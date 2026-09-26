import { EventBuilder } from "../core/builder.ts";
import { sortedEvents, type Event, type EventTemplate, type UnsignedEvent } from "../core/event.ts";
import { canonicalizeFilters, matchFilters, type Filter } from "../core/filter.ts";
import { Kind } from "../core/kind.ts";
import { normalizeURL } from "../core/util.ts";
import { throwIfAborted } from "../core/abort.ts";
import { invokeSafely } from "../core/report.ts";
import { Gossip } from "../gossip/index.ts";
import {
  createLoaders,
  createOutboxFeed,
  type Loaders,
  type OutboxFeed,
} from "../loaders/index.ts";
import type { Recipient } from "../nips/nip17.ts";
import { isGiftWrapKind, requireNip59Crypto, type Nip59Crypto } from "../nips/nip59.ts";
import { Pool, type PoolPublishResult } from "../relay/pool.ts";
import { NoSignerError } from "../signer/error.ts";
import type { NostrSigner } from "../signer/types.ts";
import { toStorageError, type StorageError } from "../storage/error.ts";
import { MemoryEventStore } from "../storage/memory.ts";
import { MemoryIndex } from "../storage/memory-index.ts";
import type { EventStore } from "../storage/types.ts";
import { ReactiveEventStore } from "../store/reactive.ts";
import { ClientBuilder } from "./builder.ts";
import {
  fetchPrivateMessages,
  giftWrapRelays,
  sendPrivateMessage,
  setDmRelays,
  subscribePrivateMessages,
  type DmDeps,
} from "./dm.ts";
import { fetchGossip, subscribeGossip } from "./gossip-io.ts";
import { sync, syncToRelay, type SyncDeps } from "./sync.ts";
import {
  ClientError,
  type ClientOptions,
  type FetchEventsOptions,
  type FetchPrivateMessagesOptions,
  type PrivateMessageSendResult,
  type PublishOptions,
  type ReceivedPrivateMessage,
  type SendPrivateMessageOptions,
  type SubscribeOptions,
  type SubscribePrivateMessagesOptions,
  type SyncOptions,
  type SyncSummary,
} from "./types.ts";

/**
 * Layer-5 facade: signer + default relays + pool + loaders + gossip + event store.
 */
export class Client {
  readonly pool: Pool;
  readonly loaders: Loaders;
  readonly gossip: Gossip;
  readonly storage: EventStore;
  readonly index: ReactiveEventStore;
  onstorageerror: ((err: StorageError) => void) | null;
  #signer: NostrSigner | undefined;
  #relays: string[];
  #shutdown = false;
  #persistEvents: boolean;
  #persistQueue: Event[] = [];
  #flushing: Promise<void> | undefined;

