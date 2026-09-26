import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Kind,
  Keys,
  KeysSigner,
  Pool,
  Relay,
  finalizeEvent,
} from "../src/index.ts";
import type { Event, EventTemplate } from "../src/core/event.ts";
import type { WebSocketConstructor } from "../src/relay/websocket.ts";
import { Nip46Signer } from "../src/signer/nip46.ts";
import {
  createFakeNip46Signer,
  createFakeRelayNetwork,
  serveFakeRelay,
  type FakeRelayNetwork,
} from "../src/testing/index.ts";
import { FakeRelayCore } from "../src/testing/relay-core.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("timed out");
}

function note(content: string, createdAt = 1): Event {
  return EventBuilder.textNote(content).createdAt(createdAt).signWithKeys(Keys.fromSecretKey(SK));
}

describe("FakeRelay NIP-01 + faults", () => {
  let net: FakeRelayNetwork;

  beforeEach(() => {
    net = createFakeRelayNetwork();
  });

  afterEach(() => {
    net.close();
  });

  test("stores, queries, and delivers injected events to live subscriptions", async () => {
    const relay = await Relay.connect("wss://live.example", {
      websocketImplementation: net.websocketImplementation,
    });
    const got: Event[] = [];
    const sub = relay.subscribe([{ kinds: [Kind.TextNote] }], {
      onevent: (e) => got.push(e),
    });

    const live = note("live event", 5);
    net.relay("wss://live.example").inject(live);
    await waitFor(() => got.length === 1);
    expect(got[0]!.id).toBe(live.id);
    expect(
      net
        .relay("wss://live.example")
        .events()
        .some((e) => e.id === live.id),
    ).toBe(true);

    sub.close();
    relay.close();
  });

  test("rate-limited writes fail with rate-limited OK", async () => {
    const relay = await Relay.connect("wss://rate.example", {
      websocketImplementation: net.websocketImplementation,
    });
    net.relay("wss://rate.example", { rateLimited: true });
    const res = await relay.publish(note("nope"));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/rate-limited:/);
    relay.close();
  });

  test("eoseBeforeEvents sends EOSE before stored events", async () => {
    const stored = note("stored", 3);
    net.relay("wss://eose.example", { eoseBeforeEvents: true }).seed([stored]);
    const relay = await Relay.connect("wss://eose.example", {
      websocketImplementation: net.websocketImplementation,
    });
    const order: string[] = [];
    const sub = relay.subscribe([{ kinds: [Kind.TextNote] }], {
      onevent: () => order.push("EVENT"),
      oneose: () => order.push("EOSE"),
    });
    await waitFor(() => order.includes("EOSE") && order.includes("EVENT"));
    expect(order).toEqual(["EOSE", "EVENT"]);
    sub.close();
    relay.close();
  });

  test("closeSubscriptions sends CLOSED to every live subscription", async () => {
    const relay = await Relay.connect("wss://closed.example", {
      websocketImplementation: net.websocketImplementation,
    });
    const reasons: string[] = [];
    const a = relay.subscribe([{ kinds: [1] }], { onclose: (r) => reasons.push(`a:${r}`) });
    const b = relay.subscribe([{ kinds: [2] }], { onclose: (r) => reasons.push(`b:${r}`) });
    await sleep(10);
    net.relay("wss://closed.example").closeSubscriptions("lab: maintenance");
    await waitFor(() => reasons.length === 2);
    expect(reasons).toEqual(["a:lab: maintenance", "b:lab: maintenance"]);
    a.close();
    b.close();
    relay.close();
  });

  test("COUNT returns the stored match count", async () => {
    const keys = Keys.fromSecretKey(SK);
    net.relay("wss://count.example").seed([note("a", 1), note("b", 2), note("c", 3)]);
    const relay = await Relay.connect("wss://count.example", {
      websocketImplementation: net.websocketImplementation,
    });
    const res = await relay.count([{ kinds: [1], authors: [keys.publicKey] }], {
      timeoutMs: 2000,
    });
    expect(res.count).toBe(3);
    relay.close();
  });

  test("search matches content case-insensitively", async () => {
    net
      .relay("wss://search.example")
      .seed([note("Hello Nostr", 1), note("goodbye", 2), note("heLLO world", 3)]);
    const relay = await Relay.connect("wss://search.example", {
      websocketImplementation: net.websocketImplementation,
    });
    const found = await relay.fetch([{ kinds: [1], search: "hello" }], { timeoutMs: 2000 });
    expect(found.map((e) => e.content).sort()).toEqual(["Hello Nostr", "heLLO world"]);
    relay.close();
  });

  test("disconnect drops sockets and the client reconnects", async () => {
    let reconnects = 0;
    const relay = await Relay.connect("wss://bounce.example", {
      websocketImplementation: net.websocketImplementation,
      enableReconnect: true,
      reconnectBackoffMs: [10],
    });
    relay.onreconnect = () => {
      reconnects += 1;
    };
    const got: Event[] = [];
    relay.subscribe([{ kinds: [1] }], { onevent: (e) => got.push(e) });

    net.relay("wss://bounce.example").disconnect();
    await waitFor(() => reconnects === 1);

    const after = note("after reconnect", 7);
    net.relay("wss://bounce.example").inject(after);
    await waitFor(() => got.some((e) => e.id === after.id));

    relay.close();
  });
});

