import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";

export type PutResult =
  | "accepted"
  | "duplicate"
  | "replaced"
  | "rejected"
  | "ephemeral"
  | "deleted";

/** NIP-77 item: event id + created_at. Sorted created_at asc, then id. */
export type NegentropyItem = { id: string; created_at: number };

/** Inclusive created_at window of stored live events for one author+kind. */
export type OutboxBound = { oldest: number; newest: number };

/**
 * Event store contract (aligned with nula-storage NostrDatabase, narrowed for v0).
 * Implementations apply replaceable / addressable / deletion semantics on put.
 */
export interface EventStore {
  put(event: Event): Promise<PutResult>;
  /**
   * Persist in input order. IndexedDB: one transaction, abort rolls the batch back.
   * Memory: sequential; put does not throw, so a rejected item does not undo earlier accepts.
   */
  putMany(events: readonly Event[]): Promise<PutResult[]>;
  get(id: string): Promise<Event | undefined>;
  query(filters: Filter[]): Promise<Event[]>;
  /** Unique events matching `filters` (same cardinality as {@link query}). */
  count(filters: Filter[]): Promise<number>;
  /**
   * Matching `{ id, created_at }` for one filter, sorted created_at asc then id.
   * Does not allocate an `Event[]`.
   */
  negentropyItems(filter: Filter): Promise<NegentropyItem[]>;
  getOutboxBound(pubkey: string, kind: number): Promise<OutboxBound | undefined>;
  setOutboxBound(pubkey: string, kind: number, bound: OutboxBound): Promise<void>;
  /** Remove by id (does not publish NIP-09). */
  remove(ids: string[]): Promise<number>;
  clear(): Promise<void>;
}
