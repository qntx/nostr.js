/**
 * NIP-21: `nostr:` URI scheme
 * @see https://github.com/nostr-protocol/nips/blob/master/21.md
 */
import { NostrError } from "../core/error.ts";
import { decode, type DecodedResult } from "./nip19.ts";

/** Matches `nostr:<bech32>` (not anchored). */
export const NOSTR_URI_REGEX = /nostr:([a-z0-9]+1[02-9ac-hj-np-z]+)/i;

export type NostrURI = {
  /** Full URI including `nostr:` */
  uri: `nostr:${string}`;
  /** Bech32 entity without prefix */
  value: string;
  decoded: DecodedResult;
};

export function isNostrURI(value: unknown): value is `nostr:${string}` {
  return typeof value === "string" && /^nostr:[a-z0-9]+1[02-9ac-hj-np-z]+$/i.test(value);
}

/** Parse and decode a full `nostr:…` URI. */
export function parseNostrURI(uri: string): NostrURI {
  const match = uri.match(/^nostr:([a-z0-9]+1[02-9ac-hj-np-z]+)$/i);
  if (!match?.[1]) throw new NostrError(`invalid Nostr URI: ${uri}`);
  return {
    uri: `nostr:${match[1]}` as `nostr:${string}`,
    value: match[1],
    decoded: decode(match[1]),
  };
}
