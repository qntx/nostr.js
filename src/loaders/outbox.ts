import type { Event } from "../core/event.ts";
import { NostrError } from "../core/error.ts";
import type { Filter } from "../core/filter.ts";
import { sortedEvents } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import { normalizeURL } from "../core/util.ts";
import type { Gossip } from "../gossip/gossip.ts";
import type { Pool } from "../relay/pool.ts";
import { toStorageError, type StorageError } from "../storage/error.ts";
import type { EventStore, OutboxBound, PutResult } from "../storage/types.ts";

export type { OutboxBound } from "../storage/types.ts";

export class OutboxError extends NostrError {}

export type OutboxFeedOptions = {
  pool: Pool;
  gossip: Gossip;
  storage: EventStore;
  /** Fallback relays when an author has no known outbox routes. */
  discoveryRelays: readonly string[];
  authors: readonly string[];
  /** Event kinds to fetch. Default `[Kind.TextNote]`. */
  kinds?: readonly number[];
  /** Max write-relays to use per author. Default 3. */
  maxRelaysPerAuthor?: number;
  fetchTimeoutMs?: number;
  /** Called for every new event after persist/observe. */
  onEvent?: (event: Event) => void;
  /** Live ingest (e.g. `client.observe`). When set, startLive does not putMany. */
  observe?: (event: Event) => void;
  /** Sync-path meta ingest (e.g. gossip/cache). Does not persist. */
  ingestMeta?: (event: Event) => void;
  /** Live `putMany` failure when `observe` is omitted. */
  onStorageError?: (err: StorageError) => void;
  /**
   * Load kind:10002 for authors before sync when routes are missing.
   * Requires a relay-list loader.
   */
  hydrate?: (pubkeys: readonly string[]) => Promise<void>;
};

function boundKey(pubkey: string, kind: number): string {
  return `${pubkey.toLowerCase()}:${kind}`;
}

/** Same skip/dedup as Gossip.setRoutes so prefer can match Client.relays. */
function canonicalRelayUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    try {
      const url = normalizeURL(raw);
      if (!out.includes(url)) out.push(url);
    } catch {
      // not a relay URL
    }
  }
  return out;
}

/**
 * Group authors by outbox relay (discovery fallback).
 * `prefer` reorders existing candidates only; it never appends a URL
 * that is not already in the author's outbox or discovery list.
 * Returns Map<relayUrl, authors[]>.
 */
export function groupAuthorsByOutboxRelay(
  authors: readonly string[],
  gossip: Gossip,
  discoveryRelays: readonly string[],
  maxRelaysPerAuthor = 3,
  prefer: readonly string[] = [],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const preferSet = new Set(canonicalRelayUrls(prefer));
  const discovery = canonicalRelayUrls(discoveryRelays);
  for (const author of authors) {
    const pk = author.toLowerCase();
    let relays = gossip.outboxRelays(pk);
    if (relays.length === 0) relays = discovery;
    const preferred: string[] = [];
    const rest: string[] = [];
    for (const url of relays) {
      if (preferSet.has(url)) preferred.push(url);
      else rest.push(url);
    }
    relays = preferred.concat(rest).slice(0, maxRelaysPerAuthor);
    for (const url of relays) {
      const list = map.get(url) ?? [];
      if (!list.includes(pk)) list.push(pk);
      map.set(url, list);
    }
  }
  return map;
}

/**
 * Outbox-model feed: history sync + live subscription for a set of authors,
 * routed via NIP-65 write relays (with discovery fallback).
 */
export class OutboxFeed {
  readonly #pool: Pool;
  readonly #gossip: Gossip;
  readonly #storage: EventStore;
  readonly #discovery: string[];
  readonly #kinds: number[];
  readonly #maxRelays: number;
  readonly #timeoutMs: number;
  readonly #onEvent: ((event: Event) => void) | undefined;
  readonly #observe: ((event: Event) => void) | undefined;
  readonly #ingestMeta: ((event: Event) => void) | undefined;
  readonly #onStorageError: ((err: StorageError) => void) | undefined;
  readonly #hydrate: ((pubkeys: readonly string[]) => Promise<void>) | undefined;
  readonly #bounds = new Map<string, OutboxBound>();
  #authors: string[];
  #liveCloser: { close: (reason?: string) => void } | undefined;
  #closed = false;