  constructor(opts: ClientOptions = {}) {
    this.#signer = opts.signer;
    this.#relays = [];
    for (const raw of opts.relays ?? []) {
      const url = normalizeURL(raw);
      if (!this.#relays.includes(url)) this.#relays.push(url);
    }
    this.gossip = opts.gossip ?? new Gossip();
    this.storage = opts.storage ?? new MemoryEventStore();
    this.index = opts.index ?? new ReactiveEventStore();
    this.#persistEvents = opts.persistEvents ?? true;
    this.onstorageerror = opts.onstorageerror ?? null;
    this.pool = new Pool({
      websocketImplementation: opts.websocketImplementation,
      verifyEvent: opts.verifyEvent,
      enablePing: opts.enablePing,
      pingIntervalMs: opts.pingIntervalMs,
      pingTimeoutMs: opts.pingTimeoutMs,
      connectTimeoutMs: opts.connectTimeoutMs,
      publishTimeoutMs: opts.publishTimeoutMs,
      enableReconnect: opts.enableReconnect ?? true,
      allowInsecure: opts.allowInsecure,
      trustedInsecureUrls: opts.trustedInsecureUrls,
      idleTimeoutMs: opts.idleTimeoutMs,
      maxRelays: opts.maxRelays,
      pinnedUrls: opts.pinnedUrls,
      // The sign function resolves the signer at challenge time, so
      // setSigner() takes effect on already-connected relays; challenges
      // without a signer are ignored by the relay (NoSignerError).
      automaticallyAuth:
        (opts.automaticAuth ?? true)
          ? () => async (template) => {
              const signer = this.#signer;
              if (!signer) throw new NoSignerError("no signer configured for AUTH");
              const pk = await signer.getPublicKey();
              return signer.signEvent({ ...template, pubkey: pk });
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

  setSigner(signer: NostrSigner | undefined): void {
    this.#signer = signer;
    // Re-arm relays whose AUTH challenge was ignored or rejected.
    this.pool.resetAuth();
  }

  addRelay(url: string): void {
    const normalized = normalizeURL(url);
    if (!this.#relays.includes(normalized)) {
      this.#relays.push(normalized);
      this.loaders.context.addRelay(normalized);
    }
  }

  removeRelay(url: string): void {
    const normalized = normalizeURL(url);
    this.#relays = this.#relays.filter((r) => r !== normalized);
    this.loaders.context.removeRelay(normalized);
    this.pool.close([normalized]);
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
    while (this.#flushing) await this.#flushing;
    this.pool.close();
    this.loaders.context.cache.clear();
  }

  #assertAlive(): void {
    if (this.#shutdown) throw new ClientError("client is shut down");
  }

  #defaultRelays(urls?: string[]): string[] {
    const list = urls ?? this.#relays;
    if (list.length === 0) throw new ClientError("no relays configured");
    return list;
  }

  #wantObserve(flag?: boolean): boolean {
    return flag !== false;
  }

  /** Ingest one inbound event: index (with relay URL) → meta → persistence. */
  observe(event: Event, relayUrl?: string): void {
    this.#ingest(event, relayUrl);
  }

  /** Ingest many events (deduped by id, order preserved) as one persist batch. */
  observeAll(events: readonly Event[]): void {
    const seen = new Set<string>();
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      this.#ingest(event);
    }
  }

  /**
   * The single inbound-event pipeline: reactive index add (with the source
   * relay URL recorded in seenOn), gossip + replaceable loader cache meta,
   * then the persistence decision. `persist: false` skips the storage queue
   * for callers that persist via their own awaited `putMany` (down-sync);
   * `meta: false` is a pure sighting/index add.
   */
  #ingest(event: Event, relayUrl?: string, opts?: { persist?: boolean; meta?: boolean }): void {
    this.index.add(event, relayUrl);
    if (opts?.meta !== false) this.#ingestMeta(event);
    if (opts?.persist === false || !this.#persistEvents) return;
    this.#persistQueue.push(event);
    this.#armFlush();
  }

  /** Record a relay sighting for an id already in the index. */
  #markSeen(id: string, relayUrl: string): void {
    this.index.markSeen(id, relayUrl);
  }

  #ingestMeta(event: Event): void {
    this.gossip.ingest(event);
    if (
      event.kind === Kind.Metadata ||
      event.kind === Kind.Contacts ||
      event.kind === Kind.MuteList ||
      event.kind === Kind.RelayList ||
      event.kind === Kind.DirectMessageRelaysList
    ) {
      this.loaders.context.cache.putIfNewer(event);
    }
  }

  #armFlush(): void {
    if (this.#flushing) return;
    this.#flushing = this.#flushLoop();
  }

  async #flushLoop(): Promise<void> {
    try {
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
      while (this.#persistQueue.length > 0) {
        const batch = this.#persistQueue.splice(0);
        try {
          await this.storage.putMany(batch);
        } catch (err) {
          invokeSafely(() => this.onstorageerror?.(toStorageError(err)));
        }
      }
    } finally {
      this.#flushing = undefined;
      if (this.#persistQueue.length > 0) this.#armFlush();
    }
  }

  /**
   * Explicitly load kind:10002 and kind:10050 lists for pubkeys and feed gossip.
   * Does not background-fetch unknown authors on every subscribe (predictable DX).
   */
  async hydrateGossip(
    pubkeys: readonly string[],
    opts?: { hints?: string[]; force?: boolean },
  ): Promise<void> {
    this.#assertAlive();
    await Promise.all(
      pubkeys.map(async (pk) => {
        const style = opts?.force ? "force" : "default";
        const [relayList, dmList] = await Promise.all([
          this.loaders.relayList(pk, { hints: opts?.hints, style }),
          this.loaders.dmRelayList(pk, { hints: opts?.hints, style }),
        ]);
        if (relayList.event) this.observe(relayList.event);
        if (dmList.event) this.observe(dmList.event);
      }),
    );
  }

  /**
   * Create an outbox-model feed for the given authors (NIP-65 write relays).
   * Live events go through {@link observe}; sync persists via applySync.
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
      observe: (event, relayUrl) => this.observe(event, relayUrl),
      seen: (event, relayUrl) => this.#ingest(event, relayUrl, { persist: false, meta: false }),
      applySync: async (events) => {
        if (!this.#persistEvents) {
          for (const event of events) this.#ingest(event, undefined, { persist: false });
          return [];
        }
        const results = await this.storage.putMany(events);
        const applied: Event[] = [];
        for (let i = 0; i < events.length; i++) {
          if (results[i] === "rejected" || results[i] === "ephemeral" || results[i] === "invalid") {
            continue;
          }
          this.#ingest(events[i]!, undefined, { persist: false });
          applied.push(events[i]!);
        }
        return applied;
      },
      hydrate: (pubkeys) => this.hydrateGossip(pubkeys),
    });
  }

  async getPublicKey(): Promise<string> {
    if (!this.#signer) throw new ClientError("no signer configured");
    return this.#signer.getPublicKey();
  }

  async signEvent(unsigned: UnsignedEvent): Promise<Event> {
    if (!this.#signer) throw new ClientError("no signer configured");
    return this.#signer.signEvent(unsigned);
  }

  async signEventBuilder(builder: EventBuilder): Promise<Event> {
    if (!this.#signer) throw new ClientError("no signer configured");
    return builder.sign(this.#signer);
  }

  async signTemplate(template: EventTemplate): Promise<Event> {
    if (!this.#signer) throw new ClientError("no signer configured");
    const pubkey = await this.#signer.getPublicKey();
    return this.#signer.signEvent({ ...template, pubkey });
  }

  /**
   * Sign (if builder) and publish to relays.
   * With `gossip: true`, prefers the author's NIP-65 outbox relays, tagged `p`
   * inboxes, and up to 5 `e`/`a` tag relay hints when known.
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
    if (!relays && isGiftWrapKind(event.kind)) {
      relays = giftWrapRelays(this.gossip, event);
    } else if (!relays && opts?.gossip) {
      const urls: string[] = [];
      const add = (list: readonly string[]) => {
        for (const url of list) {
          if (!urls.includes(url)) urls.push(url);
        }
      };
      add(this.gossip.outboxRelays(event.pubkey));
      for (const tag of event.tags) {
        if (tag[0] === "p" && tag[1]) add(this.gossip.inboxRelays(tag[1]));
      }
      let hintCount = 0;
      for (const tag of event.tags) {
        if (hintCount >= 5) break;
        if ((tag[0] !== "e" && tag[0] !== "a") || !tag[2]) continue;
        try {
          const url = normalizeURL(tag[2]);
          if (!urls.includes(url)) {
            urls.push(url);
            hintCount += 1;
          }
        } catch {
          // not a relay URL
        }
      }
      if (urls.length > 0) relays = urls;
    }
    const results = await this.pool.publish(this.#defaultRelays(relays), event, {
      timeoutMs: opts?.timeoutMs,
    });

    const anyOk = results.some((r) => r.result?.ok);
    if (anyOk && this.#wantObserve(opts?.observe)) {
      this.observe(event);
    }
    return results;
  }

  /**
   * Fetch events. With `gossip: true`, routes filters by NIP-65 when possible.
   * With `localFirst: true`, merges storage hits with network results.
   */
  async fetchEvents(filter: Filter | Filter[], opts?: FetchEventsOptions): Promise<Event[]> {
    this.#assertAlive();
    const filters = canonicalizeFilters(Array.isArray(filter) ? filter : [filter]);
    const shouldObserve = this.#wantObserve(opts?.observe);
    const candidates: Event[] = [];

    if (opts?.localFirst) {
      // Persisted storage is merged with the index below; storage may hold a
      // stale replaceable version, so it is only a candidate — the index wins.
      try {
        const local = await this.storage.query(filters);
        for (const e of local) {
          candidates.push(e);
          if (shouldObserve) this.#ingest(e, undefined, { persist: false, meta: false });
        }
      } catch (err) {
        invokeSafely(() => this.onstorageerror?.(toStorageError(err)));
      }
    }

    // Every inbound event lands in the index (with its relay URL) before the
    // caller's onevent runs; the batch below re-ingests for persistence.
    const onevent = (event: Event, relayUrl: string) => {
      if (shouldObserve) this.#ingest(event, relayUrl, { persist: false, meta: false });
      opts?.onevent?.(event, relayUrl);
    };

    const batch =
      !opts?.gossip || opts.relays
        ? await this.pool.fetch(this.#defaultRelays(opts?.relays), filters, {
            timeoutMs: opts?.timeoutMs,
            signal: opts?.signal,
            onevent,
          })
        : await fetchGossip(this.pool, this.gossip, filters, () => this.#defaultRelays(), {
            timeoutMs: opts?.timeoutMs,
            signal: opts?.signal,
            onevent,
          });
    for (const e of batch) {
      candidates.push(e);
      if (shouldObserve) this.observe(e);
    }

