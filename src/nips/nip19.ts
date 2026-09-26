import { bech32 } from "@scure/base";
import { NostrError } from "../core/error.ts";
import {
  assertByteLength,
  assertHex32,
  bytesToHex,
  hexToBytes,
  utf8Decoder,
  utf8Encoder,
} from "../core/util.ts";

/** Bech32 `nprofile1…` string (TLV profile pointer). */
export type NProfile = `nprofile1${string}`;
/** Bech32 `nevent1…` string (TLV event pointer). */
export type NEvent = `nevent1${string}`;
/** Bech32 `naddr1…` string (TLV address pointer). */
export type NAddr = `naddr1${string}`;
/** Bech32 `nsec1…` string (32-byte secret key). */
export type NSec = `nsec1${string}`;
/** Bech32 `npub1…` string (32-byte public key). */
export type NPub = `npub1${string}`;
/** Bech32 `note1…` string (32-byte event id). */
export type Note = `note1${string}`;

/** Maximum bech32 string length accepted by {@link decode} (NIP-19). */
export const Bech32MaxSize = 5000;

/** Decoded `nprofile` payload: a pubkey plus optional relay hints. */
export type ProfilePointer = {
  pubkey: string;
  relays?: string[];
};

/** Decoded `nevent` payload: an event id plus optional relay/author/kind hints. */
export type EventPointer = {
  id: string;
  relays?: string[];
  author?: string;
  kind?: number;
};

/** Decoded `naddr` payload: a replaceable-event coordinate plus optional relay hints. */
export type AddressPointer = {
  identifier: string;
  pubkey: string;
  kind: number;
  relays?: string[];
};

/** Result of {@link decode}: the bech32 prefix and its decoded payload. */
export type DecodedResult =
  | { type: "nprofile"; data: ProfilePointer }
  | { type: "nevent"; data: EventPointer }
  | { type: "naddr"; data: AddressPointer }
  | { type: "nsec"; data: Uint8Array }
  | { type: "npub"; data: string }
  | { type: "note"; data: string };

/** Error thrown by NIP-19 encoding/decoding failures. */
export class Nip19Error extends NostrError {
  constructor(message: string) {
    super(message);
  }
}

type TLV = { [t: number]: Uint8Array[] };

function integerToUint8Array(number: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (number >> 24) & 0xff;
  out[1] = (number >> 16) & 0xff;
  out[2] = (number >> 8) & 0xff;
  out[3] = number & 0xff;
  return out;
}

function parseTLV(data: Uint8Array): TLV {
  const result: TLV = {};
  let rest = data;
  while (rest.length > 0) {
    if (rest.length < 2) throw new Nip19Error("not enough data to read TLV");
    const t = rest[0]!;
    const l = rest[1]!;
    const v = rest.slice(2, 2 + l);
    rest = rest.slice(2 + l);
    if (v.length < l) throw new Nip19Error(`not enough data to read on TLV ${t}`);
    result[t] = result[t] || [];
    result[t]!.push(v);
  }
  return result;
}

function assertNip19Kind(kind: number): void {
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xffffffff) {
    throw new Nip19Error(`invalid kind: ${kind}`);
  }
}

function encodeTLV(tlv: TLV): Uint8Array {
  const entries: Uint8Array[] = [];
  for (const [t, vs] of Object.entries(tlv).reverse()) {
    for (const v of vs) {
      if (v.length > 255) throw new Nip19Error("TLV value exceeds 255 bytes");
      const entry = new Uint8Array(v.length + 2);
      entry[0] = Number.parseInt(t, 10);
      entry[1] = v.length;
      entry.set(v, 2);
      entries.push(entry);
    }
  }
  let total = 0;
  for (const e of entries) total += e.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const e of entries) {
    out.set(e, offset);
    offset += e.length;
  }
  return out;
}

function encodeBech32<Prefix extends string>(
  prefix: Prefix,
  data: Uint8Array,
): `${Prefix}1${string}` {
  const words = bech32.toWords(data);
  return bech32.encode(prefix, words, Bech32MaxSize) as `${Prefix}1${string}`;
}

export function encodeBytes<Prefix extends string>(
  prefix: Prefix,
  bytes: Uint8Array,
): `${Prefix}1${string}` {
  return encodeBech32(prefix, bytes);
}

/** Encode a 32-byte secret key as `nsec1…`; throws {@link Nip19Error} on wrong length. */
export function nsecEncode(key: Uint8Array): NSec {
  assertByteLength(key, 32, "secret key");
  return encodeBytes("nsec", key);
}

/** Encode a hex public key as `npub1…`; throws {@link HexError} on bad hex. */
export function npubEncode(hex: string): NPub {
  return encodeBytes("npub", hexToBytes(assertHex32(hex, "pubkey")));
}

/** Encode a hex event id as `note1…`; throws {@link HexError} on bad hex. */
export function noteEncode(hex: string): Note {
  return encodeBytes("note", hexToBytes(assertHex32(hex, "event id")));
}

