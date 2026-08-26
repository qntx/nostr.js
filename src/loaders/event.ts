import type { Event } from "../core/event.ts";
import { isHex32 } from "../core/util.ts";
import { decode, Nip19Error, type AddressPointer, type EventPointer } from "../nips/nip19.ts";
import type { LoaderContext } from "./context.ts";

export type EventRef = string | EventPointer | AddressPointer;

function parseRef(ref: EventRef): {
  filter: { ids?: string[]; authors?: string[]; kinds?: number[]; "#d"?: string[] };
  hints: string[];
  cacheKey: string;
} {
  if (typeof ref === "string") {
    if (isHex32(ref)) {
      return {
        filter: { ids: [ref.toLowerCase()] },
        hints: [],
        cacheKey: `id:${ref.toLowerCase()}`,
      };
    }
    const decoded = decode(ref);
    switch (decoded.type) {
      case "note":
        return { filter: { ids: [decoded.data] }, hints: [], cacheKey: `id:${decoded.data}` };
      case "nevent":
        return {
          filter: { ids: [decoded.data.id] },
          hints: decoded.data.relays ?? [],
          cacheKey: `id:${decoded.data.id}`,
        };
      case "naddr":
        return {
          filter: {
            authors: [decoded.data.pubkey],
            kinds: [decoded.data.kind],
            "#d": decoded.data.identifier ? [decoded.data.identifier] : undefined,
          },
          hints: decoded.data.relays ?? [],
          cacheKey: `addr:${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`,
        };
      default:
        throw new Nip19Error(`cannot load event from ${decoded.type}`);
    }
  }
  if ("id" in ref) {
    return {
      filter: { ids: [ref.id.toLowerCase()] },
      hints: ref.relays ?? [],
      cacheKey: `id:${ref.id.toLowerCase()}`,
    };
  }
  return {
    filter: {
      authors: [ref.pubkey.toLowerCase()],
      kinds: [ref.kind],
      "#d": ref.identifier ? [ref.identifier] : undefined,
    },
    hints: ref.relays ?? [],
    cacheKey: `addr:${ref.kind}:${ref.pubkey}:${ref.identifier}`,
  };
}

export function createEventLoader(ctx: LoaderContext) {
  const inflight = new Map<string, Promise<Event | undefined>>();
  const cache = new Map<string, Event | undefined>();
  return {
    load(ref: EventRef): Promise<Event | undefined> {
      const parsed = parseRef(ref);
      if (cache.has(parsed.cacheKey)) return Promise.resolve(cache.get(parsed.cacheKey));
      const hit = inflight.get(parsed.cacheKey);
      if (hit) return hit;
      const p = (async () => {
        const relays = [...new Set([...parsed.hints, ...ctx.relays])];
        if (relays.length === 0) return undefined;
        const events = await ctx.pool.fetch(relays, [parsed.filter], {
          timeoutMs: ctx.fetchTimeoutMs,
        });
        let best: Event | undefined;
        for (const e of events) if (!best || e.created_at > best.created_at) best = e;
        cache.set(parsed.cacheKey, best);
        return best;
      })().finally(() => inflight.delete(parsed.cacheKey));
      inflight.set(parsed.cacheKey, p);
      return p;
    },
    clearAll() {
      inflight.clear();
      cache.clear();
    },
  };
}

export type EventLoader = ReturnType<typeof createEventLoader>;
