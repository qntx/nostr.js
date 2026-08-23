import type { Event, EventTemplate, UnsignedEvent } from "../core/event.ts";
import { signedMatchesUnsigned, validateSignedEvent } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { Kind } from "../core/kind.ts";
import { SecretKey, finalizeEvent, getPublicKey, verifyEvent } from "../core/key.ts";
import { isHex32 } from "../core/util.ts";
import {
  bunkerRelaysFromNip46,
  isNip05,
  queryNip05Document,
  type Nip05Fetch,
} from "../nips/nip05.ts";
import { decrypt, encrypt, getConversationKey } from "../nips/nip44.ts";
import {
  Nip46Error,
  decodeNip46Response,
  encodeNip46Request,
  parseBunkerURL,
  parseNostrConnectURI,
  type BunkerPointer,
  type ClientMetadata,
  type Nip46Request,
} from "../nips/nip46.ts";
import type { NostrSigner } from "./types.ts";

/** Subscribe options used by NIP-46 transport (structural subset of Pool). */
export type Nip46SubscribeOptions = {
  signal?: AbortSignal;
  onevent?: (event: Event) => void;
  onclose?: (reason: string) => void;
};

/**
 * Structural relay transport for NIP-46 RPC.
 * Satisfied by {@link import("../relay/pool.ts").Pool}; constructed above the signer layer
 * so `signer` never imports `relay` (ADR-0001).
 */
export type Nip46Transport = {
  subscribe(
    relays: string[],
    filters: Filter[],
    opts?: Nip46SubscribeOptions,
  ): { close: (reason?: string) => void };
  publish(relays: string[], event: Event): Promise<unknown>;
  close(urls?: string[]): void;
};

export type Nip46SignerOptions = {
  /**
   * Shared transport. When set, the signer does not close it on {@link Nip46Signer.close}.
   */
  pool?: Nip46Transport;
  /**
   * Factory for a private transport when `pool` is omitted.
   * Typical: `() => new Pool({ websocketImplementation, enableReconnect: true })`.
   */
  createPool?: () => Nip46Transport;
  /**
   * Relays used when the bunker pointer has none, and merged uniquely onto a
   * nonempty pointer (pointer first).
   */
  relays?: string[];
  /**
   * Bunker connection secret when resolving a NIP-05 identifier
   * (not taken from the well-known document).
   */
  secret?: string | null;
  /** Injected fetch for NIP-05 lookups. Defaults to `globalThis.fetch`. */
  fetch?: Nip05Fetch;
  /** Local client key used to encrypt RPC (not the remote user key). */
  clientSecretKey?: SecretKey | Uint8Array | string;
  /** Called when bunker returns `auth_url` for a pending request. */
  onAuthUrl?: (url: string) => void;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Requested permissions sent with `connect` (`method[:kind]` list). */
  perms?: string[];
  /** Client metadata sent with bunker-initiated `connect`. */
  metadata?: ClientMetadata;
};

function resolveClientSecret(key?: SecretKey | Uint8Array | string): SecretKey {
  if (key === undefined) return SecretKey.generate();
  if (key instanceof SecretKey) return key;
  if (typeof key === "string") return SecretKey.fromHex(key);
  return SecretKey.fromBytes(key);
}

function resolveTransport(opts: Nip46SignerOptions): { pool: Nip46Transport; ownsPool: boolean } {
  if (opts.pool) return { pool: opts.pool, ownsPool: false };
  if (opts.createPool) return { pool: opts.createPool(), ownsPool: true };
  throw new Nip46Error(
    "Nip46Signer requires pool or createPool (inject Pool from @qntx/nostr/relay)",
  );
}

function applyPointerOpts(pointer: BunkerPointer, opts: Nip46SignerOptions): BunkerPointer {
  let next: BunkerPointer = {
    pubkey: pointer.pubkey.toLowerCase(),
    relays: [...pointer.relays],
    secret: pointer.secret,
  };
  if (opts.secret !== undefined && next.secret == null) {
    next = { ...next, secret: opts.secret };
  }

  const relays = next.relays.length > 0 ? next.relays : [...(opts.relays ?? [])];
  if (relays.length === 0) {
    throw new Nip46Error("no relays for bunker connection");
  }
  if (next.relays.length > 0 && opts.relays?.length) {
    const merged = [...next.relays];
    for (const r of opts.relays) {
      if (!merged.includes(r)) merged.push(r);
    }
    return { ...next, relays: merged };
  }
  return { ...next, relays };
}

