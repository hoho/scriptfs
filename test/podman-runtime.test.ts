import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startScriptFs, ScriptFsStartupError } from "../src/runtime/podman.js";
import { mountShare } from "../src/runtime/host-mount.js";
import { runCommand } from "../src/runtime/command-runner.js";
import { loadConfig } from "../src/config.js";
import type { ScriptFsConfig, ScriptFsSession } from "../src/types.js";
import type { CommandResult } from "../src/runtime/command-runner.js";

vi.mock("../src/runtime/command-runner.js", () => ({ runCommand: vi.fn() }));
vi.mock("../src/runtime/host-mount.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/host-mount.js")>()),
  mountShare: vi.fn(),
}));

let root: string;
let config: ScriptFsConfig;
let runtimeConfigPath: string;
let createArguments: readonly string[];
let sessions: ScriptFsSession[];
let containerExit: ReturnType<typeof deferred<CommandResult>>;
const unmount = vi.fn<() => Promise<void>>();

beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-runtime-test-"));
  config = {
    filesystems: [
      { name: "test", source: root, mountPoint: path.join(root, "mount") },
    ],
    container: { logLevel: "silent" },
  };
  sessions = [];
  runtimeConfigPath = "";
  createArguments = [];
  containerExit = deferred();
  unmount.mockResolvedValue();
  vi.mocked(mountShare).mockImplementation((_host, _port, _share, mountPoint) =>
    Promise.resolve({ mountPoint, unmount }),
  );
  vi.mocked(runCommand).mockImplementation(async (command, args) => {
    if (command !== "podman") throw new Error(`Unexpected command ${command}`);
    if (args[0] === "wait") return containerExit.promise;
    const stdout =
      args[0] === "image"
        ? "exists\n"
        : args[0] === "create"
          ? "test-container\n"
          : args[0] === "inspect"
            ? "running\n"
            : args[0] === "exec"
              ? "ready\n"
              : args[0] === "logs"
                ? "SCRIPTFS_READY\n"
                : args[0] === "port"
                  ? "127.0.0.1:14445\n"
                  : "";
    if (args[0] === "create") {
      createArguments = args;
      const configMount = args.find((arg) =>
        arg.endsWith(":/scriptfs/config.json:ro"),
      );
      if (!configMount) throw new Error("Missing config mount");
      runtimeConfigPath = configMount.slice(
        0,
        -":/scriptfs/config.json:ro".length,
      );
      await stat(runtimeConfigPath);
    }
    if (args[0] === "stop") {
      containerExit.resolve({ stdout: "0\n", stderr: "" });
    }
    return { stdout, stderr: "" };
  });
});

afterEach(async () => {
  for (const session of sessions) await session.stop();
  await rm(root, { recursive: true, force: true });
});

async function start(signal?: AbortSignal): Promise<ScriptFsSession> {
  const session = await startScriptFs(config, { signal });
  sessions.push(session);
  return session;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

it("keeps the server and configuration alive after a busy unmount and retries cleanup", async () => {
  const session = await start();
  unmount.mockRejectedValueOnce(new Error("Resource busy"));
  await expect(session.stop()).rejects.toThrow("Resource busy");
  expect(
    vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "stop"),
  ).toBe(false);
  await expect(stat(runtimeConfigPath)).resolves.toBeDefined();
  await session.stop();
  expect(unmount).toHaveBeenCalledTimes(2);
  await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const count = vi.mocked(runCommand).mock.calls.length;
  await session.stop();
  expect(vi.mocked(runCommand).mock.calls.length).toBe(count);
});

