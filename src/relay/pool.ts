import type { Event, EventTemplate } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import type { CountResult } from "../core/message.ts";
import { normalizeURL } from "../core/util.ts";
import { RelayClosedError } from "./error.ts";
import { Relay, type PublishResult, type RelayOptions, type SubscribeOptions } from "./relay.ts";
import type { WebSocketConstructor } from "./websocket.ts";

export type PoolOptions = {
  websocketImplementation?: WebSocketConstructor;
  verifyEvent?: RelayOptions["verifyEvent"];
  publishTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxWaitForConnectionMs?: number;
  enableReconnect?: boolean;
  reconnectBackoffMs?: number[];
  /** Return false to skip connecting to a relay for a given operation. */
  allowConnectingToRelay?: (url: string, operation: "read" | "write") => boolean;
  /**
   * When set, automatically answer NIP-42 AUTH challenges for relays that
   * send them. Return null to skip a given relay URL.
   */
  automaticallyAuth?: (relayURL: string) => null | ((event: EventTemplate) => Promise<Event>);
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

export type PoolSubscribeOptions = SubscribeOptions & {
  /** Max ms to wait for each relay connection. */
  connectionTimeoutMs?: number;
};

/**
 * Multi-relay coordinator: connection reuse, cross-relay event dedup, fan-out publish.
 */
export class Pool {
  readonly #relays = new Map<string, Relay>();
  readonly #opts: PoolOptions;
  seenOn = new Map<string, Set<string>>();
  trackRelays = false;

  constructor(opts: PoolOptions = {}) {
    this.#opts = opts;
  }

  async ensureRelay(
    url: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Relay> {
    const norm = normalizeURL(url);
    let relay = this.#relays.get(norm);
    if (!relay) {
      relay = new Relay(norm, {
        websocketImplementation: this.#opts.websocketImplementation,
        verifyEvent: this.#opts.verifyEvent,
        publishTimeoutMs: this.#opts.publishTimeoutMs,
        connectTimeoutMs: this.#opts.connectTimeoutMs,
        enableReconnect: this.#opts.enableReconnect,
        reconnectBackoffMs: this.#opts.reconnectBackoffMs,
      });
      // Only drop from the pool on terminal close (reconnect keeps the entry).
      relay.onclose = () => {
        this.#relays.delete(norm);
      };
      if (this.#opts.automaticallyAuth) {
        const signFn = this.#opts.automaticallyAuth(norm);
        if (signFn) {
          relay.onauth = (challenge) => {
            void relay!.auth(signFn).catch(() => {
              // auth failure surfaces on subsequent CLOSED/OK; avoid unhandled rejection
              void challenge;
            });
          };
        }
      }
      this.#relays.set(norm, relay);
    }
    if (!relay.connected) {
      try {
        await relay.connect({
          signal: opts?.signal,
          timeoutMs:
            opts?.timeoutMs ?? this.#opts.maxWaitForConnectionMs ?? this.#opts.connectTimeoutMs,
        });
      } catch (err) {
        // Keep the entry when reconnect is enabled so open subscriptions can recover.
        if (!this.#opts.enableReconnect) {
          this.#relays.delete(norm);
        }
        throw err;
      }
    }
    return relay;
  }

  close(urls?: string[]): void {
    if (!urls) {
      for (const relay of this.#relays.values()) relay.close();
      this.#relays.clear();
      return;
    }
    for (const url of urls) {
      const norm = normalizeURL(url);
      this.#relays.get(norm)?.close();
      this.#relays.delete(norm);
    }
  }

  #allowed(url: string, operation: "read" | "write"): boolean {
    return this.#opts.allowConnectingToRelay?.(url, operation) ?? true;
  }

  /**
   * Subscribe across relays. Deduplicates by event id.
   * Returns a closer; callbacks receive every new event once.
   */
  subscribe(
    relays: string[],
    filters: Filter[],
    opts: PoolSubscribeOptions = {},
  ): { close: (reason?: string) => void } {
    const seen = new Set<string>();
    const closers: Array<{ close: (reason?: string) => void }> = [];
    let closed = false;

    const closeAll = (reason?: string) => {
      if (closed) return;
      closed = true;
      for (const c of closers) c.close(reason);
    };

    if (opts.signal?.aborted) {
      opts.onclose?.("aborted");
      return { close: closeAll };
    }

    opts.signal?.addEventListener("abort", () => closeAll("aborted"), { once: true });

    const closeReasons: Array<{ url: string; reason: string }> = [];
    let pending = 0;

    for (const url of relays) {
      if (!this.#allowed(url, "read")) continue;
      pending += 1;
      void this.ensureRelay(url, {
        signal: opts.signal,
        timeoutMs: opts.connectionTimeoutMs ?? this.#opts.maxWaitForConnectionMs,
      })
        .then((relay) => {
          if (closed) return;
          const sub = relay.subscribe(filters, {
            id: opts.id,
            signal: opts.signal,
            eoseTimeoutMs: opts.eoseTimeoutMs,
            onevent: (event) => {
              if (seen.has(event.id)) return;
              seen.add(event.id);
              if (this.trackRelays) {
                let set = this.seenOn.get(event.id);
                if (!set) {
                  set = new Set();
                  this.seenOn.set(event.id, set);
                }
                set.add(relay.url);
              }
              opts.onevent?.(event);
            },
            oneose: opts.oneose,
            onclose: (reason) => {
              closeReasons.push({ url: relay.url, reason });
              pending -= 1;
              if (pending <= 0) {
                // Aggregate close: tools passes per-relay reasons; we pass last reason for simplicity.
                opts.onclose?.(reason);
              }
            },
          });
          closers.push(sub);
        })
        .catch(() => {
          pending -= 1;
          if (pending <= 0 && closers.length === 0) {
            opts.onclose?.("all relays failed");
          }
        });
    }

    if (pending === 0) {
      queueMicrotask(() => opts.onclose?.("no relays"));
    }

    return { close: closeAll };
  }

  /** Fetch events until each connected relay EOSE or timeout; dedupe by id. */
  async fetch(
    relays: string[],
    filters: Filter[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Event[]> {
    const timeoutMs = opts?.timeoutMs ?? 4400;
    const events = new Map<string, Event>();

    await Promise.all(
      relays.map(async (url) => {
        if (!this.#allowed(url, "read")) return;
        try {
          const relay = await this.ensureRelay(url, {
            signal: opts?.signal,
            timeoutMs: this.#opts.maxWaitForConnectionMs,
          });
          const batch = await relay.fetch(filters, { timeoutMs, signal: opts?.signal });
          for (const event of batch) {
            if (!events.has(event.id)) events.set(event.id, event);
            if (this.trackRelays) {
              let set = this.seenOn.get(event.id);
              if (!set) {
                set = new Set();
                this.seenOn.set(event.id, set);
              }
              set.add(relay.url);
            }
          }
        } catch {
          // skip failed relays
        }
      }),
    );

    return [...events.values()];
  }

  /** Publish to all listed relays; returns per-relay outcomes. */
  async publish(
    relays: string[],
    event: Event,
    opts?: { timeoutMs?: number },
  ): Promise<PoolPublishResult[]> {
    const results = await Promise.all(
      relays.map(async (url): Promise<PoolPublishResult> => {
        if (!this.#allowed(url, "write")) {
          return { url, error: "not allowed" };
        }
        try {
          const relay = await this.ensureRelay(url, {
            timeoutMs: this.#opts.maxWaitForConnectionMs,
          });
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
    const allowed = relays.filter((url) => this.#allowed(url, "write"));
    if (allowed.length === 0) throw new RelayClosedError("no relays allowed for write");

    return Promise.any(
      allowed.map(async (url) => {
        const relay = await this.ensureRelay(url, {
          timeoutMs: this.#opts.maxWaitForConnectionMs,
        });
        const result = await relay.publish(event, { timeoutMs: opts?.timeoutMs });
        if (!result.ok) throw new Error(result.message || "rejected");
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
    const results = await Promise.all(
      relays.map(async (url): Promise<PoolCountResult> => {
        if (!this.#allowed(url, "read")) {
          return { url, error: "not allowed" };
        }
        try {
          const relay = await this.ensureRelay(url, {
            signal: opts?.signal,
            timeoutMs: this.#opts.maxWaitForConnectionMs,
          });
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
}
