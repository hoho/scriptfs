import { ChildProcess } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectModule,
  loadConfig,
  scriptFsConfigSchema,
} from "../src/native-config.js";
import { startScriptFs, ScriptFsStartupError } from "../src/session.js";

const commands = vi.hoisted(() => ({
  spawn: vi.fn<(...args: unknown[]) => ChildProcess>(),
  spawnSync: vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  ...commands,
}));
vi.mock("../src/native-binary.js", () => ({
  nativeBinary: () => "/native/scriptfs",
  nativeEnvironment: () => ({ SCRIPTFS_NODE: "/native/node" }),
}));

const filesystem = { name: "code", source: "/source", mountPoint: "/mount" };
const config = { filesystems: [filesystem] };
const children: ChildProcess[] = [];

beforeEach(() => {
  commands.spawn.mockReset();
  commands.spawnSync.mockReset();
});
afterEach(() => {
  for (const child of children.splice(0)) child.emit("close", 0, null);
  vi.restoreAllMocks();
});

function configResponse(value: unknown, status = 0): SpawnSyncReturns<string> {
  const stdout = `SCRIPTFS_SDK:${JSON.stringify(value)}\n`;
  return {
    pid: 1,
    stdout,
    stderr: "",
    status,
    signal: null,
    output: [null, stdout, ""],
  };
}

function processFixture() {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);
  children.push(child);
  commands.spawn.mockReturnValueOnce(child);
  let input = "";
  stdin.on("data", (data: Buffer) => {
    input += data.toString();
  });
  return {
    child,
    kill,
    input: () => input,
    send: (message: unknown) =>
      stdout.write(`SCRIPTFS_SDK:${JSON.stringify(message)}\n`),
    raw: (message: string) => stdout.write(message),
    close: (code = 0) => child.emit("close", code, null),
  };
}

it("delegates configuration validation to Rust", () => {
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "config", config }),
  );
  expect(scriptFsConfigSchema.parse(config)).toEqual(config);
  expect(commands.spawnSync).toHaveBeenCalledWith(
    "/native/scriptfs",
    ["--sdk-config"],
    expect.objectContaining({
      input: `${JSON.stringify({ op: "validate", config })}\n`,
      env: { SCRIPTFS_NODE: "/native/node" },
    }),
  );
});

it("delegates configuration loading and path resolution to Rust", async () => {
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "config", config }),
  );
  expect(await loadConfig("relative/config.json")).toEqual(config);
  expect(commands.spawnSync).toHaveBeenCalledWith(
    "/native/scriptfs",
    ["--sdk-config"],
    expect.objectContaining({
      input: '{"op":"load","configPath":"relative/config.json"}\n',
    }),
  );
});

it("delegates module inspection to Rust in the requested directory", async () => {
  const module = {
    manifestPath: "/work/module/scriptfs.module.json",
    manifest: { name: "demo", entry: "./index.mjs" },
  };
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "module", module }),
  );
  expect(await inspectModule("./module", { cwd: "/work" })).toEqual(module);
  expect(commands.spawnSync).toHaveBeenCalledWith(
    "/native/scriptfs",
    ["--sdk-config"],
    expect.objectContaining({
      input: '{"op":"module","manifest":"./module"}\n',
      cwd: "/work",
    }),
  );
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "config", config }),
  );
  await expect(inspectModule("./module")).rejects.toThrow(
    "Invalid native configuration result",
  );
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "error", message: "Module entry not found: x" }, 1),
  );
  await expect(inspectModule("./module")).rejects.toThrow(
    "Module entry not found: x",
  );
});

it("exposes native validation failures through safeParse", () => {
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "error", message: "Invalid filesystem name" }, 1),
  );
  expect(scriptFsConfigSchema.safeParse({})).toMatchObject({
    success: false,
    error: { message: "Invalid filesystem name" },
  });
});

it("does not accept success-shaped output from a failed native process", () => {
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "config", config }, 1),
  );
  expect(() => scriptFsConfigSchema.parse(config)).toThrow(
    "Invalid native configuration result",
  );
});

it("reports a malformed native configuration response", () => {
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "config", config: {} }),
  );
  expect(() => scriptFsConfigSchema.parse(config)).toThrow(
    "Invalid native configuration result",
  );
});

it("propagates native process launch errors", () => {
  const response = configResponse({});
  response.error = Object.assign(new Error("Native binary unavailable"), {
    code: "ENOENT",
  });
  commands.spawnSync.mockReturnValueOnce(response);
  expect(() => scriptFsConfigSchema.parse(config)).toThrow(
    "Native binary unavailable",
  );
});

it("preserves literal JSON provider options in native output", () => {
  const optionsConfig = {
    modules: { generated: { manifest: "./generated" } },
    filesystems: [
      {
        ...config.filesystems[0],
        rules: [
          {
            match: "file",
            provider: { module: "generated", options: { $date: 1234 } },
          },
        ],
      },
    ],
  };
  commands.spawnSync.mockReturnValueOnce(
    configResponse({ event: "config", config: optionsConfig }),
  );
  expect(scriptFsConfigSchema.parse(optionsConfig)).toEqual(optionsConfig);
});

it("starts a native session and exposes its mounted shares", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  process.send({
    event: "ready",
    containerId: "container",
    mounts: [["code", "/mount"]],
  });
  const session = await started;
  expect(session.containerId).toBe("container");
  expect([...session.mounts]).toEqual([["code", "/mount"]]);
  expect(process.input()).toBe(`${JSON.stringify({ op: "start", config })}\n`);
  expect(commands.spawn).toHaveBeenCalledWith(
    "/native/scriptfs",
    ["--sdk"],
    expect.objectContaining({ env: { SCRIPTFS_NODE: "/native/node" } }),
  );
  process.send({ event: "stopped" });
  process.close();
  await session.wait();
});

