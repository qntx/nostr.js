import type { Event } from "./event.ts";
import { isAddressableKind, isReplaceableKind } from "./kind.ts";

/** NIP-01 filter object (immutable-friendly; callers may still pass plain objects). */
export type Filter = {
  readonly ids?: readonly string[];
  readonly kinds?: readonly number[];
  readonly authors?: readonly string[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly search?: string;
  readonly [key: `#${string}`]: readonly string[] | undefined;
};

export function matchFilter(filter: Filter, event: Event): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;

  for (const key of Object.keys(filter)) {
    if (key[0] !== "#") continue;
    const tagName = key.slice(1);
    const values = filter[`#${tagName}`];
    if (!values) continue;
    const hit = event.tags.some(
      (tag) => tag[0] === tagName && tag[1] !== undefined && values.includes(tag[1]),
    );
    if (!hit) return false;
  }

  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  return true;
}

export function matchFilters(filters: readonly Filter[], event: Event): boolean {
  for (const filter of filters) {
    if (matchFilter(filter, event)) return true;
  }
  return false;
}

/** Merge filters by unioning list fields; returns a new plain object. */
export function mergeFilters(...filters: Filter[]): Filter {
  const result: Record<string, unknown> = {};
  for (const filter of filters) {
    for (const [property, values] of Object.entries(filter)) {
      if (
        property === "kinds" ||
        property === "ids" ||
        property === "authors" ||
        property[0] === "#"
      ) {
        const list = (result[property] as (string | number)[] | undefined) ?? [];
        for (const value of values as readonly (string | number)[]) {
          if (!list.includes(value)) list.push(value);
        }
        result[property] = list;
      }
    }
    if (filter.limit !== undefined) {
      const prev = result.limit as number | undefined;
      if (prev === undefined || filter.limit > prev) result.limit = filter.limit;
    }
    if (filter.until !== undefined) {
      const prev = result.until as number | undefined;
      if (prev === undefined || filter.until > prev) result.until = filter.until;
    }
    if (filter.since !== undefined) {
      const prev = result.since as number | undefined;
      if (prev === undefined || filter.since < prev) result.since = filter.since;
    }
    if (filter.search !== undefined) {
      result.search = filter.search;
    }
  }
  return result as Filter;
}

/**
 * Intrinsic upper bound implied by the filter alone.
 * Returns a positive integer, or `Infinity` when unbounded.
 */
export function getFilterLimit(filter: Filter): number {
  if (filter.ids && filter.ids.length === 0) return 0;
  if (filter.kinds && filter.kinds.length === 0) return 0;
  if (filter.authors && filter.authors.length === 0) return 0;

  let limit = Infinity;
  if (filter.ids) limit = Math.min(limit, filter.ids.length);
  if (filter.limit !== undefined) limit = Math.min(limit, filter.limit);

  if (filter.kinds && filter.authors) {
    const allReplaceable = filter.kinds.every((k) => isReplaceableKind(k) || isAddressableKind(k));
    if (allReplaceable) {
      const dTags = filter["#d"];
      const perAuthor = dTags && dTags.length > 0 ? dTags.length : 1;
      limit = Math.min(limit, filter.authors.length * filter.kinds.length * perAuthor);
    }
  }

  return limit;
}

/** Shallow-clone a filter (for per-relay narrowing). */
export function cloneFilter(filter: Filter): Filter {
  return { ...filter };
}
