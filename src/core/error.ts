/** Base error for all @qntx/nostr failures. */
export class NostrError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid hex encoding or length. */
export class HexError extends NostrError {}

/** Invalid URL / relay URL. */
export class UrlError extends NostrError {}

/** Event shape / wire validation failure. */
export class EventValidationError extends NostrError {}

/** Cryptographic operation failure (keys, signatures). */
export class CryptoError extends NostrError {}

/** Message parse / encode failure. */
export class MessageError extends NostrError {}
