import type { Event } from "../core/event.ts";
import { isAddressableKind } from "../core/kind.ts";
import { formatEventAddress } from "../core/tag.ts";
import { isHex32 } from "../core/util.ts";
import { decode, Nip19Error, type AddressPointer, type EventPointer } from "../nips/nip19.ts";
import type { LoaderContext } from "./context.ts";

export type EventRef = string | EventPointer | AddressPointer;

type ParsedRef = {
  filter: { ids?: string[]; authors?: string[]; kinds?: number[]; "#d"?: string[] };
  hints: string[];
  /** Resolve the fetched event from the index after the network round. */
  lookup: (ctx: LoaderContext) => Event | undefined;
  cacheKey: string;
};

function dFilter(kind: number, identifier: string): { "#d"?: string[] } {
  if (isAddressableKind(kind)) return { "#d": [identifier] };
  return {};
}

function addressRef(kind: number, pubkey: string, identifier: string): string {
  return formatEventAddress(kind, pubkey.toLowerCase(), identifier);
}

function parseRef(ref: EventRef): ParsedRef {
  if (typeof ref === "string") {
    if (isHex32(ref.toLowerCase())) {
      const id = ref.toLowerCase();
      return {
        filter: { ids: [id] },
        hints: [],
        lookup: (ctx) => ctx.index.get(id),
        cacheKey: `id:${id}`,
      };
    }
    const decoded = decode(ref);
    switch (decoded.type) {
      case "note":
        return {
          filter: { ids: [decoded.data] },
          hints: [],
          lookup: (ctx) => ctx.index.get(decoded.data),
          cacheKey: `id:${decoded.data}`,
        };
      case "nevent":
        return {
          filter: { ids: [decoded.data.id] },
          hints: decoded.data.relays ?? [],
          lookup: (ctx) => ctx.index.get(decoded.data.id),
          cacheKey: `id:${decoded.data.id}`,
        };
      case "naddr": {
        const addr = addressRef(decoded.data.kind, decoded.data.pubkey, decoded.data.identifier);
        return {
          filter: {
            authors: [decoded.data.pubkey.toLowerCase()],
            kinds: [decoded.data.kind],
            ...dFilter(decoded.data.kind, decoded.data.identifier),
          },
          hints: decoded.data.relays ?? [],
          lookup: (ctx) => ctx.index.getByAddress(addr),
          cacheKey: `addr:${addr}`,
        };
      }
      default:
        throw new Nip19Error(`cannot load event from ${decoded.type}`);
    }
  }
  if ("id" in ref) {
    const id = ref.id.toLowerCase();
    return {
      filter: { ids: [id] },
      hints: ref.relays ?? [],
      lookup: (ctx) => ctx.index.get(id),
      cacheKey: `id:${id}`,
    };
  }
  const addr = addressRef(ref.kind, ref.pubkey, ref.identifier);
  return {
    filter: {
      authors: [ref.pubkey.toLowerCase()],
      kinds: [ref.kind],
      ...dFilter(ref.kind, ref.identifier),
    },
    hints: ref.relays ?? [],
    lookup: (ctx) => ctx.index.getByAddress(addr),
    cacheKey: `addr:${addr}`,
  };
}

/**
 * Resolve an event reference (hex id, note, nevent, naddr, or pointer object)
 * through the reactive index, fetching from relays on a miss. The index is
 * the durable store — the loader keeps only in-flight coalescing, so a miss
 * never blocks a later retry.
 */
export function createEventLoader(ctx: LoaderContext) {
  const inflight = new Map<string, Promise<Event | undefined>>();
  return {
    load(ref: EventRef): Promise<Event | undefined> {
      const parsed = parseRef(ref);
      const hit = parsed.lookup(ctx);
      if (hit !== undefined) return Promise.resolve(hit);
      const pending = inflight.get(parsed.cacheKey);
      if (pending) return pending;
      const p = (async () => {
        const relays = [...new Set([...parsed.hints, ...ctx.relays])];
        if (relays.length === 0) return undefined;
        await ctx.pool.fetch(relays, [parsed.filter], {
          timeoutMs: ctx.fetchTimeoutMs,
          onevent: (event, relayUrl) => ctx.ingest(event, relayUrl),
        });
        return parsed.lookup(ctx);
      })().finally(() => inflight.delete(parsed.cacheKey));
      inflight.set(parsed.cacheKey, p);
      return p;
    },
  };
}

export type EventLoader = ReturnType<typeof createEventLoader>;
