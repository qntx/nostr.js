/**
 * NIP-59: Gift Wrap.
 * Rumor → NIP-44 seal (kind 13) → gift wrap (kind 1059).
 * Does not import signer, relay, or client. Crypto is a structural type.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/59.md
 */
import { randomBytes } from "@noble/hashes/utils.js";
import type { Event, UnsignedEvent } from "../core/event.ts";
import { getEventHash, validateEvent, validateSignedEvent } from "../core/event.ts";
import { NostrError } from "../core/error.ts";
import { Kind } from "../core/kind.ts";
import { Keys, finalizeEvent, verifyEvent } from "../core/key.ts";
import type { Tag } from "../core/tag.ts";
import { Tag as TagBuilder } from "../core/tag.ts";
import { assertHex32 } from "../core/util.ts";
import { encryptToPubkey } from "./nip44.ts";

/** Unsigned event with a computed id. Never has `sig`. */
export type Rumor = UnsignedEvent & {
  readonly id: string;
};

/**
 * Structural crypto used by NIP-59.
 * Satisfied by NostrSigner when nip44Encrypt/nip44Decrypt are present.
 * This module must not import src/signer/.
 * `signEvent` and `nip44Encrypt` may use different keys; the caller supplies both.
 */
export type Nip59Crypto = {
  getPublicKey(): Promise<string>;
  signEvent(unsigned: UnsignedEvent): Promise<Event>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, payload: string): Promise<string>;
};

export type Nip44Decryptor = {
  nip44Decrypt(peer: string, payload: string): Promise<string>;
};

export type GiftWrapTimestamps = {
  readonly seal: number;
  readonly wrap: number;
};

/** `"wrap"` randomizes only the gift wrap; `"seal+wrap"` (default) randomizes both. */
export type TimestampRandomize = "wrap" | "seal+wrap";

export type WrapOptions = {
  /** Unix seconds used as the randomization window end. Default: floor(Date.now()/1000). */
  readonly now?: number;
  /** Uniform integer in [0, maxExclusive). Default: CSPRNG via @noble/hashes randomBytes. */
  readonly randomInt?: (maxExclusive: number) => number;
  /** When set, used as-is. Overrides now/randomInt for this call. */
  readonly timestamps?: GiftWrapTimestamps;
  readonly relayHint?: string;
  /** Encrypt wrap ciphertext to this pubkey instead of `recipient`. Default: recipient. */
  readonly encryptTo?: string;
  /** Appended after the required wrap `p` tag. Never applied to the seal. */
  readonly extraTags?: readonly Tag[];
  /** Default `"seal+wrap"` (NIP-59). `"wrap"` = only wrap timestamp is randomized; seal uses rumor.created_at. */
  readonly randomize?: TimestampRandomize;
};

export type SealOptions = Pick<
  WrapOptions,
  "now" | "randomInt" | "timestamps" | "encryptTo" | "randomize"
> & {
  /**
   * Seal tags. NIP-59: kind 13 tags MUST be empty. This exists only so jumble
   * dual-key can inject `[["n", encPk]]` via `createSeal` — not via `wrap()`.
   */
  readonly extraTags?: readonly Tag[];
};

export class Nip59Error extends NostrError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export const TWO_DAYS_SECS = 2 * 24 * 60 * 60;

export function isGiftWrapKind(kind: number): boolean {
  return kind === Kind.GiftWrap || kind === Kind.GiftWrapEphemeral;
}

type Nip59CryptoInput = {
  getPublicKey(): Promise<string>;
  signEvent(unsigned: UnsignedEvent): Promise<Event>;
  nip44Encrypt?: (peer: string, plaintext: string) => Promise<string>;
  nip44Decrypt?: (peer: string, payload: string) => Promise<string>;
};

/** Narrow a signer-shaped object to {@link Nip59Crypto}, or throw. */
export function requireNip59Crypto(crypto: Nip59CryptoInput): Nip59Crypto {
  const encrypt = crypto.nip44Encrypt;
  const decrypt = crypto.nip44Decrypt;
  if (!encrypt || !decrypt) {
    throw new Nip59Error("NIP-44 is required");
  }
  return {
    getPublicKey: () => crypto.getPublicKey(),
    signEvent: (unsigned) => crypto.signEvent(unsigned),
    nip44Encrypt: (peer, plaintext) => encrypt.call(crypto, peer, plaintext),
    nip44Decrypt: (peer, payload) => decrypt.call(crypto, peer, payload),
  };
}

export function requireNip44Decryptor(crypto: {
  nip44Decrypt?: (peer: string, payload: string) => Promise<string>;
}): Nip44Decryptor {
  const decrypt = crypto.nip44Decrypt;
  if (!decrypt) {
    throw new Nip59Error("NIP-44 is required");
  }
  return {
    nip44Decrypt: (peer, payload) => decrypt.call(crypto, peer, payload),
  };
}

export function rumorToJson(rumor: Rumor): string {
  return JSON.stringify({
    id: rumor.id,
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
  });
}

export function eventToJson(event: Event): string {
  return JSON.stringify({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  });
}

function defaultRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Nip59Error("randomInt bound must be a positive integer");
  }
  const bytes = randomBytes(4);
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return n % maxExclusive;
}

