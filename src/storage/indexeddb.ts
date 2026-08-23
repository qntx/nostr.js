import type { Event } from "../core/event.ts";
import { isReplaceableWinner, sortEvents } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilter } from "../core/filter.ts";
import { isEphemeralKind, Kind } from "../core/kind.ts";
import { eventAddress } from "../core/tag.ts";
import { CryptoError } from "../core/error.ts";
import { coordinateRemovals, DeletionState, planDeletion, type DeletionPlan } from "./deletion.ts";
import type { EventStore, PutResult } from "./types.ts";

const IDB_VERSION = 2;
const EVENTS = "events";
const TAG_REFS = "tag_refs";
const ADDRESSES = "addresses";
const TOMBSTONES = "tombstones";
const WRITE_STORES = [EVENTS, TAG_REFS, ADDRESSES, TOMBSTONES];

type IDBCursorDirectionLike = "next" | "prev";

type IDBKeyRangeLike = {
  lower: unknown;
  upper: unknown;
  lowerOpen: boolean;
  upperOpen: boolean;
};

type IDBCursorLike = {
  value: unknown;
  key: unknown;
  continue(): void;
};

type IDBIndexLike = {
  openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
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
  error: Error | null;
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

export type IndexedDbEventStoreOptions = {
  /** IndexedDB database name. */
  dbName?: string;
};

/**
 * Browser IndexedDB event store with the same replaceable / deletion semantics
 * as {@link MemoryEventStore}. Requires a DOM IndexedDB implementation.
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

  async #loadCaches(): Promise<void> {
    const db = this.#db!;
    const tx = db.transaction([TOMBSTONES, ADDRESSES], "readonly");
    const done = txDone(tx);
    this.#deletion.clear();
    this.#replaceable.clear();
    const tombs = await reqOf<unknown[]>(tx.objectStore(TOMBSTONES).getAll());
    this.#deletion.absorb(tombstonesToPlan(tombs ?? []));
    await walkCursor<AddressRow>(tx.objectStore(ADDRESSES), undefined, "next", (row) => {
      this.#replaceable.set(row.address, row.id);
      return false;
    });
    await done;
  }

  async put(raw: Event): Promise<PutResult> {
    const event = normalizeEvent(raw);
    const db = await this.#ensure();
    const tx = db.transaction(WRITE_STORES, "readwrite");
    const events = tx.objectStore(EVENTS);
    const tagRefs = tx.objectStore(TAG_REFS);
    const addresses = tx.objectStore(ADDRESSES);
    const tombstones = tx.objectStore(TOMBSTONES);
    const done = txDone(tx);

    if (this.#deletion.ids.has(event.id)) {
      await done;
      return "duplicate";
    }

    const existing = await reqOf<Event | undefined>(events.get(event.id));
    if (existing) {
      await done;
      return "duplicate";
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
      await done;
      return "deleted";
    }

    if (this.#deletion.covers(event)) {
      tombstones.put({ key: `id:${event.id}`, type: "id" } satisfies Tombstone);
      tombstones.delete(`pending:${event.id}`);
      this.#deletion.ids.add(event.id);
      this.#deletion.pending.delete(event.id);
      await done;
      return "duplicate";
    }

    if (isEphemeralKind(event.kind)) {
      events.put(event);
      writeTagRefs(tagRefs, event);
      await done;
      return "ephemeral";
    }

    const key = eventAddress(event);
    if (key) {
      const addrRow = await reqOf<AddressRow | undefined>(addresses.get(key));
      if (addrRow) {
        const prev = await reqOf<Event | undefined>(events.get(addrRow.id));
        if (prev && !isReplaceableWinner(event, prev)) {
          await done;
          return "rejected";
        }
        if (prev) await this.#deleteEventRows(tx, prev.id);
      }
      events.put(event);
      writeTagRefs(tagRefs, event);
      addresses.put({ address: key, id: event.id, created_at: event.created_at });
      this.#replaceable.set(key, event.id);
      await done;
      return addrRow ? "replaced" : "accepted";
    }

    events.put(event);
    writeTagRefs(tagRefs, event);
    await done;
    return "accepted";
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

  async #queryOne(tx: IDBTransactionLike, filter: Filter): Promise<Event[]> {
    const matched: Event[] = [];
    if (filter.limit === 0) return matched;
    if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) {
      return matched;
    }

    const events = tx.objectStore(EVENTS);
    const seenIds = new Set<string>();
    const take = (event: Event | undefined): boolean => {
      if (!event) return false;
      const id = event.id.toLowerCase();
      if (seenIds.has(id)) return false;
      if (this.#deletion.ids.has(id) || this.#deletion.covers(event)) return false;
      if (!matchFilter(filter, event)) return false;
      seenIds.add(id);
      matched.push(event);
      return filter.limit !== undefined && matched.length >= filter.limit;
    };

    if (filter.ids) {
      for (const id of filter.ids) {
        const event = await reqOf<Event | undefined>(events.get(id.toLowerCase()));
        if (take(event)) break;
      }
    } else if (filter.authors && filter.kinds) {
      const index = events.index("kind_pubkey_created_at");
      loop: for (const kind of filter.kinds) {
        for (const pk of filter.authors) {
          await walkCursor<Event>(
            index,
            prefixRange([kind, pk.toLowerCase()], filter.since, filter.until),
            "prev",
            take,
          );
          if (filter.limit !== undefined && matched.length >= filter.limit) break loop;
        }
      }
    } else if (filter.authors) {
      const index = events.index("pubkey_created_at");
      for (const pk of filter.authors) {
        await walkCursor<Event>(
          index,
          prefixRange([pk.toLowerCase()], filter.since, filter.until),
          "prev",
          take,
        );
        if (filter.limit !== undefined && matched.length >= filter.limit) break;
      }
    } else if (filter.kinds) {
      const index = events.index("kind_created_at");
      for (const kind of filter.kinds) {
        await walkCursor<Event>(
          index,
          prefixRange([kind], filter.since, filter.until),
          "prev",
          take,
        );
        if (filter.limit !== undefined && matched.length >= filter.limit) break;
      }
    } else {
      const tag = singleEpTag(filter);
      if (tag) {
        const index = tx.objectStore(TAG_REFS).index("name_value_created");
        loop: for (const value of tag.values) {
          await walkTagRefs(
            index,
            events,
            prefixRange([tag.name, value.toLowerCase()], filter.since, filter.until),
            take,
          );
          if (filter.limit !== undefined && matched.length >= filter.limit) break loop;
        }
      } else {
        await walkCursor<Event>(
          events.index("created_at"),
          createdAtRange(filter.since, filter.until),
          "prev",
          take,
        );
      }
    }

    sortEvents(matched);
    return matched;
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
    const tx = db.transaction(WRITE_STORES, "readwrite");
    const done = txDone(tx);
    for (const name of WRITE_STORES) tx.objectStore(name).clear();
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
    const tagRefs = tx.objectStore(TAG_REFS);
    for (const tag of event.tags) {
      if ((tag[0] === "e" || tag[0] === "p") && tag[1] !== undefined) {
        tagRefs.delete(tagRefKey(tag[0], tag[1], event.id));
      }
    }
    const addr = eventAddress(event);
    if (addr) {
      const addresses = tx.objectStore(ADDRESSES);
      const row = await reqOf<AddressRow | undefined>(addresses.get(addr));
      if (row?.id === event.id) addresses.delete(addr);
      if (this.#replaceable.get(addr) === event.id) this.#replaceable.delete(addr);
    }
    events.delete(event.id);
    return true;
  }
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

function singleEpTag(filter: Filter): { name: "e" | "p"; values: readonly string[] } | undefined {
  const e = filter["#e"];
  const p = filter["#p"];
  const hasE = e !== undefined && e.length > 0;
  const hasP = p !== undefined && p.length > 0;
  if (hasE && !hasP) return { name: "e", values: e };
  if (hasP && !hasE) return { name: "p", values: p };
  return undefined;
}

function tagRefKey(name: string, value: string, id: string): string {
  return `${name}:${value.toLowerCase()}:${id.toLowerCase()}`;
}

function normalizeEvent(event: Event): Event {
  const id = event.id.toLowerCase();
  const pubkey = event.pubkey.toLowerCase();
  if (id === event.id && pubkey === event.pubkey) return event;
  return { ...event, id, pubkey };
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
          };
        }
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

function walkCursor<T>(
  source: {
    openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
  },
  range: IDBKeyRangeLike | undefined,
  direction: IDBCursorDirectionLike,
  visit: (value: T) => boolean,
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
      if (visit(cursor.value as T)) {
        resolve();
        return;
      }
      cursor.continue();
    };
  });
}

function walkTagRefs(
  index: IDBIndexLike,
  events: IDBObjectStoreLike,
  range: IDBKeyRangeLike,
  take: (event: Event | undefined) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = index.openCursor(range, "prev");
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
    req.onsuccess = () => {
      const cursor = req.result as IDBCursorLike | undefined;
      if (!cursor) {
        resolve();
        return;
      }
      const row = cursor.value as TagRef;
      const getReq = events.get(row.id);
      getReq.onerror = () => reject(getReq.error ?? new Error("IndexedDB get failed"));
      getReq.onsuccess = () => {
        if (take(getReq.result as Event | undefined)) {
          resolve();
          return;
        }
        cursor.continue();
      };
    };
  });
}
