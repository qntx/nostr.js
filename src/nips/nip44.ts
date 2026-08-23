import { chacha20 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { extract as hkdf_extract, expand as hkdf_expand } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { CryptoError } from "../core/error.ts";
import {
  assertHex32,
  assertSecretKeyBytes,
  hexToBytes,
  utf8Decoder,
  utf8Encoder,
} from "../core/util.ts";

const minPlaintextSize = 0x0001;
const maxPlaintextSize = 0xffffffff;
const extendedPrefixThreshold = 0x10000;

function assert32(bytes: Uint8Array, label: string): void {
  if (bytes.length !== 32) throw new CryptoError(`${label} must be 32 bytes`);
}

export function getConversationKey(privkeyA: Uint8Array, pubkeyB: string): Uint8Array {
  assertSecretKeyBytes(privkeyA);
  assertHex32(pubkeyB, "public key");
  const sharedX = secp256k1
    .getSharedSecret(privkeyA, hexToBytes("02" + pubkeyB.toLowerCase()))
    .subarray(1, 33);
  return hkdf_extract(sha256, sharedX, utf8Encoder.encode("nip44-v2"));
}

function getMessageKeys(
  conversationKey: Uint8Array,
  nonce: Uint8Array,
): { chacha_key: Uint8Array; chacha_nonce: Uint8Array; hmac_key: Uint8Array } {
  assert32(conversationKey, "conversation_key");
  assert32(nonce, "nonce");
  const keys = hkdf_expand(sha256, conversationKey, nonce, 76);
  return {
    chacha_key: keys.subarray(0, 32),
    chacha_nonce: keys.subarray(32, 44),
    hmac_key: keys.subarray(44, 76),
  };
}

export function calcPaddedLen(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1) throw new CryptoError("expected positive integer");
  if (len <= 32) return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function writeU16BE(num: number): Uint8Array {
  if (!Number.isSafeInteger(num) || num < minPlaintextSize || num > 0xffff) {
    throw new CryptoError("invalid plaintext size: must be between 1 and 65535 bytes");
  }
  const arr = new Uint8Array(2);
  new DataView(arr.buffer).setUint16(0, num, false);
  return arr;
}

function writeU32BE(num: number): Uint8Array {
  if (!Number.isSafeInteger(num) || num < extendedPrefixThreshold || num > maxPlaintextSize) {
    throw new CryptoError("invalid plaintext size: must be between 65536 and 4294967295 bytes");
  }
  const arr = new Uint8Array(4);
  new DataView(arr.buffer).setUint32(0, num, false);
  return arr;
}

function pad(plaintext: string): Uint8Array {
  const unpadded = utf8Encoder.encode(plaintext);
  const unpaddedLen = unpadded.length;
  if (unpaddedLen < minPlaintextSize || unpaddedLen > maxPlaintextSize) {
    throw new CryptoError("invalid plaintext size: must be between 1 and 4294967295 bytes");
  }
  const prefix =
    unpaddedLen >= extendedPrefixThreshold
      ? concatBytes(new Uint8Array([0, 0]), writeU32BE(unpaddedLen))
      : writeU16BE(unpaddedLen);
  const suffix = new Uint8Array(calcPaddedLen(unpaddedLen) - unpaddedLen);
  return concatBytes(prefix, unpadded, suffix);
}

function unpad(padded: Uint8Array): string {
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const firstTwo = dv.getUint16(0);
  let unpaddedLen: number;
  let prefixLen: number;
  if (firstTwo === 0) {
    unpaddedLen = dv.getUint32(2);
    if (unpaddedLen < extendedPrefixThreshold) throw new CryptoError("invalid padding");
    prefixLen = 6;
  } else {
    unpaddedLen = firstTwo;
    prefixLen = 2;
  }
  const unpadded = padded.subarray(prefixLen, prefixLen + unpaddedLen);
  if (
    unpaddedLen < minPlaintextSize ||
    unpaddedLen > maxPlaintextSize ||
    unpadded.length !== unpaddedLen ||
    padded.length !== prefixLen + calcPaddedLen(unpaddedLen)
  ) {
    throw new CryptoError("invalid padding");
  }
  return utf8Decoder.decode(unpadded);
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new CryptoError("AAD associated data must be 32 bytes");
  return hmac(sha256, key, concatBytes(aad, message));
}

function decodePayload(payload: string): {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  mac: Uint8Array;
} {
  if (typeof payload !== "string") throw new CryptoError("payload must be a valid string");
  if (payload.length < 132) throw new CryptoError("invalid payload length: " + payload.length);
  if (payload[0] === "#") throw new CryptoError("unknown encryption version");
  let data: Uint8Array;
  try {
    data = base64.decode(payload);
  } catch (error) {
    throw new CryptoError(
      "invalid base64: " + (error instanceof Error ? error.message : "decode failed"),
    );
  }
  if (data.length < 99) throw new CryptoError("invalid data length: " + data.length);
  if (data[0] !== 2) throw new CryptoError("unknown encryption version " + data[0]);
  return {
    nonce: data.subarray(1, 33),
    ciphertext: data.subarray(33, -32),
    mac: data.subarray(-32),
  };
}

export function encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
  const padded = pad(plaintext);
  const ciphertext = chacha20(chacha_key, chacha_nonce, padded);
  const mac = hmacAad(hmac_key, ciphertext, nonce);
  return base64.encode(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac));
}

export function decrypt(payload: string, conversationKey: Uint8Array): string {
  const { nonce, ciphertext, mac } = decodePayload(payload);
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
  const calculatedMac = hmacAad(hmac_key, ciphertext, nonce);
  if (!equalBytes(calculatedMac, mac)) throw new CryptoError("invalid MAC");
  const padded = chacha20(chacha_key, chacha_nonce, ciphertext);
  return unpad(padded);
}

/** Convenience: derive conversation key from secret/public pair and encrypt. */
export function encryptToPubkey(
  plaintext: string,
  secretKey: Uint8Array,
  peerPubkey: string,
): string {
  return encrypt(plaintext, getConversationKey(secretKey, peerPubkey));
}

/** Convenience: decrypt a payload from a peer pubkey. */
export function decryptFromPubkey(
  payload: string,
  secretKey: Uint8Array,
  peerPubkey: string,
): string {
  return decrypt(payload, getConversationKey(secretKey, peerPubkey));
}
