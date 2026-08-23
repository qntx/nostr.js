/**
 * Minimal in-memory IndexedDB factory for unit tests (no browser).
 * Installs on `globalThis.indexedDB` / `IDBKeyRange` and returns an uninstall handle.
 */

export type IdbMock = {
  uninstall(): void;
  eventsGetAllCount(): number;
  cursorVisitCount(): number;
  readwriteTransactions(): string[][];
  resetStats(): void;
};

type Row = Record<string, unknown>;
type StoreData = {
  keyPath: string;
  rows: Map<string, Row>;
  indexes: Map<string, string | string[]>;
};
type PersistedDb = {
  version: number;
  stores: Map<string, StoreData>;
};

export function installIdbMock(): IdbMock {
  const dbs = new Map<string, PersistedDb>();
  const stats = {
    eventsGetAll: 0,
    cursorVisits: 0,
    readwrite: [] as string[][],
  };

  class MockKeyRange {
    constructor(
      readonly lower: unknown,
      readonly upper: unknown,
      readonly lowerOpen = false,
      readonly upperOpen = false,
    ) {}
    static bound(
      lower: unknown,
      upper: unknown,
      lowerOpen = false,
      upperOpen = false,
    ): MockKeyRange {
      if (cmp(lower, upper) > 0)
        throw new Error("DataError: lower bound is greater than upper bound");
      return new MockKeyRange(lower, upper, lowerOpen, upperOpen);
    }
  }

  class MockRequest<T = unknown> {
    result!: T;
    error: Error | null = null;
    onsuccess: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onupgradeneeded: ((ev: unknown) => void) | null = null;
    complete(value: T) {
      this.result = value;
      queueMicrotask(() => this.onsuccess?.({}));
    }
  }

  class MockTx {
    oncomplete: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    error: Error | null = null;
    #pending = 0;
    #held = false;
    #completed = false;
    #scheduled = false;

    constructor(
      private db: MockDb,
      private names: string[] | "all",
    ) {
      this.#queue();
    }

    hold() {
      this.#held = true;
    }

    release() {
      this.#held = false;
      this.#queue();
    }

    get completed() {
      return this.#completed;
    }

    begin() {
      this.#pending++;
    }

    end() {
      this.#pending--;
      this.#queue();
    }

    #queue() {
      if (this.#scheduled) return;
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        if (this.#completed || this.#held || this.#pending > 0) return;
        this.#completed = true;
        this.oncomplete?.({});
      });
    }

    objectStore(name: string) {
      if (this.names !== "all" && !this.names.includes(name)) {
        throw new Error(`store ${name} not in transaction`);
      }
      const data = this.db.getStore(name);
      if (!data) throw new Error(`store ${name} not found`);
      return new MockStore(data, this, name);
    }
  }

  class MockIndex {
    constructor(
      private data: StoreData,
      private keyPath: string | string[],
      private tx: MockTx,
    ) {}

    openCursor(range?: MockKeyRange, direction: "next" | "prev" = "next") {
      return openCursor(
        this.data,
        (row) => getKeyPath(row, this.keyPath),
        range,
        direction,
        this.tx,
        stats,
      );
    }
  }

  class MockStore {
    constructor(
      private data: StoreData,
      private tx: MockTx,
      private name: string,
    ) {}

    createIndex(name: string, keyPath: string | string[]) {
      this.data.indexes.set(name, keyPath);
      return this.index(name);
    }

    index(name: string) {
      const keyPath = this.data.indexes.get(name);
      if (keyPath === undefined) throw new Error(`index ${name} not found`);
      return new MockIndex(this.data, keyPath, this.tx);
    }

    put(value: unknown) {
      const row = structuredClone(value) as Row;
      const key = row[this.data.keyPath];
      if (typeof key !== "string") throw new Error("IndexedDB put missing keyPath value");
      this.data.rows.set(key, row);
    }

    get(id: string) {
      const req = new MockRequest<Row | undefined>();
      this.tx.begin();
      queueMicrotask(() => {
        const row = this.data.rows.get(id);
        req.result = row ? structuredClone(row) : undefined;
        req.onsuccess?.({});
        this.tx.end();
      });
      return req;
    }

    delete(id: string) {
      this.data.rows.delete(id);
    }

    clear() {
      this.data.rows.clear();
    }

    getAll() {
      if (this.name === "events") stats.eventsGetAll += 1;
      const req = new MockRequest<Row[]>();
      this.tx.begin();
      queueMicrotask(() => {
        req.result = [...this.data.rows.values()].map((r) => structuredClone(r));
        req.onsuccess?.({});
        this.tx.end();
      });
      return req;
    }

    openCursor(range?: MockKeyRange, direction: "next" | "prev" = "next") {
      return openCursor(
        this.data,
        (row) => row[this.data.keyPath],
        range,
        direction,
        this.tx,
        stats,
      );
    }
  }

  class MockDb {
    objectStoreNames = {
      contains: (name: string) => this.rec.stores.has(name),
    };

    constructor(private rec: PersistedDb) {}

    getStore(name: string) {
      return this.rec.stores.get(name);
    }

    createObjectStore(name: string, options?: { keyPath?: string }) {
      if (this.rec.stores.has(name)) throw new Error(`store ${name} already exists`);
      const data: StoreData = {
        keyPath: options?.keyPath ?? "id",
        rows: new Map(),
        indexes: new Map(),
      };
      this.rec.stores.set(name, data);
      return new MockStore(data, new MockTx(this, "all"), name);
    }

    transaction(storeNames: string | string[], mode: "readonly" | "readwrite" = "readonly") {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      if (mode === "readwrite") stats.readwrite.push([...names]);
      return new MockTx(this, names);
    }

    close() {}
  }

  const indexedDB = {
    open(name: string, version = 1) {
      const req = new MockRequest<MockDb>();
      let rec = dbs.get(name);
      if (!rec) {
        rec = { version: 0, stores: new Map() };
        dbs.set(name, rec);
      }
      const db = new MockDb(rec);
      req.result = db;
      const oldVersion = rec.version;
      queueMicrotask(() => {
        if (oldVersion < version) {
          const tx = new MockTx(db, "all");
          tx.hold();
          req.onupgradeneeded?.({
            oldVersion,
            newVersion: version,
            target: { result: db, transaction: tx },
          });
          rec.version = version;
          const finish = () => req.complete(db);
          if (tx.completed) {
            finish();
          } else {
            const prev = tx.oncomplete;
            tx.oncomplete = (e) => {
              prev?.(e);
              finish();
            };
            tx.release();
          }
        } else {
          req.complete(db);
        }
      });
      return req;
    },
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = indexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = MockKeyRange;

  return {
    uninstall() {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      delete (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange;
      dbs.clear();
    },
    eventsGetAllCount: () => stats.eventsGetAll,
    cursorVisitCount: () => stats.cursorVisits,
    readwriteTransactions: () => stats.readwrite,
    resetStats() {
      stats.eventsGetAll = 0;
      stats.cursorVisits = 0;
      stats.readwrite = [];
    },
  };
}

export function seedIdbV1(dbName: string, events: Array<Record<string, unknown>>): Promise<void> {
  const factory = (
    globalThis as unknown as { indexedDB: { open(name: string, version?: number): MockOpenReq } }
  ).indexedDB;
  return new Promise((resolve, reject) => {
    const req = factory.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) {
        db.createObjectStore("events", { keyPath: "id" });
      }
    };
    req.onerror = () => reject(req.error ?? new Error("seed v1 open failed"));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("events", "readwrite");
      const store = tx.objectStore("events");
      for (const event of events) store.put(event);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error("seed v1 put failed"));
    };
  });
}

