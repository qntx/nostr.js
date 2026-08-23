import type { Event } from "../core/event.ts";
import { sortEvents } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilter } from "../core/filter.ts";
import { isEphemeralKind, Kind } from "../core/kind.ts";
import { eventAddress } from "../core/tag.ts";
import { coordinateRemovals, DeletionState, planDeletion } from "./deletion.ts";
import type { EventStore, PutResult } from "./types.ts";

/**
 * In-memory event store with NIP-01 replaceable / addressable / ephemeral
 * handling and NIP-09 deletion (kind 5) application.
 */
export class MemoryEventStore implements EventStore {
  #byId = new Map<string, Event>();
  #replaceable = new Map<string, string>(); // address -> event id
  #deletion = new DeletionState();

  async put(event: Event): Promise<PutResult> {
    if (this.#deletion.ids.has(event.id) || this.#byId.has(event.id)) {
      return "duplicate";
    }

    if (event.kind === Kind.EventDeletion) {
      this.#deletion.pending.delete(event.id);
      const plan = planDeletion(event, (id) => this.#byId.get(id));
      this.#deletion.absorb(plan);
      for (const id of plan.removeIds) {
        this.#drop(id);
      }
      for (const id of coordinateRemovals(plan.coordinates, (key) => {
        const existingId = this.#replaceable.get(key);
        return existingId ? this.#byId.get(existingId) : undefined;
      })) {
        this.#deletion.ids.add(id);
        this.#drop(id);
      }
      this.#byId.set(event.id, event);
      return "deleted";
    }

    if (this.#deletion.covers(event)) {
      this.#deletion.ids.add(event.id);
      this.#deletion.pending.delete(event.id);
      return "duplicate";
    }

    if (isEphemeralKind(event.kind)) {
      this.#byId.set(event.id, event);
      return "ephemeral";
    }

    const key = eventAddress(event);
    if (key) {
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
    if (this.#deletion.ids.has(id)) return undefined;
    return this.#byId.get(id);
  }

  async query(filters: Filter[]): Promise<Event[]> {
    const seen = new Set<string>();
    const events: Event[] = [];
    for (const filter of filters) {
      const matched: Event[] = [];
      for (const event of this.#byId.values()) {
        if (this.#deletion.ids.has(event.id)) continue;
        if (matchFilter(filter, event)) matched.push(event);
      }
      sortEvents(matched);
      const slice = filter.limit !== undefined ? matched.slice(0, filter.limit) : matched;
      for (const event of slice) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
    }
    sortEvents(events);
    return events;
  }

  async remove(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      if (this.#byId.delete(id)) {
        n += 1;
        this.#dropReplaceable(id);
      }
      this.#deletion.ids.add(id);
      this.#deletion.pending.delete(id);
    }
    return n;
  }

  async clear(): Promise<void> {
    this.#byId.clear();
    this.#replaceable.clear();
    this.#deletion.clear();
  }

  get size(): number {
    return this.#byId.size;
  }

  #drop(id: string): void {
    this.#byId.delete(id);
    this.#dropReplaceable(id);
  }

  #dropReplaceable(id: string): void {
    for (const [key, eid] of this.#replaceable) {
      if (eid === id) this.#replaceable.delete(key);
    }
  }
}
