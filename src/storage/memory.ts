import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { MemoryIndex } from "./memory-index.ts";
import type { EventStore, NegentropyItem, OutboxBound, PutResult } from "./types.ts";

/**
 * In-memory event store: async {@link EventStore} facade over the synchronous
 * {@link MemoryIndex}.
 */
export class MemoryEventStore implements EventStore {
  #index = new MemoryIndex();

  async put(raw: Event): Promise<PutResult> {
    return this.#index.put(raw);
  }

  /** Sequential `put` in input order. No transaction: a throw leaves earlier events applied. */
  async putMany(events: readonly Event[]): Promise<PutResult[]> {
    const results: PutResult[] = [];
    for (const event of events) results.push(await this.put(event));
    return results;
  }

  async get(id: string): Promise<Event | undefined> {
    return this.#index.get(id);
  }

  async query(filters: Filter[]): Promise<Event[]> {
    return this.#index.query(filters);
  }

  async count(filters: Filter[]): Promise<number> {
    return this.#index.count(filters);
  }

  async negentropyItems(filter: Filter): Promise<NegentropyItem[]> {
    return this.#index.negentropyItems(filter);
  }

  async remove(ids: string[]): Promise<number> {
    return this.#index.remove(ids);
  }

  async getOutboxBound(pubkey: string, kind: number): Promise<OutboxBound | undefined> {
    return this.#index.getOutboxBound(pubkey, kind);
  }

  async setOutboxBound(pubkey: string, kind: number, bound: OutboxBound): Promise<void> {
    this.#index.setOutboxBound(pubkey, kind, bound);
  }

  async clear(): Promise<void> {
    this.#index.clear();
  }

  get size(): number {
    return this.#index.size;
  }
}