type MockOpenReq = {
  result: {
    objectStoreNames: { contains(name: string): boolean };
    createObjectStore(name: string, options?: { keyPath?: string }): unknown;
    transaction(
      storeNames: string | string[],
      mode?: "readonly" | "readwrite",
    ): {
      objectStore(name: string): { put(value: unknown): unknown };
      oncomplete: ((ev: unknown) => void) | null;
      onerror: ((ev: unknown) => void) | null;
      error: Error | null;
    };
    close(): void;
  };
  error: Error | null;
  onupgradeneeded: ((ev: unknown) => void) | null;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

function getKeyPath(row: Row, keyPath: string | string[]): unknown {
  if (typeof keyPath === "string") return row[keyPath];
  return keyPath.map((k) => row[k]);
}

function keyRangeIncludes(
  range: { lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean },
  key: unknown,
): boolean {
  const lo = cmp(key, range.lower);
  const hi = cmp(key, range.upper);
  if (range.lowerOpen ? lo <= 0 : lo < 0) return false;
  if (range.upperOpen ? hi >= 0 : hi > 0) return false;
  return true;
}

function openCursor(
  data: StoreData,
  keyOf: (row: Row) => unknown,
  range: { lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean } | undefined,
  direction: "next" | "prev",
  tx: { begin(): void; end(): void },
  stats: { cursorVisits: number },
) {
  const req = {
    result: undefined as { key: unknown; value: Row; continue(): void } | undefined,
    error: null as Error | null,
    onsuccess: null as ((ev: unknown) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
  };
  const entries: Array<{ key: unknown; primaryKey: unknown; value: Row }> = [];
  for (const row of data.rows.values()) {
    const key = keyOf(row);
    if (key === undefined) continue;
    if (range && !keyRangeIncludes(range, key)) continue;
    entries.push({ key, primaryKey: row[data.keyPath], value: row });
  }
  entries.sort((a, b) => {
    const c = cmp(a.key, b.key);
    if (c !== 0) return c;
    return cmp(a.primaryKey, b.primaryKey);
  });
  if (direction === "prev") entries.reverse();

  let pos = 0;
  const emit = () => {
    if (pos >= entries.length) {
      req.result = undefined;
      req.onsuccess?.({});
      tx.end();
      return;
    }
    stats.cursorVisits += 1;
    const entry = entries[pos]!;
    req.result = {
      key: entry.key,
      value: structuredClone(entry.value),
      continue() {
        pos += 1;
        tx.begin();
        queueMicrotask(emit);
      },
    };
    req.onsuccess?.({});
    tx.end();
  };
  tx.begin();
  queueMicrotask(emit);
  return req;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return 0;
}

function typeRank(value: unknown): number {
  if (typeof value === "number") return 1;
  if (typeof value === "string") return 2;
  if (Array.isArray(value)) return 3;
  return 0;
}
