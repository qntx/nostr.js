import type { Event, EventTemplate } from "../core/event.ts";
import { verifyEvent } from "../core/key.ts";
import { canonicalizeFilter, canonicalizeFilters, type Filter } from "../core/filter.ts";
import { WasmVerifyPoisonedError } from "../core/error.ts";
import {
  assertSubscriptionId,
  createSubscriptionId,
  encodeClientMessage,
  parseRelayMessage,
  type ClientMessage,
  type CountResult,
  type SubscriptionId,
} from "../core/message.ts";
import { type NegentropyStorageVector } from "../nips/nip77.ts";
import { isAuthRequired, makeAuthEvent } from "../nips/nip42.ts";
import { normalizeURL } from "../core/util.ts";
import { RelayClosedError, RelayConnectionError, RelayError, RelayPublishError } from "./error.ts";
import {
  armEoseTimeout,
  closeAllSubscriptions,
  dropSubscription,
  fetchFilters,
  onSubEose,
  onSubEvent,
  openExclusive,
  resubscribeAll,
  streamFilters,
  subscribeLive,
  type LiveCtx,
  type LiveGroup,
} from "./live.ts";
import {
  createNegSession,
  failNegErr,
  failNegSession,
  pushNegMsg,
  runWiredNegSession,
  type NegSession,
} from "./neg-session.ts";
import { DEFAULT_PING_INTERVAL_MS, DEFAULT_PING_TIMEOUT_MS, PingLoop } from "./ping.ts";
import type { SubscribeOptions, Subscription, SubscriptionHandlers } from "./subscription.ts";
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
  timer: ReturnType<typeof setTimeout> | undefined;
  event?: Event;
  authRetried?: boolean;
  timeoutMs: number;
};

