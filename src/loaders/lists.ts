import type { Event } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import { isHex32, normalizeURL } from "../core/util.ts";
import { parseDmRelayList } from "../nips/nip17.ts";
import type { RelayListItem } from "../nips/nip65.ts";
import { parseRelayList } from "../nips/nip65.ts";
import type { LoadStyle, ReplaceableLoader } from "./replaceable.ts";

/** Result of a list loader: the source event, its decoded items, and freshness. */
export type ListResult<T> = {
  event: Event | null;
  items: T[];
  fresh: boolean;
};

/** One muted entity decoded from a kind:10000 mute list. */
export type MutedEntity =
  | { label: "pubkey"; value: string }
  | { label: "thread"; value: string }
  | { label: "hashtag"; value: string }
  | { label: "word"; value: string };

function fromTags<T>(event: Event | null, map: (tag: readonly string[]) => T | undefined): T[] {
  if (!event) return [];
  const out: T[] = [];
  for (const tag of event.tags) {
    const item = map(tag);
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function createListLoaders(replaceable: (kind: number) => ReplaceableLoader) {
  const followsLoader = replaceable(Kind.Contacts);
  const muteLoader = replaceable(Kind.MuteList);
  const relayListLoader = replaceable(Kind.RelayList);
  const dmRelayListLoader = replaceable(Kind.DirectMessageRelaysList);

  return {
    async follows(
      pubkey: string,
      opts?: { hints?: string[]; style?: LoadStyle },
    ): Promise<ListResult<string>> {
      const { event, fresh } = await followsLoader(pubkey, opts);
      return {
        event,
        fresh,
        items: fromTags(event, (tag) =>
          tag[0] === "p" && tag[1] && isHex32(tag[1].toLowerCase())
            ? tag[1].toLowerCase()
            : undefined,
        ),
      };
    },

    async muteList(
      pubkey: string,
      opts?: { hints?: string[]; style?: LoadStyle },
    ): Promise<ListResult<MutedEntity>> {
      const { event, fresh } = await muteLoader(pubkey, opts);
      return {
        event,
        fresh,
        items: fromTags(event, (tag) => {
          if (!tag[1]) return undefined;
          switch (tag[0]) {
            case "p":
              return isHex32(tag[1].toLowerCase())
                ? { label: "pubkey", value: tag[1].toLowerCase() }
                : undefined;
            case "e":
              return isHex32(tag[1].toLowerCase())
                ? { label: "thread", value: tag[1].toLowerCase() }
                : undefined;
            case "t":
              return { label: "hashtag", value: tag[1] };
            case "word":
              return { label: "word", value: tag[1] };
            default:
              return undefined;
          }
        }),
      };
    },

    async relayList(
      pubkey: string,
      opts?: { hints?: string[]; style?: LoadStyle },
    ): Promise<ListResult<RelayListItem>> {
      const { event, fresh } = await relayListLoader(pubkey, opts);
      let items: RelayListItem[] = [];
      if (event) {
        try {
          items = parseRelayList(event);
        } catch {
          items = [];
        }
      }
      // ensure normalized urls even if parse skipped
      items = items.map((i) => {
        try {
          return { ...i, url: normalizeURL(i.url) };
        } catch {
          return i;
        }
      });
      return { event, fresh, items };
    },

    async dmRelayList(
      pubkey: string,
      opts?: { hints?: string[]; style?: LoadStyle },
    ): Promise<ListResult<string>> {
      const { event, fresh } = await dmRelayListLoader(pubkey, opts);
      let items: string[] = [];
      if (event) {
        try {
          items = parseDmRelayList(event);
        } catch {
          items = [];
        }
      }
      return { event, fresh, items };
    },
  };
}

export type ListLoaders = ReturnType<typeof createListLoaders>;
