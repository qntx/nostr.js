import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { applyPackExports } from "../vite.config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const WASM_EXPORT = {
  types: "./dist/wasm.d.mts",
  import: "./dist/wasm.mjs",
} as const;

type Pkg = {
  version: string;
  scripts: Record<string, string>;
  exports: Record<string, unknown>;
};

function readPkg(): Pkg {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg;
}

describe("package.json wasm publish", () => {
  test("version stays 0.0.0", () => {
    expect(readPkg().version).toBe("0.0.0");
  });

  test("exports ./wasm with types and import paths", () => {
    const wasm = readPkg().exports["./wasm"];
    expect(wasm).toEqual(WASM_EXPORT);
    expect(Object.hasOwn(wasm as object, "types")).toBe(true);
    expect(Object.hasOwn(wasm as object, "import")).toBe(true);
    expect((wasm as { types: string }).types).toBe("./dist/wasm.d.mts");
    expect((wasm as { import: string }).import).toBe("./dist/wasm.mjs");
  });

  test("prepublishOnly packs wasm", () => {
    expect(readPkg().scripts.prepublishOnly).toBe("bun run build:wasm");
  });

  test("build:wasm fails closed when dist/*.wasm is missing", () => {
    const script = readPkg().scripts["build:wasm"];
    expect(script).toBe(
      "bash scripts/build-wasm.sh && WASM_PACK=1 vp pack && ls dist/*.wasm >/dev/null",
    );
    expect(script).not.toMatch(/(^|[\s;|&])cp(\s|$)/);
    expect(script.includes("then cp ")).toBe(false);
    expect(script.endsWith("ls dist/*.wasm >/dev/null")).toBe(true);
  });

  test("bun run build does not set WASM_PACK", () => {
    const build = readPkg().scripts.build;
    expect(build).toBe("vp pack");
    expect(build.includes("WASM_PACK")).toBe(false);
    expect(build.includes("build:wasm")).toBe(false);
  });
});

describe("applyPackExports", () => {
  test("writes ./wasm when the pack map has no wasm key", () => {
    const out = applyPackExports({
      ".": "./dist/index.mjs",
      "./core": "./dist/core.mjs",
    });
    expect(out["./wasm"]).toEqual(WASM_EXPORT);
    expect(out["."]).toEqual({
      types: "./dist/index.d.mts",
      import: "./dist/index.mjs",
    });
    expect(out["./core"]).toEqual({
      types: "./dist/core.d.mts",
      import: "./dist/core.mjs",
    });
  });

  test("writes ./wasm for an empty pack map", () => {
    expect(applyPackExports({})["./wasm"]).toEqual(WASM_EXPORT);
  });

  test("overwrites a string ./wasm export", () => {
    expect(applyPackExports({ "./wasm": "./dist/other.mjs" })["./wasm"]).toEqual(WASM_EXPORT);
  });

  test("overwrites a wrong object ./wasm export", () => {
    expect(
      applyPackExports({
        "./wasm": { types: "./dist/wrong.d.mts", import: "./dist/wrong.mjs" },
      })["./wasm"],
    ).toEqual(WASM_EXPORT);
  });

  test("leaves non-mjs strings and object exports unchanged", () => {
    const pkgJson = "./package.json";
    const client = { types: "./dist/client.d.mts", import: "./dist/client.mjs" };
    const out = applyPackExports({
      "./package.json": pkgJson,
      "./client": client,
    });
    expect(out["./package.json"]).toBe(pkgJson);
    expect(out["./client"]).toBe(client);
    expect(out["./wasm"]).toEqual(WASM_EXPORT);
  });

  test("writes ./wasm when WASM_PACK is unset", () => {
    const prev = process.env.WASM_PACK;
    delete process.env.WASM_PACK;
    try {
      expect(applyPackExports({ "./relay": "./dist/relay.mjs" })["./wasm"]).toEqual(WASM_EXPORT);
    } finally {
      if (prev === undefined) delete process.env.WASM_PACK;
      else process.env.WASM_PACK = prev;
    }
  });
});

describe("vite pack.entry.wasm gate", () => {
  test("wasm entry stays WASM_PACK-gated", () => {
    const src = readFileSync(join(root, "vite.config.ts"), "utf8");
    expect(src).toContain('const packWasm = process.env.WASM_PACK === "1"');
    expect(src).toContain('...(packWasm ? { wasm: "src/wasm/index.ts" } : {})');
    expect(src).toContain("customExports: applyPackExports");
    expect(src.match(/wasm: "src\/wasm\/index\.ts"/g)).toEqual(['wasm: "src/wasm/index.ts"']);
  });
});
