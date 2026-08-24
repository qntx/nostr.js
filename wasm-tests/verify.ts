import { describe, expect, test } from "vite-plus/test";
import { hexToBytes, utf8Encoder } from "../src/core/util.ts";
import { finalizeEvent, serializeEvent, verifyEvent, type Event } from "../src/index.ts";
import { Kind } from "../src/core/kind.ts";
import { HexError } from "../src/core/error.ts";
import { assertAllowedWasmImports, instantiateCryptoWasm } from "../src/wasm/abi.ts";
import { makeVerifyEvent, WasmVerifyPoisonedError } from "../src/wasm/adapter.ts";
import { loadNostrWasm } from "../src/wasm/load.ts";
import { readBuiltWasm } from "./read-wasm.ts";

const SK_HEX = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

const BIP340_V0_PK = hexToBytes("F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9");
const BIP340_V0_MSG = hexToBytes(
  "0000000000000000000000000000000000000000000000000000000000000000",
);
const BIP340_V0_SIG = hexToBytes(
  "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0",
);
const BIP340_V5_PK = hexToBytes("EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34");
const BIP340_V5_MSG = hexToBytes(
  "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
);
const BIP340_V5_SIG = hexToBytes(
  "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B",
);

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

function copyEvent(event: Event): Event {
  return { ...event };
}

const bytes = await readBuiltWasm();
const wasm = await loadNostrWasm({ module: bytes });

describe("wasm module imports", () => {
  test("Module.imports is a subset of the pinned 0.2.122 list", async () => {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const mod = await WebAssembly.compile(copy);
    assertAllowedWasmImports(mod);
    const unexpected = WebAssembly.Module.imports(mod).filter(
      (imp) => imp.name !== "__wbindgen_throw",
    );
    expect(unexpected).toEqual([]);
  });

  test("invalid bytes throw and are not interned as success", async () => {
    await expect(instantiateCryptoWasm(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).rejects.toThrow();
    const again = await loadNostrWasm({ module: bytes });
    expect(again).toBe(wasm);
  });
});

describe("loadNostrWasm intern", () => {
  test("repeats reuse the same instance", async () => {
    const second = await loadNostrWasm({ module: bytes });
    expect(second).toBe(wasm);
  });
});

describe("wasm vs noble", () => {
  test("verifyEvent matches noble on a signed kind-1", () => {
    const event = helloEvent();
    expect(verifyEvent(copyEvent(event))).toBe(true);
    expect(wasm.verifyEvent(copyEvent(event))).toBe(true);
  });

  test("tampered content is false under both", () => {
    const event: Event = { ...helloEvent(), content: "tampered" };
    expect(verifyEvent(copyEvent(event))).toBe(false);
    expect(wasm.verifyEvent(copyEvent(event))).toBe(false);
  });

  test("id/hash mismatch is false", () => {
    const event = helloEvent();
    const serialized = utf8Encoder.encode(serializeEvent(event));
    const id = hexToBytes(event.id);
    id[0] = (id[0] ?? 0) ^ 1;
    expect(
      wasm.verifySerialized(serialized, id, hexToBytes(event.pubkey), hexToBytes(event.sig)),
    ).toBe(false);
  });

  test("byte verify matches BIP-340 vector 0 and rejects vector 5", () => {
    expect(wasm.verify(BIP340_V0_MSG, BIP340_V0_PK, BIP340_V0_SIG)).toBe(true);
    expect(wasm.verify(BIP340_V5_MSG, BIP340_V5_PK, BIP340_V5_SIG)).toBe(false);
  });
});

describe("wasm verify edge cases", () => {
  test("wrong lengths return false, not throw", () => {
    const id = new Uint8Array(32);
    const pk = new Uint8Array(32);
    const sig = new Uint8Array(64);
    expect(wasm.verify(new Uint8Array(0), pk, sig)).toBe(false);
    expect(wasm.verify(new Uint8Array(31), pk, sig)).toBe(false);
    expect(wasm.verify(new Uint8Array(33), pk, sig)).toBe(false);
    expect(wasm.verify(id, new Uint8Array(0), sig)).toBe(false);
    expect(wasm.verify(id, pk, new Uint8Array(63))).toBe(false);
    expect(wasm.verify(id, pk, new Uint8Array(65))).toBe(false);
  });

  test("invalid event shape is false and does not throw", () => {
    const bad = {
      kind: 1,
      tags: [],
      content: "x",
      created_at: 1,
      pubkey: "zz",
      id: "zz",
      sig: "zz",
    };
    expect(wasm.verifyEvent(bad as unknown as Event)).toBe(false);
  });

  test("WeakSet hits skip crypto", () => {
    const event = copyEvent(helloEvent());
    expect(wasm.verifyEvent(event)).toBe(true);
    expect(wasm.verifyEvent(event)).toBe(true);
    const failed: Event = { ...helloEvent(), content: "nope" };
    expect(wasm.verifyEvent(failed)).toBe(false);
    expect(wasm.verifyEvent(failed)).toBe(false);
  });
});

describe("adapter poison", () => {
  test("RuntimeError becomes sticky WasmVerifyPoisonedError", () => {
    const poison: { error?: Error } = {};
    let calls = 0;
    const fn = makeVerifyEvent(
      {
        verifySerialized: () => {
          calls += 1;
          throw new WebAssembly.RuntimeError("trap");
        },
      },
      poison,
    );
    const event = copyEvent(helloEvent());
    expect(() => fn(event)).toThrow(WasmVerifyPoisonedError);
    expect(poison.error).toBeInstanceOf(WasmVerifyPoisonedError);
    expect(() => fn(copyEvent(event))).toThrow(WasmVerifyPoisonedError);
    expect(calls).toBe(1);
  });

  test("non-RuntimeError is false, not poison", () => {
    const poison: { error?: Error } = {};
    let calls = 0;
    const fn = makeVerifyEvent(
      {
        verifySerialized: () => {
          calls += 1;
          throw new HexError("bad hex");
        },
      },
      poison,
    );
    expect(fn(copyEvent(helloEvent()))).toBe(false);
    expect(poison.error).toBeUndefined();
    expect(fn(copyEvent(helloEvent()))).toBe(false);
    expect(calls).toBe(2);
  });
});
