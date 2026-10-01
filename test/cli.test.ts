import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.each([
  { outcome: "failure", code: 1 },
  { outcome: "stopped", code: 0 },
])(
  "exits after the runtime reports $outcome without waiting for a signal",
  async ({ outcome, code }) => {
    const result = await runCli(outcome);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(code);
    expect(result.stdout).toContain("cleanup completed");
    if (outcome === "failure")
      expect(result.stderr).toContain("runtime exited unexpectedly");
    else expect(result.stderr).toBe("");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a pending session alive and exits cleanly on SIGTERM",
  async () => {
    const result = await runCli("signal");
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("cleanup completed");
    expect(result.stderr).toBe("");
  },
);

it("checks Podman without loading a mount configuration or starting the runtime", async () => {
  const result = await runCli("stopped", "--check");
  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toContain("Linux runtime is ready");
  expect(result.stdout).not.toContain("configuration loaded");
  expect(result.stdout).not.toContain("runtime started");
  expect(result.stderr).toBe("");
});

it.each(["config", "--check"])(
  "reports missing Podman before creating mount resources with %s",
  async (argument) => {
    const result = await runCli("missing-podman", argument);
    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("Podman executable was not found on PATH");
    expect(result.stdout).not.toContain("runtime started");
    expect(result.stdout).not.toContain("cleanup completed");
  },
);

async function runCli(
  outcome: string,
  argument = "config",
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "scriptfs-cli-test-"));
  directories.push(root);
  await mkdir(path.join(root, "runtime"));
  const source = await readFile(
    new URL("../src/cli.ts", import.meta.url),
    "utf8",
  );
  await writeFile(
    path.join(root, "cli.js"),
    transpileModule(source, {
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
    }).outputText,
  );
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(root, "config.js"),
    'export async function loadConfig() { console.log("configuration loaded"); return {}; }\n',
  );
  await writeFile(
    path.join(root, "runtime", "podman-check.js"),
    `
export async function checkPodman() {
  if (${JSON.stringify(outcome)} === "missing-podman")
    throw new Error("Podman executable was not found on PATH");
}
`,
  );
  await writeFile(
    path.join(root, "runtime", "podman.js"),
    `
export class ScriptFsStartupError extends Error {}
export async function startScriptFs() {
  console.log("runtime started");
  return {
    mounts: new Map(),
    wait() {
      if (${JSON.stringify(outcome)} === "signal") return new Promise(() => {});
      if (${JSON.stringify(outcome)} === "failure")
        return Promise.reject(new Error("runtime exited unexpectedly"));
      return Promise.resolve();
    },
    async stop() { console.log("cleanup completed"); }
  };
}
`,
  );
  const child = spawn(process.execPath, [path.join(root, "cli.js"), argument], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let signalTimer: NodeJS.Timeout | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (
      outcome === "signal" &&
      !signalTimer &&
      stdout.includes("scriptfs is running")
    ) {
      signalTimer = setTimeout(() => child.kill("SIGTERM"), 100);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 3_000);
  try {
    await exited;
    return { code: child.exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
    if (signalTimer) clearTimeout(signalTimer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
