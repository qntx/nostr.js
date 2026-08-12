import type { Event, EventTemplate, UnsignedEvent } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { CryptoError } from "../core/error.ts";
import { EventBuilder } from "../core/builder.ts";
import type { NostrSigner } from "../signer/types.ts";
import { Pool, type PoolPublishResult } from "../relay/pool.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import { createLoaders, type Loaders } from "../loaders/index.ts";
import { Gossip } from "../gossip/index.ts";
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
};

/**
 * Layer-5 facade: signer + default relays + pool + loaders + gossip.
 */
export class Client {
  readonly pool: Pool;
  readonly loaders: Loaders;
  readonly gossip: Gossip;
  #signer: NostrSigner | undefined;
  #relays: string[];
  #shutdown = false;

  constructor(opts: ClientOptions = {}) {
    this.#signer = opts.signer;
    this.#relays = [...(opts.relays ?? [])];
    this.gossip = opts.gossip ?? new Gossip();
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
   */
  async publish(
    eventOrBuilder: Event | EventBuilder,
    opts?: { relays?: string[]; timeoutMs?: number; gossip?: boolean },
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
    return this.pool.publish(this.#defaultRelays(relays), event, {
      timeoutMs: opts?.timeoutMs,
    });
  }

  /**
   * Fetch events. With `gossip: true`, breaks filters by NIP-65 routes when possible.
   */
  async fetchEvents(
    filter: Filter | Filter[],
    opts?: { relays?: string[]; timeoutMs?: number; signal?: AbortSignal; gossip?: boolean },
  ): Promise<Event[]> {
    this.#assertAlive();
    const filters = Array.isArray(filter) ? filter : [filter];

    if (!opts?.gossip || opts.relays) {
      return this.pool.fetch(this.#defaultRelays(opts?.relays), filters, {
        timeoutMs: opts?.timeoutMs,
        signal: opts?.signal,
      });
    }

    const byId = new Map<string, Event>();
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
              for (const e of batch) byId.set(e.id, e);
            } catch {
              // skip failed relay
            }
          }),
        );
      } else {
        // orphan or generic → fall back to configured relays
        const batch = await this.pool.fetch(this.#defaultRelays(), [f], {
          timeoutMs: opts?.timeoutMs,
          signal: opts?.signal,
        });
        for (const e of batch) byId.set(e.id, e);
      }
    }
    return [...byId.values()];
  }

  subscribe(
    filter: Filter | Filter[],
    opts?: {
      relays?: string[];
      onevent?: (event: Event) => void;
      oneose?: () => void;
      onclose?: (reason: string) => void;
      signal?: AbortSignal;
      id?: string;
      /** Fan out REQs via NIP-65 gossip routes when available. */
      gossip?: boolean;
    },
  ): { close: (reason?: string) => void } {
    this.#assertAlive();
    const filters = Array.isArray(filter) ? filter : [filter];

    if (!opts?.gossip || opts.relays) {
      return this.pool.subscribe(this.#defaultRelays(opts?.relays), filters, {
        onevent: opts?.onevent,
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
                opts?.onevent?.(event);
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
              opts?.onevent?.(event);
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

  /** Ingest events into gossip routing (kind 10002) and loader caches when applicable. */
  observe(event: Event): void {
    this.gossip.ingest(event);
    if (event.kind === 0 || event.kind === 3 || event.kind === 10000 || event.kind === 10002) {
      this.loaders.context.cache.putIfNewer(event);
    }
  }
}
