import type { Pool } from "../relay/pool.ts";
import { LoaderContext } from "./context.ts";
import { createEventLoader } from "./event.ts";
import { createListLoaders } from "./lists.ts";
import { createProfileLoader } from "./profile.ts";
import type { ReplaceableCache } from "./cache.ts";

export { DataLoader } from "./dataloader.ts";
export { ReplaceableCache } from "./cache.ts";
export { LoaderContext, type LoaderContextOptions } from "./context.ts";
export {
  createReplaceableLoader,
  type LoadStyle,
  type ReplaceableLoadResult,
} from "./replaceable.ts";
export { createListLoaders, type ListResult, type ListLoaders, type MutedEntity } from "./lists.ts";
export {
  createProfileLoader,
  bareNostrUser,
  type NostrUser,
  type ProfileLoader,
} from "./profile.ts";
export { createEventLoader, type EventLoader, type EventRef } from "./event.ts";
export {
  OutboxFeed,
  createOutboxFeed,
  groupAuthorsByOutboxRelay,
  type OutboxBound,
  type OutboxFeedOptions,
} from "./outbox.ts";

import type { ListLoaders } from "./lists.ts";
import type { ProfileLoader } from "./profile.ts";
import type { EventLoader } from "./event.ts";

export type Loaders = {
  context: LoaderContext;
  follows: ListLoaders["follows"];
  muteList: ListLoaders["muteList"];
  relayList: ListLoaders["relayList"];
  dmRelayList: ListLoaders["dmRelayList"];
  profile: ProfileLoader["load"];
  event: EventLoader["load"];
};

export type CreateLoadersOptions = {
  pool: Pool;
  relays: readonly string[];
  cache?: ReplaceableCache;
  staleAfterSec?: number;
  fetchTimeoutMs?: number;
};

/** Build an instance-scoped loader suite (no module globals). */
export function createLoaders(opts: CreateLoadersOptions): Loaders {
  const context = new LoaderContext(opts);
  const lists = createListLoaders(context);
  const profile = createProfileLoader(context);
  const event = createEventLoader(context);
  return {
    context,
    follows: (pubkey, o) => lists.follows(pubkey, o),
    muteList: (pubkey, o) => lists.muteList(pubkey, o),
    relayList: (pubkey, o) => lists.relayList(pubkey, o),
    dmRelayList: (pubkey, o) => lists.dmRelayList(pubkey, o),
    profile: (pubkey, o) => profile.load(pubkey, o),
    event: (ref) => event.load(ref),
  };
}
