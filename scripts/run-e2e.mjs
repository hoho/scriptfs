import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rebuild = process.argv.includes("--rebuild");
const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const child = spawn(
  process.execPath,
  [
    vitest,
    "run",
    process.platform === "win32"
      ? path.join("test", "e2e", "windows-mount.test.ts")
      : path.join("test", "e2e"),
    "--no-file-parallelism",
  ],
  {
    env: {
      ...process.env,
      SCRIPTFS_E2E_REBUILD: rebuild ? "1" : "0",
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
