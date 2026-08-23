import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { createSubscriptionId } from "../core/message.ts";

export type SubscriptionHandlers = {
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
  /** Skip verify + onevent when true. Evaluated after parse, before verify. */
  alreadyHaveEvent?: (id: string) => boolean;
  /**
   * Fired for every EVENT id this sub sees, including duplicates and
   * alreadyHaveEvent hits, after parse and before the verify skip.
   */
  receivedEvent?: (id: string) => void;
};

export type SubscribeOptions = SubscriptionHandlers & {
  id?: string;
  /** Close after first EOSE (one-shot query). */
  eoseTimeoutMs?: number;
  signal?: AbortSignal;
};

export class Subscription {
  readonly id: string;
  readonly filters: Filter[];
  readonly handlers: SubscriptionHandlers;
  eosed = false;
  closed = false;
  /** True after one CLOSED `auth-required:` retry. */
  authRetried = false;
  /** Inclusive NIP-01 `since` watermark from verified EVENTs. */
  lastCreatedAt: number | undefined;
  /** Event ids at `lastCreatedAt` (same-second reconnect dedup). Not all seen ids. */
  readonly idsAtWatermark = new Set<string>();
  #abort: (() => void) | undefined;

  constructor(
    filters: Filter[],
    opts: SubscribeOptions,
    private readonly sendClose: (id: string) => void,
  ) {
    this.id = opts.id ?? createSubscriptionId();
    this.filters = filters;
    this.handlers = {
      onevent: opts.onevent,
      oneose: opts.oneose,
      onclose: opts.onclose,
      alreadyHaveEvent: opts.alreadyHaveEvent,
      receivedEvent: opts.receivedEvent,
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        this.close("aborted");
      } else {
        const onAbort = () => this.close("aborted");
        opts.signal.addEventListener("abort", onAbort, { once: true });
        this.#abort = () => opts.signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  close(reason = "closed by client"): void {
    if (this.closed) return;
    this.closed = true;
    this.#abort?.();
    this.sendClose(this.id);
    this.handlers.onclose?.(reason);
  }

  /** Advance the reconnect watermark after a verified EVENT. */
  noteVerified(event: Event): void {
    if (this.lastCreatedAt === undefined || event.created_at > this.lastCreatedAt) {
      this.lastCreatedAt = event.created_at;
      this.idsAtWatermark.clear();
      this.idsAtWatermark.add(event.id);
      return;
    }
    if (event.created_at === this.lastCreatedAt) this.idsAtWatermark.add(event.id);
  }

  /**
   * Filters for re-REQ. Original `filters` stay unchanged.
   * NIP-01 `since` is inclusive — never `lastCreatedAt + 1`.
   */
  replayFilters(): Filter[] {
    const since = this.lastCreatedAt;
    if (since === undefined) return this.filters;
    return this.filters.map((f) => ({
      ...f,
      since: f.since === undefined ? since : Math.max(f.since, since),
    }));
  }
}

/** AsyncIterable wrapper over a subscription's events until EOSE or close. */
export function subscriptionToAsyncIterable(
  start: (handlers: SubscriptionHandlers) => { close: (reason?: string) => void },
  opts?: { signal?: AbortSignal; includeEose?: boolean },
): AsyncIterable<Event> & { close: (reason?: string) => void } {
  const queue: Event[] = [];
  let done = false;
  let error: Error | undefined;
  let wake: (() => void) | undefined;
  let closer: { close: (reason?: string) => void } | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  closer = start({
    onevent(event) {
      queue.push(event);
      notify();
    },
    oneose() {
      if (opts?.includeEose === false) {
        done = true;
        closer?.close("eose");
        notify();
      }
    },
    onclose(reason) {
      if (reason && reason !== "eose" && reason !== "closed by client" && reason !== "aborted") {
        error = new Error(reason);
      }
      done = true;
      notify();
    },
  });

  if (opts?.signal) {
    if (opts.signal.aborted) {
      closer.close("aborted");
      done = true;
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          closer?.close("aborted");
          done = true;
          notify();
        },
        { once: true },
      );
    }
  }

  return {
    close(reason?: string) {
      closer?.close(reason);
      done = true;
      notify();
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Event>> {
          while (true) {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            if (error) throw error;
            if (done) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<Event>> {
          closer?.close("iterator returned");
          done = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
}