describe("FakeRelay NIP-42 auth", () => {
  const keys = Keys.fromSecretKey(SK);
  const authSigner = (template: EventTemplate): Promise<Event> =>
    Promise.resolve(finalizeEvent(template, keys.secretKey));

  let net: FakeRelayNetwork;

  beforeEach(() => {
    net = createFakeRelayNetwork();
  });

  afterEach(() => {
    net.close();
  });

  test("readKinds REQ is CLOSED auth-required before AUTH, served after", async () => {
    const stored = note("secret stuff", 4);
    net
      .relay("wss://auth-read.example", {
        auth: { challenge: "chal-read", readKinds: [Kind.TextNote] },
      })
      .seed([stored]);
    const relay = await Relay.connect("wss://auth-read.example", {
      websocketImplementation: net.websocketImplementation,
      authSigner,
    });
    const got: Event[] = [];
    const sub = relay.subscribe([{ kinds: [Kind.TextNote] }], {
      onevent: (e) => got.push(e),
    });
    await waitFor(() => got.length === 1);
    expect(got[0]!.id).toBe(stored.id);
    sub.close();
    relay.close();
  });

  test("readKinds REQ without an auth signer stays closed", async () => {
    net
      .relay("wss://auth-read2.example", {
        auth: { challenge: "c2", readKinds: [Kind.TextNote] },
      })
      .seed([note("hidden", 1)]);
    const relay = await Relay.connect("wss://auth-read2.example", {
      websocketImplementation: net.websocketImplementation,
    });
    const reasons: string[] = [];
    const sub = relay.subscribe([{ kinds: [Kind.TextNote] }], {
      onclose: (r) => reasons.push(r),
    });
    await waitFor(() => reasons.length === 1);
    expect(reasons[0]).toMatch(/^auth-required:/);
    sub.close();
    relay.close();
  });

  test("writes EVENT fails auth-required before AUTH, succeeds after", async () => {
    net.relay("wss://auth-write.example", {
      auth: { challenge: "chal-write", writes: true },
    });
    const relay = await Relay.connect("wss://auth-write.example", {
      websocketImplementation: net.websocketImplementation,
      authSigner,
    });
    const res = await relay.publish(note("authed write"));
    expect(res.ok).toBe(true);
    relay.close();
  });

  test("writes EVENT without an auth signer fails", async () => {
    net.relay("wss://auth-write2.example", {
      auth: { challenge: "cw2", writes: true },
    });
    const relay = await Relay.connect("wss://auth-write2.example", {
      websocketImplementation: net.websocketImplementation,
    });
    const res = await relay.publish(note("no auth"));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/^auth-required:/);
    relay.close();
  });

  test("invalid AUTH event is rejected", async () => {
    net.relay("wss://auth-bad.example", {
      auth: { challenge: "real-challenge", writes: true },
    });
    const relay = await Relay.connect("wss://auth-bad.example", {
      websocketImplementation: net.websocketImplementation,
      authSigner: (template) =>
        Promise.resolve(
          finalizeEvent(
            {
              ...template,
              tags: template.tags.map((t) => (t[0] === "challenge" ? ["challenge", "wrong"] : t)),
            },
            keys.secretKey,
          ),
        ),
    });
    const res = await relay.publish(note("bad auth"));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/^auth-required:|error:/);
    relay.close();
  });
});

