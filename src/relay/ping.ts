import type { Filter } from "../core/filter.ts";
import type { ClientMessage, SubscriptionId } from "../core/message.ts";
import type { WebSocketLike } from "./websocket.ts";

export const DEFAULT_PING_INTERVAL_MS = 29_000;
export const DEFAULT_PING_TIMEOUT_MS = 20_000;

const PING_DUMMY_ID = "a".repeat(64);
const PING_DUMMY_FILTER: Filter = { ids: [PING_DUMMY_ID], limit: 0 };
/** Browser WebSocket and `ws` both use 1 for OPEN. */
const WS_OPEN = 1;

type PingWaiter = {
  resolve: (alive: boolean) => void;
};

export type PingLoopOpts = {
  send: (message: ClientMessage) => void;
  nextSubId: (prefix: string) => string;
  getWs: () => WebSocketLike | undefined;
  closeWs: () => void;
  pingIntervalMs: number;
  pingTimeoutMs: number;
};

/** node `ws` delivers `pong` on the EventEmitter, not via addEventListener. */
export function canNativePing(ws: WebSocketLike): boolean {
  return (
    typeof ws.ping === "function" && (typeof ws.once === "function" || typeof ws.on === "function")
  );
}

/** REQ-dummy or native ping/pong keepalive. Does not import class Relay. */
export class PingLoop {
  #opts: PingLoopOpts;
  #timer: ReturnType<typeof setInterval> | undefined;
  #waiters = new Map<SubscriptionId, PingWaiter>();
  #gen = 0;
  #nativePing: { abort: () => void } | undefined;

  constructor(opts: PingLoopOpts) {
    this.#opts = opts;
  }

  start(): void {
    this.stop();
    this.#timer = setInterval(() => {
      void this.#pingpong();
    }, this.#opts.pingIntervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#abortCurrentPing();
  }

  hasWaiter(id: string): boolean {
    return this.#waiters.has(id);
  }

  finishDummyPing(id: string): boolean {
    const waiter = this.#waiters.get(id);
    if (!waiter) return false;
    this.#waiters.delete(id);
    waiter.resolve(true);
    try {
      this.#opts.send(["CLOSE", id]);
    } catch {
      // socket already gone
    }
    return true;
  }

  #abortCurrentPing(): void {
    this.#gen += 1;
    const native = this.#nativePing;
    this.#nativePing = undefined;
    native?.abort();
    for (const waiter of this.#waiters.values()) waiter.resolve(false);
    this.#waiters.clear();
  }

  async #pingpong(): Promise<void> {
    const ws = this.#opts.getWs();
    if (!ws || ws.readyState !== WS_OPEN) return;
    if (this.#nativePing || this.#waiters.size > 0) return;

    const gen = this.#gen;
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
        if (this.#nativePing || this.#waiters.size > 0) done(false);
      }, this.#opts.pingTimeoutMs);
      void ping.then(done);
    });

    if (gen !== this.#gen) return;

    if (!ok) {
      this.#abortCurrentPing();
      this.#opts.closeWs();
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
      const id = this.#opts.nextSubId("__ping__");
      this.#waiters.set(id, { resolve });
      try {
        this.#opts.send(["REQ", id, PING_DUMMY_FILTER]);
      } catch {
        this.#waiters.delete(id);
        resolve(false);
      }
    });
  }
}
