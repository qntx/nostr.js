import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Gossip,
  Kind,
  Keys,
  MemoryEventStore,
  OutboxFeed,
  groupAuthorsByOutboxRelay,
  useWebSocketImplementation,
} from "../src/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK_A = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SK_B = "0000000000000000000000000000000000000000000000000000000000000001";

beforeEach(() => {
  MockWebSocket.reset();
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  MockWebSocket.reset();
});

describe("groupAuthorsByOutboxRelay", () => {
  test("routes authors to write relays and falls back to discovery", () => {
    const gossip = new Gossip();
    const a = Keys.fromSecretKey(SK_A);
    const b = Keys.fromSecretKey(SK_B);
    gossip.setRoutes(a.publicKey, [
      { url: "wss://a-out.example", read: false, write: true },
      { url: "wss://shared.example", read: true, write: true },
    ]);

    const map = groupAuthorsByOutboxRelay(
      [a.publicKey, b.publicKey],
      gossip,
      ["wss://discovery.example"],
      4,
    );

    expect(map.get("wss://a-out.example/") ?? map.get("wss://a-out.example")).toBeDefined();
    // B has no routes → discovery
    const discoveryKey = [...map.keys()].find((k) => k.includes("discovery"));
    expect(discoveryKey).toBeDefined();
    expect(map.get(discoveryKey!)!.includes(b.publicKey)).toBe(true);
  });
});

describe("OutboxFeed", () => {
  test("sync pulls notes from outbox relays and updates storage", async () => {
    const a = Keys.fromSecretKey(SK_A);
    const note = EventBuilder.textNote("outbox note").createdAt(50).signWithKeys(a);
    const list = EventBuilder.relayList([{ url: "wss://out.example", read: false, write: true }])
      .createdAt(1)
      .signWithKeys(a);

    const store = new MemoryEventStore();
    const gossip = new Gossip();
    gossip.ingest(list);

    const client = Client.builder()
      .storage(store)
      .gossip(gossip)
      .relays(["wss://discovery.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();

    const feed = client.outbox({ authors: [a.publicKey], kinds: [Kind.TextNote] });
    const syncP = feed.sync({ skipHydrate: true, limit: 20 });
    await new Promise((r) => setTimeout(r, 15));

    for (const ws of MockWebSocket.instances) {
      for (const raw of ws.sent) {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] !== "REQ") continue;
        const subId = msg[1] as string;
        const filter = msg[2] as { kinds?: number[]; authors?: string[] };
        if (filter.kinds?.includes(1) && filter.authors?.includes(a.publicKey)) {
          ws.receive(JSON.stringify(["EVENT", subId, note]));
          ws.receive(JSON.stringify(["EOSE", subId]));
        } else {
          ws.receive(JSON.stringify(["EOSE", subId]));
        }
      }
    }

    const events = await syncP;
    expect(events.some((e) => e.id === note.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.get(note.id)).toBeDefined();
    expect(feed.getBound(a.publicKey, Kind.TextNote)?.newest).toBe(50);

    feed.close();
    await client.shutdown();
  });

  test("startLive delivers new events", async () => {
    const a = Keys.fromSecretKey(SK_A);
    const note = EventBuilder.textNote("live outbox")
      .createdAt(Math.floor(Date.now() / 1000))
      .signWithKeys(a);
    const gossip = new Gossip();
    gossip.setRoutes(a.publicKey, [{ url: "wss://live.example", read: true, write: true }]);

    const client = Client.builder()
      .gossip(gossip)
      .relays(["wss://discovery.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();
    const got: string[] = [];
    const feed = new OutboxFeed({
      pool: client.pool,
      gossip,
      storage: client.storage,
      discoveryRelays: client.relays,
      authors: [a.publicKey],
      observe: (e) => client.observe(e),
      onEvent: (e) => got.push(e.id),
    });

    const live = feed.startLive({ since: 0 });
    await new Promise((r) => setTimeout(r, 15));

    for (const ws of MockWebSocket.instances) {
      for (const raw of ws.sent) {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] !== "REQ") continue;
        const subId = msg[1] as string;
        ws.receive(JSON.stringify(["EVENT", subId, note]));
      }
    }

    expect(got).toContain(note.id);
    live.close();
    feed.close();
    await client.shutdown();
  });
});
