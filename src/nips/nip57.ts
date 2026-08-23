/**
 * NIP-57 Lightning Zaps — zap request template (kind 9734).
 * Does not fetch LNURL or validate receipts.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/57.md
 */
import type { Event, EventTemplate } from "../core/event.ts";
import { EventValidationError } from "../core/error.ts";
import { isAddressableKind, isReplaceableKind, Kind } from "../core/kind.ts";
import { getDTag, type Tag } from "../core/tag.ts";

export type ProfileZapRequest = {
  pubkey: string;
  /** Amount in millisats. */
  amount: number;
  relays: readonly string[];
  comment?: string;
  lnurl?: string;
};

export type EventZapRequest = {
  event: Event;
  /** Amount in millisats. */
  amount: number;
  relays: readonly string[];
  comment?: string;
  lnurl?: string;
};

export function makeZapRequest(params: ProfileZapRequest | EventZapRequest): EventTemplate {
  const recipient = "event" in params ? params.event.pubkey : params.pubkey;
  const tags: Tag[] = [
    ["p", recipient],
    ["amount", params.amount.toString()],
    ["relays", ...params.relays],
  ];

  if ("event" in params) {
    const { event } = params;
    tags.push(["e", event.id]);
    if (isReplaceableKind(event.kind)) {
      tags.push(["a", `${event.kind}:${event.pubkey}:`]);
    } else if (isAddressableKind(event.kind)) {
      const d = getDTag(event.tags);
      if (!d) throw new EventValidationError("d tag not found or is empty");
      tags.push(["a", `${event.kind}:${event.pubkey}:${d}`]);
    }
    tags.push(["k", event.kind.toString()]);
  }

  if (params.lnurl) tags.push(["lnurl", params.lnurl]);

  return {
    kind: Kind.ZapRequest,
    created_at: Math.floor(Date.now() / 1000),
    content: params.comment ?? "",
    tags,
  };
}