    // Merge through a scratch index so NIP-01 replaceable winners, kind-5
    // deletions, dedupe and per-filter limits all apply to the result.
    // Ephemeral kinds are never stored; matching ones join the result directly.
    const tmp = new MemoryIndex();
    const ephemeral = new Map<string, Event>();
    const merged = opts?.localFirst ? [...this.index.query(filters), ...candidates] : candidates;
    for (const e of merged) {
      if (tmp.put(e) === "ephemeral" && matchFilters(filters, e)) ephemeral.set(e.id, e);
    }
    return sortedEvents([...tmp.query(filters), ...ephemeral.values()]);
  }

  /**
   * Query local storage only (no network).
   */
  async queryLocal(filter: Filter | Filter[]): Promise<Event[]> {
    this.#assertAlive();
    const filters = canonicalizeFilters(Array.isArray(filter) ? filter : [filter]);
    return this.storage.query(filters);
  }

  subscribe(
    filter: Filter | Filter[],
    opts?: SubscribeOptions,
  ): { close: (reason?: string) => void } {
    this.#assertAlive();
    const filters = canonicalizeFilters(Array.isArray(filter) ? filter : [filter]);
    const shouldObserve = this.#wantObserve(opts?.observe);

    const wrapEvent = (event: Event, relayUrl: string) => {
      if (shouldObserve) this.observe(event, relayUrl);
      opts?.onevent?.(event, relayUrl);
    };

    const wrapReceived = (id: string, relayUrl: string) => {
      if (shouldObserve) this.#markSeen(id, relayUrl);
      opts?.receivedEvent?.(id, relayUrl);
    };

    if (!opts?.gossip || opts.relays) {
      return this.pool.subscribe(this.#defaultRelays(opts?.relays), filters, {
        onevent: wrapEvent,
        receivedEvent: wrapReceived,
        oneose: opts?.oneose,
        onclose: opts?.onclose,
        signal: opts?.signal,
        id: opts?.id,
        eoseTimeoutMs: opts?.eoseTimeoutMs,
      });
    }

    return subscribeGossip(this.pool, this.gossip, filters, () => this.#defaultRelays(), {
      onevent: wrapEvent,
      receivedEvent: wrapReceived,
      oneose: opts?.oneose,
      onclose: opts?.onclose,
      signal: opts?.signal,
      eoseTimeoutMs: opts?.eoseTimeoutMs,
    });
  }

  #requireNip59Crypto(): Nip59Crypto {
    if (!this.#signer) throw new ClientError("no signer configured");
    return requireNip59Crypto(this.#signer);
  }

  #throwIfAborted(signal?: AbortSignal): void {
    throwIfAborted(signal);
  }

  #dmDeps(): DmDeps {
    return {
      pool: this.pool,
      gossip: this.gossip,
      hydrateGossip: (pubkeys) => this.hydrateGossip(pubkeys),
      ingest: (event, relayUrl) => this.#ingest(event, relayUrl),
      markSeen: (id, relayUrl) => this.#markSeen(id, relayUrl),
      assertAlive: () => this.#assertAlive(),
      requireNip59Crypto: () => this.#requireNip59Crypto(),
      throwIfAborted: (signal) => this.#throwIfAborted(signal),
      wantObserve: (flag) => this.#wantObserve(flag),
      publish: (eventOrBuilder, opts) => this.publish(eventOrBuilder, opts),
    };
  }

  #syncDeps(): SyncDeps {
    return {
      pool: this.pool,
      storage: this.storage,
      persistEvents: this.#persistEvents,
      assertAlive: () => this.#assertAlive(),
      throwIfAborted: (signal) => this.#throwIfAborted(signal),
      wantObserve: (flag) => this.#wantObserve(flag),
      ingest: (event, relayUrl, opts) => this.#ingest(event, relayUrl, opts),
      markSeen: (id, relayUrl) => this.#markSeen(id, relayUrl),
      defaultRelays: (urls) => this.#defaultRelays(urls),
    };
  }

  /** Publish a kind:10050 NIP-17 DM relay list (`relay` tags). Not kind 10002. */
  async setDmRelays(
    relays: readonly string[],
    opts?: PublishOptions,
  ): Promise<PoolPublishResult[]> {
    return setDmRelays(this.#dmDeps(), relays, opts);
  }

  async sendPrivateMessage(
    recipients: string | Recipient | readonly (string | Recipient)[],
    content: string,
    opts?: SendPrivateMessageOptions,
  ): Promise<PrivateMessageSendResult> {
    return sendPrivateMessage(this.#dmDeps(), recipients, content, opts);
  }

  async fetchPrivateMessages(
    opts?: FetchPrivateMessagesOptions,
  ): Promise<ReceivedPrivateMessage[]> {
    return fetchPrivateMessages(this.#dmDeps(), opts);
  }

  async subscribePrivateMessages(
    opts?: SubscribePrivateMessagesOptions,
  ): Promise<{ close: (reason?: string) => void }> {
    return subscribePrivateMessages(this.#dmDeps(), opts);
  }

  /**
   * NIP-77 sync against one relay: reconcile, then optionally upload
   * local-only events and/or download remote-only events.
   * `observe: false` skips putMany and ingest; received ids are still listed.
   * `persistEvents: false` skips putMany, still ingests when observe is on.
   */
  async syncToRelay(
    url: string,
    filter: Filter,
    opts?: Omit<SyncOptions, "relays">,
  ): Promise<SyncSummary> {
    return syncToRelay(this.#syncDeps(), url, filter, opts);
  }

  /**
   * NIP-77 sync against the given relays (or Client default relays).
   * Independent sessions run in parallel. Fulfilled summaries are merged;
   * if every relay rejects, throws the first rejection in URL order.
   */
  async sync(filter: Filter, opts?: SyncOptions): Promise<SyncSummary> {
    return sync(this.#syncDeps(), filter, opts);
  }
}
