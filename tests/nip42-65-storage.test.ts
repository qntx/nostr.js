import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  Kind,
  MemoryEventStore,
  Relay,
  isAuthRequired,
  makeAuthEvent,
  parseRelayList,
  readRelays,
  relayListToTags,
  useWebSocketImplementation,
  writeRelays,
} from "../src/index.ts";
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
});

beforeEach(() => {
  MockWebSocket.reset();
});
afterEach(() => {
  MockWebSocket.reset();
});