it.each([
  "umount: mount: not mounted",
  "umount: mount: not currently mounted",
  "The network connection could not be found.",
  "System error 2250 has occurred.",
  "The network connection could not be found.\r\n\r\nMore help is available by typing NET HELPMSG 2250.\r\n",
])(
  "finishes cleanup when the share is already unmounted: %s",
  async (message) => {
    const session = await start();
    unmount.mockRejectedValueOnce(new Error(message));
    await session.stop();
    expect(session.mounts.size).toBe(0);
    expect(
      vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "rm"),
    ).toBe(true);
    await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each([
  "/sbin/umount /tmp/not mounted/mount failed with exit code 1\numount: /tmp/not mounted/mount: Resource busy",
  "umount: /tmp/not currently mounted: target is busy.",
  "umount: /tmp/network connection could not be found: Resource busy",
  "umount: /tmp/system error 2250: Resource busy",
  "umount: /tmp/\nnot mounted\n/mount: Resource busy",
  "umount: /tmp/\nThe network connection could not be found.\n/mount: Resource busy",
])(
  "does not mistake a busy mount's path for successful cleanup: %s",
  async (message) => {
    const session = await start();
    unmount.mockRejectedValueOnce(new Error(message));
    await expect(session.stop()).rejects.toThrow(message);
    expect(session.mounts.size).toBe(1);
    expect(
      vi
        .mocked(runCommand)
        .mock.calls.some(([, args]) => args[0] === "stop" || args[0] === "rm"),
    ).toBe(false);
    await expect(stat(runtimeConfigPath)).resolves.toBeDefined();
    await session.stop();
    expect(session.mounts.size).toBe(0);
  },
);

it("surfaces failed container removal and retries without unmounting twice", async () => {
  const session = await start();
  const original = vi.mocked(runCommand).getMockImplementation();
  if (!original) throw new Error("Missing command mock");
  let failed = false;
  vi.mocked(runCommand).mockImplementation((command, args, options) => {
    if (args[0] === "rm" && !failed) {
      failed = true;
      return Promise.reject(new Error("remove failed"));
    }
    return original(command, args, options);
  });
  await expect(session.stop()).rejects.toThrow("remove failed");
  await session.stop();
  expect(unmount).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(runCommand).mock.calls.filter(([, args]) => args[0] === "rm"),
  ).toHaveLength(2);
});

it("does not start any commands when already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(start(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(runCommand).not.toHaveBeenCalled();
});

it("rejects symbolic-link file proxies before creating runtime resources", async () => {
  await writeFile(path.join(root, "target"), "target");
  const alias = path.join(root, "alias");
  await symlink("target", alias);
  config.filesystems[0] = {
    name: "test",
    source: root,
    mountPoint: path.join(root, "mount"),
    rules: [{ match: "Proxy", provider: { type: "file", path: alias } }],
  };
  await expect(start()).rejects.toThrow("a regular file, not a symbolic link");
  expect(runCommand).not.toHaveBeenCalled();
  expect(mountShare).not.toHaveBeenCalled();
});

