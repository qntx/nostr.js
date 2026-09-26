import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { invokeSafely } from "../core/report.ts";
import { normalizeURL } from "../core/util.ts";
import { RelayClosedError } from "./error.ts";
import type { Pool } from "./pool.ts";
import type { Relay } from "./relay.ts";

export type RoutedJob = {
  urls: readonly string[];
  filters: readonly Filter[];
  id?: string;
};

export type FanInOptions = {
  /** First receipt only (deduped across jobs). `relayUrl` is the normalized relay URL. */
  onevent?: (event: Event, relayUrl: string) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
  signal?: AbortSignal;
  /** Armed at fan-in only. Never forwarded to relay.subscribe. */
  eoseTimeoutMs?: number;
  alreadyHaveEvent?: (id: string) => boolean;
  /** Every receipt from every relay, including skipped duplicates. */
  receivedEvent?: (id: string, relayUrl: string) => void;
  closeOnEose?: boolean;
  /** Optional. ensureRelay uses Pool.#opts.connectTimeoutMs when omitted. */
  connectTimeoutMs?: number;
};

/**
 * Aggregate EOSE/close across routed jobs. One `seen` set.
 * `pending` counts URL list entries (duplicates included).
 * `pendingEose` counts unique `jobIndex:url` keys.
 */
export function fanIn(
  pool: Pool,
  jobs: readonly RoutedJob[],
  opts: FanInOptions = {},
): { close: (reason?: string) => void } {
  const seen = new Set<string>();
  const closers: Array<{ close: (reason?: string) => void }> = [];
  let closed = false;
  let eoseFired = false;
  let eoseTimer: ReturnType<typeof setTimeout> | undefined;
  const eoseDone = new Set<string>();
  const eoseAttempted = new Set<string>();
  let pendingEose = 0;
  let pending = 0;

  const fireEose = () => {
    if (closed || eoseFired) return;
    eoseFired = true;
    if (eoseTimer !== undefined) {
      clearTimeout(eoseTimer);
      eoseTimer = undefined;
    }
    invokeSafely(() => opts.oneose?.());
  };

  const markEose = (jobIndex: number, url: string) => {
    const key = `${jobIndex}:${url}`;
    if (eoseDone.has(key)) return;
    eoseDone.add(key);
    pendingEose -= 1;
    if (pendingEose === 0) fireEose();
  };

  const settleClose = () => {
    closed = true;
    if (eoseTimer !== undefined) {
      clearTimeout(eoseTimer);
      eoseTimer = undefined;
    }
  };

  const closeAll = (reason?: string) => {
    if (closed) return;
    settleClose();
    for (const c of closers) c.close(reason);
    invokeSafely(() => opts.onclose?.(reason ?? "closed by client"));
  };

  if (opts.signal?.aborted) {
    closed = true;
    invokeSafely(() => opts.onclose?.("aborted"));
    return { close: closeAll };
  }

  opts.signal?.addEventListener("abort", () => closeAll("aborted"), { once: true });

  const attach = (relay: Relay, job: RoutedJob, jobIndex: number): void => {
    if (closed) return;
    const received = opts.receivedEvent;
    const sub = relay.subscribe([...job.filters], {
      id: jobs.length === 1 ? job.id : undefined,
      closeOnEose: opts.closeOnEose,
      alreadyHaveEvent: (id) => {
        let have = seen.has(id);
        invokeSafely(() => {
          have = have || Boolean(opts.alreadyHaveEvent?.(id));
        });
        return have;
      },
      receivedEvent:
        received === undefined ? undefined : (id) => invokeSafely(() => received(id, relay.url)),
      onevent: (event) => {
        seen.add(event.id);
        invokeSafely(() => opts.onevent?.(event, relay.url));
      },
      oneose: () => markEose(jobIndex, relay.url),
      onclose: (reason) => {
        markEose(jobIndex, relay.url);
        pending -= 1;
        if (pending <= 0 && !closed) {
          settleClose();
          invokeSafely(() => opts.onclose?.(reason));
        }
      },
    });
    closers.push(sub);
  };

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
    const job = jobs[jobIndex]!;
    // Equivalent spellings of one relay URL attach exactly once per job.
    const jobUrls = new Set<string>();
    for (const url of job.urls) {
      let key: string;
      try {
        key = normalizeURL(url);
      } catch {
        key = url; // invalid URL: ensureRelay fails it like a dead relay
      }
      if (jobUrls.has(key)) continue;
      jobUrls.add(key);
      pending += 1;
      const eoseKey = `${jobIndex}:${key}`;
      if (!eoseAttempted.has(eoseKey)) {
        eoseAttempted.add(eoseKey);
        pendingEose += 1;
      }

      const failUrl = (): void => {
        markEose(jobIndex, key);
        pending -= 1;
        if (pending <= 0 && closers.length === 0 && !closed) {
          settleClose();
          invokeSafely(() => opts.onclose?.("all relays failed"));
        }
      };

      const tryAttach = (relay: Relay): void => {
        try {
          attach(relay, job, jobIndex);
        } catch (err) {
          if (err instanceof RelayClosedError) {
            failUrl();
            return;
          }
          throw err;
        }
      };

      void pool.ensureRelay(key, { signal: opts.signal, timeoutMs: opts.connectTimeoutMs }).then(
        (relay) => tryAttach(relay),
        () => {
          // ensureRelay rejected only — not tryAttach throws (those must not look like connect failure).
          const relay = pool.getRelay(key);
          if (relay) {
            tryAttach(relay);
            return;
          }
          failUrl();
        },
      );
    }
  }

  if (opts.eoseTimeoutMs !== undefined && pending > 0) {
    eoseTimer = setTimeout(() => {
      eoseTimer = undefined;
      fireEose();
    }, opts.eoseTimeoutMs);
  }

  if (pending === 0) {
    queueMicrotask(() => {
      if (closed) return;
      settleClose();
      invokeSafely(() => opts.onclose?.("no relays"));
    });
  }

  return { close: closeAll };
}

export async function fetchRouted(
  pool: Pool,
  jobs: readonly RoutedJob[],
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    connectTimeoutMs?: number;
    /** Every event of every relay batch, including cross-relay duplicates. */
    onevent?: (event: Event, relayUrl: string) => void;
  } = {},
): Promise<Event[]> {
  const byId = new Map<string, Event>();
  await Promise.all(
    jobs.flatMap((job) => {
      const urls: string[] = [];
      for (const raw of job.urls) {
        let key: string;
        try {
          key = normalizeURL(raw);
        } catch {
          key = raw; // invalid URL: ensureRelay fails it like a dead relay
        }
        if (!urls.includes(key)) urls.push(key);
      }
      return urls.map(async (url) => {
        let batch: Event[];
        let relayUrl: string;
        try {
          const relay = await pool.ensureRelay(url, {
            signal: opts.signal,
            timeoutMs: opts.connectTimeoutMs,
          });
          relayUrl = relay.url;
          batch = await relay.fetch([...job.filters], {
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
          });
        } catch {
          return; // skip failed relays
        }
        // The whole batch lands before callbacks so a throwing onevent cannot
        // drop events; listener errors are reported, never propagated.
        for (const event of batch) {
          if (!byId.has(event.id)) byId.set(event.id, event);
        }
        for (const event of batch) {
          invokeSafely(() => opts.onevent?.(event, relayUrl));
        }
      });
    }),
  );
  return [...byId.values()];
}
