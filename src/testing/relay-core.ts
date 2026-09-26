import type { Event } from "../core/event.ts";
import { compareEventsDesc, validateSignedEvent } from "../core/event.ts";
import { matchFilter, type Filter } from "../core/filter.ts";
import { Kind } from "../core/kind.ts";
import { bytesToHex, normalizeURL } from "../core/util.ts";
import { verifyEvent } from "../core/key.ts";
import { Negentropy, PROTOCOL_VERSION, storageFromEvents } from "../nips/nip77.ts";
import { MemoryEventStore } from "../storage/memory.ts";
import type { PutResult } from "../storage/types.ts";

export type FakeRelayOptions = {
  /** Delay before every relay→client message. */
  latencyMs?: number;
  auth?: {
    /** Sent as `["AUTH", challenge]` right after the socket opens. */
    challenge: string;
    /** REQ whose filters can match these kinds is CLOSED `auth-required:` until AUTH succeeds. */
    readKinds?: readonly number[];
    /** EVENT → `["OK", id, false, "auth-required: ..."]` until AUTH succeeds. */
    writes?: boolean;
  };
  /** EVENT → `["OK", id, false, "rate-limited: ..."]`; nothing is stored. */
  rateLimited?: boolean;
  /** Out-of-order reply: send EOSE first, then the stored events. */
  eoseBeforeEvents?: boolean;
};

export interface FakeRelay {
  readonly url: string;
  seed(events: readonly Event[]): void;
  events(): readonly Event[];
  inject(event: Event): void;
  disconnect(): void;
  closeSubscriptions(reason: string): void;
  configure(opts: Partial<FakeRelayOptions>): void;
  /** Every parsed client→relay message received, in arrival order. */
  clientMessages(): readonly unknown[];
}

/** One relay→client transport (an in-process socket or a `ws` connection). */
export type RelayTransport = {
  send(data: string): void;
  close(): void;
};

export type FakeRelaySession = {
  transport: RelayTransport;
  subs: Map<string, Filter[]>;
  negs: Map<string, Negentropy>;
  authed: boolean;
  queue: Promise<void>;
};

function searchMatch(filter: Filter, event: Event): boolean {
  if (filter.search === undefined) return true;
  return event.content.toLowerCase().includes(filter.search.toLowerCase());
}

function subMatches(filters: readonly Filter[], event: Event): boolean {
  return filters.some((f) => matchFilter(f, event) && searchMatch(f, event));
}

/** Put outcomes that made the event part of the relay's live stream. */
function isLivePut(result: PutResult): boolean {
  return (
    result === "accepted" || result === "replaced" || result === "deleted" || result === "ephemeral"
  );
}

function mayReadKinds(filters: readonly Filter[], readKinds: readonly number[]): boolean {
  return filters.some((f) => f.kinds === undefined || f.kinds.some((k) => readKinds.includes(k)));
}

/**
 * Transport-agnostic fake relay: one NIP-01/42/45/50/77 session state machine
 * per connection, storage via {@link MemoryEventStore}. No timers except
 * `latencyMs`; no global state.
 */
export class FakeRelayCore implements FakeRelay {
  readonly url: string;
  #opts: FakeRelayOptions;
  #store = new MemoryEventStore();
  #sessions = new Set<FakeRelaySession>();
  #mirror = new Map<string, Event>();
  #inbox: unknown[] = [];
  #pending: Promise<void> = Promise.resolve();

  constructor(url: string, opts: FakeRelayOptions = {}) {
    this.url = normalizeURL(url);
    this.#opts = opts;
  }

  configure(opts: Partial<FakeRelayOptions>): void {
    this.#opts = { ...this.#opts, ...opts };
  }

