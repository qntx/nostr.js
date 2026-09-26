import { EventBuilder, Keys, type Event } from "../core/index.ts";
import type { Filter } from "../core/filter.ts";
import type { EventStore } from "../storage/types.ts";

export type EventStoreConformanceCase = {
  name: string;
  run(store: EventStore): Promise<void>;
};

const ALICE_SK = "0000000000000000000000000000000000000000000000000000000000000101";
const BOB_SK = "0000000000000000000000000000000000000000000000000000000000000102";

function alice(): Keys {
  return Keys.fromSecretKey(ALICE_SK);
}
function bob(): Keys {
  return Keys.fromSecretKey(BOB_SK);
}

function note(keys: Keys, content: string, createdAt: number, tags: string[][] = []): Event {
  return new EventBuilder(1, content).tags(tags).createdAt(createdAt).signWithKeys(keys);
}

function replaceable(keys: Keys, kind: number, content: string, createdAt: number): Event {
  return new EventBuilder(kind, content).createdAt(createdAt).signWithKeys(keys);
}

function addressable(
  keys: Keys,
  kind: number,
  d: string,
  content: string,
  createdAt: number,
): Event {
  return new EventBuilder(kind, content)
    .tags([["d", d]])
    .createdAt(createdAt)
    .signWithKeys(keys);
}

function fail(message: string): never {
  throw new Error(`EventStore conformance: ${message}`);
}

function eq<T>(got: T, want: T, what: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}

function ids(events: readonly Event[]): string[] {
  return events.map((e) => e.id);
}

/**
 * Framework-agnostic {@link EventStore} conformance cases. Each `run` throws on
 * failure; register them with the test framework of your choice:
 * `for (const c of eventStoreConformanceCases) test(c.name, () => c.run(store()))`.
 */
