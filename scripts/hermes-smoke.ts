/// <reference types="node" />
/**
 * Bundle tests/hermes/smoke.ts into a single classic script and run it on the
 * Hermes CLI (`HERMES` env var). Pass = stdout contains `HERMES_SMOKE_OK`;
 * Hermes exits 0 on unhandled async rejections, so the marker is the only
 * contract. The full Hermes output is printed either way.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo does not depend on @types/bun; declare the used surface.
interface BunBuildOutput {
  success: boolean;
  logs: readonly { toString(): string }[];
  outputs: readonly { kind: string }[];
}
interface BunResolver {
  onResolve(args: { filter: RegExp }, callback: () => { path: string }): void;
}
declare const Bun: {
  build(options: {
    entrypoints: string[];
    target: "browser";
    format: "iife";
    plugins?: { name: string; setup(build: BunResolver): void }[];
  }): Promise<BunBuildOutput>;
  write(path: string, data: unknown): Promise<unknown>;
  spawnSync(
    cmd: readonly string[],
    options: { stdout: "pipe"; stderr: "pipe" },
  ): { exitCode: number; stdout: { toString(): string }; stderr: { toString(): string } };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = resolve(root, ".hermes-smoke.iife.js");

const hermes = process.env.HERMES;
if (!hermes) {
  console.error("set HERMES to the hermes binary");
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: [resolve(root, "tests/hermes/smoke.ts")],
  target: "browser",
  format: "iife",
  plugins: [
    {
      name: "punycode-cjs",
      setup(build: BunResolver) {
        // tr46 (whatwg-url dependency) `require("punycode")`s; bun build maps
        // the specifier to its `node:punycode` ESM shim (default-only export),
        // so `punycode.ucs2` is undefined at runtime. Resolve to the installed
        // CJS implementation instead.
        build.onResolve({ filter: /^(node:)?punycode$/ }, () => ({
          path: resolve(root, "node_modules/punycode/punycode.js"),
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
const bundle = result.outputs.find((o: { kind: string }) => o.kind === "entry-point");
if (!bundle) {
  console.error("bun build produced no entry-point output");
  process.exit(1);
}
await Bun.write(outfile, bundle);

const proc = Bun.spawnSync([hermes, outfile], { stdout: "pipe", stderr: "pipe" });
const out = proc.stdout.toString() + proc.stderr.toString();
process.stdout.write(out);
if (proc.exitCode !== 0 || !out.includes("HERMES_SMOKE_OK")) {
  console.error(`hermes smoke failed (exit ${proc.exitCode}): no HERMES_SMOKE_OK`);
  process.exit(1);
}
