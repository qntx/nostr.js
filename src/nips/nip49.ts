/**
 * NIP-49: Private Key Encryption (`ncryptsec`).
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/49.md
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { NostrError } from "../core/error.ts";
import { assertSecretKeyBytes } from "../core/util.ts";
import { Bech32MaxSize, encodeBytes } from "./nip19.ts";

export type Ncryptsec = `ncryptsec1${string}`;
export type KeySecurityByte = 0x00 | 0x01 | 0x02;

const VERSION = 0x02;
const SALT_LEN = 16;
const NONCE_LEN = 24;
const PAYLOAD_LEN = 91;
const LOGN_MIN = 1;
const LOGN_MAX = 22;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export class Nip49Error extends NostrError {}

function assertLogn(logn: number): void {
  if (!Number.isInteger(logn) || logn < LOGN_MIN || logn > LOGN_MAX) {
    throw new Nip49Error(`invalid logn ${logn}, expected integer ${LOGN_MIN}..${LOGN_MAX}`);
  }
}

function deriveKey(password: string, salt: Uint8Array, logn: number): Uint8Array {
  assertLogn(logn);
  const N = 2 ** logn;
  return scrypt(password.normalize("NFKC"), salt, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: 32,
    // noble 2.3: V (N blocks) + p B blocks + one tmp scratch block.
    maxmem: 128 * SCRYPT_R * (N + SCRYPT_P + 1),
  });
}

/** Encrypt a 32-byte secret key to an `ncryptsec` bech32 string. */
export function encrypt(
  secretKey: Uint8Array,
  password: string,
  logn: number = 16,
  ksb: KeySecurityByte = 0x02,
): Ncryptsec {
  assertSecretKeyBytes(secretKey);
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(password, salt, logn);
  const nonce = randomBytes(NONCE_LEN);
  const aad = Uint8Array.from([ksb]);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(secretKey);
  const bytes = concatBytes(
    Uint8Array.from([VERSION]),
    Uint8Array.from([logn]),
    salt,
    nonce,
    aad,
    ciphertext,
  );
  return encodeBytes("ncryptsec", bytes);
}

/** Decrypt an `ncryptsec` bech32 string to a 32-byte secret key. */
export function decrypt(ncryptsec: string, password: string): Uint8Array {
  let prefix: string;
  let b: Uint8Array;
  try {
    const decoded = bech32.decode(ncryptsec as `${string}1${string}`, Bech32MaxSize);
    prefix = decoded.prefix;
    b = new Uint8Array(bech32.fromWords(decoded.words));
  } catch (cause) {
    throw new Nip49Error("invalid ncryptsec", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (prefix !== "ncryptsec") {
    throw new Nip49Error(`invalid prefix ${prefix}, expected 'ncryptsec'`);
  }
  if (b.length !== PAYLOAD_LEN) {
    throw new Nip49Error("invalid ncryptsec length");
  }
  const version = b[0]!;
  if (version !== VERSION) {
    throw new Nip49Error(`invalid version ${version}, expected 0x02`);
  }
  const logn = b[1]!;
  const salt = b.subarray(2, 2 + SALT_LEN);
  const nonce = b.subarray(2 + SALT_LEN, 2 + SALT_LEN + NONCE_LEN);
  const ksb = b[2 + SALT_LEN + NONCE_LEN]!;
  const aad = Uint8Array.from([ksb]);
  const ciphertext = b.subarray(2 + SALT_LEN + NONCE_LEN + 1);
  try {
    const key = deriveKey(password, salt, logn);
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch (cause) {
    if (cause instanceof Nip49Error) throw cause;
    throw new Nip49Error("failed to decrypt", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}
