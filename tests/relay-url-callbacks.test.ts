import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { Client, EventBuilder, Keys, Pool, relayListEventBuilder } from "../src/index.ts";
import { fetchRouted } from "../src/relay/fan-in.ts";
import type { Event } from "../src/core/event.ts";
import { normalizeURL } from "../src/core/util.ts";
import { createFakeRelayNetwork, type FakeRelayNetwork } from "../src/testing/index.ts";

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
