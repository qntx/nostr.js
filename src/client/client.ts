import type { Event, EventTemplate, UnsignedEvent } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { sortedEvents } from "../core/event.ts";
import { CryptoError } from "../core/error.ts";
import { Kind } from "../core/kind.ts";
import { normalizeURL } from "../core/util.ts";
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
import { toStorageError, type StorageError } from "../storage/error.ts";
import { MemoryEventStore } from "../storage/memory.ts";
import {
  isGiftWrapKind,
  requireNip59Crypto,
  unwrap,
  type Nip59Crypto,
  type Rumor,
} from "../nips/nip59.ts";
import {
  Nip17Error,
  buildChatMessageRumor,
  dmRelayListEventBuilder,
  normalizeRecipients,
  requireDmRelays,
  wrapDirectMessage,
  type Recipient,
  type ReplyTo,
} from "../nips/nip17.ts";
import { storageFromItems, type NegentropyStorageVector } from "../nips/nip77.ts";
import { ClientBuilder } from "./builder.ts";

export const SyncDirection = {
  Up: "up",
  Down: "down",
  Both: "both",
} as const;

export type SyncDirectionName = (typeof SyncDirection)[keyof typeof SyncDirection];

export type SyncOptions = {
  relays?: readonly string[];
  direction?: SyncDirectionName;
  /**
   * Wall-clock deadline for the Negentropy reconciliation session
   * (`NEG-OPEN` through `NEG-CLOSE`), in milliseconds.
   * One clock for the whole session — not reset per `NEG-MSG`.
   * Default: the relay `publishTimeoutMs`.
   * Upload/download phases reuse this value as their per-call timeout.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  dryRun?: boolean;
  /** When false, skip observe/storage on downloaded events. Default true. */
  observe?: boolean;
};

export type SyncSummary = {
  local: string[];
  remote: string[];
  sent: string[];
  received: string[];
  sendFailures: Record<string, string>;
};

const SYNC_ID_BATCH = 100;

