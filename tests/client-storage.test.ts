import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Gossip,
  Kind,
  Keys,
  KeysSigner,
  MemoryEventStore,
  relayListEventBuilder,
  StorageError,
  useWebSocketImplementation,
  type EventStore,
  type PutResult,
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

  test("fetchEvents localFirst query throw reports onstorageerror and still returns network events", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("from net").createdAt(5).signWithKeys(keys);
    const inner = new MemoryEventStore();
    let queryCalls = 0;
    const seen: StorageError[] = [];
    const store: EventStore = {
      put: (event) => inner.put(event),
      putMany: (events) => inner.putMany(events),
      get: (id) => inner.get(id),
      query: async () => {
        queryCalls += 1;
        throw new Error("query boom");
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
      .onstorageerror((err) => {
        seen.push(err);
      })
      .relays(["wss://a.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();
    const fetchP = client.fetchEvents(
      { kinds: [1], authors: [keys.publicKey] },
      { timeoutMs: 2000, localFirst: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    const ws = MockWebSocket.last();
    const req = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [string, string];
    ws.receive(JSON.stringify(["EVENT", req[1], note]));
    ws.receive(JSON.stringify(["EOSE", req[1]]));
    const events = await fetchP;
    expect(queryCalls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(StorageError);
    expect(seen[0]!.message).toBe("query boom");
    expect(seen[0]!.cause).toBeInstanceOf(Error);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(note.id);
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
    const list = relayListEventBuilder([{ url: "wss://out.example", read: true, write: true }])
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
        }
        ws.receive(JSON.stringify(["EOSE", subId]));
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

  test("observe batches into one putMany; shutdown awaits flush", async () => {
    const inner = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    const batches: string[][] = [];
    let putCalls = 0;
    const store: EventStore = {
      put: async (event) => {
        putCalls += 1;
        return inner.put(event);
      },
      putMany: async (events) => {
        batches.push(events.map((e) => e.id));
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
    const client = Client.builder().storage(store).enableReconnect(false).build();
    client.observe(a);
    client.observe(b);
    await client.shutdown();
    expect(batches).toEqual([[a.id, b.id]]);
    expect(putCalls).toBe(0);
    expect(await inner.get(a.id)).toBeDefined();
    expect(await inner.get(b.id)).toBeDefined();
  });

  test("observeAll queues unique events as one persist batch", async () => {
    const inner = new MemoryEventStore();
    const keys = Keys.fromSecretKey(SK);
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    const batches: string[][] = [];
    const store: EventStore = {
      put: (event) => inner.put(event),
      putMany: async (events) => {
        batches.push(events.map((e) => e.id));
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
    const client = Client.builder().storage(store).enableReconnect(false).build();
    client.observeAll([a, b, a]);
    await client.shutdown();
    expect(batches).toEqual([[a.id, b.id]]);
  });

  test("single-flight flush does not overlap putMany", async () => {
    const keys = Keys.fromSecretKey(SK);
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    let inFlight = 0;
    let maxInFlight = 0;
    let first = true;
    let releaseFirst!: () => void;
    const batches: string[][] = [];
    const store: EventStore = {
      put: async () => "accepted",
      putMany: async (events) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        batches.push(events.map((e) => e.id));
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        inFlight -= 1;
        return events.map(() => "accepted");
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
    const client = Client.builder().storage(store).enableReconnect(false).build();
    client.observe(a);
    await Promise.resolve();
    await Promise.resolve();
    expect(batches).toEqual([[a.id]]);
    client.observe(b);
    expect(batches).toEqual([[a.id]]);
    expect(inFlight).toBe(1);
    releaseFirst();
    await client.shutdown();
    expect(batches).toEqual([[a.id], [b.id]]);
    expect(maxInFlight).toBe(1);
  });

  test("shutdown waits for in-flight putMany", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("flush").createdAt(1).signWithKeys(keys);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let putManyDone = false;
    const store: EventStore = {
      put: async () => "accepted",
      putMany: async (events) => {
        await gate;
        putManyDone = true;
        return events.map(() => "accepted");
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
    const client = Client.builder().storage(store).enableReconnect(false).build();
    client.observe(note);
    const done = client.shutdown();
    let shutdownDone = false;
    void done.then(() => {
      shutdownDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(putManyDone).toBe(false);
    expect(shutdownDone).toBe(false);
    finish();
    await done;
    expect(putManyDone).toBe(true);
    expect(shutdownDone).toBe(true);
  });

  test("ingestMeta runs before persist completes", async () => {
    const keys = Keys.fromSecretKey(SK);
    const list = relayListEventBuilder([{ url: "wss://out.example", read: true, write: true }])
      .createdAt(3)
      .signWithKeys(keys);
    const gossip = new Gossip();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const store: EventStore = {
      put: async () => "accepted",
      putMany: async (events) => {
        await gate;
        return events.map(() => "accepted");
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
    const client = Client.builder().storage(store).gossip(gossip).enableReconnect(false).build();
    client.observe(list);
    expect(gossip.outboxRelays(keys.publicKey).length).toBeGreaterThan(0);
    finish();
    await client.shutdown();
  });

  test("builder onstorageerror is the instance callback and is invoked", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("fail").createdAt(1).signWithKeys(keys);
    const seen: StorageError[] = [];
    const fn = (err: StorageError) => {
      seen.push(err);
    };
    const store: EventStore = {
      async put() {
        throw new Error("disk full");
      },
      async putMany() {
        throw new Error("disk full");
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
      .onstorageerror(fn)
      .enableReconnect(false)
      .build();
    expect(client.onstorageerror).toBe(fn);
    client.observe(note);
    await client.shutdown();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(StorageError);
    expect(seen[0]!.cause).toBeInstanceOf(Error);
    expect(seen[0]!.message).toBe("disk full");
    expect(seen[0]!.message.includes(note.content)).toBe(false);
  });

  test("subscribe persist failure does not throw and still delivers onevent", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("live").createdAt(1).signWithKeys(keys);
    const seen: StorageError[] = [];
    const store: EventStore = {
      async put() {
        throw new Error("disk full");
      },
      async putMany() {
        throw new Error("disk full");
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
      .onstorageerror((err) => {
        seen.push(err);
      })
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
    await client.shutdown();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(StorageError);
    sub.close();
  });

  test("persistEvents false does not call putMany", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("skip").createdAt(1).signWithKeys(keys);
    let putManyCalls = 0;
    const store: EventStore = {
      put: async () => "accepted",
      putMany: async (events) => {
        putManyCalls += 1;
        return events.map(() => "accepted");
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
      .persistEvents(false)
      .enableReconnect(false)
      .build();
    client.observe(note);
    client.observeAll([note]);
    await client.shutdown();
    expect(putManyCalls).toBe(0);
  });

  test("onstorageerror omitted does not throw when putMany fails", async () => {
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("x").createdAt(1).signWithKeys(keys);
    const store: EventStore = {
      async put() {
        throw new Error("disk full");
      },
      async putMany() {
        throw new Error("disk full");
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
    const client = Client.builder().storage(store).enableReconnect(false).build();
    expect(client.onstorageerror).toBeNull();
    client.observe(note);
    await client.shutdown();
  });
});
