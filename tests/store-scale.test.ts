/**
 * Opt-in 10^4 EventStore recency / cursor-bound tests.
 * Enable with: STORE_SCALE=1 bun run test tests/store-scale.test.ts
 *
 * Skipped by default so bun CI does not pay the fill cost.
 * Uses describe.skip (not describe.runIf) for bun:test + vite-plus compatibility.
 */
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  IndexedDbEventStore,
  Kind,
  MemoryEventStore,
  sortEvents,
  type Event,
  type EventStore,
} from "../src/index.ts";
import { installIdbMock, type IdbMock } from "./helpers/idb-mock.ts";

const SCALE = process.env.STORE_SCALE === "1";
const describeScale = SCALE ? describe : describe.skip;

const N = 10_000;
const LIMIT = 50;
const FOLLOW_N = 8;
const A_OLD = 6_900;
const A_REMAINDER = 10;
const B_NEW = 40;
const SIG = "ab".repeat(32);
const E_REF = "aa".repeat(32);

function hex32(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function fakeEvent(
  id: number,
  pubkey: string,
  kind: number,
  created_at: number,
  tags: Event["tags"] = [],
): Event {
  return {
    id: hex32(id),
    pubkey,
    kind,
    created_at,
    tags,
    content: "",
    sig: SIG,
  };
}

function buildScaleSet(): {
  events: Event[];
  follow: string[];
  expectedIds: string[];
  firstAuthorIds: string[];
} {
  const follow = Array.from({ length: FOLLOW_N }, (_, i) => hex32(0x100 + i));
  const outsiders = Array.from({ length: 4 }, (_, i) => hex32(0x200 + i));
  const a = follow[0]!;
  const b = follow[1]!;
  const events: Event[] = [];
  let seq = 0;
  const push = (pubkey: string, kind: number, created_at: number, tags: Event["tags"] = []) => {
    seq += 1;
    events.push(fakeEvent(seq, pubkey, kind, created_at, tags));
  };

  for (let t = 1; t <= A_OLD; t++) {
    push(a, Kind.TextNote, t);
  }
  for (let i = 0; i < A_REMAINDER; i++) {
    push(a, Kind.TextNote, 20_000 + i);
  }
  for (let i = 0; i < B_NEW; i++) {
    push(b, Kind.TextNote, 100_000 + i);
  }

  const kinds = [Kind.TextNote, Kind.Repost, Kind.Reaction] as const;
  let fillerT = 7_000;
  while (events.length < N) {
    const n = events.length;
    const pubkey = n % 5 === 0 ? outsiders[n % outsiders.length]! : follow[n % follow.length]!;
    const kind = kinds[n % kinds.length]!;
    const tags: Event["tags"] =
      n % 3 === 0 ? [["t", "nostr"]] : n % 3 === 1 ? [["e", E_REF]] : [["p", a]];
    push(pubkey, kind, fillerT, tags);
    fillerT += 1;
  }

  const followSet = new Set(follow);
  const matching = events.filter((e) => e.kind === Kind.TextNote && followSet.has(e.pubkey));
  const expectedIds = sortEvents(matching.slice())
    .slice(0, LIMIT)
    .map((e) => e.id);
  const firstAuthorIds = sortEvents(matching.filter((e) => e.pubkey === a).slice())
    .slice(0, LIMIT)
    .map((e) => e.id);

  return { events, follow, expectedIds, firstAuthorIds };
}

async function fill(store: EventStore, events: readonly Event[]): Promise<void> {
  for (const event of events) {
    await store.put(event);
  }
}

describeScale("store scale 10^4", () => {
  let mock: IdbMock;

  beforeEach(() => {
    mock = installIdbMock();
  });

  afterEach(() => {
    mock.uninstall();
  });

  test("follow-list limit 50 is NIP-01 global newest", async () => {
    const { events, follow, expectedIds, firstAuthorIds } = buildScaleSet();
    expect(events).toHaveLength(N);
    expect(expectedIds).toHaveLength(LIMIT);
    expect(expectedIds).not.toEqual(firstAuthorIds);

    const byId = new Map(events.map((e) => [e.id, e]));
    const expected = expectedIds.map((id) => byId.get(id)!);
    expect(expected.slice(0, B_NEW).every((e) => e.pubkey === follow[1])).toBe(true);
    expect(expected.slice(B_NEW).every((e) => e.pubkey === follow[0])).toBe(true);

    const memory = new MemoryEventStore();
    await fill(memory, events);
    expect(memory.size).toBe(N);
    expect(
      (await memory.query([{ authors: follow, kinds: [Kind.TextNote], limit: LIMIT }])).map(
        (e) => e.id,
      ),
    ).toEqual(expectedIds);

    const idb = new IndexedDbEventStore({ dbName: "scale-104" });
    await idb.open();
    await fill(idb, events);
    mock.resetStats();
    const found = await idb.query([{ authors: follow, kinds: [Kind.TextNote], limit: LIMIT }]);
    expect(found.map((e) => e.id)).toEqual(expectedIds);
    expect(found.map((e) => e.id)).not.toEqual(firstAuthorIds);
    expect(mock.eventsGetAllCount()).toBe(0);
    expect(mock.cursorVisitCount()).toBeGreaterThan(LIMIT);
    expect(mock.cursorVisitCount()).toBeLessThan(LIMIT + FOLLOW_N + 32);
    idb.close();
  });
});
