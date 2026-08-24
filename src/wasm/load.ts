import { CryptoError } from "../core/error.ts";
import type { Event } from "../core/event.ts";
import {
  instantiateCryptoWasm,
  wasmPublicKey,
  wasmSign,
  wasmVerify,
  wasmVerifySerialized,
  type CryptoWasmExports,
} from "./abi.ts";
import { makeVerifyEvent, WasmVerifyPoisonedError } from "./adapter.ts";

export type LoadNostrWasmOptions = {
  /** Bytes, or a URL whose bytes will be read (Node fs for file:; fetch otherwise). */
  module?: ArrayBuffer | ArrayBufferView | URL;
};

export type NostrWasm = {
  verify: (id: Uint8Array, pubkey: Uint8Array, sig: Uint8Array) => boolean;
  verifySerialized: (
    serializedUtf8: Uint8Array,
    id: Uint8Array,
    pubkey: Uint8Array,
    sig: Uint8Array,
  ) => boolean;
  verifyEvent: (event: Event) => boolean;
  sign: (id: Uint8Array, seckey: Uint8Array, aux: Uint8Array) => Uint8Array;
  publicKey: (seckey: Uint8Array) => Uint8Array;
};

export { WasmVerifyPoisonedError };

let interned: Promise<NostrWasm> | undefined;

function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    process.versions !== null &&
    typeof process.versions.node === "string"
  );
}

function isWasmBytes(value: object): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

async function defaultWasmHref(): Promise<string> {
  const mod = await import("./nostr_crypto_wasm_bg.wasm?url");
  return mod.default;
}

async function readWasmUrl(url: URL): Promise<Uint8Array> {
  if (isNode() && url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch wasm: ${res.status} ${url.href}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function wasmBytes(opts?: LoadNostrWasmOptions): Promise<ArrayBuffer | ArrayBufferView> {
  const source = opts?.module;
  if (source !== undefined && isWasmBytes(source)) return source;
  const href = source instanceof URL ? source : new URL(await defaultWasmHref(), import.meta.url);
  return readWasmUrl(href);
}

function requireByteLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.length !== expected) {
    throw new CryptoError(`invalid ${label} length: expected ${expected}, got ${bytes.length}`);
  }
}

function wrapPoison<T>(poison: { error?: Error }, fn: () => T): T {
  if (poison.error) throw poison.error;
  try {
    return fn();
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      poison.error = new WasmVerifyPoisonedError("wasm verify aborted the instance", {
        cause: e,
      });
      throw poison.error;
    }
    throw e;
  }
}

function bindExports(exports: CryptoWasmExports): NostrWasm {
  const poison: { error?: Error } = {};
  const rawSerialized = (
    serializedUtf8: Uint8Array,
    id: Uint8Array,
    pubkey: Uint8Array,
    sig: Uint8Array,
  ): boolean => wasmVerifySerialized(exports, serializedUtf8, id, pubkey, sig);
  return {
    verify: (id, pubkey, sig) => wrapPoison(poison, () => wasmVerify(exports, id, pubkey, sig)),
    verifySerialized: (serializedUtf8, id, pubkey, sig) =>
      wrapPoison(poison, () => rawSerialized(serializedUtf8, id, pubkey, sig)),
    verifyEvent: makeVerifyEvent({ verifySerialized: rawSerialized }, poison),
    sign: (id, seckey, aux) =>
      wrapPoison(poison, () => {
        requireByteLength(id, 32, "id");
        requireByteLength(seckey, 32, "secret key");
        requireByteLength(aux, 32, "aux");
        const sig = wasmSign(exports, id, seckey, aux);
        if (sig.length !== 64) throw new CryptoError("wasm sign failed");
        return sig;
      }),
    publicKey: (seckey) =>
      wrapPoison(poison, () => {
        requireByteLength(seckey, 32, "secret key");
        const pk = wasmPublicKey(exports, seckey);
        if (pk.length !== 32) throw new CryptoError("wasm publicKey failed");
        return pk;
      }),
  };
}

async function instantiateNostrWasm(opts?: LoadNostrWasmOptions): Promise<NostrWasm> {
  const bytes = await wasmBytes(opts);
  const exports = await instantiateCryptoWasm(bytes);
  return bindExports(exports);
}

/** Instantiate once. Repeats reuse the same module. Failure throws; no noble fallback. */
export function loadNostrWasm(opts?: LoadNostrWasmOptions): Promise<NostrWasm> {
  if (interned) return interned;
  const pending = instantiateNostrWasm(opts).catch((error: unknown) => {
    if (interned === pending) interned = undefined;
    throw error;
  });
  interned = pending;
  return pending;
}

/** Clears intern so tests can re-instantiate. Not exported from the wasm subpath. */
export function resetNostrWasmForTests(): void {
  interned = undefined;
}
