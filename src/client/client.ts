import type { Event, EventTemplate, UnsignedEvent } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { sortedEvents } from "../core/event.ts";
import { CryptoError } from "../core/error.ts";
import { EventBuilder } from "../core/builder.ts";
import type { NostrSigner } from "../signer/types.ts";
import { Pool, type PoolPublishResult } from "../relay/pool.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import {
  createLoaders,
  createOutboxFeed,
  type Loaders,
  type OutboxFeed,
} from "../loaders/index.ts";
import { Gossip } from "../gossip/index.ts";
import type { EventStore } from "../storage/types.ts";
import { MemoryEventStore } from "../storage/memory.ts";
import { ClientBuilder } from "./builder.ts";

export type ClientOptions = {
  signer?: NostrSigner;
  relays?: readonly string[];
  websocketImplementation?: WebSocketConstructor;
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  /** When true (default if signer present), answer NIP-42 AUTH automatically. */
  automaticAuth?: boolean;
  /** When true (default), relays reconnect with backoff after disconnect. */
  enableReconnect?: boolean;
  gossip?: Gossip;
  /**
   * Local event store. Defaults to {@link MemoryEventStore}.
   * Pass a custom store (e.g. IndexedDbEventStore) for persistence.
   */
  storage?: EventStore;
  /**
   * When true (default), every ingested event is written to storage.
   * Set false to disable automatic persistence while keeping the store for manual use.
   */
  persistEvents?: boolean;
};

export type FetchEventsOptions = {
  relays?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  gossip?: boolean;
  /**
   * When true, query local storage first and merge with network results.
   * Defaults to false.
   */
  localFirst?: boolean;
  /** When false, skip writing fetched events to storage/observe. Default true. */
  observe?: boolean;
};

export type SubscribeOptions = {
  relays?: string[];
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
  signal?: AbortSignal;
  id?: string;
  /** Fan out REQs via NIP-65 gossip routes when available. */
  gossip?: boolean;
  /** When false, skip writing received events to storage/observe. Default true. */
  observe?: boolean;
};

export type PublishOptions = {
  relays?: string[];
  timeoutMs?: number;
  gossip?: boolean;
  /** When false, skip writing the published event to storage/observe. Default true. */
  observe?: boolean;
};

/**
 * Layer-5 facade: signer + default relays + pool + loaders + gossip + event store.
 */
export class Client {
  readonly pool: Pool;
  readonly loaders: Loaders;
  readonly gossip: Gossip;
  readonly storage: EventStore;
  #signer: NostrSigner | undefined;
  #relays: string[];
  #shutdown = false;
  #persistEvents: boolean;

  constructor(opts: ClientOptions = {}) {
    this.#signer = opts.signer;
    this.#relays = [...(opts.relays ?? [])];
    this.gossip = opts.gossip ?? new Gossip();
    this.storage = opts.storage ?? new MemoryEventStore();
    this.#persistEvents = opts.persistEvents ?? true;
    const autoAuth = opts.automaticAuth ?? Boolean(opts.signer);
    this.pool = new Pool({
      websocketImplementation: opts.websocketImplementation,
      connectTimeoutMs: opts.connectTimeoutMs,
      publishTimeoutMs: opts.publishTimeoutMs,
      maxWaitForConnectionMs: opts.connectTimeoutMs ?? 3000,
      enableReconnect: opts.enableReconnect ?? true,
      automaticallyAuth: autoAuth
        ? () => {
            const signer = this.#signer;
            if (!signer) return null;
            return async (template) => {
              const pk = await signer.getPublicKey();
              return signer.signEvent({ ...template, pubkey: pk });
            };
          }
        : undefined,
    });
    this.loaders = createLoaders({
      pool: this.pool,
      relays: this.#relays,
    });
  }

  static builder(): ClientBuilder {
    return new ClientBuilder();
  }

  get signer(): NostrSigner | undefined {
    return this.#signer;
  }

  get relays(): readonly string[] {
    return this.#relays;
  }

  get isShutdown(): boolean {
    return this.#shutdown;
  }

  setSigner(signer: NostrSigner): void {
    this.#signer = signer;
  }

  addRelay(url: string): void {
    if (!this.#relays.includes(url)) {
      this.#relays.push(url);
      this.loaders.context.addRelay(url);
    }
  }

  removeRelay(url: string): void {
    this.#relays = this.#relays.filter((r) => r !== url);
    this.loaders.context.removeRelay(url);
    this.pool.close([url]);
  }

