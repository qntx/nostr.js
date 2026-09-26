/**
 * Report a user-callback error without aborting sibling work: a throwing
 * listener must not change library state or interrupt the dispatch loop.
 * Prefers the runtime's `reportError` (unhandled-error semantics that still
 * reach `error` event listeners); falls back to a microtask throw.
 */
export function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

/**
 * Invoke a user callback isolated from the caller: a throw is reported via
 * {@link reportError} and never aborts sibling work or alters library state.
 */
export function invokeSafely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    reportError(err);
  }
}
