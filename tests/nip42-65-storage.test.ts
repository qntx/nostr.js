import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { itemCompare, sortedEvents } from "../src/core/index.ts";
import {
  EventBuilder,
  Keys,
  Kind,
  MemoryEventStore,
  Relay,
  isAuthRequired,
  isEphemeralKind,
  makeAuthEvent,
  parseRelayList,
  readRelays,
  relayListToTags,
  useWebSocketImplementation,
  writeRelays,
  type Event,
} from "../src/index.ts";
import * as nip77 from "../src/nips/nip77.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

describe("nip42", () => {
  test("makeAuthEvent shape", () => {
    const t = makeAuthEvent("wss://relay.example", "challenge-token");
    expect(t.kind).toBe(Kind.ClientAuth);
    expect(t.tags).toEqual([
      ["relay", "wss://relay.example"],
      ["challenge", "challenge-token"],
    ]);
    expect(isAuthRequired("auth-required: login")).toBe(true);
    expect(isAuthRequired("rate-limited")).toBe(false);
  });

  test("Relay.auth sends AUTH and waits for OK", async () => {
    MockWebSocket.reset();
    useWebSocketImplementation(MockWebSocketCtor);
    const relay = await Relay.connect("wss://auth.example");
    const keys = Keys.fromSecretKey(SK);

    let challengeSeen: string | undefined;
    relay.onauth = (c) => {
      challengeSeen = c;
    };

    MockWebSocket.last().receive(JSON.stringify(["AUTH", "abc-challenge"]));
    expect(challengeSeen).toBe("abc-challenge");
    expect(relay.challenge).toBe("abc-challenge");

    const authP = relay.auth(async (template) =>
      EventBuilder.textNote("")
        .kind(template.kind)
        .tags(template.tags)
        .content(template.content)
        .createdAt(template.created_at)
        .signWithKeys(keys),
    );

    await Promise.resolve();
    const ws = MockWebSocket.last();
    const authMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "AUTH") as [
      string,
      { id: string; kind: number },
    ];
    expect(authMsg[0]).toBe("AUTH");
    expect(authMsg[1].kind).toBe(Kind.ClientAuth);
    ws.receive(JSON.stringify(["OK", authMsg[1].id, true, ""]));

    const result = await authP;
    expect(result.ok).toBe(true);
    relay.close();
    MockWebSocket.reset();
  });

  test("CLOSED auth-required retries REQ after AUTH", async () => {
    MockWebSocket.reset();
    useWebSocketImplementation(MockWebSocketCtor);
    const keys = Keys.fromSecretKey(SK);
    const relay = await Relay.connect("wss://auth-retry.example", {
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });

    const got: string[] = [];
    const sub = relay.subscribe([{ kinds: [1] }], {
      onevent: (e) => {
        got.push(e.id);
      },
    });

    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["AUTH", "retry-challenge"]));
    ws.receive(JSON.stringify(["CLOSED", sub.id, "auth-required: login"]));

    await new Promise((r) => setTimeout(r, 20));
    const authFrame = ws.sent
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => m[0] === "AUTH") as [string, { id: string }] | undefined;
    expect(authFrame?.[0]).toBe("AUTH");
    ws.receive(JSON.stringify(["OK", authFrame![1].id, true, ""]));
    await new Promise((r) => setTimeout(r, 20));

    const reqs = ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "REQ");
    expect(reqs.length).toBeGreaterThanOrEqual(2);

    const note = EventBuilder.textNote("after auth").createdAt(1).signWithKeys(keys);
    ws.receive(JSON.stringify(["EVENT", sub.id, note]));
    expect(got).toEqual([note.id]);
    relay.close();
    MockWebSocket.reset();
  });
});

