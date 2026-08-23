import type { Event, EventTemplate, UnsignedEvent } from "../core/event.ts";
import { signedMatchesUnsigned, validateSignedEvent } from "../core/event.ts";
import { CryptoError } from "../core/error.ts";
import { verifyEvent } from "../core/key.ts";
import type { NostrSigner } from "./types.ts";

/**
 * Minimal NIP-07 provider surface (browser extension `window.nostr`).
 * @see https://github.com/nostr-protocol/nips/blob/master/07.md
 */
export type WindowNostr = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
};

type GlobalWithNostr = typeof globalThis & {
  nostr?: WindowNostr;
  window?: { nostr?: WindowNostr };
};

/** Resolve `window.nostr` / `globalThis.nostr` when present. */
export function getWindowNostr(): WindowNostr | undefined {
  const g = globalThis as GlobalWithNostr;
  return g.nostr ?? g.window?.nostr;
}

/** True when a NIP-07 provider is injected in the current environment. */
export function isNip07Available(): boolean {
  const n = getWindowNostr();
  return Boolean(n && typeof n.getPublicKey === "function" && typeof n.signEvent === "function");
}

/**
 * Signer backed by a NIP-07 browser extension (or any injected provider).
 * Never holds secret keys in-process.
 */
export class Nip07Signer implements NostrSigner {
  readonly #provider: WindowNostr | undefined;

  constructor(provider?: WindowNostr) {
    this.#provider = provider;
  }

  #resolve(): WindowNostr {
    const provider = this.#provider ?? getWindowNostr();
    if (!provider) {
      throw new CryptoError("NIP-07 provider not available (window.nostr missing)");
    }
    return provider;
  }

  async getPublicKey(): Promise<string> {
    const pk = await this.#resolve().getPublicKey();
    if (typeof pk !== "string" || pk.length !== 64) {
      throw new CryptoError("NIP-07 getPublicKey returned an invalid pubkey");
    }
    return pk.toLowerCase();
  }

  async signEvent(unsigned: UnsignedEvent): Promise<Event> {
    const provider = this.#resolve();
    const template: EventTemplate = {
      kind: unsigned.kind,
      tags: unsigned.tags.map((t) => [...t] as [string, ...string[]]),
      content: unsigned.content,
      created_at: unsigned.created_at,
    };

    const signed = await provider.signEvent(template);
    if (!validateSignedEvent(signed)) {
      throw new CryptoError("NIP-07 signEvent returned an invalid event");
    }
    if (!verifyEvent(signed)) {
      throw new CryptoError("NIP-07 signed event failed signature verification");
    }
    if (!signedMatchesUnsigned(signed, unsigned)) {
      throw new CryptoError("NIP-07 signed event does not match unsigned template");
    }
    return signed;
  }

  async nip04Encrypt(peer: string, plaintext: string): Promise<string> {
    const nip04 = this.#resolve().nip04;
    if (!nip04?.encrypt) throw new CryptoError("NIP-07 provider does not support nip04.encrypt");
    return nip04.encrypt(peer, plaintext);
  }

  async nip04Decrypt(peer: string, ciphertext: string): Promise<string> {
    const nip04 = this.#resolve().nip04;
    if (!nip04?.decrypt) throw new CryptoError("NIP-07 provider does not support nip04.decrypt");
    return nip04.decrypt(peer, ciphertext);
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    const nip44 = this.#resolve().nip44;
    if (!nip44?.encrypt) throw new CryptoError("NIP-07 provider does not support nip44.encrypt");
    return nip44.encrypt(peer, plaintext);
  }

  async nip44Decrypt(peer: string, payload: string): Promise<string> {
    const nip44 = this.#resolve().nip44;
    if (!nip44?.decrypt) throw new CryptoError("NIP-07 provider does not support nip44.decrypt");
    return nip44.decrypt(peer, payload);
  }
}
