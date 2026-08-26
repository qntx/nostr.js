import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Gossip,
  Keys,
  MAX_NEG_ROUNDS,
  MemoryEventStore,
  MessageError,
  Negentropy,
  NegentropyStorageVector,
  Nip77Error,
  PROTOCOL_VERSION,
  Relay,
  SyncDirection,
  encodeClientMessage,
  parseClientMessage,
  parseRelayMessage,
  runNegSession,
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

function wrapEventStore(
  inner: EventStore,
  overrides: Partial<Pick<EventStore, "get" | "query">> = {},
): EventStore {
  return {
    put: (event) => inner.put(event),
    putMany: (events) => inner.putMany(events),
    get: overrides.get ?? ((id) => inner.get(id)),
    query: overrides.query ?? ((filters) => inner.query(filters)),
    count: (filters) => inner.count(filters),
    negentropyItems: (filter) => inner.negentropyItems(filter),
    remove: (ids) => inner.remove(ids),
    clear: () => inner.clear(),
    getOutboxBound: (pubkey, kind) => inner.getOutboxBound(pubkey, kind),
    setOutboxBound: (pubkey, kind, bound) => inner.setOutboxBound(pubkey, kind, bound),
  };
}

function runUntilDone(
  init: Negentropy,
  responder: Negentropy,
): {
  have: string[];
  need: string[];
  rounds: number;
} {
  const have = new Set<string>();
  const need = new Set<string>();
  const opening = init.initiate();
  let incoming = responder.reconcile(opening);
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

  test("parses 3- or 4-element NEG-ERR and ignores the optional 4th", () => {
    expect(parseRelayMessage(JSON.stringify(["NEG-ERR", "n1", "blocked: too big", 100]))).toEqual([
      "NEG-ERR",
      "n1",
      "blocked: too big",
    ]);
    expect(parseRelayMessage(JSON.stringify(["NEG-ERR", "n1", "error: boom", "ignored"]))).toEqual([
      "NEG-ERR",
      "n1",
      "error: boom",
    ]);
  });

  test("rejects NEG-ERR arity other than 3 or 4", () => {
    expect(() => parseRelayMessage(JSON.stringify(["NEG-ERR", "n1"]))).toThrow(MessageError);
    expect(() =>
      parseRelayMessage(JSON.stringify(["NEG-ERR", "n1", "blocked", 1, "extra"])),
    ).toThrow(MessageError);
    expect(() => parseRelayMessage(JSON.stringify(["NEG-ERR", 1, "blocked"]))).toThrow(
      MessageError,
    );
  });
});

