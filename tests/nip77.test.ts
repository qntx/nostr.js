import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Keys,
  MemoryEventStore,
  MessageError,
  NegentropyStorageVector,
  PROTOCOL_VERSION,
  Reconciliation,
  Relay,
  Responder,
  SyncDirection,
  encodeClientMessage,
  parseClientMessage,
  parseRelayMessage,
  storageFromEvents,
  useWebSocketImplementation,
  type Event,
  type EventStore,
  type Filter,
  type PutResult,
} from "../src/index.ts";
import { FakeRelayBus } from "./helpers/fake-relay.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK_A = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SK_B = "0000000000000000000000000000000000000000000000000000000000000001";

function note(sk: string, content: string, createdAt: number) {
  return EventBuilder.textNote(content).createdAt(createdAt).signWithKeys(Keys.fromSecretKey(sk));
}

function runUntilDone(
  init: Reconciliation,
  responder: Responder,
): {
  have: string[];
  need: string[];
  rounds: number;
} {
  const have = new Set<string>();
  const need = new Set<string>();
  let incoming = responder.reconcile(init.opening);
  let rounds = 1;
  if (incoming.nextMessage === null) {
    incoming = {
      have: incoming.have,
      need: incoming.need,
      nextMessage: PROTOCOL_VERSION.toString(16),
    };
  }
  for (;;) {
    const out = init.reconcile(incoming.nextMessage!);
    for (const id of out.have) have.add(id);
    for (const id of out.need) need.add(id);
    rounds += 1;
    if (out.nextMessage === null) return { have: [...have], need: [...need], rounds };
    incoming = responder.reconcile(out.nextMessage);
    if (incoming.nextMessage === null) {
      incoming = {
        have: incoming.have,
        need: incoming.need,
        nextMessage: PROTOCOL_VERSION.toString(16),
      };
    }
  }
}

describe("NIP-77 message codec", () => {
  test("encodes and parses 4-element NEG-OPEN", () => {
    const wire = encodeClientMessage(["NEG-OPEN", "n1", { kinds: [1] }, "61"]);
    expect(JSON.parse(wire)).toEqual(["NEG-OPEN", "n1", { kinds: [1] }, "61"]);
    expect(parseClientMessage(wire)).toEqual(["NEG-OPEN", "n1", { kinds: [1] }, "61"]);
  });

  test("rejects obsolete 5-element NEG-OPEN", () => {
    expect(() =>
      parseClientMessage(JSON.stringify(["NEG-OPEN", "n1", { kinds: [1] }, 32, "61"])),
    ).toThrow(MessageError);
    expect(() =>
      parseClientMessage(JSON.stringify(["NEG-OPEN", "n1", { kinds: [1] }, 32, "61"])),
    ).toThrow(/obsolete 5-element NEG-OPEN/);
  });

  test("parses NEG-MSG / NEG-CLOSE / NEG-ERR", () => {
    expect(parseClientMessage(JSON.stringify(["NEG-MSG", "n1", "61aa"]))).toEqual([
      "NEG-MSG",
      "n1",
      "61aa",
    ]);
    expect(parseClientMessage(JSON.stringify(["NEG-CLOSE", "n1"]))).toEqual(["NEG-CLOSE", "n1"]);
    expect(parseRelayMessage(JSON.stringify(["NEG-MSG", "n1", "61"]))).toEqual([
      "NEG-MSG",
      "n1",
      "61",
    ]);
    expect(parseRelayMessage(JSON.stringify(["NEG-ERR", "n1", "blocked: too big"]))).toEqual([
      "NEG-ERR",
      "n1",
      "blocked: too big",
    ]);
  });
});

