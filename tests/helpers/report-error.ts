/**
 * Capture `globalThis.reportError` calls for the duration of a test.
 * Runner-agnostic (bun:test has no `vi.stubGlobal`): assign directly and
 * restore the previous value in a `finally`.
 */
export function stubReportError(): { reported: unknown[]; restore: () => void } {
  const reported: unknown[] = [];
  const g = globalThis as { reportError?: (error: unknown) => void };
  const prev = g.reportError;
  g.reportError = (err: unknown) => {
    reported.push(err);
  };
  return {
    reported,
    restore: () => {
      if (prev === undefined) delete g.reportError;
      else g.reportError = prev;
    },
  };
}
