import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Gossip,
  Keys,
  Kind,
  Pool,
  createLoaders,
  dmRelayListEventBuilder,
  parseDmRelayList,
  relayListEventBuilder,
  useWebSocketImplementation,
} from "../src/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SK2 = "0000000000000000000000000000000000000000000000000000000000000001";

beforeEach(() => {
  MockWebSocket.reset();
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  MockWebSocket.reset();
});

function respondReplaceables(
  events: Array<{ kind: number; event: ReturnType<typeof EventBuilder.prototype.signWithKeys> }>,
) {
  // after microtasks, answer each REQ with matching events
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      for (const ws of MockWebSocket.instances) {
        for (const raw of ws.sent) {
          const msg = JSON.parse(raw) as unknown[];
          if (msg[0] !== "REQ") continue;
          const subId = msg[1] as string;
          const filter = msg[2] as { kinds?: number[]; authors?: string[] };
          for (const { kind, event } of events) {
            if (filter.kinds && !filter.kinds.includes(kind)) continue;
            if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
            ws.receive(JSON.stringify(["EVENT", subId, event]));
          }
          ws.receive(JSON.stringify(["EOSE", subId]));
        }
      }
      resolve();
    }, 15);
  });
}

describe("Gossip", () => {
  test("ingest NIP-65 and route by authors", () => {
    const keys = Keys.fromSecretKey(SK);
    const list = relayListEventBuilder([
      { url: "wss://write.example", read: false, write: true },
      { url: "wss://read.example", read: true, write: false },
      { url: "wss://both.example", read: true, write: true },
    ])
      .createdAt(1)
      .signWithKeys(keys);

    const gossip = new Gossip();
    expect(gossip.ingest(list)).toBe(true);
    expect(gossip.outboxRelays(keys.publicKey).length).toBeGreaterThan(0);
    expect(gossip.inboxRelays(keys.publicKey).length).toBeGreaterThan(0);
    expect(gossip.dmRelays(keys.publicKey)).toEqual([]);

    const routed = gossip.route({
      kinds: [1],
      authors: [keys.publicKey],
    });
    expect(routed.remainder).toBeUndefined();
    expect(routed.perRelay.size).toBeGreaterThan(0);
    for (const filter of routed.perRelay.values()) {
      expect(filter.authors).toEqual([keys.publicKey]);
      expect(filter.kinds).toEqual([1]);
    }

    const generic = gossip.route({ kinds: [1] });
    expect(generic.perRelay.size).toBe(0);
    expect(generic.remainder).toEqual({ kinds: [1] });
  });

  test("route leftover authors become remainder", () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const gossip = new Gossip();
    gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const routed = gossip.route({
      kinds: [1],
      authors: [a.publicKey, b.publicKey],
    });
    if (!routed.remainder) throw new Error("expected remainder");
    expect(routed.remainder.authors).toEqual([b.publicKey]);
    expect(routed.remainder.kinds).toEqual([1]);
    expect(routed.perRelay.size).toBe(1);
    const [url, filter] = [...routed.perRelay.entries()][0]!;
    expect(url.includes("out-a.example")).toBe(true);
    expect(filter.authors).toEqual([a.publicKey]);
    expect(filter.kinds).toEqual([1]);
  });

  test("route leftover #p values become remainder", () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const gossip = new Gossip();
    gossip.ingest(
      relayListEventBuilder([{ url: "wss://in-a.example", read: true, write: false }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const routed = gossip.route({
      kinds: [1],
      "#p": [a.publicKey, b.publicKey],
    });
    if (!routed.remainder) throw new Error("expected remainder");
    expect(routed.remainder["#p"]).toEqual([b.publicKey]);
    expect(routed.remainder.kinds).toEqual([1]);
    expect(routed.perRelay.size).toBe(1);
    const [url, filter] = [...routed.perRelay.entries()][0]!;
    expect(url.includes("in-a.example")).toBe(true);
    expect(filter["#p"]).toEqual([a.publicKey]);
  });

  test("route authors+#p leftover keeps the original filter as remainder", () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const gossip = new Gossip();
    gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const filter = {
      kinds: [1],
      authors: [a.publicKey, b.publicKey],
      "#p": [a.publicKey],
    };
    const routed = gossip.route(filter);
    expect(routed.remainder).toBe(filter);
    expect(routed.perRelay.size).toBe(1);
    const sub = [...routed.perRelay.values()][0]!;
    expect(sub.authors).toEqual(filter.authors);
    expect(sub["#p"]).toEqual(filter["#p"]);
  });

  test("ingest kind 10050 DM relays without clobbering NIP-65", () => {
    const keys = Keys.fromSecretKey(SK);
    const nip65 = relayListEventBuilder([{ url: "wss://out.example", read: false, write: true }])
      .createdAt(10)
      .signWithKeys(keys);
    const dm = dmRelayListEventBuilder(["wss://dm-a.example", "wss://dm-b.example"])
      .createdAt(20)
      .signWithKeys(keys);
    expect(parseDmRelayList(dm).map((u) => u.replace(/\/$/, ""))).toEqual([
      "wss://dm-a.example",
      "wss://dm-b.example",
    ]);

    const gossip = new Gossip();
    expect(gossip.ingest(nip65)).toBe(true);
    expect(gossip.ingest(dm)).toBe(true);

    expect(gossip.outboxRelays(keys.publicKey).some((u) => u.includes("out.example"))).toBe(true);
    expect(gossip.dmRelays(keys.publicKey).map((u) => u.replace(/\/$/, ""))).toEqual([
      "wss://dm-a.example",
      "wss://dm-b.example",
    ]);

    // older dm list ignored
    const older = dmRelayListEventBuilder(["wss://old-dm.example"]).createdAt(5).signWithKeys(keys);
    expect(gossip.ingest(older)).toBe(false);
    expect(gossip.dmRelays(keys.publicKey).some((u) => u.includes("old-dm"))).toBe(false);

    // NIP-65 still intact after dm update
    expect(gossip.getRoutes(keys.publicKey)?.updatedAt).toBe(10);
    expect(gossip.getRoutes(keys.publicKey)?.dmUpdatedAt).toBe(20);
    const orphan = gossip.route({ authors: [Keys.fromSecretKey(SK2).publicKey] });
    expect(orphan.perRelay.size).toBe(0);
    expect(orphan.remainder?.authors).toEqual([Keys.fromSecretKey(SK2).publicKey]);
  });
});

