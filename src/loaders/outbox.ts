import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { sortedEvents } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import type { Gossip } from "../gossip/gossip.ts";
import type { Pool } from "../relay/pool.ts";
import type { EventStore } from "../storage/types.ts";

export type OutboxBound = {
  oldest: number;
  newest: number;
};

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
  /** Called for every new event (after optional observe). */
  onEvent?: (event: Event) => void;
  /**
   * Ingest hook (e.g. `client.observe`). When set, sync/live events are
   * passed through before `onEvent`.
   */
  observe?: (event: Event) => void;
  /**
   * Load kind:10002 for authors before sync when routes are missing.
   * Requires a relay-list loader.
   */
  hydrate?: (pubkeys: readonly string[]) => Promise<void>;
};

function boundKey(pubkey: string, kind: number): string {
  return `${pubkey.toLowerCase()}:${kind}`;
}

/**
 * Group authors by outbox relay (discovery fallback).
 * Returns Map<relayUrl, authors[]>.
 */
export function groupAuthorsByOutboxRelay(
  authors: readonly string[],
  gossip: Gossip,
  discoveryRelays: readonly string[],
  maxRelaysPerAuthor = 3,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const author of authors) {
    const pk = author.toLowerCase();
    let relays = gossip.outboxRelays(pk);
    if (relays.length === 0) relays = [...discoveryRelays];
    relays = relays.slice(0, maxRelaysPerAuthor);
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
 *
 * Intentionally smaller than gadgets' OutboxManager — no multi-tab WASM store,
 * no global pool, single-process bounds only.
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
   * One-shot history pull. Updates in-memory bounds and writes via observe/storage.
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
          for (const event of batch) {
            byId.set(event.id, event);
            this.#noteEvent(event);
          }
        } catch {
          // skip failed relay
        }
      }),
    );

    return sortedEvents([...byId.values()]);
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
            this.#noteEvent(event);
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
    if (this.#closed) throw new Error("OutboxFeed is closed");
  }

  async #newestFromStore(pubkey: string, kind: number): Promise<number | undefined> {
    const [ev] = await this.#storage.query([{ authors: [pubkey], kinds: [kind], limit: 1 }]);
    return ev?.created_at;
  }

  async #hydrateBoundsFromStore(): Promise<void> {
    await Promise.all(
      this.#authors.flatMap((pk) =>
        this.#kinds.map(async (kind) => {
          const key = boundKey(pk, kind);
          if (this.#bounds.has(key)) return;
          const newest = await this.#newestFromStore(pk, kind);
          if (newest === undefined) return;
          this.#bounds.set(key, { oldest: newest, newest });
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
    this.#observe?.(event);
    if (!this.#observe) {
      // Still persist when no observe hook is provided.
      void this.#storage.put(event).catch(() => {});
    }
    this.#onEvent?.(event);
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
