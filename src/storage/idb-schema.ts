import type { Event } from "../core/event.ts";
import { isReplaceableWinner } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import { eventAddress } from "../core/tag.ts";
import { DeletionState, planDeletion } from "./deletion.ts";
import { StorageError } from "./error.ts";
import { deleteStoredEvent, writeTagRefs } from "./idb-helpers.ts";
import {
  ADDRESSES,
  EVENTS,
  OUTBOX_BOUNDS,
  TAG_REFS,
  TOMBSTONES,
  type AddressRow,
  type IDBDatabaseLike,
  type IDBFactoryLike,
  type IDBTransactionLike,
  type Tombstone,
} from "./idb-types.ts";
import { normalizeEvent } from "./put.ts";

export const IDB_VERSION = 4;
export {
  EVENTS,
  TAG_REFS,
  ADDRESSES,
  TOMBSTONES,
  OUTBOX_BOUNDS,
  WRITE_STORES,
} from "./idb-types.ts";

export function openDb(dbName: string): Promise<IDBDatabaseLike> {
  return new Promise((resolve, reject) => {
    const factory = (globalThis as unknown as { indexedDB: IDBFactoryLike }).indexedDB;
    const req = factory.open(dbName, IDB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const oldVersion = ev.oldVersion;
      const tx = ev.target.transaction;
      if (oldVersion < 1) {
        db.createObjectStore(EVENTS, { keyPath: "id" });
      }
      if (oldVersion < 2) {
        const events = tx.objectStore(EVENTS);
        events.createIndex("created_at", "created_at");
        events.createIndex("kind_created_at", ["kind", "created_at"]);
        events.createIndex("pubkey_created_at", ["pubkey", "created_at"]);
        events.createIndex("kind_pubkey_created_at", ["kind", "pubkey", "created_at"]);
        db.createObjectStore(TAG_REFS, { keyPath: "key" }).createIndex("name_value_created", [
          "name",
          "value",
          "created_at",
        ]);
        db.createObjectStore(ADDRESSES, { keyPath: "address" });
        db.createObjectStore(TOMBSTONES, { keyPath: "key" });
        if (oldVersion >= 1) {
          const all = events.getAll();
          all.onsuccess = () => {
            migrateV1Events(tx, (all.result as Event[]) ?? []);
            compactSupersededReplaceables(tx);
          };
        }
      } else if (oldVersion < 3) {
        compactSupersededReplaceables(tx);
      }
      if (oldVersion < 4) {
        db.createObjectStore(OUTBOX_BOUNDS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new StorageError("IndexedDB open failed"));
  });
}

export function migrateV1Events(tx: IDBTransactionLike, events: Event[]): void {
  const byId = new Map(events.map((e) => [e.id.toLowerCase(), e]));
  const deletion = new DeletionState();
  const dels = events
    .filter((e) => e.kind === Kind.EventDeletion)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  for (const del of dels) {
    const plan = planDeletion(del, (id) => byId.get(id));
    deletion.absorb(plan);
    for (const c of plan.coordinates) {
      for (const ev of events) {
        if (ev.kind === Kind.EventDeletion) continue;
        if (eventAddress(ev) === c.key && ev.created_at <= c.until) {
          deletion.ids.add(ev.id.toLowerCase());
        }
      }
    }
  }

  const eventsStore = tx.objectStore(EVENTS);
  const tagRefs = tx.objectStore(TAG_REFS);
  const addresses = tx.objectStore(ADDRESSES);
  const tombstones = tx.objectStore(TOMBSTONES);

  for (const id of deletion.ids) {
    tombstones.put({ key: `id:${id}`, type: "id" } satisfies Tombstone);
  }
  for (const [id, pubkey] of deletion.pending) {
    tombstones.put({
      key: `pending:${id}`,
      type: "pending",
      pubkey: pubkey.toLowerCase(),
    } satisfies Tombstone);
  }
  for (const [key, until] of deletion.coordinates) {
    tombstones.put({ key: `coord:${key}`, type: "coord", until } satisfies Tombstone);
  }

  const winners = new Map<string, Event>();
  for (const event of events) {
    const stored = normalizeEvent(event);
    if (deletion.ids.has(stored.id) || deletion.covers(stored)) {
      eventsStore.delete(event.id);
      continue;
    }
    if (stored.id !== event.id) eventsStore.delete(event.id);
    if (stored !== event) eventsStore.put(stored);
    writeTagRefs(tagRefs, stored);
    const addr = eventAddress(stored);
    if (addr) {
      const prev = winners.get(addr);
      if (!prev || isReplaceableWinner(stored, prev)) winners.set(addr, stored);
    }
  }
  for (const [address, event] of winners) {
    addresses.put({ address, id: event.id, created_at: event.created_at });
  }
}

export function compactSupersededReplaceables(tx: IDBTransactionLike): void {
  const eventsStore = tx.objectStore(EVENTS);
  const addressesStore = tx.objectStore(ADDRESSES);
  const evReq = eventsStore.getAll();
  const addrReq = addressesStore.getAll();
  let events: Event[] | undefined;
  let addressRows: AddressRow[] | undefined;
  const run = () => {
    if (events === undefined || addressRows === undefined) return;
    const byAddr = new Map<string, AddressRow>();
    for (const row of addressRows) byAddr.set(row.address, row);
    const kept: Event[] = [];
    for (const event of events) {
      const addr = eventAddress(event);
      if (addr) {
        const row = byAddr.get(addr);
        if (!row || row.id !== event.id) {
          deleteStoredEvent(tx, event, row);
          continue;
        }
      }
      kept.push(event);
    }
    addressesStore.clear();
    for (const event of kept) {
      const addr = eventAddress(event);
      if (!addr) continue;
      addressesStore.put({ address: addr, id: event.id, created_at: event.created_at });
    }
  };
  evReq.onsuccess = () => {
    events = (evReq.result as Event[]) ?? [];
    run();
  };
  addrReq.onsuccess = () => {
    addressRows = (addrReq.result as AddressRow[]) ?? [];
    run();
  };
}
