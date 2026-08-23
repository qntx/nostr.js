import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventBuilder, IndexedDbEventStore, Keys, Kind } from "../src/index.ts";
import { installIdbMock, seedIdbV1, type IdbMock } from "./helpers/idb-mock.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const EID = "aa".repeat(32);

describe("IndexedDbEventStore", () => {
  let mock: IdbMock;

  beforeEach(() => {
    mock = installIdbMock();
  });

  afterEach(() => {
    mock.uninstall();
  });

  test("put query replaceable and deletion", async () => {
    expect(IndexedDbEventStore.isAvailable()).toBe(true);
    const store = new IndexedDbEventStore({ dbName: "test-nostr" });
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

  test("NIP-09 a-tag and pubkey check survive reopen", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "del-db" });
    await store.open();

    const meta = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    await store.put(meta);
    const note = EventBuilder.textNote("x").createdAt(1).signWithKeys(keys);
    await store.put(note);

    const foreign = EventBuilder.deletion([note.id]).createdAt(2).signWithKeys(other);
    await store.put(foreign);
    expect(await store.get(note.id)).toBeDefined();

    const del = EventBuilder.deletion([], "gone", {
      kinds: [0],
      addresses: [`0:${keys.publicKey}:`],
    })
      .createdAt(15)
      .signWithKeys(keys);
    await store.put(del);
    expect(await store.get(meta.id)).toBeUndefined();
    store.close();

    const reopened = new IndexedDbEventStore({ dbName: "del-db" });
    await reopened.open();
    expect(await reopened.get(meta.id)).toBeUndefined();
    expect(await reopened.get(note.id)).toBeDefined();
    const older = EventBuilder.metadata({ name: "old" }).createdAt(12).signWithKeys(keys);
    expect(await reopened.put(older)).toBe("duplicate");
    reopened.close();
  });

  test("survives close and reopen on same db name", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("persist").createdAt(7).signWithKeys(keys);

    const a = new IndexedDbEventStore({ dbName: "persist-db" });
    await a.open();
    expect(await a.put(note)).toBe("accepted");
    a.close();

    const b = new IndexedDbEventStore({ dbName: "persist-db" });
    await b.open();
    expect((await b.get(note.id))?.content).toBe("persist");
    const q = await b.query([{ kinds: [Kind.TextNote], authors: [keys.publicKey] }]);
    expect(q.map((e) => e.id)).toEqual([note.id]);
    b.close();
  });

  test("upgrades v1 to v2; query and kind-5 put do not getAll events", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const note = EventBuilder.textNote("v1").createdAt(1).signWithKeys(keys);
    const meta = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    const foreign = EventBuilder.deletion([note.id]).createdAt(2).signWithKeys(other);
    const del = EventBuilder.deletion([note.id]).createdAt(3).signWithKeys(keys);
    await seedIdbV1("upgrade-db", [note, meta, foreign, del]);

    const store = new IndexedDbEventStore({ dbName: "upgrade-db" });
    await store.open();
    expect(await store.get(note.id)).toBeUndefined();
    expect(await store.get(del.id)).toBeDefined();
    expect(await store.get(meta.id)).toBeDefined();

    mock.resetStats();
    const found = await store.query([{ kinds: [1], authors: [keys.publicKey] }]);
    expect(found).toHaveLength(0);
    expect(mock.eventsGetAllCount()).toBe(0);

    const extra = EventBuilder.textNote("after").createdAt(4).signWithKeys(keys);
    await store.put(extra);
    mock.resetStats();
    const kill = EventBuilder.deletion([extra.id]).createdAt(5).signWithKeys(keys);
    expect(await store.put(kill)).toBe("deleted");
    expect(mock.eventsGetAllCount()).toBe(0);
    expect(await store.get(extra.id)).toBeUndefined();
    store.close();
  });

  test("replaceable replace deletes old tag_refs and addresses", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "repl-tags" });
    await store.open();
    const a = EventBuilder.metadata({ name: "v1" })
      .tag(["e", EID])
      .createdAt(10)
      .signWithKeys(keys);
    const b = EventBuilder.metadata({ name: "v2" })
      .tag(["e", EID])
      .createdAt(20)
      .signWithKeys(keys);
    expect(await store.put(a)).toBe("accepted");
    expect(await store.put(b)).toBe("replaced");
    expect(await store.get(a.id)).toBeUndefined();
    const byE = await store.query([{ "#e": [EID] }]);
    expect(byE.map((e) => e.id)).toEqual([b.id]);
    store.close();
  });

  test("remove and kind-5 update all four stores in one tx", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "four-store" });
    await store.open();
    const note = EventBuilder.textNote("n").tag(["e", EID]).createdAt(1).signWithKeys(keys);
    const meta = EventBuilder.metadata({ name: "m" }).createdAt(2).signWithKeys(keys);
    await store.put(note);
    await store.put(meta);

    mock.resetStats();
    expect(await store.remove([note.id])).toBe(1);
    expect(mock.readwriteTransactions().at(-1)).toEqual([
      "events",
      "tag_refs",
      "addresses",
      "tombstones",
    ]);
    expect(await store.get(note.id)).toBeUndefined();
    expect(await store.query([{ "#e": [EID] }])).toEqual([]);

    mock.resetStats();
    const del = EventBuilder.deletion([meta.id]).createdAt(3).signWithKeys(keys);
    expect(await store.put(del)).toBe("deleted");
    expect(mock.readwriteTransactions()).toHaveLength(1);
    expect(mock.readwriteTransactions()[0]).toEqual([
      "events",
      "tag_refs",
      "addresses",
      "tombstones",
    ]);
    expect(await store.get(meta.id)).toBeUndefined();
    store.close();
  });

  test("tombstones survive close and a new instance", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "tomb-db" });
    await store.open();
    const note = EventBuilder.textNote("late").createdAt(1).signWithKeys(keys);
    const del = EventBuilder.deletion([note.id]).createdAt(2).signWithKeys(keys);
    expect(await store.put(del)).toBe("deleted");
    store.close();

    const reopened = new IndexedDbEventStore({ dbName: "tomb-db" });
    await reopened.open();
    expect(await reopened.put(note)).toBe("duplicate");
    expect(await reopened.get(note.id)).toBeUndefined();
    reopened.close();
  });

  test("foreign kind 5 does not delete", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "foreign-del" });
    await store.open();
    const note = EventBuilder.textNote("keep").createdAt(1).signWithKeys(keys);
    await store.put(note);
    const foreign = EventBuilder.deletion([note.id]).createdAt(2).signWithKeys(other);
    expect(await store.put(foreign)).toBe("deleted");
    expect(await store.get(note.id)).toBeDefined();
    store.close();
  });

  test("limit since until #e #p and ids", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "filters" });
    await store.open();
    const notes = [1, 2, 3, 4, 5].map((t) =>
      EventBuilder.textNote(String(t))
        .tag(["e", EID])
        .tag(["p", keys.publicKey])
        .createdAt(t)
        .signWithKeys(keys),
    );
    for (const n of notes) await store.put(n);

    const windowed = await store.query([{ since: 2, until: 4 }]);
    expect(windowed.map((e) => e.created_at)).toEqual([4, 3, 2]);

    const limited = await store.query([{ kinds: [1], limit: 2 }]);
    expect(limited).toHaveLength(2);
    expect(limited.map((e) => e.created_at)).toEqual([5, 4]);

    const byE = await store.query([{ "#e": [EID], limit: 1 }]);
    expect(byE).toHaveLength(1);
    expect(byE[0]!.created_at).toBe(5);

    const byP = await store.query([{ "#p": [keys.publicKey], since: 3, until: 3 }]);
    expect(byP).toHaveLength(1);
    expect(byP[0]!.created_at).toBe(3);

    const byId = await store.query([{ ids: [notes[0]!.id] }]);
    expect(byId.map((e) => e.id)).toEqual([notes[0]!.id]);
    store.close();
  });

  test("authors+kinds prefix cursor does not visit other authors", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "prefix" });
    await store.open();
    for (let i = 0; i < 30; i++) {
      await store.put(
        EventBuilder.textNote(`o${i}`)
          .createdAt(100 + i)
          .signWithKeys(other),
      );
    }
    for (let i = 0; i < 3; i++) {
      await store.put(
        EventBuilder.textNote(`m${i}`)
          .createdAt(10 + i)
          .signWithKeys(keys),
      );
    }

    mock.resetStats();
    const one = await store.query([{ authors: [keys.publicKey], kinds: [1], limit: 1 }]);
    expect(one).toHaveLength(1);
    expect(one[0]!.pubkey).toBe(keys.publicKey);
    expect(mock.cursorVisitCount()).toBe(1);
    expect(mock.eventsGetAllCount()).toBe(0);

    mock.resetStats();
    const many = await store.query([{ authors: [keys.publicKey], kinds: [1], limit: 50 }]);
    expect(many).toHaveLength(3);
    expect(mock.cursorVisitCount()).toBe(3);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("search in local filter does not throw and does not restrict", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "search" });
    await store.open();
    const a = EventBuilder.textNote("alpha").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("beta").createdAt(2).signWithKeys(keys);
    await store.put(a);
    await store.put(b);
    const found = await store.query([{ kinds: [1], search: "nope" }]);
    expect(found.map((e) => e.id)).toEqual([b.id, a.id]);
    store.close();
  });

  test("fresh v2 open never getAlls events", async () => {
    const store = new IndexedDbEventStore({ dbName: "fresh" });
    await store.open();
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });
});