export function randomPastTimestamp(opts?: {
  now?: number;
  randomInt?: (maxExclusive: number) => number;
}): number {
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const offset = (opts?.randomInt ?? defaultRandomInt)(TWO_DAYS_SECS);
  return now - offset;
}

export function createRumor(
  pubkey: string,
  template: {
    kind: number;
    content?: string;
    tags?: readonly Tag[];
    created_at?: number;
  },
): Rumor {
  const unsigned: UnsignedEvent = {
    kind: template.kind,
    content: template.content ?? "",
    tags: template.tags ? [...template.tags] : [],
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    pubkey: assertHex32(pubkey, "public key"),
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

export async function createSeal(
  crypto: Nip59Crypto,
  recipient: string,
  rumor: Rumor,
  opts?: SealOptions,
): Promise<Event> {
  const sealer = requireNip59Crypto(crypto);
  const recipientPk = assertHex32(recipient, "public key");
  const encryptTo = opts?.encryptTo ? assertHex32(opts.encryptTo, "public key") : recipientPk;
  let content: string;
  try {
    content = await sealer.nip44Encrypt(encryptTo, rumorToJson(rumor));
  } catch (error) {
    throw new Nip59Error("failed to encrypt", { cause: error });
  }
  const created_at =
    opts?.timestamps?.seal ??
    (opts?.randomize === "wrap" ? rumor.created_at : randomPastTimestamp(opts));
  const pubkey = await sealer.getPublicKey();
  return sealer.signEvent({
    kind: Kind.Seal,
    content,
    created_at,
    tags: opts?.extraTags ? [...opts.extraTags] : [],
    pubkey,
  });
}

export function createGiftWrap(seal: Event, recipient: string, opts?: WrapOptions): Event {
  const recipientPk = assertHex32(recipient, "public key");
  const encryptTo = opts?.encryptTo ? assertHex32(opts.encryptTo, "public key") : recipientPk;
  const ephemeral = Keys.generate();
  const content = encryptToPubkey(eventToJson(seal), ephemeral.secretKey.bytes, encryptTo);
  const created_at = opts?.timestamps?.wrap ?? randomPastTimestamp(opts);
  const tags: Tag[] = [TagBuilder.p(recipientPk, opts?.relayHint), ...(opts?.extraTags ?? [])];
  return finalizeEvent(
    {
      kind: Kind.GiftWrap,
      content,
      created_at,
      tags,
    },
    ephemeral.secretKey,
  );
}

export async function wrap(
  crypto: Nip59Crypto,
  recipient: string,
  rumor: Rumor,
  opts?: WrapOptions,
): Promise<Event> {
  // extraTags are wrap-only; NIP-59 kind 13 tags MUST be empty unless createSeal is used.
  const seal = await createSeal(crypto, recipient, rumor, {
    now: opts?.now,
    randomInt: opts?.randomInt,
    timestamps: opts?.timestamps,
    encryptTo: opts?.encryptTo,
    randomize: opts?.randomize,
  });
  return createGiftWrap(seal, recipient, opts);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Nip59Error("invalid JSON", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRumor(value: unknown): Rumor {
  if (!isRecord(value)) {
    throw new Nip59Error("invalid rumor");
  }
  if (Object.hasOwn(value, "sig")) {
    throw new Nip59Error("rumor must be unsigned");
  }
  const givenId = value.id;
  if (!validateEvent(value)) {
    throw new Nip59Error("invalid rumor");
  }
  const unsigned: UnsignedEvent = {
    kind: value.kind,
    tags: value.tags,
    content: value.content,
    created_at: value.created_at,
    pubkey: value.pubkey.toLowerCase(),
  };
  const expected = getEventHash(unsigned);
  if (typeof givenId === "string" && givenId.toLowerCase() !== expected) {
    throw new Nip59Error("invalid rumor");
  }
  return { ...unsigned, id: expected };
}

async function decryptLayer(
  crypto: Nip44Decryptor,
  peer: string,
  payload: string,
): Promise<string> {
  try {
    return await crypto.nip44Decrypt(peer, payload);
  } catch (error) {
    throw new Nip59Error("failed to decrypt", { cause: error });
  }
}

export async function unwrap(crypto: Nip44Decryptor, giftWrap: Event): Promise<Rumor> {
  const decryptor = requireNip44Decryptor(crypto);
  if (!validateSignedEvent(giftWrap) || !isGiftWrapKind(giftWrap.kind)) {
    throw new Nip59Error("expected gift wrap");
  }

  const sealJson = await decryptLayer(decryptor, giftWrap.pubkey, giftWrap.content);
  const sealRaw = parseJson(sealJson);
  if (!validateSignedEvent(sealRaw)) {
    throw new Nip59Error("expected seal");
  }
  if (sealRaw.kind !== Kind.Seal) {
    throw new Nip59Error("expected seal");
  }
  if (!verifyEvent(sealRaw)) {
    throw new Nip59Error("seal signature");
  }

  const rumorJson = await decryptLayer(decryptor, sealRaw.pubkey, sealRaw.content);
  const rumor = parseRumor(parseJson(rumorJson));
  if (sealRaw.pubkey.toLowerCase() !== rumor.pubkey.toLowerCase()) {
    throw new Nip59Error("seal pubkey does not match rumor pubkey");
  }
  return rumor;
}
