import { normalizeURL } from "../core/util.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import {
  FakeRelayCore,
  type FakeRelay,
  type FakeRelayOptions,
  type RelayTransport,
} from "./relay-core.ts";

export interface FakeRelayNetwork {
  /** Pass to `Client` / `Pool` / `useWebSocketImplementation`. */
  readonly websocketImplementation: WebSocketConstructor;
  /** Get-or-create a relay handle by normalized URL. */
  relay(url: string, opts?: FakeRelayOptions): FakeRelay;
  close(): void;
}

type Listener = (ev: unknown) => void;

/**
 * In-process fake relay network. `new websocketImplementation(url)` opens a
 * socket bound to the network's relay for that URL; `send` is dispatched to the
 * relay session directly (no polling).
 */
export function createFakeRelayNetwork(defaults: FakeRelayOptions = {}): FakeRelayNetwork {
  const cores = new Map<string, FakeRelayCore>();

  const coreFor = (url: string, opts?: FakeRelayOptions): FakeRelayCore => {
    const key = normalizeURL(url);
    let core = cores.get(key);
    if (!core) {
      core = new FakeRelayCore(key, { ...defaults, ...opts });
      cores.set(key, core);
    } else if (opts) {
      core.configure(opts);
    }
    return core;
  };

  class FakeSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    /** Client→relay frames, for tests that inspect wire traffic. */
    readonly sent: string[] = [];
    readyState = FakeSocket.CONNECTING;
    #listeners = new Map<string, Set<Listener>>();
    #session: ReturnType<FakeRelayCore["connect"]> | undefined;
    #queuedSends: string[] = [];
    #core: FakeRelayCore;

    constructor(url: string) {
      this.url = url;
      this.#core = coreFor(url);
      queueMicrotask(() => this.#open());
    }

    #open(): void {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      const transport: RelayTransport = {
        send: (data) => this.#emit("message", { data }),
        close: () => this.#terminate(),
      };
      // "open" listeners may send immediately; relay frames (e.g. the AUTH
      // challenge) must follow "open", so connect afterwards and flush.
      this.#emit("open", {});
      this.#session = this.#core.connect(transport);
      const queued = this.#queuedSends;
      this.#queuedSends = [];
      for (const data of queued) this.#core.handleMessage(this.#session, data);
    }

    send(data: string): void {
      if (this.readyState !== FakeSocket.OPEN) return;
      this.sent.push(data);
      if (this.#session) this.#core.handleMessage(this.#session, data);
      else this.#queuedSends.push(data);
    }

    close(): void {
      this.#terminate();
    }

    #terminate(): void {
      if (this.readyState === FakeSocket.CLOSING || this.readyState === FakeSocket.CLOSED) {
        this.readyState = FakeSocket.CLOSED;
        return;
      }
      this.readyState = FakeSocket.CLOSED;
      const session = this.#session;
      this.#session = undefined;
      if (session) this.#core.detach(session);
      this.#emit("close", {});
    }

    addEventListener(type: string, listener: Listener): void {
      let set = this.#listeners.get(type);
      if (!set) {
        set = new Set();
        this.#listeners.set(type, set);
      }
      set.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.#listeners.get(type)?.delete(listener);
    }

    #emit(type: string, ev: unknown): void {
      for (const listener of this.#listeners.get(type) ?? []) listener(ev);
    }
  }

  return {
    websocketImplementation: FakeSocket as unknown as WebSocketConstructor,
    relay: coreFor,
    close() {
      for (const core of cores.values()) core.disconnect();
      cores.clear();
    },
  };
}

export type { FakeRelay, FakeRelayOptions, FakeRelayCore };
