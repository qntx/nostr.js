/**
 * NIP-10: Text Notes and Threads
 * @see https://github.com/nostr-protocol/nips/blob/master/10.md
 */
import { EventBuilder } from "../core/builder.ts";
import type { Event } from "../core/event.ts";
import type { Tag } from "../core/tag.ts";
import { isHex32 } from "../core/util.ts";
import type { EventPointer, ProfilePointer } from "./nip19.ts";

export type ThreadReferences = {
  /** Pointer to the root of the thread. */
  root: EventPointer | undefined;
  /** Pointer to the parent event this note replies to. */
  reply: EventPointer | undefined;
  /** Other e-tagged events (not root/reply). */
  mentions: EventPointer[];
  /** Quoted events (`q` tags). */
  quotes: EventPointer[];
  /** p-tagged profiles involved in the thread. */
  profiles: ProfilePointer[];
};

function eventPointerFromETag(tag: readonly string[]): EventPointer | undefined {
  if (tag[0] !== "e" || !tag[1] || !isHex32(tag[1])) return undefined;
  // NIP-10 5-tuple pubkey is index 4; NIP-01 4-tuple pubkey is index 3.
  const author =
    tag[4] && isHex32(tag[4])
      ? tag[4].toLowerCase()
      : tag[3] && isHex32(tag[3])
        ? tag[3].toLowerCase()
        : undefined;
  return {
    id: tag[1].toLowerCase(),
    relays: tag[2] ? [tag[2]] : [],
    author,
  };
}

/**
 * Parse NIP-10 thread markers and legacy positional e-tags from an event.
 */
export function parseThreadTags(event: Pick<Event, "tags">): ThreadReferences {
  const result: ThreadReferences = {
    root: undefined,
    reply: undefined,
    mentions: [],
    quotes: [],
    profiles: [],
  };

  let maybeParent: EventPointer | undefined;
  let maybeRoot: EventPointer | undefined;

  for (let i = event.tags.length - 1; i >= 0; i--) {
    const tag = event.tags[i]!;

    if (tag[0] === "e" && tag[1] && isHex32(tag[1])) {
      const pointer = eventPointerFromETag(tag)!;
      const marker = tag[3];

      if (marker === "root") {
        result.root = pointer;
        continue;
      }
      if (marker === "reply") {
        result.reply = pointer;
        continue;
      }
      // Preferred markers are root/reply only. A hex32 at index 3 is NIP-01 pubkey, not a marker.
      if (marker && !isHex32(marker)) {
        result.mentions.push(pointer);
        continue;
      }

      // Legacy positional: last unmarked is parent, second-to-last is root.
      if (!maybeParent) maybeParent = pointer;
      else maybeRoot = pointer;
      result.mentions.push(pointer);
      continue;
    }

    if (tag[0] === "q" && tag[1] && isHex32(tag[1])) {
      result.quotes.push({
        id: tag[1].toLowerCase(),
        relays: tag[2] ? [tag[2]] : [],
      });
      continue;
    }

    if (tag[0] === "p" && tag[1] && isHex32(tag[1])) {
      result.profiles.push({
        pubkey: tag[1].toLowerCase(),
        relays: tag[2] ? [tag[2]] : [],
      });
    }
  }

  if (!result.root) {
    result.root = maybeRoot ?? maybeParent ?? result.reply;
  }
  if (!result.reply) {
    result.reply = maybeParent ?? result.root;
  }

  // Drop root/reply from mentions (by id).
  const drop = new Set(
    [result.root?.id, result.reply?.id].filter((id): id is string => Boolean(id)),
  );
  result.mentions = result.mentions.filter((m) => !drop.has(m.id));

  // Inherit relay hints from matching p-tags.
  for (const ref of [result.reply, result.root, ...result.mentions]) {
    if (!ref?.author) continue;
    const author = result.profiles.find((p) => p.pubkey === ref.author);
    if (!author?.relays?.length) continue;
    const relays = [...(ref.relays ?? [])];
    for (const url of author.relays) {
      if (!relays.includes(url)) relays.push(url);
    }
    ref.relays = relays;
  }

  return result;
}

export type ReplyTagsOptions = {
  /** Parent event being replied to. */
  parent: Pick<Event, "id" | "pubkey" | "tags">;
  /** Optional relay hint for the parent e-tag. */
  relayHint?: string;
  /** Quoted event ids (`q` tags). */
  quoteIds?: string[];
};

/**
 * Build NIP-10 e/p tags for a reply to `parent`.
 * Uses marked tags (`root` / `reply`) per preferred modern style.
 */
export function buildReplyTags(opts: ReplyTagsOptions): Tag[] {
  const thread = parseThreadTags(opts.parent);
  const root = thread.root ?? { id: opts.parent.id, relays: [], author: opts.parent.pubkey };
  const parentIsRoot = root.id === opts.parent.id;

  const tags: Tag[] = [];
  const rootRelay = root.relays?.[0] ?? opts.relayHint ?? "";
  tags.push(
    ["e", root.id, rootRelay, "root", root.author ?? opts.parent.pubkey].filter(
      (x, i) => i < 4 || Boolean(x),
    ) as unknown as Tag,
  );

  if (!parentIsRoot) {
    tags.push(
      ["e", opts.parent.id, opts.relayHint ?? "", "reply", opts.parent.pubkey].filter(
        (x, i) => i < 4 || Boolean(x),
      ) as unknown as Tag,
    );
  }

  // Ensure root + parent authors are p-tagged.
  const pSeen = new Set<string>();
  const addP = (pk: string, relay?: string) => {
    const key = pk.toLowerCase();
    if (pSeen.has(key)) return;
    pSeen.add(key);
    tags.push(relay ? (["p", key, relay] as Tag) : (["p", key] as Tag));
  };
  if (root.author) addP(root.author, root.relays?.[0]);
  addP(opts.parent.pubkey, opts.relayHint);
  for (const p of thread.profiles) addP(p.pubkey, p.relays?.[0]);

  for (const id of opts.quoteIds ?? []) {
    if (isHex32(id)) tags.push(["q", id.toLowerCase()] as Tag);
  }

  return tags;
}

/** Convenience: e-tag with optional NIP-10 marker (`root` / `reply`). */
export function eTag(
  id: string,
  opts?: { relay?: string; marker?: "root" | "reply"; author?: string },
): Tag {
  const t: string[] = ["e", id.toLowerCase()];
  if (opts?.relay !== undefined || opts?.marker || opts?.author) {
    t.push(opts?.relay ?? "");
  }
  if (opts?.marker !== undefined || opts?.author) {
    t.push(opts?.marker ?? "");
  }
  if (opts?.author) t.push(opts.author.toLowerCase());
  return t as unknown as Tag;
}

/**
 * Build an {@link EventBuilder} reply with NIP-10 tags.
 * Lives here (not on EventBuilder) so core does not depend on nips.
 */
export function replyTo(
  parent: Pick<Event, "id" | "pubkey" | "tags">,
  content: string,
  opts?: { relayHint?: string; quoteIds?: string[] },
): EventBuilder {
  return EventBuilder.textNote(content).tags(
    buildReplyTags({
      parent,
      relayHint: opts?.relayHint,
      quoteIds: opts?.quoteIds,
    }),
  );
}
