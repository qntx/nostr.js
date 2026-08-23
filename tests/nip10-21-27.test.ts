import { describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  buildReplyTags,
  eTag,
  isNostrURI,
  npubEncode,
  nsecEncode,
  noteEncode,
  parseContentBlocks,
  parseNostrURI,
  parseThreadTags,
  replyTo,
} from "../src/index.ts";

const keysA = Keys.generate();
const keysB = Keys.generate();

function signedNote(keys: Keys, content: string, tags: string[][] = []) {
  return EventBuilder.textNote(content).tags(tags).signWithKeys(keys);
}

describe("nip10", () => {
  test("parseThreadTags reads marked root/reply", () => {
    const rootId = "aa".repeat(32);
    const replyId = "bb".repeat(32);
    const author = keysA.publicKey;
    const event = signedNote(keysB, "reply", [
      ["e", rootId, "wss://root.example", "root", author],
      ["e", replyId, "wss://reply.example", "reply", author],
      ["p", author, "wss://author.example"],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.root?.id).toBe(rootId);
    expect(thread.root?.relays).toEqual(
      expect.arrayContaining(["wss://root.example", "wss://author.example"]),
    );
    expect(thread.root?.author).toBe(author);
    expect(thread.reply?.id).toBe(replyId);
    expect(thread.reply?.relays).toEqual(
      expect.arrayContaining(["wss://reply.example", "wss://author.example"]),
    );
    expect(thread.mentions).toEqual([]);
    expect(thread.profiles[0]?.pubkey).toBe(author);
  });

  test("parseThreadTags legacy positional e-tags", () => {
    const rootId = "11".repeat(32);
    const parentId = "22".repeat(32);
    const event = signedNote(keysA, "legacy", [
      ["e", rootId],
      ["e", parentId],
      ["p", keysB.publicKey],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.root?.id).toBe(rootId);
    expect(thread.reply?.id).toBe(parentId);
    expect(thread.mentions).toEqual([]);
  });

  test("parseThreadTags quotes and mentions", () => {
    const rootId = "33".repeat(32);
    const mentionId = "44".repeat(32);
    const quoteId = "55".repeat(32);
    const event = signedNote(keysA, "q", [
      ["e", rootId, "", "root"],
      ["e", mentionId, "", "mention"],
      ["q", quoteId, "wss://quote.example"],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.root?.id).toBe(rootId);
    expect(thread.mentions.map((m) => m.id)).toEqual([mentionId]);
    expect(thread.reply?.id).toBe(rootId);
    expect(thread.quotes).toEqual([{ id: quoteId, relays: ["wss://quote.example"] }]);
  });

  test("parseThreadTags lone mention-marked e is extras not reply", () => {
    const mentionId = "77".repeat(32);
    const event = signedNote(keysA, "mention only", [["e", mentionId, "", "mention"]]);

    const thread = parseThreadTags(event);
    expect(thread.root).toBeUndefined();
    expect(thread.reply).toBeUndefined();
    expect(thread.mentions.map((m) => m.id)).toEqual([mentionId]);
  });

  test("parseThreadTags unknown e markers are mentions only", () => {
    const extraId = "88".repeat(32);
    const event = signedNote(keysA, "unknown marker", [["e", extraId, "", "fork"]]);

    const thread = parseThreadTags(event);
    expect(thread.root).toBeUndefined();
    expect(thread.reply).toBeUndefined();
    expect(thread.mentions.map((m) => m.id)).toEqual([extraId]);
  });

  test("parseThreadTags single unmarked e is positional reply", () => {
    const parentId = "12".repeat(32);
    const event = signedNote(keysA, "one e", [["e", parentId]]);

    const thread = parseThreadTags(event);
    expect(thread.root?.id).toBe(parentId);
    expect(thread.reply?.id).toBe(parentId);
    expect(thread.mentions).toEqual([]);
  });

  test("parseThreadTags empty marker is positional unmarked", () => {
    const rootId = "99".repeat(32);
    const parentId = "ab".repeat(32);
    const event = signedNote(keysA, "empty marker", [
      ["e", rootId, "", ""],
      ["e", parentId, "", ""],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.root?.id).toBe(rootId);
    expect(thread.reply?.id).toBe(parentId);
    expect(thread.mentions).toEqual([]);
  });

  test("parseThreadTags NIP-01 e 4-tuple is positional with author", () => {
    const parentId = "a1".repeat(32);
    const author = keysB.publicKey;
    const event = signedNote(keysA, "nip01 e", [
      ["e", parentId, "wss://relay.example", author.toUpperCase()],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.root?.id).toBe(parentId);
    expect(thread.reply?.id).toBe(parentId);
    expect(thread.root?.author).toBe(author);
    expect(thread.reply?.author).toBe(author);
    expect(thread.root?.relays).toEqual(["wss://relay.example"]);
    expect(thread.mentions).toEqual([]);
  });

  test("parseThreadTags unknown marker does not fill positional root/reply", () => {
    const extraId = "cd".repeat(32);
    const parentId = "ef".repeat(32);
    const event = signedNote(keysA, "mixed", [
      ["e", extraId, "", "mention"],
      ["e", parentId],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.root?.id).toBe(parentId);
    expect(thread.reply?.id).toBe(parentId);
    expect(thread.mentions.map((m) => m.id)).toEqual([extraId]);
  });

  test("buildReplyTags for root parent", () => {
    const parent = signedNote(keysA, "root note");
    const tags = buildReplyTags({ parent, relayHint: "wss://r.example" });
    const eTags = tags.filter((t) => t[0] === "e");
    const pTags = tags.filter((t) => t[0] === "p");

    expect(eTags).toHaveLength(1);
    expect(eTags[0]).toEqual(["e", parent.id, "wss://r.example", "root", parent.pubkey]);
    expect(pTags.some((t) => t[1] === parent.pubkey)).toBe(true);
  });

  test("buildReplyTags for nested reply", () => {
    const root = signedNote(keysA, "root");
    const parent = signedNote(keysB, "child", [
      ["e", root.id, "wss://root.example", "root", root.pubkey],
      ["p", root.pubkey],
    ]);

    const tags = buildReplyTags({
      parent,
      relayHint: "wss://parent.example",
      quoteIds: ["66".repeat(32)],
    });
    const eTags = tags.filter((t) => t[0] === "e");
    const qTags = tags.filter((t) => t[0] === "q");

    expect(eTags.find((t) => t[3] === "root")?.[1]).toBe(root.id);
    expect(eTags.find((t) => t[3] === "reply")).toEqual([
      "e",
      parent.id,
      "wss://parent.example",
      "reply",
      parent.pubkey,
    ]);
    expect(eTags.some((t) => t[3] === "mention")).toBe(false);
    expect(qTags).toEqual([["q", "66".repeat(32)]]);
  });

  test("eTag and replyTo builder", () => {
    expect(
      eTag("aa".repeat(32), { marker: "root", relay: "wss://x", author: keysA.publicKey }),
    ).toEqual(["e", "aa".repeat(32), "wss://x", "root", keysA.publicKey]);

    const parent = signedNote(keysA, "hi");
    const builder = replyTo(parent, "hello back", { relayHint: "wss://r" });
    expect(builder.currentKind).toBe(1);
    expect(builder.currentContent).toBe("hello back");
    expect(
      builder.currentTags.some((t) => t[0] === "e" && t[1] === parent.id && t[3] === "root"),
    ).toBe(true);

    const signed = builder.signWithKeys(keysB);
    expect(signed.pubkey).toBe(keysB.publicKey);
    expect(signed.tags.some((t) => t[0] === "p" && t[1] === parent.pubkey)).toBe(true);
  });
});

describe("nip21", () => {
  test("isNostrURI and parseNostrURI", () => {
    const npub = npubEncode(keysA.publicKey);
    const uri = `nostr:${npub}`;
    expect(isNostrURI(uri)).toBe(true);
    expect(isNostrURI(npub)).toBe(false);
    expect(isNostrURI("nostr:notvalid")).toBe(false);

    const parsed = parseNostrURI(uri);
    expect(parsed.uri).toBe(uri);
    expect(parsed.value).toBe(npub);
    expect(parsed.decoded).toEqual({ type: "npub", data: keysA.publicKey });
  });

  test("parseNostrURI rejects garbage", () => {
    expect(() => parseNostrURI("https://example.com")).toThrow(/invalid Nostr URI/);
    expect(() => parseNostrURI("nostr:zzz")).toThrow(/invalid Nostr URI/);
  });

  test("NIP-21 excludes nsec", () => {
    const uri = `nostr:${nsecEncode(keysA.secretKey.bytes)}`;
    expect(isNostrURI(uri)).toBe(false);
    expect(() => parseNostrURI(uri)).toThrow(/exclude nsec/);
  });
});

describe("nip27", () => {
  test("parseContentBlocks text, hashtag, url, media", () => {
    const blocks = parseContentBlocks(
      "hello #nostr see https://cdn.example.com/a.png and https://x.example.com/post",
    );
    expect(blocks).toEqual([
      { type: "text", text: "hello " },
      { type: "hashtag", value: "nostr" },
      { type: "text", text: " see " },
      { type: "image", url: "https://cdn.example.com/a.png" },
      { type: "text", text: " and " },
      { type: "url", url: "https://x.example.com/post" },
    ]);
  });

  test("parseContentBlocks nostr references", () => {
    const npub = npubEncode(keysA.publicKey);
    const note = noteEncode("77".repeat(32));
    const blocks = parseContentBlocks(`hi nostr:${npub} and note nostr:${note}`);
    expect(blocks[0]).toEqual({ type: "text", text: "hi " });
    expect(blocks[1]).toEqual({ type: "reference", pointer: { pubkey: keysA.publicKey } });
    expect(blocks[2]).toEqual({ type: "text", text: " and note " });
    expect(blocks[3]).toEqual({ type: "reference", pointer: { id: "77".repeat(32) } });
  });

  test("parseContentBlocks emoji tags and relays", () => {
    const event = signedNote(keysA, "ship it :shipit: via wss://relay.example.com", [
      ["emoji", "shipit", "https://cdn.example.com/shipit.png"],
    ]);
    const blocks = parseContentBlocks(event);
    expect(blocks).toEqual([
      { type: "text", text: "ship it " },
      { type: "emoji", shortcode: "shipit", url: "https://cdn.example.com/shipit.png" },
      { type: "text", text: " via " },
      { type: "relay", url: "wss://relay.example.com/" },
    ]);
  });
});
