import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, test } from "vite-plus/test";
import { CryptoError } from "../src/core/error.ts";
import { getEventHash, type Event } from "../src/core/event.ts";
import { Kind } from "../src/core/kind.ts";
import { getPublicKey, verifyEvent } from "../src/core/key.ts";
import { bytesToHex, hexToBytes } from "../src/core/util.ts";
import { loadNostrWasm, type NostrWasm } from "../src/wasm/load.ts";
import { readBuiltWasm } from "./read-wasm.ts";

const SK_HEX = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

const BIP340_V0_SK = hexToBytes("0000000000000000000000000000000000000000000000000000000000000003");
const BIP340_V0_PK = hexToBytes("F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9");
const BIP340_V0_AUX = hexToBytes(
  "0000000000000000000000000000000000000000000000000000000000000000",
);
const BIP340_V0_MSG = hexToBytes(
  "0000000000000000000000000000000000000000000000000000000000000000",
);
const BIP340_V0_SIG = hexToBytes(
  "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0",
);

const bytes = await readBuiltWasm();
const wasm: NostrWasm = await loadNostrWasm({ module: bytes });

describe("wasm sign/publicKey", () => {
  test("exports are present after BufferSource load", () => {
    expect(typeof wasm.sign).toBe("function");
    expect(typeof wasm.publicKey).toBe("function");
  });

  test("publicKey matches noble getPublicKey", () => {
    const sk = hexToBytes(SK_HEX);
    const pk = wasm.publicKey(sk);
    expect(pk).toHaveLength(32);
    expect(pk).toEqual(hexToBytes(getPublicKey(sk)));
    expect(pk).toEqual(schnorr.getPublicKey(sk));
  });

  test("BIP-340 vector 0 sign and publicKey", () => {
    expect(wasm.publicKey(BIP340_V0_SK)).toEqual(BIP340_V0_PK);
    expect(wasm.sign(BIP340_V0_MSG, BIP340_V0_SK, BIP340_V0_AUX)).toEqual(BIP340_V0_SIG);
  });

  test("same aux as noble produces the same signature", () => {
    const sk = hexToBytes(SK_HEX);
    const id = BIP340_V0_MSG;
    const aux = crypto.getRandomValues(new Uint8Array(32));
    expect(aux).toHaveLength(32);
    const wasmSig = wasm.sign(id, sk, aux);
    const nobleSig = schnorr.sign(id, sk, aux);
    expect(wasmSig).toHaveLength(64);
    expect(wasmSig).toEqual(nobleSig);
  });

  test("wasm-signed event verifies under noble and wasm verifyEvent", () => {
    const sk = hexToBytes(SK_HEX);
    const pk = wasm.publicKey(sk);
    const unsigned = {
      kind: Kind.TextNote,
      tags: [],
      content: "hello",
      created_at: 1617932115,
      pubkey: bytesToHex(pk),
    };
    const idHex = getEventHash(unsigned);
    const id = hexToBytes(idHex);
    const aux = crypto.getRandomValues(new Uint8Array(32));
    expect(aux).toHaveLength(32);
    const sig = wasm.sign(id, sk, aux);
    expect(sig).toHaveLength(64);
    const event: Event = { ...unsigned, id: idHex, sig: bytesToHex(sig) };
    expect(verifyEvent({ ...event })).toBe(true);
    expect(wasm.verifyEvent({ ...event })).toBe(true);
    expect(wasm.verify(id, pk, sig)).toBe(true);
  });
});

describe("wasm sign/publicKey errors", () => {
  const sk = hexToBytes(SK_HEX);
  const id = new Uint8Array(32);
  const aux = new Uint8Array(32);

  test("invalid lengths throw CryptoError", () => {
    expect(() => wasm.sign(new Uint8Array(0), sk, aux)).toThrow(CryptoError);
    expect(() => wasm.sign(new Uint8Array(31), sk, aux)).toThrow(CryptoError);
    expect(() => wasm.sign(new Uint8Array(33), sk, aux)).toThrow(CryptoError);
    expect(() => wasm.sign(id, new Uint8Array(0), aux)).toThrow(CryptoError);
    expect(() => wasm.sign(id, new Uint8Array(31), aux)).toThrow(CryptoError);
    expect(() => wasm.sign(id, new Uint8Array(33), aux)).toThrow(CryptoError);
    expect(() => wasm.sign(id, sk, new Uint8Array(0))).toThrow(CryptoError);
    expect(() => wasm.sign(id, sk, new Uint8Array(31))).toThrow(CryptoError);
    expect(() => wasm.sign(id, sk, new Uint8Array(33))).toThrow(CryptoError);
    expect(() => wasm.publicKey(new Uint8Array(0))).toThrow(CryptoError);
    expect(() => wasm.publicKey(new Uint8Array(31))).toThrow(CryptoError);
    expect(() => wasm.publicKey(new Uint8Array(33))).toThrow(CryptoError);
  });

  test("invalid scalar of correct length throws (rust empty-box path)", () => {
    const zero = new Uint8Array(32);
    expect(() => wasm.publicKey(zero)).toThrow(CryptoError);
    expect(() => wasm.sign(id, zero, aux)).toThrow(CryptoError);
    const order = hexToBytes("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    expect(order).toHaveLength(32);
    expect(() => wasm.publicKey(order)).toThrow(CryptoError);
    expect(() => wasm.sign(id, order, aux)).toThrow(CryptoError);
  });
});
