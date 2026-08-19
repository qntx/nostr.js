import type { Event } from "../../src/core/event.ts";
import type { Filter } from "../../src/core/filter.ts";
import { matchFilters } from "../../src/core/filter.ts";
import { bytesToHex } from "../../src/core/util.ts";
import { normalizeURL } from "../../src/core/util.ts";
import { PROTOCOL_VERSION, Responder, storageFromEvents } from "../../src/nips/nip77.ts";
import { MockWebSocket } from "./mock-ws.ts";

type Sub = { id: string; filters: Filter[] };
type NegHandle = { responder: Responder };

export type FakeRelayBusOptions = {
  /**
   * When set, each new connection receives `["AUTH", challenge]` after open.
   * String challenge for all URLs, or per-URL function.
   */
  authChallenge?: string | ((url: string) => string | undefined);
  /** When true (and a challenge is configured), EVENT publishes get OK false until AUTH succeeds. */
  requireAuth?: boolean;
};

/**
 * In-process NIP-01 relay simulator over {@link MockWebSocket}.
 * Auto-handles EVENT→OK, REQ→matching events+EOSE, COUNT, CLOSE, AUTH→OK.
 * Use for integration tests without a live relay process.
 */
export class FakeRelayBus {
  readonly #events = new Map<string, Event[]>();
  readonly #cursor = new WeakMap<MockWebSocket, number>();
  readonly #subs = new WeakMap<MockWebSocket, Map<string, Sub>>();
  readonly #authed = new WeakSet<MockWebSocket>();
  readonly #neg = new WeakMap<MockWebSocket, Map<string, NegHandle>>();
  readonly #opts: FakeRelayBusOptions;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: FakeRelayBusOptions = {}) {
    this.#opts = opts;
  }

  /** Seed events visible on a relay URL (matched after {@link normalizeURL}). */
  seed(url: string, events: Event[]): void {
    const key = normalizeURL(url);
    const list = this.#events.get(key) ?? [];
    for (const e of events) {
      if (!list.some((x) => x.id === e.id)) list.push(e);
    }
    this.#events.set(key, list);
  }

  eventsOn(url: string): readonly Event[] {
    return this.#events.get(normalizeURL(url)) ?? [];
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), 5);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #storeFor(url: string): Event[] {
    const key = normalizeURL(url);
    let list = this.#events.get(key);
    if (!list) {
      list = [];
      this.#events.set(key, list);
    }
    return list;
  }

  #tick(): void {
    for (const ws of MockWebSocket.instances) {
      if (ws.readyState !== MockWebSocket.OPEN) continue;

      // AUTH challenge once per socket after open.
      if (!this.#cursor.has(ws)) {
        this.#cursor.set(ws, 0);
        this.#subs.set(ws, new Map());
        this.#neg.set(ws, new Map());
        const challenge =
          typeof this.#opts.authChallenge === "function"
            ? this.#opts.authChallenge(ws.url)
            : this.#opts.authChallenge;
        if (challenge) {
          ws.receive(JSON.stringify(["AUTH", challenge]));
        }
      }

      const start = this.#cursor.get(ws) ?? 0;
      if (start >= ws.sent.length) continue;
      this.#cursor.set(ws, ws.sent.length);

      for (let i = start; i < ws.sent.length; i++) {
        const raw = ws.sent[i]!;
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!Array.isArray(msg) || typeof msg[0] !== "string") continue;
        this.#handle(ws, msg as unknown[]);
      }
    }
  }

  #handle(ws: MockWebSocket, msg: unknown[]): void {
    const type = msg[0] as string;
    const subs = this.#subs.get(ws)!;
    const store = this.#storeFor(ws.url);

    switch (type) {
      case "EVENT": {
        const event = msg[1] as Event;
        if (!event?.id) return;
        if (this.#opts.requireAuth && this.#opts.authChallenge && !this.#authed.has(ws)) {
          ws.receive(JSON.stringify(["OK", event.id, false, "auth-required: login"]));
          return;
        }
        if (!store.some((e) => e.id === event.id)) store.push(event);
        ws.receive(JSON.stringify(["OK", event.id, true, ""]));
        const url = normalizeURL(ws.url);
        for (const peer of MockWebSocket.instances) {
          if (peer.readyState !== MockWebSocket.OPEN) continue;
          if (normalizeURL(peer.url) !== url) continue;
          const peerSubs = this.#subs.get(peer);
          if (!peerSubs) continue;
          for (const sub of peerSubs.values()) {
            if (matchFilters(sub.filters, event)) {
              peer.receive(JSON.stringify(["EVENT", sub.id, event]));
            }
          }
        }
        return;
      }
      case "REQ": {
        const id = msg[1] as string;
        const filters = msg.slice(2) as Filter[];
        subs.set(id, { id, filters });
        let matched = store.filter((e) => matchFilters(filters, e));
        const limit = filters.reduce(
          (min, f) => (f.limit !== undefined ? Math.min(min, f.limit) : min),
          Number.POSITIVE_INFINITY,
        );
        if (Number.isFinite(limit)) matched = matched.slice(0, limit as number);
        for (const e of matched) {
          ws.receive(JSON.stringify(["EVENT", id, e]));
        }
        ws.receive(JSON.stringify(["EOSE", id]));
        return;
      }
      case "CLOSE": {
        const id = msg[1] as string;
        subs.delete(id);
        return;
      }
      case "COUNT": {
        const id = msg[1] as string;
        const filters = msg.slice(2) as Filter[];
        const count = store.filter((e) => matchFilters(filters, e)).length;
        ws.receive(JSON.stringify(["COUNT", id, { count }]));
        return;
      }
      case "AUTH": {
        const event = msg[1] as Event;
        if (event?.id) {
          this.#authed.add(ws);
          ws.receive(JSON.stringify(["OK", event.id, true, ""]));
        }
        return;
      }
      case "NEG-OPEN": {
        if (msg.length === 5) {
          ws.receive(JSON.stringify(["NEG-ERR", msg[1], "error: obsolete 5-element NEG-OPEN"]));
          return;
        }
        if (msg.length !== 4 || typeof msg[1] !== "string" || typeof msg[3] !== "string") {
          const badId = typeof msg[1] === "string" ? msg[1] : "";
          ws.receive(JSON.stringify(["NEG-ERR", badId, "error: invalid NEG-OPEN"]));
          return;
        }
        const id = msg[1];
        const filter = msg[2] as Filter;
        const hex = msg[3];
        const matched = store.filter((e) => matchFilters([filter], e));
        const responder = new Responder(storageFromEvents(matched));
        this.#neg.get(ws)?.set(id, { responder });
        const out = responder.reconcile(hex);
        ws.receive(
          JSON.stringify([
            "NEG-MSG",
            id,
            out.nextMessage ?? bytesToHex(new Uint8Array([PROTOCOL_VERSION])),
          ]),
        );
        return;
      }
      case "NEG-MSG": {
        if (msg.length !== 3 || typeof msg[1] !== "string" || typeof msg[2] !== "string") return;
        const handle = this.#neg.get(ws)?.get(msg[1]);
        if (!handle) {
          ws.receive(JSON.stringify(["NEG-ERR", msg[1], "closed: unknown subscription"]));
          return;
        }
        const out = handle.responder.reconcile(msg[2]);
        if (out.nextMessage === null) {
          ws.receive(
            JSON.stringify(["NEG-MSG", msg[1], bytesToHex(new Uint8Array([PROTOCOL_VERSION]))]),
          );
        } else {
          ws.receive(JSON.stringify(["NEG-MSG", msg[1], out.nextMessage]));
        }
        return;
      }
      case "NEG-CLOSE": {
        if (typeof msg[1] === "string") this.#neg.get(ws)?.delete(msg[1]);
        return;
      }
      default:
        return;
    }
  }
}
