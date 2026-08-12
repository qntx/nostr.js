import type { Event, UnsignedEvent } from "../core/event.ts";

/**
 * Universal signing interface (aligned with nula's NostrSigner).
 * Implementations: KeysSigner, Nip07Signer, Nip46Signer, …
 */
export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(unsigned: UnsignedEvent): Promise<Event>;

  /** Optional NIP-04 (legacy). Unsupported signers reject. */
  nip04Encrypt?(peer: string, plaintext: string): Promise<string>;
  nip04Decrypt?(peer: string, ciphertext: string): Promise<string>;

  /** Optional NIP-44 v2. Unsupported signers reject. */
  nip44Encrypt?(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt?(peer: string, payload: string): Promise<string>;
}
