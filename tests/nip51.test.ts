import { describe, expect, test } from "vite-plus/test";
import {
  CryptoError,
  EventValidationError,
  HexError,
  KeysSigner,
  Kind,
  normalizeURL,
} from "../src/index.ts";
import {
  bookmarkListEventBuilder,
  decryptPrivateTags,
  encryptPrivateTags,
  muteListEventBuilder,
  parseBookmarkList,
  parseEmojiSet,
  parseFavoriteRelays,
  parseFollowPack,
  parseMuteList,
  parseMuteListPrivate,
  parsePinList,
  parseRelaySet,
  parseUserEmojiList,
  pinListEventBuilder,
  type MuteItem,
  type Nip51Crypto,
} from "../src/nips/nip51.ts";

const PK = "aa".repeat(32);
const PK2 = "cc".repeat(32);
const ID = "bb".repeat(32);
const ID2 = "dd".repeat(32);
const ARTICLE = `30023:${PK}:post-1`;
const RELAY_SET = `30002:${PK}:home`;
const EMOJI_SET = `30030:${PK}:cats`;
const PEOPLE_SET = `30000:${PK}:friends`;
const AUTHOR_SK = "000000000000000000000000000000000000000000000000000000000000a1ce";

function unusedEncrypt(): Promise<string> {
  throw new Error("nip44Encrypt should not be invoked");
}

function trackingCrypto(opts: {
  pubkey: string;
  decrypt?: Nip51Crypto["nip44Decrypt"];
}): Nip51Crypto & { decryptInvocations: number } {
  const stub = {
    decryptInvocations: 0,
    async getPublicKey() {
      return opts.pubkey;
    },
    nip44Encrypt: unusedEncrypt,
    async nip44Decrypt(peer: string, payload: string) {
      stub.decryptInvocations += 1;
      if (!opts.decrypt) throw new Error("nip44Decrypt should not be invoked");
      return opts.decrypt(peer, payload);
    },
  };
  return stub;
}

describe("nip51 mute list", () => {
  test("parses public p/e/t/word tags and ignores unknown tags", () => {
    const items = parseMuteList({
      kind: Kind.MuteList,
      tags: [
        ["p", PK.toUpperCase(), "wss://hint.example"],
        ["e", ID],
        ["t", "spam"],
        ["word", "Scam"],
        ["emoji", "ignored", "https://x.example/x.png"],
        ["p", "not-hex"],
        ["e", ""],
      ],
    });
    expect(items).toEqual<MuteItem[]>([
      { type: "pubkey", value: PK },
      { type: "event", value: ID },
      { type: "hashtag", value: "spam" },
      { type: "word", value: "scam" },
    ]);
  });

  test("muteListEventBuilder round-trips public items", () => {
    const items: MuteItem[] = [
      { type: "pubkey", value: PK },
      { type: "event", value: ID },
      { type: "hashtag", value: "spam" },
      { type: "word", value: "scam" },
    ];
    const built = muteListEventBuilder(items);
    expect(built.currentKind).toBe(Kind.MuteList);
    expect(built.currentContent).toBe("");
    expect(built.currentTags).toEqual([
      ["p", PK],
      ["e", ID],
      ["t", "spam"],
      ["word", "scam"],
    ]);
    expect(parseMuteList({ kind: built.currentKind, tags: built.currentTags })).toEqual(items);
  });

  test("muteListEventBuilder lowercases hex and words; skips empty t/word", () => {
    const built = muteListEventBuilder([
      { type: "pubkey", value: PK.toUpperCase() },
      { type: "event", value: ID.toUpperCase() },
      { type: "hashtag", value: "" },
      { type: "word", value: "" },
      { type: "word", value: "Scam" },
    ]);
    expect(built.currentTags).toEqual([
      ["p", PK],
      ["e", ID],
      ["word", "scam"],
    ]);
  });

  test("muteListEventBuilder rejects non-hex pubkey", () => {
    expect(() => muteListEventBuilder([{ type: "pubkey", value: "nope" }])).toThrow(HexError);
  });
});

describe("nip51 pin list", () => {
  test("parses e tags and ignores unknown tags", () => {
    expect(
      parsePinList({
        kind: Kind.PinList,
        tags: [
          ["e", ID, "wss://r.example", PK],
          ["p", PK],
          ["e", ID2],
          ["e", "nope"],
        ],
      }),
    ).toEqual([ID, ID2]);
  });

  test("pinListEventBuilder emits e tags", () => {
    const built = pinListEventBuilder([ID.toUpperCase(), ID2]);
    expect(built.currentKind).toBe(Kind.PinList);
    expect(built.currentContent).toBe("");
    expect(built.currentTags).toEqual([
      ["e", ID],
      ["e", ID2],
    ]);
    expect(parsePinList({ kind: built.currentKind, tags: built.currentTags })).toEqual([ID, ID2]);
  });

  test("pinListEventBuilder rejects non-hex ids", () => {
    expect(() => pinListEventBuilder(["nope"])).toThrow(HexError);
  });
});

