import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite-plus";

const packWasm = process.env.WASM_PACK === "1";
const wasmTest = process.env.WASM_TEST === "1";

/** Asset-URL for `*.wasm?url`. Does not instantiate the module. */
function wasmUrlAsset() {
  return {
    name: "wasm-url-asset",
    resolveId(id: string, importer: string | undefined) {
      if (!id.endsWith(".wasm?url")) return;
      const bare = id.slice(0, -"?url".length);
      const from = importer ? path.dirname(importer.split("?")[0] ?? importer) : process.cwd();
      const file = path.resolve(from, bare);
      if (!existsSync(file)) {
        throw new Error(`missing wasm asset ${file}`);
      }
      return `\0wasm-url:${file}`;
    },
    load(id: string) {
      if (!id.startsWith("\0wasm-url:")) return;
      return `export default new URL("./nostr_crypto_wasm_bg.wasm", import.meta.url).href;`;
    },
  };
}

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    plugins: packWasm ? [wasmUrlAsset()] : [],
    entry: {
      index: "src/index.ts",
      core: "src/core/index.ts",
      signer: "src/signer/index.ts",
      relay: "src/relay/index.ts",
      client: "src/client/index.ts",
      storage: "src/storage/index.ts",
      loaders: "src/loaders/index.ts",
      gossip: "src/gossip/index.ts",
      "nips/blossom": "src/nips/blossom.ts",
      "nips/nip04": "src/nips/nip04.ts",
      "nips/nip05": "src/nips/nip05.ts",
      "nips/nip10": "src/nips/nip10.ts",
      "nips/nip11": "src/nips/nip11.ts",
      "nips/nip13": "src/nips/nip13.ts",
      "nips/nip17": "src/nips/nip17.ts",
      "nips/nip19": "src/nips/nip19.ts",
      "nips/nip21": "src/nips/nip21.ts",
      "nips/nip27": "src/nips/nip27.ts",
      "nips/nip42": "src/nips/nip42.ts",
      "nips/nip44": "src/nips/nip44.ts",
      "nips/nip46": "src/nips/nip46.ts",
      "nips/nip49": "src/nips/nip49.ts",
      "nips/nip51": "src/nips/nip51.ts",
      "nips/nip57": "src/nips/nip57.ts",
      "nips/nip59": "src/nips/nip59.ts",
      "nips/nip65": "src/nips/nip65.ts",
      "nips/nip77": "src/nips/nip77.ts",
      "nips/nip96": "src/nips/nip96.ts",
      "nips/nip98": "src/nips/nip98.ts",
      ...(packWasm ? { wasm: "src/wasm/index.ts" } : {}),
    },
    dts: {
      tsgo: true,
    },
    sourcemap: true,
    exports: {
      customExports(pkgExports: Record<string, unknown>) {
        for (const [key, value] of Object.entries(pkgExports)) {
          if (typeof value !== "string" || !value.endsWith(".mjs")) continue;
          pkgExports[key] = {
            types: value.replace(/\.mjs$/, ".d.mts"),
            import: value,
          };
        }
        if (packWasm) {
          pkgExports["./wasm"] = {
            types: "./dist/wasm.d.mts",
            import: "./dist/wasm.mjs",
          };
        }
        return pkgExports;
      },
    },
  },
  test: {
    include: wasmTest ? ["wasm-tests/**/*.ts"] : ["tests/**/*.{test,spec}.ts"],
    exclude: ["3rdparty/**", "node_modules/**", "dist/**"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
