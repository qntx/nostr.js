/**
 * NIP-04 legacy encrypted direct messages.
 * Prefer NIP-44 for new applications.
 */
import { cbc } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { CryptoError } from "../core/error.ts";
import { assertHex32, hexToBytes, utf8Decoder, utf8Encoder } from "../core/util.ts";

function normalizeSharedSecret(privkey: Uint8Array, pubkey: string): Uint8Array {
  assertHex32(pubkey, "public key");
  const key = secp256k1.getSharedSecret(privkey, hexToBytes("02" + pubkey.toLowerCase()));
  return key.slice(1, 33);
}

function resolveSecret(secretKey: string | Uint8Array): Uint8Array {
  return typeof secretKey === "string"
    ? hexToBytes(assertHex32(secretKey, "secret key"))
    : secretKey;
}

/** Encrypt plaintext to a peer pubkey (NIP-04). */
export function encrypt(secretKey: string | Uint8Array, pubkey: string, text: string): string {
  const privkey = resolveSecret(secretKey);
  const normalizedKey = normalizeSharedSecret(privkey, pubkey);
  const iv = randomBytes(16);
  const plaintext = utf8Encoder.encode(text);
  const ciphertext = cbc(normalizedKey, iv).encrypt(plaintext);
  return `${base64.encode(ciphertext)}?iv=${base64.encode(iv)}`;
}

/** Decrypt a NIP-04 payload from a peer pubkey. */
export function decrypt(secretKey: string | Uint8Array, pubkey: string, data: string): string {
  const privkey = resolveSecret(secretKey);
  const parts = data.split("?iv=");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CryptoError("invalid NIP-04 payload: missing iv");
  }
  const normalizedKey = normalizeSharedSecret(privkey, pubkey);
  const iv = base64.decode(parts[1]);
  const ciphertext = base64.decode(parts[0]);
  const plaintext = cbc(normalizedKey, iv).decrypt(ciphertext);
  return utf8Decoder.decode(plaintext);
}
