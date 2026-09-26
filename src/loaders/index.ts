import type { Event } from "../core/event.ts";
import type { Pool } from "../relay/pool.ts";
import type { ReactiveEventStore } from "../store/reactive.ts";
import { LoaderContext } from "./context.ts";
import { createEventLoader } from "./event.ts";
import { createListLoaders } from "./lists.ts";
import { createProfileLoader } from "./profile.ts";
import { createReplaceableLoader, type ReplaceableLoader } from "./replaceable.ts";

export {
  type LoadStyle,
  type ReplaceableLoader,
  type ReplaceableLoadResult,
} from "./replaceable.ts";
export { type ListResult, type ListLoaders, type MutedEntity } from "./lists.ts";
export { bareNostrUser, type NostrUser, type ProfileLoader } from "./profile.ts";
export { type EventLoader, type EventRef } from "./event.ts";
export {
  OutboxError,
  OutboxFeed,
  createOutboxFeed,
  groupAuthorsByOutboxRelay,
  type OutboxBound,
  type OutboxFeedOptions,
} from "./outbox.ts";

import type { ListLoaders } from "./lists.ts";
import type { ProfileLoader } from "./profile.ts";
import type { EventLoader } from "./event.ts";

/** The loader surface returned by {@link createLoaders}. */
export type Loaders = {
  follows: ListLoaders["follows"];
  muteList: ListLoaders["muteList"];
  relayList: ListLoaders["relayList"];
  dmRelayList: ListLoaders["dmRelayList"];
  profile: ProfileLoader["load"];
  event: EventLoader["load"];
  /** Generic replaceable loader for any kind; memoized per kind. */
  replaceable: (kind: number) => ReplaceableLoader;
  addRelay(url: string): void;
  removeRelay(url: string): void;
};

/** Options for {@link createLoaders}. */
export type CreateLoadersOptions = {
  pool: Pool;
  relays: readonly string[];
  /** The reactive index loaders read from and feed fetched events into. */
  index: ReactiveEventStore;
  /**
   * Inbound-event sink for fetched events; defaults to `index.add`. Client
   * wires its single ingest path so loader fetches get gossip meta and
   * persistence like every other inbound event.
   */
  ingest?: (event: Event, relayUrl: string) => void;
  staleAfterSec?: number;
  fetchTimeoutMs?: number;
};

/** Build an instance-scoped loader suite (no module globals). */
export function createLoaders(opts: CreateLoadersOptions): Loaders {
  const context = new LoaderContext(opts);
  const byKind = new Map<number, ReplaceableLoader>();
  const replaceable = (kind: number): ReplaceableLoader => {
    let loader = byKind.get(kind);
    if (loader === undefined) {
      loader = createReplaceableLoader(context, kind);
      byKind.set(kind, loader);
    }
    return loader;
  };
  const lists = createListLoaders(replaceable);
  const profile = createProfileLoader(replaceable);
  const event = createEventLoader(context);
  return {
    follows: (pubkey, o) => lists.follows(pubkey, o),
    muteList: (pubkey, o) => lists.muteList(pubkey, o),
    relayList: (pubkey, o) => lists.relayList(pubkey, o),
    dmRelayList: (pubkey, o) => lists.dmRelayList(pubkey, o),
    profile: (pubkey, o) => profile.load(pubkey, o),
    event: (ref) => event.load(ref),
    replaceable,
    addRelay: (url) => context.addRelay(url),
    removeRelay: (url) => context.removeRelay(url),
  };
}