it.each([false, true])(
  "cleans up a failed container start and supports removal retry=%s",
  async (failRemoval) => {
    const original = vi.mocked(runCommand).getMockImplementation();
    if (!original) throw new Error("Missing command mock");
    let removalFailed = false;
    vi.mocked(runCommand).mockImplementation((command, args, options) => {
      if (args[0] === "start")
        return Promise.reject(new Error("SMB port already in use"));
      if (args[0] === "logs")
        return Promise.resolve({ stdout: "", stderr: "" });
      if (args[0] === "rm" && failRemoval && !removalFailed) {
        removalFailed = true;
        return Promise.reject(new Error("remove failed"));
      }
      return original(command, args, options);
    });
    const error = await startScriptFs(config).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.message).toContain(
      "SMB port already in use",
    );
    expect(runCommand).toHaveBeenCalledWith(
      "podman",
      ["start", "test-container"],
      { signal: undefined, timeoutMs: 60_000 },
    );
    expect(runCommand).toHaveBeenCalledWith(
      "podman",
      ["rm", "--ignore", "--force", "test-container"],
      { timeoutMs: 60_000 },
    );
    expect(
      vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "wait"),
    ).toBe(false);
    expect(mountShare).not.toHaveBeenCalled();
    if (failRemoval) {
      if (!(error instanceof ScriptFsStartupError))
        throw new Error("Expected cleanup session");
      expect(error.message).toContain("remove failed");
      expect(error.session.containerId).toBe("test-container");
      expect(error.session.mounts.size).toBe(0);
      sessions.push(error.session);
      await expect(stat(runtimeConfigPath)).resolves.toBeDefined();
      await error.session.stop();
    } else {
      expect(error).not.toBeInstanceOf(ScriptFsStartupError);
    }
    await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("removes a created container when cancelled before starting it", async () => {
  const controller = new AbortController();
  const original = vi.mocked(runCommand).getMockImplementation();
  if (!original) throw new Error("Missing command mock");
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    const result = await original(command, args, options);
    if (args[0] === "create") controller.abort();
    return result;
  });
  await expect(start(controller.signal)).rejects.toThrow();
  expect(
    vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "start"),
  ).toBe(false);
  expect(runCommand).toHaveBeenCalledWith(
    "podman",
    ["rm", "--ignore", "--force", "test-container"],
    { timeoutMs: 60_000 },
  );
  expect(mountShare).not.toHaveBeenCalled();
  await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects case-insensitive SMB share-name collisions before creating resources", async () => {
  config.filesystems = [
    { name: "Work", source: root, mountPoint: path.join(root, "upper") },
    { name: "work", source: root, mountPoint: path.join(root, "lower") },
  ];
  await expect(start()).rejects.toThrow("unique name");
  expect(runCommand).not.toHaveBeenCalled();
  expect(mountShare).not.toHaveBeenCalled();
});

it.each([
  "bad\n[extra]",
  "bad name",
  "bad/path",
  "global",
  "GLOBAL",
  "Homes",
  "pRiNtErS",
])(
  "rejects unsafe programmatic share name %j before creating resources",
  async (name) => {
    config.filesystems[0] = {
      name,
      source: root,
      mountPoint: path.join(root, "mount"),
    };
    await expect(start()).rejects.toThrow();
    expect(runCommand).not.toHaveBeenCalled();
    expect(mountShare).not.toHaveBeenCalled();
  },
);

