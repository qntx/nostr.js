/**
 * NIP-51: Lists
 * Public tags only. Encrypted `.content` is the caller's job (needs a signer).
 * Kind 10063 Blossom servers live in blossom.ts.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/51.md
 */
import { EventBuilder } from "../core/builder.ts";
import { EventValidationError } from "../core/error.ts";
import type { Event } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import { getDTag, Tag } from "../core/tag.ts";
import { isHex32, normalizeURL } from "../core/util.ts";

export type MuteItem =
  | { type: "pubkey"; value: string }
  | { type: "event"; value: string }
  | { type: "hashtag"; value: string }
  | { type: "word"; value: string };

function requireKind(event: Pick<Event, "kind">, kind: number): void {
  if (event.kind !== kind) {
    throw new EventValidationError(`expected kind ${kind}, got ${event.kind}`);
  }
}

function collectRelays(tags: Event["tags"]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "relay" || !tag[1]) continue;
    let url: string;
    try {
      url = normalizeURL(tag[1]);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function collectEmoji(tags: Event["tags"]): Array<{ shortcode: string; url: string }> {
  const out: Array<{ shortcode: string; url: string }> = [];
  for (const tag of tags) {
    if (tag[0] !== "emoji") continue;
    const shortcode = tag[1];
    const url = tag[2];
    if (!shortcode || !url) continue;
    out.push({ shortcode, url });
  }
  return out;
}

function firstTagValue(tags: Event["tags"], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && tag[1]) return tag[1];
  }
  return undefined;
}

function identifier(tags: Event["tags"]): string {
  return getDTag(tags) ?? "";
}

/** Parse kind:10000 mute list public tags (`p` / `e` / `t` / `word`). */
export function parseMuteList(event: Pick<Event, "kind" | "tags">): MuteItem[] {
  requireKind(event, Kind.MuteList);
  const items: MuteItem[] = [];
  for (const tag of event.tags) {
    const value = tag[1];
    if (!value) continue;
    switch (tag[0]) {
      case "p":
        if (isHex32(value)) items.push({ type: "pubkey", value: value.toLowerCase() });
        break;
      case "e":
        if (isHex32(value)) items.push({ type: "event", value: value.toLowerCase() });
        break;
      case "t":
        items.push({ type: "hashtag", value });
        break;
      case "word":
        items.push({ type: "word", value });
        break;
    }
  }
  return items;
}

/** Build an unsigned kind:10000 EventBuilder from public mute items. */
export function muteListEventBuilder(items: readonly MuteItem[]): EventBuilder {
  const b = new EventBuilder(Kind.MuteList, "");
  for (const item of items) {
    switch (item.type) {
      case "pubkey":
        b.tag(Tag.p(item.value));
        break;
      case "event":
        b.tag(Tag.e(item.value));
        break;
      case "hashtag":
        b.tag(Tag.t(item.value));
        break;
      case "word":
        b.tag(["word", item.value]);
        break;
    }
  }
  return b;
}

/** Parse kind:10001 pin list public `e` tags. */
export function parsePinList(event: Pick<Event, "kind" | "tags">): string[] {
  requireKind(event, Kind.PinList);
  const ids: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "e" || !tag[1] || !isHex32(tag[1])) continue;
    ids.push(tag[1].toLowerCase());
  }
  return ids;
}

/** Build an unsigned kind:10001 EventBuilder from event ids. */
export function pinListEventBuilder(ids: readonly string[]): EventBuilder {
  const b = new EventBuilder(Kind.PinList, "");
  for (const id of ids) b.tag(Tag.e(id));
  return b;
}

/** Parse kind:10003 bookmark list public `e` and `a` tags. */
export function parseBookmarkList(event: Pick<Event, "kind" | "tags">): {
  e: string[];
  a: string[];
} {
  requireKind(event, Kind.BookmarkList);
  const e: string[] = [];
  const a: string[] = [];
  for (const tag of event.tags) {
    if (!tag[1]) continue;
    if (tag[0] === "e") {
      if (isHex32(tag[1])) e.push(tag[1].toLowerCase());
    } else if (tag[0] === "a") {
      a.push(tag[1]);
    }
  }
  return { e, a };
}

/** Build an unsigned kind:10003 EventBuilder from public bookmark pointers. */
export function bookmarkListEventBuilder(items: {
  e?: readonly string[];
  a?: readonly string[];
}): EventBuilder {
  const b = new EventBuilder(Kind.BookmarkList, "");
  if (items.e) {
    for (const id of items.e) b.tag(Tag.e(id));
  }
  if (items.a) {
    for (const coord of items.a) b.tag(Tag.a(coord));
  }
  return b;
}

/** Parse kind:10030 user emoji list public `emoji` and `a` tags. */
export function parseUserEmojiList(event: Pick<Event, "kind" | "tags">): {
  emoji: Array<{ shortcode: string; url: string }>;
  sets: string[];
} {
  requireKind(event, Kind.UserEmojiList);
  const sets: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === "a" && tag[1]) sets.push(tag[1]);
  }
  return { emoji: collectEmoji(event.tags), sets };
}

/** Parse kind:30002 relay set public `d` and `relay` tags. */
export function parseRelaySet(event: Pick<Event, "kind" | "tags">): {
  d: string;
  relays: string[];
} {
  requireKind(event, Kind.RelaySets);
  return { d: identifier(event.tags), relays: collectRelays(event.tags) };
}

/** Parse kind:10012 favorite relays public `relay` tags and kind:30002 `a` tags. */
export function parseFavoriteRelays(event: Pick<Event, "kind" | "tags">): {
  relays: string[];
  sets: string[];
} {
  requireKind(event, Kind.FavoriteRelays);
  const sets: string[] = [];
  const setKind = String(Kind.RelaySets);
  for (const tag of event.tags) {
    if (tag[0] !== "a" || !tag[1]) continue;
    if (tag[1].split(":")[0] !== setKind) continue;
    sets.push(tag[1]);
  }
  return { relays: collectRelays(event.tags), sets };
}

/** Parse kind:30030 emoji set public `d` / `title` / `emoji` tags. */
export function parseEmojiSet(event: Pick<Event, "kind" | "tags">): {
  d: string;
  title?: string;
  emoji: Array<{ shortcode: string; url: string }>;
} {
  requireKind(event, Kind.EmojiSet);
  return {
    d: identifier(event.tags),
    title: firstTagValue(event.tags, "title"),
    emoji: collectEmoji(event.tags),
  };
}

/** Parse kind:39089 starter pack (follow pack) public `d` and `p` tags. */
export function parseFollowPack(event: Pick<Event, "kind" | "tags">): {
  d: string;
  pubkeys: string[];
} {
  requireKind(event, Kind.StarterPack);
  const pubkeys: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "p" || !tag[1] || !isHex32(tag[1])) continue;
    pubkeys.push(tag[1].toLowerCase());
  }
  return { d: identifier(event.tags), pubkeys };
}
