import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { filterFingerprint, matchFilters } from "../core/filter.ts";
import { formatEventAddress, eventAddress } from "../core/tag.ts";
import { normalizeURL } from "../core/util.ts";
import { MemoryIndex } from "../storage/memory-index.ts";
import type { PutResult } from "../storage/types.ts";

export interface Watch<T> {
  subscribe(onChange: () => void): () => void;
  getSnapshot(): T;
}

export type ReactiveEventStoreOptions = {
  /** Max stored events before LRU eviction. Default 50_000. */
  maxEvents?: number;
  /** Max ids tracked by `seenOn`. Default 20_000. */
  maxSeenOnEntries?: number;
  /** FIFO cap on tombstoned deletion ids. Default 100_000. */
  maxTombstones?: number;
};

const SEEN_ON_PER_ID = 16;

type WatchKind = "event" | "replaceable" | "query";

/** Structural handle the store needs for invalidation; implemented by WatchImpl. */
interface WatchHandle {
  readonly kind: WatchKind;
  readonly key: string;
  readonly filters: readonly Filter[] | undefined;
  readonly subscribed: boolean;
  readonly pinnedIds: readonly string[];
  _markDirty(): void;
  _notify(): void;
}

class WatchImpl<T> implements Watch<T>, WatchHandle {
  readonly store: ReactiveEventStore;
  readonly kind: WatchKind;
  readonly key: string;
  readonly filters: readonly Filter[] | undefined;
  readonly compute: () => T;
  readonly equal: (a: T, b: T) => boolean;
  readonly snapshotIds: (snapshot: T) => readonly string[];
  #subscribers = new Set<() => void>();
  #snapshot: T;
  #version = -1;
  #dirty = false;
  #pendingRemove = false;

  constructor(
    store: ReactiveEventStore,
    kind: WatchKind,
    key: string,
    compute: () => T,
    equal: (a: T, b: T) => boolean,
    snapshotIds: (snapshot: T) => readonly string[],
    filters?: readonly Filter[],
  ) {
    this.store = store;
    this.kind = kind;
    this.key = key;
    this.filters = filters;
    this.compute = compute;
    this.equal = equal;
    this.snapshotIds = snapshotIds;
    this.#snapshot = compute();
    this.#version = store._version;
  }

  get subscribed(): boolean {
    return this.#subscribers.size > 0;
  }

