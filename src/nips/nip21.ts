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
  if (typeof value !== "string") return false;
  if (!/^nostr:[a-z0-9]+1[02-9ac-hj-np-z]+$/i.test(value)) return false;
  return !value.toLowerCase().startsWith("nostr:nsec1");
}

/** Parse and decode a full `nostr:…` URI. NIP-21 excludes `nsec`. */
export function parseNostrURI(uri: string): NostrURI {
  const match = uri.match(/^nostr:([a-z0-9]+1[02-9ac-hj-np-z]+)$/i);
  if (!match?.[1]) throw new NostrError(`invalid Nostr URI: ${uri}`);
  if (match[1].toLowerCase().startsWith("nsec1")) {
    throw new NostrError("NIP-21 identifiers exclude nsec");
  }
  return {
    uri: `nostr:${match[1]}` as `nostr:${string}`,
    value: match[1],
    decoded: decode(match[1]),
  };
}
