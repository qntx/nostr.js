import { HexError, UrlError } from "./error.ts";
import { EVENT_ID_BYTES, PUBLIC_KEY_BYTES, SECRET_KEY_BYTES, SIGNATURE_BYTES } from "./limits.ts";

export const utf8Encoder = new TextEncoder();
export const utf8Decoder = new TextDecoder();

const HEX_RE = /^[0-9a-f]+$/;

/** Lowercase hex encode. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** Decode lowercase or mixed-case hex to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.toLowerCase();
  if (normalized.length % 2 !== 0 || !HEX_RE.test(normalized)) {
    throw new HexError(`invalid hex string of length ${hex.length}`);
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** True when value is a 64-char hex string (any case) — 32 bytes. */
export function isHex32(value: string): boolean {
  return value.length === 64 && HEX_RE.test(value.toLowerCase());
}

/** True when value is a 128-char hex string (any case) — 64 bytes. */
export function isHex64(value: string): boolean {
  return value.length === 128 && HEX_RE.test(value.toLowerCase());
}

export function assertHex32(value: string, label: string): string {
  if (!isHex32(value)) {
    throw new HexError(`invalid ${label}: expected 64-char hex`);
  }
  return value.toLowerCase();
}

export function assertByteLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.length !== expected) {
    throw new HexError(`invalid ${label} length: expected ${expected}, got ${bytes.length}`);
  }
}

export function assertSecretKeyBytes(bytes: Uint8Array): void {
  assertByteLength(bytes, SECRET_KEY_BYTES, "secret key");
}

export function assertPublicKeyBytes(bytes: Uint8Array): void {
  assertByteLength(bytes, PUBLIC_KEY_BYTES, "public key");
}

export function assertEventIdBytes(bytes: Uint8Array): void {
  assertByteLength(bytes, EVENT_ID_BYTES, "event id");
}

export function assertSignatureBytes(bytes: Uint8Array): void {
  assertByteLength(bytes, SIGNATURE_BYTES, "signature");
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