  seed(events: readonly Event[]): void {
    for (const event of events) this.#mirror.set(event.id, event);
    this.#pending = this.#pending.then(async () => {
      for (const event of events) await this.#store.put(event);
      await this.#refreshMirror();
    });
  }

  events(): readonly Event[] {
    return [...this.#mirror.values()];
  }

  inject(event: Event): void {
    this.#pending = this.#pending.then(async () => {
      const result = await this.#store.put(event);
      await this.#refreshMirror();
      if (isLivePut(result)) this.#deliver(event);
    });
  }

  disconnect(): void {
    const sessions: FakeRelaySession[] = [...this.#sessions];
    this.#sessions.clear();
    for (const session of sessions) session.transport.close();
  }

  closeSubscriptions(reason: string): void {
    for (const session of this.#sessions) {
      for (const id of session.subs.keys()) {
        this.#send(session, ["CLOSED", id, reason]);
      }
      session.subs.clear();
      session.negs.clear();
    }
  }

  clientMessages(): readonly unknown[] {
    return this.#inbox;
  }

  /** Attach a transport; returns a handle for {@link handleMessage}/detach. */
  connect(transport: RelayTransport): FakeRelaySession {
    const session: FakeRelaySession = {
      transport,
      subs: new Map(),
      negs: new Map(),
      authed: false,
      queue: Promise.resolve(),
    };
    this.#sessions.add(session);
    if (this.#opts.auth) this.#send(session, ["AUTH", this.#opts.auth.challenge]);
    return session;
  }

  detach(session: FakeRelaySession): void {
    this.#sessions.delete(session);
  }

  /** Feed a raw client→relay frame. Messages of one session are handled in order. */
  handleMessage(session: FakeRelaySession, raw: string): void {
    // A handler throw must not poison the session queue: NOTICE and continue.
    session.queue = session.queue
      .then(() => this.#handle(session, raw))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        try {
          this.#send(session, ["NOTICE", `error: ${message}`]);
        } catch {
          // transport gone
        }
      });
  }

  async #refreshMirror(): Promise<void> {
    const all = await this.#store.query([{}]);
    this.#mirror = new Map(all.map((e) => [e.id, e]));
  }

  #send(session: FakeRelaySession, message: unknown[]): void {
    const payload = JSON.stringify(message);
    if (this.#opts.latencyMs) {
      setTimeout(() => session.transport.send(payload), this.#opts.latencyMs);
      return;
    }
    session.transport.send(payload);
  }

  #deliver(event: Event): void {
    for (const session of this.#sessions) {
      for (const [id, filters] of session.subs) {
        if (subMatches(filters, event)) this.#send(session, ["EVENT", id, event]);
      }
    }
  }

  async #matched(filters: Filter[]): Promise<Event[]> {
    const seen = new Map<string, Event>();
    for (const filter of filters) {
      // Per-filter NIP-01 limit: query unbounded, apply search, keep that
      // filter's newest — never a cross-filter minimum.
      const unbounded = { ...filter };
      delete unbounded.limit;
      const rows = (await this.#store.query([unbounded])).filter((event) =>
        searchMatch(filter, event),
      );
      rows.sort(compareEventsDesc);
      const kept = filter.limit === undefined ? rows : rows.slice(0, filter.limit);
      for (const event of kept) {
        if (!seen.has(event.id)) seen.set(event.id, event);
      }
    }
    const matched = [...seen.values()];
    matched.sort(compareEventsDesc);
    return matched;
  }

  async #handle(session: FakeRelaySession, raw: string): Promise<void> {
    await this.#pending;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.#send(session, ["NOTICE", "error: invalid message"]);
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") {
      this.#send(session, ["NOTICE", "error: invalid message"]);
      return;
    }
    this.#inbox.push(msg);

    switch (msg[0]) {
      case "EVENT": {
        const event = msg[1] as Event | undefined;
        if (!event || typeof event.id !== "string") {
          this.#send(session, ["NOTICE", "invalid: malformed event"]);
          return;
        }
        if (this.#opts.rateLimited) {
          this.#send(session, ["OK", event.id, false, "rate-limited: slow down"]);
          return;
        }
        if (this.#opts.auth?.writes && !session.authed) {
          this.#send(session, ["OK", event.id, false, "auth-required: login first"]);
          return;
        }
        if (!verifyEvent(event)) {
          this.#send(session, ["OK", event.id, false, "invalid: signature or id"]);
          return;
        }
        const result = await this.#store.put(event);
        await this.#refreshMirror();
        if (result === "rejected") {
          this.#send(session, [
            "OK",
            event.id,
            false,
            "invalid: a newer version of this event exists",
          ]);
          return;
        }
        if (result === "invalid") {
          this.#send(session, ["OK", event.id, false, "invalid: malformed event"]);
          return;
        }
        if (result === "duplicate") {
          this.#send(session, ["OK", event.id, true, "duplicate: already have this event"]);
          return;
        }
        this.#send(session, ["OK", event.id, true, ""]);
        this.#deliver(event);
        return;
      }
      case "REQ": {
        const id = msg[1];
        const filters = msg.slice(2) as Filter[];
        if (typeof id !== "string" || filters.length === 0) {
          this.#send(session, ["NOTICE", "error: invalid REQ"]);
          return;
        }
        const readKinds = this.#opts.auth?.readKinds;
        if (readKinds !== undefined && !session.authed && mayReadKinds(filters, readKinds)) {
          this.#send(session, ["CLOSED", id, "auth-required: we only serve to authed users"]);
          return;
        }
        session.subs.set(id, filters);
        const matched = await this.#matched(filters);
        if (this.#opts.eoseBeforeEvents) this.#send(session, ["EOSE", id]);
        for (const event of matched) this.#send(session, ["EVENT", id, event]);
        if (!this.#opts.eoseBeforeEvents) this.#send(session, ["EOSE", id]);
        return;
      }
      case "CLOSE": {
        if (typeof msg[1] === "string") session.subs.delete(msg[1]);
        return;
      }
      case "COUNT": {
        const id = msg[1];
        const filters = msg.slice(2) as Filter[];
        const matched = await this.#matched(filters);
        this.#send(session, ["COUNT", id, { count: matched.length }]);
        return;
      }
      case "AUTH": {
        const auth = this.#opts.auth;
        if (!validateSignedEvent(msg[1])) {
          this.#send(session, ["OK", "0".repeat(64), false, "error: invalid auth event"]);
          return;
        }
        const event = msg[1];
        const challengeTag = event.tags.find((t) => t[0] === "challenge")?.[1];
        const relayTag = event.tags.find((t) => t[0] === "relay")?.[1];
        let relayOk = false;
        try {
          relayOk = relayTag !== undefined && normalizeURL(relayTag) === this.url;
        } catch {
          relayOk = false;
        }
        if (
          auth &&
          event.kind === Kind.ClientAuth &&
          verifyEvent(event) &&
          challengeTag === auth.challenge &&
          relayOk
        ) {
          session.authed = true;
          this.#send(session, ["OK", event.id, true, ""]);
          return;
        }
        this.#send(session, ["OK", event.id, false, "error: invalid auth event"]);
        return;
      }
      case "NEG-OPEN": {
        if (msg.length === 5) {
          this.#send(session, ["NEG-ERR", msg[1], "error: obsolete 5-element NEG-OPEN"]);
          return;
        }
        if (msg.length !== 4 || typeof msg[1] !== "string" || typeof msg[3] !== "string") {
          const badId = typeof msg[1] === "string" ? msg[1] : "";
          this.#send(session, ["NEG-ERR", badId, "error: invalid NEG-OPEN"]);
          return;
        }
        const id = msg[1];
        // The NIP-77 filter is a plain NIP-01 filter — `limit` applies.
        const filter = msg[2] as Filter;
        const matched = await this.#matched([filter]);
        const neg = new Negentropy(storageFromEvents(matched));
        let opened: string | undefined;
        try {
          opened = neg.reconcile(msg[3] as string).nextMessage ?? undefined;
        } catch {
          this.#send(session, ["NEG-ERR", id, "error: invalid negentropy message"]);
          return;
        }
        session.negs.set(id, neg);
        this.#send(session, [
          "NEG-MSG",
          id,
          opened ?? bytesToHex(new Uint8Array([PROTOCOL_VERSION])),
        ]);
        return;
      }
      case "NEG-MSG": {
        if (msg.length !== 3 || typeof msg[1] !== "string" || typeof msg[2] !== "string") return;
        const handle = session.negs.get(msg[1]);
        if (!handle) {
          this.#send(session, ["NEG-ERR", msg[1], "closed: unknown subscription"]);
          return;
        }
        let next: string | undefined;
        try {
          next = handle.reconcile(msg[2]).nextMessage ?? undefined;
        } catch {
          session.negs.delete(msg[1]);
          this.#send(session, ["NEG-ERR", msg[1], "error: invalid negentropy message"]);
          return;
        }
        this.#send(session, [
          "NEG-MSG",
          msg[1],
          next ?? bytesToHex(new Uint8Array([PROTOCOL_VERSION])),
        ]);
        return;
      }
      case "NEG-CLOSE": {
        if (typeof msg[1] === "string") session.negs.delete(msg[1]);
        return;
      }
      default:
        this.#send(session, ["NOTICE", `error: unsupported ${String(msg[0])}`]);
        return;
    }
  }
}
