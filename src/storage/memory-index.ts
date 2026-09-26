import type { Event } from "../core/event.ts";
import { compareEventsDesc, itemCompare, sortEvents } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { matchFilter } from "../core/filter.ts";
import { eventAddress, formatEventAddress, parseEventAddress } from "../core/tag.ts";
import { DeletionState } from "./deletion.ts";
import { applyPutMemory, decidePut, outboxBoundKey, type PutLookup } from "./put.ts";
import type { NegentropyItem, OutboxBound, PutResult } from "./types.ts";

export type MemoryIndexOptions = {
  /**
   * FIFO cap applied independently to each deletion-state collection:
   * tombstoned event ids, pending e-tag ids, and coordinate tombstones.
   * Default unbounded. Trade-off: once an entry is trimmed, a re-arriving
   * old deleted event or replaceable version can be accepted again.
   */
  maxTombstones?: number;
  /**
   * FIFO cap on replaceable/addressable winner watermarks recorded by
   * {@link evict}. A watermark keeps only `{ id, created_at }` per address so
   * stale versions stay rejected after the winner's body is evicted, and a
   * re-put of the watermarked id re-inserts it. Default 0 (no watermark
   * retention); callers that evict should pass a bound. Once a watermark is
   * trimmed, an older evicted version can be accepted again — the same
   * trade-off as deletion tombstones.
   */
  maxWatermarks?: number;
  /** Fires after every physical index insert (accept, replace, deletion event). */
  onInsert?(event: Event): void;
  /** Fires after every physical index remove (replace, delete, evict, remove, clear). */
  onRemove?(event: Event): void;
};

/**
 * Synchronous in-memory event index with NIP-01 replaceable / addressable /
 * ephemeral handling and NIP-09 deletion (kind 5) application. Shared by
 * {@link MemoryEventStore} (async facade) and `ReactiveEventStore`.
 */
export class MemoryIndex {
  #byId = new Map<string, Event>();
  #byPubkey = new Map<string, Set<string>>();
  #byKind = new Map<number, Set<string>>();
  #byKindPubkey = new Map<string, Set<string>>(); // `${kind}:${pubkey}` → ids
  #byEpTag = new Map<string, Set<string>>(); // `${"e"|"p"}:${value.toLowerCase()}` → ids
  #replaceable = new Map<string, string>(); // address -> event id
  // address -> last evicted winner; insertion order is the FIFO trim order
  #watermarks = new Map<string, { id: string; created_at: number }>();
  // winner id -> address reverse index for O(1) watermark drops on deletion
  #watermarkIds = new Map<string, string>();
  #deletion = new DeletionState();
  #outboxBounds = new Map<string, OutboxBound>();
  #maxTombstones: number | undefined;
  #maxWatermarks: number;
  #onInsert: ((event: Event) => void) | undefined;
  #onRemove: ((event: Event) => void) | undefined;

  constructor(opts?: MemoryIndexOptions) {
    this.#maxTombstones = opts?.maxTombstones;
    this.#maxWatermarks = opts?.maxWatermarks ?? 0;
    this.#onInsert = opts?.onInsert === undefined ? undefined : (event) => opts.onInsert?.(event);
    this.#onRemove = opts?.onRemove === undefined ? undefined : (event) => opts.onRemove?.(event);
  }

  put(raw: Event): PutResult {
    const lookup: PutLookup = {
      deletion: this.#deletion,
      getById: (id) => this.#byId.get(id),
      getReplaceable: (addr) => {
        const id = this.#replaceable.get(addr);
        const ev = id ? this.#byId.get(id) : undefined;
        if (ev) return { id: ev.id, created_at: ev.created_at };
        const watermark = this.#watermarks.get(addr);
        return watermark === undefined ? undefined : { ...watermark, evicted: true };
      },
    };
    const decision = decidePut(raw, lookup);
    if (decision.action === "delete") {
      // Pending e-tag targets and coordinate tombstones never reach
      // indexRemove — drop their watermarks here.
      for (const p of decision.plan.pendingIds) this.#dropWatermarkId(p.id);
      for (const c of decision.plan.coordinates) this.#dropWatermark(c.key);
    }
    const result = applyPutMemory(
      {
        deletion: this.#deletion,
        indexInsert: (e) => this.#indexInsert(e),
        indexRemove: (id) => this.#indexRemove(id),
      },
      decision,
    );
    this.#trimTombstones();
    return result;
  }

