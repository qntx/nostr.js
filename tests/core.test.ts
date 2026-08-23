import { expect, test, describe } from "vite-plus/test";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  Kind,
  Keys,
  SecretKey,
  classifyKind,
  createSubscriptionId,
  encodeClientMessage,
  finalizeEvent,
  getEventHash,
  getPublicKey,
  isAddressableKind,
  isEphemeralKind,
  isRegularKind,
  isReplaceableKind,
  matchFilter,
  matchFilters,
  mergeFilters,
  parseClientMessage,
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

  test("catalog includes jumble-used kinds", () => {
    expect(Kind.Highlights).toBe(9802);
    expect(Kind.BlossomServerList).toBe(10063);
    expect(Kind.RelaySets).toBe(30002);
    expect(Kind.FileMessage).toBe(15);
    expect(Kind.ReactionToWebsite).toBe(17);
    expect(Kind.Picture).toBe(20);
    expect(Kind.Video).toBe(21);
    expect(Kind.ShortVideo).toBe(22);
    expect(Kind.ClientKeyAnnouncement).toBe(4454);
    expect(Kind.KeyTransfer).toBe(4455);
    expect(Kind.EncryptionKeyAnnouncement).toBe(10044);
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
});
