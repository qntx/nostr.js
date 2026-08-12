import type { Event, EventTemplate, UnsignedEvent } from "../core/event.ts";
import { validateSignedEvent } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import { SecretKey, finalizeEvent, getPublicKey, verifyEvent } from "../core/key.ts";
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
import { Pool } from "../relay/pool.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import type { NostrSigner } from "./types.ts";

export type Nip46SignerOptions = {
  /** Shared pool; when omitted a private pool is created. */
  pool?: Pool;
  /** Fallback relays when bunker pointer has none. */
  relays?: string[];
  websocketImplementation?: WebSocketConstructor;
  /** Local client key used to encrypt RPC (not the remote user key). */
  clientSecretKey?: SecretKey | Uint8Array | string;
  /** Called when bunker returns `auth_url` for a pending request. */
  onAuthUrl?: (url: string) => void;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
};

function resolveClientSecret(key?: SecretKey | Uint8Array | string): SecretKey {
  if (key === undefined) return SecretKey.generate();
  if (key instanceof SecretKey) return key;
  if (typeof key === "string") return SecretKey.fromHex(key);
  return SecretKey.fromBytes(key);
}

/**
 * NIP-46 remote signer (bunker / nostrconnect).
 * Implements {@link NostrSigner}; never holds the remote user's secret key.
 */
export class Nip46Signer implements NostrSigner {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #clientSecret: SecretKey;
  readonly #clientPubkey: string;
  readonly #pointer: BunkerPointer;
  readonly #conversationKey: Uint8Array;
  readonly #onAuthUrl: ((url: string) => void) | undefined;
  readonly #timeoutMs: number;
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
    pool: Pool,
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
    this.#pool = pool;
    this.#ownsPool = ownsPool;
    this.#conversationKey = getConversationKey(clientSecret.bytes, this.#pointer.pubkey);
    this.#onAuthUrl = opts.onAuthUrl;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get bunker(): Readonly<BunkerPointer> {
    return this.#pointer;
  }

  get clientPublicKey(): string {
    return this.#clientPubkey;
  }

  /** Connect using a `bunker://` URL (or pre-parsed pointer). */
  static async connect(
    input: string | BunkerPointer,
    opts: Nip46SignerOptions = {},
  ): Promise<Nip46Signer> {
    let pointer: BunkerPointer | null;
    if (typeof input === "string") {
      pointer = parseBunkerURL(input);
      if (!pointer) {
        throw new Nip46Error(
          "invalid bunker input (expected bunker:// URL; NIP-05 lookup not implemented here)",
        );
      }
    } else {
      pointer = {
        pubkey: input.pubkey.toLowerCase(),
        relays: [...input.relays],
        secret: input.secret,
      };
    }

    const relays = pointer.relays.length > 0 ? pointer.relays : [...(opts.relays ?? [])];
    if (relays.length === 0) {
      throw new Nip46Error("no relays for bunker connection");
    }
    pointer = { ...pointer, relays };

    const sk = resolveClientSecret(opts.clientSecretKey);
    const ownsPool = !opts.pool;
    const pool =
      opts.pool ??
      new Pool({
        websocketImplementation: opts.websocketImplementation,
        enableReconnect: true,
      });

    const signer = new Nip46Signer(sk, pointer, pool, ownsPool, opts);
    signer.#startSubscription();
    await signer.connectRemote();
    return signer;
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

    const ownsPool = !opts.pool;
    const pool =
      opts.pool ??
      new Pool({
        websocketImplementation: opts.websocketImplementation,
        enableReconnect: true,
      });

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
              finish(undefined, signer);
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
      this.#pointer.relays,
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

  async connectRemote(metadata?: ClientMetadata): Promise<void> {
    const params = [this.#pointer.pubkey, this.#pointer.secret ?? ""];
    if (metadata) {
      params.push("");
      params.push(JSON.stringify(metadata));
    }
    await this.#sendRequest("connect", params);
  }

  async ping(): Promise<void> {
    const resp = await this.#sendRequest("ping", []);
    if (resp !== "pong") throw new Nip46Error(`ping result is not pong: ${resp}`);
  }

  async getPublicKey(): Promise<string> {
    if (!this.#cachedRemotePubkey) {
      this.#cachedRemotePubkey = await this.#sendRequest("get_public_key", []);
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
    if (unsigned.pubkey && signed.pubkey.toLowerCase() !== unsigned.pubkey.toLowerCase()) {
      throw new Nip46Error("signed event pubkey does not match unsigned event");
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

    await this.#pool.publish(this.#pointer.relays, event);
    return resultPromise;
  }
}
