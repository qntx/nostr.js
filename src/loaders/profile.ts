import type { Event } from "../core/event.ts";
import type { ProfileMetadata } from "../core/builder.ts";
import { Kind } from "../core/kind.ts";
import { npubEncode } from "../nips/nip19.ts";
import type { LoaderContext } from "./context.ts";
import { createReplaceableLoader, type LoadStyle } from "./replaceable.ts";

export type NostrUser = {
  pubkey: string;
  npub: string;
  shortName: string;
  image?: string;
  metadata: ProfileMetadata;
  lastUpdated: number;
  event: Event | null;
  fresh: boolean;
};

export function bareNostrUser(pubkey: string): NostrUser {
  const pk = pubkey.toLowerCase();
  let npub: string;
  try {
    npub = npubEncode(pk);
  } catch {
    npub = pk;
  }
  return {
    pubkey: pk,
    npub,
    shortName: npub.startsWith("npub1") ? `${npub.slice(0, 8)}…${npub.slice(-4)}` : pk.slice(0, 8),
    metadata: {},
    lastUpdated: 0,
    event: null,
    fresh: false,
  };
}

function parseMetadata(content: string): ProfileMetadata {
  try {
    const obj = JSON.parse(content) as ProfileMetadata;
    return typeof obj === "object" && obj !== null ? obj : {};
  } catch {
    return {};
  }
}

export function createProfileLoader(ctx: LoaderContext) {
  const loader = createReplaceableLoader(ctx, Kind.Metadata);

  return {
    async load(pubkey: string, opts?: { hints?: string[]; style?: LoadStyle }): Promise<NostrUser> {
      const base = bareNostrUser(pubkey);
      const { event, fresh } = await loader.load(pubkey, opts);
      if (!event) return { ...base, fresh };

      const metadata = parseMetadata(event.content);
      const display = metadata.display_name || metadata.name;
      return {
        ...base,
        shortName: display || base.shortName,
        image: metadata.picture,
        metadata,
        lastUpdated: event.created_at,
        event,
        fresh,
      };
    },
  };
}

export type ProfileLoader = ReturnType<typeof createProfileLoader>;