  constructor(opts: OutboxFeedOptions) {
    this.#pool = opts.pool;
    this.#gossip = opts.gossip;
    this.#storage = opts.storage;
    this.#discovery = [...opts.discoveryRelays];
    this.#authors = [...new Set(opts.authors.map((a) => a.toLowerCase()))];
    this.#kinds = [...(opts.kinds ?? [Kind.TextNote])];
    this.#maxRelays = opts.maxRelaysPerAuthor ?? 3;
    this.#timeoutMs = opts.fetchTimeoutMs ?? 4400;
    this.#onEvent = opts.onEvent;
    this.#observe = opts.observe;
    this.#ingestMeta = opts.ingestMeta;
    this.#onStorageError = opts.onStorageError;
    this.#hydrate = opts.hydrate;
  }

  get authors(): readonly string[] {
    return this.#authors;
  }

  get kinds(): readonly number[] {
    return this.#kinds;
  }

  /** Replace the author set (does not auto-restart live). */
  setAuthors(authors: readonly string[]): void {
    this.#authors = [...new Set(authors.map((a) => a.toLowerCase()))];
  }

  getBound(pubkey: string, kind: number): OutboxBound | undefined {
    return this.#bounds.get(boundKey(pubkey, kind));
  }

  /**
   * Load NIP-65 relay lists for authors that have no outbox routes yet.
   */
  async hydrate(): Promise<void> {
    this.#assertOpen();
    if (!this.#hydrate) return;
    const missing = this.#authors.filter((pk) => this.#gossip.outboxRelays(pk).length === 0);
    if (missing.length === 0) return;
    await this.#hydrate(missing);
  }

  /**
   * One-shot history pull. Writes unique events once via putMany, then ingestMeta.
   */
  async sync(opts?: {
    limit?: number;
    since?: number;
    until?: number;
    signal?: AbortSignal;
    /** Skip hydrate() even if provided. */
    skipHydrate?: boolean;
  }): Promise<Event[]> {
    this.#assertOpen();
    if (!opts?.skipHydrate) await this.hydrate();
    await this.#hydrateBoundsFromStore();

    const byRelay = groupAuthorsByOutboxRelay(
      this.#authors,
      this.#gossip,
      this.#discovery,
      this.#maxRelays,
      this.#pool.connectedUrls(),
    );

    if (byRelay.size === 0) return [];

    const byId = new Map<string, Event>();
    await Promise.all(
      [...byRelay.entries()].map(async ([url, authors]) => {
        if (opts?.signal?.aborted) return;

        const filters = this.#syncFilters(authors, opts);
        try {
          const batch = await this.#pool.fetch([url], filters, {
            timeoutMs: this.#timeoutMs,
            signal: opts?.signal,
          });
          for (const event of batch) byId.set(event.id, event);
        } catch {
          // skip failed relay
        }
      }),
    );

    const unique = [...byId.values()];
    if (unique.length === 0) return [];

    let results: PutResult[];
    try {
      results = await this.#storage.putMany(unique);
    } catch (err) {
      throw toStorageError(err);
    }

