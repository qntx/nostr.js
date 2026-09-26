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
