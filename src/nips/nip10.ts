/**
 * NIP-10: Text Notes and Threads
 * @see https://github.com/nostr-protocol/nips/blob/master/10.md
 */
import { EventBuilder } from "../core/builder.ts";
import { EventValidationError } from "../core/error.ts";
import type { Event } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import { formatEventAddress, parseEventAddress, type Tag } from "../core/tag.ts";
import { isHex32 } from "../core/util.ts";
import type { AddressPointer, EventPointer, ProfilePointer } from "./nip19.ts";

export type ThreadReferences = {
  /** Pointer to the root of the thread. */
  root: EventPointer | undefined;
  /** Pointer to the parent event this note replies to. */
  reply: EventPointer | undefined;
  /** Other e-tagged events (not root/reply). */
  mentions: EventPointer[];
  /** Quoted events (`q` tags): event ids or addresses. Discriminate with `"id" in q`. */
  quotes: Array<EventPointer | AddressPointer>;
  /** p-tagged profiles involved in the thread. */
  profiles: ProfilePointer[];
};

type ReplyParent = Pick<Event, "id" | "pubkey" | "tags" | "kind">;
type QuoteInput = string | EventPointer | AddressPointer;

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

function quoteFromQTag(tag: readonly string[]): EventPointer | AddressPointer | undefined {
  if (tag[0] !== "q" || !tag[1]) return undefined;
  if (isHex32(tag[1])) {
    const pointer: EventPointer = {
      id: tag[1].toLowerCase(),
      relays: tag[2] ? [tag[2]] : [],
    };
    if (tag[3] && isHex32(tag[3])) pointer.author = tag[3].toLowerCase();
    return pointer;
  }
  const addr = parseEventAddress(tag[1]);
  if (!addr) return undefined;
  // Address q tags do not use the event-id pubkey slot (index 3).
  return {
    identifier: addr.identifier,
    pubkey: addr.pubkey,
    kind: addr.kind,
    relays: tag[2] ? [tag[2]] : [],
  };
}

function quoteToTag(quote: QuoteInput): { tag: Tag; author?: string; relay?: string } | undefined {
  if (typeof quote === "string") {
    if (isHex32(quote)) return { tag: ["q", quote.toLowerCase()] };
    const addr = parseEventAddress(quote);
    if (!addr) return undefined;
    return { tag: ["q", formatEventAddress(addr.kind, addr.pubkey, addr.identifier)] };
  }
  if ("id" in quote) {
    const id = quote.id.toLowerCase();
    const relay = quote.relays?.[0];
    const author = quote.author && isHex32(quote.author) ? quote.author.toLowerCase() : undefined;
    const tag: Tag =
      author !== undefined ? ["q", id, relay ?? "", author] : relay ? ["q", id, relay] : ["q", id];
    return { tag, author, relay: relay || undefined };
  }
  const coord = formatEventAddress(quote.kind, quote.pubkey, quote.identifier);
  const relay = quote.relays?.[0];
  const tag: Tag = relay ? ["q", coord, relay] : ["q", coord];
  return { tag, author: quote.pubkey, relay: relay || undefined };
}

function assertKind1Parent(parent: ReplyParent): void {
  // NIP-10 is kind 1 only; comments are NIP-22.
  if (parent.kind !== Kind.TextNote) {
    throw new EventValidationError("NIP-10 replyTo is for kind 1");
  }
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

    if (tag[0] === "q") {
      const quote = quoteFromQTag(tag);
      if (quote) result.quotes.push(quote);
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
  parent: ReplyParent;
  /** Optional relay hint for the parent e-tag. */
  relayHint?: string;
  /** Quoted events (`q` tags): hex ids, `kind:pubkey:d` coords, or pointers. */
  quotes?: QuoteInput[];
};

/**
 * Build NIP-10 e/p tags for a reply to `parent`.
 * Uses marked tags (`root` / `reply`) per preferred modern style.
 */
export function buildReplyTags(opts: ReplyTagsOptions): Tag[] {
  assertKind1Parent(opts.parent);
  const thread = parseThreadTags(opts.parent);
  const root = thread.root ?? { id: opts.parent.id, relays: [], author: opts.parent.pubkey };
  const parentIsRoot = root.id === opts.parent.id;

  const tags: Tag[] = [];
  const rootRelay = root.relays?.[0] ?? opts.relayHint ?? "";
  tags.push(
    ["e", root.id, rootRelay, "root", root.author ?? opts.parent.pubkey].filter(
      (x, i) => i < 4 || Boolean(x),
    ),
  );

  if (!parentIsRoot) {
    tags.push(
      ["e", opts.parent.id, opts.relayHint ?? "", "reply", opts.parent.pubkey].filter(
        (x, i) => i < 4 || Boolean(x),
      ),
    );
  }

  // Ensure root + parent authors are p-tagged.
  const pSeen = new Set<string>();
  const addP = (pk: string, relay?: string) => {
    const key = pk.toLowerCase();
    if (pSeen.has(key)) return;
    pSeen.add(key);
    tags.push(relay ? ["p", key, relay] : ["p", key]);
  };
  if (root.author) addP(root.author, root.relays?.[0]);
  addP(opts.parent.pubkey, opts.relayHint);
  for (const p of thread.profiles) addP(p.pubkey, p.relays?.[0]);

  const qTags: Tag[] = [];
  for (const quote of opts.quotes ?? []) {
    const built = quoteToTag(quote);
    if (!built) continue;
    if (built.author) addP(built.author, built.relay);
    qTags.push(built.tag);
  }
  tags.push(...qTags);

  return tags;
}

/**
 * Build an {@link EventBuilder} reply with NIP-10 tags.
 * Lives here (not on EventBuilder) so core does not depend on nips.
 */
export function replyTo(
  parent: ReplyParent,
  content: string,
  opts?: Pick<ReplyTagsOptions, "relayHint" | "quotes">,
): EventBuilder {
  return EventBuilder.textNote(content).tags(
    buildReplyTags({
      parent,
      relayHint: opts?.relayHint,
      quotes: opts?.quotes,
    }),
  );
}