    const dirty = new Set<string>();
    for (let i = 0; i < unique.length; i++) {
      const event = unique[i]!;
      const result = results[i];
      if (result === "rejected" || result === "ephemeral") continue;
      this.#ingestMeta?.(event);
      this.#updateBounds(event);
      dirty.add(boundKey(event.pubkey, event.kind));
      this.#onEvent?.(event);
    }
    await this.#persistBounds(dirty);
    return sortedEvents(unique);
  }

  /**
   * Start a live subscription across outbox relays for the current authors.
   * Closes any previous live subscription.
   */
  startLive(opts?: { signal?: AbortSignal; since?: number }): { close: (reason?: string) => void } {
    this.#assertOpen();
    this.#liveCloser?.close("restart");

    const byRelay = groupAuthorsByOutboxRelay(
      this.#authors,
      this.#gossip,
      this.#discovery,
      this.#maxRelays,
      this.#pool.connectedUrls(),
    );

    const seen = new Set<string>();
    const closers: Array<{ close: (reason?: string) => void }> = [];
    const since = opts?.since ?? Math.floor(Date.now() / 1000) - 60;

    for (const [url, authors] of byRelay) {
      const filter: Filter = {
        authors,
        kinds: this.#kinds,
        since,
      };
      closers.push(
        this.#pool.subscribe([url], [filter], {
          signal: opts?.signal,
          onevent: (event) => {
            if (seen.has(event.id)) return;
            seen.add(event.id);
            if (this.#observe) {
              this.#noteEvent(event);
              return;
            }
            void this.#storage
              .putMany([event])
              .then((results) => {
                const result = results[0];
                if (result === "rejected" || result === "ephemeral") return;
                this.#noteEvent(event);
              })
              .catch((err: unknown) => {
                this.#onStorageError?.(toStorageError(err));
              });
          },
        }),
      );
    }

    const closer = {
      close: (reason?: string) => {
        for (const c of closers) c.close(reason);
        if (this.#liveCloser === closer) this.#liveCloser = undefined;
      },
    };
    this.#liveCloser = closer;
    return closer;
  }

  /** Convenience: hydrate + sync + startLive. */
  async start(opts?: {
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ close: (reason?: string) => void; events: Event[] }> {
    const events = await this.sync({ limit: opts?.limit, signal: opts?.signal });
    const live = this.startLive({ signal: opts?.signal });
    return { close: (r) => live.close(r), events };
  }

  close(): void {
    this.#closed = true;
    this.#liveCloser?.close("feed closed");
    this.#liveCloser = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new OutboxError("OutboxFeed is closed");
  }

  async #hydrateBoundsFromStore(): Promise<void> {
    await Promise.all(
      this.#authors.flatMap((pk) =>
        this.#kinds.map(async (kind) => {
          const key = boundKey(pk, kind);
          if (this.#bounds.has(key)) return;
          const bound = await this.#storage.getOutboxBound(pk, kind);
          if (!bound) return;
          await this.#storage.setOutboxBound(pk, kind, bound);
          this.#bounds.set(key, { oldest: bound.oldest, newest: bound.newest });
        }),
      ),
    );
  }

  #syncFilters(
    authors: string[],
    opts?: { limit?: number; since?: number; until?: number },
  ): Filter[] {
    const base: Filter = {
      kinds: this.#kinds,
      limit: opts?.limit ?? 50,
      ...(opts?.until !== undefined ? { until: opts.until } : {}),
    };

    if (opts?.since !== undefined) {
      return [{ ...base, authors, since: opts.since }];
    }

    const bounded: string[] = [];
    const unbounded: string[] = [];
    let minBoundedNewest: number | undefined;

    for (const pk of authors) {
      let newest: number | undefined;
      let complete = true;
      for (const kind of this.#kinds) {
        const b = this.#bounds.get(boundKey(pk, kind));
        if (!b) {
          complete = false;
          break;
        }
        if (newest === undefined || b.newest < newest) newest = b.newest;
      }
      if (complete && newest !== undefined) {
        bounded.push(pk);
        if (minBoundedNewest === undefined || newest < minBoundedNewest) {
          minBoundedNewest = newest;
        }
      } else {
        unbounded.push(pk);
      }
    }

    if (bounded.length === 0 || minBoundedNewest === undefined) {
      return [{ ...base, authors }];
    }
    if (unbounded.length === 0) {
      return [{ ...base, authors, since: Math.max(0, minBoundedNewest - 1) }];
    }
    return [
      { ...base, authors: bounded, since: Math.max(0, minBoundedNewest - 1) },
      { ...base, authors: unbounded },
    ];
  }

  #noteEvent(event: Event): void {
    this.#updateBounds(event);
    const bound = this.#bounds.get(boundKey(event.pubkey, event.kind));
    if (bound) {
      void this.#storage
        .setOutboxBound(event.pubkey, event.kind, {
          oldest: bound.oldest,
          newest: bound.newest,
        })
        .catch(() => {});
    }
    this.#observe?.(event);
    this.#onEvent?.(event);
  }

  async #persistBounds(keys: Iterable<string>): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const key of keys) {
      const bound = this.#bounds.get(key);
      if (!bound) continue;
      const sep = key.lastIndexOf(":");
      writes.push(
        this.#storage.setOutboxBound(key.slice(0, sep), Number(key.slice(sep + 1)), {
          oldest: bound.oldest,
          newest: bound.newest,
        }),
      );
    }
    if (writes.length === 0) return;
    try {
      await Promise.all(writes);
    } catch (err) {
      throw toStorageError(err);
    }
  }

  #updateBounds(event: Event): void {
    const key = boundKey(event.pubkey, event.kind);
    const prev = this.#bounds.get(key);
    if (!prev) {
      this.#bounds.set(key, { oldest: event.created_at, newest: event.created_at });
      return;
    }
    if (event.created_at < prev.oldest) prev.oldest = event.created_at;
    if (event.created_at > prev.newest) prev.newest = event.created_at;
  }
}

/** Factory matching other loaders helpers. */
export function createOutboxFeed(opts: OutboxFeedOptions): OutboxFeed {
  return new OutboxFeed(opts);
}