  get pinnedIds(): readonly string[] {
    return this.snapshotIds(this.#snapshot);
  }

  subscribe(onChange: () => void): () => void {
    const wasUnsubscribed = this.#subscribers.size === 0;
    this.#subscribers.add(onChange);
    this.#pendingRemove = false;
    // Writes that landed while unregistered must not be lost.
    if (wasUnsubscribed && this.#version !== this.store._version) this.#dirty = true;
    this.store._register(this);
    return () => {
      this.#subscribers.delete(onChange);
      if (this.#subscribers.size > 0 || this.#pendingRemove) return;
      this.#pendingRemove = true;
      queueMicrotask(() => {
        if (this.#pendingRemove) this.store._unregister(this);
      });
    };
  }

  getSnapshot(): T {
    if (this.subscribed ? this.#dirty : this.#version !== this.store._version) {
      const next = this.compute();
      if (!this.equal(next, this.#snapshot)) this.#snapshot = next;
      this.#version = this.store._version;
      this.#dirty = false;
    }
    return this.#snapshot;
  }

  _markDirty(): void {
    this.#dirty = true;
  }

  _notify(): void {
    // Do not sync #version here: subscribers will call getSnapshot, which
    // recomputes against the bumped store version and keeps the reference
    // when the result is element-wise identical.
    for (const onChange of this.#subscribers) onChange();
  }
}

const EVENT_IDS = (e: Event | undefined): readonly string[] => (e ? [e.id] : []);
const LIST_IDS = (events: readonly Event[]): readonly string[] => events.map((e) => e.id);

function sameRef(a: Event | undefined, b: Event | undefined): boolean {
  return a === b;
}

function sameList(a: readonly Event[], b: readonly Event[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Synchronous reactive in-memory event store backed by {@link MemoryIndex}.
 * The single read source for Nostr events on the UI side: `Watch` snapshots
 * keep referential stability for `useSyncExternalStore` and are invalidated
 * on matching writes, deletions and tombstones. Writes batch notifications
 * into one microtask flush.
 */
export class ReactiveEventStore {
  #index: MemoryIndex;
  #maxEvents: number;
  #maxSeenOnEntries: number;

  _version = 0;

  // id -> recency-ordered access order (delete+add moves to the newest end)
  #recency = new Set<string>();
  // id -> relay urls (≤ SEEN_ON_PER_ID); Map insertion order for eviction
  #seenOn = new Map<string, string[]>();

  #idWatches = new Map<string, Set<WatchHandle>>();
  #addressWatches = new Map<string, Set<WatchHandle>>();
  #queryCache = new Map<string, WatchImpl<readonly Event[]>>();
  #queryRegistry = new Set<WatchHandle>();

  #dirty = new Set<WatchHandle>();
  #flushScheduled = false;
  #insertListeners = new Set<(event: Event) => void>();

  constructor(opts?: ReactiveEventStoreOptions) {
    this.#maxEvents = opts?.maxEvents ?? 50_000;
    this.#maxSeenOnEntries = opts?.maxSeenOnEntries ?? 20_000;
    this.#index = new MemoryIndex({
      maxTombstones: opts?.maxTombstones ?? 100_000,
      onInsert: (event) => this.#onInsert(event),
      onRemove: (event) => this.#onRemove(event),
    });
  }

  add(event: Event, relayUrl?: string): PutResult {
    const result = this.#index.put(event);
    if (relayUrl !== undefined && result !== "ephemeral" && result !== "rejected") {
      this.#recordSeen(event.id, relayUrl);
    }
    this.#evictIfNeeded();
    return result;
  }

  addMany(events: readonly Event[], relayUrl?: string): PutResult[] {
    const results: PutResult[] = [];
    for (const event of events) results.push(this.add(event, relayUrl));
    return results;
  }

  /** Record a relay sighting for an id already in the index. No notification. */
  markSeen(id: string, relayUrl: string): boolean {
    const key = id.toLowerCase();
    if (this.#index.get(key) === undefined) return false;
    this.#recordSeen(key, relayUrl);
    return true;
  }

  /** Bulk load (initial hydration): no seenOn, one batched notification. */
  hydrate(events: readonly Event[]): void {
    for (const event of events) this.#index.put(event);
    this.#evictIfNeeded();
  }

  remove(ids: readonly string[]): number {
    return this.#index.remove(ids);
  }

  clear(): void {
    this.#index.clear();
    this.#seenOn.clear();
    this.#recency.clear();
    this._version += 1;
    this.#invalidateAll();
  }

  get(id: string): Event | undefined {
    const event = this.#index.get(id);
    if (event) this.#touch(event.id);
    return event;
  }

  getReplaceable(kind: number, pubkey: string, d?: string): Event | undefined {
    return this.getByAddress(formatEventAddress(kind, pubkey, d ?? ""));
  }

  getByAddress(address: string): Event | undefined {
    const event = this.#index.getByAddress(address);
    if (event) this.#touch(event.id);
    return event;
  }

  query(filters: readonly Filter[]): readonly Event[] {
    const events = this.#index.query(filters);
    for (const event of events) this.#touch(event.id);
    return events;
  }

  isDeleted(idOrAddress: string): boolean {
    return this.#index.isDeleted(idOrAddress);
  }

  seenOn(id: string): readonly string[] {
    return this.#seenOn.get(id.toLowerCase()) ?? [];
  }

  get size(): number {
    return this.#index.size;
  }

  watchEvent(id: string): Watch<Event | undefined> {
    const key = id.toLowerCase();
    return new WatchImpl(this, "event", key, () => this.get(key), sameRef, EVENT_IDS);
  }

  watchReplaceable(kind: number, pubkey: string, d?: string): Watch<Event | undefined> {
    const address = formatEventAddress(kind, pubkey, d ?? "");
    return new WatchImpl(
      this,
      "replaceable",
      address,
      () => this.getByAddress(address),
      sameRef,
      EVENT_IDS,
    );
  }

  watchQuery(filters: readonly Filter[]): Watch<readonly Event[]> {
    const key = filterFingerprint(filters);
    let watch = this.#queryCache.get(key);
    if (!watch) {
      const list = [...filters];
      watch = new WatchImpl(this, "query", key, () => this.query(list), sameList, LIST_IDS, list);
      this.#queryCache.set(key, watch);
    }
    return watch;
  }

  /** Synchronous listener for every physical index insert (after update). */
  onInsert(listener: (event: Event) => void): () => void {
    this.#insertListeners.add(listener);
    return () => {
      this.#insertListeners.delete(listener);
    };
  }

  _register(watch: WatchHandle): void {
    switch (watch.kind) {
      case "event":
        addWatch(this.#idWatches, watch.key, watch);
        return;
      case "replaceable":
        addWatch(this.#addressWatches, watch.key, watch);
        return;
      case "query":
        this.#queryRegistry.add(watch);
        return;
    }
  }

  _unregister(watch: WatchHandle): void {
    if (watch.subscribed) return;
    switch (watch.kind) {
      case "event":
        removeWatch(this.#idWatches, watch.key, watch);
        return;
      case "replaceable":
        removeWatch(this.#addressWatches, watch.key, watch);
        return;
      case "query":
        this.#queryRegistry.delete(watch);
        return;
    }
  }

  #touch(id: string): void {
    if (this.#recency.delete(id)) this.#recency.add(id);
    else this.#recency.add(id);
  }

  #recordSeen(id: string, relayUrl: string): void {
    const url = normalizeURL(relayUrl);
    let urls = this.#seenOn.get(id);
    if (!urls) {
      urls = [];
      this.#seenOn.set(id, urls);
    }
    if (!urls.includes(url) && urls.length < SEEN_ON_PER_ID) urls.push(url);
    while (this.#seenOn.size > this.#maxSeenOnEntries) {
      const oldest = this.#seenOn.keys().next();
      if (oldest.done) break;
      this.#seenOn.delete(oldest.value);
    }
  }

  #onInsert(event: Event): void {
    this._version += 1;
    this.#touch(event.id);
    this.#invalidateByEvent(event);
    for (const listener of this.#insertListeners) listener(event);
  }

  #onRemove(event: Event): void {
    this._version += 1;
    this.#recency.delete(event.id);
    this.#invalidateByEvent(event);
  }

  #invalidateByEvent(event: Event): void {
    const byId = this.#idWatches.get(event.id);
    if (byId) for (const watch of byId) this.#markDirty(watch);
    const address = eventAddress(event);
    if (address) {
      const byAddress = this.#addressWatches.get(address);
      if (byAddress) for (const watch of byAddress) this.#markDirty(watch);
    }
    for (const watch of this.#queryRegistry) {
      if (watch.filters !== undefined && matchFilters(watch.filters, event)) {
        this.#markDirty(watch);
      }
    }
  }

  #invalidateAll(): void {
    for (const watches of this.#idWatches.values()) {
      for (const watch of watches) this.#markDirty(watch);
    }
    for (const watches of this.#addressWatches.values()) {
      for (const watch of watches) this.#markDirty(watch);
    }
    for (const watch of this.#queryRegistry) this.#markDirty(watch);
    this.#scheduleFlush();
  }

  #markDirty(watch: WatchHandle): void {
    watch._markDirty();
    this.#dirty.add(watch);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      for (const watch of this.#dirty) watch._notify();
      this.#dirty.clear();
    });
  }

  #pinnedIds(): Set<string> {
    const pinned = new Set<string>();
    const collect = (watch: WatchHandle): void => {
      for (const id of watch.pinnedIds) pinned.add(id);
    };
    for (const watches of this.#idWatches.values()) {
      for (const watch of watches) collect(watch);
    }
    for (const watches of this.#addressWatches.values()) {
      for (const watch of watches) collect(watch);
    }
    for (const watch of this.#queryRegistry) collect(watch);
    return pinned;
  }

  #evictIfNeeded(): void {
    if (this.#index.size <= this.#maxEvents) return;
    const pinned = this.#pinnedIds();
    const evicting: string[] = [];
    for (const id of this.#recency) {
      if (this.#index.size - evicting.length <= this.#maxEvents) break;
      if (pinned.has(id)) continue;
      const event = this.#index.get(id);
      if (event === undefined) continue;
      // Latest replaceable/addressable versions are never evicted.
      if (eventAddress(event) !== undefined) continue;
      evicting.push(id);
    }
    this.#index.evict(evicting);
    for (const id of evicting) this.#recency.delete(id);
  }
}

function addWatch(map: Map<string, Set<WatchHandle>>, key: string, watch: WatchHandle): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(watch);
}

function removeWatch(map: Map<string, Set<WatchHandle>>, key: string, watch: WatchHandle): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(watch);
  if (set.size === 0) map.delete(key);
}
