import type { Event } from "../core/event.ts";
import { itemCompare, sortEvents } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilter } from "../core/filter.ts";
import { eventAddress } from "../core/tag.ts";
import { DeletionState } from "./deletion.ts";
import { applyPutMemory, decidePut, outboxBoundKey, type PutLookup } from "./put.ts";
import type { EventStore, NegentropyItem, OutboxBound, PutResult } from "./types.ts";

/**
 * In-memory event store with NIP-01 replaceable / addressable / ephemeral
 * handling and NIP-09 deletion (kind 5) application.
 */
export class MemoryEventStore implements EventStore {
  #byId = new Map<string, Event>();
  #byPubkey = new Map<string, Set<string>>();
  #byKind = new Map<number, Set<string>>();
  #byKindPubkey = new Map<string, Set<string>>(); // `${kind}:${pubkey}` → ids
  #byEpTag = new Map<string, Set<string>>(); // `${"e"|"p"}:${value.toLowerCase()}` → ids
  #replaceable = new Map<string, string>(); // address -> event id
  #deletion = new DeletionState();
  #outboxBounds = new Map<string, OutboxBound>();

  async put(raw: Event): Promise<PutResult> {
    const lookup: PutLookup = {
      deletion: this.#deletion,
      getById: (id) => this.#byId.get(id),
      getReplaceable: (addr) => {
        const id = this.#replaceable.get(addr);
        const ev = id ? this.#byId.get(id) : undefined;
        return ev ? { id: ev.id, created_at: ev.created_at } : undefined;
      },
    };
    return applyPutMemory(
      {
        deletion: this.#deletion,
        indexInsert: (e) => this.#indexInsert(e),
        indexRemove: (id) => this.#indexRemove(id),
      },
      decidePut(raw, lookup),
    );
  }

  /** Sequential `put` in input order. No transaction: a throw leaves earlier events applied. */
  async putMany(events: readonly Event[]): Promise<PutResult[]> {
    const results: PutResult[] = [];
    for (const event of events) results.push(await this.put(event));
    return results;
  }

