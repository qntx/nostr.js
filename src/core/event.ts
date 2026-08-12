import { EventValidationError } from "./error.ts";
import { isHex32, isHex64, utf8Encoder } from "./util.ts";
import type { Tag } from "./tag.ts";
import { isTag } from "./tag.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "./util.ts";

/** Wire event template before pubkey/id/sig. */
export type EventTemplate = {
  readonly kind: number;
  readonly tags: readonly Tag[];
  readonly content: string;
  readonly created_at: number;
};

/** Event with pubkey, ready to hash and sign. */
export type UnsignedEvent = EventTemplate & {
  readonly pubkey: string;
};

/**
 * Fully formed NIP-01 event (JSON-friendly plain object).
 * Fields are readonly at the type level; wire interop remains plain JSON.
 */
export type Event = UnsignedEvent & {
  readonly id: string;
  readonly sig: string;
};

/** Cache of events whose signatures have been verified successfully. */
const verifiedEvents = new WeakSet<object>();

/** Cache of events known to fail verification. */
const failedEvents = new WeakSet<object>();

export function markVerified(event: Event): void {
  verifiedEvents.add(event);
  failedEvents.delete(event);
}

export function markUnverified(event: Event): void {
  failedEvents.add(event);
  verifiedEvents.delete(event);
}

export function isMarkedVerified(event: Event): boolean {
  return verifiedEvents.has(event);
}

export function isMarkedFailed(event: Event): boolean {
  return failedEvents.has(event);
}

const isRecord = (obj: unknown): obj is Record<string, unknown> =>
  typeof obj === "object" && obj !== null && !Array.isArray(obj);

/** Structural validation of an unsigned event (no crypto). */
export function validateEvent(event: unknown): event is UnsignedEvent {
  if (!isRecord(event)) return false;
  if (typeof event.kind !== "number" || !Number.isInteger(event.kind)) return false;
  if (typeof event.content !== "string") return false;
  if (typeof event.created_at !== "number" || !Number.isInteger(event.created_at)) return false;
  if (typeof event.pubkey !== "string" || !isHex32(event.pubkey)) return false;
  if (!Array.isArray(event.tags)) return false;
  for (const tag of event.tags) {
    if (!isTag(tag)) return false;
  }
  return true;
}

/** Structural validation of a full event including id and sig hex shape. */
export function validateSignedEvent(event: unknown): event is Event {
  if (!validateEvent(event)) return false;
  const e = event as Record<string, unknown>;
  if (typeof e.id !== "string" || !isHex32(e.id)) return false;
  if (typeof e.sig !== "string" || !isHex64(e.sig)) return false;
  return true;
}

/**
 * Canonical NIP-01 serialization used for hashing:
 * JSON array `[0, pubkey, created_at, kind, tags, content]` with no extra whitespace.
 */
export function serializeEvent(event: UnsignedEvent): string {
  if (!validateEvent(event)) {
    throw new EventValidationError("cannot serialize event with invalid shape");
  }
  return JSON.stringify([
    0,
    event.pubkey.toLowerCase(),
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** SHA-256 of the canonical serialization, lowercase hex. */
export function getEventHash(event: UnsignedEvent): string {
  const serialized = serializeEvent(event);
  return bytesToHex(sha256(utf8Encoder.encode(serialized)));
}

function compareEventsDesc(a: Event, b: Event): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id.localeCompare(b.id);
}

/**
 * Sort events reverse-chronologically by `created_at`, then by `id` lexicographically.
 * Mutates and returns the array.
 */
export function sortEvents(events: Event[]): Event[] {
  return events.sort(compareEventsDesc);
}

/** Non-mutating sort; returns a new array. */
export function sortedEvents(events: readonly Event[]): Event[] {
  return events.slice().sort(compareEventsDesc);
}
