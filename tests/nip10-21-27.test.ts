import { describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  EventValidationError,
  Keys,
  Kind,
  Tag,
  buildReplyTags,
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
      quotes: ["66".repeat(32)],
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

  test("replyTo requires kind 1", () => {
    const parent = signedNote(keysA, "hi");
    const kind6 = { ...parent, kind: Kind.Repost };
    expect(kind6.kind).toBe(Kind.Repost);
    expect(() => replyTo(kind6, "nope")).toThrow(EventValidationError);
    expect(() => replyTo(kind6, "nope")).toThrow(/kind 1/);
    expect(() => buildReplyTags({ parent: kind6 })).toThrow(EventValidationError);
    expect(() => buildReplyTags({ parent: kind6 })).toThrow(/kind 1/);

    const { id, pubkey, tags } = parent;
    const stripped = { id, pubkey, tags };
    expect("kind" in stripped).toBe(false);
    expect(() =>
      // @ts-expect-error ReplyParent.kind is required
      replyTo(stripped, "hello back"),
    ).toThrow(EventValidationError);
    expect(() =>
      // @ts-expect-error ReplyParent.kind is required
      replyTo(stripped, "hello back"),
    ).toThrow(/kind 1/);
    expect(() =>
      // @ts-expect-error ReplyParent.kind is required
      buildReplyTags({ parent: stripped }),
    ).toThrow(EventValidationError);

    const kind1 = replyTo({ id, pubkey, tags, kind: Kind.TextNote }, "also");
    expect(kind1.currentKind).toBe(Kind.TextNote);
    expect(kind1.currentTags.some((t) => t[0] === "e" && t[1] === id && t[3] === "root")).toBe(
      true,
    );
  });

  test("parseThreadTags hex q author is lowercased", () => {
    const quoteId = "55".repeat(32);
    const author = keysA.publicKey;
    const event = signedNote(keysB, "q author", [
      ["q", quoteId, "wss://quote.example", author.toUpperCase()],
    ]);

    const thread = parseThreadTags(event);
    const quote = thread.quotes[0];
    expect(thread.quotes).toHaveLength(1);
    expect(quote).toEqual({
      id: quoteId,
      relays: ["wss://quote.example"],
      author,
    });
    expect(quote && "id" in quote ? quote.author : undefined).toBe(author);
  });

  test("parseThreadTags address q becomes AddressPointer", () => {
    const pk = keysA.publicKey;
    const ident = "hello";
    const relay = "wss://addr.example";
    const other = keysB.publicKey;
    const event = signedNote(keysB, "q addr", [
      ["q", `30023:${pk.toUpperCase()}:${ident}`, relay, other],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.quotes).toHaveLength(1);
    expect(thread.quotes[0]).toEqual({
      identifier: ident,
      pubkey: pk,
      kind: 30023,
      relays: [relay],
    });
    expect("id" in thread.quotes[0]!).toBe(false);
    expect(thread.quotes[0]).not.toHaveProperty("author");
    expect(thread.quotes[0]).not.toMatchObject({ pubkey: other });
  });

  test("parseThreadTags skips invalid q tags", () => {
    const event = signedNote(keysA, "bad q", [
      ["q"],
      ["q", "not-a-quote"],
      ["q", "30023:short:d"],
      ["q", "1:2"],
      ["q", "55".repeat(32), "wss://ok.example", "not-a-pubkey"],
    ]);

    const thread = parseThreadTags(event);
    expect(thread.quotes).toEqual([{ id: "55".repeat(32), relays: ["wss://ok.example"] }]);
    expect(thread.quotes[0]).not.toHaveProperty("author");
  });

  test("buildReplyTags EventPointer quote emits q and p", () => {
    const parent = signedNote(keysA, "root note");
    const quoteId = "66".repeat(32);
    const quoteAuthor = "cc".repeat(32);
    const quoteRelay = "wss://quote.example";
    const tags = buildReplyTags({
      parent,
      quotes: [
        {
          id: quoteId,
          relays: [quoteRelay],
          author: quoteAuthor.toUpperCase(),
        },
      ],
    });

    expect(tags.filter((t) => t[0] === "q")).toEqual([["q", quoteId, quoteRelay, quoteAuthor]]);
    expect(tags).toContainEqual(["p", quoteAuthor, quoteRelay]);

    const viaReplyTo = replyTo(parent, "quoted", {
      quotes: [{ id: quoteId, relays: [quoteRelay], author: quoteAuthor }],
    });
    expect(viaReplyTo.currentKind).toBe(Kind.TextNote);
    expect(viaReplyTo.currentTags.filter((t) => t[0] === "q")).toEqual([
      ["q", quoteId, quoteRelay, quoteAuthor],
    ]);
    expect(viaReplyTo.currentTags).toContainEqual(["p", quoteAuthor, quoteRelay]);
  });

  test("buildReplyTags quote strings, addresses, empty relay, skip garbage", () => {
    const parent = signedNote(keysA, "root note");
    const hexId = "11".repeat(32);
    const emptyRelayId = "22".repeat(32);
    const emptyRelayAuthor = "dd".repeat(32);
    const addrPk = "bb".repeat(32);
    const addrRelay = "wss://addr.example";
    const coordPk = "ee".repeat(32);
    const tags = buildReplyTags({
      parent,
      quotes: [
        hexId.toUpperCase(),
        { id: emptyRelayId, author: emptyRelayAuthor.toUpperCase() },
        {
          identifier: "post",
          pubkey: addrPk.toUpperCase(),
          kind: 30023,
          relays: [addrRelay],
        },
        `30023:${coordPk.toUpperCase()}:slug`,
        "garbage",
        "30023:short:d",
        { id: "33".repeat(32), author: "not-hex" },
      ],
    });

    const qTags = tags.filter((t) => t[0] === "q");
    expect(qTags).toEqual([
      ["q", hexId],
      ["q", emptyRelayId, "", emptyRelayAuthor],
      ["q", `30023:${addrPk}:post`, addrRelay],
      ["q", `30023:${coordPk}:slug`],
      ["q", "33".repeat(32)],
    ]);
    expect(qTags).not.toContainEqual(["q", "garbage"]);
    expect(tags).toContainEqual(["p", emptyRelayAuthor]);
    expect(tags).toContainEqual(["p", addrPk, addrRelay]);
    expect(tags.some((t) => t[0] === "p" && t[1] === coordPk)).toBe(false);
    expect(tags.some((t) => t[0] === "p" && t[1] === hexId)).toBe(false);
  });

  test("Tag.e and replyTo builder", () => {
    expect(Tag.e("aa".repeat(32), "wss://x", "root", keysA.publicKey)).toEqual([
      "e",
      "aa".repeat(32),
      "wss://x",
      "root",
      keysA.publicKey,
    ]);

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
