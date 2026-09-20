import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCommand } from "../src/runtime/command-runner.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("declares pnpm compatibility without pinning its runtime in the lockfile", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    engines: { pnpm: string };
    packageManager?: string;
  };
  expect(manifest.engines.pnpm).toBe(">=12.4.0 <13");
  expect(manifest.packageManager).toBeUndefined();
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");
  expect(lockfile).toMatch(/^lockfileVersion:/);
  expect(lockfile).not.toContain("packageManagerDependencies:");
  expect(lockfile).not.toContain("@pnpm/exe.");
});

it.skipIf(process.platform === "win32").each([
  { version: "12.4.0", compatible: true },
  { version: "12.4.2", compatible: true },
  { version: "12.10.0", compatible: true },
  { version: "12.4.2+vendor", compatible: true },
  { version: "12.3.99", compatible: false },
  { version: "13.0.0", compatible: false },
  { version: "12.4.0-rc.1", compatible: false },
])(
  "checks pnpm compatibility for $version",
  async ({ version, compatible }) => {
    const { executable, root, calls } = await fakePnpm(
      `console.log(${JSON.stringify(version)});`,
    );
    const podman = path.join(root, "podman");
    await writeFile(podman, "#!/usr/bin/env node\nprocess.exitCode = 0;\n");
    await chmod(podman, 0o755);
    const result = runCommand("make", [
      "check-deps",
      `PNPM=${executable}`,
      `PATH=${root}${path.delimiter}${process.env.PATH ?? ""}`,
    ]);
    if (compatible) {
      expect((await result).stdout).toContain("Dependencies are ready.");
    } else {
      await expect(result).rejects.toThrow(
        `pnpm >=12.4.0 <13 is required; found ${version}`,
      );
    }
    expect(await readFile(calls, "utf8")).toBe("called\n");
  },
);

it.skipIf(process.platform === "win32").each([
  {
    output: 'console.log("not a version");',
    error: "pnpm >=12.4.0 <13 is required; found not a version",
  },
  {
    output:
      'console.error("injected bootstrap failure"); process.exitCode = 7;',
    error: "Could not determine the pnpm version",
  },
])(
  "checks pnpm once when dependency bootstrap fails: $error",
  async ({ output, error }) => {
    const { executable, calls } = await fakePnpm(output);
    await expect(
      runCommand("make", ["check-deps", `PNPM=${executable}`]),
    ).rejects.toThrow(error);
    expect(await readFile(calls, "utf8")).toBe("called\n");
  },
);

async function fakePnpm(output: string): Promise<{
  executable: string;
  root: string;
  calls: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "scriptfs-bootstrap-test-"));
  directories.push(root);
  const executable = path.join(root, "pnpm");
  const calls = path.join(root, "calls");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(calls)}, "called\\n");
${output}
`,
  );
  await chmod(executable, 0o755);
  return { executable, root, calls };
}

it.skipIf(process.platform === "win32").each([
  { state: "running", actions: ["info"] },
  { state: "stopped", actions: ["info", "list", "start", "info"] },
  { state: "missing", actions: ["info", "list", "init", "start", "info"] },
  { state: "custom", actions: ["info", "list", "start", "info"] },
  { state: "sole-machine", actions: ["info", "list", "start", "info"] },
  { state: "default-custom", actions: ["info", "list", "start", "info"] },
  {
    state: "custom-missing",
    actions: ["info", "list", "init", "start", "info"],
  },
  { state: "ambiguous", actions: ["info", "list"], fails: true },
  { state: "unknown-machine", actions: ["info", "list"], fails: true },
  { state: "invalid-list", actions: ["info", "list"], fails: true },
  { state: "list-failure", actions: ["info", "list"], fails: true },
  { state: "init-failure", actions: ["info", "list", "init"], fails: true },
  { state: "start-failure", actions: ["info", "list", "start"], fails: true },
  {
    state: "unreachable",
    actions: ["info", "list", "start", "info"],
    fails: true,
  },
])("starts Podman safely when $state", async ({ state, actions, fails }) => {
  const root = await mkdtemp(path.join(tmpdir(), "scriptfs-podman-make-test-"));
  directories.push(root);
  const executable = path.join(root, "podman");
  const calls = path.join(root, "calls");
  const started = path.join(root, "started");
  const machine = [
    "custom",
    "sole-machine",
    "default-custom",
    "custom-missing",
  ].includes(state)
    ? "my-vm"
    : "podman-machine-default";
  const requested =
    state === "custom" || state === "custom-missing"
      ? "my-vm"
      : state === "unknown-machine"
        ? "missing-vm"
        : "";
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
const action = args[0] === "info" ? "info" : args[1];
fs.appendFileSync(${JSON.stringify(calls)}, action + "\\n");
if (state === action + "-failure") {
  console.error(state);
  process.exit(1);
}
if (action === "info") {
  if (state === "running" || (state !== "unreachable" && fs.existsSync(${JSON.stringify(started)})))
    process.exit(0);
  console.error("Podman unavailable");
  process.exit(1);
}
if (action === "list") {
  const machines = state === "invalid-list"
    ? {}
    : ["missing", "custom-missing", "init-failure"].includes(state)
      ? []
      : state === "sole-machine"
        ? [{Name:"my-vm",Default:false}]
        : state === "custom" || state === "ambiguous" || state === "default-custom"
          ? [{Name:"other-vm",Default:false},{Name:"my-vm",Default:state==="default-custom"}]
          : [{Name:"podman-machine-default",Default:true}];
  if (args[3] === "{{.Name}}") {
    console.log(machines.map(machine=>machine.Name+(machine.Default?"*":"")).join("\\n"));
  } else {
    assert.deepEqual(args, ["machine", "list", "--format", "json"]);
    console.log(JSON.stringify(machines));
  }
} else if (action === "init") {
  assert.deepEqual(args, ["machine", "init", ${JSON.stringify(machine)}]);
} else if (action === "start") {
  assert.deepEqual(args, ["machine", "start", "--update-connection", ${JSON.stringify(machine)}]);
  fs.writeFileSync(${JSON.stringify(started)}, "started");
} else {
  throw new Error("Unexpected Podman command: " + args.join(" "));
}
`,
  );
  await chmod(executable, 0o755);
  const result = runCommand("make", [
    "start-podman",
    `PODMAN_MACHINE=${requested}`,
    `PATH=${root}${path.delimiter}${process.env.PATH ?? ""}`,
  ]);
  if (fails) {
    await expect(result).rejects.toThrow(
      state === "ambiguous" || state === "unknown-machine"
        ? "Use make start-podman PODMAN_MACHINE=<name>"
        : state === "invalid-list"
          ? "Invalid Podman machine list"
          : state === "unreachable"
            ? "Podman unavailable"
            : state,
    );
  } else {
    expect((await result).stdout).toContain(
      state === "running" ? "Podman is already available." : "Podman is ready.",
    );
  }
  expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(actions);
});
