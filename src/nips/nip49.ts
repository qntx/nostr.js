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

export class Nip49Error extends NostrError {}

/** Encrypt a 32-byte secret key to an `ncryptsec` bech32 string. */
export function encrypt(
  secretKey: Uint8Array,
  password: string,
  logn: number = 16,
  ksb: KeySecurityByte = 0x02,
): Ncryptsec {
  assertSecretKeyBytes(secretKey);
  const salt = randomBytes(SALT_LEN);
  const key = scrypt(password.normalize("NFKC"), salt, { N: 2 ** logn, r: 8, p: 1, dkLen: 32 });
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
  let words: number[];
  try {
    ({ prefix, words } = bech32.decode(ncryptsec as `${string}1${string}`, Bech32MaxSize));
  } catch (cause) {
    throw new Nip49Error("invalid ncryptsec", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (prefix !== "ncryptsec") {
    throw new Nip49Error(`invalid prefix ${prefix}, expected 'ncryptsec'`);
  }
  const b = new Uint8Array(bech32.fromWords(words));
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
    const key = scrypt(password.normalize("NFKC"), salt, { N: 2 ** logn, r: 8, p: 1, dkLen: 32 });
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch (cause) {
    throw new Nip49Error("failed to decrypt", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}