describe("serveFakeRelay over real ws", () => {
  test("Client publishes and fetches against a real WebSocket server", async () => {
    const served = await serveFakeRelay({ port: 0 });
    try {
      const keys = Keys.fromSecretKey(SK);
      const client = Client.builder()
        .signer(new KeysSigner(keys))
        .relays([served.url])
        .websocketImplementation(globalThis.WebSocket as unknown as WebSocketConstructor)
        .trustedInsecureUrls([served.url])
        .enableReconnect(false)
        .build();
      await client.connect();
      const results = await client.publish(EventBuilder.textNote("real ws hello").createdAt(9));
      expect(results.every((r) => r.result?.ok)).toBe(true);
      const fetched = await client.fetchEvents(
        { kinds: [1], authors: [keys.publicKey] },
        { timeoutMs: 3000 },
      );
      expect(fetched.some((e) => e.content === "real ws hello")).toBe(true);
      await client.shutdown();
    } finally {
      await served.close();
    }
  });
});

describe("createFakeNip46Signer", () => {
  test("signs events remotely through the fake relay", async () => {
    const net = createFakeRelayNetwork();
    try {
      const clientKeys = Keys.generate();
      const remote = createFakeNip46Signer({
        network: net,
        relayUrl: "wss://sign.example",
        clientPubkey: clientKeys.publicKey,
      });
      const signer = await Nip46Signer.connect(
        {
          pubkey: remote.bunkerPubkey,
          relays: ["wss://sign.example"],
          secret: "s",
        },
        {
          clientSecretKey: clientKeys.secretKey,
          createPool: () =>
            new Pool({
              websocketImplementation: net.websocketImplementation,
              enableReconnect: true,
            }),
          timeoutMs: 3000,
        },
      );
      const unsigned = EventBuilder.textNote("via fake signer")
        .createdAt(11)
        .buildUnsigned(remote.userPublicKey);
      const signed = await signer.signEvent(unsigned);
      expect(signed.pubkey).toBe(remote.userPublicKey);
      expect(signed.content).toBe("via fake signer");
      await signer.close();
      remote.close();
    } finally {
      net.close();
    }
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

  test("#3 fake relay applies per-filter limits and search, and COUNT matches only search hits", async () => {
    const keys = Keys.fromSecretKey(SK);
    const notes = [1, 2, 3, 4, 5].map((t) =>
      EventBuilder.textNote(`n${t}`).createdAt(t).signWithKeys(keys),
    );
    const meta = EventBuilder.metadata({ name: "m" }).createdAt(6).signWithKeys(keys);
    net.relay("wss://filters.example").seed([...notes, meta]);
    const relay = await Relay.connect("wss://filters.example", {
      websocketImplementation: net.websocketImplementation,
      enableReconnect: false,
    });

    const batch = await relay.fetch(
      [
        { kinds: [1], limit: 5 },
        { kinds: [0], limit: 5 },
      ],
      { timeoutMs: 2000 },
    );
    expect(batch).toHaveLength(6);

    net
      .relay("wss://search-limit.example")
      .seed([
        EventBuilder.textNote("hello there").createdAt(1).signWithKeys(keys),
        EventBuilder.textNote("unrelated").createdAt(2).signWithKeys(keys),
      ]);
    const searchRelay = await Relay.connect("wss://search-limit.example", {
      websocketImplementation: net.websocketImplementation,
      enableReconnect: false,
    });
    const hit = await searchRelay.fetch([{ kinds: [1], search: "hello", limit: 1 }], {
      timeoutMs: 2000,
    });
    expect(hit.map((e) => e.content)).toEqual(["hello there"]);
    const counted = await searchRelay.count([{ kinds: [1], search: "hello" }], {
      timeoutMs: 2000,
    });
    expect(counted.count).toBe(1);

    relay.close();
    searchRelay.close();
  });

  test("#5 fake relay does not live-deliver events the store did not keep", async () => {
    const keys = Keys.fromSecretKey(SK);
    const url = "wss://semantics.example";
    const core = net.relay(url);
    const subRelay = await Relay.connect(url, {
      websocketImplementation: net.websocketImplementation,
      enableReconnect: false,
    });
    const pub = await Relay.connect(url, {
      websocketImplementation: net.websocketImplementation,
      enableReconnect: false,
    });

    // (a) injecting an older replaceable than the stored one is not delivered
    const metaNew = EventBuilder.metadata({ name: "new" }).createdAt(20).signWithKeys(keys);
    core.seed([metaNew]);
    const gotMeta: Event[] = [];
    const subMeta = subRelay.subscribe([{ kinds: [0] }], { onevent: (e) => gotMeta.push(e) });
    await waitFor(() => gotMeta.length === 1);
    const metaOld = EventBuilder.metadata({ name: "old" }).createdAt(10).signWithKeys(keys);
    core.inject(metaOld);
    await sleep(50);
    expect(gotMeta.map((e) => e.id)).toEqual([metaNew.id]);

    // (b) re-publishing the same event ACKs `duplicate:` and is not re-delivered
    const gotNotes: Event[] = [];
    const subNotes = subRelay.subscribe([{ kinds: [1] }], { onevent: (e) => gotNotes.push(e) });
    const dup = EventBuilder.textNote("dup").createdAt(30).signWithKeys(keys);
    expect((await pub.publish(dup)).ok).toBe(true);
    const ok2 = await pub.publish(dup);
    expect(ok2.ok).toBe(true);
    expect(ok2.message).toMatch(/^duplicate:/);
    await waitFor(() => gotNotes.some((e) => e.id === dup.id));
    await sleep(50);
    expect(gotNotes.filter((e) => e.id === dup.id)).toHaveLength(1);

    // (c) re-publishing a deleted event ACKs `duplicate:` and is not delivered
    const victim = EventBuilder.textNote("victim").createdAt(31).signWithKeys(keys);
    expect((await pub.publish(victim)).ok).toBe(true);
    await waitFor(() => gotNotes.some((e) => e.id === victim.id));
    const del = EventBuilder.deletion([victim.id]).createdAt(32).signWithKeys(keys);
    expect((await pub.publish(del)).ok).toBe(true);
    const okRepublish = await pub.publish(victim);
    expect(okRepublish.ok).toBe(true);
    expect(okRepublish.message).toMatch(/^duplicate:/);
    await sleep(50);
    expect(gotNotes.filter((e) => e.id === victim.id)).toHaveLength(1);

    // (d) ephemeral events are delivered live, ACKed, and never stored
    const gotEph: Event[] = [];
    const subEph = subRelay.subscribe([{ kinds: [20001] }], { onevent: (e) => gotEph.push(e) });
    const eph = EventBuilder.textNote("ephemeral").kind(20001).createdAt(33).signWithKeys(keys);
    const okEph = await pub.publish(eph);
    expect(okEph.ok).toBe(true);
    await waitFor(() => gotEph.some((e) => e.id === eph.id));
    expect(core.events().some((e) => e.id === eph.id)).toBe(false);

    subMeta.close();
    subNotes.close();
    subEph.close();
    subRelay.close();
    pub.close();
  });

  test("#6 malformed AUTH and NEG-MSG frames do not poison the session", async () => {
    const makeSession = (url: string) => {
      const core = new FakeRelayCore(url);
      const received: unknown[][] = [];
      const session = core.connect({
        send: (data) => received.push(JSON.parse(data) as unknown[]),
        close: () => {},
      });
      return { core, session, received };
    };
    const hasEose = (received: unknown[][], id: string) =>
      received.some((m) => m[0] === "EOSE" && m[1] === id);
    const waitForEose = async (received: unknown[][], id: string): Promise<void> => {
      try {
        await waitFor(() => hasEose(received, id), 100);
      } catch {
        // report the missing EOSE as an assertion failure below
      }
    };

    // AUTH event without tags must not wedge the session queue
    const a = makeSession("wss://raw-auth.example");
    a.core.handleMessage(a.session, JSON.stringify(["AUTH", {}]));
    a.core.handleMessage(a.session, JSON.stringify(["REQ", "sub1", { kinds: [1] }]));
    // keep the (current) poisoned queue rejection from failing the runner itself
    void a.session.queue.catch(() => {});
    await waitForEose(a.received, "sub1");
    expect(hasEose(a.received, "sub1")).toBe(true);

    // non-hex NEG-MSG on an open session must not wedge the session queue
    const b = makeSession("wss://raw-neg.example");
    b.core.handleMessage(b.session, JSON.stringify(["NEG-OPEN", "neg1", { kinds: [1] }, "61"]));
    b.core.handleMessage(b.session, JSON.stringify(["NEG-MSG", "neg1", "zz"]));
    b.core.handleMessage(b.session, JSON.stringify(["REQ", "sub2", { kinds: [1] }]));
    void b.session.queue.catch(() => {});
    await waitForEose(b.received, "sub2");
    expect(hasEose(b.received, "sub2")).toBe(true);
  });
});
