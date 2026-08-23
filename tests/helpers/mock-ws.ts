import type { WebSocketConstructor, WebSocketLike } from "../../src/relay/websocket.ts";

type Listener = (ev: unknown) => void;

/** Minimal WebSocket mock for unit tests. */
export class MockWebSocket implements WebSocketLike {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];
  static autoConnect = true;
  /** If set, connect fails. */
  static failConnect = false;

  readyState = MockWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  #listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (MockWebSocket.failConnect) {
        this.readyState = MockWebSocket.CLOSED;
        this.#emit("error", {});
        this.#emit("close", {});
        return;
      }
      if (MockWebSocket.autoConnect) {
        this.readyState = MockWebSocket.OPEN;
        this.#emit("open", {});
      }
    });
  }

  static reset(): void {
    MockWebSocket.instances = [];
    MockWebSocket.autoConnect = true;
    MockWebSocket.failConnect = false;
  }

  static last(): MockWebSocket {
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (!ws) throw new Error("no MockWebSocket instances");
    return ws;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSING || this.readyState === MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSED;
      return;
    }
    this.readyState = MockWebSocket.CLOSED;
    this.#emit("close", {});
  }

  /** Simulate the socket opening (for autoConnect = false tests). */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.#emit("open", {});
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

  /** Deliver a raw relay message string to the client. */
  receive(data: string): void {
    this.#emit("message", { data });
  }

  /** Parse last client message sent on this socket. */
  lastSent(): unknown {
    const raw = this.sent[this.sent.length - 1];
    if (!raw) throw new Error("no messages sent");
    return JSON.parse(raw);
  }

  #emit(type: string, ev: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(ev);
  }
}

export const MockWebSocketCtor = MockWebSocket as unknown as WebSocketConstructor;
