/** wasm-bindgen 0.2.122 bundler-produced exports used by interned TS glue. */
export type CryptoWasmExports = {
  memory: WebAssembly.Memory;
  verify: (
    idPtr: number,
    idLen: number,
    pkPtr: number,
    pkLen: number,
    sigPtr: number,
    sigLen: number,
  ) => number;
  verify_serialized: (
    serPtr: number,
    serLen: number,
    idPtr: number,
    idLen: number,
    pkPtr: number,
    pkLen: number,
    sigPtr: number,
    sigLen: number,
  ) => number;
  /** 0.2.122 name for `__wbindgen_malloc(size, align)`. */
  __wbindgen_export: (size: number, align: number) => number;
  __wbindgen_start?: () => void;
};

/** Imports 0.2.122 may request. Instantiation fails if anything else appears. */
export const ALLOWED_WASM_IMPORTS: ReadonlyArray<{ module: string; name: string }> = [
  { module: "wbg", name: "__wbindgen_throw" },
  { module: "./nostr_crypto_wasm_bg.js", name: "__wbindgen_throw" },
];

const utf8 = new TextDecoder();

function decodeUtf8(memory: WebAssembly.Memory, ptr: number, len: number): string {
  return utf8.decode(new Uint8Array(memory.buffer, ptr, len));
}

function makeWbgImports(holder: { exports?: CryptoWasmExports }): WebAssembly.Imports {
  const throwRuntime = (ptr: number, len: number): never => {
    const mem = holder.exports?.memory;
    const msg = mem ? decodeUtf8(mem, ptr, len) : "wasm panic";
    throw new WebAssembly.RuntimeError(msg);
  };
  const wbg = {
    __wbindgen_throw: throwRuntime,
  };
  return {
    wbg,
    "./nostr_crypto_wasm_bg.js": wbg,
  };
}

/** Fail if the module imports anything outside {@link ALLOWED_WASM_IMPORTS}. */
export function assertAllowedWasmImports(mod: WebAssembly.Module): void {
  const allowed = new Set(ALLOWED_WASM_IMPORTS.map((item) => `${item.module}\0${item.name}`));
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind !== "function") {
      throw new TypeError(`unexpected wasm import kind ${imp.kind}: ${imp.module}.${imp.name}`);
    }
    if (!allowed.has(`${imp.module}\0${imp.name}`)) {
      throw new TypeError(`unexpected wasm import ${imp.module}.${imp.name}`);
    }
  }
}

function requireMemory(value: WebAssembly.ExportValue | undefined): WebAssembly.Memory {
  if (!(value instanceof WebAssembly.Memory)) {
    throw new TypeError("wasm missing memory export");
  }
  return value;
}

function requireFn<T extends (...args: never[]) => unknown>(
  value: WebAssembly.ExportValue | undefined,
  name: string,
): T {
  if (typeof value !== "function") {
    throw new TypeError(`wasm missing ${name} export`);
  }
  return value as T;
}

function asExports(raw: WebAssembly.Exports): CryptoWasmExports {
  return {
    memory: requireMemory(raw.memory),
    verify: requireFn(raw.verify, "verify"),
    verify_serialized: requireFn(raw.verify_serialized, "verify_serialized"),
    __wbindgen_export: requireFn(raw.__wbindgen_export, "__wbindgen_export"),
    __wbindgen_start:
      typeof raw.__wbindgen_start === "function" ? (raw.__wbindgen_start as () => void) : undefined,
  };
}

function passBytes(exports: CryptoWasmExports, bytes: Uint8Array): { ptr: number; len: number } {
  const len = bytes.length;
  const ptr = exports.__wbindgen_export(len, 1) >>> 0;
  new Uint8Array(exports.memory.buffer, ptr, len).set(bytes);
  return { ptr, len };
}

function callWithBytes(
  exports: CryptoWasmExports,
  arrays: readonly Uint8Array[],
  invoke: (args: number[]) => number,
): boolean {
  const passed = arrays.map((bytes) => passBytes(exports, bytes));
  const args = passed.flatMap(({ ptr, len }) => [ptr, len]);
  return invoke(args) !== 0;
}

export function wasmVerify(
  exports: CryptoWasmExports,
  id: Uint8Array,
  pubkey: Uint8Array,
  sig: Uint8Array,
): boolean {
  return callWithBytes(exports, [id, pubkey, sig], (args) =>
    exports.verify(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!),
  );
}

export function wasmVerifySerialized(
  exports: CryptoWasmExports,
  serialized: Uint8Array,
  id: Uint8Array,
  pubkey: Uint8Array,
  sig: Uint8Array,
): boolean {
  return callWithBytes(exports, [serialized, id, pubkey, sig], (args) =>
    exports.verify_serialized(
      args[0]!,
      args[1]!,
      args[2]!,
      args[3]!,
      args[4]!,
      args[5]!,
      args[6]!,
      args[7]!,
    ),
  );
}

export async function instantiateCryptoWasm(
  bytes: ArrayBuffer | ArrayBufferView,
): Promise<CryptoWasmExports> {
  const holder: { exports?: CryptoWasmExports } = {};
  const { module, instance } = await WebAssembly.instantiate(bytes, makeWbgImports(holder));
  assertAllowedWasmImports(module);
  holder.exports = asExports(instance.exports);
  holder.exports.__wbindgen_start?.();
  return holder.exports;
}
