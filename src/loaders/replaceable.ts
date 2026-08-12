import type { Event } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { getDTag } from "../core/tag.ts";
import { DataLoader } from "./dataloader.ts";
import type { LoaderContext } from "./context.ts";

export type ReplaceableLoadResult = {
  event: Event | null;
  fresh: boolean;
};

export type LoadStyle = "default" | "force" | "cache-only";

/**
 * Batch-fetch replaceable events (kind + authors) via the pool, with cache.
 * Durable cache is ReplaceableCache; DataLoader only coalesces in-flight requests.
 */
export function createReplaceableLoader(ctx: LoaderContext, kind: number) {
  type Key = { pubkey: string; hints?: string[] };

  const loader = new DataLoader<Key, Event | null, string>(
    async (keys) => {
      const authors = [...new Set(keys.map((k) => k.pubkey))];
      const hintRelays = [...new Set(keys.flatMap((k) => k.hints ?? []).concat(ctx.relays))];
      const filter: Filter = { kinds: [kind], authors };
      const events =
        hintRelays.length > 0
          ? await ctx.pool.fetch(hintRelays, [filter], { timeoutMs: ctx.fetchTimeoutMs })
          : [];

      const best = new Map<string, Event>();
      for (const event of events) {
        if (event.kind !== kind) continue;
        const prev = best.get(event.pubkey);
        if (!prev || prev.created_at < event.created_at) best.set(event.pubkey, event);
      }

      const now = Math.floor(Date.now() / 1000);
      return keys.map((k) => {
        const event = best.get(k.pubkey) ?? null;
        ctx.cache.set(
          { kind, pubkey: k.pubkey, dTag: event ? (getDTag(event.tags) ?? undefined) : undefined },
          event,
          now,
        );
        return event;
      });
    },
    {
      cache: false,
      cacheKeyFn: (k) => `${kind}:${k.pubkey}:${(k.hints ?? []).join(",")}`,
      maxBatchSize: 50,
    },
  );

  return {
    async load(
      pubkey: string,
      opts?: { hints?: string[]; style?: LoadStyle },
    ): Promise<ReplaceableLoadResult> {
      const pk = pubkey.toLowerCase();
      const style = opts?.style ?? "default";
      const cached = ctx.cache.get({ kind, pubkey: pk });

      if (style === "cache-only") {
        return { event: cached?.event ?? null, fresh: false };
      }
      if (style === "default" && cached && ctx.isFresh(cached.fetchedAt)) {
        return { event: cached.event, fresh: false };
      }

      const event = await loader.load({ pubkey: pk, hints: opts?.hints });
      return { event, fresh: true };
    },
    clear(pubkey?: string) {
      if (pubkey) {
        const pk = pubkey.toLowerCase();
        loader.clear({ pubkey: pk });
        ctx.cache.clear({ kind, pubkey: pk });
      } else {
        loader.clearAll();
      }
    },
  };
}
