/**
 * NIP-57 Lightning Zaps — zap request template (kind 9734) and receipt validation (kind 9735).
 * Does not fetch LNURL. Receipt checks never throw.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/57.md
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { EventValidationError } from "../core/error.ts";
import { validateSignedEvent, type Event, type EventTemplate } from "../core/event.ts";
import { isAddressableKind, Kind } from "../core/kind.ts";
import { eventAddress, getDTag, type Tag } from "../core/tag.ts";
import { hexToBytes, utf8Encoder } from "../core/util.ts";

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
  if (params.relays.length === 0) {
    throw new EventValidationError("relays tag requires one or more URLs");
  }

  const recipient = "event" in params ? params.event.pubkey : params.pubkey;
  const tags: Tag[] = [
    ["p", recipient],
    ["amount", params.amount.toString()],
    ["relays", ...params.relays],
  ];

  if ("event" in params) {
    const { event } = params;
    tags.push(["e", event.id]);
    if (isAddressableKind(event.kind)) {
      const d = getDTag(event.tags);
      if (!d) throw new EventValidationError("d tag not found or is empty");
    }
    const addr = eventAddress(event);
    if (addr) tags.push(["a", addr]);
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

export type ZapReceiptContext = {
  nostrPubkey: string;
  lnurl?: string;
};

export type ZapReceiptValidation = {
  valid: boolean;
  reason?: string;
  request?: Event;
  amountMsats?: number;
};

export type Bolt11Fields = {
  amountMsats?: number;
  descriptionHash?: Uint8Array;
  paymentHash?: Uint8Array;
};

function firstTagValue(tags: readonly Tag[], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && tag[1] !== undefined) return tag[1];
  }
  return undefined;
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}

function fail(reason: string): ZapReceiptValidation {
  return { valid: false, reason };
}

const MSATS_PER_BTC = 100_000_000_000;
const MSATS_PER_MILLI = 100_000_000;
const MSATS_PER_MICRO = 100_000;
const MSATS_PER_NANO = 100;

/** Amount is digits after `ln` + currency letters, optional m/u/n/p. Non-integer pico is omitted. */
function amountMsatsFromHrp(hrp: string): number | undefined {
  if (!hrp.startsWith("ln")) return undefined;
  let i = 2;
  while (i < hrp.length) {
    const c = hrp.charCodeAt(i);
    if (c < 97 || c > 122) break;
    i++;
  }
  if (i === hrp.length) return undefined;
  const rest = hrp.slice(i);
  const m = /^([0-9]+)([munp])?$/.exec(rest);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n)) return undefined;
  const mul = m[2];
  if (mul === undefined) return n * MSATS_PER_BTC;
  if (mul === "m") return n * MSATS_PER_MILLI;
  if (mul === "u") return n * MSATS_PER_MICRO;
  if (mul === "n") return n * MSATS_PER_NANO;
  // p: 0.1 msat; drop amounts that are not whole millisats
  if (n % 10 !== 0) return undefined;
  return n / 10;
}

function parseMsatsTag(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Decode a BOLT11 invoice. Never throws. */
export function parseBolt11(pr: string): Bolt11Fields | undefined {
  try {
    // Invoices exceed bech32's default 90-char limit.
    const { prefix, words } = bech32.decode(pr.toLowerCase() as `${string}1${string}`, false);
    if (!prefix.startsWith("ln")) return undefined;
    const fields: Bolt11Fields = {};
    const amountMsats = amountMsatsFromHrp(prefix);
    if (amountMsats !== undefined) fields.amountMsats = amountMsats;
    // Skip 7-word timestamp. TLV: 5-bit type, 10-bit length in 5-bit words, data.
    let i = 7;
    while (i + 3 <= words.length) {
      const type = words[i]!;
      const dataLen = (words[i + 1]! << 5) | words[i + 2]!;
      i += 3;
      if (i + dataLen > words.length) break;
      const data = words.slice(i, i + dataLen);
      i += dataLen;
      if (type !== 1 && type !== 23) continue;
      const bytes = bech32.fromWordsUnsafe(data);
      if (!bytes) continue;
      if (type === 1) {
        fields.paymentHash ??= bytes;
      } else {
        fields.descriptionHash ??= bytes;
      }
    }
    return fields;
  } catch {
    return undefined;
  }
}

/** Parse the `description` tag of a kind 9735 receipt as a signed kind 9734. Never throws. */
export function parseZapRequestFromReceipt(receipt: Event): Event | undefined {
  try {
    const raw = firstTagValue(receipt.tags, "description");
    if (raw === undefined) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!validateSignedEvent(parsed) || parsed.kind !== Kind.ZapRequest) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Validate a kind 9735 zap receipt. Never throws. */
export function validateZapReceipt(receipt: Event, ctx: ZapReceiptContext): ZapReceiptValidation {
  try {
    if (receipt.kind !== Kind.Zap || !validateSignedEvent(receipt)) {
      return fail("invalid receipt");
    }
    if (receipt.pubkey.toLowerCase() !== ctx.nostrPubkey.toLowerCase()) {
      return fail("pubkey mismatch");
    }

    const descriptionRaw = firstTagValue(receipt.tags, "description");
    const request = parseZapRequestFromReceipt(receipt);
    if (descriptionRaw === undefined || !request) return fail("invalid zap request");

    const bolt11Tag = firstTagValue(receipt.tags, "bolt11");
    if (bolt11Tag === undefined) return fail("missing bolt11");
    const bolt11 = parseBolt11(bolt11Tag);
    if (!bolt11) return fail("invalid bolt11");

    const requestAmount = firstTagValue(request.tags, "amount");
    if (requestAmount !== undefined && bolt11.amountMsats !== undefined) {
      const msats = parseMsatsTag(requestAmount);
      if (msats !== bolt11.amountMsats) return fail("amount mismatch");
    }

    if (bolt11.descriptionHash) {
      // Hash the tag payload, not JSON.stringify(parsed) (key order may differ).
      const digest = sha256(utf8Encoder.encode(descriptionRaw));
      if (!bytesEq(digest, bolt11.descriptionHash)) return fail("description hash mismatch");
    }

    const requestLnurl = firstTagValue(request.tags, "lnurl");
    if (requestLnurl !== undefined && ctx.lnurl !== undefined) {
      if (requestLnurl.toLowerCase() !== ctx.lnurl.toLowerCase()) return fail("lnurl mismatch");
    }

    const preimageHex = firstTagValue(receipt.tags, "preimage");
    if (preimageHex !== undefined && bolt11.paymentHash) {
      let preimage: Uint8Array;
      try {
        preimage = hexToBytes(preimageHex);
      } catch {
        return fail("preimage mismatch");
      }
      if (!bytesEq(sha256(preimage), bolt11.paymentHash)) return fail("preimage mismatch");
    }

    const amountMsats =
      bolt11.amountMsats ??
      (requestAmount !== undefined ? parseMsatsTag(requestAmount) : undefined);
    return amountMsats === undefined
      ? { valid: true, request }
      : { valid: true, request, amountMsats };
  } catch {
    return fail("invalid receipt");
  }
}
