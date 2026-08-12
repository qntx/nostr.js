import type { NostrSigner } from "../signer/types.ts";
import type { PoolOptions } from "../relay/pool.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import { Client } from "./client.ts";

export type ClientBuilderOptions = {
  signer?: NostrSigner;
  relays?: readonly string[];
  websocketImplementation?: WebSocketConstructor;
  pool?: PoolOptions;
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  automaticAuth?: boolean;
  enableReconnect?: boolean;
};

/** Fluent constructor for {@link Client}. */
export class ClientBuilder {
  #signer: NostrSigner | undefined;
  #relays: string[] = [];
  #websocketImplementation: WebSocketConstructor | undefined;
  #connectTimeoutMs: number | undefined;
  #publishTimeoutMs: number | undefined;
  #automaticAuth: boolean | undefined;
  #enableReconnect: boolean | undefined;

  signer(signer: NostrSigner): this {
    this.#signer = signer;
    return this;
  }

  relays(urls: readonly string[]): this {
    this.#relays = [...urls];
    return this;
  }

  addRelay(url: string): this {
    this.#relays.push(url);
    return this;
  }

  websocketImplementation(impl: WebSocketConstructor): this {
    this.#websocketImplementation = impl;
    return this;
  }

  connectTimeoutMs(ms: number): this {
    this.#connectTimeoutMs = ms;
    return this;
  }

  publishTimeoutMs(ms: number): this {
    this.#publishTimeoutMs = ms;
    return this;
  }

  automaticAuth(enabled: boolean): this {
    this.#automaticAuth = enabled;
    return this;
  }

  enableReconnect(enabled: boolean): this {
    this.#enableReconnect = enabled;
    return this;
  }

  build(): Client {
    return new Client({
      signer: this.#signer,
      relays: this.#relays,
      websocketImplementation: this.#websocketImplementation,
      connectTimeoutMs: this.#connectTimeoutMs,
      publishTimeoutMs: this.#publishTimeoutMs,
      automaticAuth: this.#automaticAuth,
      enableReconnect: this.#enableReconnect,
    });
  }
}
