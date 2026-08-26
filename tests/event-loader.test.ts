import { describe, expect, test } from "vite-plus/test";
import { EventBuilder, Keys, Pool, naddrEncode, type Filter } from "../src/index.ts";
import { createEventLoader, LoaderContext } from "../src/loaders/index.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const ID1 = "11".repeat(32);
const ID2 = "22".repeat(32);
const RELAY = "wss://idx.example";
const FETCH_TIMEOUT_MS = 1500;

function captureError(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected reject");
    },
    (err: unknown) => err,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for condition");
}

function idsOf(filters: Filter[]): string[] {
  const ids = filters[0]?.ids;
  if (!ids) throw new Error("expected filter.ids");
  return [...ids];
}

describe("createEventLoader overlapping fetches", () => {
  test("two distinct ids load()ed in one tick overlap fetches", async () => {
    expect(ID1).not.toBe(ID2);
    const pool = new Pool();
    let inflight = 0;
    let maxInflight = 0;
    const calls: Array<{ ids: string[]; timeoutMs: number | undefined }> = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    pool.fetch = async (_relays, filters, opts) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      calls.push({ ids: idsOf(filters), timeoutMs: opts?.timeoutMs });
      try {
        await hold;
        return [];
      } finally {
        inflight -= 1;
      }
    };
    const loader = createEventLoader(
      new LoaderContext({ pool, relays: [RELAY], fetchTimeoutMs: FETCH_TIMEOUT_MS }),
    );

    const p1 = loader.load(ID1);
    const p2 = loader.load(ID2);
    await waitUntil(() => inflight === 2);
    expect(maxInflight).toBe(2);
    expect(calls).toHaveLength(2);
    expect(
      calls
        .map((c) => c.ids)
        .flat()
        .sort(),
    ).toEqual([ID1, ID2].sort());
    expect(calls[0]!.timeoutMs).toBe(FETCH_TIMEOUT_MS);
    expect(calls[1]!.timeoutMs).toBe(FETCH_TIMEOUT_MS);

    release();
    expect(await Promise.all([p1, p2])).toEqual([undefined, undefined]);
    expect(inflight).toBe(0);
  });

  test("same id load()ed twice in one tick shares one fetch", async () => {
    const pool = new Pool();
    let inflight = 0;
    let maxInflight = 0;
    const calls: string[][] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    pool.fetch = async (_relays, filters) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      calls.push(idsOf(filters));
      try {
        await hold;
        return [];
      } finally {
        inflight -= 1;
      }
    };
    const loader = createEventLoader(
      new LoaderContext({ pool, relays: [RELAY], fetchTimeoutMs: FETCH_TIMEOUT_MS }),
    );

    const p1 = loader.load(ID1);
    const p2 = loader.load({ id: ID1, relays: ["wss://hint.example"] });
    await waitUntil(() => inflight === 1);
    expect(maxInflight).toBe(1);
    expect(calls).toEqual([[ID1]]);

    release();
    expect(await Promise.all([p1, p2])).toEqual([undefined, undefined]);
    expect(inflight).toBe(0);
  });

  test("hints change relay URLs not cache identity", async () => {
    const pool = new Pool();
    const seen: string[][] = [];
    let fetchCalls = 0;
    pool.fetch = async (relays) => {
      fetchCalls += 1;
      seen.push([...relays]);
      return [];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    const hint = "wss://hint.example";
    expect(await loader.load({ id: ID1, relays: [hint] })).toBeUndefined();
    expect(fetchCalls).toBe(1);
    expect(seen).toEqual([[hint, RELAY]]);
    expect(await loader.load(ID1)).toBeUndefined();
    expect(fetchCalls).toBe(1);
  });

  test("resolved miss is cached; clearAll fetches again", async () => {
    const pool = new Pool();
    let fetchCalls = 0;
    pool.fetch = async () => {
      fetchCalls += 1;
      return [];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    expect(await loader.load(ID1)).toBeUndefined();
    expect(fetchCalls).toBe(1);
    expect(await loader.load(ID1)).toBeUndefined();
    expect(fetchCalls).toBe(1);
    loader.clearAll();
    expect(await loader.load(ID1)).toBeUndefined();
    expect(fetchCalls).toBe(2);
  });

  test("serial load() fetches keep maxInflight at 1", async () => {
    expect(ID1).not.toBe(ID2);
    const pool = new Pool();
    let inflight = 0;
    let maxInflight = 0;
    const calls: string[][] = [];
    pool.fetch = async (_relays, filters) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      calls.push(idsOf(filters));
      try {
        await sleep(20);
        return [];
      } finally {
        inflight -= 1;
      }
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));

    expect(await loader.load(ID1)).toBeUndefined();
    expect(inflight).toBe(0);
    expect(await loader.load(ID2)).toBeUndefined();
    expect(inflight).toBe(0);
    expect(maxInflight).toBe(1);
    expect(calls).toEqual([[ID1], [ID2]]);
  });

  test("no relays and no hints skips pool.fetch", async () => {
    const pool = new Pool();
    let fetchCalls = 0;
    pool.fetch = async () => {
      fetchCalls += 1;
      return [];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [] }));
    expect(await loader.load(ID1)).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  test("EventPointer hints fetch when ctx.relays is empty", async () => {
    const pool = new Pool();
    const seen: string[][] = [];
    pool.fetch = async (relays) => {
      seen.push([...relays]);
      return [];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [] }));
    const hint = "wss://hint.example";
    expect(await loader.load({ id: ID1, relays: [hint] })).toBeUndefined();
    expect(seen).toEqual([[hint]]);
  });

  test("picks newest created_at when older is listed first", async () => {
    const keys = Keys.fromSecretKey(SK);
    const older = EventBuilder.textNote("old").createdAt(1).signWithKeys(keys);
    const newer = EventBuilder.textNote("new").createdAt(99).signWithKeys(keys);
    expect(older.created_at).toBe(1);
    expect(newer.created_at).toBe(99);
    expect(older.id).not.toBe(newer.id);

    const pool = new Pool();
    let fetchCalls = 0;
    pool.fetch = async (_relays, filters) => {
      fetchCalls += 1;
      expect(idsOf(filters)).toEqual([older.id]);
      return [older, newer];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    const result = await loader.load(older.id);
    expect(fetchCalls).toBe(1);
    expect(result).toEqual(newer);
  });

  test("empty pool.fetch result is undefined", async () => {
    const pool = new Pool();
    let fetchCalls = 0;
    pool.fetch = async () => {
      fetchCalls += 1;
      return [];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    expect(await loader.load(ID1)).toBeUndefined();
    expect(fetchCalls).toBe(1);
  });

  test("pool.fetch throw rejects load", async () => {
    const boom = new Error("relay down");
    const pool = new Pool();
    let fetchCalls = 0;
    pool.fetch = async () => {
      fetchCalls += 1;
      throw boom;
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    const err = await captureError(loader.load(ID1));
    expect(fetchCalls).toBe(1);
    expect(err).toBe(boom);
    const err2 = await captureError(loader.load(ID1));
    expect(fetchCalls).toBe(2);
    expect(err2).toBe(boom);
  });

  test('addressable kind 30023 with empty identifier sends #d:[""]', async () => {
    const keys = Keys.fromSecretKey(SK);
    const pool = new Pool();
    const seen: Filter[] = [];
    pool.fetch = async (_relays, filters) => {
      const f = filters[0];
      if (!f) throw new Error("expected a filter");
      seen.push(f);
      return [];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    const pubkey = keys.publicKey;
    expect(await loader.load({ kind: 30023, pubkey, identifier: "" })).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(Object.hasOwn(seen[0]!, "#d")).toBe(true);
    expect(seen[0]!["#d"]).toEqual([""]);
    expect(seen[0]!.authors).toEqual([pubkey.toLowerCase()]);
    expect(seen[0]!.kinds).toEqual([30023]);

    loader.clearAll();
    const naddr = naddrEncode({ kind: 30023, pubkey, identifier: "" });
    expect(await loader.load(naddr)).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(Object.hasOwn(seen[1]!, "#d")).toBe(true);
    expect(seen[1]!["#d"]).toEqual([""]);
    expect(seen[1]!.authors).toEqual([pubkey.toLowerCase()]);
    expect(seen[1]!.kinds).toEqual([30023]);
  });

  test("kind 0 AddressPointer omits #d", async () => {
    const keys = Keys.fromSecretKey(SK);
    const pool = new Pool();
    const seen: Filter[] = [];
    pool.fetch = async (_relays, filters) => {
      const f = filters[0];
      if (!f) throw new Error("expected a filter");
      seen.push(f);
      return [];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    const pubkey = keys.publicKey;
    expect(await loader.load({ kind: 0, pubkey, identifier: "" })).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(Object.hasOwn(seen[0]!, "#d")).toBe(false);
    expect(seen[0]!["#d"]).toBeUndefined();
    expect(seen[0]!.authors).toEqual([pubkey.toLowerCase()]);
    expect(seen[0]!.kinds).toEqual([0]);

    expect(await loader.load({ kind: 0, pubkey, identifier: "profile" })).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(Object.hasOwn(seen[1]!, "#d")).toBe(false);
    expect(seen[1]!["#d"]).toBeUndefined();
    expect(seen[1]!.kinds).toEqual([0]);

    loader.clearAll();
    const naddr = naddrEncode({ kind: 0, pubkey, identifier: "" });
    expect(await loader.load(naddr)).toBeUndefined();
    expect(seen).toHaveLength(3);
    expect(Object.hasOwn(seen[2]!, "#d")).toBe(false);
    expect(seen[2]!["#d"]).toBeUndefined();
    expect(seen[2]!.authors).toEqual([pubkey.toLowerCase()]);
    expect(seen[2]!.kinds).toEqual([0]);
  });

  test("two events same created_at, lower id wins", async () => {
    const keys = Keys.fromSecretKey(SK);
    const a = EventBuilder.textNote("a").createdAt(50).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(50).signWithKeys(keys);
    expect(a.created_at).toBe(50);
    expect(b.created_at).toBe(50);
    expect(a.id).not.toBe(b.id);
    const winner = a.id < b.id ? a : b;
    const loser = a.id < b.id ? b : a;
    expect(loser.id > winner.id).toBe(true);

    const pool = new Pool();
    let fetchCalls = 0;
    pool.fetch = async () => {
      fetchCalls += 1;
      return [loser, winner];
    };
    const loader = createEventLoader(new LoaderContext({ pool, relays: [RELAY] }));
    const result = await loader.load(loser.id);
    expect(fetchCalls).toBe(1);
    expect(result).toEqual(winner);
    expect(result?.id).toBe(winner.id);
  });
});