type CountWaiter = {
  resolve: (result: CountResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  filters: Filter[];
  authRetried: boolean;
  timeoutMs: number;
};

type SocketHandlers = {
  onOpen: () => void;
  onError: () => void;
  onClose: () => void;
  onMessage: (ev: unknown) => void;
  ws: WebSocketLike;
};

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

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
  #liveByFp = new Map<string, LiveGroup>();
  #liveBySubId = new Map<SubscriptionId, LiveGroup>();
  #live: LiveCtx;
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
  #ping: PingLoop;

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
    this.#authSigner = opts.authSigner;
    this.#ping = new PingLoop({
      send: (message) => this.#send(message),
      nextSubId: (prefix) => this.nextSubId(prefix),
      getWs: () => this.#ws,
      closeWs: () => {
        const ws = this.#ws;
        if (ws && ws.readyState === this.#WS.OPEN) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      },
      pingIntervalMs: opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      pingTimeoutMs: opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
    });
    this.#live = {
      liveByFp: this.#liveByFp,
      liveBySubId: this.#liveBySubId,
      subs: this.#subs,
      connected: () => this.#connected,
      enableReconnect: () => this.#enableReconnect,
      send: (message) => this.#send(message),
      scheduleReconnect: () => this.#scheduleReconnect(),
      acceptEvent: (event) => this.#acceptEvent(event),
      armEoseTimeout,
    };
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
      this.#challenge = undefined;
      this.#authPromise = undefined;
      if (!resubscribeAll(this.#live)) {
        this.#connected = false;
        this.#status = RelayStatus.Disconnected;
        if (!isReconnect && !this.#enableReconnect) this.#skipReconnect = true;
        release();
        finish(new RelayConnectionError("connection failed", this.url));
        if (
          this.#enableReconnect &&
          !this.#intentionalClose &&
          !this.#skipReconnect &&
          this.#subs.size > 0
        ) {
          this.#scheduleReconnect();
        }
        return;
      }
      this.#reconnectAttempts = 0;
      if (this.#enablePing) this.#ping.start();
      else this.#ping.stop();
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
    this.#ping.stop();
    this.#connectFinish?.(new RelayClosedError("relay closed", this.url));
    try {
      closeAllSubscriptions(this.#live, "relay closed");
    } finally {
      this.#rejectPublishes(new RelayClosedError("relay closed", this.url));
      this.#rejectCounts(new RelayClosedError("relay closed", this.url));
      this.#rejectNeg(new RelayClosedError("relay closed", this.url));
      this.#detachSocketHandlers();
      this.#teardownSocket();
      this.#connected = false;
      this.onclose?.();
    }
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
    for (const session of this.#neg.values()) failNegSession(session, err);
    this.#neg.clear();
  }

  /**
   * Unexpected socket death. Keep subscriptions if reconnecting.
   */
  #handleSocketDeath(reason: string, opts: { fromConnectAttempt?: boolean; gen: number }): void {
    if (opts.gen !== this.#gen) return;
    if (this.#deathHandled) return;
    this.#deathHandled = true;
    this.#ping.stop();
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
      closeAllSubscriptions(this.#live, reason);
      if (!this.#intentionalClose) this.onclose?.();
    }

    this.#status = RelayStatus.Closed;
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined) return;
    if (this.#connected) return;
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
        if (this.#ping.hasWaiter(subId)) return;
        onSubEvent(this.#live, subId, event);
        break;
      }
      case "EOSE": {
        const [, subId] = msg;
        if (this.#ping.finishDummyPing(subId)) return;
        onSubEose(this.#live, subId);
        break;
      }
      case "CLOSED": {
        const [, subId, reason] = msg;
        if (this.#ping.finishDummyPing(subId)) return;
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
        dropSubscription(this.#live, sub, reason);
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
        pushNegMsg(session, hex);
        break;
      }
      case "NEG-ERR": {
        const [, negId, reason] = msg;
        const session = this.#neg.get(negId);
        if (!session) return;
        failNegErr(session, reason);
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
    const canonical = canonicalizeFilters(filters);
    if (opts.closeOnEose === true) return openExclusive(this.#live, canonical, opts);
    return subscribeLive(this.#live, canonical, opts);
  }

  #acceptEvent(event: Event): boolean {
    if (this.#verifyDead) return false;
    try {
      return this.#verify(event);
    } catch (e) {
      if (e instanceof WasmVerifyPoisonedError || e instanceof WebAssembly.RuntimeError) {
        this.#verifyDead = true;
        this.onnotice?.("verify-poisoned: wasm instance aborted");
        return false;
      }
      throw e;
    }
  }

  /** AsyncIterable of events for filters until the subscription is closed. */
  stream(
    filters: Filter[],
    opts?: { signal?: AbortSignal; id?: string },
  ): AsyncIterable<Event> & {
    close: (reason?: string) => void;
  } {
    return streamFilters((f, o) => this.subscribe(f, o), filters, opts);
  }

  /**
   * One-shot query: collect events until EOSE or timeout, then close.
   */
  async fetch(
    filters: Filter[],
    opts?: { timeoutMs?: number; signal?: AbortSignal; id?: string },
  ): Promise<Event[]> {
    filters = canonicalizeFilters(filters);
    if (!this.#connected) {
      await this.connect({ signal: opts?.signal });
    }
    return fetchFilters((f, o) => this.subscribe(f, o), filters, {
      timeoutMs: opts?.timeoutMs ?? 4400,
      signal: opts?.signal,
      id: opts?.id,
      url: this.url,
    });
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
      this.#publishes.set(event.id, { resolve, reject, timer, event, timeoutMs });
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
    filters = canonicalizeFilters(filters);

    const id = opts?.id !== undefined ? createSubscriptionId(opts.id) : this.nextSubId("count");
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
        this.#publishes.set(event.id, { resolve, reject, timer, timeoutMs });
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

  async #ensureAuthed(): Promise<boolean> {
    const signer = this.#authSigner;
    if (!signer || !this.#challenge) return false;
    if (this.#authedChallenge === this.#challenge) return true;
    const result = await this.auth(signer);
    return result.ok;
  }

  async #authThenResubscribe(sub: Subscription, reason: string): Promise<void> {
    try {
      if (!(await this.#ensureAuthed())) {
        dropSubscription(this.#live, sub, reason);
        return;
      }
      if (sub.closed || !this.#connected) {
        dropSubscription(this.#live, sub, reason);
        return;
      }
      sub.eosed = false;
      const group = this.#liveBySubId.get(sub.id);
      if (group) {
        for (const att of group.attachments) att.eosed = false;
      }
      this.#send(["REQ", sub.id, ...sub.replayFilters()]);
    } catch {
      dropSubscription(this.#live, sub, reason);
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
      const ok = await this.#ensureAuthed();
      if (this.#counts.get(id) !== waiter) return;
      if (!ok) {
        fail();
        return;
      }
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
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    const finish = (result: PublishResult) => {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      this.#publishes.delete(eventId);
      waiter.resolve(result);
    };
    try {
      if (!waiter.event) {
        finish({ ok: false, message });
        return;
      }
      const ok = await this.#ensureAuthed();
      if (this.#publishes.get(eventId) !== waiter) return;
      if (!ok) {
        finish({ ok: false, message });
        return;
      }
      if (!this.#connected) {
        finish({ ok: false, message });
        return;
      }
      waiter.timer = setTimeout(() => {
        this.#publishes.delete(eventId);
        waiter.reject(new RelayPublishError("publish timed out", this.url));
      }, waiter.timeoutMs);
      this.#send(["EVENT", waiter.event]);
    } catch {
      if (!this.#publishes.has(eventId)) return;
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
    filter = canonicalizeFilter(filter);

    const id = opts?.id !== undefined ? assertSubscriptionId(opts.id) : this.nextSubId("neg");
    const timeoutMs = opts?.timeoutMs ?? this.#publishTimeoutMs;
    const session = createNegSession();
    this.#neg.set(id, session);

    try {
      return await runWiredNegSession({
        session,
        storage,
        filter,
        id,
        timeoutMs,
        signal: opts?.signal,
        send: (message) => this.#send(message),
        url: this.url,
      });
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
}

export type { SubscriptionHandlers, SubscribeOptions };
