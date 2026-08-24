import type { Event } from "../core/event.ts";
import { isReplaceableWinner, itemCompare, sortEvents } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilter } from "../core/filter.ts";
import { isEphemeralKind, Kind } from "../core/kind.ts";
import { eventAddress } from "../core/tag.ts";
import { CryptoError } from "../core/error.ts";
import { coordinateRemovals, DeletionState, planDeletion, type DeletionPlan } from "./deletion.ts";
import { toStorageError } from "./error.ts";
import type { EventStore, NegentropyItem, OutboxBound, PutResult } from "./types.ts";

const IDB_VERSION = 4;
const EVENTS = "events";
const TAG_REFS = "tag_refs";
const ADDRESSES = "addresses";
const TOMBSTONES = "tombstones";
const OUTBOX_BOUNDS = "outbox_bounds";
const WRITE_STORES = [EVENTS, TAG_REFS, ADDRESSES, TOMBSTONES];

type IDBCursorDirectionLike = "next" | "prev";

type IDBKeyRangeLike = {
  lower: unknown;
  upper: unknown;
  lowerOpen: boolean;
  upperOpen: boolean;
};

type IDBCursorLike = {
  value?: unknown;
  key: unknown;
  primaryKey: unknown;
  continue(): void;
};

type IDBIndexLike = {
  openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
  openKeyCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
};

type IDBRequestLike = {
  result: unknown;
  error: Error | null;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

type IDBObjectStoreLike = {
  put(value: unknown): unknown;
  get(key: string): IDBRequestLike;
  delete(key: string): unknown;
  clear(): unknown;
  getAll(): IDBRequestLike;
  createIndex(name: string, keyPath: string | string[]): IDBIndexLike;
  index(name: string): IDBIndexLike;
  openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
};

type IDBTransactionLike = {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onabort: ((ev: unknown) => void) | null;
  error: Error | null;
  abort(): void;
};

type IDBDatabaseLike = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): IDBObjectStoreLike;
  transaction(storeNames: string | string[], mode?: "readonly" | "readwrite"): IDBTransactionLike;
  close(): void;
};

type IDBVersionChangeEventLike = {
  oldVersion: number;
  newVersion: number | null;
  target: { result: IDBDatabaseLike; transaction: IDBTransactionLike };
};

type IDBFactoryLike = {
  open(name: string, version?: number): IDBOpenRequestLike;
};

type IDBOpenRequestLike = IDBRequestLike & {
  onupgradeneeded: ((ev: IDBVersionChangeEventLike) => void) | null;
  result: IDBDatabaseLike;
};

type TagRef = {
  key: string;
  name: string;
  value: string;
  id: string;
  created_at: number;
};

type AddressRow = {
  address: string;
  id: string;
  created_at: number;
};

type Tombstone =
  | { key: `id:${string}`; type: "id" }
  | { key: `pending:${string}`; type: "pending"; pubkey: string }
  | { key: `coord:${string}`; type: "coord"; until: number };

