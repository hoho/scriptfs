import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@scriptfs/module": fileURLToPath(
        new URL("packages/module/src/index.ts", import.meta.url),
      ),
      "@scriptfs/testing": fileURLToPath(
        new URL("packages/testing/src/index.ts", import.meta.url),
      ),
      "scriptfs": fileURLToPath(new URL("src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    exclude: [...configDefaults.exclude, "target/**", "examples/**"],
  },
});
