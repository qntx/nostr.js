import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { itemCompare } from "../src/core/index.ts";
import { EventBuilder, IndexedDbEventStore, Keys, Kind, StorageError } from "../src/index.ts";
import {
  installIdbMock,
  seedIdbV1,
  seedIdbV2,
  seedIdbV3,
  type IdbMock,
} from "./helpers/idb-mock.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const EID = "aa".repeat(32);

async function tickUntil(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for IndexedDB mock");
}

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
    expect(await store.query([{ since: 5, until: 1 }])).toEqual([]);
    expect(await store.query([{ kinds: [1], limit: 0 }])).toEqual([]);

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
    expect(mock.cursorVisitCount()).toBeLessThan(30);
    expect(mock.eventsGetAllCount()).toBe(0);

    mock.resetStats();
    const many = await store.query([{ authors: [keys.publicKey], kinds: [1], limit: 50 }]);
    expect(many).toHaveLength(3);
    expect(mock.cursorVisitCount()).toBeLessThan(30);
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

  test("NIP-10 dual #e tags do not double-count toward limit", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "nip10-limit" });
    await store.open();
    const root = "11".repeat(32);
    const parent = "22".repeat(32);
    const reply = EventBuilder.textNote("reply")
      .tag(["e", root])
      .tag(["e", parent])
      .createdAt(10)
      .signWithKeys(keys);
    const other = EventBuilder.textNote("other").tag(["e", parent]).createdAt(5).signWithKeys(keys);
    await store.put(reply);
    await store.put(other);
    const found = await store.query([{ "#e": [root, parent], limit: 2 }]);
    expect(found.map((e) => e.id)).toEqual([reply.id, other.id]);
    store.close();
  });

  test("mixed-case authors and #e/#p match like matchFilter", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "case-hex" });
    await store.open();
    const note = EventBuilder.textNote("n").tag(["e", EID]).createdAt(1).signWithKeys(keys);
    const mixed = {
      ...note,
      id: note.id.toUpperCase(),
      pubkey: note.pubkey.toUpperCase(),
      tags: [
        ["e", EID.toUpperCase()],
        ["p", keys.publicKey.toUpperCase()],
      ] as typeof note.tags,
    };
    expect(await store.put(mixed)).toBe("accepted");
    expect((await store.get(note.id.toUpperCase()))?.id).toBe(note.id);
    expect(
      await store.query([{ authors: [keys.publicKey.toUpperCase()], kinds: [1] }]),
    ).toHaveLength(1);
    expect(await store.query([{ "#e": [EID.toUpperCase()] }])).toHaveLength(1);
    expect(await store.query([{ "#p": [keys.publicKey.toUpperCase()] }])).toHaveLength(1);
    store.close();
  });

  test("negentropyItems and count do not getAll events", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "neg-items" });
    await store.open();
    const older = EventBuilder.textNote("old").createdAt(1).signWithKeys(keys);
    const newer = EventBuilder.textNote("new").createdAt(2).signWithKeys(keys);
    const foreign = EventBuilder.textNote("other").createdAt(3).signWithKeys(other);
    const meta1 = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    const meta2 = EventBuilder.metadata({ name: "v2" }).createdAt(20).signWithKeys(keys);
    await store.put(older);
    await store.put(newer);
    await store.put(foreign);
    expect(await store.put(meta1)).toBe("accepted");
    expect(await store.put(meta2)).toBe("replaced");

    mock.resetStats();
    const items = await store.negentropyItems({ kinds: [1], authors: [keys.publicKey] });
    expect(items.map((i) => i.id)).toEqual([older.id, newer.id]);
    expect(items.map((i) => i.created_at)).toEqual([1, 2]);
    expect(mock.eventsGetAllCount()).toBe(0);

    mock.resetStats();
    const n = await store.count([{ kinds: [1], authors: [keys.publicKey] }]);
    expect(n).toBe(2);
    expect(n).toBe((await store.query([{ kinds: [1], authors: [keys.publicKey] }])).length);
    expect(mock.eventsGetAllCount()).toBe(0);

    mock.resetStats();
    const metaItems = await store.negentropyItems({ kinds: [Kind.Metadata] });
    expect(metaItems.map((i) => i.id)).toEqual([meta2.id]);
    expect(await store.count([{ kinds: [Kind.Metadata] }])).toBe(1);
    expect(mock.eventsGetAllCount()).toBe(0);

    const tagged = EventBuilder.textNote("tag").tag(["e", EID]).createdAt(4).signWithKeys(keys);
    await store.put(tagged);
    mock.resetStats();
    const byE = await store.negentropyItems({ "#e": [EID] });
    expect(byE.map((i) => i.id)).toEqual([tagged.id]);
    expect(await store.count([{ "#e": [EID] }])).toBe(1);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("v1 superseded replaceable is omitted after a-tag deletion", async () => {
    const keys = Keys.fromSecretKey(SK);
    const meta1 = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    const meta2 = EventBuilder.metadata({ name: "v2" }).createdAt(20).signWithKeys(keys);
    await seedIdbV1("coord-leak", [meta1, meta2]);
    const store = new IndexedDbEventStore({ dbName: "coord-leak" });
    await store.open();
    const del = EventBuilder.deletion([], "gone", {
      kinds: [0],
      addresses: [`0:${keys.publicKey}:`],
    })
      .createdAt(25)
      .signWithKeys(keys);
    expect(await store.put(del)).toBe("deleted");
    mock.resetStats();
    const filter = { kinds: [Kind.Metadata], authors: [keys.publicKey] };
    expect(await store.query([filter])).toEqual([]);
    expect(await store.count([filter])).toBe(0);
    expect(await store.negentropyItems(filter)).toEqual([]);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("ids+limit still applies authors matchFilter", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "ids-authors-limit" });
    await store.open();
    const older = EventBuilder.textNote("old").createdAt(1).signWithKeys(keys);
    const newer = EventBuilder.textNote("new").createdAt(2).signWithKeys(keys);
    await store.put(older);
    await store.put(newer);
    const filter = { ids: [older.id, newer.id], authors: [other.publicKey], limit: 1 };
    expect(filter.authors).toEqual([other.publicKey]);
    expect(await store.query([filter])).toEqual([]);
    expect(await store.count([filter])).toBe(0);
    expect(await store.negentropyItems(filter)).toEqual([]);
    store.close();
  });

  test("same-second k-way drain emits lowest ids", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "same-second" });
    await store.open();
    const mk = (id: string, pubkey: string) => ({
      id,
      pubkey,
      kind: Kind.TextNote,
      created_at: 5,
      tags: [] as [],
      content: "",
      sig: "ab".repeat(32),
    });
    const e00 = mk("00".repeat(32), a.publicKey);
    const e80 = mk("80".repeat(32), b.publicKey);
    const eff = mk("ff".repeat(32), a.publicKey);
    await store.put(eff);
    await store.put(e00);
    await store.put(e80);
    const filter = { authors: [a.publicKey, b.publicKey], kinds: [1], limit: 2 };
    const found = await store.query([filter]);
    expect(found.map((e) => e.id)).toEqual([e00.id, e80.id]);
    expect(await store.count([filter])).toBe(2);
    expect((await store.negentropyItems(filter)).map((i) => i.id)).toEqual([e00.id, e80.id]);

    const oneAuthor = Keys.generate();
    const p00 = mk("01".repeat(32), oneAuthor.publicKey);
    const p80 = mk("81".repeat(32), oneAuthor.publicKey);
    const pff = mk("fe".repeat(32), oneAuthor.publicKey);
    await store.put(pff);
    await store.put(p00);
    await store.put(p80);
    const inner = { authors: [oneAuthor.publicKey], kinds: [1], limit: 2 };
    expect((await store.query([inner])).map((e) => e.id)).toEqual([p00.id, p80.id]);
    store.close();
  });

  test("deleted heads do not count toward limit", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "skip-deleted-limit" });
    await store.open();
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    const c = EventBuilder.textNote("c").createdAt(3).signWithKeys(keys);
    await store.put(a);
    await store.put(b);
    await store.put(c);
    await store.remove([c.id]);
    const filter = { authors: [keys.publicKey], kinds: [1], limit: 1 };
    expect((await store.query([filter])).map((e) => e.id)).toEqual([b.id]);
    expect(await store.count([filter])).toBe(1);
    store.close();
  });

  test("authors+kinds+#t skips non-matching heads toward limit", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "skip-tag-limit" });
    await store.open();
    const tagged = EventBuilder.textNote("hit").tag(["t", "nostr"]).createdAt(1).signWithKeys(keys);
    const newer = EventBuilder.textNote("miss").createdAt(2).signWithKeys(keys);
    await store.put(tagged);
    await store.put(newer);
    const filter = { authors: [keys.publicKey], kinds: [1], "#t": ["nostr"], limit: 1 };
    expect(filter["#t"]).toEqual(["nostr"]);
    expect((await store.query([filter])).map((e) => e.id)).toEqual([tagged.id]);
    expect(await store.count([filter])).toBe(1);
    store.close();
  });

  test("two-prefix limit does not throw continue-after-complete", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "tx-lifetime" });
    await store.open();
    for (const t of [1, 2, 3, 4, 5]) {
      await store.put(EventBuilder.textNote(`a${t}`).createdAt(t).signWithKeys(a));
      await store.put(
        EventBuilder.textNote(`b${t}`)
          .createdAt(t + 10)
          .signWithKeys(b),
      );
    }
    mock.resetStats();
    const n = 3;
    const found = await store.query([
      { authors: [a.publicKey, b.publicKey], kinds: [1], limit: n },
    ]);
    expect(found).toHaveLength(n);
    expect(found.map((e) => e.created_at)).toEqual([15, 14, 13]);
    expect(mock.cursorVisitCount()).toBeLessThan(10);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("v3 compact deletes leftover kind 0 and tag_refs", async () => {
    const keys = Keys.fromSecretKey(SK);
    const meta1 = EventBuilder.metadata({ name: "v1" })
      .tag(["e", EID])
      .tag(["p", keys.publicKey])
      .createdAt(10)
      .signWithKeys(keys);
    const meta2 = EventBuilder.metadata({ name: "v2" })
      .tag(["e", EID])
      .createdAt(20)
      .signWithKeys(keys);
    await seedIdbV1("compact-k0", [meta1, meta2]);
    const store = new IndexedDbEventStore({ dbName: "compact-k0" });
    await store.open();
    mock.resetStats();
    const found = await store.query([{ kinds: [Kind.Metadata] }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(meta2.id);
    expect(await store.count([{ kinds: [Kind.Metadata] }])).toBe(1);
    expect(await store.get(meta1.id)).toBeUndefined();
    expect(mock.eventsGetAllCount()).toBe(0);
    expect((await store.query([{ "#e": [EID] }])).map((e) => e.id)).toEqual([meta2.id]);
    expect(await store.query([{ "#p": [keys.publicKey] }])).toEqual([]);
    store.close();
  });

  test("v2 leftover kind 0 is compacted on open", async () => {
    const keys = Keys.fromSecretKey(SK);
    const loser = EventBuilder.metadata({ name: "v1" })
      .tag(["e", EID])
      .tag(["p", keys.publicKey])
      .createdAt(10)
      .signWithKeys(keys);
    const winner = EventBuilder.metadata({ name: "v2" })
      .tag(["e", EID])
      .createdAt(20)
      .signWithKeys(keys);
    const eVal = EID.toLowerCase();
    const pVal = keys.publicKey.toLowerCase();
    await seedIdbV2("v2-compact", {
      events: [loser, winner],
      addresses: [
        { address: `0:${keys.publicKey}:`, id: winner.id, created_at: winner.created_at },
      ],
      tagRefs: [
        {
          key: `e:${eVal}:${loser.id.toLowerCase()}`,
          name: "e",
          value: eVal,
          id: loser.id.toLowerCase(),
          created_at: loser.created_at,
        },
        {
          key: `p:${pVal}:${loser.id.toLowerCase()}`,
          name: "p",
          value: pVal,
          id: loser.id.toLowerCase(),
          created_at: loser.created_at,
        },
        {
          key: `e:${eVal}:${winner.id.toLowerCase()}`,
          name: "e",
          value: eVal,
          id: winner.id.toLowerCase(),
          created_at: winner.created_at,
        },
      ],
    });
    const store = new IndexedDbEventStore({ dbName: "v2-compact" });
    await store.open();
    const found = await store.query([{ kinds: [0] }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(winner.id);
    expect(await store.get(loser.id)).toBeUndefined();
    expect((await store.query([{ "#e": [EID] }])).map((e) => e.id)).toEqual([winner.id]);
    expect(await store.query([{ "#p": [keys.publicKey] }])).toEqual([]);
    mock.resetStats();
    await store.query([{ kinds: [0] }]);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("#e and #p k-way merge is AND and respects limit", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "ep-and" });
    await store.open();
    const both = EventBuilder.textNote("both")
      .tag(["e", EID])
      .tag(["p", keys.publicKey])
      .createdAt(10)
      .signWithKeys(keys);
    const onlyE = EventBuilder.textNote("e").tag(["e", EID]).createdAt(20).signWithKeys(keys);
    const onlyP = EventBuilder.textNote("p")
      .tag(["p", keys.publicKey])
      .createdAt(30)
      .signWithKeys(keys);
    await store.put(both);
    await store.put(onlyE);
    await store.put(onlyP);
    const filter = { "#e": [EID], "#p": [keys.publicKey], limit: 2 };
    expect(filter["#e"]).toEqual([EID]);
    expect(filter["#p"]).toEqual([keys.publicKey]);
    const found = await store.query([filter]);
    expect(found.map((e) => e.id)).toEqual([both.id]);
    expect(await store.count([filter])).toBe(1);
    store.close();
  });

  test("#t-only queries scan created_at and matchFilter", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "t-tag" });
    await store.open();
    const hit = EventBuilder.textNote("hit").tag(["t", "nostr"]).createdAt(1).signWithKeys(keys);
    const miss = EventBuilder.textNote("miss").tag(["t", "other"]).createdAt(2).signWithKeys(keys);
    await store.put(hit);
    await store.put(miss);
    expect((await store.query([{ "#t": ["nostr"] }])).map((e) => e.id)).toEqual([hit.id]);
    expect((await store.query([{ "#t": ["other"] }])).map((e) => e.id)).toEqual([miss.id]);
    store.close();
  });

  test("ids+limit on negentropyItems keeps newest not ids-array order", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "ids-limit" });
    await store.open();
    const older = EventBuilder.textNote("old").createdAt(1).signWithKeys(keys);
    const newer = EventBuilder.textNote("new").createdAt(2).signWithKeys(keys);
    await store.put(older);
    await store.put(newer);
    mock.resetStats();
    const items = await store.negentropyItems({ ids: [older.id, newer.id], limit: 1 });
    expect(items.map((i) => i.id)).toEqual([newer.id]);
    expect((await store.query([{ ids: [older.id, newer.id], limit: 1 }])).map((e) => e.id)).toEqual(
      [newer.id],
    );
    expect(await store.count([{ ids: [older.id, newer.id], limit: 1 }])).toBe(1);
    expect(await store.query([{ ids: ["ab".repeat(32)], limit: 1 }])).toEqual([]);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("count equals query length under multi-prefix limit; items are global recency", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "multi-prefix" });
    await store.open();
    const aNotes = [1, 2, 3].map((t) =>
      EventBuilder.textNote(`a${t}`).createdAt(t).signWithKeys(a),
    );
    const bNotes = [10, 11, 12].map((t) =>
      EventBuilder.textNote(`b${t}`).createdAt(t).signWithKeys(b),
    );
    for (const n of aNotes) await store.put(n);
    for (const n of bNotes) await store.put(n);

    const filter = { authors: [a.publicKey, b.publicKey], kinds: [1], limit: 2 };
    mock.resetStats();
    const queried = await store.query([filter]);
    expect(await store.count([filter])).toBe(queried.length);
    expect(queried.map((e) => e.created_at)).toEqual([12, 11]);
    expect(queried.map((e) => e.id)).toEqual([bNotes[2]!.id, bNotes[1]!.id]);

    const items = await store.negentropyItems(filter);
    expect(items.map((i) => i.created_at)).toEqual([11, 12]);
    expect(items.map((i) => i.id)).toEqual(
      [bNotes[1]!, bNotes[2]!].sort((x, y) => itemCompare(x, y)).map((e) => e.id),
    );
    expect(items.map((i) => i.id).sort()).toEqual(queried.map((e) => e.id).sort());
    expect(
      (await store.query([{ authors: [a.publicKey, b.publicKey], limit: 2 }])).map(
        (e) => e.created_at,
      ),
    ).toEqual([12, 11]);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("ephemeral kinds are not inserted", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "ephemeral-db" });
    await store.open();
    const auth = new EventBuilder(Kind.ClientAuth, "")
      .tag(["relay", "wss://r.example"])
      .createdAt(1)
      .signWithKeys(keys);
    const wrap = new EventBuilder(Kind.GiftWrapEphemeral, "x")
      .tag(["p", keys.publicKey])
      .tag(["e", EID])
      .createdAt(2)
      .signWithKeys(keys);
    expect(await store.put(auth)).toBe("ephemeral");
    expect(await store.put(wrap)).toBe("ephemeral");
    expect(await store.get(auth.id)).toBeUndefined();
    expect(await store.get(wrap.id)).toBeUndefined();
    expect(await store.query([{ kinds: [Kind.ClientAuth] }])).toEqual([]);
    expect(await store.query([{ kinds: [Kind.GiftWrapEphemeral] }])).toEqual([]);
    expect(await store.query([{ "#p": [keys.publicKey] }])).toEqual([]);
    expect(await store.query([{ "#e": [EID] }])).toEqual([]);
    expect(await store.count([{ kinds: [Kind.ClientAuth, Kind.GiftWrapEphemeral] }])).toBe(0);
    expect(await store.negentropyItems({ kinds: [Kind.ClientAuth] })).toEqual([]);

    const note = EventBuilder.textNote("keep").tag(["e", EID]).createdAt(3).signWithKeys(keys);
    expect(await store.put(note)).toBe("accepted");
    expect((await store.get(note.id))?.id).toBe(note.id);
    expect((await store.query([{ "#e": [EID] }])).map((e) => e.id)).toEqual([note.id]);
    store.close();
  });

  test("negentropyItems same created_at sorts by id lexicographically", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "same-ts" });
    await store.open();
    const high = {
      id: "ff".repeat(32),
      pubkey: keys.publicKey,
      kind: Kind.TextNote,
      created_at: 5,
      tags: [] as [],
      content: "",
      sig: "ab".repeat(32),
    };
    const low = { ...high, id: "00".repeat(32) };
    await store.put(high);
    await store.put(low);
    expect(await store.negentropyItems({ kinds: [Kind.TextNote] })).toEqual([
      { id: low.id, created_at: 5 },
      { id: high.id, created_at: 5 },
    ]);
    expect(itemCompare(low, high)).toBeLessThan(0);
    store.close();
  });

  test("v1 mixed-case pubkey and e-tag are queryable after upgrade", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("v1").tag(["e", EID]).createdAt(1).signWithKeys(keys);
    await seedIdbV1("case-upgrade", [
      {
        ...note,
        pubkey: note.pubkey.toUpperCase(),
        tags: [["e", EID.toUpperCase()]],
      },
    ]);
    const store = new IndexedDbEventStore({ dbName: "case-upgrade" });
    await store.open();
    mock.resetStats();
    expect(await store.query([{ authors: [keys.publicKey], kinds: [1] }])).toHaveLength(1);
    expect(await store.query([{ "#e": [EID] }])).toHaveLength(1);
    expect(mock.eventsGetAllCount()).toBe(0);
    store.close();
  });

  test("putMany empty does not open a transaction", async () => {
    const store = new IndexedDbEventStore({ dbName: "putmany-empty" });
    await store.open();
    mock.resetStats();
    expect(await store.putMany([])).toEqual([]);
    expect(mock.readwriteTransactions()).toEqual([]);
    store.close();
  });

  test("putMany writes N events in one transaction", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "putmany-one-tx" });
    await store.open();
    const notes = [1, 2, 3].map((t) =>
      EventBuilder.textNote(String(t)).createdAt(t).signWithKeys(keys),
    );
    mock.resetStats();
    expect(await store.putMany(notes)).toEqual(["accepted", "accepted", "accepted"]);
    expect(mock.readwriteTransactions()).toHaveLength(1);
    expect(mock.readwriteTransactions()[0]).toEqual([
      "events",
      "tag_refs",
      "addresses",
      "tombstones",
    ]);
    expect((await store.query([{ kinds: [1] }])).map((e) => e.created_at)).toEqual([3, 2, 1]);
    store.close();
  });

  test("putMany applies replaceable semantics in input order", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "putmany-repl" });
    await store.open();
    const old = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    const neu = EventBuilder.metadata({ name: "v2" }).createdAt(20).signWithKeys(keys);
    mock.resetStats();
    expect(await store.putMany([old, neu])).toEqual(["accepted", "replaced"]);
    expect(mock.readwriteTransactions()).toHaveLength(1);
    expect(await store.get(old.id)).toBeUndefined();
    expect((await store.get(neu.id))?.content).toContain("v2");

    const older = EventBuilder.metadata({ name: "v0" }).createdAt(5).signWithKeys(keys);
    expect(await store.putMany([older])).toEqual(["rejected"]);
    expect((await store.get(neu.id))?.id).toBe(neu.id);
    store.close();
  });

  test("putMany abort rejects StorageError and persists nothing", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "putmany-abort" });
    await store.open();
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    mock.failGetOnCall(2);
    await expect(store.putMany([a, b])).rejects.toBeInstanceOf(StorageError);
    expect(await store.get(a.id)).toBeUndefined();
    expect(await store.get(b.id)).toBeUndefined();
    expect(await store.query([{ kinds: [1] }])).toEqual([]);
    store.close();
  });

  test("overlapping putMany waits for the in-flight write", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "putmany-serial" });
    await store.open();
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    const c = EventBuilder.textNote("c").createdAt(3).signWithKeys(keys);
    mock.resetStats();
    const gate = mock.gateGetOnCall(1);
    const first = store.putMany([a]);
    await tickUntil(() => mock.readwriteTransactions().length === 1);
    const second = store.putMany([b, c]);
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.readwriteTransactions()).toHaveLength(1);
    gate.release();
    expect(await first).toEqual(["accepted"]);
    expect(await second).toEqual(["accepted", "accepted"]);
    expect(mock.readwriteTransactions()).toHaveLength(2);
    expect((await store.query([{ kinds: [1] }])).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    store.close();
  });

  test("setOutboxBound waits behind an in-flight putMany", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "bound-behind-put" });
    await store.open();
    const note = EventBuilder.textNote("n").createdAt(50).signWithKeys(keys);
    mock.resetStats();
    const gate = mock.gateGetOnCall(1);
    const put = store.putMany([note]);
    await tickUntil(() => mock.readwriteTransactions().length === 1);
    const boundP = store.setOutboxBound(keys.publicKey, 1, { oldest: 1, newest: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.readwriteTransactions()).not.toContainEqual(["outbox_bounds"]);
    gate.release();
    expect(await put).toEqual(["accepted"]);
    await boundP;
    expect(mock.readwriteTransactions()).toContainEqual(["outbox_bounds"]);
    expect(await store.getOutboxBound(keys.publicKey, 1)).toEqual({ oldest: 1, newest: 2 });
    store.close();
  });

  test("clear then setOutboxBound keeps the bound; reverse drops it", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "bound-vs-clear" });
    await store.open();
    const note = EventBuilder.textNote("n").createdAt(50).signWithKeys(keys);
    mock.resetStats();
    const gate1 = mock.gateGetOnCall(1);
    const put1 = store.putMany([note]);
    await tickUntil(() => mock.readwriteTransactions().length === 1);
    const clear1 = store.clear();
    const bound1 = store.setOutboxBound(keys.publicKey, 1, { oldest: 1, newest: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.readwriteTransactions()).not.toContainEqual(["outbox_bounds"]);
    gate1.release();
    await put1;
    await clear1;
    await bound1;
    expect(await store.getOutboxBound(keys.publicKey, 1)).toEqual({ oldest: 1, newest: 2 });

    const later = EventBuilder.textNote("m").createdAt(51).signWithKeys(keys);
    mock.resetStats();
    const gate2 = mock.gateGetOnCall(1);
    const put2 = store.putMany([later]);
    await tickUntil(() => mock.readwriteTransactions().length === 1);
    const bound2 = store.setOutboxBound(keys.publicKey, 1, { oldest: 3, newest: 4 });
    const clear2 = store.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.readwriteTransactions()).not.toContainEqual(["outbox_bounds"]);
    gate2.release();
    await put2;
    await bound2;
    await clear2;
    expect(await store.getOutboxBound(keys.publicKey, 1)).toBeUndefined();
    store.close();
  });

  test("outbox bound persist survives close and reopen", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new IndexedDbEventStore({ dbName: "bounds-persist" });
    await store.open();
    await store.setOutboxBound(keys.publicKey, Kind.TextNote, { oldest: 10, newest: 20 });
    expect(await store.getOutboxBound(keys.publicKey, Kind.TextNote)).toEqual({
      oldest: 10,
      newest: 20,
    });
    mock.resetStats();
    await store.setOutboxBound(keys.publicKey, Kind.TextNote, { oldest: 10, newest: 30 });
    expect(mock.readwriteTransactions()).toEqual([["outbox_bounds"]]);
    store.close();

    const reopened = new IndexedDbEventStore({ dbName: "bounds-persist" });
    await reopened.open();
    expect(await reopened.getOutboxBound(keys.publicKey, Kind.TextNote)).toEqual({
      oldest: 10,
      newest: 30,
    });
    await reopened.clear();
    expect(await reopened.getOutboxBound(keys.publicKey, Kind.TextNote)).toBeUndefined();
    reopened.close();
  });

  test("v3 db gains outbox_bounds on open", async () => {
    const keys = Keys.fromSecretKey(SK);
    await seedIdbV3("v3-bounds");
    const store = new IndexedDbEventStore({ dbName: "v3-bounds" });
    await store.open();
    await store.setOutboxBound(keys.publicKey, 1, { oldest: 4, newest: 8 });
    expect(await store.getOutboxBound(keys.publicKey, 1)).toEqual({ oldest: 4, newest: 8 });
    store.close();
  });

  test("outbox bound derive uses prefix heads not getAll", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const store = new IndexedDbEventStore({ dbName: "bounds-derive" });
    await store.open();
    for (let t = 0; t < 20; t++) {
      await store.put(EventBuilder.textNote(`n${t}`).createdAt(t).signWithKeys(keys));
    }
    for (let t = 100; t < 110; t++) {
      await store.put(EventBuilder.textNote(`o${t}`).createdAt(t).signWithKeys(other));
    }
    mock.resetStats();
    expect(await store.getOutboxBound(keys.publicKey, Kind.TextNote)).toEqual({
      oldest: 0,
      newest: 19,
    });
    expect(mock.eventsGetAllCount()).toBe(0);
    expect(mock.cursorVisitCount()).toBe(2);
    expect(await store.getOutboxBound(other.publicKey, Kind.TextNote)).toEqual({
      oldest: 100,
      newest: 109,
    });
    store.close();
  });

  test("open with null req.error throws StorageError fallback", async () => {
    mock.failOpen(null);
    const store = new IndexedDbEventStore({ dbName: "open-null-err" });
    const err = await store.open().then(
      () => {
        throw new Error("expected reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).message).toBe("IndexedDB open failed");
    expect((err as StorageError).cause).toBeUndefined();
  });

  test("get with null req.error throws StorageError fallback", async () => {
    const store = new IndexedDbEventStore({ dbName: "get-null-err" });
    await store.open();
    mock.failGetOnCall(1, null);
    const err = await store.get(EID).then(
      () => {
        throw new Error("expected reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).message).toBe("IndexedDB request failed");
    expect((err as StorageError).cause).toBeUndefined();
    store.close();
  });
});