describe("Loaders", () => {
  test("follows and profile batch via pool", async () => {
    const keys = Keys.fromSecretKey(SK);
    const other = Keys.fromSecretKey(SK2);

    const follows = EventBuilder.contacts([other.publicKey, keys.publicKey])
      .createdAt(10)
      .signWithKeys(keys);
    const meta = EventBuilder.metadata({ name: "alice", picture: "https://x/y.png" })
      .createdAt(11)
      .signWithKeys(keys);

    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    const loaders = createLoaders({
      pool,
      relays: ["wss://idx.example"],
    });

    const followsP = loaders.follows(keys.publicKey);
    const profileP = loaders.profile(keys.publicKey);
    await respondReplaceables([
      { kind: Kind.Contacts, event: follows },
      { kind: Kind.Metadata, event: meta },
    ]);

    const fl = await followsP;
    expect(fl.items).toContain(other.publicKey);
    expect(fl.event?.id).toBe(follows.id);

    const user = await profileP;
    expect(user.metadata.name).toBe("alice");
    expect(user.image).toBe("https://x/y.png");
    expect(user.shortName).toBe("alice");

    // cache hit (no extra network required for second call with default style)
    const fl2 = await loaders.follows(keys.publicKey);
    expect(fl2.fresh).toBe(false);
    expect(fl2.items).toEqual(fl.items);

    pool.close();
  });

  test("relayList loader + client.observe", async () => {
    const keys = Keys.fromSecretKey(SK);
    const list = relayListEventBuilder([{ url: "wss://out.example", read: true, write: true }])
      .createdAt(5)
      .signWithKeys(keys);

    const client = Client.builder()
      .relays(["wss://idx.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();

    const p = client.loaders.relayList(keys.publicKey);
    await respondReplaceables([{ kind: Kind.RelayList, event: list }]);
    const result = await p;
    expect(result.items.some((i: { write: boolean }) => i.write)).toBe(true);

    client.observe(list);
    expect(client.gossip.outboxRelays(keys.publicKey).length).toBeGreaterThan(0);

    await client.shutdown();
  });

  test("dmRelayList loader + observe caches 10050", async () => {
    const keys = Keys.fromSecretKey(SK);
    const dm = dmRelayListEventBuilder(["wss://dm-a.example"]).createdAt(7).signWithKeys(keys);

    const client = Client.builder()
      .relays(["wss://idx.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();

    const p = client.loaders.dmRelayList(keys.publicKey);
    await respondReplaceables([{ kind: Kind.DirectMessageRelaysList, event: dm }]);
    const result = await p;
    expect(result.items.some((u) => u.includes("dm-a.example"))).toBe(true);

    client.observe(dm);
    expect(client.gossip.dmRelays(keys.publicKey).some((u) => u.includes("dm-a.example"))).toBe(
      true,
    );
    expect(
      client.loaders.context.cache.get({
        kind: Kind.DirectMessageRelaysList,
        pubkey: keys.publicKey,
      })?.event?.id,
    ).toBe(dm.id);

    await client.shutdown();
  });

  test("hydrateGossip loads 10002 and 10050", async () => {
    const keys = Keys.fromSecretKey(SK);
    const list = relayListEventBuilder([{ url: "wss://out.example", read: true, write: true }])
      .createdAt(8)
      .signWithKeys(keys);
    const dm = dmRelayListEventBuilder(["wss://dm.example"]).createdAt(9).signWithKeys(keys);

    const client = Client.builder()
      .relays(["wss://idx.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();

    const hydrateP = client.hydrateGossip([keys.publicKey]);
    await respondReplaceables([
      { kind: Kind.RelayList, event: list },
      { kind: Kind.DirectMessageRelaysList, event: dm },
    ]);
    await hydrateP;

    expect(client.gossip.outboxRelays(keys.publicKey).some((u) => u.includes("out.example"))).toBe(
      true,
    );
    expect(client.gossip.dmRelays(keys.publicKey).some((u) => u.includes("dm.example"))).toBe(true);

    await client.shutdown();
  });
});
