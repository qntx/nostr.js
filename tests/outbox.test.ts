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
  normalizeURL,
  useWebSocketImplementation,
} from "../src/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK_A = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SK_B = "0000000000000000000000000000000000000000000000000000000000000001";

type ReqFilter = { authors?: string[]; kinds?: number[]; since?: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReq(timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (collectReqFilters().length > 0) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for REQ");
}

async function waitForReqSockets(minCount: number, timeoutMs = 500): Promise<MockWebSocket[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const sockets = MockWebSocket.instances.filter((ws) => reqMessages(ws).length > 0);
    if (sockets.length >= minCount) return sockets;
    await sleep(5);
  }
  throw new Error("timeout waiting for REQ sockets");
}

function collectReqFilters(): ReqFilter[] {
  const filters: ReqFilter[] = [];
  for (const ws of MockWebSocket.instances) {
    for (const raw of ws.sent) {
      const msg = JSON.parse(raw) as unknown[];
      if (msg[0] !== "REQ") continue;
      for (const filter of msg.slice(2) as ReqFilter[]) filters.push(filter);
    }
  }
  return filters;
}

function reqMessages(ws: MockWebSocket): unknown[][] {
  const out: unknown[][] = [];
  for (const raw of ws.sent) {
    const msg = JSON.parse(raw) as unknown[];
    if (msg[0] === "REQ") out.push(msg);
  }
  return out;
}

function kind1ReqFilters(msg: unknown[]): ReqFilter[] {
  return (msg.slice(2) as ReqFilter[]).filter((f) => f.kinds?.includes(Kind.TextNote));
}

async function waitForSharedKind1Reqs(minCount = 1): Promise<unknown[][]> {
  const start = Date.now();
  while (Date.now() - start < 500) {
    const ws = MockWebSocket.instances.find((s) => s.url.includes("shared.example"));
    if (ws) {
      const reqs = reqMessages(ws).filter((msg) => kind1ReqFilters(msg).length > 0);
      if (reqs.length >= minCount) return reqs;
    }
    await sleep(5);
  }
  throw new Error("timeout waiting for shared kind-1 REQ");
}

