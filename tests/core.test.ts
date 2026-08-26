import { expect, test, describe } from "vite-plus/test";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  Kind,
  Keys,
  MessageError,
  SUBSCRIPTION_ID_MAX_CHARS,
  SecretKey,
  assertSubscriptionId,
  classifyKind,
  createSubscriptionId,
  eventAddress,
  formatEventAddress,
  encodeClientMessage,
  finalizeEvent,
  getEventHash,
  getPublicKey,
  isAddressableKind,
  isEphemeralKind,
  isRegularKind,
  isReplaceableKind,
  filterFingerprint,
  matchFilter,
  matchFilters,
  mergeFilters,
  parseClientMessage,
  parseEventAddress,
  parseRelayMessage,
  serializeEvent,
  validateEvent,
  verifyEvent,
  type Event,
  type Filter,
} from "../src/index.ts";

const SK_HEX = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

describe("keys", () => {
  test("generate secret key as 32 bytes / 64 hex", () => {
    const sk = SecretKey.generate();
    expect(sk.bytes.length).toBe(32);
    expect(sk.toHex()).toMatch(/^[0-9a-f]{64}$/);
    sk.zeroize();
  });

  test("public key is deterministic", () => {
    const sk = SecretKey.fromHex(SK_HEX);
    const pk = getPublicKey(sk);
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(sk)).toBe(pk);
    expect(getPublicKey(SK_HEX)).toBe(pk);
  });

  test("Keys.generate produces matching pair", () => {
    const keys = Keys.generate();
    expect(getPublicKey(keys.secretKey)).toBe(keys.publicKey);
  });
});

describe("events", () => {
  test("finalizeEvent signs a text note that verifies", () => {
    const event = finalizeEvent(
      {
        kind: Kind.TextNote,
        tags: [],
        content: "Hello, world!",
        created_at: 1617932115,
      },
      SK_HEX,
    );

    expect(event.pubkey).toBe(getPublicKey(SK_HEX));
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEvent(event)).toBe(true);
    // WeakSet cache path
    expect(verifyEvent(event)).toBe(true);
  });

  test("validateEvent rejects kind outside 0..65535", () => {
    const pubkey = getPublicKey(SK_HEX);
    expect(
      validateEvent({
        kind: 65536,
        tags: [],
        content: "",
        created_at: 1,
        pubkey,
      }),
    ).toBe(false);
    expect(
      validateEvent({
        kind: -1,
        tags: [],
        content: "",
        created_at: 1,
        pubkey,
      }),
    ).toBe(false);
  });

  test("serializeEvent matches NIP-01 array form", () => {
    const pubkey = getPublicKey(SK_HEX);
    const unsigned = {
      kind: Kind.TextNote,
      tags: [] as [],
      content: "Hello, world!",
      created_at: 1617932115,
      pubkey,
    };
    expect(serializeEvent(unsigned)).toBe(
      JSON.stringify([0, pubkey, 1617932115, Kind.TextNote, [], "Hello, world!"]),
    );
    expect(getEventHash(unsigned)).toHaveLength(64);
  });

  test("validateEvent rejects bad shapes", () => {
    expect(validateEvent("")).toBe(false);
    expect(validateEvent({})).toBe(false);
    expect(
      validateEvent({
        kind: 1,
        tags: [],
        content: "hi",
        created_at: 1,
        pubkey: "not-hex",
      }),
    ).toBe(false);
  });

  test("tampered content fails verify", () => {
    const event = finalizeEvent(
      {
        kind: Kind.TextNote,
        tags: [],
        content: "original",
        created_at: 1617932115,
      },
      SK_HEX,
    );
    const bad: Event = { ...event, content: "tampered" };
    expect(verifyEvent(bad)).toBe(false);
  });
});

