import { NostrError } from "../core/error.ts";

/** Base class for relay errors; carries the relay URL when known. */
export class RelayError extends NostrError {
  readonly url?: string;

  constructor(message: string, url?: string, options?: ErrorOptions) {
    super(url ? `${message} (${url})` : message, options);
    this.url = url;
  }
}

/** A relay connection attempt or socket failed. */
export class RelayConnectionError extends RelayError {}
/** A relay answered an EVENT with `ok: false`. */
export class RelayPublishError extends RelayError {}
/** A subscription was closed by the relay (`CLOSED`) or the socket dropped. */
export class RelayClosedError extends RelayError {}
/** A relay operation exceeded its deadline. */
export class RelayTimeoutError extends RelayError {}
