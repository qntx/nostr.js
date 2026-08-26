import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Kind,
  Keys,
  KeysSigner,
  MemoryEventStore,
  relayListEventBuilder,
  Pool,
  useWebSocketImplementation,
} from "../src/index.ts";
import { FakeRelayBus } from "./helpers/fake-relay.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SK_B = "0000000000000000000000000000000000000000000000000000000000000001";

describe("integration via FakeRelayBus", () => {
  let bus: FakeRelayBus;

  beforeEach(() => {
    MockWebSocket.reset();
    useWebSocketImplementation(MockWebSocketCtor);
    bus = new FakeRelayBus();
    bus.start();
  });

  afterEach(() => {
    bus.stop();
    MockWebSocket.reset();
  });

  test("Client publish + fetch + local storage observe", async () => {
    const keys = Keys.fromSecretKey(SK);
    const store = new MemoryEventStore();
    const client = Client.builder()
      .signer(new KeysSigner(keys))
      .storage(store)
      .relays(["wss://a.example", "wss://b.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();

    const results = await client.publish(EventBuilder.textNote("bus hello").createdAt(42));
    expect(results.every((r) => r.result?.ok)).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    const local = await client.queryLocal({ kinds: [Kind.TextNote] });
    expect(local).toHaveLength(1);
    expect(local[0]!.content).toBe("bus hello");

    const fetched = await client.fetchEvents(
      { kinds: [1], authors: [keys.publicKey], limit: 10 },
      { timeoutMs: 2000 },
    );
    expect(fetched.some((e) => e.content === "bus hello")).toBe(true);

    await client.shutdown();
  });

  test("Pool publishAny + multi-relay fetch dedupe", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("shared").createdAt(1).signWithKeys(keys);
    bus.seed("wss://a.example", [note]);
    bus.seed("wss://b.example", [note]);

    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: false,
    });

    const events = await pool.fetch(["wss://a.example", "wss://b.example"], [{ kinds: [1] }], {
      timeoutMs: 2000,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(note.id);

    const other = EventBuilder.textNote("fan").createdAt(2).signWithKeys(keys);
    const pub = await pool.publish(["wss://a.example", "wss://b.example"], other);
    expect(pub.every((r) => r.result?.ok)).toBe(true);
    expect(bus.eventsOn("wss://a.example").some((e) => e.id === other.id)).toBe(true);
    expect(bus.eventsOn("wss://b.example").some((e) => e.id === other.id)).toBe(true);

    pool.close();
  });

  test("Pool automaticallyAuth answers AUTH challenge", async () => {
    bus.stop();
    bus = new FakeRelayBus({
      authChallenge: "chal-xyz",
      requireAuth: true,
    });
    bus.start();

    const keys = Keys.fromSecretKey(SK);
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: false,
      automaticallyAuth: () => async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });

    const note = EventBuilder.textNote("authed").createdAt(3).signWithKeys(keys);
    // ensureRelay triggers connect → AUTH challenge → auto auth
    await pool.ensureRelay("wss://auth.example");
    await new Promise((r) => setTimeout(r, 30));

    const results = await pool.publish(["wss://auth.example"], note);
    expect(results[0]?.result?.ok).toBe(true);
    expect(bus.eventsOn("wss://auth.example").some((e) => e.id === note.id)).toBe(true);

    pool.close();
  });

  test("OutboxFeed.sync against seeded outbox relay", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK_B);
    const note = EventBuilder.textNote("from outbox").createdAt(99).signWithKeys(a);
    const list = relayListEventBuilder([{ url: "wss://out.example", read: false, write: true }])
      .createdAt(1)
      .signWithKeys(a);

    bus.seed("wss://out.example", [note]);

    const store = new MemoryEventStore();
    const client = Client.builder()
      .storage(store)
      .relays(["wss://discovery.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    client.gossip.ingest(list);
    await client.connect();

    const feed = client.outbox({ authors: [a.publicKey], kinds: [Kind.TextNote] });
    const events = await feed.sync({ skipHydrate: true, limit: 20 });
    expect(events.some((e) => e.id === note.id)).toBe(true);
    expect(await store.get(note.id)).toBeDefined();

    // B has no routes — discovery path still works without throwing
    const feedB = client.outbox({ authors: [b.publicKey], kinds: [Kind.TextNote] });
    await feedB.sync({ skipHydrate: true, limit: 5 });

    feed.close();
    feedB.close();
    await client.shutdown();
  });
});