describe("nip65", () => {
  test("parse and encode relay list", () => {
    const keys = Keys.fromSecretKey(SK);
    const event = EventBuilder.relayList([
      { url: "wss://a.example" },
      { url: "wss://b.example", read: true, write: false },
      { url: "wss://c.example", read: false, write: true },
    ]).signWithKeys(keys);

    const items = parseRelayList(event);
    expect(items).toEqual([
      { url: "wss://a.example/", read: true, write: true },
      { url: "wss://b.example/", read: true, write: false },
      { url: "wss://c.example/", read: false, write: true },
    ]);
    // normalizeURL may add trailing slash depending on URL parser — accept both
    expect(readRelays(items).length).toBe(2);
    expect(writeRelays(items).length).toBe(2);

    const tags = relayListToTags([
      { url: "wss://x.example", read: true, write: true },
      { url: "wss://y.example", read: true, write: false },
    ]);
    expect(tags).toEqual([
      ["r", "wss://x.example"],
      ["r", "wss://y.example", "read"],
    ]);
  });
});

describe("MemoryEventStore", () => {
  test("put query replaceable and deletion", async () => {
    const store = new MemoryEventStore();
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

    const found = await store.query([{ kinds: [0], authors: [keys.publicKey] }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(meta2.id);
  });

  test("query applies limit per filter then unions", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const notes = [
      EventBuilder.textNote("a").createdAt(1).signWithKeys(keys),
      EventBuilder.textNote("b").createdAt(2).signWithKeys(keys),
    ];
    const meta = EventBuilder.metadata({ name: "n" }).createdAt(3).signWithKeys(keys);
    for (const e of notes) await store.put(e);
    await store.put(meta);
    const found = await store.query([
      { kinds: [1], limit: 10 },
      { kinds: [0], limit: 1 },
    ]);
    expect(found.filter((e) => e.kind === 1)).toHaveLength(2);
    expect(found.filter((e) => e.kind === 0)).toHaveLength(1);
  });

  test("NIP-09 a-tag deletes replaceable versions up to created_at", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const meta = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    await store.put(meta);
    const del = EventBuilder.deletion([], "gone", {
      kinds: [0],
      addresses: [`0:${keys.publicKey}:`],
    })
      .createdAt(15)
      .signWithKeys(keys);
    expect(await store.put(del)).toBe("deleted");
    expect(await store.get(meta.id)).toBeUndefined();

    const older = EventBuilder.metadata({ name: "old" }).createdAt(12).signWithKeys(keys);
    expect(await store.put(older)).toBe("duplicate");

    const newer = EventBuilder.metadata({ name: "v2" }).createdAt(20).signWithKeys(keys);
    expect(await store.put(newer)).toBe("accepted");
    expect((await store.get(newer.id))?.content).toContain("v2");
  });

  test("NIP-09 e-tag requires matching pubkey; deletion of deletion is a no-op", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const note = EventBuilder.textNote("keep").createdAt(1).signWithKeys(keys);
    await store.put(note);

    const foreign = EventBuilder.deletion([note.id]).createdAt(2).signWithKeys(other);
    expect(await store.put(foreign)).toBe("deleted");
    expect(await store.get(note.id)).toBeDefined();

    const first = EventBuilder.deletion([note.id]).createdAt(3).signWithKeys(keys);
    expect(await store.put(first)).toBe("deleted");
    expect(await store.get(note.id)).toBeUndefined();

    const undo = EventBuilder.deletion([first.id]).createdAt(4).signWithKeys(keys);
    expect(await store.put(undo)).toBe("deleted");
    expect(await store.get(note.id)).toBeUndefined();
    expect(await store.get(first.id)).toBeDefined();
  });

  test("NIP-09 pending e-tag hides the event when it arrives later", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("late").createdAt(1).signWithKeys(keys);
    const del = EventBuilder.deletion([note.id]).createdAt(2).signWithKeys(keys);
    expect(await store.put(del)).toBe("deleted");
    expect(await store.put(note)).toBe("duplicate");
    expect(await store.get(note.id)).toBeUndefined();
  });

  test("replace kind 0 and 10002 drops old id from query/count/negentropyItems", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);

    const meta1 = EventBuilder.metadata({ name: "v1" }).createdAt(10).signWithKeys(keys);
    const meta2 = EventBuilder.metadata({ name: "v2" }).createdAt(20).signWithKeys(keys);
    expect(await store.put(meta1)).toBe("accepted");
    expect(await store.put(meta2)).toBe("replaced");

    const list1 = EventBuilder.relayList([{ url: "wss://a.example" }])
      .createdAt(10)
      .signWithKeys(keys);
    const list2 = EventBuilder.relayList([{ url: "wss://b.example" }])
      .createdAt(20)
      .signWithKeys(keys);
    expect(await store.put(list1)).toBe("accepted");
    expect(await store.put(list2)).toBe("replaced");

    const q0 = await store.query([{ kinds: [Kind.Metadata] }]);
    expect(q0.map((e) => e.id)).toEqual([meta2.id]);
    expect(await store.count([{ kinds: [Kind.Metadata] }])).toBe(1);
    const items0 = await store.negentropyItems({ kinds: [Kind.Metadata] });
    expect(items0).toEqual([{ id: meta2.id, created_at: 20 }]);
    expect(items0.some((i) => i.id === meta1.id)).toBe(false);

    const q65 = await store.query([{ kinds: [Kind.RelayList] }]);
    expect(q65.map((e) => e.id)).toEqual([list2.id]);
    expect(await store.count([{ kinds: [Kind.RelayList] }])).toBe(1);
    const items65 = await store.negentropyItems({ kinds: [Kind.RelayList] });
    expect(items65.map((i) => i.id)).toEqual([list2.id]);
    expect(items65.some((i) => i.id === list1.id)).toBe(false);
  });

  test("count equals query length", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    const meta = EventBuilder.metadata({ name: "n" }).createdAt(3).signWithKeys(keys);
    await store.put(a);
    await store.put(b);
    await store.put(meta);

    const filters = [
      { kinds: [1], limit: 10 },
      { kinds: [0], limit: 1 },
      { authors: [keys.publicKey] },
    ];
    expect(await store.count(filters)).toBe((await store.query(filters)).length);
    expect(await store.count([{ kinds: [1] }])).toBe((await store.query([{ kinds: [1] }])).length);
    expect(await store.count([{ kinds: [1], limit: 1 }])).toBe(1);

    const items = await store.negentropyItems({ kinds: [1] });
    expect(items).toEqual([
      { id: a.id, created_at: 1 },
      { id: b.id, created_at: 2 },
    ]);
  });

  test("query({ids}) matches mixed-case stored ids like matchFilter", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    const mixed = { ...note, id: note.id.toUpperCase(), pubkey: note.pubkey.toUpperCase() };
    expect(await store.put(mixed)).toBe("accepted");
    expect((await store.get(note.id.toUpperCase()))?.id).toBe(note.id);
    expect((await store.query([{ ids: [note.id] }])).map((e) => e.id)).toEqual([note.id]);
    expect(await store.count([{ ids: [note.id.toUpperCase()] }])).toBe(1);
    expect(await store.negentropyItems({ ids: [note.id.toLowerCase()] })).toEqual([
      { id: note.id, created_at: 1 },
    ]);
  });

  test("ids+limit keeps newest, not ids-array order", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const older = EventBuilder.textNote("old").createdAt(1).signWithKeys(keys);
    const newer = EventBuilder.textNote("new").createdAt(2).signWithKeys(keys);
    await store.put(older);
    await store.put(newer);
    const filter = { ids: [older.id, newer.id], limit: 1 };
    expect((await store.query([filter])).map((e) => e.id)).toEqual([newer.id]);
    expect(await store.count([filter])).toBe(1);
    expect((await store.negentropyItems(filter)).map((i) => i.id)).toEqual([newer.id]);
  });

  test("negentropyItems 10k authors+kinds has no content and matches itemCompare", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const events: Event[] = [];
    for (let i = 0; i < 10_000; i++) {
      events.push({
        id: i.toString(16).padStart(64, "0"),
        pubkey: keys.publicKey,
        kind: Kind.TextNote,
        created_at: i,
        tags: [],
        content: "payload-should-not-appear-on-items",
        sig: "ab".repeat(32),
      });
    }
    for (const event of events) await store.put(event);
    const filter = { authors: [keys.publicKey], kinds: [Kind.TextNote] };
    const items = await store.negentropyItems(filter);
    expect(items).toHaveLength(10_000);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["created_at", "id"]);
    }
    const expected = events.map((e) => ({ id: e.id, created_at: e.created_at })).sort(itemCompare);
    expect(items).toEqual(expected);
    expect(await store.count([filter])).toBe((await store.query([filter])).length);
  });

  test("ephemeral kinds are not inserted", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const auth = new EventBuilder(Kind.ClientAuth, "")
      .tag(["relay", "wss://r.example"])
      .createdAt(1)
      .signWithKeys(keys);
    const wrap = new EventBuilder(Kind.GiftWrapEphemeral, "x")
      .tag(["p", keys.publicKey])
      .createdAt(2)
      .signWithKeys(keys);
    const lo = new EventBuilder(20_000, "lo").createdAt(3).signWithKeys(keys);
    const hi = new EventBuilder(29_999, "hi").createdAt(4).signWithKeys(keys);
    expect(isEphemeralKind(auth.kind)).toBe(true);
    expect(await store.put(auth)).toBe("ephemeral");
    expect(await store.put(wrap)).toBe("ephemeral");
    expect(await store.put(lo)).toBe("ephemeral");
    expect(await store.put(hi)).toBe("ephemeral");
    expect(store.size).toBe(0);
    expect(await store.get(auth.id)).toBeUndefined();
    expect(await store.get(wrap.id)).toBeUndefined();
    expect(await store.query([{ kinds: [Kind.ClientAuth] }])).toEqual([]);
    expect(await store.query([{ kinds: [Kind.GiftWrapEphemeral] }])).toEqual([]);
    expect(await store.query([{ "#p": [keys.publicKey] }])).toEqual([]);
    expect(await store.count([{ kinds: [Kind.ClientAuth] }])).toBe(0);
    expect(await store.negentropyItems({ kinds: [Kind.ClientAuth] })).toEqual([]);

    const below = new EventBuilder(19_999, "below").createdAt(5).signWithKeys(keys);
    const note = EventBuilder.textNote("keep").createdAt(6).signWithKeys(keys);
    expect(await store.put(below)).toBe("accepted");
    expect(await store.put(note)).toBe("accepted");
    expect(store.size).toBe(2);
    expect((await store.get(note.id))?.id).toBe(note.id);
    expect((await store.query([{ kinds: [1] }])).map((e) => e.id)).toEqual([note.id]);
  });

  test("negentropyItems same created_at sorts by id lexicographically", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const high: Event = {
      id: "ff".repeat(32),
      pubkey: keys.publicKey,
      kind: Kind.TextNote,
      created_at: 5,
      tags: [],
      content: "",
      sig: "ab".repeat(32),
    };
    const low: Event = { ...high, id: "00".repeat(32) };
    await store.put(high);
    await store.put(low);
    expect(await store.negentropyItems({ kinds: [Kind.TextNote] })).toEqual([
      { id: low.id, created_at: 5 },
      { id: high.id, created_at: 5 },
    ]);
  });

  test("authors×kinds uses kind+pubkey sets then sortEvents+slice", async () => {
    const store = new MemoryEventStore();
    const a = Keys.fromSecretKey(SK);
    const b = Keys.generate();
    const outsider = Keys.generate();

    const aMeta = EventBuilder.metadata({ name: "a" }).createdAt(50).signWithKeys(a);
    const aOld = EventBuilder.textNote("a-old").createdAt(10).signWithKeys(a);
    const aNew = EventBuilder.textNote("a-new").createdAt(30).signWithKeys(a);
    const bNote = EventBuilder.textNote("b").createdAt(40).signWithKeys(b);
    const bMeta = EventBuilder.metadata({ name: "b" }).createdAt(60).signWithKeys(b);
    const outNote = EventBuilder.textNote("out").createdAt(90).signWithKeys(outsider);
    for (const e of [aMeta, aOld, aNew, bNote, bMeta, outNote]) {
      expect(await store.put(e)).toBe("accepted");
    }

    const filter = { authors: [a.publicKey, b.publicKey], kinds: [Kind.TextNote], limit: 2 };
    expect((await store.query([filter])).map((e) => e.id)).toEqual([bNote.id, aNew.id]);
    expect(await store.count([filter])).toBe(2);
    expect((await store.negentropyItems(filter)).map((i) => i.id)).toEqual([aNew.id, bNote.id]);

    const metaFilter = {
      authors: [a.publicKey.toUpperCase(), b.publicKey],
      kinds: [Kind.Metadata],
    };
    expect((await store.query([metaFilter])).map((e) => e.id)).toEqual([bMeta.id, aMeta.id]);
    expect(await store.count([metaFilter])).toBe(2);

    expect(await store.query([{ authors: [], kinds: [Kind.TextNote] }])).toEqual([]);
    expect(await store.count([{ authors: [a.publicKey], kinds: [] }])).toBe(0);
    expect(
      await store.query([{ authors: [outsider.publicKey], kinds: [Kind.TextNote, Kind.Metadata] }]),
    ).toEqual([outNote]);
  });

  test("authors×kinds same created_at keeps lowest id first under limit", async () => {
    const store = new MemoryEventStore();
    const a = Keys.fromSecretKey(SK);
    const b = Keys.generate();
    const low: Event = {
      id: "00".repeat(32),
      pubkey: a.publicKey,
      kind: Kind.TextNote,
      created_at: 5,
      tags: [],
      content: "low",
      sig: "ab".repeat(32),
    };
    const mid: Event = { ...low, id: "80".repeat(32), pubkey: b.publicKey, content: "mid" };
    const high: Event = { ...low, id: "ff".repeat(32), content: "high" };
    for (const e of [high, mid, low]) expect(await store.put(e)).toBe("accepted");
    const filter = { authors: [a.publicKey, b.publicKey], kinds: [Kind.TextNote], limit: 2 };
    expect((await store.query([filter])).map((e) => e.id)).toEqual([low.id, mid.id]);
    expect(await store.count([filter])).toBe(2);
  });

  test("tag-only #e/#p indexes union then matchFilter AND; empty #e is no match", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.generate();
    const eid = "aa".repeat(32);
    const eidOther = "bb".repeat(32);
    const both = EventBuilder.textNote("both")
      .tag(["e", eid])
      .tag(["p", keys.publicKey])
      .createdAt(30)
      .signWithKeys(keys);
    const onlyE = EventBuilder.textNote("only-e").tag(["e", eid]).createdAt(20).signWithKeys(keys);
    const onlyP = EventBuilder.textNote("only-p")
      .tag(["p", keys.publicKey])
      .createdAt(10)
      .signWithKeys(keys);
    const otherE = EventBuilder.textNote("other-e")
      .tag(["e", eidOther])
      .createdAt(40)
      .signWithKeys(other);
    const untagged = EventBuilder.textNote("none").createdAt(50).signWithKeys(keys);
    for (const e of [both, onlyE, onlyP, otherE, untagged]) {
      expect(await store.put(e)).toBe("accepted");
    }

    const byE = { "#e": [eid] as const };
    expect((await store.query([byE])).map((e) => e.id)).toEqual([both.id, onlyE.id]);
    expect(await store.count([byE])).toBe(2);
    expect((await store.negentropyItems(byE)).map((i) => i.id)).toEqual([onlyE.id, both.id]);

    const byP = { "#p": [keys.publicKey] as const };
    expect((await store.query([byP])).map((e) => e.id)).toEqual([both.id, onlyP.id]);

    const andBoth = { "#e": [eid] as const, "#p": [keys.publicKey] as const };
    expect((await store.query([andBoth])).map((e) => e.id)).toEqual([both.id]);
    expect(await store.count([andBoth])).toBe(1);

    expect(await store.query([{ "#e": [eid], "#p": [other.publicKey] }])).toEqual([]);
    expect(await store.query([{ "#e": [eidOther], "#p": [keys.publicKey] }])).toEqual([]);
    expect(await store.query([{ "#e": [eidOther] }])).toEqual([otherE]);
    expect(await store.query([{ "#e": [] }])).toEqual([]);
    expect(await store.count([{ "#e": [] }])).toBe(0);
    expect(await store.query([{ "#p": [] }])).toEqual([]);
    expect(await store.query([{ "#e": [eid], limit: 0 }])).toEqual([]);
    expect(await store.query([{ "#e": [eid], since: 25, until: 35 }])).toEqual([both]);
    expect(await store.query([{ "#e": [eid], since: 40, until: 10 }])).toEqual([]);
    expect(await store.query([{ "#e": [eid], limit: 1 }])).toEqual([both]);
  });

  test("tag-only mixed-case #e/#p and dual #e tags do not double-count", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const eid = "aa".repeat(32);
    const root = "11".repeat(32);
    const parent = "22".repeat(32);
    const mixed = EventBuilder.textNote("mixed").createdAt(1).signWithKeys(keys);
    const stored = {
      ...mixed,
      id: mixed.id.toUpperCase(),
      pubkey: mixed.pubkey.toUpperCase(),
      tags: [
        ["e", eid.toUpperCase()],
        ["p", keys.publicKey.toUpperCase()],
      ] as typeof mixed.tags,
    };
    expect(await store.put(stored)).toBe("accepted");
    expect((await store.query([{ "#e": [eid.toUpperCase()] }])).map((e) => e.id)).toEqual([
      mixed.id,
    ]);
    expect(
      (await store.query([{ "#p": [keys.publicKey.toUpperCase()] }])).map((e) => e.id),
    ).toEqual([mixed.id]);

    const reply = EventBuilder.textNote("reply")
      .tag(["e", root])
      .tag(["e", parent])
      .createdAt(10)
      .signWithKeys(keys);
    const other = EventBuilder.textNote("other").tag(["e", parent]).createdAt(5).signWithKeys(keys);
    expect(await store.put(reply)).toBe("accepted");
    expect(await store.put(other)).toBe("accepted");
    const dual = { "#e": [root, parent] as const, limit: 2 };
    expect((await store.query([dual])).map((e) => e.id)).toEqual([reply.id, other.id]);
    expect(await store.count([dual])).toBe(2);
  });

  test("#t tag-only still matches via full scan; defined miss is empty", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const eid = "aa".repeat(32);
    const nostr = EventBuilder.textNote("n")
      .tag(["t", "nostr"])
      .tag(["e", eid])
      .createdAt(3)
      .signWithKeys(keys);
    const bitcoin = EventBuilder.textNote("b")
      .tag(["t", "bitcoin"])
      .createdAt(2)
      .signWithKeys(keys);
    const noT = EventBuilder.textNote("plain").tag(["e", eid]).createdAt(1).signWithKeys(keys);
    for (const e of [nostr, bitcoin, noT]) expect(await store.put(e)).toBe("accepted");

    expect((await store.query([{ "#t": ["nostr"] }])).map((e) => e.id)).toEqual([nostr.id]);
    expect(await store.count([{ "#t": ["nostr"] }])).toBe(1);
    expect(await store.query([{ "#t": ["absent-hashtag"] }])).toEqual([]);
    expect(await store.query([{ "#t": ["bitcoin"] }])).toEqual([bitcoin]);
    expect((await store.query([{ "#e": [eid], "#t": ["nostr"] }])).map((e) => e.id)).toEqual([
      nostr.id,
    ]);
    expect(await store.query([{ "#e": [eid], "#t": ["bitcoin"] }])).toEqual([]);
    expect((await store.negentropyItems({ "#t": ["nostr"] })).map((i) => i.id)).toEqual([nostr.id]);
  });

  test("replace/remove/clear drop compound and e/p index entries", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const eid = "aa".repeat(32);
    const meta1 = EventBuilder.metadata({ name: "v1" })
      .tag(["e", eid])
      .createdAt(10)
      .signWithKeys(keys);
    const meta2 = EventBuilder.metadata({ name: "v2" })
      .tag(["e", eid])
      .createdAt(20)
      .signWithKeys(keys);
    expect(await store.put(meta1)).toBe("accepted");
    expect(await store.put(meta2)).toBe("replaced");
    expect((await store.query([{ "#e": [eid] }])).map((e) => e.id)).toEqual([meta2.id]);
    expect(
      (await store.query([{ authors: [keys.publicKey], kinds: [Kind.Metadata] }])).map((e) => e.id),
    ).toEqual([meta2.id]);

    const note = EventBuilder.textNote("n")
      .tag(["p", keys.publicKey])
      .createdAt(1)
      .signWithKeys(keys);
    expect(await store.put(note)).toBe("accepted");
    expect(await store.remove([note.id])).toBe(1);
    expect(await store.query([{ "#p": [keys.publicKey] }])).toEqual([]);

    await store.clear();
    expect(store.size).toBe(0);
    expect(await store.query([{ authors: [keys.publicKey], kinds: [Kind.Metadata] }])).toEqual([]);
    expect(await store.query([{ "#e": [eid] }])).toEqual([]);
    expect(await store.query([{ "#t": ["nostr"] }])).toEqual([]);
  });

  test("valueless e tag is not indexed; empty-string e tag is", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const bare = EventBuilder.textNote("bare").tag(["e"]).createdAt(1).signWithKeys(keys);
    const empty = EventBuilder.textNote("empty").tag(["e", ""]).createdAt(2).signWithKeys(keys);
    expect(await store.put(bare)).toBe("accepted");
    expect(await store.put(empty)).toBe("accepted");
    expect(await store.query([{ "#e": ["undefined"] }])).toEqual([]);
    expect((await store.query([{ "#e": [""] }])).map((e) => e.id)).toEqual([empty.id]);
    expect((await store.query([{ kinds: [Kind.TextNote] }])).map((e) => e.id)).toEqual([
      empty.id,
      bare.id,
    ]);
  });

  test("ids candidate path still AND-matches defined #e", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const eid = "aa".repeat(32);
    const other = "bb".repeat(32);
    const note = EventBuilder.textNote("n").tag(["e", eid]).createdAt(1).signWithKeys(keys);
    expect(await store.put(note)).toBe("accepted");
    expect((await store.query([{ ids: [note.id], "#e": [eid] }])).map((e) => e.id)).toEqual([
      note.id,
    ]);
    expect(await store.query([{ ids: [note.id], "#e": [other] }])).toEqual([]);
    expect(await store.query([{ ids: [] }])).toEqual([]);
  });
});

