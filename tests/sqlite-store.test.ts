import { describe, expect, test } from "vite-plus/test";
import { EventBuilder, Keys, SqliteEventStore, StorageError, type Event } from "../src/index.ts";
import { eventStoreConformanceCases } from "../src/testing/index.ts";
import { SqliteTestDriver } from "./helpers/sqlite-driver.ts";

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

async function openStore(): Promise<{ driver: SqliteTestDriver; store: SqliteEventStore }> {
  const driver = await SqliteTestDriver.open();
  return { driver, store: await SqliteEventStore.open(driver) };
}

describe("SqliteEventStore conformance", () => {
  for (const c of eventStoreConformanceCases) {
    test(c.name, async () => {
      const { driver, store } = await openStore();
      try {
        await c.run(store);
      } finally {
        driver.close();
      }
    });
  }
});

describe("SqliteEventStore", () => {
  test("putMany rolls back the whole batch on a mid-batch driver failure", async () => {
    const { driver, store } = await openStore();
    try {
      const first = note(alice(), "first", 1);
      const second = note(alice(), "second", 2, [["e", "aa".repeat(32)]]);
      // Fail the second event insert; the batch transaction must roll back.
      driver.failOn(/^INSERT INTO events/, { skip: 1 });
      let err: unknown;
      try {
        await store.putMany([first, second]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(StorageError);
      expect(await store.get(first.id)).toBeUndefined();
      expect(await store.get(second.id)).toBeUndefined();
      expect(await store.count([{ kinds: [1] }])).toBe(0);
      // The driver recovers and the store keeps working.
      expect(await store.put(first)).toBe("accepted");
    } finally {
      driver.close();
    }
  });

  test("reopen on the same database preserves data and tombstones", async () => {
    const { driver } = await openStore();
    try {
      const first = await SqliteEventStore.open(driver);
      const kept = note(alice(), "kept", 1);
      // Deleted before arrival: leaves a `pending` tombstone, not a row.
      const pending = note(alice(), "pending target", 5);
      const removed = note(alice(), "removed", 3, [["d", "x"]]);
      const addressable = new EventBuilder(30001, "v")
        .tags([["d", "x"]])
        .createdAt(2)
        .signWithKeys(alice());
      await first.putMany([kept, removed, addressable]);
      await first.remove([removed.id]);

      const delPending = EventBuilder.deletion([pending.id]).createdAt(4).signWithKeys(alice());
      // The coordinate tombstone must be authored by the address owner.
      const coord = `30001:${alice().publicKey}:x`;
      const delCoord = EventBuilder.deletion([{ address: coord }], "")
        .createdAt(4)
        .signWithKeys(alice());
      await first.putMany([delPending, delCoord]);

      const second = await SqliteEventStore.open(driver);
      expect(await second.get(kept.id)).toEqual(kept);
      expect(await second.put(kept)).toBe("duplicate");
      // Pending tombstone: the deleted-before-arrival event is rejected.
      expect(await second.put(pending)).toBe("duplicate");
      // Coordinate tombstone: a stale version of the address cannot return.
      const stale = new EventBuilder(30001, "stale")
        .tags([["d", "x"]])
        .createdAt(3)
        .signWithKeys(alice());
      expect(await second.put(stale)).toBe("duplicate");
      // Removed ids stay tombstoned across reopen.
      expect(await second.put(removed)).toBe("duplicate");
      // A newer version newer than the tombstone is still accepted.
      const fresh = new EventBuilder(30001, "fresh")
        .tags([["d", "x"]])
        .createdAt(9)
        .signWithKeys(alice());
      expect(await second.put(fresh)).toBe("accepted");
      expect((await second.get(fresh.id))?.content).toBe("fresh");
    } finally {
      driver.close();
    }
  });

  test("#e and #p tag filters match case-insensitively", async () => {
    const { driver, store } = await openStore();
    try {
      const refId = "AB".repeat(32);
      const refPk = "CD".repeat(32);
      const tagged = note(alice(), "tagged", 1, [
        ["e", refId.toLowerCase()],
        ["p", refPk.toLowerCase()],
      ]);
      await store.put(tagged);
      expect(await store.query([{ "#e": [refId] }])).toHaveLength(1);
      expect(await store.query([{ "#p": [refPk] }])).toHaveLength(1);
      expect(await store.query([{ "#e": [refId.toLowerCase()] }])).toHaveLength(1);
      expect(await store.query([{ "#e": ["00".repeat(32)] }])).toHaveLength(0);
    } finally {
      driver.close();
    }
  });

  test("filters with more than 500 ids or authors are chunked", async () => {
    const { driver, store } = await openStore();
    try {
      const mine = note(alice(), "mine", 1);
      const theirs = note(bob(), "theirs", 2);
      await store.putMany([mine, theirs]);
      const filler = (n: number): string[] =>
        Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
      const manyIds = [...filler(600), mine.id];
      expect((await store.query([{ ids: manyIds }])).map((e) => e.id)).toEqual([mine.id]);
      const manyAuthors = [...filler(600), alice().publicKey];
      expect((await store.query([{ authors: manyAuthors }])).map((e) => e.id)).toEqual([mine.id]);
      expect(await store.count([{ ids: manyIds, kinds: [1] }])).toBe(1);
      expect((await store.negentropyItems({ ids: manyIds })).map((i) => i.id)).toEqual([mine.id]);
    } finally {
      driver.close();
    }
  });

  test("addressable replacement keeps exactly one row per address", async () => {
    const { driver, store } = await openStore();
    try {
      const put = (content: string, createdAt: number): Event =>
        new EventBuilder(30001, content)
          .tags([["d", "x"]])
          .createdAt(createdAt)
          .signWithKeys(alice());
      const v1 = put("v1", 1);
      const v2 = put("v2", 2);
      const v3 = put("v3", 3);
      expect(await store.putMany([v1, v2, v3])).toEqual(["accepted", "replaced", "replaced"]);
      const rows = await driver.all<{ id: string }>(`SELECT id FROM events WHERE address = ?`, [
        `30001:${alice().publicKey}:x`,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(v3.id);
      expect((await store.query([{ kinds: [30001] }])).map((e) => e.id)).toEqual([v3.id]);
      expect(await store.get(v1.id)).toBeUndefined();
    } finally {
      driver.close();
    }
  });

  test("kind-5 deletion with more than 500 a tags is chunked", async () => {
    const { driver, store } = await openStore();
    try {
      const target = new EventBuilder(30001, "target")
        .tags([["d", "x"]])
        .createdAt(1)
        .signWithKeys(alice());
      const keep = new EventBuilder(30001, "keep")
        .tags([["d", "y"]])
        .createdAt(1)
        .signWithKeys(alice());
      await store.putMany([target, keep]);

      const targets: { address: string }[] = [];
      for (let i = 0; i < 599; i++) {
        targets.push({ address: `30001:${(i + 1).toString(16).padStart(64, "0")}:z` });
      }
      targets.push({ address: `30001:${alice().publicKey}:x` });
      const del = EventBuilder.deletion(targets, "").createdAt(5).signWithKeys(alice());
      expect(await store.put(del)).toBe("deleted");
      expect(await store.get(target.id)).toBeUndefined();
      expect((await store.get(keep.id))?.content).toBe("keep");
    } finally {
      driver.close();
    }
  });

  test("multi-char #tag filters fall back to a matchFilter pass", async () => {
    const { driver, store } = await openStore();
    try {
      const tagged = note(alice(), "tagged", 1, [["client", "test-app"]]);
      const plain = note(alice(), "plain", 2);
      await store.putMany([tagged, plain]);
      expect((await store.query([{ "#client": ["test-app"] }])).map((e) => e.id)).toEqual([
        tagged.id,
      ]);
      expect(await store.count([{ "#client": ["test-app"] }])).toBe(1);
    } finally {
      driver.close();
    }
  });
});
