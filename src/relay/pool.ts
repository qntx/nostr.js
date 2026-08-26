import type { Event, EventTemplate } from "../core/event.ts";
import { canonicalizeFilters, type Filter } from "../core/filter.ts";
import { assertSubscriptionId, type CountResult } from "../core/message.ts";
import { normalizeURL } from "../core/util.ts";
import { RelayConnectionError, RelayPublishError } from "./error.ts";
import { fanIn, fetchRouted } from "./fan-in.ts";
import { Relay, type PublishResult, type RelayOptions, type SubscribeOptions } from "./relay.ts";
import { isInsecureRelayUrl } from "./url.ts";
import type { WebSocketConstructor } from "./websocket.ts";

export type PoolOptions = {
  websocketImplementation?: WebSocketConstructor;
  verifyEvent?: RelayOptions["verifyEvent"];
  publishTimeoutMs?: number;
  connectTimeoutMs?: number;
  enableReconnect?: boolean;
  reconnectBackoffMs?: number[];
  enablePing?: boolean;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /**
   * When set, automatically answer NIP-42 AUTH challenges for relays that
   * send them. Return null to skip a given relay URL.
   */
  automaticallyAuth?: (relayURL: string) => null | ((event: EventTemplate) => Promise<Event>);
  /** When false, ensureRelay rejects isInsecureRelayUrl unless trusted. Default true (allow). */
  allowInsecure?: boolean;
  trustedInsecureUrls?: readonly string[];
  /** Close unused relays. Unset/0 = disabled. */
  idleTimeoutMs?: number;
  idleCleanupIntervalMs?: number;
  onIdleRelaysClosed?: (urls: string[]) => void;
};

export type PoolPublishResult = {
  url: string;
  result?: PublishResult;
  error?: string;
};

export type PoolCountResult = {
  url: string;
  count?: number;
  approximate?: boolean;
  hll?: string;
  error?: string;
};

/**
 * Multi-relay coordinator: connection reuse, cross-relay event dedup, fan-out publish.
 */
export class Pool {
  readonly #relays = new Map<string, Relay>();
  readonly #opts: PoolOptions;
  readonly #lastActivity = new Map<string, number>();
  readonly #idleTimeoutMs: number;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #allowInsecure: boolean;
  #trustedInsecure: Set<string>;

