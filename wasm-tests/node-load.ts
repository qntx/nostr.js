import { describe, expect, test } from "vite-plus/test";
import { finalizeEvent, type Event } from "../src/index.ts";
import { Kind } from "../src/core/kind.ts";
// Packed entry exists only after `build:wasm`; keep this file out of default typecheck.
// @ts-ignore
import { loadNostrWasm } from "../dist/wasm.mjs";
import { readBuiltWasm } from "./read-wasm.ts";

const SK_HEX = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

function helloEvent(): Event {
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

describe("packed dist/wasm.mjs", () => {
  test("loadNostrWasm() with omitted module instantiates from packed sibling wasm", async () => {
    const wasm = await loadNostrWasm();
    const event = helloEvent();
    expect(wasm.verifyEvent(event)).toBe(true);
    expect(wasm.verifyEvent({ ...event, content: "tampered" })).toBe(false);
  });

  test("loadNostrWasm({ module }) verifies a kind-1 from BufferSource", async () => {
    const bytes = await readBuiltWasm();
    const wasm = await loadNostrWasm({ module: bytes });
    const event = helloEvent();
    expect(wasm.verifyEvent(event)).toBe(true);
    expect(wasm.verifyEvent({ ...event, content: "tampered" })).toBe(false);
  });
});
