import type { Event } from "../core/event.ts";
import type { Gossip } from "../gossip/gossip.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import type { NostrSigner } from "../signer/types.ts";
import type { StorageError } from "../storage/error.ts";
import type { EventStore } from "../storage/types.ts";
import { Client } from "./client.ts";
import type { ClientOptions } from "./types.ts";

/** Fluent constructor for {@link Client}. */
export class ClientBuilder {
  #opts: ClientOptions = {};

  signer(signer: NostrSigner): this {
    this.#opts = { ...this.#opts, signer };
    return this;
  }

  relays(urls: readonly string[]): this {
    this.#opts = { ...this.#opts, relays: [...urls] };
    return this;
  }

  addRelay(url: string): this {
    this.#opts = { ...this.#opts, relays: [...(this.#opts.relays ?? []), url] };
    return this;
  }

  websocketImplementation(impl: WebSocketConstructor): this {
    this.#opts = { ...this.#opts, websocketImplementation: impl };
    return this;
  }

  verifyEvent(fn: (event: Event) => boolean): this {
    this.#opts = { ...this.#opts, verifyEvent: fn };
    return this;
  }

  connectTimeoutMs(ms: number): this {
    this.#opts = { ...this.#opts, connectTimeoutMs: ms };
    return this;
  }

  publishTimeoutMs(ms: number): this {
    this.#opts = { ...this.#opts, publishTimeoutMs: ms };
    return this;
  }

  automaticAuth(enabled: boolean): this {
    this.#opts = { ...this.#opts, automaticAuth: enabled };
    return this;
  }

  enableReconnect(enabled: boolean): this {
    this.#opts = { ...this.#opts, enableReconnect: enabled };
    return this;
  }

  enablePing(enabled: boolean): this {
    this.#opts = { ...this.#opts, enablePing: enabled };
    return this;
  }

  pingIntervalMs(ms: number): this {
    this.#opts = { ...this.#opts, pingIntervalMs: ms };
    return this;
  }

  pingTimeoutMs(ms: number): this {
    this.#opts = { ...this.#opts, pingTimeoutMs: ms };
    return this;
  }

  /**
   * Local event store. Defaults to {@link MemoryEventStore}.
   * Browser apps that want persistence must pass {@link IndexedDbEventStore} and `await open()`.
   */
  storage(store: EventStore): this {
    this.#opts = { ...this.#opts, storage: store };
    return this;
  }

  /** When false, Client will not auto-write events to storage. Default true. */
  persistEvents(enabled: boolean): this {
    this.#opts = { ...this.#opts, persistEvents: enabled };
    return this;
  }

  gossip(gossip: Gossip): this {
    this.#opts = { ...this.#opts, gossip };
    return this;
  }

  onstorageerror(fn: (err: StorageError) => void): this {
    this.#opts = { ...this.#opts, onstorageerror: fn };
    return this;
  }

  build(): Client {
    return new Client(this.#opts);
  }
}
