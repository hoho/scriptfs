import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts", cli: "src/native-cli.ts" },
    clean: true,
    dts: true,
    format: "esm",
    platform: "node",
    sourcemap: true,
  },
  {
    entry: { index: "packages/module/src/index.ts" },
    outDir: "packages/module/dist",
    tsconfig: "packages/module/tsconfig.json",
    clean: true,
    dts: true,
    format: "esm",
    platform: "node",
    sourcemap: true,
  },
  {
    entry: {
      index: "packages/testing/src/index.ts",
      cli: "packages/testing/src/cli.ts",
    },
    outDir: "packages/testing/dist",
    tsconfig: "packages/testing/tsconfig.json",
    // The installed scriptfs package provides the native binary and image.
    external: ["scriptfs"],
    clean: true,
    dts: true,
    format: "esm",
    platform: "node",
    sourcemap: true,
  },
]);
