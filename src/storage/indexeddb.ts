import type { Event } from "../core/event.ts";
import { itemCompare, sortEvents } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilter } from "../core/filter.ts";
import { Kind } from "../core/kind.ts";
import { eventAddress, parseEventAddress } from "../core/tag.ts";
import { DeletionState } from "./deletion.ts";
import { StorageError, toStorageError } from "./error.ts";
import {
  applyPutIndexedDb,
  deleteStoredEvent,
  reqOf,
  tombstonesToPlan,
  txDone,
  walkCursor,
} from "./idb-helpers.ts";
import { prefixRange, scanFilter } from "./idb-query.ts";
import { openDb } from "./idb-schema.ts";
import {
  ADDRESSES,
  EVENTS,
  OUTBOX_BOUNDS,
  TAG_REFS,
  TOMBSTONES,
  WRITE_STORES,
  type AddressRow,
  type IDBCursorDirectionLike,
  type IDBDatabaseLike,
  type IDBFactoryLike,
  type IDBTransactionLike,
  type OutboxBoundRow,
  type Tombstone,
} from "./idb-types.ts";
import { decidePut, normalizeEvent, outboxBoundKey } from "./put.ts";
import type { EventStore, NegentropyItem, OutboxBound, PutResult } from "./types.ts";

export type IndexedDbEventStoreOptions = {
  /** IndexedDB database name. */
  dbName?: string;
};

/**
 * Browser IndexedDB event store with the same replaceable / deletion semantics
 * as {@link MemoryEventStore}. Requires a DOM IndexedDB implementation.
 *
 * `open` loads every tombstone and address row into memory. Fine at 10^4 events;
 * tens of MB at 10^5 addressables.
 */
export class IndexedDbEventStore implements EventStore {
  readonly #dbName: string;
  #db: IDBDatabaseLike | undefined;
  #deletion = new DeletionState();
  #replaceable = new Map<string, string>();
  /** Serializes writes so abort restore cannot roll back a committed sibling tx. */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(opts: IndexedDbEventStoreOptions = {}) {
    this.#dbName = opts.dbName ?? "@qntx/nostr";
  }

  static isAvailable(): boolean {
    return typeof (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB !== "undefined";
  }

  async open(): Promise<void> {
    if (this.#db) return;
    if (!IndexedDbEventStore.isAvailable()) {
      throw new StorageError("IndexedDB is not available in this environment");
    }
    this.#db = await openDb(this.#dbName);
    await this.#loadCaches();
  }

  async #ensure(): Promise<IDBDatabaseLike> {
    await this.open();
    return this.#db!;
  }

  /** Loads every tombstone and address row into RAM. Tens of MB at 10^5 addressables. */
  async #loadCaches(): Promise<void> {
    const db = this.#db!;
    const tx = db.transaction([TOMBSTONES, ADDRESSES], "readonly");
    const done = txDone(tx);
    this.#deletion.clear();
    this.#replaceable.clear();
    const tombs = await reqOf<unknown[]>(tx.objectStore(TOMBSTONES).getAll());
    this.#deletion.absorb(tombstonesToPlan(tombs ?? []));
    await walkCursor(tx.objectStore(ADDRESSES), undefined, "next", (cursor) => {
      const row = cursor.value as AddressRow;
      this.#replaceable.set(row.address, row.id);
      return false;
    });
    await done;
  }