it("rolls back cancellation during the last host mount", async () => {
  const controller = new AbortController();
  vi.mocked(mountShare).mockImplementationOnce(
    (_host, _port, _share, mountPoint) => {
      controller.abort();
      return Promise.resolve({ mountPoint, unmount });
    },
  );
  await expect(start(controller.signal)).rejects.toThrow();
  expect(unmount).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "rm"),
  ).toBe(true);
  await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("cleans up a running session when its signal is aborted", async () => {
  const controller = new AbortController();
  const session = await start(controller.signal);
  controller.abort();
  await session.stop();
  expect(unmount).toHaveBeenCalledTimes(1);
  await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("reports unexpected container termination through the session", async () => {
  const session = await start();
  containerExit.resolve({ stdout: "137\n", stderr: "" });
  await expect(session.wait()).rejects.toThrow(
    "scriptfs container test-container exited with status 137",
  );
});

it("retains the startup error if obtaining logs fails", async () => {
  const original = vi.mocked(runCommand).getMockImplementation();
  if (!original) throw new Error("Missing command mock");
  vi.mocked(runCommand).mockImplementation((command, args, options) => {
    if (args[0] === "inspect")
      return Promise.resolve({ stdout: "exited", stderr: "" });
    if (args[0] === "logs") return Promise.reject(new Error("logs failed"));
    return original(command, args, options);
  });
  await expect(start()).rejects.toThrow(
    /container stopped during startup.*logs failed/s,
  );
  expect(runCommand).toHaveBeenCalledWith(
    "podman",
    ["logs", "--tail", "1000", "test-container"],
    { allowFailure: true, timeoutMs: 10_000 },
  );
  expect(
    vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "rm"),
  ).toBe(true);
});

it("exposes a retryable cleanup session when startup rollback is busy", async () => {
  config.filesystems.push({
    name: "second",
    source: root,
    mountPoint: path.join(root, "second"),
  });
  vi.mocked(mountShare)
    .mockResolvedValueOnce({ mountPoint: path.join(root, "mount"), unmount })
    .mockRejectedValueOnce(new Error("second mount failed"));
  unmount.mockRejectedValueOnce(new Error("Resource busy"));
  const error = await startScriptFs(config).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ScriptFsStartupError);
  if (!(error instanceof ScriptFsStartupError))
    throw new Error("Expected cleanup session");
  expect(error.message).toContain("second mount failed");
  expect(error.session.mounts.size).toBe(1);
  sessions.push(error.session);
  await error.session.stop();
  expect(error.session.mounts.size).toBe(0);
  await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("uses import conditions for bare provider names during programmatic startup", async () => {
  const provider = path.join(root, "node_modules", "provider");
  await mkdir(provider, { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(
    path.join(provider, "package.json"),
    JSON.stringify({
      name: "provider",
      type: "module",
      exports: { ".": { import: "./provider.mjs" } },
    }),
  );
  await writeFile(path.join(provider, "provider.mjs"), "export default {}");
  config.filesystems[0] = {
    name: "test",
    source: root,
    mountPoint: path.join(root, "mount"),
    rules: [{ match: "file", provider: { module: "provider" } }],
  };
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    await start();
  } finally {
    cwd.mockRestore();
  }
  expect(createArguments).toContain(
    `${await realpath(root)}:/scriptfs/providers/0:ro`,
  );
});

it("uses an explicit readiness file instead of polling container logs", async () => {
  await start();
  expect(
    vi
      .mocked(runCommand)
      .mock.calls.some(
        ([, args]) =>
          args[0] === "exec" &&
          args[2] === "cat" &&
          args[3] === "/tmp/scriptfs-ready",
      ),
  ).toBe(true);
  expect(
    vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "logs"),
  ).toBe(false);
});

it("permits FUSE through per-container AppArmor settings without privileged mode", async () => {
  await start();
  expect(
    createArguments.filter(
      (_argument, index) => createArguments[index - 1] === "--security-opt",
    ),
  ).toEqual(["label=disable", "apparmor=unconfined"]);
  expect(createArguments).toContain("SYS_ADMIN");
  expect(createArguments).not.toContain("--privileged");
});

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error("Command interrupted", { cause: reason });
}

function stallCommand(operation: string): Promise<AbortSignal> {
  const entered = deferred<AbortSignal>();
  const original = vi.mocked(runCommand).getMockImplementation();
  if (!original) throw new Error("Missing command mock");
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    const result = await original(command, args, options);
    if (args[0] !== operation) return result;
    const signal = options?.signal;
    if (!signal) throw new Error(`Missing cancellation for ${operation}`);
    signal.throwIfAborted();
    entered.resolve(signal);
    return new Promise<CommandResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError(signal)), {
        once: true,
      });
    });
  });
  return entered.promise;
}