  async get(id: string): Promise<Event | undefined> {
    const key = id.toLowerCase();
    if (this.#deletion.ids.has(key)) return undefined;
    return this.#byId.get(key);
  }

  async query(filters: Filter[]): Promise<Event[]> {
    const seen = new Set<string>();
    const events: Event[] = [];
    for (const filter of filters) {
      for (const event of this.#matchedEvents(filter)) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
    }
    sortEvents(events);
    return events;
  }

  async count(filters: Filter[]): Promise<number> {
    const seen = new Set<string>();
    for (const filter of filters) {
      for (const event of this.#matchedEvents(filter)) seen.add(event.id);
    }
    return seen.size;
  }

  async negentropyItems(filter: Filter): Promise<NegentropyItem[]> {
    if (filter.limit === 0) return [];
    const items: NegentropyItem[] = [];
    this.#eachCandidate(filter, (event) => {
      if (this.#deletion.covers(event)) return;
      if (!matchFilter(filter, event)) return;
      items.push({ id: event.id, created_at: event.created_at });
    });
    if (filter.limit !== undefined) {
      items.sort(queryItemOrder);
      if (items.length > filter.limit) items.length = filter.limit;
    }
    items.sort(itemCompare);
    return items;
  }

  async remove(ids: string[]): Promise<number> {
    let n = 0;
    for (const raw of ids) {
      const id = raw.toLowerCase();
      if (this.#indexRemove(id)) n += 1;
      this.#deletion.ids.add(id);
      this.#deletion.pending.delete(id);
    }
    return n;
  }

  async getOutboxBound(pubkey: string, kind: number): Promise<OutboxBound | undefined> {
    const persisted = this.#outboxBounds.get(outboxBoundKey(pubkey, kind));
    if (persisted) return { oldest: persisted.oldest, newest: persisted.newest };
    return this.#deriveOutboxBound(pubkey, kind);
  }

  async setOutboxBound(pubkey: string, kind: number, bound: OutboxBound): Promise<void> {
    this.#outboxBounds.set(outboxBoundKey(pubkey, kind), {
      oldest: bound.oldest,
      newest: bound.newest,
    });
  }

  async clear(): Promise<void> {
    this.#byId.clear();
    this.#byPubkey.clear();
    this.#byKind.clear();
    this.#byKindPubkey.clear();
    this.#byEpTag.clear();
    this.#replaceable.clear();
    this.#deletion.clear();
    this.#outboxBounds.clear();
  }

  get size(): number {
    return this.#byId.size;
  }

  #indexInsert(event: Event): void {
    this.#byId.set(event.id, event);
    const pubkey = event.pubkey.toLowerCase();
    addToSet(this.#byPubkey, pubkey, event.id);
    addToSet(this.#byKind, event.kind, event.id);
    addToSet(this.#byKindPubkey, `${event.kind}:${pubkey}`, event.id);
    for (const tag of event.tags) {
      if ((tag[0] !== "e" && tag[0] !== "p") || tag[1] === undefined) continue;
      addToSet(this.#byEpTag, `${tag[0]}:${tag[1].toLowerCase()}`, event.id);
    }
    const addr = eventAddress(event);
    if (addr) this.#replaceable.set(addr, event.id);
  }

  #indexRemove(id: string): boolean {
    const key = id.toLowerCase();
    const event = this.#byId.get(key);
    if (!event) return false;
    this.#byId.delete(key);
    const pubkey = event.pubkey.toLowerCase();
    removeFromSet(this.#byPubkey, pubkey, key);
    removeFromSet(this.#byKind, event.kind, key);
    removeFromSet(this.#byKindPubkey, `${event.kind}:${pubkey}`, key);
    for (const tag of event.tags) {
      if ((tag[0] !== "e" && tag[0] !== "p") || tag[1] === undefined) continue;
      removeFromSet(this.#byEpTag, `${tag[0]}:${tag[1].toLowerCase()}`, key);
    }
    const addr = eventAddress(event);
    if (addr && this.#replaceable.get(addr) === key) this.#replaceable.delete(addr);
    return true;
  }

  #matchedEvents(filter: Filter): Event[] {
    if (filter.limit === 0) return [];
    const matched: Event[] = [];
    this.#eachCandidate(filter, (event) => {
      if (this.#deletion.covers(event)) return;
      if (!matchFilter(filter, event)) return;
      matched.push(event);
    });
    sortEvents(matched);
    return filter.limit !== undefined ? matched.slice(0, filter.limit) : matched;
  }

  #deriveOutboxBound(pubkey: string, kind: number): OutboxBound | undefined {
    const byPk = this.#byPubkey.get(pubkey.toLowerCase());
    const byKind = this.#byKind.get(kind);
    if (!byPk || !byKind) return undefined;
    let oldest: number | undefined;
    let newest: number | undefined;
    for (const id of byPk) {
      if (!byKind.has(id) || this.#deletion.ids.has(id)) continue;
      const event = this.#byId.get(id);
      if (!event || this.#deletion.covers(event)) continue;
      if (oldest === undefined || event.created_at < oldest) oldest = event.created_at;
      if (newest === undefined || event.created_at > newest) newest = event.created_at;
    }
    if (oldest === undefined || newest === undefined) return undefined;
    return { oldest, newest };
  }

  #eachCandidate(filter: Filter, visit: (event: Event) => void): void {
    if (filter.ids) {
      const seen = new Set<string>();
      for (const raw of filter.ids) {
        const event = this.#byId.get(raw.toLowerCase());
        if (!event || seen.has(event.id)) continue;
        seen.add(event.id);
        visit(event);
      }
      return;
    }

    if (filter.authors && filter.kinds) {
      const seen = new Set<string>();
      for (const pk of filter.authors) {
        const pubkey = pk.toLowerCase();
        for (const kind of filter.kinds) {
          const ids = this.#byKindPubkey.get(`${kind}:${pubkey}`);
          if (!ids) continue;
          for (const id of ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            const event = this.#byId.get(id);
            if (event) visit(event);
          }
        }
      }
      return;
    }

    if (filter.authors) {
      const seen = new Set<string>();
      for (const pk of filter.authors) {
        const byPk = this.#byPubkey.get(pk.toLowerCase());
        if (!byPk) continue;
        for (const id of byPk) {
          if (seen.has(id)) continue;
          seen.add(id);
          const event = this.#byId.get(id);
          if (event) visit(event);
        }
      }
      return;
    }

    if (filter.kinds) {
      const seen = new Set<string>();
      for (const kind of filter.kinds) {
        const byKind = this.#byKind.get(kind);
        if (!byKind) continue;
        for (const id of byKind) {
          if (seen.has(id)) continue;
          seen.add(id);
          const event = this.#byId.get(id);
          if (event) visit(event);
        }
      }
      return;
    }

    const eTags = filter["#e"];
    const pTags = filter["#p"];
    if (eTags !== undefined || pTags !== undefined) {
      const seen = new Set<string>();
      visitEpTagIds(this.#byEpTag, this.#byId, "e", eTags, seen, visit);
      visitEpTagIds(this.#byEpTag, this.#byId, "p", pTags, seen, visit);
      return;
    }

    // #t/#d and other non-e/p tags are not indexed (e/p only). A generic tag
    // store is extra put/remove amp; hashtag-only queries scan #byId.
    for (const event of this.#byId.values()) visit(event);
  }
}

function visitEpTagIds(
  byEpTag: Map<string, Set<string>>,
  byId: Map<string, Event>,
  name: "e" | "p",
  values: readonly string[] | undefined,
  seen: Set<string>,
  visit: (event: Event) => void,
): void {
  if (values === undefined) return;
  for (const value of values) {
    const ids = byEpTag.get(`${name}:${value.toLowerCase()}`);
    if (!ids) continue;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const event = byId.get(id);
      if (event) visit(event);
    }
  }
}

function addToSet<K>(map: Map<K, Set<string>>, key: K, id: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function removeFromSet<K>(map: Map<K, Set<string>>, key: K, id: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) map.delete(key);
}

function queryItemOrder(a: NegentropyItem, b: NegentropyItem): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id.localeCompare(b.id);
}
