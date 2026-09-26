import { describe, expect, test, vi } from "vite-plus/test";
import { EventBuilder, Keys, ReactiveEventStore } from "../src/index.ts";
import type { Event } from "../src/core/event.ts";
import { normalizeURL } from "../src/core/util.ts";
import { MemoryIndex } from "../src/storage/memory-index.ts";
import { stubReportError } from "./helpers/report-error.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

const keys = Keys.fromSecretKey(SK);

function note(content: string, created_at: number): Event {
  return EventBuilder.textNote(content).createdAt(created_at).signWithKeys(keys);
}

function kind5(targets: readonly Event[], created_at: number): Event {
  return EventBuilder.deletion(targets.map((t) => t.id))
    .createdAt(created_at)
    .signWithKeys(keys);
}

function meta(created_at: number): Event {
  return EventBuilder.metadata({ name: `n${created_at}` })
    .createdAt(created_at)
    .signWithKeys(keys);
}

function flush(): Promise<void> {
  return Promise.resolve();
}

describe("ReactiveEventStore writes", () => {
  test("duplicate add records seenOn", () => {
    const store = new ReactiveEventStore();
    const e = note("a", 1);
    expect(store.add(e, "wss://a")).toBe("accepted");
    expect(store.add(e, "wss://b")).toBe("duplicate");
    expect(store.seenOn(e.id)).toEqual([normalizeURL("wss://a"), normalizeURL("wss://b")]);
  });

  test("ephemeral events are not stored", () => {
    const store = new ReactiveEventStore();
    const e = new EventBuilder(20001, "gone").createdAt(1).signWithKeys(keys);
    expect(store.add(e)).toBe("ephemeral");
    expect(store.get(e.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("markSeen returns false for unknown ids and does not notify", async () => {
    const store = new ReactiveEventStore();
    const e = note("a", 1);
    const watch = store.watchEvent(e.id);
    const onChange = vi.fn();
    watch.subscribe(onChange);
    expect(store.markSeen(e.id, "wss://x")).toBe(false);
    expect(store.markSeen("ab".repeat(32), "wss://x")).toBe(false);
    store.add(e, "wss://a");
    await flush();
    onChange.mockClear();
    expect(store.markSeen(e.id, "wss://b")).toBe(true);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(store.seenOn(e.id)).toEqual([normalizeURL("wss://a"), normalizeURL("wss://b")]);
  });

  test("seenOn caps at 16 urls per id", () => {
    const store = new ReactiveEventStore();
    const e = note("a", 1);
    store.add(e);
    for (let i = 0; i < 20; i++) store.markSeen(e.id, `wss://r${i}`);
    expect(store.seenOn(e.id)).toHaveLength(16);
    expect(store.seenOn(e.id)[0]).toBe(normalizeURL("wss://r0"));
    expect(store.seenOn(e.id)[15]).toBe(normalizeURL("wss://r15"));
  });

  test("maxSeenOnEntries evicts the oldest id", () => {
    const store = new ReactiveEventStore({ maxSeenOnEntries: 3 });
    const events = [note("a", 1), note("b", 2), note("c", 3), note("d", 4)];
    for (const e of events) store.add(e, `wss://${e.content}`);
    expect(store.seenOn(events[0]!.id)).toEqual([]);
    expect(store.seenOn(events[3]!.id)).toEqual([normalizeURL("wss://d")]);
  });

  test("kind-5 deletion tombstones and isDeleted reports", () => {
    const store = new ReactiveEventStore();
    const e = note("victim", 1);
    store.add(e);
    const del = kind5([e], 2);
    expect(store.add(del)).toBe("deleted");
    expect(store.get(e.id)).toBeUndefined();
    expect(store.isDeleted(e.id)).toBe(true);
  });

  test("remove invalidates and clear empties", async () => {
    const store = new ReactiveEventStore();
    const a = note("a", 1);
    const b = note("b", 2);
    store.add(a);
    store.add(b);
    const watch = store.watchQuery([{ kinds: [1] }]);
    watch.subscribe(() => {});
    expect(watch.getSnapshot()).toHaveLength(2);
    expect(store.remove([a.id])).toBe(1);
    expect(watch.getSnapshot()).toHaveLength(1);
    store.clear();
    expect(watch.getSnapshot()).toHaveLength(0);
    expect(store.size).toBe(0);
  });
});

describe("ReactiveEventStore watches", () => {
  test("multiple writes in one microtask notify once", async () => {
    const store = new ReactiveEventStore();
    const watch = store.watchQuery([{ kinds: [1] }]);
    const onChange = vi.fn();
    watch.subscribe(onChange);
    store.add(note("a", 1));
    store.add(note("b", 2));
    store.add(note("c", 3));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(watch.getSnapshot()).toHaveLength(3);
  });

  test("getSnapshot is referentially stable without writes", () => {
    const store = new ReactiveEventStore();
    const e = note("a", 1);
    store.add(e);
    const watch = store.watchEvent(e.id);
    const first = watch.getSnapshot();
    expect(watch.getSnapshot()).toBe(first);
    const q = store.watchQuery([{ kinds: [1] }]);
    const list = q.getSnapshot();
    expect(q.getSnapshot()).toBe(list);
  });

  test("unrelated writes do not invalidate a watchQuery snapshot", async () => {
    const store = new ReactiveEventStore();
    const watch = store.watchQuery([{ kinds: [1] }]);
    const before = watch.getSnapshot();
    const onChange = vi.fn();
    watch.subscribe(onChange);
    store.add(meta(1)); // kind 0 — does not match kinds:[1]
    store.add(new EventBuilder(7, "x").createdAt(1).signWithKeys(keys));
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(watch.getSnapshot()).toBe(before);
  });

  test("subscribed watchQuery does not recompute after an unrelated write", async () => {
    const store = new ReactiveEventStore();
    const watch = store.watchQuery([{ kinds: [1] }]);
    const spy = vi.spyOn(store, "query");
    watch.subscribe(() => {});
    watch.getSnapshot();
    watch.getSnapshot();
    // constructor snapshot is reused; no recompute without invalidation
    expect(spy).not.toHaveBeenCalled();
    store.add(meta(1)); // kind 0 — does not match kinds:[1]
    await flush();
    watch.getSnapshot();
    expect(spy).not.toHaveBeenCalled();
    // a matching write dirties the watch → next getSnapshot recomputes
    store.add(note("a", 1));
    await flush();
    expect(watch.getSnapshot()).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("subscribe after unregistered writes reflects them in getSnapshot", async () => {
    const store = new ReactiveEventStore();
    const watch = store.watchQuery([{ kinds: [1] }]);
    watch.getSnapshot(); // constructor-computed snapshot, unsubscribed
    const e = note("a", 1);
    store.add(e); // write while unregistered
    const onChange = vi.fn();
    watch.subscribe(onChange);
    expect(watch.getSnapshot().map((x) => x.id)).toEqual([e.id]);
    await flush();
    // no new write since subscribe → still no notification
    expect(onChange).not.toHaveBeenCalled();
    store.add(note("b", 2));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(watch.getSnapshot()).toHaveLength(2);
  });

  test("unsubscribed watch recomputes on version change but keeps identical reference", async () => {
    const store = new ReactiveEventStore();
    const a = note("a", 1);
    store.add(a);
    const watch = store.watchQuery([{ kinds: [1] }]);
    const before = watch.getSnapshot();
    // relevant shape but identical content: replaceable rewrite keeps same event ref set
    const sameA = { ...a };
    store.add(sameA); // duplicate — version unchanged in effect but index.put runs
    expect(watch.getSnapshot()).toBe(before);
    // a relevant new event changes the snapshot
    const b = note("b", 2);
    store.add(b);
    const after = watch.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.map((e) => e.id)).toEqual([b.id, a.id]);
  });

  test("shared watch for equal filters and StrictMode re-subscribe keeps registration", async () => {
    const store = new ReactiveEventStore();
    const w1 = store.watchQuery([{ kinds: [1] }]);
    const w2 = store.watchQuery([{ kinds: [1] }]);
    expect(w2).toBe(w1);
    expect(store.watchQuery([{ kinds: [1] }])).toBe(w1);

    // StrictMode: subscribe → unsubscribe → subscribe within the same task
    const onChange = vi.fn();
    const un1 = w1.subscribe(onChange);
    un1();
    w1.subscribe(onChange);
    const e = note("a", 1);
    store.add(e);
    await flush();
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("replaceable replacement invalidates watchReplaceable and old event leaves watchQuery", async () => {
    const store = new ReactiveEventStore();
    const watchMeta = store.watchReplaceable(0, keys.publicKey);
    const watchNotes = store.watchQuery([{ kinds: [0] }]);
    const onMeta = vi.fn();
    const onNotes = vi.fn();
    watchMeta.subscribe(onMeta);
    watchNotes.subscribe(onNotes);

    const m1 = meta(1);
    store.add(m1);
    await flush();
    expect(watchMeta.getSnapshot()?.id).toBe(m1.id);

    const m2 = meta(2);
    store.add(m2);
    await flush();
    expect(watchMeta.getSnapshot()?.id).toBe(m2.id);
    expect(watchNotes.getSnapshot().map((e) => e.id)).toEqual([m2.id]);
    expect(store.get(m1.id)).toBeUndefined();
  });

  test("kind-5 deletion invalidates watchEvent", async () => {
    const store = new ReactiveEventStore();
    const e = note("victim", 1);
    store.add(e);
    const watch = store.watchEvent(e.id);
    const onChange = vi.fn();
    watch.subscribe(onChange);
    store.add(kind5([e], 2));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(watch.getSnapshot()).toBeUndefined();
  });

  test("onInsert fires synchronously for accepted, replaced and deletion events", () => {
    const store = new ReactiveEventStore();
    const inserted: string[] = [];
    store.onInsert((e) => inserted.push(e.id));
    const a = note("a", 1);
    const m = meta(2);
    const del = kind5([a], 3);
    store.add(a);
    store.add(m);
    store.add(del);
    expect(inserted).toEqual([a.id, m.id, del.id]);
  });
});

describe("ReactiveEventStore LRU", () => {
  test("evicts oldest beyond maxEvents, never watched or replaceable events", () => {
    const store = new ReactiveEventStore({ maxEvents: 5 });
    const watched = note("watched", 0);
    const replaceable = meta(1);
    store.add(watched);
    store.add(replaceable);
    const watch = store.watchEvent(watched.id);
    watch.subscribe(() => {});
    watch.getSnapshot();

    const rest: Event[] = [];
    for (let i = 0; i < 10; i++) {
      const e = note(`r${i}`, 10 + i);
      rest.push(e);
      store.add(e);
    }

    expect(store.size).toBeLessThanOrEqual(5);
    // watched + replaceable survive regardless of recency
    expect(store.get(watched.id)?.id).toBe(watched.id);
    expect(store.get(replaceable.id)?.id).toBe(replaceable.id);
    // oldest unwatched regular events are gone
    expect(store.get(rest[0]!.id)).toBeUndefined();
    // eviction does not tombstone
    expect(store.isDeleted(rest[0]!.id)).toBe(false);
  });

  test("recent access protects events from eviction", () => {
    const store = new ReactiveEventStore({ maxEvents: 3 });
    const a = note("a", 1);
    const b = note("b", 2);
    const c = note("c", 3);
    store.add(a);
    store.add(b);
    store.add(c);
    // touch a → b becomes oldest
    store.get(a.id);
    const d = note("d", 4);
    store.add(d);
    expect(store.get(a.id)?.id).toBe(a.id);
    expect(store.get(b.id)).toBeUndefined();
  });
});

describe("issue #125", () => {
  test("#7 query and hydrate keep LRU order (newest stay hottest)", () => {
    const store = new ReactiveEventStore({ maxEvents: 3 });
    const notes = [1, 2, 3, 4].map((t) => note(`n${t}`, t));
    for (const n of notes) store.add(n);
    store.query([{ kinds: [1] }]);
    store.add(note("n5", 5));
    // t2 is least-recently-used; t4 (just returned by query) must survive
    expect(store.query([{ kinds: [1] }]).map((e) => e.created_at)).toEqual([5, 4, 3]);

    const hydrated = new ReactiveEventStore({ maxEvents: 2 });
    hydrated.hydrate([notes[2]!, notes[1]!, notes[0]!]);
    expect(hydrated.query([{ kinds: [1] }]).map((e) => e.created_at)).toEqual([3, 2]);
  });

  test("#8 a watched query does not evict the event just inserted", async () => {
    const store = new ReactiveEventStore({ maxEvents: 2 });
    const n1 = note("n1", 1);
    const n2 = note("n2", 2);
    const n3 = note("n3", 3);
    store.add(n1);
    store.add(n2);
    const watch = store.watchQuery([{ kinds: [1] }]);
    watch.subscribe(() => {});
    watch.getSnapshot();

    store.add(n3);
    expect(store.get(n3.id)).toBeDefined();
    await flush();
    await flush();
    expect(watch.getSnapshot().map((e) => e.id)).toContain(n3.id);
  });

  test("#10 notifications survive re-entrant adds and isolate a throwing subscriber", async () => {
    const store = new ReactiveEventStore();
    const a = note("a", 1);
    const b = note("b", 2);

    // a re-entrant add inside onChange must trigger a second notification
    const watch = store.watchQuery([{ kinds: [1] }]);
    let calls = 0;
    watch.subscribe(() => {
      calls += 1;
      if (calls === 1) store.add(b);
    });
    watch.getSnapshot();
    store.add(a);
    await flush();
    await flush();
    await flush();
    expect(calls).toBe(2);
    expect(watch.getSnapshot()).toHaveLength(2);

    // a throwing watchEvent subscriber must not starve a later watchQuery
    const c = note("c", 3);
    const boom = new Error("boom");
    store.watchEvent(c.id).subscribe(() => {
      throw boom;
    });
    const queryWatch = store.watchQuery([{ kinds: [1] }]);
    let queryCalls = 0;
    queryWatch.subscribe(() => {
      queryCalls += 1;
    });

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    const { reported, restore } = stubReportError();
    process.on("uncaughtException", onUncaught);
    try {
      store.add(c);
      await flush();
      await flush();
      await flush();
    } finally {
      restore();
      process.removeListener("uncaughtException", onUncaught);
    }
    expect(queryCalls).toBe(1);
    expect(reported).toContain(boom);
  });

  test("#12 uppercase event fields and deletion coordinate casing normalize correctly", () => {
    // (a) a non-canonical event is invalid; uppercase lookup arguments still match
    const store = new ReactiveEventStore();
    const e = note("upper", 1);
    expect(
      store.add(
        { ...e, id: e.id.toUpperCase(), pubkey: e.pubkey.toUpperCase() },
        "wss://r.example",
      ),
    ).toBe("invalid");
    expect(store.get(e.id)).toBeUndefined();
    expect(store.add(e, "wss://r.example")).toBe("accepted");
    expect(store.get(e.id.toUpperCase())?.id).toBe(e.id);
    expect(store.seenOn(e.id)).toEqual([normalizeURL("wss://r.example")]);

    // (b) isDeleted coordinates are case-insensitive and cleared by a newer replacement
    const index = new MemoryIndex();
    const coord = `30001:${keys.publicKey}:z`;
    const upperCoord = `30001:${keys.publicKey.toUpperCase()}:z`;
    const v1 = EventBuilder.textNote("before")
      .kind(30001)
      .tag(["d", "z"])
      .createdAt(1)
      .signWithKeys(keys);
    const del = EventBuilder.deletion([{ address: coord }], "gone")
      .createdAt(2)
      .signWithKeys(keys);
    const v3 = EventBuilder.textNote("after")
      .kind(30001)
      .tag(["d", "z"])
      .createdAt(3)
      .signWithKeys(keys);
    index.put(v1);
    index.put(del);
    expect(index.isDeleted(coord)).toBe(true);
    expect(index.isDeleted(upperCoord)).toBe(true);
    index.put(v3);
    expect(index.getByAddress(coord)?.content).toBe("after");
    expect(index.isDeleted(coord)).toBe(false);
  });

  test("#13 watchQuery cache entries are released after unsubscribe", async () => {
    const store = new ReactiveEventStore();
    const filterSets = [[{ kinds: [1] }], [{ kinds: [3] }], [{ kinds: [1], limit: 5 }]];
    const watches = filterSets.map((filters) => store.watchQuery(filters));
    for (const watch of watches) {
      const unsubscribe = watch.subscribe(() => {});
      unsubscribe();
    }
    await flush();
    await flush();
    for (let i = 0; i < filterSets.length; i++) {
      expect(store.watchQuery(filterSets[i]!)).not.toBe(watches[i]);
    }
  });
});
