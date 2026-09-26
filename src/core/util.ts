import {
  bytesToHex as nobleBytesToHex,
  hexToBytes as nobleHexToBytes,
} from "@noble/hashes/utils.js";
import { HexError, UrlError } from "./error.ts";
import { SECRET_KEY_BYTES } from "./limits.ts";

export const utf8Encoder = new TextEncoder();
export const utf8Decoder = new TextDecoder();

const HEX32_RE = /^[0-9a-f]{64}$/;
const HEX64_RE = /^[0-9a-f]{128}$/;

/** Lowercase hex encode. */
export function bytesToHex(bytes: Uint8Array): string {
  return nobleBytesToHex(bytes);
}

/** Decode lowercase or mixed-case hex to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  try {
    return nobleHexToBytes(hex);
  } catch (cause) {
    throw new HexError(`invalid hex string of length ${hex.length}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

/** True when value is canonical NIP-01 lowercase hex of 32 bytes (64 chars). */
export function isHex32(value: string): boolean {
  return HEX32_RE.test(value);
}

/** True when value is canonical NIP-01 lowercase hex of 64 bytes (128 chars). */
export function isHex64(value: string): boolean {
  return HEX64_RE.test(value);
}

/** Caller input of any case: lowercases first, then requires canonical hex shape. */
export function assertHex32(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!isHex32(normalized)) {
    throw new HexError(`invalid ${label}: expected 64-char hex`);
  }
  return normalized;
}

export function assertByteLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.length !== expected) {
    throw new HexError(`invalid ${label} length: expected ${expected}, got ${bytes.length}`);
  }
}

export function assertSecretKeyBytes(bytes: Uint8Array): void {
  assertByteLength(bytes, SECRET_KEY_BYTES, "secret key");
}

/**
 * Normalize a relay URL to a stable form (wss preferred, no trailing slash, sorted query).
 */
export function normalizeURL(url: string): string {
  try {
    let input = url;
    if (!input.includes("://")) input = `wss://${input}`;
    const p = new URL(input);
    if (p.protocol === "http:") p.protocol = "ws:";
    else if (p.protocol === "https:") p.protocol = "wss:";
    p.pathname = p.pathname.replace(/\/+/g, "/");
    if (p.pathname.endsWith("/") && p.pathname.length > 1) {
      p.pathname = p.pathname.slice(0, -1);
    }
    if ((p.port === "80" && p.protocol === "ws:") || (p.port === "443" && p.protocol === "wss:")) {
      p.port = "";
    }
    p.searchParams.sort();
    p.hash = "";
    return p.toString();
  } catch (cause) {
    throw new UrlError(`invalid URL: ${url}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}
