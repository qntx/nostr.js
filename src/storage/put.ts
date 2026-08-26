import type { Event } from "../core/event.ts";
import { isReplaceableWinner } from "../core/event.ts";
import { isEphemeralKind, Kind } from "../core/kind.ts";
import { eventAddress } from "../core/tag.ts";
import {
  coordinateRemovals,
  planDeletion,
  type DeletionPlan,
  type DeletionState,
} from "./deletion.ts";
import type { PutResult } from "./types.ts";

export function normalizeEvent(event: Event): Event {
  const id = event.id.toLowerCase();
  const pubkey = event.pubkey.toLowerCase();
  if (id === event.id && pubkey === event.pubkey) return event;
  return { ...event, id, pubkey };
}

export function outboxBoundKey(pubkey: string, kind: number): string {
  return `${pubkey.toLowerCase()}:${kind}`;
}

export type PutDecision =
  | { action: "skip"; result: "duplicate" | "ephemeral" | "rejected"; event: Event }
  | { action: "tombstone"; result: "duplicate"; event: Event }
  | { action: "delete"; result: "deleted"; event: Event; plan: DeletionPlan; coordIds: string[] }
  | {
      action: "insert";
      result: "accepted" | "replaced";
      event: Event;
      address?: string;
      replaceId?: string;
    };

export type PutLookup = {
  deletion: DeletionState;
  getById: (
    id: string,
  ) => Pick<Event, "id" | "pubkey" | "kind" | "created_at" | "tags"> | undefined;
  getReplaceable: (address: string) => Pick<Event, "id" | "created_at"> | undefined;
};

export function decidePut(raw: Event, lookup: PutLookup): PutDecision {
  const event = normalizeEvent(raw);
  if (lookup.deletion.ids.has(event.id) || lookup.getById(event.id)) {
    return { action: "skip", result: "duplicate", event };
  }
  if (event.kind === Kind.EventDeletion) {
    const plan = planDeletion(event, lookup.getById);
    const coordIds = coordinateRemovals(plan.coordinates, lookup.getReplaceable);
    return { action: "delete", result: "deleted", event, plan, coordIds };
  }
  if (lookup.deletion.covers(event)) return { action: "tombstone", result: "duplicate", event };
  if (isEphemeralKind(event.kind)) return { action: "skip", result: "ephemeral", event };
  const address = eventAddress(event);
  if (address) {
    const prev = lookup.getReplaceable(address);
    if (prev && !isReplaceableWinner(event, prev)) {
      return { action: "skip", result: "rejected", event };
    }
    return {
      action: "insert",
      result: prev ? "replaced" : "accepted",
      event,
      address,
      replaceId: prev?.id,
    };
  }
  return { action: "insert", result: "accepted", event };
}

export function applyPutMemory(
  s: {
    deletion: DeletionState;
    indexInsert(event: Event): void;
    indexRemove(id: string): boolean;
  },
  d: PutDecision,
): PutResult {
  switch (d.action) {
    case "skip":
      return d.result;
    case "tombstone":
      s.deletion.ids.add(d.event.id);
      s.deletion.pending.delete(d.event.id);
      return "duplicate";
    case "delete":
      s.deletion.pending.delete(d.event.id);
      s.deletion.absorb(d.plan);
      for (const id of d.plan.removeIds) s.indexRemove(id);
      for (const id of d.coordIds) {
        s.deletion.ids.add(id);
        s.indexRemove(id);
      }
      s.indexInsert(d.event);
      return "deleted";
    case "insert":
      if (d.replaceId) s.indexRemove(d.replaceId);
      s.indexInsert(d.event);
      return d.result;
  }
}
