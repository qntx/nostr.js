import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilters } from "../core/filter.ts";
import { isAddressableKind, isEphemeralKind, isReplaceableKind, Kind } from "../core/kind.ts";
import { getDTag } from "../core/tag.ts";
import { sortEvents } from "../core/event.ts";
import type { EventStore, PutResult } from "./types.ts";

function replaceableKey(event: Event): string {
  if (isAddressableKind(event.kind)) {
    return `${event.kind}:${event.pubkey}:${getDTag(event.tags) ?? ""}`;
  }
  return `${event.kind}:${event.pubkey}`;
}

/**
 * In-memory event store with NIP-01 replaceable / addressable / ephemeral
 * handling and basic NIP-09 deletion (kind 5) application.
 */
export class MemoryEventStore implements EventStore {
  #byId = new Map<string, Event>();
  #replaceable = new Map<string, string>(); // key -> event id
  #deleted = new Set<string>();

  async put(event: Event): Promise<PutResult> {
    if (this.#deleted.has(event.id) || this.#byId.has(event.id)) {
      return "duplicate";
    }

    if (isEphemeralKind(event.kind)) {
      // Store briefly for local query symmetry; callers may ignore.
      this.#byId.set(event.id, event);
      return "ephemeral";
    }

    if (event.kind === Kind.EventDeletion) {
      for (const tag of event.tags) {
        if (tag[0] === "e" && tag[1]) {
          this.#deleted.add(tag[1]);
          this.#byId.delete(tag[1]);
          for (const [key, id] of this.#replaceable) {
            if (id === tag[1]) this.#replaceable.delete(key);
          }
        }
      }
      this.#byId.set(event.id, event);
      return "deleted";
    }

    if (isReplaceableKind(event.kind) || isAddressableKind(event.kind)) {
      const key = replaceableKey(event);
      const existingId = this.#replaceable.get(key);
      if (existingId) {
        const existing = this.#byId.get(existingId);
        if (existing) {
          if (existing.created_at > event.created_at) return "rejected";
          if (existing.created_at === event.created_at && existing.id > event.id) return "rejected";
          this.#byId.delete(existingId);
        }
      }
      this.#byId.set(event.id, event);
      this.#replaceable.set(key, event.id);
      return existingId ? "replaced" : "accepted";
    }

    this.#byId.set(event.id, event);
    return "accepted";
  }

  async get(id: string): Promise<Event | undefined> {
    if (this.#deleted.has(id)) return undefined;
    return this.#byId.get(id);
  }

  async query(filters: Filter[]): Promise<Event[]> {
    const events: Event[] = [];
    for (const event of this.#byId.values()) {
      if (this.#deleted.has(event.id)) continue;
      if (matchFilters(filters, event)) events.push(event);
    }
    sortEvents(events);
    const limit = filters.reduce(
      (min, f) => (f.limit !== undefined ? Math.min(min, f.limit) : min),
      Infinity,
    );
    if (Number.isFinite(limit)) return events.slice(0, limit);
    return events;
  }

  async remove(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      if (this.#byId.delete(id)) {
        n += 1;
        for (const [key, eid] of this.#replaceable) {
          if (eid === id) this.#replaceable.delete(key);
        }
      }
      this.#deleted.add(id);
    }
    return n;
  }

  async clear(): Promise<void> {
    this.#byId.clear();
    this.#replaceable.clear();
    this.#deleted.clear();
  }

  get size(): number {
    return this.#byId.size;
  }
}
