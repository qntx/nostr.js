/**
 * After `vp pack` rewrites package.json exports as bare .mjs paths,
 * expand each entry with explicit `types` / `import` conditions for
 * TypeScript (node16/bundler) and modern package consumers.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

function toExportEntry(value) {
  if (typeof value !== "string") return value;
  if (value === "./package.json") return value;
  if (!value.endsWith(".mjs")) return value;
  const types = value.replace(/\.mjs$/, ".d.mts");
  return {
    types,
    import: value,
    default: value,
  };
}

const next = {};
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  next[key] = toExportEntry(value);
}
pkg.exports = next;

if (typeof pkg.exports["."] === "object" && pkg.exports["."].types) {
  pkg.types = pkg.exports["."].types;
}

pkg.sideEffects = false;

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("fixed package.json exports with types conditions");