it.each(["darwin", "linux", "win32"])(
  "discovers the configured npm registry safely on %s before building",
  async (platform) => {
    const original = vi.mocked(runCommand).getMockImplementation();
    if (!original) throw new Error("Missing command mock");
    const registryCommand = platform === "win32" ? "cmd.exe" : "npm";
    const registryArgs =
      platform === "win32"
        ? ["/d", "/s", "/c", "npm config get registry"]
        : ["config", "get", "registry"];
    vi.mocked(runCommand).mockImplementation((command, args, options) => {
      if (command === registryCommand)
        return Promise.resolve({
          stdout: "https://registry.example.invalid/\n",
          stderr: "",
        });
      if (command === "podman" && args[0] === "build")
        return Promise.resolve({ stdout: "", stderr: "" });
      return original(command, args, options);
    });
    config.container = { rebuild: true, logLevel: "silent" };
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key, receiver): unknown =>
          key === "platform" ? platform : Reflect.get(target, key, receiver),
      }),
    );
    try {
      const controller = new AbortController();
      await start(controller.signal);
      expect(runCommand).toHaveBeenCalledWith(registryCommand, registryArgs, {
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      expect(runCommand).toHaveBeenCalledWith(
        "podman",
        expect.arrayContaining([
          "--build-arg",
          "NPM_REGISTRY=https://registry.example.invalid/",
        ]),
        { output: "inherit", signal: controller.signal, timeoutMs: 600_000 },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each(["registry", "build"])(
  "cancels a stalled %s command before creating a container",
  async (operation) => {
    config.container = { rebuild: true, logLevel: "silent" };
    const entered = deferred<undefined>();
    const controller = new AbortController();
    vi.mocked(runCommand).mockImplementation((command, args, options) => {
      const registryCommand = process.platform === "win32" ? "cmd.exe" : "npm";
      if (command === registryCommand && operation === "build")
        return Promise.resolve({
          stdout: "https://registry.example.invalid/\n",
          stderr: "",
        });
      expect(command).toBe(
        operation === "registry" ? registryCommand : "podman",
      );
      if (operation === "build") {
        expect(args).toContain(
          "NPM_REGISTRY=https://registry.example.invalid/",
        );
        expect(options?.timeoutMs).toBe(10 * 60_000);
      } else expect(options?.timeoutMs).toBe(60_000);
      const signal = options?.signal;
      if (!signal) throw new Error("Missing build cancellation");
      entered.resolve(undefined);
      return new Promise<CommandResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError(signal)), {
          once: true,
        });
      });
    });
    const running = start(controller.signal);
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    await entered.promise;
    controller.abort();
    await rejected;
    expect(mountShare).not.toHaveBeenCalled();
  },
);

it("rolls back by the assigned name if create returns no container ID", async () => {
  const original = vi.mocked(runCommand).getMockImplementation();
  if (!original) throw new Error("Missing command mock");
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    const result = await original(command, args, options);
    return args[0] === "create" ? { stdout: "", stderr: "" } : result;
  });
  await expect(start()).rejects.toThrow("Podman returned no container ID");
  const name = createArguments[createArguments.indexOf("--name") + 1];
  expect(name).toMatch(/^scriptfs-/);
  expect(runCommand).toHaveBeenCalledWith(
    "podman",
    ["rm", "--ignore", "--force", name],
    { timeoutMs: 60_000 },
  );
  expect(mountShare).not.toHaveBeenCalled();
});

it.each(["image", "create", "start", "inspect", "exec", "port"])(
  "cancels a stalled %s command and rolls back owned resources",
  async (operation) => {
    const entered = stallCommand(operation);
    const controller = new AbortController();
    const running = start(controller.signal);
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    const commandSignal = await entered;
    controller.abort();
    await rejected;
    expect(commandSignal.aborted).toBe(true);
    expect(mountShare).not.toHaveBeenCalled();
    if (operation === "image") {
      expect(
        vi
          .mocked(runCommand)
          .mock.calls.some(([, args]) => args[0] === "create"),
      ).toBe(false);
    } else {
      const target =
        operation === "create"
          ? createArguments[createArguments.indexOf("--name") + 1]
          : "test-container";
      if (operation === "create") expect(target).toMatch(/^scriptfs-/);
      expect(runCommand).toHaveBeenCalledWith(
        "podman",
        ["rm", "--ignore", "--force", target],
        { timeoutMs: 60_000 },
      );
      await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(
      vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "logs"),
    ).toBe(false);
  },
);