  #enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#writeTail.then(op, op);
    this.#writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async put(event: Event): Promise<PutResult> {
    const [result] = await this.putMany([event]);
    return result!;
  }

  /** One readwrite transaction; abort rejects the whole batch with no partial persist. */
  async putMany(events: readonly Event[]): Promise<PutResult[]> {
    if (events.length === 0) return [];
    return this.#enqueueWrite(() => this.#putManyLocked(events));
  }

  async #putManyLocked(events: readonly Event[]): Promise<PutResult[]> {
    let db: IDBDatabaseLike;
    try {
      db = await this.#ensure();
    } catch (err) {
      throw toStorageError(err);
    }
    const tx = db.transaction(WRITE_STORES, "readwrite");
    const txSettled = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new StorageError("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new StorageError("IndexedDB transaction aborted"));
    });
    const txOutcome = txSettled.then(
      () => undefined,
      (err: unknown) => err,
    );
    const cache = this.#snapshotCaches();
    try {
      const results = await this.#putAllInTx(tx, events);
      const txErr = await txOutcome;
      if (txErr !== undefined) throw txErr;
      return results;
    } catch (err) {
      this.#restoreCaches(cache);
      try {
        tx.abort();
      } catch {
        // already aborted or complete
      }
      await txOutcome;
      throw toStorageError(err);
    }
  }

  /** Sequential awaits so the tx stays alive between events. */
  async #putAllInTx(tx: IDBTransactionLike, batch: readonly Event[]): Promise<PutResult[]> {
    const eventsStore = tx.objectStore(EVENTS);
    const addressesStore = tx.objectStore(ADDRESSES);
    const results: PutResult[] = [];
    for (const raw of batch) {
      const event = normalizeEvent(raw);
      const byId = new Map<string, Pick<Event, "id" | "pubkey" | "kind" | "created_at" | "tags">>();
      const existing = await reqOf<Event | undefined>(eventsStore.get(event.id));
      if (existing) byId.set(existing.id, existing);
      if (event.kind === Kind.EventDeletion) {
        for (const tag of event.tags) {
          if (tag[0] !== "e" || tag[1] === undefined) continue;
          const got = await reqOf<Event | undefined>(eventsStore.get(tag[1].toLowerCase()));
          if (got) byId.set(got.id, got);
        }
      }
      const addrRows = new Map<string, { id: string; created_at: number }>();
      const ownAddr = eventAddress(event);
      if (ownAddr) {
        const row = await reqOf<AddressRow | undefined>(addressesStore.get(ownAddr));
        if (row) addrRows.set(ownAddr, { id: row.id, created_at: row.created_at });
      }
      if (event.kind === Kind.EventDeletion) {
        for (const tag of event.tags) {
          if (tag[0] !== "a" || !tag[1]) continue;
          const coord = parseEventAddress(tag[1]);
          if (!coord) continue;
          const key = `${coord.kind}:${coord.pubkey}:${coord.identifier}`;
          if (addrRows.has(key)) continue;
          const row = await reqOf<AddressRow | undefined>(addressesStore.get(key));
          if (row) addrRows.set(key, { id: row.id, created_at: row.created_at });
        }
      }
      const d = decidePut(event, {
        deletion: this.#deletion,
        getById: (id) => byId.get(id),
        getReplaceable: (address) => addrRows.get(address),
      });
      // Await row deletes in this loop so the next events.get runs in the IDB
      // request continuation. `await` of a no-request promise auto-commits the tx.
      if (d.action === "delete") {
        const remove = new Set([...d.plan.removeIds, ...d.coordIds]);
        for (const id of remove) await this.#deleteEventRows(tx, id);
      } else if (d.action === "insert" && d.replaceId) {
        await this.#deleteEventRows(tx, d.replaceId);
      }
      results.push(
        applyPutIndexedDb(
          tx,
          {
            deletion: this.#deletion,
            replaceable: this.#replaceable,
          },
          d,
        ),
      );
    }
    return results;
  }

  #snapshotCaches(): {
    replaceable: Map<string, string>;
    ids: Set<string>;
    pending: Map<string, string>;
    coordinates: Map<string, number>;
  } {
    return {
      replaceable: new Map(this.#replaceable),
      ids: new Set(this.#deletion.ids),
      pending: new Map(this.#deletion.pending),
      coordinates: new Map(this.#deletion.coordinates),
    };
  }

  #restoreCaches(snap: {
    replaceable: Map<string, string>;
    ids: Set<string>;
    pending: Map<string, string>;
    coordinates: Map<string, number>;
  }): void {
    this.#replaceable = snap.replaceable;
    this.#deletion.ids.clear();
    for (const id of snap.ids) this.#deletion.ids.add(id);
    this.#deletion.pending.clear();
    for (const [k, v] of snap.pending) this.#deletion.pending.set(k, v);
    this.#deletion.coordinates.clear();
    for (const [k, v] of snap.coordinates) this.#deletion.coordinates.set(k, v);
  }

  async get(id: string): Promise<Event | undefined> {
    const key = id.toLowerCase();
    if (this.#deletion.ids.has(key)) return undefined;
    const db = await this.#ensure();
    const tx = db.transaction(EVENTS, "readonly");
    const done = txDone(tx);
    const event = await reqOf<Event | undefined>(tx.objectStore(EVENTS).get(key));
    await done;
    return event;
  }

  async query(filters: Filter[]): Promise<Event[]> {
    const db = await this.#ensure();
    const tx = db.transaction([EVENTS, TAG_REFS], "readonly");
    const done = txDone(tx);
    const seen = new Set<string>();
    const events: Event[] = [];
    for (const filter of filters) {
      const matched = await this.#queryOne(tx, filter);
      for (const event of matched) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
    }
    await done;
    sortEvents(events);
    return events;
  }

  async count(filters: Filter[]): Promise<number> {
    const db = await this.#ensure();
    const tx = db.transaction([EVENTS, TAG_REFS], "readonly");
    const done = txDone(tx);
    const seen = new Set<string>();
    for (const filter of filters) {
      const local = new Set<string>();
      await this.#scan(tx, filter, (event) => {
        local.add(event.id);
        return filter.limit !== undefined && local.size >= filter.limit;
      });
      for (const id of local) seen.add(id);
    }
    await done;
    return seen.size;
  }

  async negentropyItems(filter: Filter): Promise<NegentropyItem[]> {
    const db = await this.#ensure();
    const tx = db.transaction([EVENTS, TAG_REFS], "readonly");
    const done = txDone(tx);
    const items: NegentropyItem[] = [];
    await this.#scan(tx, filter, (event) => {
      items.push({ id: event.id, created_at: event.created_at });
      return filter.limit !== undefined && items.length >= filter.limit;
    });
    await done;
    items.sort(itemCompare);
    return items;
  }

  #acceptHit(filter: Filter, event: Event): boolean {
    if (this.#deletion.ids.has(event.id)) return false;
    if (this.#deletion.covers(event)) return false;
    return matchFilter(filter, event);
  }

  async #queryOne(tx: IDBTransactionLike, filter: Filter): Promise<Event[]> {
    const matched: Event[] = [];
    await this.#scan(tx, filter, (event) => {
      matched.push(event);
      return filter.limit !== undefined && matched.length >= filter.limit;
    });
    sortEvents(matched);
    return matched;
  }

  #scan(tx: IDBTransactionLike, filter: Filter, take: (event: Event) => boolean): Promise<void> {
    return scanFilter(tx, filter, (event) => this.#acceptHit(filter, event), take);
  }

  async getOutboxBound(pubkey: string, kind: number): Promise<OutboxBound | undefined> {
    try {
      const db = await this.#ensure();
      const tx = db.transaction(OUTBOX_BOUNDS, "readonly");
      const done = txDone(tx);
      const row = await reqOf<OutboxBoundRow | undefined>(
        tx.objectStore(OUTBOX_BOUNDS).get(outboxBoundKey(pubkey, kind)),
      );
      await done;
      if (row && typeof row.oldest === "number" && typeof row.newest === "number") {
        return { oldest: row.oldest, newest: row.newest };
      }
      return await this.#deriveOutboxBound(pubkey, kind);
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async setOutboxBound(pubkey: string, kind: number, bound: OutboxBound): Promise<void> {
    return this.#enqueueWrite(() => this.#setOutboxBoundLocked(pubkey, kind, bound));
  }

  async #setOutboxBoundLocked(pubkey: string, kind: number, bound: OutboxBound): Promise<void> {
    try {
      const db = await this.#ensure();
      const tx = db.transaction(OUTBOX_BOUNDS, "readwrite");
      const done = txDone(tx);
      tx.objectStore(OUTBOX_BOUNDS).put({
        key: outboxBoundKey(pubkey, kind),
        oldest: bound.oldest,
        newest: bound.newest,
      } satisfies OutboxBoundRow);
      await done;
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async remove(ids: string[]): Promise<number> {
    return this.#enqueueWrite(() => this.#removeLocked(ids));
  }

  async #removeLocked(ids: string[]): Promise<number> {
    const db = await this.#ensure();
    const tx = db.transaction(WRITE_STORES, "readwrite");
    const tombstones = tx.objectStore(TOMBSTONES);
    const done = txDone(tx);
    let n = 0;
    for (const raw of ids) {
      const id = raw.toLowerCase();
      if (await this.#deleteEventRows(tx, id)) n += 1;
      tombstones.put({ key: `id:${id}`, type: "id" } satisfies Tombstone);
      tombstones.delete(`pending:${id}`);
      this.#deletion.ids.add(id);
      this.#deletion.pending.delete(id);
    }
    await done;
    return n;
  }

  async clear(): Promise<void> {
    return this.#enqueueWrite(() => this.#clearLocked());
  }

  async #clearLocked(): Promise<void> {
    const db = await this.#ensure();
    const stores = [...WRITE_STORES, OUTBOX_BOUNDS];
    const tx = db.transaction(stores, "readwrite");
    const done = txDone(tx);
    for (const name of stores) tx.objectStore(name).clear();
    this.#deletion.clear();
    this.#replaceable.clear();
    await done;
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  async #deleteEventRows(tx: IDBTransactionLike, id: string): Promise<boolean> {
    const events = tx.objectStore(EVENTS);
    const event = await reqOf<Event | undefined>(events.get(id.toLowerCase()));
    if (!event) return false;
    const addr = eventAddress(event);
    let row: AddressRow | undefined;
    if (addr) {
      row = await reqOf<AddressRow | undefined>(tx.objectStore(ADDRESSES).get(addr));
      if (this.#replaceable.get(addr) === event.id) this.#replaceable.delete(addr);
    }
    deleteStoredEvent(tx, event, row);
    return true;
  }

  async #deriveOutboxBound(pubkey: string, kind: number): Promise<OutboxBound | undefined> {
    const db = await this.#ensure();
    const pk = pubkey.toLowerCase();
    const tx = db.transaction(EVENTS, "readonly");
    const done = txDone(tx);
    const index = tx.objectStore(EVENTS).index("kind_pubkey_created_at");
    const range = prefixRange([kind, pk]);
    const filter: Filter = { authors: [pk], kinds: [kind] };
    let oldest: number | undefined;
    let newest: number | undefined;
    const firstLive = (direction: IDBCursorDirectionLike, assign: (createdAt: number) => void) =>
      walkCursor(index, range, direction, (cursor) => {
        const event = cursor.value as Event;
        if (!this.#acceptHit(filter, event)) return false;
        assign(event.created_at);
        return true;
      });
    await Promise.all([
      firstLive("next", (createdAt) => {
        oldest = createdAt;
      }),
      firstLive("prev", (createdAt) => {
        newest = createdAt;
      }),
    ]);
    await done;
    if (oldest === undefined || newest === undefined) return undefined;
    return { oldest, newest };
  }
}
