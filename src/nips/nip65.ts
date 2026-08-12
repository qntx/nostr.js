import type { Event } from "../core/event.ts";
import { EventValidationError } from "../core/error.ts";
import { Kind } from "../core/kind.ts";
import type { Tag } from "../core/tag.ts";
import { EventBuilder } from "../core/builder.ts";
import { normalizeURL } from "../core/util.ts";

export type RelayMarker = "read" | "write" | "readwrite";

export type RelayListItem = {
  url: string;
  read: boolean;
  write: boolean;
};

export function markerOf(item: RelayListItem): RelayMarker {
  if (item.read && item.write) return "readwrite";
  if (item.read) return "read";
  if (item.write) return "write";
  return "readwrite";
}

/** Parse a kind:10002 NIP-65 event into relay list entries. */
export function parseRelayList(event: Event): RelayListItem[] {
  if (event.kind !== Kind.RelayList) {
    throw new EventValidationError(`expected kind ${Kind.RelayList}, got ${event.kind}`);
  }
  const out: RelayListItem[] = [];
  const seen = new Set<string>();

  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]) continue;
    let url: string;
    try {
      url = normalizeURL(tag[1]);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);

    const marker = tag[2];
    if (marker === "read") {
      out.push({ url, read: true, write: false });
    } else if (marker === "write") {
      out.push({ url, read: false, write: true });
    } else {
      out.push({ url, read: true, write: true });
    }
  }
  return out;
}

/** Encode relay list items as NIP-65 `r` tags. */
export function relayListToTags(items: RelayListItem[]): Tag[] {
  return items.map((item) => {
    if (item.read && item.write) return ["r", item.url] as Tag;
    if (item.read) return ["r", item.url, "read"] as Tag;
    if (item.write) return ["r", item.url, "write"] as Tag;
    return ["r", item.url] as Tag;
  });
}

/** Build an unsigned kind:10002 EventBuilder from relay list items. */
export function relayListEventBuilder(items: RelayListItem[]): EventBuilder {
  return new EventBuilder(Kind.RelayList, "").tags(relayListToTags(items));
}

export function readRelays(items: RelayListItem[]): string[] {
  return items.filter((i) => i.read).map((i) => i.url);
}

export function writeRelays(items: RelayListItem[]): string[] {
  return items.filter((i) => i.write).map((i) => i.url);
}
