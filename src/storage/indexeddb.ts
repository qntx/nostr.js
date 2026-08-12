import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilters } from "../core/filter.ts";
import { isAddressableKind, isEphemeralKind, isReplaceableKind, Kind } from "../core/kind.ts";
import { getDTag } from "../core/tag.ts";
import { sortEvents } from "../core/event.ts";
import { CryptoError } from "../core/error.ts";
import type { EventStore, PutResult } from "./types.ts";

/** Minimal IndexedDB surface so this module does not require the DOM lib. */
type IDBDatabaseLike = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): unknown;
  transaction(storeName: string, mode?: "readonly" | "readwrite"): IDBTransactionLike;
  close(): void;
};

type IDBTransactionLike = {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  error: Error | null;
};

type IDBObjectStoreLike = {
  put(value: unknown): unknown;
  get(key: string): IDBRequestLike;
  delete(key: string): unknown;
  clear(): unknown;
  getAll(): IDBRequestLike;
};

type IDBRequestLike = {
  result: unknown;
  error: Error | null;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onupgradeneeded?: ((ev: unknown) => void) | null;
};

type IDBFactoryLike = {
  open(name: string, version?: number): IDBOpenRequestLike;
};

type IDBOpenRequestLike = IDBRequestLike & {
  onupgradeneeded: ((ev: unknown) => void) | null;
  result: IDBDatabaseLike;
};

function replaceableKey(event: Event): string {
  if (isAddressableKind(event.kind)) {
    return `${event.kind}:${event.pubkey}:${getDTag(event.tags) ?? ""}`;
  }
  return `${event.kind}:${event.pubkey}`;
}

export type IndexedDbEventStoreOptions = {
  /** IndexedDB database name. */
  dbName?: string;
  /** Object store name for events. */
  storeName?: string;
};

/**
 * Browser IndexedDB event store with the same replaceable / deletion semantics
 * as {@link MemoryEventStore}. Requires a DOM IndexedDB implementation.
 */
export class IndexedDbEventStore implements EventStore {
  readonly #dbName: string;
  readonly #storeName: string;
  #db: IDBDatabaseLike | undefined;
  #deleted = new Set<string>();
  #replaceable = new Map<string, string>();

  constructor(opts: IndexedDbEventStoreOptions = {}) {
    this.#dbName = opts.dbName ?? "@qntx/nostr";
    this.#storeName = opts.storeName ?? "events";
  }

  static isAvailable(): boolean {
    return typeof (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB !== "undefined";
  }

  async open(): Promise<void> {
    if (this.#db) return;
    if (!IndexedDbEventStore.isAvailable()) {
      throw new CryptoError("IndexedDB is not available in this environment");
    }
    this.#db = await openDb(this.#dbName, this.#storeName);
    await this.#rebuildIndexes();
  }

  async #ensure(): Promise<IDBDatabaseLike> {
    await this.open();
    return this.#db!;
  }

  async #rebuildIndexes(): Promise<void> {
    const db = await this.#ensure();
    const events = await idbGetAll<Event>(db, this.#storeName);
    this.#deleted.clear();
    this.#replaceable.clear();
    // Sort ascending so newer replaceables overwrite older map entries.
    events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const event of events) {
      if (event.kind === Kind.EventDeletion) {
        for (const tag of event.tags) {
          if (tag[0] === "e" && tag[1]) this.#deleted.add(tag[1]);
        }
      }
      if (isReplaceableKind(event.kind) || isAddressableKind(event.kind)) {
        this.#replaceable.set(replaceableKey(event), event.id);
      }
    }
  }

  async put(event: Event): Promise<PutResult> {
    const db = await this.#ensure();
    if (this.#deleted.has(event.id)) return "duplicate";

    const existing = await idbGet<Event>(db, this.#storeName, event.id);
    if (existing) return "duplicate";

    if (isEphemeralKind(event.kind)) {
      await idbPut(db, this.#storeName, event);
      return "ephemeral";
    }

    if (event.kind === Kind.EventDeletion) {
      for (const tag of event.tags) {
        if (tag[0] === "e" && tag[1]) {
          this.#deleted.add(tag[1]);
          await idbDelete(db, this.#storeName, tag[1]);
          for (const [key, id] of this.#replaceable) {
            if (id === tag[1]) this.#replaceable.delete(key);
          }
        }
      }
      await idbPut(db, this.#storeName, event);
      return "deleted";
    }

    if (isReplaceableKind(event.kind) || isAddressableKind(event.kind)) {
      const key = replaceableKey(event);
      const existingId = this.#replaceable.get(key);
      if (existingId) {
        const prev = await idbGet<Event>(db, this.#storeName, existingId);
        if (prev) {
          if (prev.created_at > event.created_at) return "rejected";
          if (prev.created_at === event.created_at && prev.id > event.id) return "rejected";
          await idbDelete(db, this.#storeName, existingId);
        }
      }
      await idbPut(db, this.#storeName, event);
      this.#replaceable.set(key, event.id);
      return existingId ? "replaced" : "accepted";
    }

    await idbPut(db, this.#storeName, event);
    return "accepted";
  }

  async get(id: string): Promise<Event | undefined> {
    if (this.#deleted.has(id)) return undefined;
    const db = await this.#ensure();
    return idbGet<Event>(db, this.#storeName, id);
  }

  async query(filters: Filter[]): Promise<Event[]> {
    const db = await this.#ensure();
    const all = await idbGetAll<Event>(db, this.#storeName);
    const events: Event[] = [];
    for (const event of all) {
      if (this.#deleted.has(event.id)) continue;
      if (matchFilters(filters, event)) events.push(event);
    }
    sortEvents(events);
    const limit = filters.reduce(
      (min, f) => (f.limit !== undefined ? Math.min(min, f.limit) : min),
      Infinity,
    );
    if (Number.isFinite(limit)) return events.slice(0, limit);
    return events;
  }

  async remove(ids: string[]): Promise<number> {
    const db = await this.#ensure();
    let n = 0;
    for (const id of ids) {
      const had = await idbGet<Event>(db, this.#storeName, id);
      if (had) {
        await idbDelete(db, this.#storeName, id);
        n += 1;
        for (const [key, eid] of this.#replaceable) {
          if (eid === id) this.#replaceable.delete(key);
        }
      }
      this.#deleted.add(id);
    }
    return n;
  }

  async clear(): Promise<void> {
    const db = await this.#ensure();
    await idbClear(db, this.#storeName);
    this.#deleted.clear();
    this.#replaceable.clear();
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }
}

function openDb(dbName: string, storeName: string): Promise<IDBDatabaseLike> {
  return new Promise((resolve, reject) => {
    const factory = (globalThis as unknown as { indexedDB: IDBFactoryLike }).indexedDB;
    const req = factory.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbPut(db: IDBDatabaseLike, storeName: string, event: Event): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB put failed"));
  });
}

function idbGet<T>(db: IDBDatabaseLike, storeName: string, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
  });
}

function idbDelete(db: IDBDatabaseLike, storeName: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
  });
}

function idbGetAll<T>(db: IDBDatabaseLike, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB getAll failed"));
  });
}

function idbClear(db: IDBDatabaseLike, storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB clear failed"));
  });
}