type OutboxBoundRow = { key: string; oldest: number; newest: number };

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

  constructor(opts: IndexedDbEventStoreOptions = {}) {
    this.#dbName = opts.dbName ?? "@qntx/nostr";
  }

  static isAvailable(): boolean {
    return typeof (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB !== "undefined";
  }

  async open(): Promise<void> {
    if (this.#db) return;
    if (!IndexedDbEventStore.isAvailable()) {
      throw new CryptoError("IndexedDB is not available in this environment");
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

  async put(event: Event): Promise<PutResult> {
    const [result] = await this.putMany([event]);
    return result!;
  }

  /** One readwrite transaction; abort rejects the whole batch with no partial persist. */
  async putMany(events: readonly Event[]): Promise<PutResult[]> {
    if (events.length === 0) return [];
    let db: IDBDatabaseLike;
    try {
      db = await this.#ensure();
    } catch (err) {
      throw toStorageError(err);
    }
    const tx = db.transaction(WRITE_STORES, "readwrite");
    const txSettled = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
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

  /** Sequential puts in one async function so the tx stays alive between events. */
  async #putAllInTx(tx: IDBTransactionLike, batch: readonly Event[]): Promise<PutResult[]> {
    const events = tx.objectStore(EVENTS);
    const tagRefs = tx.objectStore(TAG_REFS);
    const addresses = tx.objectStore(ADDRESSES);
    const tombstones = tx.objectStore(TOMBSTONES);
    const results: PutResult[] = [];
    for (const raw of batch) {
      const event = normalizeEvent(raw);

      if (this.#deletion.ids.has(event.id)) {
        results.push("duplicate");
        continue;
      }

      const existing = await reqOf<Event | undefined>(events.get(event.id));
      if (existing) {
        results.push("duplicate");
        continue;
      }

      if (event.kind === Kind.EventDeletion) {
        this.#deletion.pending.delete(event.id);
        const byId = new Map<string, Event>();
        for (const tag of event.tags) {
          if (tag[0] !== "e" || tag[1] === undefined) continue;
          const got = await reqOf<Event | undefined>(events.get(tag[1].toLowerCase()));
          if (got) byId.set(got.id, got);
        }
        const plan = planDeletion(event, (id) => byId.get(id));
        const current = new Map<string, Pick<Event, "id" | "created_at">>();
        for (const c of plan.coordinates) {
          const row = await reqOf<AddressRow | undefined>(addresses.get(c.key));
          if (row) current.set(c.key, row);
        }
        const coordIds = coordinateRemovals(plan.coordinates, (key) => current.get(key));
        const remove = new Set([...plan.removeIds, ...coordIds]);
        for (const id of remove) {
          await this.#deleteEventRows(tx, id);
        }
        persistPlanTombstones(tombstones, plan, coordIds, this.#deletion);
        this.#deletion.absorb(plan);
        for (const id of coordIds) this.#deletion.ids.add(id);
        events.put(event);
        writeTagRefs(tagRefs, event);
        results.push("deleted");
        continue;
      }

      if (this.#deletion.covers(event)) {
        tombstones.put({ key: `id:${event.id}`, type: "id" } satisfies Tombstone);
        tombstones.delete(`pending:${event.id}`);
        this.#deletion.ids.add(event.id);
        this.#deletion.pending.delete(event.id);
        results.push("duplicate");
        continue;
      }

      if (isEphemeralKind(event.kind)) {
        results.push("ephemeral");
        continue;
      }

      const key = eventAddress(event);
      if (key) {
        const addrRow = await reqOf<AddressRow | undefined>(addresses.get(key));
        if (addrRow) {
          const prev = await reqOf<Event | undefined>(events.get(addrRow.id));
          if (prev && !isReplaceableWinner(event, prev)) {
            results.push("rejected");
            continue;
          }
          if (prev) await this.#deleteEventRows(tx, prev.id);
        }
        events.put(event);
        writeTagRefs(tagRefs, event);
        addresses.put({ address: key, id: event.id, created_at: event.created_at });
        this.#replaceable.set(key, event.id);
        results.push(addrRow ? "replaced" : "accepted");
        continue;
      }

      events.put(event);
      writeTagRefs(tagRefs, event);
      results.push("accepted");
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

  async #scan(
    tx: IDBTransactionLike,
    filter: Filter,
    take: (event: Event) => boolean,
  ): Promise<void> {
    if (filter.limit === 0) return;
    if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) {
      return;
    }

    const accept = (event: Event) => this.#acceptHit(filter, event);
    if (filter.ids) {
      await scanIds(tx, filter, accept, take);
      return;
    }

    const events = tx.objectStore(EVENTS);
    const openers: MergeOpener[] = [];
    if (filter.authors && filter.kinds) {
      const index = events.index("kind_pubkey_created_at");
      for (const kind of filter.kinds) {
        for (const pk of filter.authors) {
          openers.push(
            eventCursor(index, prefixRange([kind, pk.toLowerCase()], filter.since, filter.until)),
          );
        }
      }
    } else if (filter.authors) {
      const index = events.index("pubkey_created_at");
      for (const pk of filter.authors) {
        openers.push(
          eventCursor(index, prefixRange([pk.toLowerCase()], filter.since, filter.until)),
        );
      }
    } else if (filter.kinds) {
      const index = events.index("kind_created_at");
      for (const kind of filter.kinds) {
        openers.push(eventCursor(index, prefixRange([kind], filter.since, filter.until)));
      }
    } else {
      const tags = epTagPrefixes(filter);
      if (tags.length > 0) {
        const index = tx.objectStore(TAG_REFS).index("name_value_created");
        for (const tag of tags) {
          openers.push(
            tagCursor(
              index,
              events,
              prefixRange([tag.name, tag.value], filter.since, filter.until),
            ),
          );
        }
      } else {
        openers.push(
          eventCursor(events.index("created_at"), createdAtRange(filter.since, filter.until)),
        );
      }
    }
    await kWayMerge(openers, accept, take);
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

function compareEventsDesc(
  a: { id: string; created_at: number },
  b: { id: string; created_at: number },
): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id.localeCompare(b.id);
}

function prefixRange(
  prefix: readonly (string | number)[],
  since?: number,
  until?: number,
): IDBKeyRangeLike {
  return idbKeyRange().bound(
    [...prefix, since ?? 0],
    [...prefix, until ?? Number.MAX_SAFE_INTEGER],
  );
}

function createdAtRange(since?: number, until?: number): IDBKeyRangeLike {
  return idbKeyRange().bound(since ?? 0, until ?? Number.MAX_SAFE_INTEGER);
}

function idbKeyRange(): {
  bound(lower: unknown, upper: unknown, lowerOpen?: boolean, upperOpen?: boolean): IDBKeyRangeLike;
} {
  return (globalThis as unknown as { IDBKeyRange: ReturnType<typeof idbKeyRange> }).IDBKeyRange;
}

function epTagPrefixes(filter: Filter): Array<{ name: "e" | "p"; value: string }> {
  const out: Array<{ name: "e" | "p"; value: string }> = [];
  for (const name of ["e", "p"] as const) {
    const values = filter[`#${name}`];
    if (!values) continue;
    for (const value of values) out.push({ name, value: value.toLowerCase() });
  }
  return out;
}

type MergeOpener = {
  open(): IDBRequestLike;
  read(
    cursor: IDBCursorLike,
    ok: (event: Event | undefined) => void,
    err: (error: Error) => void,
  ): void;
};

function eventCursor(
  source: {
    openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
  },
  range: IDBKeyRangeLike,
): MergeOpener {
  return {
    open: () => source.openCursor(range, "prev"),
    read: (cursor, ok) => {
      ok(cursor.value as Event);
    },
  };
}

function tagCursor(
  index: IDBIndexLike,
  events: IDBObjectStoreLike,
  range: IDBKeyRangeLike,
): MergeOpener {
  return {
    open: () => index.openCursor(range, "prev"),
    read: (cursor, ok, err) => {
      const row = cursor.value as TagRef;
      const req = events.get(row.id);
      req.onerror = () => err(req.error ?? new Error("IndexedDB get failed"));
      req.onsuccess = () => ok(req.result as Event | undefined);
    },
  };
}

function scanIds(
  tx: IDBTransactionLike,
  filter: Filter,
  accept: (event: Event) => boolean,
  take: (event: Event) => boolean,
): Promise<void> {
  const ids = filter.ids ?? [];
  const events = tx.objectStore(EVENTS);
  const reqs = ids.map((id) => events.get(id.toLowerCase()));
  return Promise.all(reqs.map((req) => reqOf<Event | undefined>(req))).then((rows) => {
    const matched: Event[] = [];
    const seen = new Set<string>();
    for (const event of rows) {
      if (!event || seen.has(event.id) || !accept(event)) continue;
      seen.add(event.id);
      matched.push(event);
    }
    sortEvents(matched);
    const out = filter.limit !== undefined ? matched.slice(0, filter.limit) : matched;
    for (const event of out) {
      if (take(event)) break;
    }
  });
}

/** IDB auto-commits when onsuccess returns with no outstanding requests. */
function kWayMerge(
  openers: readonly MergeOpener[],
  accept: (event: Event) => boolean,
  take: (event: Event) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (openers.length === 0) {
      resolve();
      return;
    }

    type Slot = { cursor: IDBCursorLike | undefined; head: Event | undefined };
    const slots: Slot[] = openers.map(() => ({ cursor: undefined, head: undefined }));
    const seen = new Set<string>();
    let inflight = 0;
    let phase: "merge" | "drain" | "done" = "merge";
    let drainT = 0;
    let drainBuf: Event[] = [];

    const finish = () => {
      if (phase === "done") return;
      phase = "done";
      resolve();
    };
    const fail = (error: Error) => {
      if (phase === "done") return;
      phase = "done";
      reject(error);
    };

    const stepCursor = (i: number) => {
      const cursor = slots[i]!.cursor;
      if (!cursor) return;
      inflight++;
      cursor.continue();
    };

    const emitDrain = () => {
      sortEvents(drainBuf);
      for (const event of drainBuf) {
        if (seen.has(event.id) || !accept(event)) continue;
        seen.add(event.id);
        if (take(event)) {
          finish();
          return;
        }
      }
      drainBuf = [];
      phase = "merge";
      pump();
    };

    const pump = () => {
      if (phase === "done" || inflight > 0) return;
      if (phase === "drain") {
        emitDrain();
        return;
      }
      let best: Event | undefined;
      for (let i = 0; i < slots.length; i++) {
        const event = slots[i]!.head;
        if (!event) continue;
        if (!best || compareEventsDesc(event, best) < 0) best = event;
      }
      if (!best) {
        finish();
        return;
      }
      phase = "drain";
      drainT = best.created_at;
      drainBuf = [];
      for (let i = 0; i < slots.length; i++) {
        const event = slots[i]!.head;
        if (!event || event.created_at !== drainT) continue;
        drainBuf.push(event);
        slots[i]!.head = undefined;
        stepCursor(i);
      }
      if (inflight === 0) pump();
    };

    const onEvent = (i: number, event: Event | undefined) => {
      if (phase === "done") return;
      const slot = slots[i]!;
      const cursor = slot.cursor;
      if (!event) {
        if (cursor) {
          inflight++;
          cursor.continue();
        } else {
          pump();
        }
        return;
      }
      if (phase === "drain") {
        if (event.created_at === drainT) {
          drainBuf.push(event);
          if (cursor) {
            inflight++;
            cursor.continue();
          } else {
            pump();
          }
          return;
        }
        slot.head = event;
        pump();
        return;
      }
      slot.head = event;
      pump();
    };

    for (let i = 0; i < openers.length; i++) {
      const req = openers[i]!.open();
      req.onerror = () => fail(req.error ?? new Error("IndexedDB cursor failed"));
      inflight++;
      req.onsuccess = () => {
        inflight--;
        if (phase === "done") return;
        const cursor = req.result as IDBCursorLike | undefined;
        const slot = slots[i]!;
        if (!cursor) {
          slot.cursor = undefined;
          slot.head = undefined;
          pump();
          return;
        }
        slot.cursor = cursor;
        inflight++;
        openers[i]!.read(
          cursor,
          (event) => {
            inflight--;
            onEvent(i, event);
          },
          (error) => {
            inflight--;
            fail(error);
          },
        );
      };
    }
  });
}

function tagRefKey(name: string, value: string, id: string): string {
  return `${name}:${value.toLowerCase()}:${id.toLowerCase()}`;
}

function outboxBoundKey(pubkey: string, kind: number): string {
  return `${pubkey.toLowerCase()}:${kind}`;
}

function normalizeEvent(event: Event): Event {
  const id = event.id.toLowerCase();
  const pubkey = event.pubkey.toLowerCase();
  if (id === event.id && pubkey === event.pubkey) return event;
  return { ...event, id, pubkey };
}

function deleteStoredEvent(tx: IDBTransactionLike, event: Event, addressRow?: AddressRow): void {
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

function writeTagRefs(store: IDBObjectStoreLike, event: Event): void {
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

function persistPlanTombstones(
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

function tombstonesToPlan(rows: unknown[]): DeletionPlan {
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

function openDb(dbName: string): Promise<IDBDatabaseLike> {
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
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function migrateV1Events(tx: IDBTransactionLike, events: Event[]): void {
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

function compactSupersededReplaceables(tx: IDBTransactionLike): void {
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

function reqOf<T>(req: IDBRequestLike): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

function walkCursor(
  source: {
    openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
  },
  range: IDBKeyRangeLike | undefined,
  direction: IDBCursorDirectionLike,
  visit: (cursor: IDBCursorLike) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = source.openCursor(range, direction);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
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
