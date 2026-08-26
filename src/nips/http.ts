/**
 * Shared nips HTTP primitive. Not a pack entry (core has zero network).
 * Callers never pass `redirect`; sendManual always sets `"manual"`.
 */

export type ManualFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Blob | FormData | string | null;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type ManualInit = NonNullable<Parameters<ManualFetch>[1]>;

export function requireGlobalFetch(missing: () => Error): ManualFetch {
  if (typeof globalThis.fetch !== "function") throw missing();
  return globalThis.fetch.bind(globalThis) as ManualFetch;
}

/** Always sets redirect:manual. Shared by fetchManual and headStatus. */
export async function sendManual(
  fetchImpl: ManualFetch,
  url: string,
  init: ManualInit,
): Promise<Awaited<ReturnType<ManualFetch>>> {
  return await fetchImpl(url, { ...init, redirect: "manual" } as Parameters<ManualFetch>[1]);
}

export async function fetchManual(
  fetchImpl: ManualFetch,
  url: string,
  init: ManualInit,
  wrapNetwork: (err: unknown) => Error,
): Promise<Awaited<ReturnType<ManualFetch>>> {
  try {
    return await sendManual(fetchImpl, url, init);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw wrapNetwork(err);
  }
}
