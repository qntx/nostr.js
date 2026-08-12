import { schnorr } from "@noble/curves/secp256k1.js";
import { CryptoError } from "./error.ts";
import {
  type Event,
  type EventTemplate,
  type UnsignedEvent,
  getEventHash,
  isMarkedFailed,
  isMarkedVerified,
  markUnverified,
  markVerified,
  validateEvent,
  validateSignedEvent,
} from "./event.ts";
import { assertHex32, assertSecretKeyBytes, bytesToHex, hexToBytes } from "./util.ts";

/** 32-byte secret key held as bytes; prefer zeroize when done. */
export class SecretKey {
  #bytes: Uint8Array | null;

  private constructor(bytes: Uint8Array) {
    assertSecretKeyBytes(bytes);
    this.#bytes = new Uint8Array(bytes);
  }

  static generate(): SecretKey {
    return new SecretKey(schnorr.utils.randomSecretKey());
  }

  static fromBytes(bytes: Uint8Array): SecretKey {
    return new SecretKey(bytes);
  }

  static fromHex(hex: string): SecretKey {
    return new SecretKey(hexToBytes(assertHex32(hex, "secret key")));
  }

  get bytes(): Uint8Array {
    if (!this.#bytes) throw new CryptoError("secret key has been zeroized");
    return new Uint8Array(this.#bytes);
  }

  toHex(): string {
    return bytesToHex(this.bytes);
  }

  /** Best-effort wipe of the internal buffer. */
  zeroize(): void {
    if (this.#bytes) {
      this.#bytes.fill(0);
      this.#bytes = null;
    }
  }
}

export type PublicKey = string;

export function publicKeyFromHex(hex: string): PublicKey {
  return assertHex32(hex, "public key");
}

export function getPublicKey(secretKey: SecretKey | Uint8Array | string): PublicKey {
  const bytes =
    secretKey instanceof SecretKey
      ? secretKey.bytes
      : typeof secretKey === "string"
        ? hexToBytes(assertHex32(secretKey, "secret key"))
        : (assertSecretKeyBytes(secretKey), secretKey);
  return bytesToHex(schnorr.getPublicKey(bytes));
}

/** Keypair convenience wrapper. */
export class Keys {
  readonly secretKey: SecretKey;
  readonly publicKey: PublicKey;

  private constructor(secretKey: SecretKey) {
    this.secretKey = secretKey;
    this.publicKey = getPublicKey(secretKey);
  }

  static generate(): Keys {
    return new Keys(SecretKey.generate());
  }

  static fromSecretKey(secretKey: SecretKey | Uint8Array | string): Keys {
    const sk =
      secretKey instanceof SecretKey
        ? secretKey
        : typeof secretKey === "string"
          ? SecretKey.fromHex(secretKey)
          : SecretKey.fromBytes(secretKey);
    return new Keys(sk);
  }
}

function resolveSecretKeyBytes(secretKey: SecretKey | Uint8Array | string): Uint8Array {
  if (secretKey instanceof SecretKey) return secretKey.bytes;
  if (typeof secretKey === "string") return hexToBytes(assertHex32(secretKey, "secret key"));
  assertSecretKeyBytes(secretKey);
  return secretKey;
}

/** Fill pubkey/id/sig on a template and return a signed event. */
export function finalizeEvent(
  template: EventTemplate,
  secretKey: SecretKey | Uint8Array | string,
): Event {
  const sk = resolveSecretKeyBytes(secretKey);
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const unsigned: UnsignedEvent = {
    kind: template.kind,
    tags: template.tags,
    content: template.content,
    created_at: template.created_at,
    pubkey,
  };
  return signEvent(unsigned, sk);
}

/**
 * Sign an already-assembled unsigned event.
 * Rejects when `unsigned.pubkey` does not match the secret key.
 */
export function signEvent(
  unsigned: UnsignedEvent,
  secretKey: SecretKey | Uint8Array | string,
): Event {
  const sk = resolveSecretKeyBytes(secretKey);
  if (!validateEvent(unsigned)) {
    throw new CryptoError("cannot sign invalid unsigned event");
  }

  const expected = bytesToHex(schnorr.getPublicKey(sk));
  if (unsigned.pubkey.toLowerCase() !== expected) {
    throw new CryptoError("unsigned event pubkey does not match secret key");
  }

  const normalized: UnsignedEvent = {
    kind: unsigned.kind,
    tags: unsigned.tags,
    content: unsigned.content,
    created_at: unsigned.created_at,
    pubkey: expected,
  };

  const id = getEventHash(normalized);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
  const event: Event = { ...normalized, id, sig };
  markVerified(event);
  return event;
}

/** Verify event id and BIP-340 signature. Uses WeakSet cache (does not mutate the event). */
export function verifyEvent(event: Event): boolean {
  if (isMarkedVerified(event)) return true;
  if (isMarkedFailed(event)) return false;

  if (!validateSignedEvent(event)) {
    markUnverified(event);
    return false;
  }

  try {
    const hash = getEventHash(event);
    if (hash !== event.id.toLowerCase()) {
      markUnverified(event);
      return false;
    }
    const ok = schnorr.verify(
      hexToBytes(event.sig.toLowerCase()),
      hexToBytes(hash),
      hexToBytes(event.pubkey.toLowerCase()),
    );
    if (ok) markVerified(event);
    else markUnverified(event);
    return ok;
  } catch {
    markUnverified(event);
    return false;
  }
}