  /** Connect all configured relays (best-effort; failures are ignored). */
  async connect(opts?: { signal?: AbortSignal }): Promise<void> {
    this.#assertAlive();
    await Promise.allSettled(
      this.#relays.map((url) => this.pool.ensureRelay(url, { signal: opts?.signal })),
    );
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    this.pool.close();
    this.loaders.context.cache.clear();
  }

  #assertAlive(): void {
    if (this.#shutdown) throw new CryptoError("client is shut down");
  }

  #defaultRelays(urls?: string[]): string[] {
    const list = urls ?? this.#relays;
    if (list.length === 0) throw new CryptoError("no relays configured");
    return list;
  }

  /**
   * Unified ingest pipeline: storage → gossip → replaceable loader cache.
   * Fire-and-forget storage writes; failures are swallowed so network paths stay resilient.
   */
  observe(event: Event): void {
    this.gossip.ingest(event);
    if (event.kind === 0 || event.kind === 3 || event.kind === 10000 || event.kind === 10002) {
      this.loaders.context.cache.putIfNewer(event);
    }
    if (this.#persistEvents) {
      void this.storage.put(event).catch(() => {
        // storage errors must not break live pipelines
      });
    }
  }

  /** Observe many events (deduped by id order preserved). */
  observeAll(events: readonly Event[]): void {
    const seen = new Set<string>();
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      this.observe(event);
    }
  }

  /**
   * Explicitly load kind:10002 lists for pubkeys and feed gossip.
   * Does not background-fetch unknown authors on every subscribe (predictable DX).
   */
  async hydrateGossip(
    pubkeys: readonly string[],
    opts?: { hints?: string[]; force?: boolean },
  ): Promise<void> {
    this.#assertAlive();
    await Promise.all(
      pubkeys.map(async (pk) => {
        const result = await this.loaders.relayList(pk, {
          hints: opts?.hints,
          style: opts?.force ? "force" : "default",
        });
        if (result.event) this.observe(result.event);
      }),
    );
  }

  /**
   * Create an outbox-model feed for the given authors (NIP-65 write relays).
   * Events are ingested via {@link observe}. Call `feed.hydrate()` / `sync()` / `startLive()`.
   */
  outbox(opts: {
    authors: readonly string[];
    kinds?: readonly number[];
    onEvent?: (event: Event) => void;
    maxRelaysPerAuthor?: number;
  }): OutboxFeed {
    this.#assertAlive();
    return createOutboxFeed({
      pool: this.pool,
      gossip: this.gossip,
      storage: this.storage,
      discoveryRelays: this.#relays,
      authors: opts.authors,
      kinds: opts.kinds,
      onEvent: opts.onEvent,
      maxRelaysPerAuthor: opts.maxRelaysPerAuthor,
      observe: (event) => this.observe(event),
      hydrate: (pubkeys) => this.hydrateGossip(pubkeys),
    });
  }

  async getPublicKey(): Promise<string> {
    if (!this.#signer) throw new CryptoError("no signer configured");
    return this.#signer.getPublicKey();
  }

  async signEvent(unsigned: UnsignedEvent): Promise<Event> {
    if (!this.#signer) throw new CryptoError("no signer configured");
    return this.#signer.signEvent(unsigned);
  }

  async signEventBuilder(builder: EventBuilder): Promise<Event> {
    if (!this.#signer) throw new CryptoError("no signer configured");
    return builder.sign(this.#signer);
  }

  async signTemplate(template: EventTemplate): Promise<Event> {
    if (!this.#signer) throw new CryptoError("no signer configured");
    const pubkey = await this.#signer.getPublicKey();
    return this.#signer.signEvent({ ...template, pubkey });
  }

  /**
   * Sign (if builder) and publish to relays.
   * With `gossip: true`, prefers the author's NIP-65 outbox relays when known.
   * On any successful OK, observes the event into storage/gossip.
   */
  async publish(
    eventOrBuilder: Event | EventBuilder,
    opts?: PublishOptions,
  ): Promise<PoolPublishResult[]> {
    this.#assertAlive();
    const event =
      eventOrBuilder instanceof EventBuilder
        ? await this.signEventBuilder(eventOrBuilder)
        : eventOrBuilder;

    let relays = opts?.relays;
    if (!relays && opts?.gossip) {
      const outbox = this.gossip.outboxRelays(event.pubkey);
      if (outbox.length > 0) relays = outbox;
    }
    const results = await this.pool.publish(this.#defaultRelays(relays), event, {
      timeoutMs: opts?.timeoutMs,
    });

    const anyOk = results.some((r) => r.result?.ok);
    if (anyOk && opts?.observe !== false) {
      this.observe(event);
    }
    return results;
  }

  /**
   * Fetch events. With `gossip: true`, breaks filters by NIP-65 routes when possible.
   * With `localFirst: true`, merges storage hits with network results.
   */
  async fetchEvents(filter: Filter | Filter[], opts?: FetchEventsOptions): Promise<Event[]> {
    this.#assertAlive();
    const filters = Array.isArray(filter) ? filter : [filter];
    const shouldObserve = opts?.observe !== false;
    const byId = new Map<string, Event>();

    if (opts?.localFirst) {
      try {
        const local = await this.storage.query(filters);
        for (const e of local) byId.set(e.id, e);
      } catch {
        // ignore local failures
      }
    }

    const ingest = (events: Event[]) => {
      for (const e of events) {
        byId.set(e.id, e);
        if (shouldObserve) this.observe(e);
      }
    };

    if (!opts?.gossip || opts.relays) {
      const remote = await this.pool.fetch(this.#defaultRelays(opts?.relays), filters, {
        timeoutMs: opts?.timeoutMs,
        signal: opts?.signal,
      });
      ingest(remote);
      return sortedEvents([...byId.values()]);
    }

    for (const f of filters) {
      const broken = this.gossip.breakDownFilter(f);
      if (broken.type === "per-relay") {
        await Promise.all(
          [...broken.filters.entries()].map(async ([url, subFilter]) => {
            try {
              const batch = await this.pool.fetch([url], [subFilter], {
                timeoutMs: opts?.timeoutMs,
                signal: opts?.signal,
              });
              ingest(batch);
            } catch {
              // skip failed relay
            }
          }),
        );
      } else {
        const batch = await this.pool.fetch(this.#defaultRelays(), [f], {
          timeoutMs: opts?.timeoutMs,
          signal: opts?.signal,
        });
        ingest(batch);
      }
    }
    return sortedEvents([...byId.values()]);
  }

  /**
   * Query local storage only (no network).
   */
  async queryLocal(filter: Filter | Filter[]): Promise<Event[]> {
    this.#assertAlive();
    const filters = Array.isArray(filter) ? filter : [filter];
    return this.storage.query(filters);
  }

  subscribe(
    filter: Filter | Filter[],
    opts?: SubscribeOptions,
  ): { close: (reason?: string) => void } {
    this.#assertAlive();
    const filters = Array.isArray(filter) ? filter : [filter];
    const shouldObserve = opts?.observe !== false;

    const wrapEvent = (event: Event) => {
      if (shouldObserve) this.observe(event);
      opts?.onevent?.(event);
    };

    if (!opts?.gossip || opts.relays) {
      return this.pool.subscribe(this.#defaultRelays(opts?.relays), filters, {
        onevent: wrapEvent,
        oneose: opts?.oneose,
        onclose: opts?.onclose,
        signal: opts?.signal,
        id: opts?.id,
      });
    }

    const seen = new Set<string>();
    const closers: Array<{ close: (reason?: string) => void }> = [];
    let pendingEose = 0;
    let eoseFired = false;

    const maybeEose = () => {
      pendingEose -= 1;
      if (pendingEose <= 0 && !eoseFired) {
        eoseFired = true;
        opts?.oneose?.();
      }
    };

    for (const f of filters) {
      const broken = this.gossip.breakDownFilter(f);
      if (broken.type === "per-relay") {
        for (const [url, subFilter] of broken.filters) {
          pendingEose += 1;
          closers.push(
            this.pool.subscribe([url], [subFilter], {
              signal: opts?.signal,
              onevent: (event) => {
                if (seen.has(event.id)) return;
                seen.add(event.id);
                wrapEvent(event);
              },
              oneose: maybeEose,
              onclose: opts?.onclose,
            }),
          );
        }
      } else {
        pendingEose += 1;
        closers.push(
          this.pool.subscribe(this.#defaultRelays(), [f], {
            signal: opts?.signal,
            id: opts?.id,
            onevent: (event) => {
              if (seen.has(event.id)) return;
              seen.add(event.id);
              wrapEvent(event);
            },
            oneose: maybeEose,
            onclose: opts?.onclose,
          }),
        );
      }
    }

    if (pendingEose === 0) {
      queueMicrotask(() => opts?.oneose?.());
    }

    return {
      close: (reason?: string) => {
        for (const c of closers) c.close(reason);
      },
    };
  }
}
