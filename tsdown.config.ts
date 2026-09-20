import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/container/main.ts"],
  clean: true,
  dts: true,
  external: ["@cocalc/fuse-native"],
  format: "esm",
  platform: "node",
  sourcemap: true,
});
