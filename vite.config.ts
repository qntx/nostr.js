import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: {
      index: "src/index.ts",
      core: "src/core/index.ts",
      signer: "src/signer/index.ts",
      relay: "src/relay/index.ts",
      client: "src/client/index.ts",
      storage: "src/storage/index.ts",
      loaders: "src/loaders/index.ts",
      gossip: "src/gossip/index.ts",
      "nips/nip04": "src/nips/nip04.ts",
      "nips/nip05": "src/nips/nip05.ts",
      "nips/nip10": "src/nips/nip10.ts",
      "nips/nip19": "src/nips/nip19.ts",
      "nips/nip21": "src/nips/nip21.ts",
      "nips/nip27": "src/nips/nip27.ts",
      "nips/nip42": "src/nips/nip42.ts",
      "nips/nip44": "src/nips/nip44.ts",
      "nips/nip46": "src/nips/nip46.ts",
      "nips/nip65": "src/nips/nip65.ts",
    },
    dts: {
      tsgo: true,
    },
    sourcemap: true,
    exports: true,
  },
  test: {
    include: ["tests/**/*.{test,spec}.ts"],
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
