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
import {
  MAX_NEG_ROUNDS,
  Nip77Error,
  Reconciliation,
  type NegentropyStorageVector,
} from "../nips/nip77.ts";
import { isAuthRequired, makeAuthEvent } from "../nips/nip42.ts";
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

export const RelayStatus = {
  Initialized: "initialized",
  Connecting: "connecting",
  Connected: "connected",
  Disconnected: "disconnected",
  Closed: "closed",
} as const;
export type RelayStatusName = (typeof RelayStatus)[keyof typeof RelayStatus];

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
  enablePing?: boolean;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** When set, CLOSED/OK `auth-required:` triggers AUTH then retries the REQ/EVENT/COUNT. */
  authSigner?: (template: EventTemplate) => Promise<Event>;
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
  event?: Event;
  authRetried?: boolean;
};

type CountWaiter = {
  resolve: (result: CountResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  filters: Filter[];
  authRetried: boolean;
  timeoutMs: number;
};

type NegSession = {
  queue: string[];
  waiter:
    | {
        resolve: (hex: string) => void;
        reject: (err: Error) => void;
      }
    | undefined;
  error: Error | undefined;
};

type PingWaiter = {
  resolve: (alive: boolean) => void;
};

type SocketHandlers = {
  onOpen: () => void;
  onError: () => void;
  onClose: () => void;
  onMessage: (ev: unknown) => void;
  ws: WebSocketLike;
};

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];
const DEFAULT_PING_INTERVAL_MS = 29_000;
const DEFAULT_PING_TIMEOUT_MS = 20_000;
const PING_DUMMY_ID = "a".repeat(64);
const PING_DUMMY_FILTER: Filter = { ids: [PING_DUMMY_ID], limit: 0 };

/** node `ws` delivers `pong` on the EventEmitter, not via addEventListener. */
function canNativePing(ws: WebSocketLike): boolean {
  return (
    typeof ws.ping === "function" && (typeof ws.once === "function" || typeof ws.on === "function")
  );
}

/**
 * Single-relay NIP-01 client.
 * Connection lifecycle, REQ/CLOSE, EVENT publish ACK, AUTH, COUNT, NIP-77, optional reconnect.
 */
