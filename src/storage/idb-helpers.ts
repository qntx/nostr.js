import type { Event } from "../core/event.ts";
import { type DeletionPlan, type DeletionState } from "./deletion.ts";
import { StorageError } from "./error.ts";
import {
  ADDRESSES,
  EVENTS,
  TAG_REFS,
  TOMBSTONES,
  type AddressRow,
  type IDBCursorDirectionLike,
  type IDBCursorLike,
  type IDBKeyRangeLike,
  type IDBObjectStoreLike,
  type IDBRequestLike,
  type IDBTransactionLike,
  type TagRef,
  type Tombstone,
} from "./idb-types.ts";
import type { PutDecision } from "./put.ts";
import type { PutResult } from "./types.ts";

export function reqOf<T>(req: IDBRequestLike): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new StorageError("IndexedDB request failed"));
  });
}

export function txDone(tx: IDBTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new StorageError("IndexedDB transaction failed"));
  });
}

export function walkCursor(
  source: {
    openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
  },
  range: IDBKeyRangeLike | undefined,
  direction: IDBCursorDirectionLike,
  visit: (cursor: IDBCursorLike) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = source.openCursor(range, direction);
    req.onerror = () => reject(req.error ?? new StorageError("IndexedDB cursor failed"));
    req.onsuccess = () => {
      const cursor = req.result as IDBCursorLike | undefined;
      if (!cursor) {
        resolve();
        return;
      }
      if (visit(cursor)) {
        resolve();
        return;
      }
      cursor.continue();
    };
  });
}

export function tagRefKey(name: string, value: string, id: string): string {
  return `${name}:${value.toLowerCase()}:${id.toLowerCase()}`;
}

export function writeTagRefs(store: IDBObjectStoreLike, event: Event): void {
  for (const tag of event.tags) {
    if ((tag[0] !== "e" && tag[0] !== "p") || tag[1] === undefined) continue;
    const name = tag[0];
    const value = tag[1].toLowerCase();
    const id = event.id.toLowerCase();
    store.put({
      key: tagRefKey(name, value, id),
      name,
      value,
      id,
      created_at: event.created_at,
    } satisfies TagRef);
  }
}

export function deleteStoredEvent(
  tx: IDBTransactionLike,
  event: Event,
  addressRow?: AddressRow,
): void {
  const tagRefs = tx.objectStore(TAG_REFS);
  for (const tag of event.tags) {
    if ((tag[0] === "e" || tag[0] === "p") && tag[1] !== undefined) {
      tagRefs.delete(tagRefKey(tag[0], tag[1], event.id));
    }
  }
  if (addressRow?.id === event.id) {
    tx.objectStore(ADDRESSES).delete(addressRow.address);
  }
  tx.objectStore(EVENTS).delete(event.id);
}

export function persistPlanTombstones(
  store: IDBObjectStoreLike,
  plan: DeletionPlan,
  coordIds: readonly string[],
  deletion: DeletionState,
): void {
  for (const id of plan.removeIds) {
    store.put({ key: `id:${id}`, type: "id" } satisfies Tombstone);
    store.delete(`pending:${id}`);
  }
  for (const id of coordIds) {
    store.put({ key: `id:${id}`, type: "id" } satisfies Tombstone);
    store.delete(`pending:${id}`);
  }
  for (const p of plan.pendingIds) {
    if (deletion.ids.has(p.id)) continue;
    store.put({
      key: `pending:${p.id}`,
      type: "pending",
      pubkey: p.pubkey.toLowerCase(),
    } satisfies Tombstone);
  }
  for (const c of plan.coordinates) {
    const prev = deletion.coordinates.get(c.key) ?? Number.NEGATIVE_INFINITY;
    store.put({
      key: `coord:${c.key}`,
      type: "coord",
      until: Math.max(prev, c.until),
    } satisfies Tombstone);
  }
}

export function tombstonesToPlan(rows: unknown[]): DeletionPlan {
  const plan: DeletionPlan = { removeIds: [], pendingIds: [], coordinates: [] };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.type === "id" && typeof r.key === "string" && r.key.startsWith("id:")) {
      plan.removeIds.push(r.key.slice(3).toLowerCase());
      continue;
    }
    if (
      r.type === "pending" &&
      typeof r.key === "string" &&
      r.key.startsWith("pending:") &&
      typeof r.pubkey === "string"
    ) {
      plan.pendingIds.push({ id: r.key.slice(8).toLowerCase(), pubkey: r.pubkey.toLowerCase() });
      continue;
    }
    if (
      r.type === "coord" &&
      typeof r.key === "string" &&
      r.key.startsWith("coord:") &&
      typeof r.until === "number"
    ) {
      plan.coordinates.push({ key: r.key.slice(6), until: r.until });
    }
  }
  return plan;
}

export function applyPutIndexedDb(
  tx: IDBTransactionLike,
  s: {
    deletion: DeletionState;
    replaceable: Map<string, string>;
  },
  d: PutDecision,
): PutResult {
  const events = tx.objectStore(EVENTS);
  const tagRefs = tx.objectStore(TAG_REFS);
  const addresses = tx.objectStore(ADDRESSES);
  const tombstones = tx.objectStore(TOMBSTONES);
  switch (d.action) {
    case "skip":
      return d.result;
    case "tombstone":
      tombstones.put({ key: `id:${d.event.id}`, type: "id" } satisfies Tombstone);
      tombstones.delete(`pending:${d.event.id}`);
      s.deletion.ids.add(d.event.id);
      s.deletion.pending.delete(d.event.id);
      return "duplicate";
    case "delete": {
      s.deletion.pending.delete(d.event.id);
      persistPlanTombstones(tombstones, d.plan, d.coordIds, s.deletion);
      s.deletion.absorb(d.plan);
      for (const id of d.coordIds) s.deletion.ids.add(id);
      events.put(d.event);
      writeTagRefs(tagRefs, d.event);
      return "deleted";
    }
    case "insert":
      events.put(d.event);
      writeTagRefs(tagRefs, d.event);
      if (d.address) {
        addresses.put({
          address: d.address,
          id: d.event.id,
          created_at: d.event.created_at,
        });
        s.replaceable.set(d.address, d.event.id);
      }
      return d.result;
  }
}
