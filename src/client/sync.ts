import type { Event } from "../core/event.ts";
import { canonicalizeFilter, type Filter } from "../core/filter.ts";
import type { Pool } from "../relay/pool.ts";
import type { EventStore, PutResult } from "../storage/types.ts";
import { storageFromItems, type NegentropyStorageVector } from "../nips/nip77.ts";
import { SyncDirection, type SyncOptions, type SyncSummary } from "./types.ts";

export type SyncDeps = {
  pool: Pool;
  storage: EventStore;
  persistEvents: boolean;
  assertAlive: () => void;
  throwIfAborted: (signal?: AbortSignal) => void;
  wantObserve: (flag?: boolean) => boolean;
  ingestMeta: (event: Event) => void;
  defaultRelays: (urls?: string[]) => string[];
};

const SYNC_ID_BATCH = 100;
const SYNC_UPLOAD_CONCURRENCY = 8;

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function emptySummary(): SyncSummary {
  return {
    local: [],
    remote: [],
    sent: [],
    received: [],
    sendFailures: {},
    persistFailures: {},
  };
}

function mergeSyncSummary(into: SyncSummary, other: SyncSummary): SyncSummary {
  const sendFailures = { ...into.sendFailures, ...other.sendFailures };
  const persistFailures = { ...into.persistFailures, ...other.persistFailures };
  return {
    local: uniqueIds([...into.local, ...other.local]),
    remote: uniqueIds([...into.remote, ...other.remote]),
    sent: uniqueIds([...into.sent, ...other.sent]),
    received: uniqueIds([...into.received, ...other.received]),
    sendFailures,
    persistFailures,
  };
}

/**
 * NIP-77 sync against one relay: reconcile, then optionally upload
 * local-only events and/or download remote-only events.
 * `observe: false` skips putMany and ingestMeta; received ids are still listed.
 * `persistEvents: false` skips putMany, still ingestMeta when observe is on.
 */
export async function syncToRelay(
  deps: SyncDeps,
  url: string,
  filter: Filter,
  opts?: Omit<SyncOptions, "relays">,
): Promise<SyncSummary> {
  deps.assertAlive();
  deps.throwIfAborted(opts?.signal);
  const direction = opts?.direction ?? SyncDirection.Down;
  filter = canonicalizeFilter(filter);
  const items = await deps.storage.negentropyItems(filter);
  const storage: NegentropyStorageVector = storageFromItems(items);
  const relay = await deps.pool.ensureRelay(url, { signal: opts?.signal });
  const { have, need } = await relay.negReconcile(filter, storage, {
    timeoutMs: opts?.timeoutMs,
    signal: opts?.signal,
  });

  const summary: SyncSummary = {
    local: have,
    remote: need,
    sent: [],
    received: [],
    sendFailures: {},
    persistFailures: {},
  };

  if (opts?.dryRun) return summary;

  if (direction === SyncDirection.Up || direction === SyncDirection.Both) {
    if (have.length > 0) {
      const found = await deps.storage.query([{ ids: have }]);
      const foundById = new Map(found.map((event) => [event.id, event]));
      for (const id of have) {
        if (!foundById.has(id)) {
          summary.sendFailures[id] = "event not found in local store";
        }
      }
      for (let i = 0; i < found.length; i += SYNC_UPLOAD_CONCURRENCY) {
        const chunk = found.slice(i, i + SYNC_UPLOAD_CONCURRENCY);
        await Promise.all(
          chunk.map(async (event) => {
            try {
              const results = await deps.pool.publish([url], event, {
                timeoutMs: opts?.timeoutMs,
              });
              const ok = results.some((r) => r.result?.ok);
              if (ok) summary.sent.push(event.id);
              else {
                summary.sendFailures[event.id] =
                  results[0]?.error ?? results[0]?.result?.message ?? "publish failed";
              }
            } catch (error) {
              summary.sendFailures[event.id] =
                error instanceof Error ? error.message : String(error);
            }
          }),
        );
      }
    }
  }

  if ((direction === SyncDirection.Down || direction === SyncDirection.Both) && need.length > 0) {
    const shouldObserve = deps.wantObserve(opts?.observe);
    for (let i = 0; i < need.length; i += SYNC_ID_BATCH) {
      const batch = need.slice(i, i + SYNC_ID_BATCH);
      deps.throwIfAborted(opts?.signal);
      const events = await deps.pool.fetch([url], [{ ids: batch }], {
        timeoutMs: opts?.timeoutMs,
        signal: opts?.signal,
      });
      if (!shouldObserve) {
        for (const event of events) summary.received.push(event.id);
        continue;
      }
      if (!deps.persistEvents) {
        for (const event of events) {
          deps.ingestMeta(event);
          summary.received.push(event.id);
        }
        continue;
      }
      let results: PutResult[];
      try {
        results = await deps.storage.putMany(events);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const event of events) summary.persistFailures[event.id] = message;
        break;
      }
      for (let j = 0; j < events.length; j++) {
        const event = events[j]!;
        if (results[j] === "rejected") continue;
        deps.ingestMeta(event);
        summary.received.push(event.id);
      }
    }
  }

  return summary;
}

/**
 * NIP-77 sync against the given relays (or Client default relays).
 * Independent sessions run in parallel. Fulfilled summaries are merged;
 * if every relay rejects, throws the first rejection in URL order.
 */
export async function sync(
  deps: SyncDeps,
  filter: Filter,
  opts?: SyncOptions,
): Promise<SyncSummary> {
  deps.assertAlive();
  const urls = deps.defaultRelays(opts?.relays ? [...opts.relays] : undefined);
  const results = await Promise.allSettled(urls.map((url) => syncToRelay(deps, url, filter, opts)));
  let merged = emptySummary();
  let fulfilled = 0;
  let firstRejection: unknown;
  for (const result of results) {
    if (result.status === "fulfilled") {
      fulfilled += 1;
      merged = mergeSyncSummary(merged, result.value);
    } else {
      firstRejection ??= result.reason;
    }
  }
  if (urls.length > 0 && fulfilled === 0) throw firstRejection;
  return merged;
}