describe("itemCompare", () => {
  test("created_at ascending, then id lexicographic; equal items are 0", () => {
    const a = { id: "aa", created_at: 1 };
    const b = { id: "bb", created_at: 1 };
    const c = { id: "aa", created_at: 2 };
    expect(itemCompare(a, c)).toBeLessThan(0);
    expect(itemCompare(c, a)).toBeGreaterThan(0);
    expect(itemCompare(a, b)).toBeLessThan(0);
    expect(itemCompare(b, a)).toBeGreaterThan(0);
    expect(itemCompare(a, a)).toBe(0);
    expect(itemCompare({ id: "", created_at: 0 }, { id: "", created_at: 0 })).toBe(0);
    expect(itemCompare({ id: "a", created_at: -1 }, { id: "a", created_at: 0 })).toBeLessThan(0);
    expect(itemCompare({ id: "A", created_at: 1 }, { id: "a", created_at: 1 })).toBeLessThan(0);
  });

  test("is not the inverse of sortEvents: id tie-break stays ascending", () => {
    const olderLow: Event = {
      id: "aa",
      created_at: 1,
      pubkey: "00".repeat(32),
      kind: 1,
      tags: [],
      content: "",
      sig: "00".repeat(64),
    };
    const olderHigh: Event = { ...olderLow, id: "zz" };
    const newer: Event = { ...olderLow, id: "mm", created_at: 2 };
    expect([newer, olderHigh, olderLow].sort(itemCompare).map((e) => e.id)).toEqual([
      "aa",
      "zz",
      "mm",
    ]);
    expect(sortedEvents([newer, olderHigh, olderLow]).map((e) => e.id)).toEqual(["mm", "aa", "zz"]);
  });

  test("nip77 module export has no itemCompare", async () => {
    expect("itemCompare" in nip77).toBe(false);
    const root = await import("../src/index.ts");
    expect(root.itemCompare).toBe(itemCompare);
  });
});

beforeEach(() => {
  MockWebSocket.reset();
});
afterEach(() => {
  MockWebSocket.reset();
});