describe("nip51 bookmark list", () => {
  test("parses e and a tags and ignores unknown tags", () => {
    expect(
      parseBookmarkList({
        kind: Kind.BookmarkList,
        tags: [
          ["e", ID],
          ["a", ARTICLE],
          ["t", "ignored"],
          ["e", ID2],
          ["a", ""],
        ],
      }),
    ).toEqual({ e: [ID, ID2], a: [ARTICLE] });
  });

  test("bookmarkListEventBuilder emits e then a", () => {
    const built = bookmarkListEventBuilder({ e: [ID.toUpperCase()], a: [ARTICLE, ""] });
    expect(built.currentKind).toBe(Kind.BookmarkList);
    expect(built.currentContent).toBe("");
    expect(built.currentTags).toEqual([
      ["e", ID],
      ["a", ARTICLE],
    ]);
    expect(parseBookmarkList({ kind: built.currentKind, tags: built.currentTags })).toEqual({
      e: [ID],
      a: [ARTICLE],
    });
  });
});

describe("nip51 user emoji list", () => {
  test("parses emoji and a tags; skips incomplete emoji", () => {
    expect(
      parseUserEmojiList({
        kind: Kind.UserEmojiList,
        tags: [
          ["emoji", "cat", "https://cdn.example/cat.png", EMOJI_SET],
          ["a", EMOJI_SET],
          ["emoji", "incomplete"],
          ["p", PK],
          ["emoji", "dog", "https://cdn.example/dog.png"],
        ],
      }),
    ).toEqual({
      emoji: [
        { shortcode: "cat", url: "https://cdn.example/cat.png" },
        { shortcode: "dog", url: "https://cdn.example/dog.png" },
      ],
      sets: [EMOJI_SET],
    });
  });
});

describe("nip51 relay set", () => {
  test("parses d and relay tags; skips invalid urls and unknown tags", () => {
    expect(
      parseRelaySet({
        kind: Kind.RelaySets,
        tags: [
          ["d", "home"],
          ["title", "Home"],
          ["relay", "wss://a.example"],
          ["relay", "not a url"],
          ["relay", "wss://a.example/"],
          ["r", "wss://wrong.example"],
          ["relay", "wss://b.example"],
        ],
      }),
    ).toEqual({
      d: "home",
      relays: [normalizeURL("wss://a.example"), normalizeURL("wss://b.example")],
    });
  });

  test("missing d is empty string", () => {
    expect(parseRelaySet({ kind: Kind.RelaySets, tags: [] })).toEqual({ d: "", relays: [] });
  });
});

describe("nip51 favorite relays", () => {
  test("parses relay urls and kind 30002 a tags only", () => {
    const withColonD = `30002:${PK}:home:extra`;
    expect(
      parseFavoriteRelays({
        kind: Kind.FavoriteRelays,
        tags: [
          ["relay", "wss://a.example"],
          ["a", RELAY_SET],
          ["a", withColonD],
          ["a", "30002"],
          ["a", `30002:${PK}`],
          ["a", `30002:${PK}:`],
          ["a", PEOPLE_SET],
          ["a", EMOJI_SET],
          ["p", PK],
          ["relay", "://bad"],
        ],
      }),
    ).toEqual({
      relays: [normalizeURL("wss://a.example")],
      sets: [RELAY_SET, withColonD],
    });
  });
});

describe("nip51 emoji set", () => {
  test("parses d, title, and emoji tags", () => {
    expect(
      parseEmojiSet({
        kind: Kind.EmojiSet,
        tags: [
          ["d", "cats"],
          ["title", "Cats"],
          ["image", "https://cdn.example/cover.png"],
          ["emoji", "cat", "https://cdn.example/cat.png"],
          ["a", EMOJI_SET],
        ],
      }),
    ).toEqual({
      d: "cats",
      title: "Cats",
      emoji: [{ shortcode: "cat", url: "https://cdn.example/cat.png" }],
    });
  });

  test("omits title when absent", () => {
    const parsed = parseEmojiSet({
      kind: Kind.EmojiSet,
      tags: [
        ["d", "cats"],
        ["emoji", "cat", "https://cdn.example/cat.png"],
      ],
    });
    expect(parsed.d).toBe("cats");
    expect(parsed.title).toBeUndefined();
    expect(parsed.emoji).toEqual([{ shortcode: "cat", url: "https://cdn.example/cat.png" }]);
  });
});

