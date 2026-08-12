import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";

export type PutResult =
  | "accepted"
  | "duplicate"
  | "replaced"
  | "rejected"
  | "ephemeral"
  | "deleted";

/**
 * Event store contract (aligned with nula-storage NostrDatabase, narrowed for v0).
 * Implementations apply replaceable / addressable / deletion semantics on put.
 */
export interface EventStore {
  put(event: Event): Promise<PutResult>;
  get(id: string): Promise<Event | undefined>;
  query(filters: Filter[]): Promise<Event[]>;
  /** Remove by id (does not publish NIP-09). */
  remove(ids: string[]): Promise<number>;
  clear(): Promise<void>;
}