describe("kinds", () => {
  test("classification ranges", () => {
    expect(isRegularKind(1)).toBe(true);
    expect(isRegularKind(7)).toBe(true);
    expect(isRegularKind(1111)).toBe(true);
    expect(isRegularKind(45)).toBe(false);
    expect(isRegularKind(999)).toBe(false);
    expect(classifyKind(45)).toBe("unknown");
    expect(isReplaceableKind(0)).toBe(true);
    expect(isReplaceableKind(10002)).toBe(true);
    expect(isEphemeralKind(22242)).toBe(true);
    expect(isAddressableKind(30023)).toBe(true);
    expect(classifyKind(1)).toBe("regular");
    expect(classifyKind(30023)).toBe("addressable");
  });

  test("catalog is the 28 production names", () => {
    expect(Kind).toEqual({
      Metadata: 0,
      TextNote: 1,
      Contacts: 3,
      EventDeletion: 5,
      Repost: 6,
      Reaction: 7,
      Seal: 13,
      PrivateDirectMessage: 14,
      GenericRepost: 16,
      GiftWrap: 1059,
      ZapRequest: 9734,
      Zap: 9735,
      MuteList: 10000,
      PinList: 10001,
      RelayList: 10002,
      BookmarkList: 10003,
      FavoriteRelays: 10012,
      UserEmojiList: 10030,
      DirectMessageRelaysList: 10050,
      BlossomServerList: 10063,
      GiftWrapEphemeral: 21059,
      ClientAuth: 22242,
      NostrConnect: 24133,
      BlobsAuth: 24242,
      HttpAuth: 27235,
      RelaySets: 30002,
      EmojiSet: 30030,
      StarterPack: 39089,
    });
    expect(Object.keys(Kind)).toHaveLength(28);
    expect("EncryptionKeyAnnouncement" in Kind).toBe(false);
    expect("ClientKeyAnnouncement" in Kind).toBe(false);
    expect("KeyTransfer" in Kind).toBe(false);
  });

  test("event address coordinates", () => {
    const pk = "aa".repeat(32);
    expect(parseEventAddress(`30023:${pk}:hello:world`)).toEqual({
      kind: 30023,
      pubkey: pk,
      identifier: "hello:world",
    });
    expect(parseEventAddress(`0:${pk}:`)).toEqual({ kind: 0, pubkey: pk, identifier: "" });
    expect(parseEventAddress("0:short:")).toBeUndefined();
    expect(formatEventAddress(0, pk)).toBe(`0:${pk}:`);
    expect(eventAddress({ kind: 1, pubkey: pk, tags: [] })).toBeUndefined();
    expect(eventAddress({ kind: 0, pubkey: pk, tags: [] })).toBe(`0:${pk}:`);
    expect(eventAddress({ kind: 30023, pubkey: pk, tags: [["d", "x"]] })).toBe(`30023:${pk}:x`);
  });
});

