import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventBuilder, IndexedDbEventStore, Keys, Kind } from "../src/index.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

/** Minimal in-memory IndexedDB mock for unit tests (no real browser). */
function installIdbMock() {
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
      // Assign result before upgrade so handlers can use req.result.
      req.result = db;
      queueMicrotask(() => {
        req.onupgradeneeded?.({});
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

describe("IndexedDbEventStore", () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installIdbMock();
  });

  afterEach(() => {
    uninstall();
  });

  test("put query replaceable and deletion", async () => {
    expect(IndexedDbEventStore.isAvailable()).toBe(true);
    const store = new IndexedDbEventStore({ dbName: "test-nostr", storeName: "events" });
    await store.open();
    const keys = Keys.fromSecretKey(SK);

    const meta1 = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    const meta2 = EventBuilder.metadata({ name: "v2" }).createdAt(20).signWithKeys(keys);
    expect(await store.put(meta1)).toBe("accepted");
    expect(await store.put(meta2)).toBe("replaced");
    expect(await store.get(meta1.id)).toBeUndefined();
    expect((await store.get(meta2.id))?.content).toContain("v2");

    const note = EventBuilder.textNote("keep").createdAt(1).signWithKeys(keys);
    await store.put(note);
    const del = EventBuilder.deletion([note.id]).createdAt(2).signWithKeys(keys);
    expect(await store.put(del)).toBe("deleted");
    expect(await store.get(note.id)).toBeUndefined();

    const found = await store.query([{ kinds: [Kind.Metadata], authors: [keys.publicKey] }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(meta2.id);

    store.close();
  });
});