describe("nip51 follow pack", () => {
  test("parses d and p tags; ignores unknown tags", () => {
    expect(
      parseFollowPack({
        kind: Kind.StarterPack,
        tags: [
          ["d", "dev"],
          ["title", "Devs"],
          ["p", PK2.toUpperCase(), "wss://hint.example"],
          ["p", "short"],
          ["p", PK],
          ["e", ID],
        ],
      }),
    ).toEqual({ d: "dev", pubkeys: [PK2, PK] });
  });
});

describe("nip51 kind mismatch", () => {
  const wrong = { kind: Kind.TextNote, tags: [] as const };

  test("throws EventValidationError", () => {
    expect(() => parseMuteList(wrong)).toThrow(EventValidationError);
    expect(() => parseMuteList(wrong)).toThrow(
      `expected kind ${Kind.MuteList}, got ${Kind.TextNote}`,
    );
    expect(() => parsePinList(wrong)).toThrow(EventValidationError);
    expect(() => parseBookmarkList(wrong)).toThrow(EventValidationError);
    expect(() => parseUserEmojiList(wrong)).toThrow(EventValidationError);
    expect(() => parseRelaySet(wrong)).toThrow(EventValidationError);
    expect(() => parseFavoriteRelays(wrong)).toThrow(EventValidationError);
    expect(() => parseEmojiSet(wrong)).toThrow(EventValidationError);
    expect(() => parseFollowPack(wrong)).toThrow(EventValidationError);
  });
});

