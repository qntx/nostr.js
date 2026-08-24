import type { Event } from "../core/event.ts";
import type { NostrSigner } from "../signer/types.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import type { EventStore } from "../storage/types.ts";
import type { StorageError } from "../storage/error.ts";
import type { Gossip } from "../gossip/gossip.ts";
import { Client } from "./client.ts";

export type ClientBuilderOptions = {
  signer?: NostrSigner;
  relays?: readonly string[];
  websocketImplementation?: WebSocketConstructor;
  verifyEvent?: (event: Event) => boolean;
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  automaticAuth?: boolean;
  enableReconnect?: boolean;
  enablePing?: boolean;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  storage?: EventStore;
  persistEvents?: boolean;
  gossip?: Gossip;
  onstorageerror?: (err: StorageError) => void;
};

/** Fluent constructor for {@link Client}. */
export class ClientBuilder {
  #signer: NostrSigner | undefined;
  #relays: string[] = [];
  #websocketImplementation: WebSocketConstructor | undefined;
  #verifyEvent: ((event: Event) => boolean) | undefined;
  #connectTimeoutMs: number | undefined;
  #publishTimeoutMs: number | undefined;
  #automaticAuth: boolean | undefined;
  #enableReconnect: boolean | undefined;
  #enablePing: boolean | undefined;
  #pingIntervalMs: number | undefined;
  #pingTimeoutMs: number | undefined;
  #storage: EventStore | undefined;
  #persistEvents: boolean | undefined;
  #gossip: Gossip | undefined;
  #onstorageerror: ((err: StorageError) => void) | undefined;

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

  verifyEvent(fn: (event: Event) => boolean): this {
    this.#verifyEvent = fn;
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

  enablePing(enabled: boolean): this {
    this.#enablePing = enabled;
    return this;
  }

  pingIntervalMs(ms: number): this {
    this.#pingIntervalMs = ms;
    return this;
  }

  pingTimeoutMs(ms: number): this {
    this.#pingTimeoutMs = ms;
    return this;
  }

  /**
   * Local event store. Defaults to {@link MemoryEventStore}.
   * Browser apps that want persistence must pass {@link IndexedDbEventStore} and `await open()`.
   */
  storage(store: EventStore): this {
    this.#storage = store;
    return this;
  }

  /** When false, Client will not auto-write events to storage. Default true. */
  persistEvents(enabled: boolean): this {
    this.#persistEvents = enabled;
    return this;
  }

  gossip(gossip: Gossip): this {
    this.#gossip = gossip;
    return this;
  }

  onstorageerror(fn: (err: StorageError) => void): this {
    this.#onstorageerror = fn;
    return this;
  }

  build(): Client {
    return new Client({
      signer: this.#signer,
      relays: this.#relays,
      websocketImplementation: this.#websocketImplementation,
      verifyEvent: this.#verifyEvent,
      connectTimeoutMs: this.#connectTimeoutMs,
      publishTimeoutMs: this.#publishTimeoutMs,
      automaticAuth: this.#automaticAuth,
      enableReconnect: this.#enableReconnect,
      enablePing: this.#enablePing,
      pingIntervalMs: this.#pingIntervalMs,
      pingTimeoutMs: this.#pingTimeoutMs,
      storage: this.#storage,
      persistEvents: this.#persistEvents,
      gossip: this.#gossip,
      onstorageerror: this.#onstorageerror,
    });
  }
}
