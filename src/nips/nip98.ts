/**
 * NIP-98: HTTP Auth (kind 27235).
 * Token is standard base64 of the signed event JSON, not base64url.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/98.md
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import type { Event, EventTemplate } from "../core/event.ts";
import { validateSignedEvent } from "../core/event.ts";
import { NostrError } from "../core/error.ts";
import { verifyEvent } from "../core/key.ts";
import { Kind } from "../core/kind.ts";
import type { Tag } from "../core/tag.ts";
import { bytesToHex, utf8Decoder, utf8Encoder } from "../core/util.ts";

const AUTHORIZATION_SCHEME = "Nostr ";
const DEFAULT_MAX_SKEW_SEC = 60;

export class Nip98Error extends NostrError {}

/** SHA-256 of the request body: raw bytes for string/Uint8Array, else JSON.stringify. */
function hashPayload(payload: unknown): string {
  const bytes =
    typeof payload === "string"
      ? utf8Encoder.encode(payload)
      : payload instanceof Uint8Array
        ? payload
        : utf8Encoder.encode(JSON.stringify(payload));
  return bytesToHex(sha256(bytes));
}

/** RFC 4648 standard base64; accept missing `=` (NIP-98 spec example is unpadded). */
function decodeStandardBase64(encoded: string): Uint8Array {
  const rem = encoded.length % 4;
  const padded = rem === 0 ? encoded : encoded + "=".repeat(4 - rem);
  return base64.decode(padded);
}

function stripAuthorizationScheme(token: string): string {
  const prefix = /^nostr\s+/i.exec(token);
  return prefix ? token.slice(prefix[0].length) : token;
}

/**
 * Sign a kind 27235 auth event and encode it as a NIP-98 token.
 * Uses standard base64 (`@scure/base`), not base64url.
 */
export async function getToken(
  url: string,
  method: string,
  sign: (template: EventTemplate) => Promise<Event> | Event,
  opts?: {
    includeAuthorizationScheme?: boolean;
    content?: string;
    payload?: unknown;
    now?: number;
  },
): Promise<string> {
  const tags: Tag[] = [
    ["u", url],
    ["method", method],
  ];
  if (opts?.payload !== undefined) {
    tags.push(["payload", hashPayload(opts.payload)]);
  }

  const signed = await sign({
    kind: Kind.HttpAuth,
    created_at: opts?.now ?? Math.floor(Date.now() / 1000),
    tags,
    content: opts?.content ?? "",
  });

  const encoded = base64.encode(utf8Encoder.encode(JSON.stringify(signed)));
  return opts?.includeAuthorizationScheme ? AUTHORIZATION_SCHEME + encoded : encoded;
}

/** Decode a NIP-98 token (with or without the `Nostr ` scheme) into an event. */
export function unpackEventFromToken(token: string): Event {
  if (!token) {
    throw new Nip98Error("missing token");
  }

  const encoded = stripAuthorizationScheme(token);

  let json: string;
  try {
    json = utf8Decoder.decode(decodeStandardBase64(encoded));
  } catch (cause) {
    throw new Nip98Error("invalid token encoding", { cause });
  }
  if (!json.startsWith("{")) {
    throw new Nip98Error("invalid token");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Nip98Error("invalid token JSON", { cause });
  }
  if (!validateSignedEvent(parsed)) {
    throw new Nip98Error("token is not a signed event");
  }
  return parsed;
}

/**
 * True when `event` is a valid NIP-98 auth event for `url` + `method`.
 * Verifies signature, kind 27235, timestamp window, `u`, `method`,
 * and optional `payload` tag.
 */
export function validateAuthEvent(
  event: Event,
  url: string,
  method: string,
  opts?: { payload?: unknown; maxSkewSec?: number },
): boolean {
  if (!verifyEvent(event)) return false;
  if (event.kind !== Kind.HttpAuth) return false;

  const maxSkewSec = opts?.maxSkewSec ?? DEFAULT_MAX_SKEW_SEC;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > maxSkewSec) return false;

  const u = event.tags.find((t) => t[0] === "u")?.[1];
  if (u !== url) return false;

  const m = event.tags.find((t) => t[0] === "method")?.[1];
  if (m === undefined || m.toLowerCase() !== method.toLowerCase()) return false;

  if (opts?.payload !== undefined) {
    const payloadTag = event.tags.find((t) => t[0] === "payload")?.[1];
    if (payloadTag !== hashPayload(opts.payload)) return false;
  }

  return true;
}