function mergeSyncSummary(into: SyncSummary, other: SyncSummary): SyncSummary {
  const sendFailures = { ...into.sendFailures, ...other.sendFailures };
  return {
    local: uniqueIds([...into.local, ...other.local]),
    remote: uniqueIds([...into.remote, ...other.remote]),
    sent: uniqueIds([...into.sent, ...other.sent]),
    received: uniqueIds([...into.received, ...other.received]),
    sendFailures,
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function emptySummary(): SyncSummary {
  return { local: [], remote: [], sent: [], received: [], sendFailures: {} };
}

export type ClientOptions = {
  signer?: NostrSigner;
  relays?: readonly string[];
  websocketImplementation?: WebSocketConstructor;
  /** Injected EVENT verifier. Default is core BIP-340. */
  verifyEvent?: (event: Event) => boolean;
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  /** When true (default if signer present), answer NIP-42 AUTH automatically. */
  automaticAuth?: boolean;
  /** When true (default), relays reconnect with backoff after disconnect. */
  enableReconnect?: boolean;
  /** Keepalive ping. Default false. */
  enablePing?: boolean;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  gossip?: Gossip;
  /**
   * Local event store. Defaults to {@link MemoryEventStore}.
   * Browser apps that want persistence must pass {@link IndexedDbEventStore} and `await open()`.
   */
  storage?: EventStore;
  /**
   * When true (default), every ingested event is written to storage.
   * Set false to disable automatic persistence while keeping the store for manual use.
   */
  persistEvents?: boolean;
  /** Live persist failures. Does not throw on the subscribe path. */
  onstorageerror?: (err: StorageError) => void;
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
  /**
   * If set, fire `oneose` once after this many ms if not all relays have EOSEd.
   * Does not close the subscription.
   */
  eoseTimeoutMs?: number;
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

export type SendPrivateMessageOptions = {
  readonly subject?: string;
  readonly replyTo?: ReplyTo;
  readonly created_at?: number;
  readonly timeoutMs?: number;
  readonly observe?: boolean;
};

export type PrivateMessageSendResult = {
  rumor: Rumor;
  wraps: ReadonlyArray<{
    recipient: string;
    wrap: Event;
    results: PoolPublishResult[];
  }>;
};

export type ReceivedPrivateMessage = {
  wrap: Event;
  rumor: Rumor;
};

export type FetchPrivateMessagesOptions = {
  readonly since?: number;
  readonly until?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly observe?: boolean;
};

export type SubscribePrivateMessagesOptions = {
  readonly since?: number;
  readonly onevent?: (msg: ReceivedPrivateMessage) => void;
  readonly oneose?: () => void;
  readonly onclose?: (reason: string) => void;
  readonly signal?: AbortSignal;
  readonly eoseTimeoutMs?: number;
  readonly observe?: boolean;
};

/**
 * Layer-5 facade: signer + default relays + pool + loaders + gossip + event store.
 */
export class Client {
  readonly pool: Pool;
  readonly loaders: Loaders;
  readonly gossip: Gossip;
  readonly storage: EventStore;
  onstorageerror: ((err: StorageError) => void) | null;
  #signer: NostrSigner | undefined;
  #relays: string[];
  #shutdown = false;
  #persistEvents: boolean;
  #persistQueue: Event[] = [];
  #flushing: Promise<void> | undefined;

  constructor(opts: ClientOptions = {}) {
    this.#signer = opts.signer;
    this.#relays = [...(opts.relays ?? [])];
    this.gossip = opts.gossip ?? new Gossip();
    this.storage = opts.storage ?? new MemoryEventStore();
    this.#persistEvents = opts.persistEvents ?? true;
    this.onstorageerror = opts.onstorageerror ?? null;
    const autoAuth = opts.automaticAuth ?? Boolean(opts.signer);
    this.pool = new Pool({
      websocketImplementation: opts.websocketImplementation,
      verifyEvent: opts.verifyEvent,
      enablePing: opts.enablePing,
      pingIntervalMs: opts.pingIntervalMs,
      pingTimeoutMs: opts.pingTimeoutMs,
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
    while (this.#flushing) await this.#flushing;
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
   * Unified ingest pipeline: gossip + replaceable loader cache immediately;
   * storage writes are coalesced into a single-flight `putMany`.
   */
  observe(event: Event): void {
    this.#ingestMeta(event);
    if (!this.#persistEvents) return;
    this.#persistQueue.push(event);
    this.#armFlush();
  }

  /** Observe many events (deduped by id, order preserved) as one persist batch. */
  observeAll(events: readonly Event[]): void {
    const seen = new Set<string>();
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      this.#ingestMeta(event);
      if (this.#persistEvents) this.#persistQueue.push(event);
    }
    if (this.#persistEvents && this.#persistQueue.length > 0) this.#armFlush();
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
          this.onstorageerror?.(toStorageError(err));
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
   * Live events go through {@link observe}; sync persists via putMany then ingestMeta.
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
      ingestMeta: (event) => this.#ingestMeta(event),
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
      relays = this.#giftWrapRelays(event);
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
        eoseTimeoutMs: opts?.eoseTimeoutMs,
      });
    }

    const seen = new Set<string>();
    const closers: Array<{ close: (reason?: string) => void }> = [];
    let pendingEose = 0;
    let eoseFired = false;
    let closed = false;
    let eoseTimer: ReturnType<typeof setTimeout> | undefined;

    const fireEose = () => {
      if (closed || eoseFired) return;
      eoseFired = true;
      if (eoseTimer !== undefined) {
        clearTimeout(eoseTimer);
        eoseTimer = undefined;
      }
      opts?.oneose?.();
    };

    const maybeEose = () => {
      pendingEose -= 1;
      if (pendingEose <= 0) fireEose();
    };

    const close = (reason?: string) => {
      if (closed) return;
      closed = true;
      if (eoseTimer !== undefined) {
        clearTimeout(eoseTimer);
        eoseTimer = undefined;
      }
      for (const c of closers) c.close(reason);
    };

    if (opts.signal?.aborted) closed = true;
    else opts.signal?.addEventListener("abort", () => close("aborted"), { once: true });

    for (const f of filters) {
      const broken = this.gossip.breakDownFilter(f);
      if (broken.type === "per-relay") {
        for (const [url, subFilter] of broken.filters) {
          pendingEose += 1;
          closers.push(
            this.pool.subscribe([url], [subFilter], {
              signal: opts.signal,
              onevent: (event) => {
                if (seen.has(event.id)) return;
                seen.add(event.id);
                wrapEvent(event);
              },
              oneose: maybeEose,
              onclose: opts.onclose,
            }),
          );
        }
      } else {
        pendingEose += 1;
        closers.push(
          this.pool.subscribe(this.#defaultRelays(), [f], {
            signal: opts.signal,
            id: opts.id,
            onevent: (event) => {
              if (seen.has(event.id)) return;
              seen.add(event.id);
              wrapEvent(event);
            },
            oneose: maybeEose,
            onclose: opts.onclose,
          }),
        );
      }
    }

    if (pendingEose === 0) {
      queueMicrotask(() => fireEose());
    }

    if (opts.eoseTimeoutMs !== undefined && !closed) {
      eoseTimer = setTimeout(() => {
        eoseTimer = undefined;
        fireEose();
      }, opts.eoseTimeoutMs);
    }

    return { close };
  }

  #requireNip59Crypto(): Nip59Crypto {
    if (!this.#signer) throw new CryptoError("no signer configured");
    return requireNip59Crypto(this.#signer);
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new CryptoError("aborted");
  }

  #giftWrapRelays(event: Event): string[] {
    const targets: string[] = [];
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1]) targets.push(tag[1].toLowerCase());
    }
    if (targets.length === 0) {
      throw new Nip17Error("gift wrap has no p-tag recipient");
    }
    if (targets.length !== 1) {
      throw new Nip17Error("gift wrap must have exactly one p-tag recipient");
    }
    const relays = this.gossip.dmRelays(targets[0]!);
    if (relays.length === 0) {
      throw new Nip17Error("no kind 10050 in gossip; use sendPrivateMessage or pass relays");
    }
    return relays;
  }

  /** Publish a public kind:10050 list (NIP-65 outbox / default relays, not DM relays). */
  async setDmRelays(
    relays: readonly string[],
    opts?: PublishOptions,
  ): Promise<PoolPublishResult[]> {
    return this.publish(dmRelayListEventBuilder(relays), { gossip: true, ...opts });
  }

  async sendPrivateMessage(
    recipients: string | Recipient | readonly (string | Recipient)[],
    content: string,
    opts?: SendPrivateMessageOptions,
  ): Promise<PrivateMessageSendResult> {
    this.#assertAlive();
    const crypto = this.#requireNip59Crypto();
    const sender = await crypto.getPublicKey();
    const list = normalizeRecipients(recipients);
    if (list.length === 0) {
      throw new Nip17Error("recipients must not be empty");
    }

    const targets = new Set<string>([sender.toLowerCase(), ...list.map((r) => r.pubkey)]);
    await this.hydrateGossip([...targets]);
    for (const pk of targets) {
      requireDmRelays(pk, this.gossip.dmRelays(pk));
    }

    const rumor = buildChatMessageRumor(sender, list, content, {
      created_at: opts?.created_at,
      subject: opts?.subject,
      replyTo: opts?.replyTo,
    });
    const wraps = await wrapDirectMessage(crypto, list, rumor);
    const sent: Array<{
      recipient: string;
      wrap: Event;
      results: PoolPublishResult[];
    }> = [];
    for (const { recipient, wrap } of wraps) {
      const relays = requireDmRelays(recipient, this.gossip.dmRelays(recipient));
      const results = await this.pool.publish(relays, wrap, { timeoutMs: opts?.timeoutMs });
      const anyOk = results.some((r) => r.result?.ok);
      if (anyOk && opts?.observe !== false) {
        this.observe(wrap);
      }
      sent.push({ recipient, wrap, results });
    }
    return { rumor, wraps: sent };
  }

  async fetchPrivateMessages(
    opts?: FetchPrivateMessagesOptions,
  ): Promise<ReceivedPrivateMessage[]> {
    this.#assertAlive();
    const crypto = this.#requireNip59Crypto();
    const self = await crypto.getPublicKey();
    this.#throwIfAborted(opts?.signal);
    await this.hydrateGossip([self]);
    this.#throwIfAborted(opts?.signal);
    const relays = requireDmRelays(self, this.gossip.dmRelays(self));
    const events = await this.pool.fetch(
      relays,
      [
        {
          kinds: [Kind.GiftWrap],
          "#p": [self],
          since: opts?.since,
          until: opts?.until,
        },
      ],
      { timeoutMs: opts?.timeoutMs, signal: opts?.signal },
    );

    const byRumor = new Map<string, ReceivedPrivateMessage>();
    for (const wrap of events) {
      if (opts?.observe !== false) this.observe(wrap);
      try {
        const rumor = await unwrap(crypto, wrap);
        byRumor.set(rumor.id, { wrap, rumor });
      } catch {
        // junk / forgery / key mismatch — NIP-17 allows unreadable wraps
      }
    }

    return [...byRumor.values()].sort((a, b) => {
      if (a.rumor.created_at !== b.rumor.created_at) {
        return a.rumor.created_at - b.rumor.created_at;
      }
      return a.rumor.id.localeCompare(b.rumor.id);
    });
  }

  async subscribePrivateMessages(
    opts?: SubscribePrivateMessagesOptions,
  ): Promise<{ close: (reason?: string) => void }> {
    this.#assertAlive();
    const crypto = this.#requireNip59Crypto();
    const self = await crypto.getPublicKey();
    this.#throwIfAborted(opts?.signal);
    await this.hydrateGossip([self]);
    this.#throwIfAborted(opts?.signal);
    const relays = requireDmRelays(self, this.gossip.dmRelays(self));

    const seen = new Set<string>();
    let tail = Promise.resolve();
    return this.pool.subscribe(
      relays,
      // 21059 is ephemeral (relays MUST NOT store); live inbox has to REQ it.
      [{ kinds: [Kind.GiftWrap, Kind.GiftWrapEphemeral], "#p": [self], since: opts?.since }],
      {
        signal: opts?.signal,
        oneose: opts?.oneose,
        onclose: opts?.onclose,
        eoseTimeoutMs: opts?.eoseTimeoutMs,
        onevent: (wrap) => {
          tail = tail
            .then(async () => {
              if (opts?.observe !== false) this.observe(wrap);
              try {
                const rumor = await unwrap(crypto, wrap);
                if (seen.has(rumor.id)) return;
                seen.add(rumor.id);
                opts?.onevent?.({ wrap, rumor });
              } catch {
                // drop
              }
            })
            .catch(() => {
              // keep the queue alive if a handler throws
            });
        },
      },
    );
  }

  /**
   * NIP-77 sync against one relay: reconcile, then optionally upload
   * local-only events and/or download remote-only events.
   */
  async syncToRelay(
    url: string,
    filter: Filter,
    opts?: Omit<SyncOptions, "relays">,
  ): Promise<SyncSummary> {
    this.#assertAlive();
    this.#throwIfAborted(opts?.signal);
    const direction = opts?.direction ?? SyncDirection.Down;
    const items = await this.storage.negentropyItems(filter);
    const storage: NegentropyStorageVector = storageFromItems(items);
    const relay = await this.pool.ensureRelay(url, { signal: opts?.signal });
    const { have, need } = await relay.negReconcile(filter, storage, {
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
    });

    const summary: SyncSummary = {
      local: have,
      remote: need,
      sent: [],
      received: [],
      sendFailures: {},
    };

    if (opts?.dryRun) return summary;

    if (direction === SyncDirection.Up || direction === SyncDirection.Both) {
      for (const id of have) {
        const event = await this.storage.get(id);
        if (!event) {
          summary.sendFailures[id] = "event not found in local store";
          continue;
        }
        try {
          const results = await this.pool.publish([url], event, { timeoutMs: opts?.timeoutMs });
          const ok = results.some((r) => r.result?.ok);
          if (ok) summary.sent.push(id);
          else {
            summary.sendFailures[id] =
              results[0]?.error ?? results[0]?.result?.message ?? "publish failed";
          }
        } catch (error) {
          summary.sendFailures[id] = error instanceof Error ? error.message : String(error);
        }
      }
    }

    if ((direction === SyncDirection.Down || direction === SyncDirection.Both) && need.length > 0) {
      const shouldObserve = opts?.observe !== false;
      for (let i = 0; i < need.length; i += SYNC_ID_BATCH) {
        const batch = need.slice(i, i + SYNC_ID_BATCH);
        this.#throwIfAborted(opts?.signal);
        const events = await this.pool.fetch([url], [{ ids: batch }], {
          timeoutMs: opts?.timeoutMs,
          signal: opts?.signal,
        });
        let results;
        try {
          results = await this.storage.putMany(events);
        } catch {
          continue;
        }
        for (let j = 0; j < events.length; j++) {
          const event = events[j]!;
          if (results[j] === "rejected") continue;
          if (shouldObserve) this.#ingestMeta(event);
          summary.received.push(event.id);
        }
      }
    }

    return summary;
  }

  /**
   * NIP-77 sync against the given relays (or Client default relays).
   * Independent sessions run in parallel. Fulfilled summaries are merged;
   * if every relay rejects, throws the first rejection in URL order.
   */
  async sync(filter: Filter, opts?: SyncOptions): Promise<SyncSummary> {
    this.#assertAlive();
    const urls = this.#defaultRelays(opts?.relays ? [...opts.relays] : undefined);
    const results = await Promise.allSettled(
      urls.map((url) => this.syncToRelay(url, filter, opts)),
    );
    let merged = emptySummary();
    let fulfilled = 0;
    let firstRejection: unknown;
    for (const result of results) {
      if (result.status === "fulfilled") {
        fulfilled += 1;
        merged = mergeSyncSummary(merged, result.value);
      } else {
        firstRejection ??= result.reason;
      }
    }
    if (urls.length > 0 && fulfilled === 0) throw firstRejection;
    return merged;
  }
}
