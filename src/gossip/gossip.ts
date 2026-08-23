import type { Event } from "../core/event.ts";
import { isReplaceableWinner } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { Kind } from "../core/kind.ts";
import { parseDmRelayList } from "../nips/nip17.ts";
import { parseRelayList, type RelayListItem } from "../nips/nip65.ts";
import { normalizeURL } from "../core/util.ts";

export type PubkeyRoutes = {
  /** Relays the user writes to (outbox). NIP-65. */
  write: string[];
  /** Relays the user reads from (inbox). NIP-65. */
  read: string[];
  /** Relays for NIP-17 gift-wrap delivery. Kind 10050. */
  dm: string[];
  /** `created_at` of the last accepted kind:10002 list. */
  updatedAt: number;
  /** `created_at` of the last accepted kind:10050 list. */
  dmUpdatedAt: number;
  /** Event id of the last accepted kind:10002 (NIP-01 equal-timestamp tie-break). */
  relayListId?: string;
  /** Event id of the last accepted kind:10050. */
  dmListId?: string;
};

export type BrokenDownFilters =
  | { type: "per-relay"; filters: Map<string, Filter> }
  | { type: "orphan"; filter: Filter }
  | { type: "generic"; filter: Filter };

export type GossipOptions = {
  /** Max relays to keep per direction when ranking. Default 4. */
  maxRelaysPerPubkey?: number;
};

function emptyRoutes(): PubkeyRoutes {
  return {
    write: [],
    read: [],
    dm: [],
    updatedAt: 0,
    dmUpdatedAt: 0,
  };
}

/**
 * Routing table for NIP-65 (10002) and NIP-17 DM relays (10050).
 * Ingest replaceable list events, then break filters into per-relay REQs.
 */
export class Gossip {
  readonly #routes = new Map<string, PubkeyRoutes>();
  readonly #maxRelays: number;

  constructor(opts: GossipOptions = {}) {
    this.#maxRelays = opts.maxRelaysPerPubkey ?? 4;
  }

  /**
   * Ingest a routing list event.
   * - kind:10002 → write/read (NIP-65)
   * - kind:10050 → dm (NIP-17)
   * Returns true if routes for that list type were updated.
   */
  ingest(event: Event): boolean {
    if (event.kind === Kind.RelayList) {
      let items: RelayListItem[];
      try {
        items = parseRelayList(event);
      } catch {
        return false;
      }
      return this.setRoutes(event.pubkey, items, event.created_at, event.id);
    }
    if (event.kind === Kind.DirectMessageRelaysList) {
      let relays: string[];
      try {
        relays = parseDmRelayList(event);
      } catch {
        return false;
      }
      return this.setDmRoutes(event.pubkey, relays, event.created_at, event.id);
    }
    return false;
  }

  setRoutes(
    pubkey: string,
    items: RelayListItem[],
    updatedAt = Math.floor(Date.now() / 1000),
    eventId?: string,
  ): boolean {
    const pk = pubkey.toLowerCase();
    const prev = this.#routes.get(pk) ?? emptyRoutes();
    if (prev.updatedAt > updatedAt) return false;
    if (
      eventId &&
      prev.relayListId &&
      prev.updatedAt === updatedAt &&
      !isReplaceableWinner(
        { created_at: updatedAt, id: eventId },
        { created_at: prev.updatedAt, id: prev.relayListId },
      )
    ) {
      return false;
    }

    const write: string[] = [];
    const read: string[] = [];
    for (const item of items) {
      let url: string;
      try {
        url = normalizeURL(item.url);
      } catch {
        continue;
      }
      if (item.write && !write.includes(url)) write.push(url);
      if (item.read && !read.includes(url)) read.push(url);
    }

    this.#routes.set(pk, {
      write: write.slice(0, this.#maxRelays),
      read: read.slice(0, this.#maxRelays),
      dm: prev.dm,
      updatedAt,
      dmUpdatedAt: prev.dmUpdatedAt,
      relayListId: eventId ?? prev.relayListId,
      dmListId: prev.dmListId,
    });
    return true;
  }

