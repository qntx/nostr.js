import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  Kind,
  Keys,
  KeysSigner,
  MemoryEventStore,
  relayListEventBuilder,
  finalizeEvent,
  normalizeURL,
  useWebSocketImplementation,
  type Event,
  type EventStore,
  type Filter,
  type PutResult,
} from "../src/index.ts";
import { Nip17Error, dmRelayListEventBuilder } from "../src/nips/nip17.ts";
import { encryptToPubkey } from "../src/nips/nip44.ts";
import { createGiftWrap, createRumor, createSeal, eventToJson, wrap } from "../src/nips/nip59.ts";
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
  const aliceOut = relayListEventBuilder([{ url: ALICE_OUT, read: false, write: true }])
    .createdAt(1)
    .signWithKeys(alice);
  const aliceDm = dmRelayListEventBuilder([ALICE_DM]).createdAt(2).signWithKeys(alice);
  const bobDm = dmRelayListEventBuilder([BOB_DM]).createdAt(3).signWithKeys(bob);
  bus.seed(IDX, [aliceOut, aliceDm, bobDm]);
}

function clientFrames(url: string): unknown[][] {
  const key = normalizeURL(url);
  const frames: unknown[][] = [];
  for (const ws of MockWebSocket.instances) {
    if (normalizeURL(ws.url) !== key) continue;
    for (const raw of ws.sent) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) frames.push(parsed as unknown[]);
    }
  }
  return frames;
}

function reqFilters(url: string): Filter[] {
  const filters: Filter[] = [];
  for (const msg of clientFrames(url)) {
    if (msg[0] !== "REQ") continue;
    for (const item of msg.slice(2)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("REQ filter is not an object");
      }
      filters.push(item as Filter);
    }
  }
  return filters;
}

