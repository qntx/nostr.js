import type { Event } from "../core/event.ts";
import { sortEvents } from "../core/event.ts";
import type { Filter } from "../core/filter.ts";
import { StorageError } from "./error.ts";
import { reqOf } from "./idb-helpers.ts";
import {
  EVENTS,
  TAG_REFS,
  type IDBCursorDirectionLike,
  type IDBCursorLike,
  type IDBIndexLike,
  type IDBKeyRangeLike,
  type IDBObjectStoreLike,
  type IDBRequestLike,
  type IDBTransactionLike,
  type TagRef,
} from "./idb-types.ts";

function compareEventsDesc(
  a: { id: string; created_at: number },
  b: { id: string; created_at: number },
): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id.localeCompare(b.id);
}

export function prefixRange(
  prefix: readonly (string | number)[],
  since?: number,
  until?: number,
): IDBKeyRangeLike {
  return idbKeyRange().bound(
    [...prefix, since ?? 0],
    [...prefix, until ?? Number.MAX_SAFE_INTEGER],
  );
}

function createdAtRange(since?: number, until?: number): IDBKeyRangeLike {
  return idbKeyRange().bound(since ?? 0, until ?? Number.MAX_SAFE_INTEGER);
}

function idbKeyRange(): {
  bound(lower: unknown, upper: unknown, lowerOpen?: boolean, upperOpen?: boolean): IDBKeyRangeLike;
} {
  return (globalThis as unknown as { IDBKeyRange: ReturnType<typeof idbKeyRange> }).IDBKeyRange;
}

export function epTagPrefixes(filter: Filter): Array<{ name: "e" | "p"; value: string }> {
  const out: Array<{ name: "e" | "p"; value: string }> = [];
  for (const name of ["e", "p"] as const) {
    const values = filter[`#${name}`];
    if (!values) continue;
    for (const value of values) out.push({ name, value: value.toLowerCase() });
  }
  return out;
}

type MergeOpener = {
  open(): IDBRequestLike;
  read(
    cursor: IDBCursorLike,
    ok: (event: Event | undefined) => void,
    err: (error: Error) => void,
  ): void;
};

function eventCursor(
  source: {
    openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
  },
  range: IDBKeyRangeLike,
): MergeOpener {
  return {
    open: () => source.openCursor(range, "prev"),
    read: (cursor, ok) => {
      ok(cursor.value as Event);
    },
  };
}

function tagCursor(
  index: IDBIndexLike,
  events: IDBObjectStoreLike,
  range: IDBKeyRangeLike,
): MergeOpener {
  return {
    open: () => index.openCursor(range, "prev"),
    read: (cursor, ok, err) => {
      const row = cursor.value as TagRef;
      const req = events.get(row.id);
      req.onerror = () => err(req.error ?? new StorageError("IndexedDB get failed"));
      req.onsuccess = () => ok(req.result as Event | undefined);
    },
  };
}

export function scanIds(
  tx: IDBTransactionLike,
  filter: Filter,
  accept: (event: Event) => boolean,
  take: (event: Event) => boolean,
): Promise<void> {
  const ids = filter.ids ?? [];
  const events = tx.objectStore(EVENTS);
  const reqs = ids.map((id) => events.get(id.toLowerCase()));
  return Promise.all(reqs.map((req) => reqOf<Event | undefined>(req))).then((rows) => {
    const matched: Event[] = [];
    const seen = new Set<string>();
    for (const event of rows) {
      if (!event || seen.has(event.id) || !accept(event)) continue;
      seen.add(event.id);
      matched.push(event);
    }
    sortEvents(matched);
    const out = filter.limit !== undefined ? matched.slice(0, filter.limit) : matched;
    for (const event of out) {
      if (take(event)) break;
    }
  });
}