it.each(["inspect", "exec"])(
  "enforces the readiness deadline while %s never returns",
  async (operation) => {
    vi.useFakeTimers();
    try {
      const entered = stallCommand(operation);
      const running = start();
      const rejected = expect(running).rejects.toThrow(
        "Timed out waiting for the scriptfs container",
      );
      const signal = await entered;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(signal.aborted).toBe(false);
      expect(
        vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "stop"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(
        "podman",
        ["rm", "--ignore", "--force", "test-container"],
        { timeoutMs: 60_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

it("interrupts a stalled readiness command when the container exits", async () => {
  const entered = stallCommand("exec");
  const running = start();
  const rejected = expect(running).rejects.toThrow(
    "scriptfs container test-container exited with status 42",
  );
  const signal = await entered;
  containerExit.resolve({ stdout: "42\n", stderr: "" });
  await rejected;
  expect(signal.aborted).toBe(true);
});

it("terminates a stalled exit monitor after the container is removed", async () => {
  const original = vi.mocked(runCommand).getMockImplementation();
  if (!original) throw new Error("Missing command mock");
  let monitorSignal: AbortSignal | undefined;
  vi.mocked(runCommand).mockImplementation((command, args, options) => {
    if (args[0] !== "wait") return original(command, args, options);
    monitorSignal = options?.signal;
    if (!monitorSignal) throw new Error("Missing monitor cancellation");
    const signal = monitorSignal;
    return new Promise<CommandResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError(signal)), {
        once: true,
      });
    });
  });
  const session = await start();
  await session.stop();
  expect(monitorSignal?.aborted).toBe(true);
  await expect(session.wait()).resolves.toBeUndefined();
});

it("keeps failed rollback retryable without reusing the cancelled signal", async () => {
  const entered = stallCommand("exec");
  const controller = new AbortController();
  const original = vi.mocked(runCommand).getMockImplementation();
  if (!original) throw new Error("Missing command mock");
  let failed = false;
  vi.mocked(runCommand).mockImplementation((command, args, options) => {
    if (args[0] === "rm" && !failed) {
      failed = true;
      return Promise.reject(new Error("cleanup timed out"));
    }
    return original(command, args, options);
  });
  const running = startScriptFs(config, { signal: controller.signal }).catch(
    (error: unknown) => error,
  );
  await entered;
  controller.abort();
  const error = await running;
  expect(error).toBeInstanceOf(ScriptFsStartupError);
  if (!(error instanceof ScriptFsStartupError))
    throw new Error("Missing cleanup recovery session");
  sessions.push(error.session);
  await expect(stat(runtimeConfigPath)).resolves.toBeDefined();
  await error.session.stop();
  await expect(stat(runtimeConfigPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    vi
      .mocked(runCommand)
      .mock.calls.filter(([, args]) => args[0] === "stop" || args[0] === "rm")
      .every(
        ([, , options]) =>
          options?.signal === undefined && options?.timeoutMs === 60_000,
      ),
  ).toBe(true);
});

it("mounts file proxy parents and enforces read-only proxy bind mounts", async () => {
  const target = path.join(root, "target");
  await writeFile(target, "value");
  config.filesystems[0] = {
    name: "test",
    source: root,
    mountPoint: path.join(root, "mount"),
    readOnly: true,
    rules: [{ match: "file", provider: { type: "file", path: target } }],
  };
  await start();
  expect(createArguments).toContain(`${root}:/scriptfs/proxies/0:ro`);
  const runtimeConfig = JSON.parse(
    await readFile(runtimeConfigPath, "utf8"),
  ) as ScriptFsConfig;
  expect(runtimeConfig.filesystems[0]?.rules?.[0]).toMatchObject({
    provider: { path: "/scriptfs/proxies/0/target" },
  });
});

it("resolves programmatic host paths before validation and Podman mounts without mutating the input", async () => {
  await mkdir(path.join(root, "source"));
  await mkdir(path.join(root, "directory"));
  await writeFile(path.join(root, "target"), "value");
  config.filesystems = [
    {
      name: "test",
      source: "source",
      mountPoint: "mount",
      rules: [
        { match: "File", provider: { type: "file", path: "target" } },
        {
          match: "Directory/**",
          root: "Directory",
          provider: { type: "directory", path: "directory" },
        },
      ],
    },
  ];
  const input = structuredClone(config);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  let session: ScriptFsSession;
  try {
    session = await start();
  } finally {
    cwd.mockRestore();
  }
  expect(config).toEqual(input);
  expect(createArguments).toContain(
    `${path.join(root, "source")}:/scriptfs/sources/0`,
  );
  expect(createArguments).toContain(`${root}:/scriptfs/proxies/0`);
  expect(createArguments).toContain(
    `${path.join(root, "directory")}:/scriptfs/proxies/1`,
  );
  expect(mountShare).toHaveBeenCalledWith(
    "127.0.0.1",
    14445,
    "test",
    path.join(root, "mount"),
  );
  expect(session.mounts.get("test")).toBe(path.join(root, "mount"));
});

it("uses the same schema-normalized rules for programmatic and file-based startup", async () => {
  const modulePath = path.join(root, "provider.mjs");
  await writeFile(modulePath, "export default {}");
  const rule = {
    match: "Virtual",
    provider: { module: modulePath },
    hide: false,
  };
  config.filesystems[0] = {
    name: "test",
    source: root,
    mountPoint: path.join(root, "mount"),
    rules: [rule],
  };
  const original = structuredClone(config);
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const direct = await start();
  const directConfig = JSON.parse(
    await readFile(runtimeConfigPath, "utf8"),
  ) as ScriptFsConfig;
  expect(config).toEqual(original);
  await direct.stop();

  config = await loadConfig(configPath);
  await start();
  const loadedConfig = JSON.parse(
    await readFile(runtimeConfigPath, "utf8"),
  ) as ScriptFsConfig;
  expect(directConfig).toEqual(loadedConfig);
  expect(directConfig.filesystems[0]?.rules?.[0]).toEqual({
    match: "Virtual",
    provider: { module: "/scriptfs/providers/0/provider.mjs" },
  });
});

it("validates provider paths in every filesystem before creating resources", async () => {
  config.filesystems.push({
    name: "second",
    source: root,
    mountPoint: path.join(root, "second"),
    rules: [{ match: "Virtual", provider: { module: "./provider.mjs" } }],
  });
  await expect(start()).rejects.toThrow(
    "Provider paths must be absolute after config loading",
  );
  expect(runCommand).not.toHaveBeenCalled();
});

it.each([
  "node_modules/provider",
  "node_modules/.pnpm/provider@1/node_modules/provider",
  "packages/provider",
])("preserves sibling dependencies for provider layout %s", async (layout) => {
  const project = path.join(root, "project");
  const provider = path.join(project, layout);
  await mkdir(provider, { recursive: true });
  await mkdir(path.join(project, "node_modules", "dependency"), {
    recursive: true,
  });
  await writeFile(path.join(project, "package.json"), "{}");
  await writeFile(path.join(provider, "package.json"), "{}");
  const modulePath = path.join(provider, "index.mjs");
  await writeFile(modulePath, "export default {}");
  config.filesystems[0] = {
    name: "test",
    source: root,
    mountPoint: path.join(root, "mount"),
    rules: [{ match: "file", provider: { module: modulePath } }],
  };
  await start();
  expect(createArguments).toContain(
    `${await realpath(project)}:/scriptfs/providers/0:ro`,
  );
  const runtimeConfig = JSON.parse(
    await readFile(runtimeConfigPath, "utf8"),
  ) as ScriptFsConfig;
  expect(runtimeConfig.filesystems[0]?.rules?.[0]).toMatchObject({
    provider: { module: `/scriptfs/providers/0/${layout}/index.mjs` },
  });
});
