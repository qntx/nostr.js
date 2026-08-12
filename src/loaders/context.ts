import type { Pool } from "../relay/pool.ts";
import { ReplaceableCache } from "./cache.ts";

export type LoaderContextOptions = {
  pool: Pool;
  /** Fallback / discovery relays when no per-user routing is known. */
  relays: readonly string[];
  cache?: ReplaceableCache;
  /** Max age (seconds) before a cached replaceable is considered stale. Default 2 days. */
  staleAfterSec?: number;
  fetchTimeoutMs?: number;
};

/**
 * Explicit dependency bag for loaders — never a module-level singleton.
 */
export class LoaderContext {
  readonly pool: Pool;
  readonly cache: ReplaceableCache;
  readonly staleAfterSec: number;
  readonly fetchTimeoutMs: number;
  #relays: string[];

  constructor(opts: LoaderContextOptions) {
    this.pool = opts.pool;
    this.#relays = [...opts.relays];
    this.cache = opts.cache ?? new ReplaceableCache();
    this.staleAfterSec = opts.staleAfterSec ?? 60 * 60 * 24 * 2;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 4400;
  }

  /** Snapshot of discovery/fallback relays. */
  get relays(): readonly string[] {
    return this.#relays;
  }

  addRelay(url: string): void {
    if (!this.#relays.includes(url)) this.#relays.push(url);
  }

  removeRelay(url: string): void {
    this.#relays = this.#relays.filter((r) => r !== url);
  }

  setRelays(urls: readonly string[]): void {
    this.#relays = [...urls];
  }

  isFresh(fetchedAt: number, now = Math.floor(Date.now() / 1000)): boolean {
    return now - fetchedAt < this.staleAfterSec;
  }
}
