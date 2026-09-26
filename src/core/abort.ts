export function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Race `promise` against the caller's `signal` without cancelling the shared
 * work: on abort the returned promise rejects with `signal.reason` (or an
 * `AbortError`-named Error) while `promise` itself keeps running. With no
 * signal the original promise is returned.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    const done = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (err: unknown) => {
        done();
        reject(err);
      },
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
