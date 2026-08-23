import { describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  EventValidationError,
  Keys,
  KeysSigner,
  Kind,
  verifyEvent,
} from "../src/index.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

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

  test("metadata / deletion / reaction factories", () => {
    const keys = Keys.fromSecretKey(SK);
    const meta = EventBuilder.metadata({ name: "alice" }).signWithKeys(keys);
    expect(meta.kind).toBe(Kind.Metadata);
    expect(JSON.parse(meta.content).name).toBe("alice");

    const del = EventBuilder.deletion([meta.id], "spam").signWithKeys(keys);
    expect(del.kind).toBe(Kind.EventDeletion);
    expect(del.tags[0]).toEqual(["e", meta.id]);

    const react = EventBuilder.reaction(meta.id, "+", {
      author: meta.pubkey,
      kind: 0,
    }).signWithKeys(keys);
    expect(react.kind).toBe(Kind.Reaction);
    expect(react.content).toBe("+");
  });

  test("genericRepost kind 20 embeds JSON and omits a", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(Kind.Picture, "img").createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target);

    expect(draft.currentKind).toBe(Kind.GenericRepost);
    expect(draft.currentTags.find((t) => t[0] === "e")).toEqual(["e", target.id]);
    expect(draft.currentTags).toContainEqual(["p", target.pubkey]);
    expect(draft.currentTags).toContainEqual(["k", "20"]);
    expect(draft.currentTags.some((t) => t[0] === "a")).toBe(false);
    expect(JSON.parse(draft.currentContent).id).toBe(target.id);
  });

  test("genericRepost relayHint is e tag relay URL", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(Kind.Picture, "img").createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target, { relayHint: "wss://r" });
    expect(draft.currentTags.find((t) => t[0] === "e")).toEqual(["e", target.id, "wss://r"]);
  });

  test("genericRepost kind 0 uses empty a identifier and empty content", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.metadata({ name: "alice" }).createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target);
    expect(draft.currentContent).toBe("");
    expect(draft.currentTags).toContainEqual(["a", `0:${target.pubkey}:`]);
    expect(draft.currentTags).toContainEqual(["k", "0"]);
  });

  test("genericRepost addressable without d throws", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = new EventBuilder(Kind.AddressableVideo, "v").createdAt(1).signWithKeys(keys);
    expect(() => EventBuilder.genericRepost(target)).toThrow(EventValidationError);
  });

  test("genericRepost NIP-70 protected event has empty content", () => {
    const keys = Keys.fromSecretKey(SK);
    const target = EventBuilder.textNote("secret").tag(["-"]).createdAt(1).signWithKeys(keys);
    const draft = EventBuilder.genericRepost(target);
    expect(draft.currentContent).toBe("");
    expect(draft.currentKind).toBe(Kind.GenericRepost);
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
    const event = EventBuilder.relayList([
      { url: "wss://a.example" },
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
