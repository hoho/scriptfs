import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const windows = process.platform === "win32";

/**
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {Promise<number>}
 */
function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

// Example modules carry their own @scriptfs/testing suites.
/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function exampleTests(directory = path.join(root, "examples")) {
  /** @type {string[]} */
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !["node_modules", "mount", "mount-readonly", ".scriptfs"].includes(
          entry.name,
        )
      )
        files.push(...(await exampleTests(location)));
    } else if (entry.name.endsWith(".test.mjs")) files.push(location);
  }
  return files;
}

const examplesOnly = process.argv[2] === "--examples";
const args = process.argv.slice(2);
let code = examplesOnly
  ? 0
  : await run(
      [
        vitest,
        "run",
        windows
          ? path.join("test", "e2e", "windows-mount.test.ts")
          : path.join("test", "e2e"),
        "--no-file-parallelism",
        ...args,
      ],
      { env: { ...process.env, SCRIPTFS_E2E_REBUILD: "0" } },
    );
// Filtered runs target the platform suites only.
if (code === 0 && !windows && (examplesOnly || args.length === 0))
  // Like the platform suites, examples share the container engine and SMB
  // mount client. Concurrent suite startup can time out macOS SMB mounts.
  code = await run(
    ["--test", "--test-concurrency=1", ...(await exampleTests())],
    {
      cwd: path.join(root, "examples"),
      env: {
        ...process.env,
        SCRIPTFS_TEST_IMAGE:
          process.env.SCRIPTFS_TEST_IMAGE ??
          process.env.SCRIPTFS_E2E_RUNTIME_IMAGE,
      },
    },
  );
process.exitCode = code;