function eoseAllReqs(): void {
  for (const ws of MockWebSocket.instances) {
    for (const raw of ws.sent) {
      const msg = JSON.parse(raw) as unknown[];
      if (msg[0] !== "REQ") continue;
      ws.receive(JSON.stringify(["EOSE", msg[1] as string]));
    }
  }
}

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

  test("prefers connected URLs already in the author's list when slicing", () => {
    const gossip = new Gossip();
    const a = Keys.fromSecretKey(SK_A);
    gossip.setRoutes(a.publicKey, [
      { url: "wss://a.example", read: true, write: true },
      { url: "wss://b.example", read: true, write: true },
      { url: "wss://c.example", read: true, write: true },
      { url: "wss://d.example", read: true, write: true },
    ]);

    const map = groupAuthorsByOutboxRelay([a.publicKey], gossip, ["wss://discovery.example"], 3, [
      normalizeURL("wss://d.example"),
    ]);

    const urls = [...map.keys()];
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(normalizeURL("wss://d.example"));
    expect(urls).toContain(normalizeURL("wss://a.example"));
    expect(urls).toContain(normalizeURL("wss://b.example"));
    expect(urls.some((u) => u.includes("c.example"))).toBe(false);
    expect(map.get(urls[0]!)!.includes(a.publicKey)).toBe(true);
  });

  test("does not append a preferred URL that is not already a candidate", () => {
    const gossip = new Gossip();
    const a = Keys.fromSecretKey(SK_A);
    gossip.setRoutes(a.publicKey, [
      { url: "wss://a.example", read: true, write: true },
      { url: "wss://b.example", read: true, write: true },
    ]);

    const extra = normalizeURL("wss://connected-other.example");
    const map = groupAuthorsByOutboxRelay([a.publicKey], gossip, ["wss://discovery.example"], 3, [
      extra,
      normalizeURL("wss://b.example"),
    ]);

    const urls = [...map.keys()];
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(normalizeURL("wss://b.example"));
    expect(urls[1]).toBe(normalizeURL("wss://a.example"));
    expect(urls.includes(extra)).toBe(false);
    expect([...map.keys()].some((u) => u.includes("discovery"))).toBe(false);
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

  test("sync REQ since is derived from stored newest on a fresh feed", async () => {
    const a = Keys.fromSecretKey(SK_A);
    const stored = EventBuilder.textNote("seeded newest").createdAt(100).signWithKeys(a);
    const list = EventBuilder.relayList([{ url: "wss://out.example", read: false, write: true }])
      .createdAt(1)
      .signWithKeys(a);

    const store = new MemoryEventStore();
    await store.put(stored);
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
    const feed = new OutboxFeed({
      pool: client.pool,
      gossip,
      storage: store,
      discoveryRelays: client.relays,
      authors: [a.publicKey],
      kinds: [Kind.TextNote],
      observe: (e) => client.observe(e),
    });

    const syncP = feed.sync({ skipHydrate: true, limit: 20 });
    await waitForReq();
    const filters = collectReqFilters().filter(
      (f) => f.kinds?.includes(Kind.TextNote) && f.authors?.includes(a.publicKey),
    );
    eoseAllReqs();
    await syncP;

    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) {
      expect(filter.since).toBe(99);
    }
    expect(feed.getBound(a.publicKey, Kind.TextNote)?.newest).toBe(100);

    feed.close();
    await client.shutdown();
  });

  test("mixed relay group keeps unbound authors without since", async () => {
    const a = Keys.fromSecretKey(SK_A);
    const b = Keys.fromSecretKey(SK_B);
    const stored = EventBuilder.textNote("a only").createdAt(80).signWithKeys(a);

    const store = new MemoryEventStore();
    await store.put(stored);
    const gossip = new Gossip();
    gossip.setRoutes(a.publicKey, [{ url: "wss://shared.example", read: true, write: true }]);
    gossip.setRoutes(b.publicKey, [{ url: "wss://shared.example", read: true, write: true }]);

    const client = Client.builder()
      .storage(store)
      .gossip(gossip)
      .relays(["wss://discovery.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();
    const feed = new OutboxFeed({
      pool: client.pool,
      gossip,
      storage: store,
      discoveryRelays: client.relays,
      authors: [a.publicKey, b.publicKey],
      kinds: [Kind.TextNote],
      observe: (e) => client.observe(e),
    });

    const syncP = feed.sync({ skipHydrate: true, limit: 20 });
    const reqs = await waitForSharedKind1Reqs(1);
    expect(reqs).toHaveLength(1);
    const msg = reqs[0]!;
    expect(msg.length).toBe(4);
    const filters = msg.slice(2) as ReqFilter[];
    eoseAllReqs();
    await syncP;

    expect(filters).toHaveLength(2);
    const forA = filters.filter((f) => f.authors?.includes(a.publicKey));
    const forB = filters.filter((f) => f.authors?.includes(b.publicKey));
    expect(forA.some((f) => f.since === 79 && !f.authors?.includes(b.publicKey))).toBe(true);
    expect(forB.some((f) => f.since === undefined && !f.authors?.includes(a.publicKey))).toBe(true);

    feed.close();
    await client.shutdown();
  });

  test("caller since wins for mixed groups including since 0", async () => {
    const a = Keys.fromSecretKey(SK_A);
    const b = Keys.fromSecretKey(SK_B);
    const stored = EventBuilder.textNote("a newest").createdAt(100).signWithKeys(a);

    const store = new MemoryEventStore();
    await store.put(stored);
    const gossip = new Gossip();
    gossip.setRoutes(a.publicKey, [{ url: "wss://shared.example", read: true, write: true }]);
    gossip.setRoutes(b.publicKey, [{ url: "wss://shared.example", read: true, write: true }]);

    const client = Client.builder()
      .storage(store)
      .gossip(gossip)
      .relays(["wss://discovery.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();
    const feed = new OutboxFeed({
      pool: client.pool,
      gossip,
      storage: store,
      discoveryRelays: client.relays,
      authors: [a.publicKey, b.publicKey],
      kinds: [Kind.TextNote],
      observe: (e) => client.observe(e),
    });

    let seen = 0;
    for (const since of [50, 0] as const) {
      const syncP = feed.sync({ skipHydrate: true, since, limit: 20 });
      const reqs = await waitForSharedKind1Reqs(seen + 1);
      const msg = reqs[reqs.length - 1]!;
      seen = reqs.length;
      expect(msg.length).toBe(3);
      const filters = kind1ReqFilters(msg);
      eoseAllReqs();
      await syncP;

      expect(filters).toHaveLength(1);
      const filter = filters[0]!;
      expect(filter.authors?.includes(a.publicKey)).toBe(true);
      expect(filter.authors?.includes(b.publicKey)).toBe(true);
      expect(filter.authors).toHaveLength(2);
      expect(filter.since).toBe(since);
    }

    feed.close();
    await client.shutdown();
  });

  test("startLive prefers a connected outbox relay within maxRelaysPerAuthor", async () => {
    const a = Keys.fromSecretKey(SK_A);
    const gossip = new Gossip();
    gossip.setRoutes(a.publicKey, [
      { url: "wss://out-a.example", read: true, write: true },
      { url: "wss://out-b.example", read: true, write: true },
      { url: "wss://out-c.example", read: true, write: true },
      { url: "wss://out-d.example", read: true, write: true },
    ]);

    const client = Client.builder()
      .gossip(gossip)
      .relays(["wss://discovery.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();
    await client.pool.ensureRelay("wss://out-d.example");

    const feed = new OutboxFeed({
      pool: client.pool,
      gossip,
      storage: client.storage,
      discoveryRelays: client.relays,
      authors: [a.publicKey],
      maxRelaysPerAuthor: 3,
    });

    const live = feed.startLive({ since: 0 });
    await waitForReqSockets(3);
    await sleep(20);

    const reqUrls = MockWebSocket.instances
      .filter((ws) => reqMessages(ws).length > 0)
      .map((ws) => ws.url);
    expect(reqUrls).toHaveLength(3);
    expect(reqUrls.some((u) => u.includes("out-d.example"))).toBe(true);
    expect(reqUrls.some((u) => u.includes("out-a.example"))).toBe(true);
    expect(reqUrls.some((u) => u.includes("out-b.example"))).toBe(true);
    expect(reqUrls.some((u) => u.includes("out-c.example"))).toBe(false);

    live.close();
    feed.close();
    await client.shutdown();
  });

  test("startLive does not add a connected relay missing from the author's list", async () => {
    const a = Keys.fromSecretKey(SK_A);
    const gossip = new Gossip();
    gossip.setRoutes(a.publicKey, [{ url: "wss://out-a.example", read: true, write: true }]);

    const client = Client.builder()
      .gossip(gossip)
      .relays(["wss://discovery.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    await client.connect();
    await client.pool.ensureRelay("wss://other.example");

    const feed = new OutboxFeed({
      pool: client.pool,
      gossip,
      storage: client.storage,
      discoveryRelays: client.relays,
      authors: [a.publicKey],
    });

    const live = feed.startLive({ since: 0 });
    await waitForReqSockets(1);
    await sleep(20);

    const other = MockWebSocket.instances.find((ws) => ws.url.includes("other.example"));
    expect(other).toBeDefined();
    expect(reqMessages(other!)).toHaveLength(0);
    expect(
      MockWebSocket.instances.some(
        (ws) => ws.url.includes("out-a.example") && reqMessages(ws).length > 0,
      ),
    ).toBe(true);

    live.close();
    feed.close();
    await client.shutdown();
  });
});