describe("Negentropy algorithm", () => {
  test("empty sets converge with no delta", () => {
    const a = new NegentropyStorageVector();
    a.seal();
    const b = new NegentropyStorageVector();
    b.seal();
    const { have, need } = runUntilDone(new Negentropy(a), new Negentropy(b));
    expect(have).toEqual([]);
    expect(need).toEqual([]);
  });

  test("initiator learns local-only and remote-only ids", () => {
    const shared = note(SK_A, "shared", 10);
    const onlyA = note(SK_A, "alice", 11);
    const onlyB = note(SK_B, "bob", 12);
    const init = new Negentropy(storageFromEvents([shared, onlyA]));
    const resp = new Negentropy(storageFromEvents([shared, onlyB]));
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
      new Negentropy(storageFromEvents(alice)),
      new Negentropy(storageFromEvents(bob)),
    );
    expect(have.sort()).toEqual([alice[7]!.id, alice[33]!.id].sort());
    expect(need).toEqual([extra.id]);
  });

  test("runNegSession collects have/need until nextMessage is null", async () => {
    const shared = note(SK_A, "shared", 10);
    const onlyA = note(SK_A, "alice", 11);
    const onlyB = note(SK_B, "bob", 12);
    const resp = new Negentropy(storageFromEvents([shared, onlyB]));
    let incoming: string | undefined;
    const { have, need } = await runNegSession({
      storage: storageFromEvents([shared, onlyA]),
      openingSend: (hex) => {
        const out = resp.reconcile(hex);
        incoming = out.nextMessage ?? PROTOCOL_VERSION.toString(16);
      },
      msgSend: (hex) => {
        const out = resp.reconcile(hex);
        incoming = out.nextMessage ?? PROTOCOL_VERSION.toString(16);
      },
      next: async () => {
        if (incoming === undefined) throw new Error("missing incoming");
        return incoming;
      },
    });
    expect(have).toEqual([onlyA.id]);
    expect(need).toEqual([onlyB.id]);
  });

  test("runNegSession throws after MAX_NEG_ROUNDS", async () => {
    const storage = new NegentropyStorageVector();
    storage.seal();
    const mismatch = `61000001${"ff".repeat(16)}`;
    let nextCalls = 0;
    const err = await runNegSession({
      storage,
      openingSend: () => {},
      msgSend: () => {},
      next: async () => {
        nextCalls += 1;
        return mismatch;
      },
    }).then(
      () => {
        throw new Error("expected reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Nip77Error);
    expect((err as Nip77Error).message).toBe("negentropy exceeded max rounds");
    expect(nextCalls).toBe(MAX_NEG_ROUNDS);
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

  test("Client.syncToRelay up loads via query not get", async () => {
    const events = [note(SK_A, "a", 1), note(SK_A, "b", 2), note(SK_A, "c", 3)];
    const inner = new MemoryEventStore();
    for (const event of events) await inner.put(event);
    let getCount = 0;
    let queryCount = 0;
    let queried: Filter[] | undefined;
    const store = wrapEventStore(inner, {
      get: (id) => {
        getCount += 1;
        return inner.get(id);
      },
      query: (filters) => {
        queryCount += 1;
        queried = filters;
        return inner.query(filters);
      },
    });
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(false)
      .build();
    await client.connect();
    const summary = await client.syncToRelay(
      "wss://neg.example",
      { kinds: [1] },
      { direction: SyncDirection.Up, timeoutMs: 2000 },
    );
    expect(getCount).toBe(0);
    expect(queryCount).toBe(1);
    expect(queried).toBeDefined();
    expect(queried).toHaveLength(1);
    expect(queried![0]!.ids).toBeDefined();
    expect(queried![0]!.kinds).toBeUndefined();
    expect(new Set(queried![0]!.ids)).toEqual(new Set(events.map((event) => event.id)));
    expect(new Set(summary.sent)).toEqual(new Set(events.map((event) => event.id)));
    await client.shutdown();
  });

  test("Client.syncToRelay up skips query when have is empty", async () => {
    const shared = note(SK_A, "shared", 1);
    bus.seed("wss://neg.example", [shared]);
    const inner = new MemoryEventStore();
    await inner.put(shared);
    let getCount = 0;
    let queryCount = 0;
    const store = wrapEventStore(inner, {
      get: (id) => {
        getCount += 1;
        return inner.get(id);
      },
      query: (filters) => {
        queryCount += 1;
        return inner.query(filters);
      },
    });
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(false)
      .build();
    await client.connect();
    const summary = await client.syncToRelay(
      "wss://neg.example",
      { kinds: [1] },
      { direction: SyncDirection.Up, timeoutMs: 2000 },
    );
    expect(summary.local).toEqual([]);
    expect(summary.sent).toEqual([]);
    expect(queryCount).toBe(0);
    expect(getCount).toBe(0);
    await client.shutdown();
  });

  test("Client.syncToRelay up publishes with concurrency 8", async () => {
    const events: Event[] = [];
    const store = new MemoryEventStore();
    for (let i = 0; i < 16; i++) {
      const event = note(SK_A, `n${i}`, 100 + i);
      events.push(event);
      await store.put(event);
    }
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    let inflight = 0;
    let maxInflight = 0;
    const origPublish = client.pool.publish.bind(client.pool);
    client.pool.publish = async (relays, event, opts) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      try {
        return await origPublish(relays, event, opts);
      } finally {
        inflight -= 1;
      }
    };
    const summary = await client.syncToRelay(
      "wss://neg.example",
      { kinds: [1] },
      { direction: SyncDirection.Up, timeoutMs: 2000 },
    );
    expect(maxInflight).toBeGreaterThan(1);
    expect(maxInflight).toBe(8);
    expect(new Set(summary.sent)).toEqual(new Set(events.map((event) => event.id)));
    await client.shutdown();
  });

  test("Client.syncToRelay up records sendFailures for ids missing from query", async () => {
    const events = [note(SK_A, "a", 1), note(SK_A, "b", 2), note(SK_A, "c", 3)];
    const missing = events[1]!;
    const inner = new MemoryEventStore();
    for (const event of events) await inner.put(event);
    let getCount = 0;
    let queryCount = 0;
    let queried: Filter[] | undefined;
    const store = wrapEventStore(inner, {
      get: (id) => {
        getCount += 1;
        return inner.get(id);
      },
      query: async (filters) => {
        queryCount += 1;
        queried = filters;
        const found = await inner.query(filters);
        return found.filter((event) => event.id !== missing.id);
      },
    });
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(false)
      .build();
    await client.connect();
    const summary = await client.syncToRelay(
      "wss://neg.example",
      { kinds: [1] },
      { direction: SyncDirection.Up, timeoutMs: 2000 },
    );
    expect(getCount).toBe(0);
    expect(queryCount).toBe(1);
    expect(queried).toBeDefined();
    expect(queried).toHaveLength(1);
    expect(queried![0]!.ids).toBeDefined();
    expect(queried![0]!.kinds).toBeUndefined();
    expect(new Set(queried![0]!.ids)).toEqual(new Set(events.map((event) => event.id)));
    expect(summary.sendFailures[missing.id]).toBe("event not found in local store");
    expect(Object.keys(summary.sendFailures)).toEqual([missing.id]);
    expect(new Set(summary.sent)).toEqual(
      new Set(events.filter((event) => event.id !== missing.id).map((event) => event.id)),
    );
    await client.shutdown();
  });

  test("Client.syncToRelay up isolates a throwing publish in the chunk", async () => {
    const events = [note(SK_A, "a", 1), note(SK_A, "b", 2), note(SK_A, "c", 3)];
    const boom = events[1]!;
    const store = new MemoryEventStore();
    for (const event of events) await store.put(event);
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    const origPublish = client.pool.publish.bind(client.pool);
    client.pool.publish = async (relays, event, opts) => {
      if (event.id === boom.id) throw new Error("boom");
      return origPublish(relays, event, opts);
    };
    const summary = await client.syncToRelay(
      "wss://neg.example",
      { kinds: [1] },
      { direction: SyncDirection.Up, timeoutMs: 2000 },
    );
    expect(summary.sendFailures[boom.id]).toBe("boom");
    expect(Object.keys(summary.sendFailures)).toEqual([boom.id]);
    expect(new Set(summary.sent)).toEqual(
      new Set(events.filter((event) => event.id !== boom.id).map((event) => event.id)),
    );
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

  test("Client.syncToRelay dryRun uses negentropyItems not query", async () => {
    const remote = note(SK_B, "stay", 22);
    const local = note(SK_A, "mine", 21);
    bus.seed("wss://neg.example", [remote]);
    const inner = new MemoryEventStore();
    await inner.put(local);
    const store: EventStore = {
      put: (event) => inner.put(event),
      putMany: async (events) => {
        const out: PutResult[] = [];
        for (const event of events) out.push(await inner.put(event));
        return out;
      },
      get: (id) => inner.get(id),
      query: async () => {
        throw new Error("query should not be called");
      },
      count: (filters) => inner.count(filters),
      negentropyItems: (filter) => inner.negentropyItems(filter),
      remove: (ids) => inner.remove(ids),
      clear: () => inner.clear(),
      getOutboxBound: (pubkey, kind) => inner.getOutboxBound(pubkey, kind),
      setOutboxBound: (pubkey, kind, bound) => inner.setOutboxBound(pubkey, kind, bound),
    };
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(false)
      .build();
    await client.connect();
    const summary = await client.syncToRelay(
      "wss://neg.example",
      { kinds: [1] },
      { direction: SyncDirection.Both, dryRun: true, timeoutMs: 2000 },
    );
    expect(summary.local).toEqual([local.id]);
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.sent).toEqual([]);
    expect(summary.received).toEqual([]);
    await client.shutdown();
  });

  test("Client.sync down observe false never putMany and still lists received", async () => {
    const remote = note(SK_B, "unsaved", 23);
    bus.seed("wss://neg.example", [remote]);
    let method = "";
    const store: EventStore = {
      async put(_event: Event): Promise<PutResult> {
        method = "put";
        throw new Error("disk full");
      },
      async putMany(_events: readonly Event[]): Promise<PutResult[]> {
        method = "putMany";
        throw new Error("disk full");
      },
      async get() {
        return undefined;
      },
      async query(_filters: Filter[]) {
        return [];
      },
      async count() {
        return 0;
      },
      async negentropyItems() {
        return [];
      },
      async remove() {
        return 0;
      },
      async clear() {},
      getOutboxBound: async () => undefined,
      setOutboxBound: async () => {},
    };
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(true)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000, observe: false },
    );
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.received).toEqual([remote.id]);
    expect(method).toBe("");
    expect(await store.get(remote.id)).toBeUndefined();
    await client.shutdown();
  });

  test("Client.sync down does not list received when store.putMany throws", async () => {
    const remote = note(SK_B, "unsaved-default", 23);
    bus.seed("wss://neg.example", [remote]);
    let method = "";
    const store: EventStore = {
      async put(_event: Event): Promise<PutResult> {
        method = "put";
        throw new Error("disk full");
      },
      async putMany(_events: readonly Event[]): Promise<PutResult[]> {
        method = "putMany";
        throw new Error("disk full");
      },
      async get() {
        return undefined;
      },
      async query(_filters: Filter[]) {
        return [];
      },
      async count() {
        return 0;
      },
      async negentropyItems() {
        return [];
      },
      async remove() {
        return 0;
      },
      async clear() {},
      getOutboxBound: async () => undefined,
      setOutboxBound: async () => {},
    };
    const client = Client.builder()
      .storage(store)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(true)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000 },
    );
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.received).toEqual([]);
    expect(method).toBe("putMany");
    expect(await store.get(remote.id)).toBeUndefined();
    await client.shutdown();
  });

  test("Client.sync down persistEvents false skips putMany and still ingestMeta", async () => {
    const remote = note(SK_B, "once", 24);
    bus.seed("wss://neg.example", [remote]);
    const inner = new MemoryEventStore();
    const persistCalls: string[] = [];
    let ingested = 0;
    const gossip = new Gossip();
    const origIngest = gossip.ingest.bind(gossip);
    gossip.ingest = (event) => {
      ingested += 1;
      return origIngest(event);
    };
    const store: EventStore = {
      put: async (event) => {
        persistCalls.push("put");
        return inner.put(event);
      },
      putMany: async (events) => {
        persistCalls.push(`putMany:${events.length}`);
        const out: PutResult[] = [];
        for (const event of events) out.push(await inner.put(event));
        return out;
      },
      get: (id) => inner.get(id),
      query: (filters) => inner.query(filters),
      count: (filters) => inner.count(filters),
      negentropyItems: (filter) => inner.negentropyItems(filter),
      remove: (ids) => inner.remove(ids),
      clear: () => inner.clear(),
      getOutboxBound: (pubkey, kind) => inner.getOutboxBound(pubkey, kind),
      setOutboxBound: (pubkey, kind, bound) => inner.setOutboxBound(pubkey, kind, bound),
    };
    const client = Client.builder()
      .storage(store)
      .gossip(gossip)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(false)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000 },
    );
    expect(summary.received).toEqual([remote.id]);
    expect(persistCalls).toEqual([]);
    expect(ingested).toBe(1);
    expect(await inner.get(remote.id)).toBeUndefined();
    await client.shutdown();
  });

  test("Client.sync down persistEvents true writes once via putMany then ingestMeta", async () => {
    const remote = note(SK_B, "once-persist", 24);
    bus.seed("wss://neg.example", [remote]);
    const inner = new MemoryEventStore();
    const persistCalls: string[] = [];
    let ingested = 0;
    const gossip = new Gossip();
    const origIngest = gossip.ingest.bind(gossip);
    gossip.ingest = (event) => {
      ingested += 1;
      return origIngest(event);
    };
    const store: EventStore = {
      put: async (event) => {
        persistCalls.push("put");
        return inner.put(event);
      },
      putMany: async (events) => {
        persistCalls.push(`putMany:${events.length}`);
        const out: PutResult[] = [];
        for (const event of events) out.push(await inner.put(event));
        return out;
      },
      get: (id) => inner.get(id),
      query: (filters) => inner.query(filters),
      count: (filters) => inner.count(filters),
      negentropyItems: (filter) => inner.negentropyItems(filter),
      remove: (ids) => inner.remove(ids),
      clear: () => inner.clear(),
      getOutboxBound: (pubkey, kind) => inner.getOutboxBound(pubkey, kind),
      setOutboxBound: (pubkey, kind, bound) => inner.setOutboxBound(pubkey, kind, bound),
    };
    const client = Client.builder()
      .storage(store)
      .gossip(gossip)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(true)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000 },
    );
    expect(summary.received).toEqual([remote.id]);
    expect(persistCalls).toEqual([`putMany:1`]);
    expect(ingested).toBe(1);
    expect(await inner.get(remote.id)).toBeDefined();
    await client.shutdown();
  });

  test("Client.sync down observe false skips putMany and ingestMeta", async () => {
    const remote = note(SK_B, "no-meta", 25);
    bus.seed("wss://neg.example", [remote]);
    const inner = new MemoryEventStore();
    const persistCalls: string[] = [];
    let ingested = 0;
    const gossip = new Gossip();
    const origIngest = gossip.ingest.bind(gossip);
    gossip.ingest = (event) => {
      ingested += 1;
      return origIngest(event);
    };
    const store: EventStore = {
      put: async (event) => {
        persistCalls.push("put");
        return inner.put(event);
      },
      putMany: async (events) => {
        persistCalls.push(`putMany:${events.length}`);
        const out: PutResult[] = [];
        for (const event of events) out.push(await inner.put(event));
        return out;
      },
      get: (id) => inner.get(id),
      query: (filters) => inner.query(filters),
      count: (filters) => inner.count(filters),
      negentropyItems: (filter) => inner.negentropyItems(filter),
      remove: (ids) => inner.remove(ids),
      clear: () => inner.clear(),
      getOutboxBound: (pubkey, kind) => inner.getOutboxBound(pubkey, kind),
      setOutboxBound: (pubkey, kind, bound) => inner.setOutboxBound(pubkey, kind, bound),
    };
    const client = Client.builder()
      .storage(store)
      .gossip(gossip)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(true)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000, observe: false },
    );
    expect(summary.received).toEqual([remote.id]);
    expect(persistCalls).toEqual([]);
    expect(ingested).toBe(0);
    expect(await inner.get(remote.id)).toBeUndefined();
    await client.shutdown();
  });

  test("Client.sync down skipped rejected putMany results", async () => {
    const remote = note(SK_B, "rej", 26);
    bus.seed("wss://neg.example", [remote]);
    let ingested = 0;
    const gossip = new Gossip();
    gossip.ingest = () => {
      ingested += 1;
      return false;
    };
    const store: EventStore = {
      async put() {
        return "rejected";
      },
      async putMany(events) {
        return events.map(() => "rejected");
      },
      async get() {
        return undefined;
      },
      async query() {
        return [];
      },
      async count() {
        return 0;
      },
      async negentropyItems() {
        return [];
      },
      async remove() {
        return 0;
      },
      async clear() {},
      getOutboxBound: async () => undefined,
      setOutboxBound: async () => {},
    };
    const client = Client.builder()
      .storage(store)
      .gossip(gossip)
      .relays(["wss://neg.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .persistEvents(true)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 2000 },
    );
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.received).toEqual([]);
    expect(ingested).toBe(0);
    await client.shutdown();
  });

  test("Client.sync mixed success does not throw; merges the good relay", async () => {
    const remote = note(SK_B, "from-good", 30);
    bus.seed("wss://neg.example", [remote]);

    class SwallowSilent extends MockWebSocket {
      send(data: string): void {
        if (this.url.includes("silent-neg.example")) return;
        super.send(data);
      }
    }

    const store = new MemoryEventStore();
    const client = Client.builder()
      .storage(store)
      .relays(["wss://silent-neg.example", "wss://neg.example"])
      .websocketImplementation(SwallowSilent as unknown as typeof MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    const summary = await client.sync(
      { kinds: [1] },
      { direction: SyncDirection.Down, timeoutMs: 150 },
    );
    expect(summary.remote).toEqual([remote.id]);
    expect(summary.received).toEqual([remote.id]);
    expect(await store.get(remote.id)).toBeDefined();
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

  test("Client.sync throws the first rejection in URL order when every relay rejects", async () => {
    const store = new MemoryEventStore();
    const client = Client.builder()
      .storage(store)
      .relays(["wss://silent-a.example", "wss://silent-b.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await client.connect();
    await expect(
      client.sync({ kinds: [1] }, { direction: SyncDirection.Down, timeoutMs: 80 }),
    ).rejects.toThrow(/negentropy timed out \(wss:\/\/silent-a\.example\/\)/);
    await client.shutdown();
  });
});
