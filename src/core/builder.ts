import { EventValidationError } from "./error.ts";
import type { Event, EventTemplate, UnsignedEvent } from "./event.ts";
import { Kind, isAddressableKind, isReplaceableKind } from "./kind.ts";
import { Keys, finalizeEvent } from "./key.ts";
import { Tag, getDTag } from "./tag.ts";

function hasProtectedTag(event: Event): boolean {
  for (const tag of event.tags) {
    if (tag[0] === "-") return true;
  }
  return false;
}

/** Profile metadata JSON (kind 0 content). NIP-05 is not verified here. */
export type ProfileMetadata = {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud06?: string;
  lud16?: string;
};

/**
 * Fluent builder for event templates.
 * Decouples intent (kind/content/tags) from signing (Keys / NostrSigner).
 */
export class EventBuilder {
  #kind: number;
  #content: string;
  #tags: Tag[];
  #createdAt: number | undefined;

  constructor(kind: number, content = "") {
    this.#kind = kind;
    this.#content = content;
    this.#tags = [];
    this.#createdAt = undefined;
  }

  static textNote(content: string): EventBuilder {
    return new EventBuilder(Kind.TextNote, content);
  }

  static metadata(meta: ProfileMetadata): EventBuilder {
    return new EventBuilder(Kind.Metadata, JSON.stringify(meta));
  }

  static contacts(pubkeys: string[]): EventBuilder {
    const b = new EventBuilder(Kind.Contacts, "");
    for (const pk of pubkeys) b.#tags.push(["p", pk]);
    return b;
  }

  static deletion(
    ids: string[],
    reason = "",
    opts?: { kinds?: readonly number[]; addresses?: readonly string[] },
  ): EventBuilder {
    const b = new EventBuilder(Kind.EventDeletion, reason);
    for (const id of ids) b.#tags.push(Tag.e(id));
    if (opts?.kinds) {
      for (const kind of opts.kinds) b.#tags.push(Tag.k(kind));
    }
    if (opts?.addresses) {
      for (const address of opts.addresses) b.#tags.push(Tag.a(address));
    }
    return b;
  }

  static reaction(
    targetId: string,
    content = "+",
    opts?: { author?: string; kind?: number },
  ): EventBuilder {
    const b = new EventBuilder(Kind.Reaction, content);
    b.#tags.push(["e", targetId]);
    if (opts?.author) b.#tags.push(["p", opts.author]);
    if (opts?.kind !== undefined) b.#tags.push(["k", String(opts.kind)]);
    return b;
  }

  static repost(target: Event, opts?: { relayHint?: string }): EventBuilder {
    const content = hasProtectedTag(target) ? "" : JSON.stringify(target);
    const b = new EventBuilder(Kind.Repost, content);
    b.#tags.push(Tag.e(target.id, opts?.relayHint));
    b.#tags.push(Tag.p(target.pubkey));
    return b;
  }

  static genericRepost(
    target: Event,
    opts?: { relayHint?: string; pPubkey?: string },
  ): EventBuilder {
    if (target.kind === Kind.TextNote) {
      throw new EventValidationError("kind 1 uses EventBuilder.repost");
    }
    const replaceable = isReplaceableKind(target.kind);
    const addressable = isAddressableKind(target.kind);
    const d = getDTag(target.tags);
    if (addressable && d === undefined) {
      throw new EventValidationError("addressable event is missing d tag");
    }

    const content =
      hasProtectedTag(target) || replaceable || addressable ? "" : JSON.stringify(target);
    const b = new EventBuilder(Kind.GenericRepost, content);
    b.#tags.push(Tag.e(target.id, opts?.relayHint));
    b.#tags.push(Tag.p(opts?.pPubkey ?? target.pubkey));
    b.#tags.push(Tag.k(target.kind));
    if (replaceable || addressable) {
      b.#tags.push(Tag.a(`${target.kind}:${target.pubkey}:${d ?? ""}`));
    }
    return b;
  }

  static relayList(relays: Array<{ url: string; read?: boolean; write?: boolean }>): EventBuilder {
    const b = new EventBuilder(Kind.RelayList, "");
    for (const r of relays) {
      if (r.read !== false && r.write !== false) {
        b.#tags.push(["r", r.url]);
      } else if (r.read !== false && r.write === false) {
        b.#tags.push(["r", r.url, "read"]);
      } else if (r.read === false && r.write !== false) {
        b.#tags.push(["r", r.url, "write"]);
      }
    }
    return b;
  }

  kind(kind: number): this {
    this.#kind = kind;
    return this;
  }

  content(content: string): this {
    this.#content = content;
    return this;
  }

  tag(tag: Tag | string[]): this {
    this.#tags.push(tag as Tag);
    return this;
  }

  tags(tags: Iterable<Tag | string[]>): this {
    for (const t of tags) this.#tags.push(t as Tag);
    return this;
  }

  createdAt(ts: number): this {
    this.#createdAt = ts;
    return this;
  }

  get currentKind(): number {
    return this.#kind;
  }

  get currentContent(): string {
    return this.#content;
  }

  get currentTags(): readonly Tag[] {
    return this.#tags;
  }

  get currentCreatedAt(): number | undefined {
    return this.#createdAt;
  }

  /** Snapshot as EventTemplate (uses wall clock if created_at unset). */
  toTemplate(): EventTemplate {
    return {
      kind: this.#kind,
      content: this.#content,
      tags: this.#tags.slice(),
      created_at: this.#createdAt ?? Math.floor(Date.now() / 1000),
    };
  }

  /** Build unsigned event with the given pubkey. */
  buildUnsigned(pubkey: string): UnsignedEvent {
    const template = this.toTemplate();
    return {
      ...template,
      pubkey: pubkey.toLowerCase(),
    };
  }

  /** Sign with local Keys (synchronous). */
  signWithKeys(keys: Keys | SecretKeyLike): Event {
    if (keys instanceof Keys) {
      return finalizeEvent(this.toTemplate(), keys.secretKey);
    }
    return finalizeEvent(this.toTemplate(), keys);
  }

  /**
   * Sign via any NostrSigner-shaped object.
   * Accepts a structural type so core does not depend on the signer module.
   */
  async sign(signer: {
    getPublicKey(): Promise<string>;
    signEvent(unsigned: UnsignedEvent): Promise<Event>;
  }): Promise<Event> {
    const pubkey = await signer.getPublicKey();
    return signer.signEvent(this.buildUnsigned(pubkey));
  }
}

type SecretKeyLike = import("./key.ts").SecretKey | Uint8Array | string;
