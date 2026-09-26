import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { Client, EventBuilder, Keys, Pool, relayListEventBuilder } from "../src/index.ts";
import { fetchRouted } from "../src/relay/fan-in.ts";
import type { Event } from "../src/core/event.ts";
import { normalizeURL } from "../src/core/util.ts";
import { createFakeRelayNetwork, type FakeRelayNetwork } from "../src/testing/index.ts";
import { stubReportError } from "./helpers/report-error.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

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

const A = normalizeURL("wss://a.example");
const B = normalizeURL("wss://b.example");

describe("relay URL callbacks", () => {
  let net: FakeRelayNetwork;

  beforeEach(() => {
    net = createFakeRelayNetwork();
  });

  afterEach(() => {
    net.close();
  });

  test("client subscribe: onevent once with first URL, receivedEvent per receipt", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("dup").createdAt(1).signWithKeys(keys);
    net.relay("wss://a.example").seed([note]);
    net.relay("wss://b.example").seed([note]);

    const client = Client.builder()
      .relays(["wss://a.example", "wss://b.example"])
      .websocketImplementation(net.websocketImplementation)
      .enableReconnect(false)
      .build();

    const events: Array<[Event, string]> = [];
    const received: Array<[string, string]> = [];
    const closer = client.subscribe(
      { kinds: [1] },
      {
        onevent: (event, relayUrl) => events.push([event, relayUrl]),
        receivedEvent: (id, relayUrl) => received.push([id, relayUrl]),
      },
    );

    await waitUntil(() => received.length === 2);

    expect(events).toHaveLength(1);
    expect(events[0]![0].id).toBe(note.id);
    expect(events[0]![1]).toBe(received[0]![1]);
    expect(new Set(received.map(([, url]) => url))).toEqual(new Set([A, B]));

    closer.close();
    await client.shutdown();
  });

  test("fetchRouted: onevent sees every relay batch, result deduped", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("routed").createdAt(1).signWithKeys(keys);
    net.relay("wss://a.example").seed([note]);
    net.relay("wss://b.example").seed([note]);

    const pool = new Pool({
      websocketImplementation: net.websocketImplementation,
      enableReconnect: false,
    });

    const seen: Array<[string, string]> = [];
    const events = await fetchRouted(
      pool,
      [{ urls: ["wss://a.example", "wss://b.example"], filters: [{ kinds: [1] }] }],
      {
        timeoutMs: 2000,
        onevent: (event, relayUrl) => seen.push([event.id, relayUrl]),
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(note.id);
    expect(seen).toHaveLength(2);
    expect(new Set(seen.map(([, url]) => url))).toEqual(new Set([A, B]));

    pool.close();
  });

  test("gossip subscribe passes the source relay URL", async () => {
    const a = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("gossip dup").createdAt(1).signWithKeys(a);
    net.relay("wss://out-a.example").seed([note]);
    net.relay("wss://out-b.example").seed([note]);

    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(net.websocketImplementation)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([
        { url: "wss://out-a.example", read: true, write: true },
        { url: "wss://out-b.example", read: true, write: true },
      ])
        .createdAt(1)
        .signWithKeys(a),
    );

    const events: Array<[Event, string]> = [];
    const received: string[] = [];
    const closer = client.subscribe(
      { kinds: [1], authors: [a.publicKey] },
      {
        gossip: true,
        onevent: (event, relayUrl) => events.push([event, relayUrl]),
        receivedEvent: (_id, relayUrl) => received.push(relayUrl),
      },
    );

    await waitUntil(() => received.length === 2);

    expect(events).toHaveLength(1);
    expect(events[0]![0].id).toBe(note.id);
    expect(new Set(received)).toEqual(
      new Set([normalizeURL("wss://out-a.example"), normalizeURL("wss://out-b.example")]),
    );
    expect(received).toContain(events[0]![1]);

    closer.close();
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

  test("#1 throwing onevent does not drop events from a fetch batch", async () => {
    const keys = Keys.fromSecretKey(SK);
    const older = EventBuilder.textNote("older").createdAt(1).signWithKeys(keys);
    const newer = EventBuilder.textNote("newer").createdAt(2).signWithKeys(keys);
    net.relay("wss://a.example").seed([older, newer]);
    const throwOnOlder = (event: Event): void => {
      if (event.id === older.id) throw new Error("boom");
    };

    const pool = new Pool({
      websocketImplementation: net.websocketImplementation,
      enableReconnect: false,
    });
    const { reported, restore } = stubReportError();
    try {
      const routed = await fetchRouted(
        pool,
        [{ urls: ["wss://a.example"], filters: [{ kinds: [1] }] }],
        { onevent: (event) => throwOnOlder(event) },
      );
      expect(routed.map((e) => e.id).sort()).toEqual([older.id, newer.id].sort());

      const pooled = await pool.fetch(["wss://a.example"], [{ kinds: [1] }], {
        onevent: (event) => throwOnOlder(event),
      });
      expect(pooled.map((e) => e.id).sort()).toEqual([older.id, newer.id].sort());
      pool.close();

      const client = Client.builder()
        .relays(["wss://a.example"])
        .websocketImplementation(net.websocketImplementation)
        .enableReconnect(false)
        .build();
      const fetched = await client.fetchEvents(
        { kinds: [1] },
        { onevent: (event) => throwOnOlder(event), timeoutMs: 2000 },
      );
      expect(fetched.map((e) => e.id).sort()).toEqual([older.id, newer.id].sort());
      // persistence is a microtask-coalesced flush; poll until it lands
      let stored: Event[] = [];
      for (let i = 0; i < 200 && stored.length < 2; i += 1) {
        stored = await client.storage.query([{ kinds: [1] }]);
        if (stored.length < 2) await sleep(5);
      }
      expect(stored.map((e) => e.id).sort()).toEqual([older.id, newer.id].sort());
      await client.shutdown();
    } finally {
      restore();
    }
    expect(reported).toHaveLength(3);
    for (const err of reported) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("boom");
    }
  });

  test("#2 canonical relay URLs dedupe subscribe callbacks and addRelay", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("dup-url").createdAt(1).signWithKeys(keys);
    net.relay("wss://a.example").seed([note]);

    const client = Client.builder()
      .relays(["wss://a.example", "wss://a.example/"])
      .websocketImplementation(net.websocketImplementation)
      .enableReconnect(false)
      .build();

    const events: Event[] = [];
    const received: string[] = [];
    const closer = client.subscribe(
      { kinds: [1] },
      {
        onevent: (event) => events.push(event),
        receivedEvent: (id) => received.push(id),
      },
    );
    await waitUntil(() => received.length > 0);
    await sleep(50);
    expect(events).toHaveLength(1);
    expect(received).toHaveLength(1);
    closer.close();

    const single = Client.builder()
      .relays(["wss://a.example"])
      .websocketImplementation(net.websocketImplementation)
      .enableReconnect(false)
      .build();
    single.addRelay("wss://a.example/");
    expect(single.relays).toHaveLength(1);
    expect(client.relays).toHaveLength(1);

    await client.shutdown();
    await single.shutdown();
  });
});