  /** Sequential `put` in input order. */
  putMany(events: readonly Event[]): PutResult[] {
    const results: PutResult[] = [];
    for (const event of events) results.push(this.put(event));
    return results;
  }

  get(id: string): Event | undefined {
    const key = id.toLowerCase();
    if (this.#deletion.ids.has(key)) return undefined;
    return this.#byId.get(key);
  }

  /** Current event at a `kind:pubkey:d` coordinate (replaceable or addressable). */
  getByAddress(address: string): Event | undefined {
    const coord = parseEventAddress(address);
    if (!coord) return undefined;
    const id = this.#replaceable.get(
      formatEventAddress(coord.kind, coord.pubkey, coord.identifier),
    );
    if (id === undefined) return undefined;
    const key = id.toLowerCase();
    if (this.#deletion.ids.has(key)) return undefined;
    return this.#byId.get(key);
  }

  query(filters: readonly Filter[]): Event[] {
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

  count(filters: readonly Filter[]): number {
    const seen = new Set<string>();
    for (const filter of filters) {
      for (const event of this.#matchedEvents(filter)) seen.add(event.id);
    }
    return seen.size;
  }

  negentropyItems(filter: Filter): NegentropyItem[] {
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

  /** Remove by id and tombstone (like a local NIP-09). Returns removed count. */
  remove(ids: readonly string[]): number {
    let n = 0;
    for (const raw of ids) {
      const id = raw.toLowerCase();
      if (this.#indexRemove(id)) n += 1;
      this.#deletion.ids.add(id);
      this.#deletion.pending.delete(id);
    }
    this.#trimTombstones();
    return n;
  }

  /**
   * Remove by id without writing a tombstone (LRU eviction). When the evicted
   * event is the current winner of a replaceable/addressable address, a
   * `{ id, created_at }` watermark is recorded so stale versions stay
   * rejected while the body is gone; the watermarks are FIFO-bounded by
   * `maxWatermarks`.
   */
  evict(ids: readonly string[]): number {
    let n = 0;
    for (const raw of ids) {
      const id = raw.toLowerCase();
      const event = this.#byId.get(id);
      if (event === undefined) continue;
      const addr = eventAddress(event);
      const winner = addr !== undefined && this.#replaceable.get(addr) === id;
      if (this.#indexRemove(id)) n += 1;
      if (winner) this.#setWatermark(addr, { id, created_at: event.created_at });
    }
    return n;
  }

  /**
   * True when the id is tombstoned, or the coordinate has a deletion marker
   * that still covers the current event at that address: a replacement
   * published after the marker's `until` clears the deletion. Coordinates are
   * matched on the canonical lowercase pubkey.
   */
  isDeleted(idOrAddress: string): boolean {
    if (this.#deletion.ids.has(idOrAddress.toLowerCase())) return true;
    const coord = parseEventAddress(idOrAddress);
    if (!coord) return false;
    const address = formatEventAddress(coord.kind, coord.pubkey, coord.identifier);
    const until = this.#deletion.coordinates.get(address);
    if (until === undefined) return false;
    const id = this.#replaceable.get(address);
    if (id === undefined) return true;
    const event = this.#byId.get(id);
    return event === undefined || event.created_at <= until;
  }

  getOutboxBound(pubkey: string, kind: number): OutboxBound | undefined {
    const persisted = this.#outboxBounds.get(outboxBoundKey(pubkey, kind));
    if (persisted) return { oldest: persisted.oldest, newest: persisted.newest };
    return this.#deriveOutboxBound(pubkey, kind);
  }

  setOutboxBound(pubkey: string, kind: number, bound: OutboxBound): void {
    this.#outboxBounds.set(outboxBoundKey(pubkey, kind), {
      oldest: bound.oldest,
      newest: bound.newest,
    });
  }

  clear(): void {
    if (this.#onRemove) {
      for (const event of this.#byId.values()) this.#onRemove(event);
    }
    this.#byId.clear();
    this.#byPubkey.clear();
    this.#byKind.clear();
    this.#byKindPubkey.clear();
    this.#byEpTag.clear();
    this.#replaceable.clear();
    this.#watermarks.clear();
    this.#watermarkIds.clear();
    this.#deletion.clear();
    this.#outboxBounds.clear();
  }

  get size(): number {
    return this.#byId.size;
  }

  #indexInsert(event: Event): void {
    this.#byId.set(event.id, event);
    const pubkey = event.pubkey;
    addToSet(this.#byPubkey, pubkey, event.id);
    addToSet(this.#byKind, event.kind, event.id);
    addToSet(this.#byKindPubkey, `${event.kind}:${pubkey}`, event.id);
    for (const tag of event.tags) {
      if ((tag[0] !== "e" && tag[0] !== "p") || tag[1] === undefined) continue;
      addToSet(this.#byEpTag, `${tag[0]}:${tag[1].toLowerCase()}`, event.id);
    }
    const addr = eventAddress(event);
    if (addr) {
      this.#replaceable.set(addr, event.id);
      this.#dropWatermark(addr);
    }
    this.#onInsert?.(event);
  }

  #indexRemove(id: string): boolean {
    const key = id;
    // A removed/deleted id must not keep a stale watermark alive; eviction
    // re-records its winner watermark right after this call.
    this.#dropWatermarkId(key);
    const event = this.#byId.get(key);
    if (!event) return false;
    this.#byId.delete(key);
    const pubkey = event.pubkey;
    removeFromSet(this.#byPubkey, pubkey, key);
    removeFromSet(this.#byKind, event.kind, key);
    removeFromSet(this.#byKindPubkey, `${event.kind}:${pubkey}`, key);
    for (const tag of event.tags) {
      if ((tag[0] !== "e" && tag[0] !== "p") || tag[1] === undefined) continue;
      removeFromSet(this.#byEpTag, `${tag[0]}:${tag[1].toLowerCase()}`, key);
    }
    const addr = eventAddress(event);
    if (addr && this.#replaceable.get(addr) === key) this.#replaceable.delete(addr);
    this.#onRemove?.(event);
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

  #setWatermark(addr: string, watermark: { id: string; created_at: number }): void {
    if (this.#maxWatermarks === 0) return;
    this.#dropWatermark(addr);
    this.#watermarks.set(addr, watermark);
    this.#watermarkIds.set(watermark.id, addr);
    while (this.#watermarks.size > this.#maxWatermarks) {
      const oldest = this.#watermarks.keys().next();
      if (oldest.done) break;
      this.#dropWatermark(oldest.value);
    }
  }

  #dropWatermark(addr: string): void {
    const watermark = this.#watermarks.get(addr);
    if (watermark === undefined) return;
    this.#watermarks.delete(addr);
    this.#watermarkIds.delete(watermark.id);
  }

  #dropWatermarkId(id: string): void {
    const addr = this.#watermarkIds.get(id);
    if (addr === undefined) return;
    this.#watermarkIds.delete(id);
    this.#watermarks.delete(addr);
  }

  #trimTombstones(): void {
    const cap = this.#maxTombstones;
    if (cap === undefined) return;
    let excess = this.#deletion.ids.size - cap;
    for (const id of this.#deletion.ids) {
      if (excess <= 0) break;
      this.#deletion.ids.delete(id);
      this.#deletion.pending.delete(id);
      excess--;
    }
    excess = this.#deletion.pending.size - cap;
    for (const id of this.#deletion.pending.keys()) {
      if (excess <= 0) break;
      this.#deletion.pending.delete(id);
      excess--;
    }
    excess = this.#deletion.coordinates.size - cap;
    for (const key of this.#deletion.coordinates.keys()) {
      if (excess <= 0) break;
      this.#deletion.coordinates.delete(key);
      excess--;
    }
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
  return compareEventsDesc(a, b);
}