  constructor(opts: PoolOptions = {}) {
    this.#opts = opts;
    this.#allowInsecure = opts.allowInsecure ?? true;
    this.#trustedInsecure = new Set((opts.trustedInsecureUrls ?? []).map(normalizeURL));
    this.#idleTimeoutMs = opts.idleTimeoutMs ?? 0;
    if (this.#idleTimeoutMs > 0) {
      this.#idleTimer = setInterval(
        () => this.cleanIdleRelays(),
        opts.idleCleanupIntervalMs ?? 30_000,
      );
    }
  }

  setAllowInsecure(allow: boolean): void {
    this.#allowInsecure = allow;
  }

  setTrustedInsecureUrls(urls: readonly string[]): void {
    this.#trustedInsecure = new Set(urls.map(normalizeURL));
  }

  cleanIdleRelays(): void {
    if (this.#idleTimeoutMs <= 0) return;
    const now = Date.now();
    const idle: string[] = [];
    for (const [url, relay] of this.#relays) {
      if (relay.subscriptionCount > 0) continue;
      const last = this.#lastActivity.get(url) ?? 0;
      if (!relay.connected || now - last >= this.#idleTimeoutMs) {
        idle.push(url);
      }
    }
    for (const url of this.#lastActivity.keys()) {
      if (!this.#relays.has(url)) this.#lastActivity.delete(url);
    }
    if (idle.length === 0) return;
    this.close(idle);
    this.#opts.onIdleRelaysClosed?.(idle);
  }

  #touch(url: string): void {
    this.#lastActivity.set(url, Date.now());
  }

  #rejectInsecure(url: string, norm: string): void {
    if (this.#allowInsecure) return;
    if (!isInsecureRelayUrl(url)) return;
    if (this.#trustedInsecure.has(norm)) return;
    throw new RelayConnectionError("insecure relay connection blocked", norm);
  }

  #stopIdleCleanup(): void {
    if (this.#idleTimer === undefined) return;
    clearInterval(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  async ensureRelay(
    url: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Relay> {
    const norm = normalizeURL(url);
    this.#rejectInsecure(url, norm);
    let relay = this.#relays.get(norm);
    if (!relay) {
      const signFn = this.#opts.automaticallyAuth?.(norm) ?? undefined;
      const created = new Relay(norm, {
        websocketImplementation: this.#opts.websocketImplementation,
        verifyEvent: this.#opts.verifyEvent,
        publishTimeoutMs: this.#opts.publishTimeoutMs,
        connectTimeoutMs: this.#opts.connectTimeoutMs,
        enableReconnect: this.#opts.enableReconnect,
        reconnectBackoffMs: this.#opts.reconnectBackoffMs,
        enablePing: this.#opts.enablePing,
        pingIntervalMs: this.#opts.pingIntervalMs,
        pingTimeoutMs: this.#opts.pingTimeoutMs,
        authSigner: signFn,
      });
      // Only drop from the pool on terminal close (reconnect keeps the entry).
      created.onclose = () => {
        this.#relays.delete(norm);
        this.#lastActivity.delete(norm);
      };
      if (signFn) {
        created.onauth = () => {
          void created.auth(signFn).catch(() => {
            // auth failure surfaces on subsequent CLOSED/OK; avoid unhandled rejection
          });
        };
      }
      this.#relays.set(norm, created);
      relay = created;
    }
    this.#touch(norm);
    if (!relay.connected) {
      try {
        await relay.connect({
          signal: opts?.signal,
          timeoutMs: opts?.timeoutMs ?? this.#opts.connectTimeoutMs,
        });
      } catch (err) {
        // Keep the entry when reconnect is enabled so open subscriptions can recover.
        if (!this.#opts.enableReconnect) {
          this.#relays.delete(norm);
          this.#lastActivity.delete(norm);
        }
        throw err;
      }
    }
    return relay;
  }

  close(urls?: string[]): void {
    if (!urls) {
      this.#stopIdleCleanup();
      for (const relay of this.#relays.values()) relay.close();
      this.#relays.clear();
      this.#lastActivity.clear();
      return;
    }
    for (const url of urls) {
      const norm = normalizeURL(url);
      this.#relays.get(norm)?.close();
      this.#relays.delete(norm);
      this.#lastActivity.delete(norm);
    }
  }

  /**
   * Subscribe across relays. Deduplicates by event id.
   * Returns a closer; callbacks receive every new event once.
   */
  subscribe(
    relays: string[],
    filters: Filter[],
    opts: SubscribeOptions = {},
  ): { close: (reason?: string) => void } {
    if (opts.id !== undefined) assertSubscriptionId(opts.id);
    filters = canonicalizeFilters(filters);
    return fanIn(this, [{ urls: relays, filters, id: opts.id }], {
      onevent: opts.onevent,
      oneose: opts.oneose,
      onclose: opts.onclose,
      signal: opts.signal,
      eoseTimeoutMs: opts.eoseTimeoutMs,
      alreadyHaveEvent: opts.alreadyHaveEvent,
      receivedEvent: opts.receivedEvent,
      closeOnEose: opts.closeOnEose,
      connectTimeoutMs: this.#opts.connectTimeoutMs,
    });
  }

  /** Fetch events until each connected relay EOSE or timeout; dedupe by id. */
  async fetch(
    relays: string[],
    filters: Filter[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Event[]> {
    return fetchRouted(this, [{ urls: relays, filters: canonicalizeFilters(filters) }], {
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      connectTimeoutMs: this.#opts.connectTimeoutMs,
    });
  }

  /** Publish to all listed relays; returns per-relay outcomes. */
  async publish(
    relays: string[],
    event: Event,
    opts?: { timeoutMs?: number },
  ): Promise<PoolPublishResult[]> {
    const results = await Promise.all(
      relays.map(async (url): Promise<PoolPublishResult> => {
        try {
          const relay = await this.ensureRelay(url, {
            timeoutMs: this.#opts.connectTimeoutMs,
          });
          this.#touch(relay.url);
          const result = await relay.publish(event, { timeoutMs: opts?.timeoutMs });
          return { url: relay.url, result };
        } catch (err) {
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return results;
  }

  /** First successful publish (Promise.any semantics). */
  async publishAny(
    relays: string[],
    event: Event,
    opts?: { timeoutMs?: number },
  ): Promise<PoolPublishResult> {
    return Promise.any(
      relays.map(async (url) => {
        const relay = await this.ensureRelay(url, {
          timeoutMs: this.#opts.connectTimeoutMs,
        });
        this.#touch(relay.url);
        const result = await relay.publish(event, { timeoutMs: opts?.timeoutMs });
        if (!result.ok) throw new RelayPublishError(result.message || "rejected", relay.url);
        return { url: relay.url, result };
      }),
    );
  }

  /**
   * NIP-45 COUNT across relays. Per-relay outcomes; failures do not throw.
   * Counts are not summed — each relay reports independently (may overlap).
   */
  async count(
    relays: string[],
    filters: Filter[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PoolCountResult[]> {
    filters = canonicalizeFilters(filters);
    const results = await Promise.all(
      relays.map(async (url): Promise<PoolCountResult> => {
        try {
          const relay = await this.ensureRelay(url, {
            signal: opts?.signal,
            timeoutMs: this.#opts.connectTimeoutMs,
          });
          this.#touch(relay.url);
          const payload: CountResult = await relay.count(filters, {
            timeoutMs: opts?.timeoutMs,
            signal: opts?.signal,
          });
          return {
            url: relay.url,
            count: payload.count,
            approximate: payload.approximate,
            hll: payload.hll,
          };
        } catch (err) {
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return results;
  }

  listRelays(): string[] {
    return [...this.#relays.keys()];
  }

  /** Lookup a pooled relay, including disconnected reconnecting entries. */
  getRelay(url: string): Relay | undefined {
    try {
      return this.#relays.get(normalizeURL(url));
    } catch {
      return this.#relays.get(url);
    }
  }

  /** Currently connected URLs. Unlike listRelays(), excludes reconnecting/disconnected entries. */
  connectedUrls(): string[] {
    const urls: string[] = [];
    for (const [url, relay] of this.#relays) {
      if (relay.connected) urls.push(url);
    }
    return urls;
  }
}