describe("Negentropy algorithm", () => {
  test("empty sets converge with no delta", () => {
    const a = new NegentropyStorageVector();
    a.seal();
    const b = new NegentropyStorageVector();
    b.seal();
    const { have, need } = runUntilDone(new Reconciliation(a), new Responder(b));
    expect(have).toEqual([]);
    expect(need).toEqual([]);
  });

  test("initiator learns local-only and remote-only ids", () => {
    const shared = note(SK_A, "shared", 10);
    const onlyA = note(SK_A, "alice", 11);
    const onlyB = note(SK_B, "bob", 12);
    const init = new Reconciliation(storageFromEvents([shared, onlyA]));
    const resp = new Responder(storageFromEvents([shared, onlyB]));
    const { have, need } = runUntilDone(init, resp);
    expect(have).toEqual([onlyA.id]);
    expect(need).toEqual([onlyB.id]);
  });

  test("fingerprint path with >32 items still finds the delta", () => {
    const keys = Keys.fromSecretKey(SK_A);
    const alice: ReturnType<typeof note>[] = [];
    const bob: ReturnType<typeof note>[] = [];
    for (let i = 0; i < 40; i++) {
      const ev = EventBuilder.textNote(`n${i}`)
        .createdAt(100 + i)
        .signWithKeys(keys);
      alice.push(ev);
      if (i !== 7 && i !== 33) bob.push(ev);
    }
    const extra = EventBuilder.textNote("remote")
      .createdAt(999)
      .signWithKeys(Keys.fromSecretKey(SK_B));
    bob.push(extra);
    const { have, need } = runUntilDone(
      new Reconciliation(storageFromEvents(alice)),
      new Responder(storageFromEvents(bob)),
    );
    expect(have.sort()).toEqual([alice[7]!.id, alice[33]!.id].sort());
    expect(need).toEqual([extra.id]);
  });
});

describe("Relay.negReconcile + Client.sync", () => {
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

  test("Relay.negReconcile reports have/need against seeded relay", async () => {
    const localOnly = note(SK_A, "local", 1);
    const remoteOnly = note(SK_B, "remote", 2);
    const shared = note(SK_A, "shared", 3);
    bus.seed("wss://neg.example", [remoteOnly, shared]);

    const relay = await Relay.connect("wss://neg.example", {
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: false,
    });
    const storage = storageFromEvents([localOnly, shared]);
    const { have, need } = await relay.negReconcile({ kinds: [1] }, storage, { timeoutMs: 2000 });
    expect(have).toEqual([localOnly.id]);
    expect(need).toEqual([remoteOnly.id]);
    relay.close();
  });

  test("Client.sync down downloads remote-only events", async () => {
    const remote = note(SK_B, "from-relay", 20);
    bus.seed("wss://neg.example", [remote]);
    const store = new MemoryEventStore();
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000 },
    );
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.received).toEqual([remote.id]);
    expect(await store.get(remote.id)).toBeDefined();
    await client.shutdown();
  });

  test("Client.sync up publishes local-only events", async () => {
    const local = note(SK_A, "to-relay", 21);
    const store = new MemoryEventStore();
    await store.put(local);
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Up, timeoutMs: 2000 },
    );
    expect(summary.local).toEqual([local.id]);
    expect(summary.sent).toEqual([local.id]);
    expect(bus.eventsOn("wss://neg.example").some((e) => e.id === local.id)).toBe(true);
    await client.shutdown();
  });

  test("Client.sync dryRun does not exchange events", async () => {
    const remote = note(SK_B, "stay", 22);
    bus.seed("wss://neg.example", [remote]);
    const store = new MemoryEventStore();
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Both, dryRun: true, timeoutMs: 2000 },
    );
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.received).toEqual([]);
    expect(await store.get(remote.id)).toBeUndefined();
    await client.shutdown();
  });

  test("Client.sync down does not list received when store.put throws", async () => {
    const remote = note(SK_B, "unsaved", 23);
    bus.seed("wss://neg.example", [remote]);
    const store: EventStore = {
      async put(_event: Event): Promise<PutResult> {
        throw new Error("disk full");
      },
      async get() {
        return undefined;
      },
      async query(_filters: Filter[]) {
        return [];
      },
      async remove() {
        return 0;
      },
      async clear() {},
    };
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(false)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000, observe: false },
    );
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.received).toEqual([]);
    expect(await store.get(remote.id)).toBeUndefined();
    await client.shutdown();
  });
});

describe("Negentropy session timeout", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    useWebSocketImplementation(MockWebSocketCtor);
  });
  afterEach(() => {
    MockWebSocket.reset();
  });

  test("Client.sync rejects on session deadline when the relay never sends NEG-MSG", async () => {
    const store = new MemoryEventStore();
    const client = Client.builder()
      .storage(store)
      .relays(["wss://silent-neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    const started = Date.now();
    await expect(
      client.sync({ kinds: [1] }, { direction: SyncDirection.Down, timeoutMs: 80 }),
    ).rejects.toThrow(/negentropy timed out/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(1500);
    await client.shutdown();
  });
});
