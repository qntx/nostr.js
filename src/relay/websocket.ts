import { RelayConnectionError } from "./error.ts";

/** Minimal WebSocket surface used by Relay (browser or `ws`). */
export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
  ping?(): void;
  /** Node `ws` emits `pong` on the EventEmitter; `addEventListener("pong")` is a no-op. */
  once?(event: string, listener: (...args: unknown[]) => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
};

export type WebSocketConstructor = {
  new (url: string): WebSocketLike;
  readonly OPEN: number;
  readonly CONNECTING: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
};

let impl: WebSocketConstructor | undefined;

try {
  if (typeof globalThis.WebSocket !== "undefined") {
    impl = globalThis.WebSocket as unknown as WebSocketConstructor;
  }
} catch {
  // no global WebSocket
}

/** Inject a WebSocket implementation (required on Node unless undici/global is present). */
export function useWebSocketImplementation(websocketImplementation: WebSocketConstructor): void {
  impl = websocketImplementation;
}

export function getWebSocketImplementation(): WebSocketConstructor {
  if (!impl) {
    throw new RelayConnectionError(
      "No WebSocket implementation available; call useWebSocketImplementation() or run in a browser",
    );
  }
  return impl;
}
