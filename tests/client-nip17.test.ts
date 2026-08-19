import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Kind,
  Keys,
  KeysSigner,
  Nip17Error,
  createRumor,
  dmRelayListEventBuilder,
  finalizeEvent,
  useWebSocketImplementation,
  wrapGift,
} from "../src/index.ts";
import { FakeRelayBus } from "./helpers/fake-relay.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const ALICE_SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const BOB_SK = "0000000000000000000000000000000000000000000000000000000000000001";
const MALLORY_SK = "0000000000000000000000000000000000000000000000000000000000000002";

const IDX = "wss://idx.example";
const ALICE_DM = "wss://alice-dm.example";
const BOB_DM = "wss://bob-dm.example";
const ALICE_OUT = "wss://alice-out.example";

function seedLists(bus: FakeRelayBus, alice: Keys, bob: Keys): void {
  const aliceOut = EventBuilder.relayList([{ url: ALICE_OUT, read: false, write: true }])
    .createdAt(1)
    .signWithKeys(alice);
  const aliceDm = dmRelayListEventBuilder([ALICE_DM]).createdAt(2).signWithKeys(alice);
  const bobDm = dmRelayListEventBuilder([BOB_DM]).createdAt(3).signWithKeys(bob);
  bus.seed(IDX, [aliceOut, aliceDm, bobDm]);
}