describe("nip51 private tags", () => {
  test('encrypt [["p", PK]] round-trips through decrypt', async () => {
    const signer = new KeysSigner(AUTHOR_SK);
    const author = await signer.getPublicKey();
    const peers: string[] = [];
    const crypto: Nip51Crypto = {
      getPublicKey: () => signer.getPublicKey(),
      nip44Encrypt: async (peer, plaintext) => {
        peers.push(peer);
        return signer.nip44Encrypt(peer, plaintext);
      },
      nip44Decrypt: async (peer, payload) => {
        peers.push(peer);
        return signer.nip44Decrypt(peer, payload);
      },
    };
    const tags = [["p", PK]] as const;
    const content = await encryptPrivateTags(crypto, tags);
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toBe(JSON.stringify(tags));
    const decrypted = await decryptPrivateTags(crypto, { pubkey: author, content });
    expect(decrypted).toEqual([["p", PK]]);
    expect(peers).toEqual([author, author]);
  });

  test("parseMuteListPrivate splits public tags and private content; parseMuteList ignores content", async () => {
    const signer = new KeysSigner(AUTHOR_SK);
    const author = await signer.getPublicKey();
    const privateTags = [
      ["e", ID.toUpperCase()],
      ["word", "Secret"],
    ] as const;
    const content = await encryptPrivateTags(signer, privateTags);
    const event = {
      kind: Kind.MuteList,
      pubkey: author,
      tags: [
        ["p", PK],
        ["t", "spam"],
      ] as const,
      content,
    };
    const parsed = await parseMuteListPrivate(signer, event);
    expect(parsed.public).toEqual<MuteItem[]>([
      { type: "pubkey", value: PK },
      { type: "hashtag", value: "spam" },
    ]);
    expect(parsed.private).toEqual<MuteItem[]>([
      { type: "event", value: ID },
      { type: "word", value: "secret" },
    ]);
    expect(parseMuteList(event)).toEqual(parsed.public);
    expect(event.content).toBe(content);
    expect(event.content.length).toBeGreaterThan(0);
  });

  test("empty content yields private [] without invoking nip44Decrypt", async () => {
    const crypto = trackingCrypto({ pubkey: PK });
    const parsed = await parseMuteListPrivate(crypto, {
      kind: Kind.MuteList,
      pubkey: PK2,
      tags: [["p", PK2]],
      content: "",
    });
    expect(parsed.public).toEqual<MuteItem[]>([{ type: "pubkey", value: PK2 }]);
    expect(parsed.private).toEqual<MuteItem[]>([]);
    expect(crypto.decryptInvocations).toBe(0);
    expect(await decryptPrivateTags(crypto, { pubkey: PK2, content: "" })).toEqual([]);
    expect(crypto.decryptInvocations).toBe(0);
  });

  test("foreign pubkey throws before decrypt", async () => {
    const crypto = trackingCrypto({ pubkey: PK });
    await expect(
      decryptPrivateTags(crypto, { pubkey: PK2, content: "ciphertext" }),
    ).rejects.toThrow(EventValidationError);
    await expect(
      decryptPrivateTags(crypto, { pubkey: PK2, content: "ciphertext" }),
    ).rejects.toThrow("NIP-51 private content is only for the author");
    expect(crypto.decryptInvocations).toBe(0);
  });

  test("mixed-case author pubkey is accepted", async () => {
    const crypto = trackingCrypto({
      pubkey: PK,
      decrypt: async () => JSON.stringify([["p", PK2]]),
    });
    const tags = await decryptPrivateTags(crypto, {
      pubkey: PK.toUpperCase(),
      content: "ciphertext",
    });
    expect(tags).toEqual([["p", PK2]]);
    expect(crypto.decryptInvocations).toBe(1);
  });

  test("NIP-04-shaped content throws CryptoError and must not succeed", async () => {
    const signer = new KeysSigner(AUTHOR_SK);
    const author = await signer.getPublicKey();
    const tags = [["p", PK]] as const;
    const nip04Content = await signer.nip04Encrypt(author, JSON.stringify(tags));
    expect(nip04Content.includes("?iv=")).toBe(true);
    await expect(
      decryptPrivateTags(signer, { pubkey: author, content: nip04Content }),
    ).rejects.toThrow(CryptoError);
    let succeeded: unknown;
    try {
      succeeded = await decryptPrivateTags(signer, { pubkey: author, content: nip04Content });
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect(error).not.toBeInstanceOf(EventValidationError);
      return;
    }
    throw new Error(`NIP-04 content must not decrypt, got ${JSON.stringify(succeeded)}`);
  });

  test("plaintext JSON in content is not a parse-first fallback", async () => {
    const signer = new KeysSigner(AUTHOR_SK);
    const author = await signer.getPublicKey();
    const tags = [["p", PK]] as const;
    const plaintextJson = JSON.stringify(tags);
    expect(() => JSON.parse(plaintextJson)).not.toThrow();
    const crypto = trackingCrypto({
      pubkey: author,
      decrypt: (peer, payload) => signer.nip44Decrypt(peer, payload),
    });
    let succeeded: unknown;
    try {
      succeeded = await decryptPrivateTags(crypto, { pubkey: author, content: plaintextJson });
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect(error).not.toBeInstanceOf(EventValidationError);
      expect(crypto.decryptInvocations).toBe(1);
      return;
    }
    throw new Error(`plaintext JSON must not decrypt, got ${JSON.stringify(succeeded)}`);
  });

  test("NIP-44 decrypt of not-json throws EventValidationError not SyntaxError", async () => {
    const crypto = trackingCrypto({
      pubkey: PK,
      decrypt: async () => "not-json",
    });
    try {
      await decryptPrivateTags(crypto, { pubkey: PK, content: "payload" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EventValidationError);
      expect(error).not.toBeInstanceOf(SyntaxError);
      expect((error as EventValidationError).message).toBe("invalid NIP-51 private tags");
      expect((error as EventValidationError).cause).toBeInstanceOf(SyntaxError);
    }
    expect(crypto.decryptInvocations).toBe(1);
  });

  test("decrypted JSON that is not a tag array throws EventValidationError", async () => {
    const cases = ["{}", "null", "1", '"x"', "[[]]", '[["p", 1]]', "[1]"];
    for (const plaintext of cases) {
      const crypto = trackingCrypto({
        pubkey: PK,
        decrypt: async () => plaintext,
      });
      try {
        await decryptPrivateTags(crypto, { pubkey: PK, content: "payload" });
        throw new Error(`expected throw for ${plaintext}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EventValidationError);
        expect((error as EventValidationError).message).toBe("invalid NIP-51 private tags");
        expect((error as EventValidationError).cause).toBeUndefined();
      }
      expect(crypto.decryptInvocations).toBe(1);
    }
  });

  test("muteListEventBuilder still emits empty content; caller sets encrypted content", async () => {
    const signer = new KeysSigner(AUTHOR_SK);
    const built = muteListEventBuilder([{ type: "pubkey", value: PK }]);
    expect(built.currentContent).toBe("");
    const cipher = await encryptPrivateTags(signer, [["word", "secret"]]);
    built.content(cipher);
    expect(built.currentContent).toBe(cipher);
    expect(built.currentContent).not.toBe("");
    expect(built.currentTags).toEqual([["p", PK]]);
  });

  test("parseMuteListPrivate kind !== 10000 throws via requireKind", async () => {
    const crypto = trackingCrypto({ pubkey: PK });
    await expect(
      parseMuteListPrivate(crypto, {
        kind: Kind.TextNote,
        pubkey: PK,
        tags: [],
        content: "",
      }),
    ).rejects.toThrow(EventValidationError);
    await expect(
      parseMuteListPrivate(crypto, {
        kind: Kind.TextNote,
        pubkey: PK,
        tags: [],
        content: "ciphertext",
      }),
    ).rejects.toThrow(`expected kind ${Kind.MuteList}, got ${Kind.TextNote}`);
    expect(crypto.decryptInvocations).toBe(0);
  });
});
