/**
 * NIP-27: Text Note References
 * Tokenizes note content into text, nostr: references, URLs, hashtags, media, relays, emoji.
 * @see https://github.com/nostr-protocol/nips/blob/master/27.md
 */
import type { Event } from "../core/event.ts";
import { decode, type AddressPointer, type EventPointer, type ProfilePointer } from "./nip19.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reference"; pointer: ProfilePointer | AddressPointer | EventPointer }
  | { type: "url"; url: string }
  | { type: "relay"; url: string }
  | { type: "image"; url: string }
  | { type: "video"; url: string }
  | { type: "audio"; url: string }
  | { type: "emoji"; shortcode: string; url: string }
  | { type: "hashtag"; value: string };

const noCharacter = /\W/m;
const noURLCharacter = /[^\w/] |[^\w/]$|$|,| /m;
const MAX_HASHTAG_LENGTH = 42;

/**
 * Parse note content (or a full event, to pick up emoji tags) into blocks.
 * Generator — consume with `for…of` or `[...parseContent(s)]`.
 */
export function* parseContent(
  content: string | Pick<Event, "content" | "tags">,
): Iterable<ContentBlock> {
  let emojis: Array<{ type: "emoji"; shortcode: string; url: string }> = [];
  let text: string;

  if (typeof content === "string") {
    text = content;
  } else {
    for (const tag of content.tags) {
      if (tag[0] === "emoji" && tag[1] && tag[2]) {
        emojis.push({ type: "emoji", shortcode: tag[1], url: tag[2] });
      }
    }
    text = content.content;
  }

  const max = text.length;
  let prevIndex = 0;
  let index = 0;

  mainloop: while (index < max) {
    const u = text.indexOf(":", index);
    const h = text.indexOf("#", index);
    if (u === -1 && h === -1) break;

    if (u === -1 || (h >= 0 && h < u)) {
      // hashtag
      if (h === 0 || (h > 0 && text[h - 1]!.match(noCharacter))) {
        const m = text.slice(h + 1, h + MAX_HASHTAG_LENGTH).match(noCharacter);
        const end = m ? h + 1 + (m.index ?? 0) : max;
        if (prevIndex !== h) yield { type: "text", text: text.slice(prevIndex, h) };
        yield { type: "hashtag", value: text.slice(h + 1, end) };
        index = end;
        prevIndex = index;
        continue mainloop;
      }
      index = h + 1;
      continue mainloop;
    }

    // nostr: references
    if (u >= 5 && text.slice(u - 5, u) === "nostr") {
      const m = text.slice(u + 60).match(noCharacter);
      const end = m ? u + 60 + (m.index ?? 0) : max;
      try {
        const { data, type } = decode(text.slice(u + 1, end));
        let pointer: ProfilePointer | AddressPointer | EventPointer | undefined;
        switch (type) {
          case "npub":
            pointer = { pubkey: data };
            break;
          case "note":
            pointer = { id: data };
            break;
          case "nprofile":
          case "nevent":
          case "naddr":
            pointer = data as ProfilePointer | EventPointer | AddressPointer;
            break;
          case "nsec":
            index = end + 1;
            continue mainloop;
          default:
            index = u + 1;
            continue mainloop;
        }
        if (prevIndex !== u - 5) yield { type: "text", text: text.slice(prevIndex, u - 5) };
        yield { type: "reference", pointer };
        index = end;
        prevIndex = index;
        continue mainloop;
      } catch {
        index = u + 1;
        continue mainloop;
      }
    }

    // http(s) URLs
    if (
      (u >= 5 && text.slice(u - 5, u) === "https") ||
      (u >= 4 && text.slice(u - 4, u) === "http")
    ) {
      const m = text.slice(u + 4).match(noURLCharacter);
      const end = m ? u + 4 + (m.index ?? 0) : max;
      const prefixLen = text[u - 1] === "s" ? 5 : 4;
      try {
        const url = new URL(text.slice(u - prefixLen, end));
        if (!url.hostname.includes(".")) throw new Error("invalid url");
        if (prevIndex !== u - prefixLen) {
          yield { type: "text", text: text.slice(prevIndex, u - prefixLen) };
        }
        const path = url.pathname;
        if (/\.(png|jpe?g|gif|webp|heic|svg)$/i.test(path)) {
          yield { type: "image", url: url.toString() };
        } else if (/\.(mp4|avi|webm|mkv|mov)$/i.test(path)) {
          yield { type: "video", url: url.toString() };
        } else if (/\.(mp3|aac|ogg|opus|wav|flac)$/i.test(path)) {
          yield { type: "audio", url: url.toString() };
        } else {
          yield { type: "url", url: url.toString() };
        }
        index = end;
        prevIndex = index;
        continue mainloop;
      } catch {
        index = end + 1;
        continue mainloop;
      }
    }

    // ws(s) relays
    if ((u >= 3 && text.slice(u - 3, u) === "wss") || (u >= 2 && text.slice(u - 2, u) === "ws")) {
      const m = text.slice(u + 4).match(noURLCharacter);
      const end = m ? u + 4 + (m.index ?? 0) : max;
      const prefixLen = text[u - 1] === "s" ? 3 : 2;
      try {
        const url = new URL(text.slice(u - prefixLen, end));
        if (!url.hostname.includes(".")) throw new Error("invalid ws url");
        if (prevIndex !== u - prefixLen) {
          yield { type: "text", text: text.slice(prevIndex, u - prefixLen) };
        }
        yield { type: "relay", url: url.toString() };
        index = end;
        prevIndex = index;
        continue mainloop;
      } catch {
        index = end + 1;
        continue mainloop;
      }
    }

    // custom emoji shortcodes :code:
    for (const emoji of emojis) {
      const endColon = u + emoji.shortcode.length + 1;
      if (text[endColon] === ":" && text.slice(u + 1, endColon) === emoji.shortcode) {
        if (prevIndex !== u) yield { type: "text", text: text.slice(prevIndex, u) };
        yield emoji;
        index = endColon + 1;
        prevIndex = index;
        continue mainloop;
      }
    }

    index = u + 1;
  }

  if (prevIndex !== max) {
    yield { type: "text", text: text.slice(prevIndex) };
  }
}

/** Collect all content blocks into an array. */
export function parseContentBlocks(
  content: string | Pick<Event, "content" | "tags">,
): ContentBlock[] {
  return [...parseContent(content)];
}
