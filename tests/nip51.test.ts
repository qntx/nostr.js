import { describe, expect, test } from "vite-plus/test";
import {
  EventValidationError,
  Kind,
  bookmarkListEventBuilder,
  muteListEventBuilder,
  parseBookmarkList,
  parseEmojiSet,
  parseFavoriteRelays,
  parseFollowPack,
  parseMuteList,
  parsePinList,
  parseRelaySet,
  parseUserEmojiList,
  pinListEventBuilder,
  normalizeURL,
  type MuteItem,
} from "../src/index.ts";

const PK = "aa".repeat(32);
const PK2 = "cc".repeat(32);
const ID = "bb".repeat(32);
const ID2 = "dd".repeat(32);
const ARTICLE = `30023:${PK}:post-1`;
const RELAY_SET = `30002:${PK}:home`;
const EMOJI_SET = `30030:${PK}:cats`;
const PEOPLE_SET = `30000:${PK}:friends`;

describe("nip51 mute list", () => {
  test("parses public p/e/t/word tags and ignores unknown tags", () => {
    const items = parseMuteList({
      kind: Kind.MuteList,
      tags: [
        ["p", PK.toUpperCase(), "wss://hint.example"],
        ["e", ID],
        ["t", "spam"],
        ["word", "scam"],
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
    const built = pinListEventBuilder([ID, ID2]);
    expect(built.currentKind).toBe(Kind.PinList);
    expect(built.currentTags).toEqual([
      ["e", ID],
      ["e", ID2],
    ]);
    expect(parsePinList({ kind: built.currentKind, tags: built.currentTags })).toEqual([ID, ID2]);
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
    const built = bookmarkListEventBuilder({ e: [ID], a: [ARTICLE] });
    expect(built.currentKind).toBe(Kind.BookmarkList);
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
    expect(
      parseFavoriteRelays({
        kind: Kind.FavoriteRelays,
        tags: [
          ["relay", "wss://a.example"],
          ["a", RELAY_SET],
          ["a", PEOPLE_SET],
          ["a", EMOJI_SET],
          ["p", PK],
          ["relay", "://bad"],
        ],
      }),
    ).toEqual({
      relays: [normalizeURL("wss://a.example")],
      sets: [RELAY_SET],
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
    expect(() => parsePinList(wrong)).toThrow(EventValidationError);
    expect(() => parseBookmarkList(wrong)).toThrow(EventValidationError);
    expect(() => parseUserEmojiList(wrong)).toThrow(EventValidationError);
    expect(() => parseRelaySet(wrong)).toThrow(EventValidationError);
    expect(() => parseFavoriteRelays(wrong)).toThrow(EventValidationError);
    expect(() => parseEmojiSet(wrong)).toThrow(EventValidationError);
    expect(() => parseFollowPack(wrong)).toThrow(EventValidationError);
  });
});
