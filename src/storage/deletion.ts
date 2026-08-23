import type { Event } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import { eventAddress, parseEventAddress } from "../core/tag.ts";
import { isHex32 } from "../core/util.ts";

export type DeletionPlan = {
  /** Stored events validated as same-pubkey (not kind 5) and to be removed now. */
  removeIds: string[];
  /** Referenced ids not in the store; remember deletion pubkey until the event arrives. */
  pendingIds: Array<{ id: string; pubkey: string }>;
  /** Replaceable/addressable coordinates tombstoned up to `until` (deletion created_at). */
  coordinates: Array<{ key: string; until: number }>;
};

/**
 * NIP-09 application plan for a kind 5 event.
 *
 * - `e` tags: delete only when the target exists, is not itself kind 5, and shares pubkey.
 * - Unknown `e` ids are pending until the event arrives (client MUST validate pubkey).
 * - `a` tags: tombstone that coordinate up to this deletion's `created_at` when pubkey matches.
 * - Deleting a deletion request is a no-op.
 */
export function planDeletion(
  deletion: Pick<Event, "pubkey" | "created_at" | "tags">,
  getById: (id: string) => Pick<Event, "id" | "pubkey" | "kind"> | undefined,
): DeletionPlan {
  const pubkey = deletion.pubkey.toLowerCase();
  const removeIds: string[] = [];
  const pendingIds: Array<{ id: string; pubkey: string }> = [];
  const coordinates: Array<{ key: string; until: number }> = [];
  const seenIds = new Set<string>();
  const seenCoords = new Set<string>();

  for (const tag of deletion.tags) {
    if (tag[0] === "e" && tag[1] && isHex32(tag[1])) {
      const id = tag[1].toLowerCase();
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const existing = getById(id);
      if (!existing) {
        pendingIds.push({ id, pubkey });
        continue;
      }
      if (existing.kind === Kind.EventDeletion) continue;
      if (existing.pubkey.toLowerCase() !== pubkey) continue;
      removeIds.push(id);
      continue;
    }

    if (tag[0] === "a" && tag[1]) {
      const coord = parseEventAddress(tag[1]);
      if (!coord || coord.pubkey !== pubkey) continue;
      const key = `${coord.kind}:${coord.pubkey}:${coord.identifier}`;
      if (seenCoords.has(key)) continue;
      seenCoords.add(key);
      coordinates.push({ key, until: deletion.created_at });
    }
  }

  return { removeIds, pendingIds, coordinates };
}

/** In-memory NIP-09 tombstones shared by MemoryEventStore and IndexedDbEventStore. */
export class DeletionState {
  readonly ids = new Set<string>();
  readonly pending = new Map<string, string>();
  readonly coordinates = new Map<string, number>();

  clear(): void {
    this.ids.clear();
    this.pending.clear();
    this.coordinates.clear();
  }

  covers(event: Pick<Event, "id" | "pubkey" | "kind" | "created_at" | "tags">): boolean {
    if (this.ids.has(event.id)) return true;
    if (event.kind === Kind.EventDeletion) return false;
    const pendingPk = this.pending.get(event.id);
    if (pendingPk && event.pubkey.toLowerCase() === pendingPk) return true;
    const addr = eventAddress(event);
    if (!addr) return false;
    const until = this.coordinates.get(addr);
    return until !== undefined && event.created_at <= until;
  }

  absorb(plan: DeletionPlan): void {
    for (const id of plan.removeIds) {
      this.ids.add(id);
      this.pending.delete(id);
    }
    for (const p of plan.pendingIds) {
      if (!this.ids.has(p.id)) this.pending.set(p.id, p.pubkey);
    }
    for (const c of plan.coordinates) {
      const prev = this.coordinates.get(c.key) ?? Number.NEGATIVE_INFINITY;
      this.coordinates.set(c.key, Math.max(prev, c.until));
    }
  }
}

export function coordinateRemovals(
  coordinates: readonly { key: string; until: number }[],
  getCurrent: (key: string) => Pick<Event, "id" | "created_at"> | undefined,
): string[] {
  const ids: string[] = [];
  for (const c of coordinates) {
    const current = getCurrent(c.key);
    if (current && current.created_at <= c.until) ids.push(current.id);
  }
  return ids;
}
