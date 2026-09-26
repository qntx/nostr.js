import type { Event } from "../core/event.ts";
import type { Pool } from "../relay/pool.ts";
import type { ReactiveEventStore } from "../store/reactive.ts";

export type LoaderContextOptions = {
  pool: Pool;
  /** Fallback / discovery relays when no per-user routing is known. */
  relays: readonly string[];
  /** The reactive index loaders read from and feed fetched events into. */
  index: ReactiveEventStore;
  /**
   * Inbound-event sink for fetched events. Defaults to `index.add`; Client
   * supplies its single ingest path so loader fetches get gossip meta and
   * persistence like every other inbound event.
   */
  ingest?: (event: Event, relayUrl: string) => void;
  /** Max age (seconds) before a fetched replaceable is considered stale. Default 2 days. */
  staleAfterSec?: number;
  fetchTimeoutMs?: number;
};

/**
 * Internal dependency bag for loaders — never a module-level singleton.
 */
export class LoaderContext {
  readonly pool: Pool;
  readonly index: ReactiveEventStore;
  readonly ingest: (event: Event, relayUrl: string) => void;
  readonly staleAfterSec: number;
  readonly fetchTimeoutMs: number;
  #relays: string[];

  constructor(opts: LoaderContextOptions) {
    this.pool = opts.pool;
    this.#relays = [...opts.relays];
    this.index = opts.index;
    this.ingest = opts.ingest ?? ((event, relayUrl) => this.index.add(event, relayUrl));
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

  isFresh(fetchedAt: number, now: number = Math.floor(Date.now() / 1000)): boolean {
    return now - fetchedAt < this.staleAfterSec;
  }
}
