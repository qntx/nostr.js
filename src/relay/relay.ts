import type { Event, EventTemplate } from "../core/event.ts";
import { verifyEvent } from "../core/key.ts";
import type { Filter } from "../core/filter.ts";
import {
  encodeClientMessage,
  parseRelayMessage,
  type ClientMessage,
  type CountResult,
  type SubscriptionId,
} from "../core/message.ts";
import { makeAuthEvent } from "../nips/nip42.ts";
import { normalizeURL } from "../core/util.ts";
import { RelayClosedError, RelayConnectionError, RelayError, RelayPublishError } from "./error.ts";
import {
  Subscription,
  subscriptionToAsyncIterable,
  type SubscribeOptions,
  type SubscriptionHandlers,
} from "./subscription.ts";
import {
  getWebSocketImplementation,
  type WebSocketConstructor,
  type WebSocketLike,
} from "./websocket.ts";

export type RelayOptions = {
  websocketImplementation?: WebSocketConstructor;
  verifyEvent?: (event: Event) => boolean;
  publishTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * When true, unexpected disconnects schedule reconnect with backoff and
   * re-fire open subscriptions. Default false.
   */
  enableReconnect?: boolean;
  /** Backoff delays in ms between reconnect attempts. */
  reconnectBackoffMs?: number[];
};

export type PublishResult = {
  ok: boolean;
  message: string;
};

export type { CountResult };

