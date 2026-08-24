import type { Event, UnsignedEvent } from "../core/event.ts";
import { CryptoError } from "../core/error.ts";
import { Keys, SecretKey, getPublicKey, signEvent } from "../core/key.ts";
import * as nip04 from "../nips/nip04.ts";
import * as nip44 from "../nips/nip44.ts";
import type { NostrSigner } from "./types.ts";

/** Local secret-key signer with NIP-04 (legacy) and NIP-44 support. */
export class KeysSigner implements NostrSigner {
  readonly #keys: Keys;
  readonly #convKeys = new Map<string, Uint8Array>();

  constructor(secretKey: SecretKey | Uint8Array | string | Keys) {
    this.#keys = secretKey instanceof Keys ? secretKey : Keys.fromSecretKey(secretKey);
  }

  get keys(): Keys {
    return this.#keys;
  }

  async getPublicKey(): Promise<string> {
    return this.#keys.publicKey;
  }

  async signEvent(unsigned: UnsignedEvent): Promise<Event> {
    const expected = getPublicKey(this.#keys.secretKey);
    if (unsigned.pubkey.toLowerCase() !== expected) {
      throw new CryptoError("unsigned event pubkey does not match signer");
    }
    return signEvent(unsigned, this.#keys.secretKey);
  }

  async nip04Encrypt(peer: string, plaintext: string): Promise<string> {
    return nip04.encrypt(this.#keys.secretKey.bytes, peer, plaintext);
  }

  async nip04Decrypt(peer: string, ciphertext: string): Promise<string> {
    return nip04.decrypt(this.#keys.secretKey.bytes, peer, ciphertext);
  }

  #conversationKey(peer: string): Uint8Array {
    const pk = peer.toLowerCase();
    let key = this.#convKeys.get(pk);
    if (!key) {
      key = nip44.getConversationKey(this.#keys.secretKey.bytes, pk);
      this.#convKeys.set(pk, key);
    }
    return key;
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return nip44.encrypt(plaintext, this.#conversationKey(peer));
  }

  async nip44Decrypt(peer: string, payload: string): Promise<string> {
    return nip44.decrypt(payload, this.#conversationKey(peer));
  }
}
