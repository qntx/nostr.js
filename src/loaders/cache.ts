import type { Event } from "../core/event.ts";

export type ReplaceableKey = {
  kind: number;
  pubkey: string;
  dTag?: string;
};

function keyOf(spec: ReplaceableKey): string {
  return `${spec.kind}:${spec.pubkey.toLowerCase()}:${spec.dTag ?? ""}`;
}

/** In-memory replaceable-event cache used by loaders (no DOM / localStorage). */
export class ReplaceableCache {
  #events = new Map<string, { event: Event | null; fetchedAt: number }>();

  get(spec: ReplaceableKey): { event: Event | null; fetchedAt: number } | undefined {
    return this.#events.get(keyOf(spec));
  }

  set(spec: ReplaceableKey, event: Event | null, fetchedAt = Math.floor(Date.now() / 1000)): void {
    this.#events.set(keyOf(spec), { event, fetchedAt });
  }

  /** Keep newer event by created_at. */
  putIfNewer(event: Event, dTag?: string): void {
    const spec: ReplaceableKey = { kind: event.kind, pubkey: event.pubkey, dTag };
    const prev = this.get(spec);
    if (!prev?.event || prev.event.created_at < event.created_at) {
      this.set(spec, event);
    }
  }

  clear(spec?: ReplaceableKey): void {
    if (spec) this.#events.delete(keyOf(spec));
    else this.#events.clear();
  }

  get size(): number {
    return this.#events.size;
  }
}