  setDmRoutes(
    pubkey: string,
    relays: readonly string[],
    updatedAt = Math.floor(Date.now() / 1000),
    eventId?: string,
  ): boolean {
    const pk = pubkey.toLowerCase();
    const prev = this.#routes.get(pk) ?? emptyRoutes();
    if (prev.dmUpdatedAt > updatedAt) return false;
    if (
      eventId &&
      prev.dmListId &&
      prev.dmUpdatedAt === updatedAt &&
      !isReplaceableWinner(
        { created_at: updatedAt, id: eventId },
        { created_at: prev.dmUpdatedAt, id: prev.dmListId },
      )
    ) {
      return false;
    }

    const dm: string[] = [];
    for (const raw of relays) {
      let url: string;
      try {
        url = normalizeURL(raw);
      } catch {
        continue;
      }
      if (!dm.includes(url)) dm.push(url);
    }

    this.#routes.set(pk, {
      write: prev.write,
      read: prev.read,
      dm: dm.slice(0, this.#maxRelays),
      updatedAt: prev.updatedAt,
      dmUpdatedAt: updatedAt,
      relayListId: prev.relayListId,
      dmListId: eventId ?? prev.dmListId,
    });
    return true;
  }

  getRoutes(pubkey: string): PubkeyRoutes | undefined {
    return this.#routes.get(pubkey.toLowerCase());
  }

  outboxRelays(pubkey: string): string[] {
    return this.#routes.get(pubkey.toLowerCase())?.write ?? [];
  }

  inboxRelays(pubkey: string): string[] {
    return this.#routes.get(pubkey.toLowerCase())?.read ?? [];
  }

  /** NIP-17 kind:10050 delivery relays for gift-wraps. */
  dmRelays(pubkey: string): string[] {
    return this.#routes.get(pubkey.toLowerCase())?.dm ?? [];
  }

  clear(pubkey?: string): void {
    if (pubkey) this.#routes.delete(pubkey.toLowerCase());
    else this.#routes.clear();
  }

  get size(): number {
    return this.#routes.size;
  }

  /**
   * Break a user-facing filter into per-relay sub-filters.
   * - authors → outbox relays, filter narrowed per relay's authors
   * - #p only → inbox relays of those pubkeys
   * - neither → generic (caller uses default pool)
   * - authors known but no routes → orphan
   */
  breakDownFilter(filter: Filter): BrokenDownFilters {
    const authors = filter.authors?.map((a) => a.toLowerCase());
    const pTags = filter["#p"]?.map((p) => p.toLowerCase());

    if ((!authors || authors.length === 0) && (!pTags || pTags.length === 0)) {
      return { type: "generic", filter };
    }

    if (authors && authors.length > 0 && (!pTags || pTags.length === 0)) {
      return this.#breakAuthors(filter, authors, "write");
    }

    if (pTags && pTags.length > 0 && (!authors || authors.length === 0)) {
      return this.#breakAuthors(
        { ...filter, authors: undefined },
        pTags,
        "read",
        (base, pubkeys) => ({ ...base, "#p": pubkeys }),
      );
    }

    // both authors and #p: send full filter to union of routes
    const unionKeys = new Set([...(authors ?? []), ...(pTags ?? [])]);
    const relays = new Set<string>();
    for (const pk of unionKeys) {
      const r = this.#routes.get(pk);
      if (!r) continue;
      for (const u of r.write) relays.add(u);
      for (const u of r.read) relays.add(u);
    }
    if (relays.size === 0) return { type: "orphan", filter };
    const map = new Map<string, Filter>();
    for (const url of relays) map.set(url, { ...filter });
    return { type: "per-relay", filters: map };
  }

  #breakAuthors(
    filter: Filter,
    pubkeys: string[],
    direction: "read" | "write",
    narrow: (base: Filter, pubkeys: string[]) => Filter = (base, pks) => ({
      ...base,
      authors: pks,
    }),
  ): BrokenDownFilters {
    const perRelay = new Map<string, string[]>();
    let anyRoute = false;

    for (const pk of pubkeys) {
      const routes = this.#routes.get(pk);
      const urls = direction === "write" ? routes?.write : routes?.read;
      if (!urls || urls.length === 0) continue;
      anyRoute = true;
      for (const url of urls) {
        const list = perRelay.get(url) ?? [];
        list.push(pk);
        perRelay.set(url, list);
      }
    }

    if (!anyRoute) return { type: "orphan", filter };

    const map = new Map<string, Filter>();
    for (const [url, pks] of perRelay) {
      map.set(url, narrow(filter, pks));
    }
    return { type: "per-relay", filters: map };
  }
}
