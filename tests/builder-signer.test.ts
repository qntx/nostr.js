import { describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  EventValidationError,
  Keys,
  KeysSigner,
  Kind,
  UrlError,
  normalizeURL,
  relayListEventBuilder,
  verifyEvent,
} from "../src/index.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const RELAY = "wss://r.example/nostr";
const RELAY_HINT = { relayHint: RELAY };

describe("EventBuilder", () => {
  test("textNote signs with Keys", () => {
    const keys = Keys.fromSecretKey(SK);
    const event = EventBuilder.textNote("hello")
      .tag(["t", "nostr"])
      .createdAt(1_700_000_000)
      .signWithKeys(keys);

    expect(event.kind).toBe(Kind.TextNote);
    expect(event.content).toBe("hello");
    expect(event.tags).toEqual([["t", "nostr"]]);
    expect(event.created_at).toBe(1_700_000_000);
    expect(event.pubkey).toBe(keys.publicKey);
    expect(verifyEvent(event)).toBe(true);
  });

  test("metadata / deletion factories", () => {
    const keys = Keys.fromSecretKey(SK);
    const meta = EventBuilder.metadata({ name: "alice" }).signWithKeys(keys);
    expect(meta.kind).toBe(Kind.Metadata);
    expect(JSON.parse(meta.content).name).toBe("alice");

    const del = EventBuilder.deletion([meta.id], "spam").signWithKeys(keys);
    expect(del.kind).toBe(Kind.EventDeletion);
    expect(del.tags[0]).toEqual(["e", meta.id]);
  });

  test("repost NIP-70 empty content and required normalized relay URL", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    const protectedTarget = EventBuilder.textNote("p").tag(["-"]).createdAt(1).signWithKeys(keys);
    expect(EventBuilder.repost(protectedTarget, RELAY_HINT).currentContent).toBe("");
    expect(JSON.parse(EventBuilder.repost(target, RELAY_HINT).currentContent).id).toBe(target.id);
    expect(EventBuilder.repost(target, RELAY_HINT).currentTags.find((t) => t[0] === "e")).toEqual([
      "e",
      target.id,
      RELAY,
    ]);
    expect(EventBuilder.repost(target, RELAY_HINT).currentTags).toContainEqual([
      "p",
      target.pubkey,
    ]);
  });

  test("repost missing or empty relayHint throws EventValidationError", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.repost(target, { relayHint: "" })).toThrow(EventValidationError);
    expect(() => EventBuilder.repost(target, { relayHint: "" })).toThrow(
      /relayHint must be a relay URL/,
    );
    expect(() => EventBuilder.repost(target, {} as { relayHint: string })).toThrow(
      EventValidationError,
    );
  });

  test("repost invalid relayHint throws UrlError", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.repost(target, { relayHint: "not a url" })).toThrow(UrlError);
    expect(() => EventBuilder.repost(target, { relayHint: ":" })).toThrow(UrlError);
  });

  test("repost host-only and http relayHint emit normalizeURL", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    expect(
      EventBuilder.repost(target, { relayHint: "relay.example" }).currentTags.find(
        (t) => t[0] === "e",
      ),
    ).toEqual(["e", target.id, normalizeURL("relay.example")]);
    expect(
      EventBuilder.repost(target, { relayHint: "https://r.example/path/" }).currentTags.find(
        (t) => t[0] === "e",
      ),
    ).toEqual(["e", target.id, normalizeURL("https://r.example/path/")]);
  });

  test("repost rejects non-kind-1", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(Kind.Reaction, "+").createdAt(1).signWithKeys(keys);
    expect(target.kind).toBe(Kind.Reaction);
    expect(() => EventBuilder.repost(target, RELAY_HINT)).toThrow(EventValidationError);
    expect(() => EventBuilder.repost(target, RELAY_HINT)).toThrow(/genericRepost/);
  });

  test("genericRepost rejects kind 1", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.genericRepost(target, RELAY_HINT)).toThrow(EventValidationError);
    expect(() => EventBuilder.genericRepost(target, RELAY_HINT)).toThrow(
      /kind 1 uses EventBuilder.repost/,
    );
  });

  test("genericRepost kind 20 embeds JSON, omits a, and requires relay URL", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(20, "img").createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target, RELAY_HINT);

    expect(draft.currentKind).toBe(Kind.GenericRepost);
    expect(draft.currentTags.find((t) => t[0] === "e")).toEqual(["e", target.id, RELAY]);
    expect(draft.currentTags).toContainEqual(["p", target.pubkey]);
    expect(draft.currentTags).toContainEqual(["k", "20"]);
    expect(draft.currentTags.some((t) => t[0] === "a")).toBe(false);
    expect(JSON.parse(draft.currentContent).id).toBe(target.id);
  });

  test("genericRepost missing or empty relayHint throws EventValidationError", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(20, "img").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.genericRepost(target, { relayHint: "" })).toThrow(
      EventValidationError,
    );
    expect(() => EventBuilder.genericRepost(target, { relayHint: "" })).toThrow(
      /relayHint must be a relay URL/,
    );
    expect(() => EventBuilder.genericRepost(target, {} as { relayHint: string })).toThrow(
      EventValidationError,
    );
  });

  test("genericRepost invalid relayHint throws UrlError", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(20, "img").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.genericRepost(target, { relayHint: "not a url" })).toThrow(UrlError);
  });

  test("genericRepost kind 0 uses empty a identifier and empty content", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.metadata({ name: "alice" }).createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target, RELAY_HINT);
    expect(draft.currentContent).toBe("");
    expect(draft.currentTags).toContainEqual(["a", `0:${target.pubkey}:`]);
    expect(draft.currentTags).toContainEqual(["k", "0"]);
    expect(draft.currentTags.find((t) => t[0] === "e")).toEqual(["e", target.id, RELAY]);
  });

  test("genericRepost addressable without d throws", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(34235, "v").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.genericRepost(target, RELAY_HINT)).toThrow(EventValidationError);
    expect(() => EventBuilder.genericRepost(target, RELAY_HINT)).toThrow(/missing d tag/);
  });

  test("genericRepost addressable with d emits a and empty content", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(34235, "v").tag(["d", "ep1"]).createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target, RELAY_HINT);
    expect(draft.currentContent).toBe("");
    expect(draft.currentTags).toContainEqual(["a", `34235:${target.pubkey}:ep1`]);
    expect(draft.currentTags.find((t) => t[0] === "e")).toEqual(["e", target.id, RELAY]);
  });

  test("genericRepost NIP-70 protected event has empty content", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(20, "secret").tag(["-"]).createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target, RELAY_HINT);
    expect(draft.currentContent).toBe("");
    expect(draft.currentKind).toBe(Kind.GenericRepost);
  });

  test("reaction(Event) emits e/p/k; pubkey sits fourth when hint omitted", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    const react = EventBuilder.reaction(target).signWithKeys(keys);
    expect(react.kind).toBe(Kind.Reaction);
    expect(react.content).toBe("+");
    expect(react.tags).toEqual([
      ["e", target.id, "", target.pubkey],
      ["p", target.pubkey],
      ["k", "1"],
    ]);
  });

  test("reaction custom content and normalized relayHint on e and p", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    const raw = "https://r.example/path/";
    const hint = normalizeURL(raw);
    const draft = EventBuilder.reaction(target, "-", { relayHint: raw });
    expect(draft.currentContent).toBe("-");
    expect(draft.currentTags).toEqual([
      ["e", target.id, hint, target.pubkey],
      ["p", target.pubkey, hint],
      ["k", "1"],
    ]);
  });

  test("reaction kind 0 metadata has no a tag", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.metadata({ name: "alice" }).createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.reaction(target);
    expect(draft.currentTags.some((t) => t[0] === "a")).toBe(false);
    expect(draft.currentTags).toContainEqual(["k", "0"]);
    expect(draft.currentTags.find((t) => t[0] === "e")).toEqual([
      "e",
      target.id,
      "",
      target.pubkey,
    ]);
  });

  test("reaction addressable emits a; hint is third on e/p/a", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(34235, "v").tag(["d", "ep1"]).createdAt(1).signWithKeys(keys);
    const withHint = EventBuilder.reaction(target, "+", RELAY_HINT);
    expect(withHint.currentTags).toEqual([
      ["e", target.id, RELAY, target.pubkey],
      ["p", target.pubkey, RELAY],
      ["k", "34235"],
      ["a", `34235:${target.pubkey}:ep1`, RELAY],
    ]);
    const noHint = EventBuilder.reaction(target);
    expect(noHint.currentTags).toEqual([
      ["e", target.id, "", target.pubkey],
      ["p", target.pubkey],
      ["k", "34235"],
      ["a", `34235:${target.pubkey}:ep1`],
    ]);
  });

  test("reaction addressable without d throws", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(34235, "v").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.reaction(target)).toThrow(EventValidationError);
    expect(() => EventBuilder.reaction(target)).toThrow(/missing d tag/);
  });

  test("reaction addressable with empty d emits a", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(34235, "v").tag(["d", ""]).createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.reaction(target);
    expect(draft.currentTags).toEqual([
      ["e", target.id, "", target.pubkey],
      ["p", target.pubkey],
      ["k", "34235"],
      ["a", `34235:${target.pubkey}:`],
    ]);
  });

  test("reaction empty relayHint throws EventValidationError", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.reaction(target, "+", { relayHint: "" })).toThrow(
      EventValidationError,
    );
  });

  test("reaction invalid relayHint throws UrlError", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("n").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.reaction(target, "+", { relayHint: "not a url" })).toThrow(UrlError);
  });

  test("deletion k tags with e", () => {
    const del = EventBuilder.deletion(["id"], "x", { kinds: [1] });
    expect(del.currentKind).toBe(Kind.EventDeletion);
    expect(del.currentContent).toBe("x");
    expect(del.currentTags).toEqual([
      ["e", "id"],
      ["k", "1"],
    ]);
  });

  test("deletion empty ids with a and k", () => {
    const del = EventBuilder.deletion([], "gone", { kinds: [0], addresses: ["0:pk:"] });
    expect(del.currentContent).toBe("gone");
    expect(del.currentTags).toEqual([
      ["k", "0"],
      ["a", "0:pk:"],
    ]);
    expect(del.currentTags.some((t) => t[0] === "e")).toBe(false);
  });

  test("relayList markers", () => {
    const keys = Keys.fromSecretKey(SK);
    const event = relayListEventBuilder([
      { url: "wss://a.example", read: true, write: true },
      { url: "wss://b.example", read: true, write: false },
      { url: "wss://c.example", read: false, write: true },
    ]).signWithKeys(keys);
    expect(event.kind).toBe(Kind.RelayList);
    expect(event.tags).toEqual([
      ["r", "wss://a.example"],
      ["r", "wss://b.example", "read"],
      ["r", "wss://c.example", "write"],
    ]);
  });
});

describe("KeysSigner", () => {
  test("async sign path matches EventBuilder.sign", async () => {
    const signer = new KeysSigner(SK);
    const pk = await signer.getPublicKey();
    const event = await EventBuilder.textNote("via signer").createdAt(1).sign(signer);
    expect(event.pubkey).toBe(pk);
    expect(verifyEvent(event)).toBe(true);
  });

  test("rejects pubkey mismatch", async () => {
    const signer = new KeysSigner(SK);
    const other = Keys.generate();
    await expect(
      signer.signEvent({
        kind: 1,
        tags: [],
        content: "x",
        created_at: 1,
        pubkey: other.publicKey,
      }),
    ).rejects.toThrow(/pubkey/);
  });
});