export const eventStoreConformanceCases: ReadonlyArray<EventStoreConformanceCase> = [
  {
    name: "put accepted then duplicate",
    async run(store) {
      const e = note(alice(), "hello", 1);
      eq(await store.put(e), "accepted", "first put");
      eq(await store.put(e), "duplicate", "second put");
      eq(await store.get(e.id), e, "get after put");
      eq(
        await store.putMany([note(alice(), "a", 2), note(alice(), "b", 3)]),
        ["accepted", "accepted"],
        "putMany results",
      );
    },
  },
  {
    name: "ephemeral event returns ephemeral and is not stored",
    async run(store) {
      const e = replaceable(alice(), 20001, "ephemeral", 1);
      eq(await store.put(e), "ephemeral", "put ephemeral");
      eq(await store.get(e.id), undefined, "ephemeral not retrievable");
      eq(await store.query([{ kinds: [20001] }]), [], "ephemeral not queryable");
      eq(await store.count([{ kinds: [20001] }]), 0, "ephemeral not counted");
    },
  },
  {
    name: "replaceable event keeps newest and rejects stale",
    async run(store) {
      const older = replaceable(alice(), 0, "old", 1);
      const newer = replaceable(alice(), 0, "new", 2);
      eq(await store.put(older), "accepted", "first replaceable");
      eq(await store.put(newer), "replaced", "newer replaces");
      eq(await store.put(older), "rejected", "stale replaceable rejected");
      eq(await store.get(older.id), undefined, "replaced event gone");
      eq(
        ids(await store.query([{ kinds: [0], authors: [alice().publicKey] }])),
        [newer.id],
        "newest kept",
      );
    },
  },
  {
    name: "addressable event replaces by address",
    async run(store) {
      const v1 = addressable(alice(), 30001, "x", "v1", 1);
      const v2 = addressable(alice(), 30001, "x", "v2", 2);
      const other = addressable(alice(), 30001, "y", "other", 3);
      eq(await store.put(v1), "accepted", "first addressable");
      eq(await store.put(v2), "replaced", "same address replaced");
      eq(await store.put(v1), "rejected", "stale addressable rejected");
      eq(await store.put(other), "accepted", "different address independent");
      eq(await store.get(v1.id), undefined, "v1 gone");
      eq(
        ids(await store.query([{ kinds: [30001], authors: [alice().publicKey] }])).sort(),
        [other.id, v2.id].sort(),
        "independent addresses",
      );
    },
  },
  {
    name: "deletion removes same-author e-tag targets only",
    async run(store) {
      const mine = note(alice(), "mine", 1);
      const theirs = note(bob(), "theirs", 1);
      await store.put(mine);
      await store.put(theirs);
      const delForeign = EventBuilder.deletion([theirs.id]).createdAt(2).signWithKeys(alice());
      eq(await store.put(delForeign), "deleted", "kind 5 accepted");
      eq(await store.get(theirs.id), theirs, "other author's event survives");
      const delMine = EventBuilder.deletion([mine.id]).createdAt(3).signWithKeys(alice());
      eq(await store.put(delMine), "deleted", "kind 5 accepted");
      eq(await store.get(mine.id), undefined, "own event deleted");
      eq(await store.query([{ ids: [mine.id] }]), [], "deleted event not queryable");
      eq(await store.put(mine), "duplicate", "deleted event cannot be re-put");
    },
  },
  {
    name: "deletion removes addressable via a tag and tombstones re-put",
    async run(store) {
      const target = addressable(alice(), 30001, "z", "target", 1);
      await store.put(target);
      const coord = `30001:${alice().publicKey}:z`;
      const del = EventBuilder.deletion([], "", { addresses: [coord] })
        .createdAt(2)
        .signWithKeys(alice());
      eq(await store.put(del), "deleted", "a-tag deletion");
      eq(await store.get(target.id), undefined, "addressable deleted");
      const stillCovered = addressable(alice(), 30001, "z", "covered", 1);
      eq(await store.put(stillCovered), "duplicate", "tombstoned address rejects re-put");
      eq(await store.query([{ kinds: [30001], authors: [alice().publicKey] }]), [], "none left");
      const after = addressable(alice(), 30001, "z", "after", 3);
      eq(await store.put(after), "accepted", "events newer than the deletion are kept");
    },
  },
  {
    name: "query orders newest first and applies limit",
    async run(store) {
      const a = note(alice(), "a", 1);
      const b = note(alice(), "b", 3);
      const c = note(alice(), "c", 2);
      await store.putMany([a, b, c]);
      eq(
        ids(await store.query([{ kinds: [1], authors: [alice().publicKey] }])),
        [b.id, c.id, a.id],
        "descending created_at",
      );
      eq(
        ids(await store.query([{ kinds: [1], authors: [alice().publicKey], limit: 2 }])),
        [b.id, c.id],
        "limit applies",
      );
    },
  },
  {
    name: "query filters by kinds, authors, #e, #p, since, until",
    async run(store) {
      const target = note(bob(), "target", 1);
      const tagged = note(alice(), "tagged", 2, [
        ["e", target.id],
        ["p", bob().publicKey],
      ]);
      const plain = note(alice(), "plain", 3);
      await store.putMany([target, tagged, plain]);
      const all = await store.query([{ kinds: [1] }]);
      eq(all.length, 3, "kind filter");
      eq(ids(await store.query([{ authors: [bob().publicKey] }])), [target.id], "authors");
      eq(ids(await store.query([{ "#e": [target.id] }])), [tagged.id], "#e");
      eq(ids(await store.query([{ "#p": [bob().publicKey] }])), [tagged.id], "#p");
      eq(ids(await store.query([{ kinds: [1], since: 2 }])), [plain.id, tagged.id], "since");
      eq(ids(await store.query([{ kinds: [1], until: 2 }])), [tagged.id, target.id], "until");
      eq(
        ids(await store.query([{ ids: [target.id, tagged.id] }])).sort(),
        [tagged.id, target.id].sort(),
        "ids filter",
      );
    },
  },
  {
    name: "count matches query cardinality across overlapping filters",
    async run(store) {
      const a = note(alice(), "a", 1);
      const b = note(bob(), "b", 2);
      await store.putMany([a, b]);
      eq(await store.count([{ kinds: [1] }]), 2, "count all");
      eq(
        await store.count([
          { authors: [alice().publicKey] },
          { authors: [bob().publicKey] },
          { ids: [a.id] },
        ]),
        2,
        "count dedupes union",
      );
      eq(await store.count([{ kinds: [2] }]), 0, "count none");
    },
  },
  {
    name: "negentropyItems sorted by created_at then id and respects limit",
    async run(store) {
      const a = note(alice(), "a", 2);
      const b = note(alice(), "b", 1);
      const c = note(bob(), "c", 3);
      await store.putMany([a, b, c]);
      const items = await store.negentropyItems({ kinds: [1] });
      eq(
        items.map((i) => i.id),
        [b.id, a.id, c.id],
        "created_at asc ordering",
      );
      eq(
        (await store.negentropyItems({ kinds: [1], limit: 2 })).map((i) => i.id),
        [a.id, c.id],
        "limit keeps newest two, presented ascending",
      );
      eq(await store.negentropyItems({ kinds: [2] }), [], "no match");
      const filtered = await store.negentropyItems({ authors: [bob().publicKey] });
      eq(filtered, [{ id: c.id, created_at: 3 }], "filter");
    },
  },
  {
    name: "outbox bounds roundtrip",
    async run(store) {
      eq(await store.getOutboxBound(alice().publicKey, 1), undefined, "unset bound");
      await store.setOutboxBound(alice().publicKey, 1, { oldest: 10, newest: 20 });
      eq(
        await store.getOutboxBound(alice().publicKey, 1),
        { oldest: 10, newest: 20 },
        "bound read",
      );
      await store.setOutboxBound(alice().publicKey, 1, { oldest: 5, newest: 30 });
      eq(
        await store.getOutboxBound(alice().publicKey, 1),
        { oldest: 5, newest: 30 },
        "bound overwrite",
      );
    },
  },
  {
    name: "remove deletes by id and tombstones",
    async run(store) {
      const a = note(alice(), "a", 1);
      await store.put(a);
      eq(await store.remove([a.id]), 1, "remove count");
      eq(await store.get(a.id), undefined, "removed");
      eq(await store.remove([a.id]), 0, "second remove is noop");
      eq(await store.put(a), "duplicate", "removed id tombstoned");
    },
  },
  {
    name: "clear wipes events and bounds",
    async run(store) {
      const a = note(alice(), "a", 1);
      await store.put(a);
      await store.setOutboxBound(alice().publicKey, 1, { oldest: 1, newest: 1 });
      await store.clear();
      eq(await store.get(a.id), undefined, "event gone");
      eq(await store.query([{ kinds: [1] }]), [], "query empty");
      eq(await store.getOutboxBound(alice().publicKey, 1), undefined, "bound gone");
      eq(await store.put(a), "accepted", "store usable after clear");
    },
  },
];

export type { Filter };
