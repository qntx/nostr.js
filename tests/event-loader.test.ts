import { describe, expect, test } from "vite-plus/test";
import { EventBuilder, Keys, Pool, type Filter } from "../src/index.ts";
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
});
