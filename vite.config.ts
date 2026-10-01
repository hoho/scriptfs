import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    port: 5173,
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      // These exercise the Linux container's native filesystem on the test host.
      ...(process.platform === "win32"
        ? [
            "test/filesystem-io.test.ts",
            "test/fuse-adapter.test.ts",
            "test/overlay-filesystem.test.ts",
          ]
        : []),
    ],
  },
});
