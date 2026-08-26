import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import type { Gossip } from "../gossip/gossip.ts";
import { fanIn, fetchRouted, type FanInOptions, type RoutedJob } from "../relay/fan-in.ts";
import type { Pool } from "../relay/pool.ts";

/** Remainder is one job on defaults; throw before any REQ when defaults are empty. */
export function jobsForFilters(
  gossip: Gossip,
  filters: Filter[],
  defaultRelays: () => string[],
): RoutedJob[] {
  const routed = filters.map((f) => gossip.route(f));
  const needsDefaults = routed.some((r) => r.remainder !== undefined);
  const defaults = needsDefaults ? defaultRelays() : undefined;
  const jobs: RoutedJob[] = [];
  for (const r of routed) {
    for (const [url, sub] of r.perRelay) jobs.push({ urls: [url], filters: [sub] });
    if (r.remainder) jobs.push({ urls: defaults!, filters: [r.remainder] });
  }
  return jobs;
}

export function fetchGossip(
  pool: Pool,
  gossip: Gossip,
  filters: Filter[],
  defaultRelays: () => string[],
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<Event[]> {
  return fetchRouted(pool, jobsForFilters(gossip, filters, defaultRelays), {
    timeoutMs: opts?.timeoutMs,
    signal: opts?.signal,
  });
}

export function subscribeGossip(
  pool: Pool,
  gossip: Gossip,
  filters: Filter[],
  defaultRelays: () => string[],
  opts: FanInOptions,
): { close: (reason?: string) => void } {
  const jobs = jobsForFilters(gossip, filters, defaultRelays);
  if (jobs.length === 0) {
    queueMicrotask(() => opts.oneose?.());
    return { close: () => {} };
  }
  return fanIn(pool, jobs, opts);
}
