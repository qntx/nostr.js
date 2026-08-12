/**
 * Minimal in-memory IndexedDB factory for unit tests (no browser).
 * Installs on `globalThis.indexedDB` and returns an uninstall function.
 */
export function installIdbMock(): () => void {
  type Row = Record<string, unknown> & { id: string };
  const dbs = new Map<string, Map<string, Map<string, Row>>>();

  class MockRequest<T> {
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

  class MockStore {
    constructor(private rows: Map<string, Row>) {}
    put(row: Row) {
      this.rows.set(row.id, structuredClone(row));
    }
    get(id: string) {
      const req = new MockRequest<Row | undefined>();
      queueMicrotask(() =>
        req.complete(this.rows.has(id) ? structuredClone(this.rows.get(id)!) : undefined),
      );
      return req;
    }
    delete(id: string) {
      this.rows.delete(id);
    }
    clear() {
      this.rows.clear();
    }
    getAll() {
      const req = new MockRequest<Row[]>();
      queueMicrotask(() => req.complete([...this.rows.values()].map((r) => structuredClone(r))));
      return req;
    }
  }

  class MockTx {
    oncomplete: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    error: Error | null = null;
    constructor(private rows: Map<string, Row>) {
      queueMicrotask(() => this.oncomplete?.({}));
    }
    objectStore() {
      return new MockStore(this.rows);
    }
  }

  class MockDb {
    objectStoreNames = {
      contains: (name: string) => this.stores.has(name),
    };
    constructor(private stores: Map<string, Map<string, Row>>) {}
    createObjectStore(name: string) {
      if (!this.stores.has(name)) this.stores.set(name, new Map());
    }
    transaction(storeName: string) {
      let rows = this.stores.get(storeName);
      if (!rows) {
        rows = new Map();
        this.stores.set(storeName, rows);
      }
      return new MockTx(rows);
    }
    close() {}
  }

  const indexedDB = {
    open(name: string) {
      const req = new MockRequest<MockDb>();
      if (!dbs.has(name)) dbs.set(name, new Map());
      const stores = dbs.get(name)!;
      const db = new MockDb(stores);
      req.result = db;
      queueMicrotask(() => {
        // Only fire upgrade when the store map is empty (first open).
        if (stores.size === 0) req.onupgradeneeded?.({});
        req.complete(db);
      });
      return req;
    },
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = indexedDB;
  return () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    dbs.clear();
  };
}
