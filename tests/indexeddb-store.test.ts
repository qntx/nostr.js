import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventBuilder, IndexedDbEventStore, Keys, Kind } from "../src/index.ts";
import { installIdbMock } from "./helpers/idb-mock.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

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

  test("survives close and reopen on same db name", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("persist").createdAt(7).signWithKeys(keys);

    const a = new IndexedDbEventStore({ dbName: "persist-db", storeName: "events" });
    await a.open();
    expect(await a.put(note)).toBe("accepted");
    a.close();

    const b = new IndexedDbEventStore({ dbName: "persist-db", storeName: "events" });
    await b.open();
    expect((await b.get(note.id))?.content).toBe("persist");
    const q = await b.query([{ kinds: [Kind.TextNote], authors: [keys.publicKey] }]);
    expect(q.map((e) => e.id)).toEqual([note.id]);
    b.close();
  });
});
