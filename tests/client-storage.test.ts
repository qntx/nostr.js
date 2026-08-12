import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Gossip,
  Kind,
  Keys,
  KeysSigner,
  MemoryEventStore,
  useWebSocketImplementation,
} from "../src/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

beforeEach(() => {
  MockWebSocket.reset();
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  MockWebSocket.reset();
});

describe("Client storage + observe", () => {
  test("default MemoryEventStore; publish success observes into storage", async () => {
    const client = Client.builder()
      .signer(new KeysSigner(SK))
      .relays(["wss://a.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    expect(client.storage).toBeInstanceOf(MemoryEventStore);

    await client.connect();
    const publishP = client.publish(EventBuilder.textNote("stored").createdAt(10));
    await new Promise((r) => setTimeout(r, 10));
    const ws = MockWebSocket.last();
    const eventMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "EVENT") as [
      string,
      { id: string },
    ];
    ws.receive(JSON.stringify(["OK", eventMsg[1].id, true, ""]));
    await publishP;

    // allow fire-and-forget put
    await new Promise((r) => setTimeout(r, 5));
    const local = await client.queryLocal({ kinds: [Kind.TextNote] });
    expect(local).toHaveLength(1);
    expect(local[0]!.content).toBe("stored");
    await client.shutdown();
  });

  test("fetchEvents observes into storage and localFirst merges", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("from net").createdAt(5).signWithKeys(keys);

    const client = Client.builder()
      .signer(new KeysSigner(SK))
      .storage(store)
      .relays(["wss://a.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();

    const fetchP = client.fetchEvents(
      { kinds: [1], authors: [keys.publicKey] },
      { timeoutMs: 2000 },
    );
    await new Promise((r) => setTimeout(r, 10));
    const ws = MockWebSocket.last();
    const req = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [string, string];
    ws.receive(JSON.stringify(["EVENT", req[1], note]));
    ws.receive(JSON.stringify(["EOSE", req[1]]));
    const remote = await fetchP;
    expect(remote).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 5));
    expect(await store.get(note.id)).toBeDefined();

    // Second fetch with localFirst should return stored event even without network reply
    // (we still open REQ; answer EOSE empty)
    const fetch2 = client.fetchEvents(
      { kinds: [1], authors: [keys.publicKey] },
      { timeoutMs: 500, localFirst: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    const ws2 = MockWebSocket.last();
    const reqs = ws2.sent.map((s) => JSON.parse(s)).filter((m) => m[0] === "REQ");
    const lastReq = reqs[reqs.length - 1] as [string, string];
    ws2.receive(JSON.stringify(["EOSE", lastReq[1]]));
    const merged = await fetch2;
    expect(merged.some((e) => e.id === note.id)).toBe(true);

    await client.shutdown();
  });

  test("subscribe observes events", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("live").createdAt(1).signWithKeys(keys);

    const client = Client.builder()
      .storage(store)
      .relays(["wss://a.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();
    const got: string[] = [];
    const sub = client.subscribe([{ kinds: [1] }], {
      onevent: (e) => got.push(e.id),
    });

    await new Promise((r) => setTimeout(r, 10));
    const ws = MockWebSocket.last();
    const req = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [string, string];
    ws.receive(JSON.stringify(["EVENT", req[1], note]));
    expect(got).toEqual([note.id]);
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.get(note.id)).toBeDefined();
    sub.close();
    await client.shutdown();
  });

  test("hydrateGossip ingests relay list into gossip", async () => {
    const keys = Keys.fromSecretKey(SK);
    const list = EventBuilder.relayList([{ url: "wss://out.example" }])
      .createdAt(3)
      .signWithKeys(keys);

    const gossip = new Gossip();
    const client = Client.builder()
      .gossip(gossip)
      .relays(["wss://idx.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    // kick hydrate (will fetch); respond with list
    const hydrateP = client.hydrateGossip([keys.publicKey]);
    await new Promise((r) => setTimeout(r, 15));
    for (const ws of MockWebSocket.instances) {
      for (const raw of ws.sent) {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] !== "REQ") continue;
        const subId = msg[1] as string;
        const filter = msg[2] as { kinds?: number[] };
        if (filter.kinds?.includes(Kind.RelayList)) {
          ws.receive(JSON.stringify(["EVENT", subId, list]));
          ws.receive(JSON.stringify(["EOSE", subId]));
        }
      }
    }
    await hydrateP;

    expect(gossip.outboxRelays(keys.publicKey).length).toBeGreaterThan(0);
    await client.shutdown();
  });

  test("persistEvents false skips storage writes", async () => {
    const store = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("no store").createdAt(1).signWithKeys(keys);

    const client = Client.builder()
      .storage(store)
      .persistEvents(false)
      .relays(["wss://a.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    client.observe(note);
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.get(note.id)).toBeUndefined();
    // gossip still runs for kind 10002 only — text notes are fine
    await client.shutdown();
  });
});