type PublishWaiter = {
  resolve: (result: PublishResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CountWaiter = {
  resolve: (result: CountResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

/**
 * Single-relay NIP-01 client.
 * Connection lifecycle, REQ/CLOSE, EVENT publish ACK, AUTH, COUNT, optional reconnect.
 */
export class Relay {
  readonly url: string;
  #ws: WebSocketLike | undefined;
  #connected = false;
  #connecting: Promise<void> | undefined;
  #subs = new Map<SubscriptionId, Subscription>();
  #publishes = new Map<string, PublishWaiter>();
  #counts = new Map<string, CountWaiter>();
  #WS: WebSocketConstructor;
  #verify: (event: Event) => boolean;
  #publishTimeoutMs: number;
  #connectTimeoutMs: number;
  #enableReconnect: boolean;
  #backoff: number[];
  #serial = 0;
  #challenge: string | undefined;
  #authPromise: Promise<PublishResult> | undefined;
  #intentionalClose = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #skipReconnect = false;
  /** Collapses error+close pairs into a single terminal/reconnect action. */
  #deathHandled = false;

  onnotice: ((msg: string) => void) | null = null;
  onclose: (() => void) | null = null;
  /** Fired when the relay sends a NIP-42 AUTH challenge. */
  onauth: ((challenge: string) => void) | null = null;
  /** Fired after a successful reconnect (not the initial connect). */
  onreconnect: (() => void) | null = null;

  constructor(url: string, opts: RelayOptions = {}) {
    this.url = normalizeURL(url);
    this.#WS = opts.websocketImplementation ?? getWebSocketImplementation();
    this.#verify = opts.verifyEvent ?? verifyEvent;
    this.#publishTimeoutMs = opts.publishTimeoutMs ?? 4400;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.#enableReconnect = opts.enableReconnect ?? false;
    this.#backoff = opts.reconnectBackoffMs ?? DEFAULT_BACKOFF;
  }

  /** Latest NIP-42 challenge, if any. */
  get challenge(): string | undefined {
    return this.#challenge;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get reconnectEnabled(): boolean {
    return this.#enableReconnect;
  }

  static async connect(
    url: string,
    opts?: RelayOptions & { signal?: AbortSignal },
  ): Promise<Relay> {
    const relay = new Relay(url, opts);
    await relay.connect({ signal: opts?.signal });
    return relay;
  }

  async connect(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    if (this.#connected) return;
    if (this.#connecting) return this.#connecting;

    this.#intentionalClose = false;
    this.#skipReconnect = false;
    this.#deathHandled = false;
    this.#clearReconnectTimer();

    const timeoutMs = opts?.timeoutMs ?? this.#connectTimeoutMs;
    const isReconnect = this.#reconnectAttempts > 0;

    this.#connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        if (err) {
          this.#connecting = undefined;
          reject(
            err instanceof Error ? err : new RelayConnectionError("connection failed", this.url),
          );
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        this.#detachSocketHandlers();
        this.#teardownSocket();
        // only abandon reconnect on initial connect timeout
        if (!isReconnect) this.#skipReconnect = true;
        finish(new RelayConnectionError("connection timed out", this.url));
        this.#handleSocketDeath("connection timed out", { fromConnectAttempt: true });
      }, timeoutMs);

      const onAbort = () => {
        this.#intentionalClose = true;
        this.#detachSocketHandlers();
        this.#teardownSocket();
        this.#skipReconnect = true;
        finish(new RelayConnectionError("connection aborted", this.url));
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.#ws = new this.#WS(this.url);
      } catch (err) {
        finish(err);
        return;
      }

      const ws = this.#ws;

      const onOpen = () => {
        this.#connected = true;
        this.#deathHandled = false;
        const wasReconnect = this.#reconnectAttempts > 0;
        this.#reconnectAttempts = 0;
        this.#challenge = undefined;
        this.#authPromise = undefined;
        this.#resubscribeAll();
        if (wasReconnect) this.onreconnect?.();
        finish();
      };
      const onError = () => {
        this.#connected = false;
        if (!isReconnect) this.#skipReconnect = true;
        finish(new RelayConnectionError("connection failed", this.url));
        this.#handleSocketDeath("connection failed", { fromConnectAttempt: true });
      };
      const onClose = () => {
        this.#connected = false;
        if (!settled) {
          if (!isReconnect) this.#skipReconnect = true;
          finish(new RelayConnectionError("websocket closed", this.url));
        }
        this.#handleSocketDeath("websocket closed", { fromConnectAttempt: !settled });
      };
      const onMessage = (ev: unknown) => {
        const data =
          typeof ev === "object" && ev !== null && "data" in ev
            ? (ev as { data: unknown }).data
            : ev;
        this.#onMessage(String(data));
      };

      // store for detach
      this.#socketHandlers = { onOpen, onError, onClose, onMessage, ws };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);
    });

    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  #socketHandlers:
    | {
        onOpen: () => void;
        onError: () => void;
        onClose: () => void;
        onMessage: (ev: unknown) => void;
        ws: WebSocketLike;
      }
    | undefined;

  #detachSocketHandlers(): void {
    const h = this.#socketHandlers;
    if (!h) return;
    try {
      h.ws.removeEventListener("open", h.onOpen);
      h.ws.removeEventListener("error", h.onError);
      h.ws.removeEventListener("close", h.onClose);
      h.ws.removeEventListener("message", h.onMessage);
    } catch {
      // ignore
    }
    this.#socketHandlers = undefined;
  }

  /** Graceful shutdown: disables reconnect and closes all subscriptions. */
  close(): void {
    this.#intentionalClose = true;
    this.#skipReconnect = true;
    this.#clearReconnectTimer();
    this.#closeAllSubscriptions("relay closed");
    this.#rejectPublishes(new RelayClosedError("relay closed", this.url));
    this.#rejectCounts(new RelayClosedError("relay closed", this.url));
    this.#detachSocketHandlers();
    this.#teardownSocket();
    this.#connected = false;
    this.onclose?.();
  }

  #teardownSocket(): void {
    try {
      this.#ws?.close();
    } catch {
      // ignore
    }
    this.#ws = undefined;
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }

  #closeAllSubscriptions(reason: string): void {
    for (const sub of this.#subs.values()) {
      if (!sub.closed) {
        sub.closed = true;
        sub.handlers.onclose?.(reason);
      }
    }
    this.#subs.clear();
  }

  #rejectPublishes(err: Error): void {
    for (const [, waiter] of this.#publishes) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.#publishes.clear();
  }

  #rejectCounts(err: Error): void {
    for (const [, waiter] of this.#counts) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.#counts.clear();
  }

  /**
   * Unexpected socket death. Keep subscriptions if reconnecting.
   */
  #handleSocketDeath(reason: string, opts?: { fromConnectAttempt?: boolean }): void {
    if (this.#deathHandled) return;
    this.#deathHandled = true;
    this.#detachSocketHandlers();
    this.#connected = false;
    this.#ws = undefined;
    this.#rejectPublishes(new RelayClosedError(reason, this.url));
    this.#rejectCounts(new RelayClosedError(reason, this.url));

    const canReconnect =
      this.#enableReconnect &&
      !this.#intentionalClose &&
      !this.#skipReconnect &&
      this.#subs.size > 0;

    if (canReconnect) {
      this.#scheduleReconnect();
      return;
    }

    // terminal close
    if (!opts?.fromConnectAttempt || this.#subs.size > 0) {
      this.#closeAllSubscriptions(reason);
      if (!this.#intentionalClose) this.onclose?.();
    }
  }

  #scheduleReconnect(): void {
    this.#clearReconnectTimer();
    const delay =
      this.#backoff[Math.min(this.#reconnectAttempts, this.#backoff.length - 1)] ?? 60_000;
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connect().catch(() => {
        // connect failure already schedules next attempt via #handleSocketDeath
        // if subs still open
        if (
          this.#enableReconnect &&
          !this.#intentionalClose &&
          this.#subs.size > 0 &&
          !this.#connected
        ) {
          this.#scheduleReconnect();
        }
      });
    }, delay);
  }

  #resubscribeAll(): void {
    for (const sub of this.#subs.values()) {
      if (sub.closed) continue;
      sub.eosed = false;
      try {
        this.#send(["REQ", sub.id, ...sub.filters]);
      } catch {
        // not connected yet — ignore
      }
    }
  }

  #send(message: ClientMessage | string): void {
    if (!this.#ws || !this.#connected) {
      throw new RelayClosedError("not connected", this.url);
    }
    const raw = typeof message === "string" ? message : encodeClientMessage(message);
    this.#ws.send(raw);
  }

  #onMessage(raw: string): void {
    let msg;
    try {
      msg = parseRelayMessage(raw);
    } catch {
      return;
    }

    switch (msg[0]) {
      case "EVENT": {
        const [, subId, event] = msg;
        const sub = this.#subs.get(subId);
        if (!sub || sub.closed) return;
        if (!this.#verify(event)) return;
        sub.handlers.onevent?.(event);
        break;
      }
      case "EOSE": {
        const [, subId] = msg;
        const sub = this.#subs.get(subId);
        if (!sub || sub.closed) return;
        sub.eosed = true;
        sub.handlers.oneose?.();
        break;
      }
      case "CLOSED": {
        const [, subId, reason] = msg;
        const sub = this.#subs.get(subId);
        if (!sub) return;
        this.#subs.delete(subId);
        sub.closed = true;
        sub.handlers.onclose?.(reason);
        break;
      }
      case "OK": {
        const [, eventId, ok, message] = msg;
        const waiter = this.#publishes.get(eventId);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.#publishes.delete(eventId);
        waiter.resolve({ ok, message });
        break;
      }
      case "COUNT": {
        const [, countId, payload] = msg;
        const waiter = this.#counts.get(countId);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.#counts.delete(countId);
        waiter.resolve(payload);
        break;
      }
      case "NOTICE": {
        this.onnotice?.(msg[1]);
        break;
      }
      case "AUTH": {
        this.#challenge = msg[1];
        this.#authPromise = undefined;
        this.onauth?.(msg[1]);
        break;
      }
      default:
        break;
    }
  }

  /** Low-level REQ with callbacks. Survives reconnect when enableReconnect is on. */
  subscribe(filters: Filter[], opts: SubscribeOptions = {}): Subscription {
    if (!this.#connected && !this.#enableReconnect) {
      throw new RelayClosedError("not connected", this.url);
    }

    const sub = new Subscription(filters, opts, (id) => {
      this.#subs.delete(id);
      try {
        if (this.#connected) this.#send(["CLOSE", id]);
      } catch {
        // ignore
      }
    });

    this.#subs.set(sub.id, sub);
    if (this.#connected) {
      this.#send(["REQ", sub.id, ...filters]);
    } else if (this.#enableReconnect) {
      // wait for reconnect; REQ sent in #resubscribeAll
      this.#scheduleReconnect();
    }

    if (opts.eoseTimeoutMs !== undefined) {
      const timer = setTimeout(() => {
        if (!sub.eosed && !sub.closed) sub.close("eose timeout");
      }, opts.eoseTimeoutMs);
      const prevClose = sub.handlers.onclose;
      sub.handlers.onclose = (reason) => {
        clearTimeout(timer);
        prevClose?.(reason);
      };
      const prevEose = sub.handlers.oneose;
      sub.handlers.oneose = () => {
        clearTimeout(timer);
        prevEose?.();
      };
    }

    return sub;
  }

  /** AsyncIterable of events for filters until the subscription is closed. */
  stream(
    filters: Filter[],
    opts?: { signal?: AbortSignal; id?: string },
  ): AsyncIterable<Event> & {
    close: (reason?: string) => void;
  } {
    return subscriptionToAsyncIterable(
      (handlers) => this.subscribe(filters, { ...handlers, id: opts?.id, signal: opts?.signal }),
      { signal: opts?.signal },
    );
  }

  /**
   * One-shot query: collect events until EOSE or timeout, then close.
   */
  async fetch(
    filters: Filter[],
    opts?: { timeoutMs?: number; signal?: AbortSignal; id?: string },
  ): Promise<Event[]> {
    if (!this.#connected) {
      await this.connect({ signal: opts?.signal });
    }
    const timeoutMs = opts?.timeoutMs ?? 4400;
    const events: Event[] = [];
    const seen = new Set<string>();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close(err ? err.message : "fetch complete");
        if (err) reject(err);
        else resolve();
      };

      const timer = setTimeout(() => done(), timeoutMs);

      const sub = this.subscribe(filters, {
        id: opts?.id,
        signal: opts?.signal,
        onevent(event) {
          if (seen.has(event.id)) return;
          seen.add(event.id);
          events.push(event);
        },
        oneose() {
          done();
        },
        onclose() {
          if (!settled) done();
        },
      });

      opts?.signal?.addEventListener(
        "abort",
        () => done(new RelayConnectionError("fetch aborted", this.url)),
        { once: true },
      );
    });

    return events;
  }

  /** Publish an event and wait for OK. */
  async publish(event: Event, opts?: { timeoutMs?: number }): Promise<PublishResult> {
    if (!this.#connected) throw new RelayClosedError("not connected", this.url);
    const timeoutMs = opts?.timeoutMs ?? this.#publishTimeoutMs;

    const result = await new Promise<PublishResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#publishes.delete(event.id);
        reject(new RelayPublishError("publish timed out", this.url));
      }, timeoutMs);
      this.#publishes.set(event.id, { resolve, reject, timer });
      try {
        this.#send(["EVENT", event]);
      } catch (err) {
        clearTimeout(timer);
        this.#publishes.delete(event.id);
        reject(err instanceof Error ? err : new RelayPublishError("publish failed", this.url));
      }
    });

    return result;
  }

  /**
   * NIP-45 COUNT: ask the relay how many events match `filters`.
   * Resolves with the COUNT payload (count / optional approximate / optional hll).
   */
  async count(
    filters: Filter[],
    opts?: { id?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CountResult> {
    if (!this.#connected) throw new RelayClosedError("not connected", this.url);
    if (filters.length === 0) throw new RelayError("COUNT requires at least one filter", this.url);
    if (opts?.signal?.aborted) {
      throw new RelayConnectionError("count aborted", this.url);
    }

    const id = opts?.id ?? this.nextSubId("count");
    const timeoutMs = opts?.timeoutMs ?? this.#publishTimeoutMs;

    return await new Promise<CountResult>((resolve, reject) => {
      const cleanup = () => {
        opts?.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error) => {
        clearTimeout(timer);
        this.#counts.delete(id);
        cleanup();
        reject(err);
      };
      const onAbort = () => fail(new RelayConnectionError("count aborted", this.url));

      const timer = setTimeout(() => {
        fail(new RelayPublishError("count timed out", this.url));
      }, timeoutMs);

      this.#counts.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          this.#counts.delete(id);
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.#counts.delete(id);
          cleanup();
          reject(err);
        },
        timer,
      });

      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.#send(["COUNT", id, ...filters]);
      } catch (err) {
        fail(err instanceof Error ? err : new RelayPublishError("count failed", this.url));
      }
    });
  }

  /**
   * NIP-42 AUTH: sign the current challenge and wait for OK.
   */
  async auth(
    sign: (template: EventTemplate) => Promise<Event>,
    opts?: { timeoutMs?: number },
  ): Promise<PublishResult> {
    if (!this.#challenge) {
      throw new RelayError("no AUTH challenge received from relay", this.url);
    }
    if (this.#authPromise) return this.#authPromise;

    this.#authPromise = (async () => {
      const template = makeAuthEvent(this.url, this.#challenge!);
      const event = await sign(template);
      if (!this.#connected) throw new RelayClosedError("not connected", this.url);
      const timeoutMs = opts?.timeoutMs ?? this.#publishTimeoutMs;

      return await new Promise<PublishResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#publishes.delete(event.id);
          reject(new RelayPublishError("auth timed out", this.url));
        }, timeoutMs);
        this.#publishes.set(event.id, { resolve, reject, timer });
        try {
          this.#send(["AUTH", event]);
        } catch (err) {
          clearTimeout(timer);
          this.#publishes.delete(event.id);
          reject(err instanceof Error ? err : new RelayPublishError("auth send failed", this.url));
        }
      });
    })();

    try {
      return await this.#authPromise;
    } finally {
      this.#authPromise = undefined;
    }
  }

  /** Generate a unique subscription id for this relay instance. */
  nextSubId(prefix = "sub"): string {
    this.#serial += 1;
    return `${prefix}:${this.#serial}`;
  }
}

export type { SubscriptionHandlers, SubscribeOptions };
