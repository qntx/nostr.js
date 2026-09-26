import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { Client, EventBuilder, Keys } from "../src/index.ts";
import { normalizeURL } from "../src/core/util.ts";
import { createFakeRelayNetwork, type FakeRelayNetwork } from "../src/testing/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

const A = normalizeURL("wss://a.example");
const B = normalizeURL("wss://b.example");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for condition");
}

describe("Client + ReactiveEventStore", () => {
  let net: FakeRelayNetwork;

  beforeEach(() => {
    net = createFakeRelayNetwork();
  });

  afterEach(() => {
    net.close();
  });

  function makeClient() {
    return Client.builder()
      .relays(["wss://a.example", "wss://b.example"])
      .websocketImplementation(net.websocketImplementation)
      .enableReconnect(false)
      .build();
  }

  test("default client has an index; observe() records seenOn", async () => {
    const client = makeClient();
    expect(client.index).toBeDefined();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("x").createdAt(1).signWithKeys(keys);
    client.observe(note, "wss://a.example");
    expect(client.index.get(note.id)?.id).toBe(note.id);
    expect(client.index.seenOn(note.id)).toEqual([A]);
    await client.shutdown();
  });

  test("subscribe with observe:false delivers onevent but skips the index", async () => {
    const client = makeClient();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("skip me").createdAt(1).signWithKeys(keys);
    net.relay("wss://a.example").seed([note]);

    const delivered: string[] = [];
    const closer = client.subscribe(
      { kinds: [1] },
      { observe: false, onevent: (e) => delivered.push(e.id) },
    );
    await waitUntil(() => delivered.length === 1);
    expect(client.index.get(note.id)).toBeUndefined();
    closer.close();
    await client.shutdown();
  });

  test("two relays deliver the same note: index has it once, seenOn both, index precedes onevent", async () => {
    const client = makeClient();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("dup").createdAt(1).signWithKeys(keys);
    net.relay("wss://a.example").seed([note]);
    net.relay("wss://b.example").seed([note]);

    const order: string[] = [];
    const received: string[] = [];
    const closer = client.subscribe(
      { kinds: [1] },
      {
        onevent: (event) => {
          // index must already contain the event when the caller sees it
          order.push(client.index.get(event.id) !== undefined ? "index-first" : "index-late");
        },
        receivedEvent: (id) => received.push(id),
      },
    );

    await waitUntil(() => received.length === 2);
    await sleep(20);

    expect(order).toEqual(["index-first"]);
    expect(client.index.get(note.id)?.id).toBe(note.id);
    expect(client.index.seenOn(note.id)).toEqual([A, B]);

    closer.close();
    await client.shutdown();
  });

  test("fetchEvents localFirst reads index, hydrates storage, merges network", async () => {
    const client = makeClient();
    const keys = Keys.fromSecretKey(SK);
    const inIndex = EventBuilder.textNote("in index").createdAt(1).signWithKeys(keys);
    const inStorage = EventBuilder.textNote("in storage").createdAt(2).signWithKeys(keys);
    const inNet = EventBuilder.textNote("in net").createdAt(3).signWithKeys(keys);

    client.index.add(inIndex);
    await client.storage.put(inStorage);
    net.relay("wss://a.example").seed([inNet]);

    const events = await client.fetchEvents({ kinds: [1] }, { localFirst: true });
    const ids = new Set(events.map((e) => e.id));
    expect(ids.has(inIndex.id)).toBe(true);
    expect(ids.has(inStorage.id)).toBe(true);
    expect(ids.has(inNet.id)).toBe(true);
    // storage hit hydrated into the index, network event indexed with its url
    expect(client.index.get(inStorage.id) !== undefined).toBe(true);
    expect(client.index.seenOn(inNet.id)).toEqual([A]);
    await client.shutdown();
  });

  test("published event lands in the index after OK", async () => {
    const client = makeClient();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("mine").createdAt(1).signWithKeys(keys);
    const results = await client.publish(note);
    expect(results.some((r) => r.result?.ok)).toBe(true);
    expect(client.index.get(note.id)?.id).toBe(note.id);
    await client.shutdown();
  });
});

describe("issue #125", () => {
  let net: FakeRelayNetwork;

  beforeEach(() => {
    net = createFakeRelayNetwork();
  });

  afterEach(() => {
    net.close();
  });

  test("#9 localFirst prefers the newer index event over stale storage", async () => {
    const client = Client.builder()
      .relays(["wss://empty.example"])
      .websocketImplementation(net.websocketImplementation)
      .enableReconnect(false)
      .build();
    const keys = Keys.fromSecretKey(SK);
    const fresh = EventBuilder.metadata({ name: "fresh" }).createdAt(5).signWithKeys(keys);
    const stale = EventBuilder.metadata({ name: "stale" }).createdAt(1).signWithKeys(keys);
    client.index.add(fresh);
    await client.storage.put(stale);

    const events = await client.fetchEvents({ kinds: [0] }, { localFirst: true });
    expect(events.map((e) => e.id)).toEqual([fresh.id]);
    expect(client.index.getReplaceable(0, keys.publicKey)?.id).toBe(fresh.id);
    await client.shutdown();
  });

  test("#9 fetchEvents applies the filter limit to merged relay results", async () => {
    const keys = Keys.fromSecretKey(SK);
    const t1 = EventBuilder.textNote("one").createdAt(1).signWithKeys(keys);
    const t2 = EventBuilder.textNote("two").createdAt(2).signWithKeys(keys);
    const t3 = EventBuilder.textNote("three").createdAt(3).signWithKeys(keys);
    net.relay("wss://a.example").seed([t3, t2]);
    net.relay("wss://b.example").seed([t2, t1]);
    const client = Client.builder()
      .relays(["wss://a.example", "wss://b.example"])
      .websocketImplementation(net.websocketImplementation)
      .enableReconnect(false)
      .build();
    const events = await client.fetchEvents({ kinds: [1], limit: 2 });
    expect(events.map((e) => e.id)).toEqual([t3.id, t2.id]);
    await client.shutdown();
  });

  test("#9 fetchEvents returns ephemeral events a relay sends before EOSE", async () => {
    MockWebSocket.reset();
    const client = Client.builder()
      .relays(["wss://ephemeral.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    const keys = Keys.fromSecretKey(SK);
    const eph = EventBuilder.textNote("live-only").kind(20001).createdAt(1).signWithKeys(keys);

    const pending = client.fetchEvents({ kinds: [20001] });
    await waitUntil(
      () =>
        MockWebSocket.instances.length > 0 &&
        MockWebSocket.last().sent.some((s) => (JSON.parse(s) as unknown[])[0] === "REQ"),
    );
    const ws = MockWebSocket.last();
    const req = ws.sent.map((s) => JSON.parse(s) as unknown[]).find((m) => m[0] === "REQ")!;
    const subId = req[1];
    ws.receive(JSON.stringify(["EVENT", subId, eph]));
    ws.receive(JSON.stringify(["EOSE", subId]));

    const events = await pending;
    expect(events.map((e) => e.id)).toEqual([eph.id]);
    await client.shutdown();
    MockWebSocket.reset();
  });
});
