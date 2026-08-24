import { describe, expect, test } from "vite-plus/test";
import { arch, cpus, hostname, platform } from "node:os";
import { finalizeEvent, verifyEvent, type Event } from "../src/index.ts";
import { Kind } from "../src/core/kind.ts";
import { loadNostrWasm } from "../src/wasm/load.ts";
import { readBuiltWasm } from "./read-wasm.ts";

const SK_HEX = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SIZES = [1, 100, 10_000] as const;

function fixture(): Event {
  return finalizeEvent(
    {
      kind: Kind.TextNote,
      tags: [],
      content: "hello",
      created_at: 1617932115,
    },
    SK_HEX,
  );
}

function timeOps(n: number, run: () => void): { ms: number; ops: number } {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) run();
  const ms = performance.now() - t0;
  return { ms, ops: ms === 0 ? Infinity : (n / ms) * 1000 };
}

describe("wasm bench", () => {
  test("ingest-equivalent verify: wasm ops/s > noble at N=10000", async () => {
    const bytes = await readBuiltWasm();
    const tInit = performance.now();
    const wasm = await loadNostrWasm({ module: bytes });
    const initMs = performance.now() - tInit;

    const base = fixture();
    verifyEvent({ ...base });
    wasm.verifyEvent({ ...base });

    const rows: Record<string, unknown>[] = [];
    let noble10k = 0;
    let wasm10k = 0;
    for (const n of SIZES) {
      const noble = timeOps(n, () => {
        verifyEvent({ ...base });
      });
      const accelerated = timeOps(n, () => {
        wasm.verifyEvent({ ...base });
      });
      if (n === 10_000) {
        noble10k = noble.ops;
        wasm10k = accelerated.ops;
      }
      rows.push({
        n,
        nobleOps: noble.ops,
        nobleUs: (noble.ms / n) * 1000,
        wasmOps: accelerated.ops,
        wasmUs: (accelerated.ms / n) * 1000,
        ratio: accelerated.ops / noble.ops,
      });
    }

    const record = {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      wasmBytes: bytes.byteLength,
      initMs,
      results: rows,
    };
    console.log(JSON.stringify(record, null, 2));

    expect(wasm10k).toBeGreaterThan(noble10k);
  }, 60_000);
});