describe("filter", () => {
  const base = finalizeEvent(
    {
      kind: 1,
      tags: [
        ["t", "nostr"],
        ["p", "abc"],
      ],
      content: "x",
      created_at: 150,
    },
    SK_HEX,
  );

  test("matchFilter positive and negative", () => {
    expect(matchFilter({ kinds: [1], since: 100, until: 200 }, base)).toBe(true);
    expect(matchFilter({ kinds: [2] }, base)).toBe(false);
    expect(matchFilter({ since: 200 }, base)).toBe(false);
    expect(matchFilter({ "#t": ["nostr"] }, base)).toBe(true);
    expect(matchFilter({ "#t": ["other"] }, base)).toBe(false);
    expect(matchFilter({ authors: [base.pubkey.toUpperCase()] }, base)).toBe(true);
    expect(matchFilter({ ids: [base.id.toUpperCase()] }, base)).toBe(true);
  });

  test("matchFilter ignores NIP-50 search", () => {
    expect(matchFilter({ search: "nope" }, base)).toBe(true);
    expect(matchFilter({ kinds: [1], search: "nope" }, base)).toBe(true);
    expect(matchFilter({ kinds: [2], search: "nope" }, base)).toBe(false);
  });

  test("matchFilters is OR across filters", () => {
    expect(matchFilters([{ kinds: [2] }, { kinds: [1] }], base)).toBe(true);
    expect(matchFilters([{ kinds: [2] }, { kinds: [3] }], base)).toBe(false);
  });

  test("mergeFilters unions list fields", () => {
    const merged = mergeFilters({ kinds: [1], authors: ["a"] }, { kinds: [2], authors: ["b"] });
    expect([...(merged.kinds ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...(merged.authors ?? [])].sort((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  test("filterFingerprint sorts keys, list items, and filter order", () => {
    const pk = "aa".repeat(32);
    expect(filterFingerprint([{ kinds: [1], authors: [pk] }])).toBe(
      filterFingerprint([{ authors: [pk], kinds: [1] }]),
    );
    expect(filterFingerprint([{ kinds: [2, 1] }])).toBe(filterFingerprint([{ kinds: [1, 2] }]));
    expect(filterFingerprint([{ kinds: [1] }, { kinds: [2] }])).toBe(
      filterFingerprint([{ kinds: [2] }, { kinds: [1] }]),
    );
  });

  test("filterFingerprint lowercases hex ids/authors/#e/#p and preserves #t case", () => {
    const id = "ab".repeat(32);
    const pk = "cd".repeat(32);
    expect(filterFingerprint([{ ids: [id.toUpperCase()] }])).toBe(
      filterFingerprint([{ ids: [id] }]),
    );
    expect(filterFingerprint([{ authors: [pk.toUpperCase()] }])).toBe(
      filterFingerprint([{ authors: [pk] }]),
    );
    expect(filterFingerprint([{ "#e": [id.toUpperCase()] }])).toBe(
      filterFingerprint([{ "#e": [id] }]),
    );
    expect(filterFingerprint([{ "#p": [pk.toUpperCase()] }])).toBe(
      filterFingerprint([{ "#p": [pk] }]),
    );
    expect(filterFingerprint([{ "#t": ["b", "a"] }])).toBe(
      filterFingerprint([{ "#t": ["a", "b"] }]),
    );
    expect(filterFingerprint([{ "#t": ["Nostr"] }])).not.toBe(
      filterFingerprint([{ "#t": ["nostr"] }]),
    );
  });

  test("filterFingerprint includes since/until/limit/search; missing key is not []", () => {
    expect(filterFingerprint([{ kinds: [1], limit: 10 }])).not.toBe(
      filterFingerprint([{ kinds: [1], limit: 50 }]),
    );
    expect(filterFingerprint([{ kinds: [1], since: 1 }])).not.toBe(
      filterFingerprint([{ kinds: [1] }]),
    );
    expect(filterFingerprint([{ kinds: [1], until: 1 }])).not.toBe(
      filterFingerprint([{ kinds: [1] }]),
    );
    expect(filterFingerprint([{ search: "x" }])).not.toBe(filterFingerprint([{ search: "X" }]));
    expect(filterFingerprint([{ kinds: [1] }])).not.toBe(
      filterFingerprint([{ kinds: [1], authors: [] }]),
    );
    expect(filterFingerprint([{ kinds: [1] }])).not.toBe(
      filterFingerprint([{ kinds: [1], "#t": [] }]),
    );
    expect(filterFingerprint([{ kinds: [1] }])).not.toBe(filterFingerprint([{ kinds: [1, 2] }]));
  });
});

describe("messages", () => {
  test("encode and parse EVENT client message", () => {
    const event = finalizeEvent(
      { kind: 1, tags: [], content: "hi", created_at: 1 },
      hexToBytes(SK_HEX),
    );
    const raw = encodeClientMessage(["EVENT", event]);
    const parsed = parseClientMessage(raw);
    expect(parsed[0]).toBe("EVENT");
    if (parsed[0] === "EVENT") {
      expect(parsed[1].id).toBe(event.id);
    }
  });

  test("parse relay EVENT / EOSE / OK", () => {
    const event = finalizeEvent({ kind: 1, tags: [], content: "hi", created_at: 1 }, SK_HEX);
    const sub = createSubscriptionId("sub1");
    const eventMsg = parseRelayMessage(JSON.stringify(["EVENT", sub, event]));
    expect(eventMsg[0]).toBe("EVENT");
    expect(parseRelayMessage(JSON.stringify(["EOSE", sub]))[0]).toBe("EOSE");
    expect(parseRelayMessage(JSON.stringify(["OK", event.id, true, ""]))[0]).toBe("OK");
  });

  test("REQ round-trip", () => {
    const filter: Filter = { kinds: [1], limit: 10 };
    const raw = encodeClientMessage(["REQ", "abc", filter]);
    const msg = parseClientMessage(raw);
    expect(msg[0]).toBe("REQ");
  });

  test("assertSubscriptionId accepts 1..max and rejects empty/too long", () => {
    expect(assertSubscriptionId("a")).toBe("a");
    expect(assertSubscriptionId("x".repeat(SUBSCRIPTION_ID_MAX_CHARS))).toBe(
      "x".repeat(SUBSCRIPTION_ID_MAX_CHARS),
    );
    expect(() => assertSubscriptionId("")).toThrow(MessageError);
    expect(() => assertSubscriptionId("")).toThrow(/1\.\./);
    expect(() => assertSubscriptionId("x".repeat(SUBSCRIPTION_ID_MAX_CHARS + 1))).toThrow(
      MessageError,
    );
    expect(() => assertSubscriptionId("x".repeat(SUBSCRIPTION_ID_MAX_CHARS + 1))).toThrow(/1\.\./);
  });

  test("createSubscriptionId validates or generates 8-byte hex", () => {
    expect(createSubscriptionId("sub1")).toBe("sub1");
    expect(() => createSubscriptionId("")).toThrow(MessageError);
    expect(() => createSubscriptionId("x".repeat(SUBSCRIPTION_ID_MAX_CHARS + 1))).toThrow(
      MessageError,
    );
    const generated = createSubscriptionId();
    expect(generated).toMatch(/^[0-9a-f]{16}$/);
    expect(generated).not.toBe(createSubscriptionId());
  });
});
