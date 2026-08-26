import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { normalizeURL } from "../core/util.ts";
import type { Pool } from "./pool.ts";
import type { Relay } from "./relay.ts";

export type RoutedJob = {
  urls: readonly string[];
  filters: readonly Filter[];
  id?: string;
};

export type FanInOptions = {
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
  signal?: AbortSignal;
  /** Armed at fan-in only. Never forwarded to relay.subscribe. */
  eoseTimeoutMs?: number;
  alreadyHaveEvent?: (id: string) => boolean;
  receivedEvent?: (id: string) => void;
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
    opts.oneose?.();
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
    opts.onclose?.(reason ?? "closed by client");
  };

  if (opts.signal?.aborted) {
    closed = true;
    opts.onclose?.("aborted");
    return { close: closeAll };
  }

  opts.signal?.addEventListener("abort", () => closeAll("aborted"), { once: true });

  const attach = (relay: Relay, job: RoutedJob, jobIndex: number): void => {
    if (closed) return;
    const sub = relay.subscribe([...job.filters], {
      id: jobs.length === 1 ? job.id : undefined,
      closeOnEose: opts.closeOnEose,
      alreadyHaveEvent: (id) => Boolean(opts.alreadyHaveEvent?.(id) || seen.has(id)),
      receivedEvent: opts.receivedEvent,
      onevent: (event) => {
        seen.add(event.id);
        opts.onevent?.(event);
      },
      oneose: () => markEose(jobIndex, relay.url),
      onclose: (reason) => {
        markEose(jobIndex, relay.url);
        pending -= 1;
        if (pending <= 0 && !closed) {
          settleClose();
          opts.onclose?.(reason);
        }
      },
    });
    closers.push(sub);
  };

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
    const job = jobs[jobIndex]!;
    for (const url of job.urls) {
      let key: string;
      try {
        key = normalizeURL(url);
      } catch {
        key = url;
      }
      pending += 1;
      const eoseKey = `${jobIndex}:${key}`;
      if (!eoseAttempted.has(eoseKey)) {
        eoseAttempted.add(eoseKey);
        pendingEose += 1;
      }
      void pool
        .ensureRelay(url, { signal: opts.signal, timeoutMs: opts.connectTimeoutMs })
        .then((relay) => attach(relay, job, jobIndex))
        .catch(() => {
          // Presence after failed ensureRelay means reconnect kept the entry.
          const relay = pool.getRelay(key);
          if (relay) {
            attach(relay, job, jobIndex);
            return;
          }
          markEose(jobIndex, key);
          pending -= 1;
          if (pending <= 0 && closers.length === 0 && !closed) {
            settleClose();
            opts.onclose?.("all relays failed");
          }
        });
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
      opts.onclose?.("no relays");
    });
  }

  return { close: closeAll };
}

export async function fetchRouted(
  pool: Pool,
  jobs: readonly RoutedJob[],
  opts: { timeoutMs?: number; signal?: AbortSignal; connectTimeoutMs?: number } = {},
): Promise<Event[]> {
  const byId = new Map<string, Event>();
  await Promise.all(
    jobs.flatMap((job) =>
      job.urls.map(async (url) => {
        try {
          const relay = await pool.ensureRelay(url, {
            signal: opts.signal,
            timeoutMs: opts.connectTimeoutMs,
          });
          const batch = await relay.fetch([...job.filters], {
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
          });
          for (const event of batch) if (!byId.has(event.id)) byId.set(event.id, event);
        } catch {
          // skip failed relays
        }
      }),
    ),
  );
  return [...byId.values()];
}