/** IDB auto-commits when onsuccess returns with no outstanding requests. */
export function kWayMerge(
  openers: readonly MergeOpener[],
  accept: (event: Event) => boolean,
  take: (event: Event) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (openers.length === 0) {
      resolve();
      return;
    }

    type Slot = { cursor: IDBCursorLike | undefined; head: Event | undefined };
    const slots: Slot[] = openers.map(() => ({ cursor: undefined, head: undefined }));
    const seen = new Set<string>();
    let inflight = 0;
    let phase: "merge" | "drain" | "done" = "merge";
    let drainT = 0;
    let drainBuf: Event[] = [];

    const finish = () => {
      if (phase === "done") return;
      phase = "done";
      resolve();
    };
    const fail = (error: Error) => {
      if (phase === "done") return;
      phase = "done";
      reject(error);
    };

    const stepCursor = (i: number) => {
      const cursor = slots[i]!.cursor;
      if (!cursor) return;
      inflight++;
      cursor.continue();
    };

    const emitDrain = () => {
      sortEvents(drainBuf);
      for (const event of drainBuf) {
        if (seen.has(event.id) || !accept(event)) continue;
        seen.add(event.id);
        if (take(event)) {
          finish();
          return;
        }
      }
      drainBuf = [];
      phase = "merge";
      pump();
    };

    const pump = () => {
      if (phase === "done" || inflight > 0) return;
      if (phase === "drain") {
        emitDrain();
        return;
      }
      let best: Event | undefined;
      for (let i = 0; i < slots.length; i++) {
        const event = slots[i]!.head;
        if (!event) continue;
        if (!best || compareEventsDesc(event, best) < 0) best = event;
      }
      if (!best) {
        finish();
        return;
      }
      phase = "drain";
      drainT = best.created_at;
      drainBuf = [];
      for (let i = 0; i < slots.length; i++) {
        const event = slots[i]!.head;
        if (!event || event.created_at !== drainT) continue;
        drainBuf.push(event);
        slots[i]!.head = undefined;
        stepCursor(i);
      }
      if (inflight === 0) pump();
    };

    const onEvent = (i: number, event: Event | undefined) => {
      if (phase === "done") return;
      const slot = slots[i]!;
      const cursor = slot.cursor;
      if (!event) {
        if (cursor) {
          inflight++;
          cursor.continue();
        } else {
          pump();
        }
        return;
      }
      if (phase === "drain") {
        if (event.created_at === drainT) {
          drainBuf.push(event);
          if (cursor) {
            inflight++;
            cursor.continue();
          } else {
            pump();
          }
          return;
        }
        slot.head = event;
        pump();
        return;
      }
      slot.head = event;
      pump();
    };

    for (let i = 0; i < openers.length; i++) {
      const req = openers[i]!.open();
      req.onerror = () => fail(req.error ?? new StorageError("IndexedDB cursor failed"));
      inflight++;
      req.onsuccess = () => {
        inflight--;
        if (phase === "done") return;
        const cursor = req.result as IDBCursorLike | undefined;
        const slot = slots[i]!;
        if (!cursor) {
          slot.cursor = undefined;
          slot.head = undefined;
          pump();
          return;
        }
        slot.cursor = cursor;
        inflight++;
        openers[i]!.read(
          cursor,
          (event) => {
            inflight--;
            onEvent(i, event);
          },
          (error) => {
            inflight--;
            fail(error);
          },
        );
      };
    }
  });
}

export function scanFilter(
  tx: IDBTransactionLike,
  filter: Filter,
  accept: (event: Event) => boolean,
  take: (event: Event) => boolean,
): Promise<void> {
  if (filter.limit === 0) return Promise.resolve();
  if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) {
    return Promise.resolve();
  }

  if (filter.ids) {
    return scanIds(tx, filter, accept, take);
  }

  const events = tx.objectStore(EVENTS);
  const openers: MergeOpener[] = [];
  if (filter.authors && filter.kinds) {
    const index = events.index("kind_pubkey_created_at");
    for (const kind of filter.kinds) {
      for (const pk of filter.authors) {
        openers.push(
          eventCursor(index, prefixRange([kind, pk.toLowerCase()], filter.since, filter.until)),
        );
      }
    }
  } else if (filter.authors) {
    const index = events.index("pubkey_created_at");
    for (const pk of filter.authors) {
      openers.push(eventCursor(index, prefixRange([pk.toLowerCase()], filter.since, filter.until)));
    }
  } else if (filter.kinds) {
    const index = events.index("kind_created_at");
    for (const kind of filter.kinds) {
      openers.push(eventCursor(index, prefixRange([kind], filter.since, filter.until)));
    }
  } else {
    const tags = epTagPrefixes(filter);
    if (tags.length > 0) {
      const index = tx.objectStore(TAG_REFS).index("name_value_created");
      for (const tag of tags) {
        openers.push(
          tagCursor(index, events, prefixRange([tag.name, tag.value], filter.since, filter.until)),
        );
      }
    } else {
      openers.push(
        eventCursor(events.index("created_at"), createdAtRange(filter.since, filter.until)),
      );
    }
  }
  return kWayMerge(openers, accept, take);
}
