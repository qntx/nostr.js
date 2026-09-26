import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { formatEventAddress } from "../core/tag.ts";
import { DataLoader } from "./dataloader.ts";
import type { LoaderContext } from "./context.ts";

export type ReplaceableLoadResult = {
  event: Event | null;
  fresh: boolean;
};

export type LoadStyle = "default" | "force" | "cache-only";

export type ReplaceableLoader = (
  pubkey: string,
  opts?: { hints?: string[]; style?: LoadStyle },
) => Promise<ReplaceableLoadResult>;

/** FIFO cap on per-address fetch records (misses included). */
const MAX_FETCHED_AT = 10_000;

/**
 * address -> last network fetch. `hit` is true when the index held a winner
 * right after that fetch; a fresh `hit` record whose winner was evicted
 * since must refetch instead of reporting a miss.
 */
type FetchedAt = Map<string, { at: number; hit: boolean }>;

/**
 * Batch-fetch replaceable events (kind + authors) via the pool. Fetched
 * events are written into the reactive index (`onevent` records `seenOn`)
 * and the winner is read back from it; the index — not the loader — owns
 * the stored value and winner selection. The loader only tracks per-address
 * `fetchedAt` timestamps so a recent fetch (including a miss) is not
 * repeated within `staleAfterSec`.
 */
export function createReplaceableLoader(ctx: LoaderContext, kind: number): ReplaceableLoader {
  type Key = { pubkey: string; hints?: string[] };

  const fetchedAt: FetchedAt = new Map();
  const markFetched = (addr: string, hit: boolean, now: number): void => {
    fetchedAt.delete(addr);
    fetchedAt.set(addr, { at: now, hit });
    while (fetchedAt.size > MAX_FETCHED_AT) {
      const oldest = fetchedAt.keys().next();
      if (oldest.done) break;
      fetchedAt.delete(oldest.value);
    }
  };

  const loader = new DataLoader<Key, ReplaceableLoadResult, string>(
    async (keys) => {
      const authors = [...new Set(keys.map((k) => k.pubkey))];
      const relays = [...new Set(keys.flatMap((k) => k.hints ?? []).concat(ctx.relays))];
      if (relays.length > 0) {
        const filter: Filter = { kinds: [kind], authors };
        await ctx.pool.fetch(relays, [filter], {
          timeoutMs: ctx.fetchTimeoutMs,
          onevent: (event, relayUrl) => ctx.ingest(event, relayUrl),
        });
      }
      const now = Math.floor(Date.now() / 1000);
      return keys.map((k) => {
        const addr = formatEventAddress(kind, k.pubkey, "");
        const event = ctx.index.getByAddress(addr) ?? null;
        // Record the fetch even when nothing came back: a recent miss must
        // not be retried on every `default` load.
        markFetched(addr, event !== null, now);
        return { event, fresh: true };
      });
    },
    {
      cache: false,
      cacheKeyFn: (k) => `${kind}:${k.pubkey}:${(k.hints ?? []).join(",")}`,
      maxBatchSize: 50,
    },
  );

  return async (pubkey, opts) => {
    const pk = pubkey.toLowerCase();
    const address = formatEventAddress(kind, pk, "");
    const style = opts?.style ?? "default";
    const current = (): Event | null => ctx.index.getByAddress(address) ?? null;

    if (style === "cache-only") return { event: current(), fresh: false };
    if (style === "default") {
      const rec = fetchedAt.get(address);
      const event = current();
      // A fresh record short-circuits the fetch, unless it was a hit whose
      // winner has since been evicted — that would report a stale miss.
      if (rec !== undefined && ctx.isFresh(rec.at) && (!rec.hit || event !== null)) {
        return { event, fresh: false };
      }
    }
    return loader.load({ pubkey: pk, hints: opts?.hints });
  };
}
