/**
 * NIP-17: Private Direct Messages.
 * Kind 10050 advertises where gift-wraps should be delivered.
 * Kind 14 rumor construction and per-recipient wrap live here.
 * Envelope primitives live in nip59.ts.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/17.md
 */
import type { Event } from "../core/event.ts";
import { EventValidationError, NostrError } from "../core/error.ts";
import { Kind } from "../core/kind.ts";
import type { Tag } from "../core/tag.ts";
import { Tag as TagBuilder } from "../core/tag.ts";
import { EventBuilder } from "../core/builder.ts";
import { assertHex32, normalizeURL } from "../core/util.ts";
import {
  createGiftWrap,
  createRumor,
  createSeal,
  type Nip59Crypto,
  type Rumor,
  type WrapOptions,
} from "./nip59.ts";

export class Nip17Error extends NostrError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type Recipient = {
  readonly pubkey: string;
  readonly relayHint?: string;
};

export type ReplyTo = {
  readonly id: string;
  readonly relayHint?: string;
};

export type ChatMessageOptions = {
  readonly created_at?: number;
  readonly subject?: string;
  readonly replyTo?: ReplyTo;
};

/** Parse kind:10050 DM relay list (`["relay", url]` tags). */
export function parseDmRelayList(event: Pick<Event, "kind" | "tags">): string[] {
  if (event.kind !== Kind.DirectMessageRelaysList) {
    throw new EventValidationError(
      `expected kind ${Kind.DirectMessageRelaysList}, got ${event.kind}`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "relay" || !tag[1]) continue;
    let url: string;
    try {
      url = normalizeURL(tag[1]);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Encode DM relay URLs as NIP-17 `relay` tags. */
export function dmRelayListToTags(relays: readonly string[]): Tag[] {
  const tags: Tag[] = [];
  const seen = new Set<string>();
  for (const raw of relays) {
    let url: string;
    try {
      url = normalizeURL(raw);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    tags.push(["relay", url] as Tag);
  }
  return tags;
}

/** Build an unsigned kind:10050 EventBuilder. */
export function dmRelayListEventBuilder(relays: readonly string[]): EventBuilder {
  return new EventBuilder(Kind.DirectMessageRelaysList, "").tags(dmRelayListToTags(relays));
}

function asRecipientList(
  input: string | Recipient | readonly (string | Recipient)[],
): readonly (string | Recipient)[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input as readonly (string | Recipient)[];
  return [input as Recipient];
}

/** Accept a hex pubkey, a Recipient, or a readonly array of either. Dedup by pubkey. */
export function normalizeRecipients(
  input: string | Recipient | readonly (string | Recipient)[],
): Recipient[] {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const item of asRecipientList(input)) {
    const rec: Recipient = typeof item === "string" ? { pubkey: item } : item;
    const pubkey = assertHex32(rec.pubkey, "public key");
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push({ pubkey, relayHint: rec.relayHint });
  }
  return out;
}

export function buildChatMessageRumor(
  senderPubkey: string,
  recipients: readonly Recipient[],
  content: string,
  opts?: ChatMessageOptions,
): Rumor {
  if (recipients.length === 0) {
    throw new Nip17Error("recipients must not be empty");
  }
  const tags: Tag[] = [];
  for (const recipient of recipients) {
    const pk = assertHex32(recipient.pubkey, "public key");
    tags.push(TagBuilder.p(pk, recipient.relayHint));
  }
  if (opts?.replyTo) {
    tags.push(
      TagBuilder.e(assertHex32(opts.replyTo.id, "event id"), opts.replyTo.relayHint ?? "", "reply"),
    );
  }
  if (opts?.subject !== undefined) {
    tags.push(["subject", opts.subject]);
  }
  return createRumor(senderPubkey, {
    kind: Kind.PrivateDirectMessage,
    content,
    tags,
    created_at: opts?.created_at,
  });
}

function wrapTargets(sender: string, recipients: readonly Recipient[]): Recipient[] {
  const senderPk = sender.toLowerCase();
  const self = recipients.find((r) => r.pubkey.toLowerCase() === senderPk);
  const out: Recipient[] = [{ pubkey: senderPk, relayHint: self?.relayHint }];
  const seen = new Set<string>([senderPk]);
  for (const recipient of recipients) {
    const pk = recipient.pubkey.toLowerCase();
    if (seen.has(pk)) continue;
    seen.add(pk);
    out.push({ pubkey: pk, relayHint: recipient.relayHint });
  }
  return out;
}

export async function wrapDirectMessage(
  crypto: Nip59Crypto,
  recipients: readonly Recipient[],
  rumor: Rumor,
  opts?: Pick<WrapOptions, "now" | "randomInt">,
): Promise<ReadonlyArray<{ recipient: string; wrap: Event }>> {
  if (recipients.length === 0) {
    throw new Nip17Error("recipients must not be empty");
  }
  const targets = wrapTargets(rumor.pubkey, recipients);
  const out: Array<{ recipient: string; wrap: Event }> = [];
  for (const target of targets) {
    const seal = await createSeal(crypto, target.pubkey, rumor, opts);
    const wrap = createGiftWrap(seal, target.pubkey, {
      ...opts,
      relayHint: target.relayHint,
    });
    out.push({ recipient: target.pubkey, wrap });
  }
  return out;
}

export function requireDmRelays(pubkey: string, relays: readonly string[]): string[] {
  if (relays.length === 0) {
    throw new Nip17Error(`pubkey ${pubkey} is not ready to receive DMs (no kind 10050)`);
  }
  return [...relays];
}
