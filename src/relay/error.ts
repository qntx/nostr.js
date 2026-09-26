import { NostrError } from "../core/error.ts";

export class RelayError extends NostrError {
  readonly url?: string;

  constructor(message: string, url?: string, options?: ErrorOptions) {
    super(url ? `${message} (${url})` : message, options);
    this.url = url;
  }
}

export class RelayConnectionError extends RelayError {}
export class RelayPublishError extends RelayError {}
export class RelayClosedError extends RelayError {}
export class RelayTimeoutError extends RelayError {}
