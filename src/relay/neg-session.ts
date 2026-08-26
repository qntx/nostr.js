import type { Filter } from "../core/filter.ts";
import type { ClientMessage } from "../core/message.ts";
import { Nip77Error, runNegSession, type NegentropyStorageVector } from "../nips/nip77.ts";
import { RelayConnectionError, RelayPublishError } from "./error.ts";

export type NegSession = {
  queue: string[];
  waiter:
    | {
        resolve: (hex: string) => void;
        reject: (err: Error) => void;
      }
    | undefined;
  error: Error | undefined;
};

export function createNegSession(): NegSession {
  return { queue: [], waiter: undefined, error: undefined };
}

export function pushNegMsg(session: NegSession, hex: string): void {
  if (session.waiter) {
    const waiter = session.waiter;
    session.waiter = undefined;
    waiter.resolve(hex);
  } else {
    session.queue.push(hex);
  }
}

export function failNegSession(session: NegSession, err: Error): void {
  session.error = err;
  if (session.waiter) {
    const waiter = session.waiter;
    session.waiter = undefined;
    waiter.reject(err);
  }
}

export function failNegErr(session: NegSession, reason: string): void {
  failNegSession(session, new Nip77Error(reason));
}

/** Wire queue/timeout/abort around `runNegSession`. Not a second session class. */
export async function runWiredNegSession(opts: {
  session: NegSession;
  storage: NegentropyStorageVector;
  filter: Filter;
  id: string;
  timeoutMs: number;
  signal?: AbortSignal;
  send: (message: ClientMessage) => void;
  url: string;
}): Promise<{ have: string[]; need: string[] }> {
  const { session, storage, filter, id, timeoutMs, signal, send, url } = opts;
  const deadline = Date.now() + timeoutMs;

  const timedOut = (): RelayPublishError => new RelayPublishError("negentropy timed out", url);

  const remainingMs = (): number => deadline - Date.now();

  const next = (): Promise<string> => {
    if (session.error) return Promise.reject(session.error);
    if (remainingMs() <= 0) return Promise.reject(timedOut());
    const queued = session.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.waiter = undefined;
        reject(timedOut());
      }, remainingMs());
      const fail = (err: Error): void => {
        clearTimeout(timer);
        session.waiter = undefined;
        reject(err);
      };
      const onAbort = (): void => fail(new RelayConnectionError("negentropy aborted", url));
      session.waiter = {
        resolve: (hex) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(hex);
        },
        reject: (err) => fail(err),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return await runNegSession({
    storage,
    openingSend: (hex) => {
      send(["NEG-OPEN", id, filter, hex]);
    },
    msgSend: (hex) => {
      send(["NEG-MSG", id, hex]);
    },
    next,
  });
}