describe("Client NIP-17", () => {
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

  test("sendPrivateMessage publishes wraps only to each target's 10050", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);

    const alice = Client.builder()
      .signer(new KeysSigner(aliceKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await alice.connect();

    const sent = await alice.sendPrivateMessage(bobKeys.publicKey, "hola");
    expect(sent.rumor.content).toBe("hola");
    expect(sent.wraps).toHaveLength(2);

    const onBob = bus.eventsOn(BOB_DM).filter((e) => e.kind === Kind.GiftWrap);
    const onAlice = bus.eventsOn(ALICE_DM).filter((e) => e.kind === Kind.GiftWrap);
    expect(onBob).toHaveLength(1);
    expect(onAlice).toHaveLength(1);
    expect(bus.eventsOn(ALICE_OUT).some((e) => e.kind === Kind.GiftWrap)).toBe(false);
    expect(bus.eventsOn(IDX).some((e) => e.kind === Kind.GiftWrap)).toBe(false);

    await alice.shutdown();
  });

  test("missing recipient 10050 throws before any EVENT", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    const aliceDm = dmRelayListEventBuilder([ALICE_DM]).createdAt(2).signWithKeys(aliceKeys);
    bus.seed(IDX, [aliceDm]);

    const alice = Client.builder()
      .signer(new KeysSigner(aliceKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await alice.connect();

    await expect(alice.sendPrivateMessage(bobKeys.publicKey, "hola")).rejects.toThrow(/not ready/);
    expect(bus.eventsOn(ALICE_DM).some((e) => e.kind === Kind.GiftWrap)).toBe(false);
    expect(bus.eventsOn(IDX).some((e) => e.kind === Kind.GiftWrap)).toBe(false);

    await alice.shutdown();
  });

  test("missing sender 10050 throws and does not send to recipient", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    const bobDm = dmRelayListEventBuilder([BOB_DM]).createdAt(3).signWithKeys(bobKeys);
    bus.seed(IDX, [bobDm]);

    const alice = Client.builder()
      .signer(new KeysSigner(aliceKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await alice.connect();

    await expect(alice.sendPrivateMessage(bobKeys.publicKey, "hola")).rejects.toThrow(/not ready/);
    expect(bus.eventsOn(BOB_DM).some((e) => e.kind === Kind.GiftWrap)).toBe(false);

    await alice.shutdown();
  });

  test("fetchPrivateMessages returns the rumor and drops junk and forgery", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    const malloryKeys = Keys.fromSecretKey(MALLORY_SK);
    seedLists(bus, aliceKeys, bobKeys);

    const alice = new KeysSigner(aliceKeys);
    const wrap = await wrapGift(
      alice,
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, {
        kind: Kind.PrivateDirectMessage,
        content: "hola",
        tags: [["p", bobKeys.publicKey]],
        created_at: 10,
      }),
    );
    const junk = finalizeEvent(
      {
        kind: Kind.GiftWrap,
        content: "not-valid-nip44",
        created_at: 11,
        tags: [["p", bobKeys.publicKey]],
      },
      Keys.generate().secretKey,
    );
    const forgedRumor = createRumor(aliceKeys.publicKey, {
      kind: Kind.PrivateDirectMessage,
      content: "i am alice",
    });
    const forged = await wrapGift(new KeysSigner(malloryKeys), bobKeys.publicKey, forgedRumor);
    bus.seed(BOB_DM, [wrap, junk, forged]);

    const bob = Client.builder()
      .signer(new KeysSigner(bobKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();

    const inbox = await bob.fetchPrivateMessages({ timeoutMs: 2000 });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.rumor.content).toBe("hola");
    expect(inbox[0]!.rumor.pubkey).toBe(aliceKeys.publicKey);

    await bob.shutdown();
  });

  test("subscribePrivateMessages delivers a wrap published after subscribe", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);

    const alice = Client.builder()
      .signer(new KeysSigner(aliceKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    const bob = Client.builder()
      .signer(new KeysSigner(bobKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await alice.connect();
    await bob.connect();

    const got: string[] = [];
    const sub = await bob.subscribePrivateMessages({
      onevent: (msg) => {
        got.push(msg.rumor.content);
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    await alice.sendPrivateMessage(bobKeys.publicKey, "live");
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toContain("live");

    sub.close();
    await alice.shutdown();
    await bob.shutdown();
  });

  test("setDmRelays publishes kind 10050 to outbox, not to peer DM relays", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const aliceOut = EventBuilder.relayList([{ url: ALICE_OUT, read: false, write: true }])
      .createdAt(1)
      .signWithKeys(aliceKeys);
    bus.seed(IDX, [aliceOut]);

    const alice = Client.builder()
      .signer(new KeysSigner(aliceKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await alice.connect();
    await alice.hydrateGossip([aliceKeys.publicKey]);

    const results = await alice.setDmRelays([ALICE_DM]);
    expect(results.some((r) => r.result?.ok)).toBe(true);
    expect(bus.eventsOn(ALICE_OUT).some((e) => e.kind === Kind.DirectMessageRelaysList)).toBe(true);
    expect(bus.eventsOn(BOB_DM).some((e) => e.kind === Kind.DirectMessageRelaysList)).toBe(false);
    expect(alice.gossip.dmRelays(aliceKeys.publicKey).some((u) => u.includes("alice-dm"))).toBe(
      true,
    );

    await alice.shutdown();
  });

  test("publish(wrap) without relays never hits default relays", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);

    const alice = Client.builder()
      .signer(new KeysSigner(aliceKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await alice.connect();
    await alice.hydrateGossip([bobKeys.publicKey]);

    const wrap = await wrapGift(
      new KeysSigner(aliceKeys),
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, { kind: 14, content: "x" }),
    );
    await alice.publish(wrap);
    expect(bus.eventsOn(BOB_DM).some((e) => e.id === wrap.id)).toBe(true);
    expect(bus.eventsOn(IDX).some((e) => e.id === wrap.id)).toBe(false);

    alice.gossip.clear();
    const wrap2 = await wrapGift(
      new KeysSigner(aliceKeys),
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, { kind: 14, content: "y" }),
    );
    await expect(alice.publish(wrap2)).rejects.toThrow(Nip17Error);
    await expect(alice.publish(wrap2)).rejects.toThrow(/no kind 10050 in gossip/);
    expect(bus.eventsOn(IDX).some((e) => e.id === wrap2.id)).toBe(false);

    await alice.publish(wrap2, { relays: [IDX] });
    expect(bus.eventsOn(IDX).some((e) => e.id === wrap2.id)).toBe(true);

    await alice.shutdown();
  });

  test("AUTH-gated DM relay accepts wrap after automaticAuth", async () => {
    bus.stop();
    bus = new FakeRelayBus({ authChallenge: "c", requireAuth: true });
    bus.start();

    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);

    const alice = Client.builder()
      .signer(new KeysSigner(aliceKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await alice.connect();
    await alice.hydrateGossip([aliceKeys.publicKey, bobKeys.publicKey]);
    await alice.pool.ensureRelay(ALICE_DM);
    await alice.pool.ensureRelay(BOB_DM);
    await new Promise((r) => setTimeout(r, 40));
    const sent = await alice.sendPrivateMessage(bobKeys.publicKey, "authed");
    expect(sent.wraps.every((w) => w.results.some((r) => r.result?.ok))).toBe(true);

    await alice.shutdown();
  });
});