async function resolveBunkerPointer(
  input: string | BunkerPointer,
  opts: Nip46SignerOptions,
): Promise<BunkerPointer> {
  if (typeof input !== "string") {
    return {
      pubkey: input.pubkey.toLowerCase(),
      relays: [...input.relays],
      secret: input.secret,
    };
  }

  const bunker = parseBunkerURL(input);
  if (bunker) return bunker;

  if (isNip05(input)) {
    const fetched = await queryNip05Document(input, { fetch: opts.fetch });
    if (!fetched) {
      throw new Nip46Error(`NIP-05 lookup failed for ${input}`);
    }
    const pubkey = fetched.doc.names[fetched.address.local];
    if (!pubkey) {
      throw new Nip46Error(`NIP-05 lookup failed for ${input}`);
    }
    return {
      pubkey,
      relays: bunkerRelaysFromNip46(fetched.doc.nip46, pubkey),
      secret: opts.secret ?? null,
    };
  }

  throw new Nip46Error(
    "invalid bunker input (expected bunker:// URL, NIP-05 identifier, or BunkerPointer)",
  );
}

/**
 * NIP-46 remote signer (bunker / nostrconnect).
 * Implements {@link NostrSigner}; never holds the remote user's secret key.
 * Network I/O is injected via {@link Nip46Transport} (no relay import).
 */
export class Nip46Signer implements NostrSigner {
  readonly #pool: Nip46Transport;
  readonly #ownsPool: boolean;
  readonly #clientSecret: SecretKey;
  readonly #clientPubkey: string;
  readonly #pointer: BunkerPointer;
  readonly #conversationKey: Uint8Array;
  readonly #onAuthUrl: ((url: string) => void) | undefined;
  readonly #timeoutMs: number;
  readonly #perms: string[] | undefined;
  readonly #metadata: ClientMetadata | undefined;
  #relays: string[];
  readonly #listeners = new Map<
    string,
    {
      resolve: (v: string) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #waitingAuth = new Set<string>();
  #sub: { close: (reason?: string) => void } | undefined;
  #open = false;
  #serial = 0;
  #idPrefix = Math.random().toString(36).slice(2, 9);
  #cachedRemotePubkey: string | undefined;

  private constructor(
    clientSecret: SecretKey,
    pointer: BunkerPointer,
    pool: Nip46Transport,
    ownsPool: boolean,
    opts: Nip46SignerOptions,
  ) {
    if (pointer.relays.length === 0) {
      throw new Nip46Error("bunker pointer has no relays");
    }
    this.#clientSecret = clientSecret;
    this.#clientPubkey = getPublicKey(clientSecret);
    this.#pointer = {
      pubkey: pointer.pubkey.toLowerCase(),
      relays: [...pointer.relays],
      secret: pointer.secret,
    };
    this.#relays = [...pointer.relays];
    this.#pool = pool;
    this.#ownsPool = ownsPool;
    this.#conversationKey = getConversationKey(clientSecret.bytes, this.#pointer.pubkey);
    this.#onAuthUrl = opts.onAuthUrl;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#perms = opts.perms;
    this.#metadata = opts.metadata;
  }