export class Relay {
  readonly url: string;
  #ws: WebSocketLike | undefined;
  #connected = false;
  #gen = 0;
  #status: RelayStatusName = RelayStatus.Initialized;
  #connecting: Promise<void> | undefined;
  #connectFinish: ((err?: unknown) => void) | undefined;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #socketHandlers: SocketHandlers | undefined;
  #subs = new Map<SubscriptionId, Subscription>();
  #publishes = new Map<string, PublishWaiter>();
  #counts = new Map<string, CountWaiter>();
  #neg = new Map<SubscriptionId, NegSession>();
  #WS: WebSocketConstructor;
  #verify: (event: Event) => boolean;
  #verifyDead = false;
  #publishTimeoutMs: number;
  #connectTimeoutMs: number;
  #enableReconnect: boolean;
  #backoff: number[];
  #serial = 0;
  #challenge: string | undefined;
  #authedChallenge: string | undefined;
  #authPromise: Promise<PublishResult> | undefined;
  #authSigner: ((template: EventTemplate) => Promise<Event>) | undefined;
  #intentionalClose = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #skipReconnect = false;
  /** Collapses error+close pairs into a single terminal/reconnect action. */
  #deathHandled = false;
  #enablePing: boolean;
  #pingIntervalMs: number;
  #pingTimeoutMs: number;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pingWaiters = new Map<SubscriptionId, PingWaiter>();
  #pingGen = 0;
  #nativePing: { abort: () => void } | undefined;

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
    this.#enablePing = opts.enablePing ?? false;
    this.#pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.#pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.#authSigner = opts.authSigner;
  }

  /** Latest NIP-42 challenge, if any. */
  get challenge(): string | undefined {
    return this.#challenge;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get status(): RelayStatusName {
    return this.#status;
  }

  get generation(): number {
    return this.#gen;
  }

  get reconnectEnabled(): boolean {
    return this.#enableReconnect;
  }

  /** User subscriptions only; dummy ping REQs are not counted. */
  get subscriptionCount(): number {
    return this.#subs.size;
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
    if (this.#connecting) return await this.#connecting;

    const gen = ++this.#gen;
    this.#intentionalClose = false;
    this.#skipReconnect = false;
    this.#deathHandled = false;
    this.#clearReconnectTimer();
    this.#status = RelayStatus.Connecting;

    const timeoutMs = opts?.timeoutMs ?? this.#connectTimeoutMs;
    const isReconnect = this.#reconnectAttempts > 0;

    let resolveConnect = (): void => {};
    let rejectConnect = (_err: Error): void => {};
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocketLike | undefined;
    let handlers: SocketHandlers | undefined;

    const connecting = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });

    const release = (): void => {
      if (!ws) return;
      if (handlers) {
        try {
          ws.removeEventListener("open", handlers.onOpen);
          ws.removeEventListener("error", handlers.onError);
          ws.removeEventListener("close", handlers.onClose);
          ws.removeEventListener("message", handlers.onMessage);
        } catch {
          // ignore
        }
        if (this.#socketHandlers === handlers) this.#socketHandlers = undefined;
      }
      try {
        if (ws.readyState !== this.#WS.CLOSED && ws.readyState !== this.#WS.CLOSING) {
          ws.close();
        }
      } catch {
        // ignore
      }
      if (this.#ws === ws) this.#ws = undefined;
    };

    const onAbort = (): void => {
      if (gen !== this.#gen) {
        release();
        return;
      }
      this.#intentionalClose = true;
      this.#skipReconnect = true;
      release();
      finish(new RelayConnectionError("connection aborted", this.url));
      if (gen === this.#gen) {
        this.#handleSocketDeath("connection aborted", { fromConnectAttempt: true, gen });
      }
    };

    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (this.#connectTimer === timer) this.#connectTimer = undefined;
      opts?.signal?.removeEventListener("abort", onAbort);
      if (this.#connectFinish === finish) this.#connectFinish = undefined;
      if (this.#connecting === connecting) this.#connecting = undefined;
      if (err) {
        rejectConnect(
          err instanceof Error ? err : new RelayConnectionError("connection failed", this.url),
        );
      } else {
        resolveConnect();
      }
    };

    this.#connecting = connecting;
    this.#connectFinish = finish;

    timer = setTimeout(() => {
      if (gen !== this.#gen) {
        release();
        return;
      }
      if (!isReconnect && !this.#enableReconnect) this.#skipReconnect = true;
      release();
      finish(new RelayConnectionError("connection timed out", this.url));
      if (gen === this.#gen) {
        this.#handleSocketDeath("connection timed out", { fromConnectAttempt: true, gen });
      }
    }, timeoutMs);
    this.#connectTimer = timer;

    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      ws = new this.#WS(this.url);
    } catch (err) {
      if (!isReconnect && !this.#enableReconnect) this.#skipReconnect = true;
      finish(err);
      if (gen === this.#gen) {
        this.#handleSocketDeath("connection failed", { fromConnectAttempt: true, gen });
      }
      await connecting;
      return;
    }
    this.#ws = ws;

    const onOpen = (): void => {
      if (gen !== this.#gen) {
        release();
        return;
      }
      this.#connected = true;
      this.#status = RelayStatus.Connected;
      this.#deathHandled = false;
      const wasReconnect = this.#reconnectAttempts > 0;
      this.#reconnectAttempts = 0;
      this.#challenge = undefined;
      this.#authPromise = undefined;
      this.#resubscribeAll();
      this.#startPingLoop();
      if (wasReconnect) this.onreconnect?.();
      finish();
    };
    const onError = (): void => {
      if (gen !== this.#gen) {
        release();
        return;
      }
      this.#connected = false;
      const fromConnectAttempt = !settled;
      if (!settled && !isReconnect && !this.#enableReconnect) this.#skipReconnect = true;
      release();
      finish(new RelayConnectionError("connection failed", this.url));
      if (gen === this.#gen) {
        this.#handleSocketDeath("connection failed", { fromConnectAttempt, gen });
      }
    };
    const onClose = (): void => {
      if (gen !== this.#gen) {
        release();
        return;
      }
      this.#connected = false;
      const fromConnectAttempt = !settled;
      if (!settled && !isReconnect && !this.#enableReconnect) this.#skipReconnect = true;
      release();
      if (fromConnectAttempt) {
        finish(new RelayConnectionError("websocket closed", this.url));
      }
      if (gen === this.#gen) {
        this.#handleSocketDeath("websocket closed", { fromConnectAttempt, gen });
      }
    };
    const onMessage = (ev: unknown): void => {
      if (gen !== this.#gen) return;
      const data =
        typeof ev === "object" && ev !== null && "data" in ev ? (ev as { data: unknown }).data : ev;
      this.#onMessage(String(data));
    };

    handlers = { onOpen, onError, onClose, onMessage, ws };
    this.#socketHandlers = handlers;
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    ws.addEventListener("message", onMessage);

    await connecting;
  }

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
    this.#gen += 1;
    this.#status = RelayStatus.Closed;
    this.#intentionalClose = true;
    this.#skipReconnect = true;
    this.#clearReconnectTimer();
    if (this.#connectTimer !== undefined) {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = undefined;
    }
    this.#stopPingLoop();
    this.#connectFinish?.(new RelayClosedError("relay closed", this.url));
    this.#closeAllSubscriptions("relay closed");
    this.#rejectPublishes(new RelayClosedError("relay closed", this.url));
    this.#rejectCounts(new RelayClosedError("relay closed", this.url));
    this.#rejectNeg(new RelayClosedError("relay closed", this.url));
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

  #rejectNeg(err: Error): void {
    for (const session of this.#neg.values()) {
      session.error = err;
      session.waiter?.reject(err);
      session.waiter = undefined;
    }
    this.#neg.clear();
  }

  /**
   * Unexpected socket death. Keep subscriptions if reconnecting.
   */
  #handleSocketDeath(reason: string, opts: { fromConnectAttempt?: boolean; gen: number }): void {
    if (opts.gen !== this.#gen) return;
    if (this.#deathHandled) return;
    this.#deathHandled = true;
    this.#stopPingLoop();
    this.#detachSocketHandlers();
    this.#connected = false;
    this.#ws = undefined;
    this.#rejectPublishes(new RelayClosedError(reason, this.url));
    this.#rejectCounts(new RelayClosedError(reason, this.url));
    this.#rejectNeg(new RelayClosedError(reason, this.url));

    const canReconnect =
      this.#enableReconnect &&
      !this.#intentionalClose &&
      !this.#skipReconnect &&
      this.#subs.size > 0;

    if (canReconnect) {
      this.#status = RelayStatus.Disconnected;
      this.#scheduleReconnect();
      return;
    }

    if (!this.#intentionalClose) this.#status = RelayStatus.Disconnected;

    if (!opts.fromConnectAttempt || this.#subs.size > 0) {
      this.#closeAllSubscriptions(reason);
      if (!this.#intentionalClose) this.onclose?.();
    }

    this.#status = RelayStatus.Closed;
  }

  #scheduleReconnect(): void {
    this.#clearReconnectTimer();
    const delay =
      this.#backoff[Math.min(this.#reconnectAttempts, this.#backoff.length - 1)] ?? 60_000;
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#intentionalClose || this.#connected) return;
      void this.connect().catch(() => {
        if (
          this.#enableReconnect &&
          !this.#intentionalClose &&
          !this.#skipReconnect &&
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
      sub.authRetried = false;
      try {
        this.#send(["REQ", sub.id, ...sub.replayFilters()]);
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
        if (this.#pingWaiters.has(subId)) return;
        const sub = this.#subs.get(subId);
        if (!sub || sub.closed) return;
        sub.handlers.receivedEvent?.(event.id);
        if (sub.idsAtWatermark.has(event.id)) return;
        if (sub.handlers.alreadyHaveEvent?.(event.id)) return;
        if (this.#verifyDead) return;
        try {
          if (!this.#verify(event)) return;
        } catch (e) {
          const name = e instanceof Error ? e.name : "";
          if (name === "WasmVerifyPoisonedError" || e instanceof WebAssembly.RuntimeError) {
            this.#verifyDead = true;
            this.onnotice?.("verify-poisoned: wasm instance aborted");
            return;
          }
          throw e;
        }
        sub.noteVerified(event);
        sub.handlers.onevent?.(event);
        break;
      }
      case "EOSE": {
        const [, subId] = msg;
        if (this.#finishDummyPing(subId)) return;
        const sub = this.#subs.get(subId);
        if (!sub || sub.closed) return;
        if (sub.eosed) return;
        sub.eosed = true;
        sub.handlers.oneose?.();
        break;
      }
      case "CLOSED": {
        const [, subId, reason] = msg;
        if (this.#finishDummyPing(subId)) return;
        const countWaiter = this.#counts.get(subId);
        if (countWaiter) {
          if (isAuthRequired(reason) && this.#authSigner && !countWaiter.authRetried) {
            countWaiter.authRetried = true;
            void this.#authThenRecount(subId, countWaiter, reason);
            return;
          }
          countWaiter.reject(new RelayClosedError(reason || "COUNT closed", this.url));
          return;
        }
        const sub = this.#subs.get(subId);
        if (!sub) return;
        if (isAuthRequired(reason) && this.#authSigner && !sub.authRetried) {
          sub.authRetried = true;
          void this.#authThenResubscribe(sub, reason);
          return;
        }
        this.#dropSubscription(sub, reason);
        break;
      }
      case "OK": {
        const [, eventId, ok, message] = msg;
        const waiter = this.#publishes.get(eventId);
        if (!waiter) return;
        if (
          !ok &&
          isAuthRequired(message) &&
          waiter.event &&
          !waiter.authRetried &&
          this.#authSigner
        ) {
          waiter.authRetried = true;
          void this.#authThenRepublish(waiter, eventId, message);
          return;
        }
        clearTimeout(waiter.timer);
        this.#publishes.delete(eventId);
        waiter.resolve({ ok, message });
        break;
      }
      case "COUNT": {
        const [, countId, payload] = msg;
        const waiter = this.#counts.get(countId);
        if (!waiter) return;
        waiter.resolve(payload);
        break;
      }
      case "NEG-MSG": {
        const [, negId, hex] = msg;
        const session = this.#neg.get(negId);
        if (!session) return;
        if (session.waiter) {
          const waiter = session.waiter;
          session.waiter = undefined;
          waiter.resolve(hex);
        } else {
          session.queue.push(hex);
        }
        break;
      }
      case "NEG-ERR": {
        const [, negId, reason] = msg;
        const session = this.#neg.get(negId);
        if (!session) return;
        const err = new Nip77Error(reason);
        session.error = err;
        if (session.waiter) {
          const waiter = session.waiter;
          session.waiter = undefined;
          waiter.reject(err);
        }
        break;
      }
      case "NOTICE": {
        this.onnotice?.(msg[1]);
        break;
      }
      case "AUTH": {
        this.#challenge = msg[1];
        this.#authPromise = undefined;
        this.#authedChallenge = undefined;
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
        if (sub.eosed || sub.closed) return;
        sub.eosed = true;
        sub.handlers.oneose?.();
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
      this.#publishes.set(event.id, { resolve, reject, timer, event });
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
      const waiter: CountWaiter = {
        resolve: (result) => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          waiter.timer = undefined;
          this.#counts.delete(id);
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          waiter.timer = undefined;
          this.#counts.delete(id);
          cleanup();
          reject(err);
        },
        timer: undefined,
        filters: [...filters],
        authRetried: false,
        timeoutMs,
      };
      const onAbort = () => waiter.reject(new RelayConnectionError("count aborted", this.url));
      waiter.timer = setTimeout(() => {
        waiter.reject(new RelayPublishError("count timed out", this.url));
      }, timeoutMs);
      this.#counts.set(id, waiter);

      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.#send(["COUNT", id, ...filters]);
      } catch (err) {
        waiter.reject(err instanceof Error ? err : new RelayPublishError("count failed", this.url));
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
      const result = await this.#authPromise;
      if (result.ok) this.#authedChallenge = this.#challenge;
      return result;
    } finally {
      this.#authPromise = undefined;
    }
  }

  #dropSubscription(sub: Subscription, reason: string): void {
    this.#subs.delete(sub.id);
    sub.closed = true;
    sub.handlers.onclose?.(reason);
  }

  async #authThenResubscribe(sub: Subscription, reason: string): Promise<void> {
    try {
      const signer = this.#authSigner;
      if (!signer || !this.#challenge) {
        this.#dropSubscription(sub, reason);
        return;
      }
      if (this.#authedChallenge !== this.#challenge) {
        const result = await this.auth(signer);
        if (!result.ok) {
          this.#dropSubscription(sub, reason);
          return;
        }
      }
      if (sub.closed || !this.#connected) {
        this.#dropSubscription(sub, reason);
        return;
      }
      sub.eosed = false;
      this.#send(["REQ", sub.id, ...sub.replayFilters()]);
    } catch {
      this.#dropSubscription(sub, reason);
    }
  }

  async #authThenRecount(id: string, waiter: CountWaiter, reason: string): Promise<void> {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    const fail = () => {
      waiter.reject(new RelayClosedError(reason || "COUNT closed", this.url));
    };
    try {
      const signer = this.#authSigner;
      if (!signer || !this.#challenge) {
        fail();
        return;
      }
      if (this.#authedChallenge !== this.#challenge) {
        const result = await this.auth(signer);
        if (!this.#counts.has(id)) return;
        if (!result.ok) {
          fail();
          return;
        }
      }
      if (!this.#counts.has(id)) return;
      if (!this.#connected) {
        fail();
        return;
      }
      waiter.timer = setTimeout(() => {
        waiter.reject(new RelayPublishError("count timed out", this.url));
      }, waiter.timeoutMs);
      this.#send(["COUNT", id, ...waiter.filters]);
    } catch (err) {
      if (!this.#counts.has(id)) return;
      waiter.reject(
        err instanceof Error ? err : new RelayClosedError(reason || "COUNT closed", this.url),
      );
    }
  }

  async #authThenRepublish(waiter: PublishWaiter, eventId: string, message: string): Promise<void> {
    const finish = (result: PublishResult) => {
      clearTimeout(waiter.timer);
      this.#publishes.delete(eventId);
      waiter.resolve(result);
    };
    try {
      const signer = this.#authSigner;
      const event = waiter.event;
      if (!signer || !event || !this.#challenge) {
        finish({ ok: false, message });
        return;
      }
      if (this.#authedChallenge !== this.#challenge) {
        const result = await this.auth(signer);
        if (!result.ok) {
          finish({ ok: false, message });
          return;
        }
      }
      if (!this.#connected) {
        finish({ ok: false, message });
        return;
      }
      this.#send(["EVENT", event]);
    } catch {
      finish({ ok: false, message });
    }
  }

  /**
   * NIP-77: run Negentropy reconciliation against this relay.
   * Returns the local-only (`have`) and remote-only (`need`) event ids.
   * Does not upload or download events.
   *
   * `timeoutMs` is a single wall-clock deadline for the whole session
   * (`NEG-OPEN` through the last `NEG-MSG`), not a per-message budget.
   * Default: {@link RelayOptions.publishTimeoutMs}.
   */
  async negReconcile(
    filter: Filter,
    storage: NegentropyStorageVector,
    opts?: { id?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ have: string[]; need: string[] }> {
    if (!this.#connected) throw new RelayClosedError("not connected", this.url);
    if (opts?.signal?.aborted) {
      throw new RelayConnectionError("negentropy aborted", this.url);
    }

    const id = opts?.id ?? this.nextSubId("neg");
    const timeoutMs = opts?.timeoutMs ?? this.#publishTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const session: NegSession = { queue: [], waiter: undefined, error: undefined };
    this.#neg.set(id, session);

    const timedOut = (): RelayPublishError =>
      new RelayPublishError("negentropy timed out", this.url);

    const remainingMs = (): number => deadline - Date.now();

    const next = (): Promise<string> => {
      if (session.error) return Promise.reject(session.error);
      if (remainingMs() <= 0) return Promise.reject(timedOut());
      const queued = session.queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          session.waiter = undefined;
          reject(timedOut());
        }, remainingMs());
        const fail = (err: Error): void => {
          clearTimeout(timer);
          session.waiter = undefined;
          reject(err);
        };
        const onAbort = (): void => fail(new RelayConnectionError("negentropy aborted", this.url));
        session.waiter = {
          resolve: (hex) => {
            clearTimeout(timer);
            opts?.signal?.removeEventListener("abort", onAbort);
            resolve(hex);
          },
          reject: (err) => fail(err),
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    };

    const recon = new Reconciliation(storage);
    const have = new Set<string>();
    const need = new Set<string>();

    try {
      this.#send(["NEG-OPEN", id, filter, recon.opening]);
      for (let round = 0; round < MAX_NEG_ROUNDS; round++) {
        const incoming = await next();
        const out = recon.reconcile(incoming);
        for (const hid of out.have) have.add(hid);
        for (const nid of out.need) need.add(nid);
        if (out.nextMessage === null) {
          return { have: [...have], need: [...need] };
        }
        this.#send(["NEG-MSG", id, out.nextMessage]);
      }
      throw new Nip77Error("negentropy exceeded max rounds");
    } finally {
      this.#neg.delete(id);
      try {
        this.#send(["NEG-CLOSE", id]);
      } catch {
        // connection already gone
      }
    }
  }

  /** Generate a unique subscription id for this relay instance. */
  nextSubId(prefix = "sub"): string {
    this.#serial += 1;
    return `${prefix}:${this.#serial}`;
  }

  #startPingLoop(): void {
    this.#stopPingLoop();
    if (!this.#enablePing) return;
    this.#pingTimer = setInterval(() => {
      void this.#pingpong();
    }, this.#pingIntervalMs);
  }

  #stopPingLoop(): void {
    if (this.#pingTimer !== undefined) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
    }
    this.#abortCurrentPing();
  }

  #abortCurrentPing(): void {
    this.#pingGen += 1;
    const native = this.#nativePing;
    this.#nativePing = undefined;
    native?.abort();
    for (const waiter of this.#pingWaiters.values()) waiter.resolve(false);
    this.#pingWaiters.clear();
  }

  #finishDummyPing(id: string): boolean {
    const waiter = this.#pingWaiters.get(id);
    if (!waiter) return false;
    this.#pingWaiters.delete(id);
    waiter.resolve(true);
    try {
      if (this.#connected) this.#send(["CLOSE", id]);
    } catch {
      // socket already gone
    }
    return true;
  }

  async #pingpong(): Promise<void> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== this.#WS.OPEN) return;
    if (this.#nativePing || this.#pingWaiters.size > 0) return;

    const gen = this.#pingGen;
    const ping = canNativePing(ws) ? this.#waitForNativePing(ws) : this.#waitForDummyPing();
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (alive: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(alive);
      };
      const timer = setTimeout(() => {
        if (this.#nativePing || this.#pingWaiters.size > 0) done(false);
      }, this.#pingTimeoutMs);
      void ping.then(done);
    });

    if (gen !== this.#pingGen) return;

    if (!ok) {
      this.#abortCurrentPing();
      if (ws.readyState === this.#WS.OPEN) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }
  }

  #waitForNativePing(ws: WebSocketLike): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (alive: boolean) => {
        if (settled) return;
        settled = true;
        this.#nativePing = undefined;
        ws.off?.("pong", onPong);
        resolve(alive);
      };
      const onPong = () => finish(true);
      this.#nativePing = { abort: () => finish(false) };

      // node `ws` once() wraps the listener; off(fn) would miss it.
      if (typeof ws.on === "function" && typeof ws.off === "function") {
        ws.on("pong", onPong);
      } else if (typeof ws.once === "function") {
        ws.once("pong", onPong);
      } else {
        ws.on!("pong", onPong);
      }
      try {
        ws.ping!();
      } catch {
        finish(false);
      }
    });
  }

  #waitForDummyPing(): Promise<boolean> {
    return new Promise((resolve) => {
      const id = this.nextSubId("__ping__");
      this.#pingWaiters.set(id, { resolve });
      try {
        this.#send(["REQ", id, PING_DUMMY_FILTER]);
      } catch {
        this.#pingWaiters.delete(id);
        resolve(false);
      }
    });
  }
}

export type { SubscriptionHandlers, SubscribeOptions };