function giftWrapReqKinds(url: string, recipient: string): number[] {
  const hits = reqFilters(url).filter((f) => {
    const p = f["#p"];
    return Array.isArray(p) && p.includes(recipient);
  });
  if (hits.length === 0) throw new Error(`no REQ with #p ${recipient} on ${url}`);
  const kinds = hits[hits.length - 1]!.kinds;
  if (kinds === undefined) throw new Error("REQ kinds missing");
  return [...kinds];
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

async function waitQuiet(check: () => boolean | Promise<boolean>, timeoutMs = 300): Promise<void> {
  try {
    await waitFor(check, timeoutMs);
  } catch {
    // condition never held
  }
}

function wsFor(url: string): MockWebSocket {
  const key = normalizeURL(url);
  const ws = MockWebSocket.instances.find((w) => normalizeURL(w.url) === key);
  if (!ws) throw new Error(`no websocket for ${url}`);
  return ws;
}

function lastReqId(url: string): string {
  let id: string | undefined;
  for (const msg of clientFrames(url)) {
    if (msg[0] === "REQ" && typeof msg[1] === "string") id = msg[1];
  }
  if (id === undefined) throw new Error(`no REQ on ${url}`);
  return id;
}

function trackingStore(inner = new MemoryEventStore()): {
  store: EventStore;
  persistIds: string[];
} {
  const persistIds: string[] = [];
  const store: EventStore = {
    put: (event) => inner.put(event),
    putMany: async (events) => {
      for (const event of events) persistIds.push(event.id);
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
  return { store, persistIds };
}

async function wrapKind21059(
  sender: KeysSigner,
  senderKeys: Keys,
  recipientPk: string,
  content: string,
): Promise<{ wrap: Event; storedKind: number }> {
  const rumor = createRumor(senderKeys.publicKey, {
    kind: Kind.PrivateDirectMessage,
    content,
    tags: [["p", recipientPk]],
    created_at: 10,
  });
  const seal = await createSeal(sender, recipientPk, rumor);
  const stored = createGiftWrap(seal, recipientPk);
  const ephemeral = Keys.generate();
  const wrap = finalizeEvent(
    {
      kind: Kind.GiftWrapEphemeral,
      content: encryptToPubkey(eventToJson(seal), ephemeral.secretKey.bytes, recipientPk),
      created_at: 1,
      tags: [["p", recipientPk]],
    },
    ephemeral.secretKey,
  );
  return { wrap, storedKind: stored.kind };
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
    expect(sent.wraps.every((w) => w.wrap.kind === Kind.GiftWrap)).toBe(true);
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
    const gift = await wrap(
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
    const forged = await wrap(new KeysSigner(malloryKeys), bobKeys.publicKey, forgedRumor);
    bus.seed(BOB_DM, [gift, junk, forged]);

    const { store, persistIds } = trackingStore();
    const bob = Client.builder()
      .signer(new KeysSigner(bobKeys))
      .storage(store)
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();

    const inbox = await bob.fetchPrivateMessages({ timeoutMs: 2000 });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.rumor.content).toBe("hola");
    expect(inbox[0]!.rumor.pubkey).toBe(aliceKeys.publicKey);
    expect(giftWrapReqKinds(BOB_DM, bobKeys.publicKey)).toEqual([Kind.GiftWrap]);
    await waitFor(() => persistIds.includes(gift.id));
    expect(persistIds.includes(junk.id)).toBe(false);
    expect(persistIds.includes(forged.id)).toBe(false);
    expect(await store.get(junk.id)).toBeUndefined();
    expect(await store.get(forged.id)).toBeUndefined();

    await bob.shutdown();
  });

  test("fetchPrivateMessages REQ kinds are 1059 only and skip seeded 21059", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);

    const alice = new KeysSigner(aliceKeys);
    const gift = await wrap(
      alice,
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, {
        kind: Kind.PrivateDirectMessage,
        content: "stored",
        tags: [["p", bobKeys.publicKey]],
        created_at: 10,
      }),
    );
    const { wrap: ephemeral, storedKind } = await wrapKind21059(
      alice,
      aliceKeys,
      bobKeys.publicKey,
      "not-fetched",
    );
    expect(storedKind).toBe(Kind.GiftWrap);
    expect(ephemeral.kind).toBe(Kind.GiftWrapEphemeral);
    bus.seed(BOB_DM, [gift, ephemeral]);

    const bob = Client.builder()
      .signer(new KeysSigner(bobKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();

    const inbox = await bob.fetchPrivateMessages({ timeoutMs: 2000 });
    expect(giftWrapReqKinds(BOB_DM, bobKeys.publicKey)).toEqual([Kind.GiftWrap]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.wrap.kind).toBe(Kind.GiftWrap);
    expect(inbox[0]!.rumor.content).toBe("stored");
    expect(inbox.some((m) => m.wrap.kind === Kind.GiftWrapEphemeral)).toBe(false);
    expect(inbox.some((m) => m.wrap.id === ephemeral.id)).toBe(false);

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

  test("subscribePrivateMessages REQ kinds include 1059 and 21059", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);

    const bob = Client.builder()
      .signer(new KeysSigner(bobKeys))
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();

    const sub = await bob.subscribePrivateMessages();
    await waitFor(() => reqFilters(BOB_DM).some((f) => Array.isArray(f["#p"])));
    expect(giftWrapReqKinds(BOB_DM, bobKeys.publicKey)).toEqual([
      Kind.GiftWrap,
      Kind.GiftWrapEphemeral,
    ]);

    sub.close();
    await bob.shutdown();
  });

  test("subscribePrivateMessages delivers kind 21059 and does not store it", async () => {
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
    const junk = finalizeEvent(
      {
        kind: Kind.GiftWrapEphemeral,
        content: "not-valid-nip44",
        created_at: 11,
        tags: [["p", bobKeys.publicKey]],
      },
      Keys.generate().secretKey,
    );
    bus.seed(BOB_DM, [junk]);

    await alice.connect();
    await bob.connect();

    const got: Array<{ content: string; kind: number; id: string }> = [];
    let eosed = false;
    const sub = await bob.subscribePrivateMessages({
      onevent: (msg) => {
        got.push({ content: msg.rumor.content, kind: msg.wrap.kind, id: msg.wrap.id });
      },
      oneose: () => {
        eosed = true;
      },
    });
    await waitFor(() => eosed);
    expect(giftWrapReqKinds(BOB_DM, bobKeys.publicKey)).toEqual([
      Kind.GiftWrap,
      Kind.GiftWrapEphemeral,
    ]);

    const sent = await alice.sendPrivateMessage(bobKeys.publicKey, "stored-1059");
    const wrap1059 = sent.wraps.find((w) => w.recipient === bobKeys.publicKey)?.wrap;
    if (!wrap1059) throw new Error("missing 1059 wrap for bob");
    expect(wrap1059.kind).toBe(Kind.GiftWrap);

    const { wrap: wrap21059, storedKind } = await wrapKind21059(
      new KeysSigner(aliceKeys),
      aliceKeys,
      bobKeys.publicKey,
      "live-21059",
    );
    expect(storedKind).toBe(Kind.GiftWrap);
    expect(wrap21059.kind).toBe(Kind.GiftWrapEphemeral);
    await alice.publish(wrap21059);

    await waitFor(() => got.some((m) => m.content === "stored-1059"));
    expect(got.some((m) => m.id === junk.id)).toBe(false);

    await waitFor(() => got.some((m) => m.content === "live-21059"));
    expect(got.map((m) => m.content).sort()).toEqual(["live-21059", "stored-1059"]);
    expect(got.find((m) => m.content === "live-21059")!.kind).toBe(Kind.GiftWrapEphemeral);
    expect(got.find((m) => m.content === "stored-1059")!.kind).toBe(Kind.GiftWrap);

    await waitFor(async () => (await bob.queryLocal({ kinds: [Kind.GiftWrap] })).length > 0);
    const stored1059 = await bob.queryLocal({ kinds: [Kind.GiftWrap] });
    expect(stored1059.some((e) => e.id === wrap1059.id)).toBe(true);
    expect(await bob.queryLocal({ kinds: [Kind.GiftWrapEphemeral] })).toEqual([]);
    expect(await bob.storage.get(wrap21059.id)).toBeUndefined();
    expect(await bob.storage.get(junk.id)).toBeUndefined();

    sub.close();
    await alice.shutdown();
    await bob.shutdown();
  });

  test("subscribePrivateMessages close same turn as deliver skips persist and onevent", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);
    const gift = await wrap(
      new KeysSigner(aliceKeys),
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, {
        kind: Kind.PrivateDirectMessage,
        content: "same-turn",
        tags: [["p", bobKeys.publicKey]],
        created_at: 10,
      }),
    );
    const { store, persistIds } = trackingStore();
    const signer = new KeysSigner(bobKeys);
    let decrypts = 0;
    const origDecrypt = signer.nip44Decrypt.bind(signer);
    signer.nip44Decrypt = async (peer, payload) => {
      decrypts += 1;
      return origDecrypt(peer, payload);
    };
    const bob = Client.builder()
      .signer(signer)
      .storage(store)
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();
    const got: string[] = [];
    const sub = await bob.subscribePrivateMessages({
      onevent: (msg) => {
        got.push(msg.rumor.content);
      },
    });
    await waitFor(() => reqFilters(BOB_DM).some((f) => Array.isArray(f["#p"])));
    wsFor(BOB_DM).receive(JSON.stringify(["EVENT", lastReqId(BOB_DM), gift]));
    sub.close();
    await waitQuiet(() => got.length > 0 || persistIds.includes(gift.id) || decrypts > 0);
    expect(got).toEqual([]);
    expect(persistIds.includes(gift.id)).toBe(false);
    expect(decrypts).toBe(0);
    expect(await store.get(gift.id)).toBeUndefined();
    await bob.shutdown();
  });

  test("subscribePrivateMessages close during decrypt skips persist and onevent", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);
    const gift = await wrap(
      new KeysSigner(aliceKeys),
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, {
        kind: Kind.PrivateDirectMessage,
        content: "during-decrypt",
        tags: [["p", bobKeys.publicKey]],
        created_at: 10,
      }),
    );
    const { store, persistIds } = trackingStore();
    const signer = new KeysSigner(bobKeys);
    const origDecrypt = signer.nip44Decrypt.bind(signer);
    let decryptEntered = 0;
    let decryptFinished = 0;
    let decryptErrors = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    signer.nip44Decrypt = async (peer, payload) => {
      decryptEntered += 1;
      if (decryptEntered === 1) await held;
      try {
        return await origDecrypt(peer, payload);
      } catch (error) {
        decryptErrors += 1;
        throw error;
      } finally {
        decryptFinished += 1;
      }
    };
    const bob = Client.builder()
      .signer(signer)
      .storage(store)
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();
    const got: string[] = [];
    const sub = await bob.subscribePrivateMessages({
      onevent: (msg) => {
        got.push(msg.rumor.content);
      },
    });
    await waitFor(() => reqFilters(BOB_DM).some((f) => Array.isArray(f["#p"])));
    wsFor(BOB_DM).receive(JSON.stringify(["EVENT", lastReqId(BOB_DM), gift]));
    await waitFor(() => decryptEntered === 1);
    sub.close();
    release();
    await waitFor(() => decryptFinished === 2);
    expect(decryptErrors).toBe(0);
    expect(got).toEqual([]);
    expect(persistIds.includes(gift.id)).toBe(false);
    expect(await store.get(gift.id)).toBeUndefined();
    await bob.shutdown();
  });

  test("subscribePrivateMessages abort during decrypt skips persist and onevent", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);
    const gift = await wrap(
      new KeysSigner(aliceKeys),
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, {
        kind: Kind.PrivateDirectMessage,
        content: "abort-decrypt",
        tags: [["p", bobKeys.publicKey]],
        created_at: 10,
      }),
    );
    const { store, persistIds } = trackingStore();
    const signer = new KeysSigner(bobKeys);
    const origDecrypt = signer.nip44Decrypt.bind(signer);
    let decryptEntered = 0;
    let decryptFinished = 0;
    let decryptErrors = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    signer.nip44Decrypt = async (peer, payload) => {
      decryptEntered += 1;
      if (decryptEntered === 1) await held;
      try {
        return await origDecrypt(peer, payload);
      } catch (error) {
        decryptErrors += 1;
        throw error;
      } finally {
        decryptFinished += 1;
      }
    };
    const bob = Client.builder()
      .signer(signer)
      .storage(store)
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();
    const got: string[] = [];
    const ac = new AbortController();
    const sub = await bob.subscribePrivateMessages({
      signal: ac.signal,
      onevent: (msg) => {
        got.push(msg.rumor.content);
      },
    });
    await waitFor(() => reqFilters(BOB_DM).some((f) => Array.isArray(f["#p"])));
    wsFor(BOB_DM).receive(JSON.stringify(["EVENT", lastReqId(BOB_DM), gift]));
    await waitFor(() => decryptEntered === 1);
    ac.abort();
    release();
    await waitFor(() => decryptFinished === 2);
    expect(decryptErrors).toBe(0);
    expect(got).toEqual([]);
    expect(persistIds.includes(gift.id)).toBe(false);
    expect(await store.get(gift.id)).toBeUndefined();
    sub.close();
    await bob.shutdown();
  });

  test("subscribePrivateMessages junk wrap is not stored", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const bobKeys = Keys.fromSecretKey(BOB_SK);
    seedLists(bus, aliceKeys, bobKeys);
    const junk = finalizeEvent(
      {
        kind: Kind.GiftWrap,
        content: "not-valid-nip44",
        created_at: 11,
        tags: [["p", bobKeys.publicKey]],
      },
      Keys.generate().secretKey,
    );
    const { store, persistIds } = trackingStore();
    const bob = Client.builder()
      .signer(new KeysSigner(bobKeys))
      .storage(store)
      .relays([IDX])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    await bob.connect();
    const got: string[] = [];
    const sub = await bob.subscribePrivateMessages({
      onevent: (msg) => {
        got.push(msg.rumor.content);
      },
    });
    await waitFor(() => reqFilters(BOB_DM).some((f) => Array.isArray(f["#p"])));
    wsFor(BOB_DM).receive(JSON.stringify(["EVENT", lastReqId(BOB_DM), junk]));
    await waitQuiet(() => got.length > 0 || persistIds.includes(junk.id));
    expect(got).toEqual([]);
    expect(persistIds.includes(junk.id)).toBe(false);
    expect(await store.get(junk.id)).toBeUndefined();
    sub.close();
    await bob.shutdown();
  });

  test("setDmRelays publishes kind 10050 to outbox, not to peer DM relays", async () => {
    const aliceKeys = Keys.fromSecretKey(ALICE_SK);
    const aliceOut = relayListEventBuilder([{ url: ALICE_OUT, read: false, write: true }])
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

    const gift = await wrap(
      new KeysSigner(aliceKeys),
      bobKeys.publicKey,
      createRumor(aliceKeys.publicKey, { kind: 14, content: "x" }),
    );
    await alice.publish(gift);
    expect(bus.eventsOn(BOB_DM).some((e) => e.id === gift.id)).toBe(true);
    expect(bus.eventsOn(IDX).some((e) => e.id === gift.id)).toBe(false);

    alice.gossip.clear();
    const wrap2 = await wrap(
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