  get bunker(): Readonly<BunkerPointer> {
    return {
      pubkey: this.#pointer.pubkey,
      relays: [...this.#relays],
      secret: this.#pointer.secret,
    };
  }

  get clientPublicKey(): string {
    return this.#clientPubkey;
  }

  /**
   * Subscribe to an already-known bunker pointer. Does not send the `connect` RPC
   * (reconnect / jumble `isInitialConnection=false`).
   * Requires `clientSecretKey` — reconnect must reuse the original client identity.
   */
  static fromBunker(
    pointer: BunkerPointer,
    opts: Nip46SignerOptions & { clientSecretKey: SecretKey | Uint8Array | string },
  ): Nip46Signer {
    if (opts.clientSecretKey === undefined) {
      throw new Nip46Error("fromBunker requires clientSecretKey");
    }
    const resolved = applyPointerOpts(pointer, opts);
    const sk = resolveClientSecret(opts.clientSecretKey);
    const { pool, ownsPool } = resolveTransport(opts);
    const signer = new Nip46Signer(sk, resolved, pool, ownsPool, opts);
    signer.#startSubscription();
    return signer;
  }

  /**
   * Connect using a `bunker://` URL, NIP-05 identifier, or pre-parsed pointer.
   * NIP-05: pubkey from `names`; bunker relays from `nip46` (never profile `relays`).
   * Empty `nip46` relays are filled from `opts.relays`; still empty → throw.
   * When both pointer and `opts.relays` are nonempty, unique `opts.relays` are appended.
   */
  static async connect(
    input: string | BunkerPointer,
    opts: Nip46SignerOptions = {},
  ): Promise<Nip46Signer> {
    const pointer = await resolveBunkerPointer(input, opts);
    const signer = Nip46Signer.fromBunker(pointer, {
      ...opts,
      clientSecretKey: resolveClientSecret(opts.clientSecretKey),
    });
    try {
      await signer.connectRemote();
      try {
        await signer.switchRelays();
      } catch {
        // Bunker may not implement switch_relays.
      }
      await signer.getPublicKey();
      return signer;
    } catch (err) {
      await signer.close();
      throw err;
    }
  }

  /**
   * Wait for a bunker to complete a client-initiated `nostrconnect://` handshake.
   * Requires `clientSecretKey` whose pubkey matches the URI client pubkey
   * (build the URI with {@link createNostrConnectURI} after generating keys).
   */
  static async fromNostrConnectURI(
    connectionURI: string,
    opts: Nip46SignerOptions & {
      clientSecretKey: SecretKey | Uint8Array | string;
      signal?: AbortSignal;
      handshakeTimeoutMs?: number;
    },
  ): Promise<Nip46Signer> {
    const params = parseNostrConnectURI(connectionURI);
    const sk = resolveClientSecret(opts.clientSecretKey);
    const clientPubkey = getPublicKey(sk);

    if (clientPubkey !== params.clientPubkey) {
      throw new Nip46Error("client secret key does not match nostrconnect client pubkey");
    }

    const { pool, ownsPool } = resolveTransport(opts);
    const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 300_000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, signer?: Nip46Signer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close(err ? "failed" : "connected");
        if (err) {
          if (ownsPool) pool.close();
          reject(err);
        } else if (signer) {
          resolve(signer);
        }
      };

      const timer = setTimeout(() => {
        finish(new Nip46Error("nostrconnect handshake timed out"));
      }, handshakeTimeoutMs);

      const sub = pool.subscribe(
        params.relays,
        [{ kinds: [Kind.NostrConnect], "#p": [clientPubkey], limit: 0 }],
        {
          signal: opts.signal,
          onevent: (event) => {
            try {
              const convKey = getConversationKey(sk.bytes, event.pubkey);
              const payload = decrypt(event.content, convKey);
              const response = decodeNip46Response(payload);
              if (response.result !== params.secret) return;

              const pointer: BunkerPointer = {
                pubkey: event.pubkey.toLowerCase(),
                relays: params.relays,
                secret: params.secret,
              };
              const signer = new Nip46Signer(sk, pointer, pool, ownsPool, opts);
              signer.#startSubscription();
              void signer
                .switchRelays()
                .catch(() => undefined)
                .then(() => signer.getPublicKey())
                .then(() => finish(undefined, signer))
                .catch((e) => finish(e instanceof Error ? e : new Nip46Error(String(e))));
            } catch {
              // ignore non-matching events
            }
          },
          onclose: (reason) => {
            if (reason !== "connected" && reason !== "failed") {
              finish(new Nip46Error(`nostrconnect subscription closed: ${reason}`));
            }
          },
        },
      );
    });
  }

  #startSubscription(): void {
    this.#sub?.close();
    this.#sub = this.#pool.subscribe(
      this.#relays,
      [
        {
          kinds: [Kind.NostrConnect],
          authors: [this.#pointer.pubkey],
          "#p": [this.#clientPubkey],
          limit: 0,
        },
      ],
      {
        onevent: (event) => {
          try {
            const payload = decrypt(event.content, this.#conversationKey);
            const { id, result, error } = decodeNip46Response(payload);

            if (result === "auth_url" && this.#waitingAuth.has(id)) {
              this.#waitingAuth.delete(id);
              if (error) this.#onAuthUrl?.(error);
              return;
            }

            const listener = this.#listeners.get(id);
            if (!listener) return;
            clearTimeout(listener.timer);
            this.#listeners.delete(id);
            this.#waitingAuth.delete(id);
            if (error) listener.reject(new Nip46Error(error));
            else if (result !== undefined) listener.resolve(result);
            else listener.reject(new Nip46Error("empty NIP-46 response"));
          } catch {
            // ignore decrypt failures from unrelated events
          }
        },
        onclose: () => {
          this.#sub = undefined;
        },
      },
    );
    this.#open = true;
  }

  async connectRemote(overrides?: { metadata?: ClientMetadata; perms?: string[] }): Promise<void> {
    const metadata = overrides?.metadata ?? this.#metadata;
    const perms = overrides?.perms ?? this.#perms;
    const params = [this.#pointer.pubkey, this.#pointer.secret ?? ""];
    if (perms?.length || metadata) {
      params.push(perms?.length ? perms.join(",") : "");
    }
    if (metadata) {
      params.push(JSON.stringify(metadata));
    }
    await this.#sendRequest("connect", params);
  }

  /**
   * Ask the bunker for its preferred relay list and resubscribe when it changes.
   * Spec result is a JSON array of URLs, or `null` when nothing changes.
   */
  async switchRelays(): Promise<string[] | null> {
    const resp = await this.#sendRequest("switch_relays", []);
    if (resp === "null") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(resp);
    } catch (cause) {
      throw new Nip46Error("invalid switch_relays JSON", {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((x) => typeof x === "string")
    ) {
      throw new Nip46Error("invalid switch_relays result");
    }
    this.#relays = parsed;
    this.#startSubscription();
    return parsed;
  }

  /** Courtesy session teardown. Always closes the local signer afterwards. */
  async logout(): Promise<void> {
    try {
      const resp = await this.#sendRequest("logout", []);
      if (resp !== "ack") throw new Nip46Error(`logout result is not ack: ${resp}`);
    } finally {
      await this.close();
    }
  }

  async ping(): Promise<void> {
    const resp = await this.#sendRequest("ping", []);
    if (resp !== "pong") throw new Nip46Error(`ping result is not pong: ${resp}`);
  }

  async getPublicKey(): Promise<string> {
    if (!this.#cachedRemotePubkey) {
      const pk = await this.#sendRequest("get_public_key", []);
      if (!isHex32(pk)) throw new Nip46Error("bunker returned invalid pubkey");
      this.#cachedRemotePubkey = pk.toLowerCase();
    }
    return this.#cachedRemotePubkey;
  }

  async signEvent(unsigned: UnsignedEvent): Promise<Event> {
    const template: EventTemplate = {
      kind: unsigned.kind,
      tags: unsigned.tags,
      content: unsigned.content,
      created_at: unsigned.created_at,
    };
    const resp = await this.#sendRequest("sign_event", [JSON.stringify(template)]);
    let signed: unknown;
    try {
      signed = JSON.parse(resp);
    } catch (cause) {
      throw new Nip46Error("bunker returned invalid sign_event JSON", {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    if (!validateSignedEvent(signed) || !verifyEvent(signed)) {
      throw new Nip46Error("bunker returned improperly signed event");
    }
    if (!signedMatchesUnsigned(signed, unsigned)) {
      throw new Nip46Error("signed event does not match unsigned template");
    }
    return signed;
  }

  async nip04Encrypt(peer: string, plaintext: string): Promise<string> {
    return this.#sendRequest("nip04_encrypt", [peer, plaintext]);
  }

  async nip04Decrypt(peer: string, ciphertext: string): Promise<string> {
    return this.#sendRequest("nip04_decrypt", [peer, ciphertext]);
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return this.#sendRequest("nip44_encrypt", [peer, plaintext]);
  }

  async nip44Decrypt(peer: string, payload: string): Promise<string> {
    return this.#sendRequest("nip44_decrypt", [peer, payload]);
  }

  async close(): Promise<void> {
    this.#open = false;
    for (const [, listener] of this.#listeners) {
      clearTimeout(listener.timer);
      listener.reject(new Nip46Error("signer closed"));
    }
    this.#listeners.clear();
    this.#sub?.close("signer closed");
    this.#sub = undefined;
    if (this.#ownsPool) this.#pool.close();
  }

  async #sendRequest(method: string, params: string[]): Promise<string> {
    if (!this.#open) throw new Nip46Error("signer is closed");
    if (!this.#sub) this.#startSubscription();

    this.#serial += 1;
    const id = `${this.#idPrefix}-${this.#serial}`;
    const req: Nip46Request = { id, method, params };
    const encrypted = encrypt(encodeNip46Request(req), this.#conversationKey);

    const event = finalizeEvent(
      {
        kind: Kind.NostrConnect,
        tags: [["p", this.#pointer.pubkey]],
        content: encrypted,
        created_at: Math.floor(Date.now() / 1000),
      },
      this.#clientSecret,
    );

    const resultPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(id);
        this.#waitingAuth.delete(id);
        reject(new Nip46Error(`NIP-46 request timed out: ${method}`));
      }, this.#timeoutMs);
      this.#listeners.set(id, { resolve, reject, timer });
      this.#waitingAuth.add(id);
    });

    await this.#pool.publish(this.#relays, event);
    return resultPromise;
  }
}