it("coalesces stop requests and waits for the native process to close", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  process.send({ event: "ready", containerId: "container", mounts: [] });
  const session = await started;
  const stop = session.stop();
  expect(session.stop()).toBe(stop);
  expect(process.input().split("\n").filter(Boolean)).toHaveLength(2);
  process.send({ event: "stopped" });
  process.close();
  await stop;
  await session.wait();
  await session.stop();
});

it("reports runtime failure while allowing successful native cleanup", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  process.send({ event: "ready", containerId: "container", mounts: [] });
  const session = await started;
  const waited = expect(session.wait()).rejects.toThrow("runtime exited");
  process.send({ event: "error", message: "runtime exited" });
  process.send({ event: "stopped" });
  process.close(1);
  await waited;
  await session.stop();
});

it("rejects startup with a retryable session when cleanup is incomplete", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  const failed = expect(started).rejects.toBeInstanceOf(ScriptFsStartupError);
  process.send({
    event: "error",
    message: "Unmount failed",
    containerId: "container",
    mounts: [["code", "/mount"]],
    retryable: true,
  });
  await failed;
  const error = await started.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ScriptFsStartupError);
  if (!(error instanceof ScriptFsStartupError)) throw new Error("Wrong error");
  expect(error.session.containerId).toBe("container");
  const mounts = error.session.mounts;
  expect(mounts.size).toBe(1);
  const stop = error.session.stop();
  process.send({ event: "stopped" });
  process.close();
  await stop;
  expect(error.session.mounts.size).toBe(0);
  expect(mounts.size).toBe(0);
});

it("allows retrying a failed native cleanup request", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  process.send({ event: "ready", containerId: "container", mounts: [] });
  const session = await started;
  const firstStop = session.stop();
  const failed = expect(firstStop).rejects.toThrow("Unmount failed");
  process.send({
    event: "error",
    message: "Unmount failed",
    retryable: true,
  });
  await failed;
  const secondStop = session.stop();
  expect(secondStop).not.toBe(firstStop);
  process.send({ event: "stopped" });
  process.close();
  await secondStop;
});

it("does not launch a process for an already-aborted start", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await expect(
    startScriptFs(config, { signal: controller.signal }),
  ).rejects.toThrow("Cancelled");
  expect(commands.spawn).not.toHaveBeenCalled();
});

it("requests native cleanup when a running session is aborted", async () => {
  const process = processFixture();
  const controller = new AbortController();
  const started = startScriptFs(config, { signal: controller.signal });
  process.send({ event: "ready", containerId: "container", mounts: [] });
  const session = await started;
  controller.abort();
  expect(process.input()).toContain('{"op":"stop"}\n');
  process.send({ event: "stopped" });
  process.close();
  await session.wait();
});

it("does not return a session after startup cancellation", async () => {
  const process = processFixture();
  const controller = new AbortController();
  const started = startScriptFs(config, { signal: controller.signal });
  const failed = expect(started).rejects.toThrow("Cancelled");
  controller.abort(new Error("Cancelled"));
  process.send({ event: "stopped" });
  process.close();
  await failed;
});

it("rejects malformed native messages instead of silently continuing", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  const failed = expect(started).rejects.toBeInstanceOf(SyntaxError);
  process.raw("SCRIPTFS_SDK:not-json\n");
  await failed;
  expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  process.close(1);
});

it("propagates native session launch errors", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  const failed = expect(started).rejects.toThrow("Native binary unavailable");
  process.child.emit("error", new Error("Native binary unavailable"));
  process.close(1);
  await failed;
});

it("rejects non-JSON options before starting a native process", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await expect(
    startScriptFs({
      modules: { generated: { manifest: "./generated" } },
      filesystems: [
        {
          ...filesystem,
          rules: [
            {
              match: "file",
              provider: { module: "generated", options: circular },
            },
          ],
        },
      ],
    }),
  ).rejects.toThrow(/circular/i);
  expect(commands.spawn).not.toHaveBeenCalled();
});

it("does not expose recovery after a successfully rolled-back startup", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  const failed = expect(started).rejects.toThrow("Port occupied");
  process.send({
    event: "error",
    message: "Port occupied",
    containerId: "rolled-back-container",
    mounts: [],
    retryable: false,
  });
  await failed;
  expect(await started.catch((reason: unknown) => reason)).not.toBeInstanceOf(
    ScriptFsStartupError,
  );
  process.send({ event: "stopped" });
  process.close(1);
});

it("preserves AbortError when native startup cancellation finishes rollback", async () => {
  const process = processFixture();
  const controller = new AbortController();
  const started = startScriptFs(config, { signal: controller.signal });
  const failed = expect(started).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  process.send({
    event: "error",
    message: "Command cancelled",
    containerId: "rolled-back-container",
    mounts: [],
  });
  process.send({ event: "stopped" });
  process.close(1);
  await failed;
});

it("does not write another stop request after native shutdown is acknowledged", async () => {
  const process = processFixture();
  const started = startScriptFs(config);
  process.send({ event: "ready", containerId: "container", mounts: [] });
  const session = await started;
  process.send({ event: "stopped" });
  const stop = session.stop();
  expect(process.input().split("\n").filter(Boolean)).toHaveLength(1);
  process.close();
  await stop;
});
