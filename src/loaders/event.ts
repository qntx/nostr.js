import type { Event } from "../core/event.ts";
import { isHex32 } from "../core/util.ts";
import { decode, Nip19Error, type AddressPointer, type EventPointer } from "../nips/nip19.ts";
import type { LoaderContext } from "./context.ts";
import { DataLoader } from "./dataloader.ts";

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
  type Key = { ref: EventRef; parsed: ReturnType<typeof parseRef> };

  const loader = new DataLoader<Key, Event | undefined, string>(
    async (keys) => {
      // group by identical filter shape is hard; fetch per key for v0 simplicity,
      // still coalesces identical cache keys via DataLoader.
      const out: Array<Event | undefined> = [];
      for (const key of keys) {
        const relays = [...new Set([...key.parsed.hints, ...ctx.relays])];
        if (relays.length === 0) {
          out.push(undefined);
          continue;
        }
        const events = await ctx.pool.fetch(relays, [key.parsed.filter], {
          timeoutMs: ctx.fetchTimeoutMs,
        });
        // newest first already from sort in pool? pool doesn't sort; pick first match
        let best: Event | undefined;
        for (const e of events) {
          if (!best || e.created_at > best.created_at) best = e;
        }
        out.push(best);
      }
      return out;
    },
    { cacheKeyFn: (k) => k.parsed.cacheKey },
  );

  return {
    load(ref: EventRef): Promise<Event | undefined> {
      const parsed = parseRef(ref);
      return loader.load({ ref, parsed });
    },
    clearAll() {
      loader.clearAll();
    },
  };
}

export type EventLoader = ReturnType<typeof createEventLoader>;