/** Encode a profile pointer as `nprofile1…`. */
export function nprofileEncode(profile: ProfilePointer): NProfile {
  const data = encodeTLV({
    0: [hexToBytes(assertHex32(profile.pubkey, "pubkey"))],
    1: (profile.relays || []).map((url) => utf8Encoder.encode(url)),
  });
  return encodeBech32("nprofile", data);
}

/** Encode an event pointer as `nevent1…`. */
export function neventEncode(event: EventPointer): NEvent {
  if (event.kind !== undefined) assertNip19Kind(event.kind);
  const kindArray = event.kind !== undefined ? integerToUint8Array(event.kind) : undefined;
  const data = encodeTLV({
    0: [hexToBytes(assertHex32(event.id, "event id"))],
    1: (event.relays || []).map((url) => utf8Encoder.encode(url)),
    2: event.author ? [hexToBytes(assertHex32(event.author, "author"))] : [],
    3: kindArray ? [kindArray] : [],
  });
  return encodeBech32("nevent", data);
}

/** Encode an address pointer as `naddr1…`. */
export function naddrEncode(addr: AddressPointer): NAddr {
  assertNip19Kind(addr.kind);
  const kind = integerToUint8Array(addr.kind);
  const data = encodeTLV({
    0: [utf8Encoder.encode(addr.identifier)],
    1: (addr.relays || []).map((url) => utf8Encoder.encode(url)),
    2: [hexToBytes(assertHex32(addr.pubkey, "pubkey"))],
    3: [kind],
  });
  return encodeBech32("naddr", data);
}

/** Decode a NIP-19 bech32 entity; throws {@link Nip19Error} on bad input or unknown prefix. */
export function decode(code: string): DecodedResult {
  let { prefix, words } = bech32.decode(code as `${string}1${string}`, Bech32MaxSize);
  const data = new Uint8Array(bech32.fromWords(words));

  switch (prefix) {
    case "nprofile": {
      const tlv = parseTLV(data);
      if (!tlv[0]?.[0]) throw new Nip19Error("missing TLV 0 for nprofile");
      if (tlv[0][0].length !== 32) throw new Nip19Error("TLV 0 should be 32 bytes");
      return {
        type: "nprofile",
        data: {
          pubkey: bytesToHex(tlv[0][0]),
          relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : [],
        },
      };
    }
    case "nevent": {
      const tlv = parseTLV(data);
      if (!tlv[0]?.[0]) throw new Nip19Error("missing TLV 0 for nevent");
      if (tlv[0][0].length !== 32) throw new Nip19Error("TLV 0 should be 32 bytes");
      if (tlv[2]?.[0] && tlv[2][0].length !== 32) throw new Nip19Error("TLV 2 should be 32 bytes");
      if (tlv[3]?.[0] && tlv[3][0].length !== 4) throw new Nip19Error("TLV 3 should be 4 bytes");
      return {
        type: "nevent",
        data: {
          id: bytesToHex(tlv[0][0]),
          relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : [],
          author: tlv[2]?.[0] ? bytesToHex(tlv[2][0]) : undefined,
          kind: tlv[3]?.[0] ? Number.parseInt(bytesToHex(tlv[3][0]), 16) : undefined,
        },
      };
    }
    case "naddr": {
      const tlv = parseTLV(data);
      if (!tlv[0]?.[0]) throw new Nip19Error("missing TLV 0 for naddr");
      if (!tlv[2]?.[0]) throw new Nip19Error("missing TLV 2 for naddr");
      if (tlv[2][0].length !== 32) throw new Nip19Error("TLV 2 should be 32 bytes");
      if (!tlv[3]?.[0]) throw new Nip19Error("missing TLV 3 for naddr");
      if (tlv[3][0].length !== 4) throw new Nip19Error("TLV 3 should be 4 bytes");
      return {
        type: "naddr",
        data: {
          identifier: utf8Decoder.decode(tlv[0][0]),
          pubkey: bytesToHex(tlv[2][0]),
          kind: Number.parseInt(bytesToHex(tlv[3][0]), 16),
          relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : [],
        },
      };
    }
    case "nsec":
      if (data.length !== 32) throw new Nip19Error("nsec must be 32 bytes");
      return { type: "nsec", data };
    case "npub":
    case "note":
      if (data.length !== 32) throw new Nip19Error(`${prefix} must be 32 bytes`);
      return { type: prefix, data: bytesToHex(data) };
    default:
      throw new Nip19Error(`unknown prefix ${prefix}`);
  }
}

/** Decode `nostr:` URI or bare bech32; returns invalid sentinel instead of throwing. */
export function decodeNostrURI(nip19code: string): DecodedResult | { type: "invalid"; data: null } {
  try {
    let code = nip19code;
    if (code.startsWith("nostr:")) {
      code = code.slice(6);
      // NIP-21 excludes nsec from nostr: identifiers.
      if (code.startsWith("nsec1")) return { type: "invalid", data: null };
    }
    return decode(code);
  } catch {
    return { type: "invalid", data: null };
  }
}
