/**
 * NIP-17: Private Direct Messages (relay list surface).
 * Kind 10050 advertises where gift-wraps should be delivered.
 * Full seal/gift-wrap chat helpers live with NIP-59 (separate module).
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/17.md
 */
import type { Event } from "../core/event.ts";
import { EventValidationError } from "../core/error.ts";
import { Kind } from "../core/kind.ts";
import type { Tag } from "../core/tag.ts";
import { EventBuilder } from "../core/builder.ts";
import { normalizeURL } from "../core/util.ts";

/** Parse kind:10050 DM relay list (`["relay", url]` tags). */
export function parseDmRelayList(event: Pick<Event, "kind" | "tags">): string[] {
  if (event.kind !== Kind.DirectMessageRelaysList) {
    throw new EventValidationError(
      `expected kind ${Kind.DirectMessageRelaysList}, got ${event.kind}`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
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

/** Encode DM relay URLs as NIP-17 `relay` tags. */
export function dmRelayListToTags(relays: readonly string[]): Tag[] {
  const tags: Tag[] = [];
  const seen = new Set<string>();
  for (const raw of relays) {
    let url: string;
    try {
      url = normalizeURL(raw);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    tags.push(["relay", url] as Tag);
  }
  return tags;
}

/** Build an unsigned kind:10050 EventBuilder. */
export function dmRelayListEventBuilder(relays: readonly string[]): EventBuilder {
  return new EventBuilder(Kind.DirectMessageRelaysList, "").tags(dmRelayListToTags(relays));
}
