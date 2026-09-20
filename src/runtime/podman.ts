import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ScriptFsConfig,
  ScriptFsSession,
  StartOptions,
} from "../types.js";
import {
  mountShare,
  validateMountPoints,
  type MountedShare,
} from "./host-mount.js";
import { runCommand } from "./command-runner.js";
import {
  resolveHostPaths,
  resolveProviderModule,
  scriptFsConfigSchema,
  validateProxyTargets,
} from "../config.js";

const DEFAULT_IMAGE = "localhost/scriptfs-runtime:0.0.1";
const CLEANUP_RETRY_MS = 1_000;
const COMMAND_TIMEOUT_MS = 60_000;

interface ContainerExitOutcome {
  expected: boolean;
  status?: string;
  error?: unknown;
}

export class ScriptFsStartupError extends AggregateError {
  readonly session: ScriptFsSession;

  constructor(errors: unknown[], message: string, session: ScriptFsSession) {
    super(errors, message);
    this.name = "ScriptFsStartupError";
    this.session = session;
  }
}

export async function startScriptFs(
  inputConfig: ScriptFsConfig,
  options: StartOptions = {},
): Promise<ScriptFsSession> {
  options.signal?.throwIfAborted();
  const config = resolveHostPaths(validateConfig(inputConfig), process.cwd());
  validateMountPoints(
    config.filesystems.map((filesystem) => filesystem.mountPoint),
  );
  await Promise.all(
    config.filesystems.map((filesystem) => access(filesystem.source)),
  );
  await validateProxyTargets(config);

  const commandOptions = {
    signal: options.signal,
    timeoutMs: COMMAND_TIMEOUT_MS,
  };
  const image = config.container?.image ?? DEFAULT_IMAGE;
  if (
    config.container?.rebuild ||
    !(await imageExists(image, options.signal))
  ) {
    await buildImage(image, options.signal);
  }
  options.signal?.throwIfAborted();

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "scriptfs-runtime-"),
  );
  const mounts: MountedShare[] = [];
  let containerId = "";
  let logFollower: ChildProcess | undefined;
  let containerExit: Promise<ContainerExitOutcome> | undefined;
  const monitorController = new AbortController();
  let removed = false;
  let stopped = false;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const onAbort = (): void => {
    void stopUntilComplete();
  };
  const stopSession = async (): Promise<void> => {
    stopping = true;
    const errors: unknown[] = [];
    if (logFollower) {
      try {
        await terminateLogFollower(logFollower);
        logFollower = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    for (const mounted of [...mounts].reverse()) {
      try {
        await mounted.unmount();
        mounts.splice(mounts.indexOf(mounted), 1);
      } catch (error) {
        if (isAlreadyUnmountedError(error)) {
          mounts.splice(mounts.indexOf(mounted), 1);
        } else {
          errors.push(error);
        }
      }
    }

    function isAlreadyUnmountedError(error: unknown): boolean {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = message.trimEnd().split("\n").at(-1) ?? "";
      return /(?:^|:\s)(?:not currently mounted|not mounted)\.?\s*$|^(?:The )?network connection could not be found\.?\s*$|^System error 2250(?: has occurred\.)?\s*$|^More help is available by typing NET HELPMSG 2250\.\s*$/i.test(
        diagnostic,
      );
    }
    // Keep the server available if a busy host mount still depends on it.
    if (mounts.length === 0 && containerId && !removed) {
      if (!stopped) {
        try {
          await runCommand(
            "podman",
            ["stop", "--ignore", "--time", "5", containerId],
            { timeoutMs: COMMAND_TIMEOUT_MS },
          );
          stopped = true;
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await runCommand("podman", ["rm", "--ignore", "--force", containerId], {
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        removed = true;
        monitorController.abort();
        await containerExit;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to completely stop scriptfs (${containerId || "no container"}): ${errors.map(String).join("; ")}`,
      );
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
    options.signal?.removeEventListener("abort", onAbort);
  };
  const stop = (): Promise<void> => {
    stopPromise ??= stopSession().catch((error: unknown) => {
      stopPromise = undefined;
      throw error;
    });
    return stopPromise;
  };
  const stopUntilComplete = async (): Promise<void> => {
    for (;;) {
      try {
        await stop();
        return;
      } catch (error) {
        console.error(error);
        await delay(CLEANUP_RETRY_MS);
      }
    }
  };
  const session: ScriptFsSession = {
    get containerId() {
      return containerId;
    },
    get mounts() {
      const mounted = new Set(mounts.map((share) => share.mountPoint));
      return new Map(
        config.filesystems
          .filter((filesystem) => mounted.has(filesystem.mountPoint))
          .map((filesystem) => [filesystem.name, filesystem.mountPoint]),
      );
    },
    async wait() {
      const outcome = await containerExit;
      if (outcome && !outcome.expected) {
        throw containerExitError(containerId, outcome);
      }
    },
    stop,
  };

  try {
    const prepared = await prepareContainerConfig(config);
    options.signal?.throwIfAborted();
    const runtimeConfigPath = path.join(temporaryDirectory, "config.json");
    await writeFile(
      runtimeConfigPath,
      JSON.stringify(prepared.config, null, 2),
    );

    const publish =
      config.container?.smbPort === undefined
        ? "127.0.0.1::445"
        : `127.0.0.1:${String(config.container.smbPort)}:445`;
    const containerName = `scriptfs-${randomUUID()}`;
    const args = [
      "create",
      "--name",
      containerName,
      "--device",
      "/dev/fuse",
      "--cap-add",
      "SYS_ADMIN",
      "--security-opt",
      "label=disable",
      "--security-opt",
      "apparmor=unconfined",
      "--publish",
      publish,
      "--volume",
      `${runtimeConfigPath}:/scriptfs/config.json:ro`,
      ...prepared.mountArguments,
      image,
    ];
    // Cancellation can lose create's stdout after the container already exists.
    containerId = containerName;
    const result = await runCommand("podman", args, commandOptions);
    if (!result.stdout.trim())
      throw new Error("Podman returned no container ID");
    containerId = result.stdout.trim();
    options.signal?.throwIfAborted();
    await runCommand("podman", ["start", containerId], commandOptions);
    containerExit = monitorContainerExit(
      containerId,
      () => stopping,
      monitorController.signal,
    );

    await waitUntilReady(containerId, containerExit, options.signal);
    if (config.container?.logLevel !== "silent") {
      logFollower = followContainerLogs(containerId);
    }
    const port = await getPublishedPort(containerId, options.signal);
    const host = config.container?.smbHost ?? "127.0.0.1";

    for (const filesystem of config.filesystems) {
      options.signal?.throwIfAborted();
      mounts.push(
        await mountShare(host, port, filesystem.name, filesystem.mountPoint),
      );
      options.signal?.throwIfAborted();
    }

    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    return session;
  } catch (error) {
    let containerLogs = "";
    const errors: unknown[] = [error];
    if (containerId && !options.signal?.aborted) {
      try {
        const logs = await getContainerLogs(containerId);
        containerLogs = `${logs.stdout}${logs.stderr}`;
      } catch (logsError) {
        errors.push(logsError);
      }
    }
    try {
      await stop();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length > 1) {
      throw new ScriptFsStartupError(
        errors,
        `Scriptfs startup/cleanup failed: ${errors.map(String).join("; ")}\n${containerLogs}`,
        session,
      );
    }
    if (containerLogs) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`${cause}\nContainer logs:\n${containerLogs}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function prepareContainerConfig(config: ScriptFsConfig): Promise<{
  config: ScriptFsConfig;
  mountArguments: string[];
}> {
  const mountArguments: string[] = [];
  const providerRoots = new Map<string, string>();
  let proxyIndex = 0;

  const filesystems = await Promise.all(
    config.filesystems.map(async (filesystem, filesystemIndex) => {
      const source = `/scriptfs/sources/${String(filesystemIndex)}`;
      mountArguments.push(
        "--volume",
        `${filesystem.source}:${source}${filesystem.readOnly ? ":ro" : ""}`,
      );

      const rules = await Promise.all(
        (filesystem.rules ?? []).map(async (rule) => {
          if ("hide" in rule) {
            return rule;
          }

          if (!("module" in rule.provider)) {
            const containerPath = `/scriptfs/proxies/${String(proxyIndex++)}`;
            const fileProxy = rule.provider.type === "file";
            const hostPath = fileProxy
              ? path.dirname(rule.provider.path)
              : rule.provider.path;
            mountArguments.push(
              "--volume",
              `${hostPath}:${containerPath}${filesystem.readOnly ? ":ro" : ""}`,
            );
            return {
              ...rule,
              provider: {
                ...rule.provider,
                path: fileProxy
                  ? `${containerPath}/${path.basename(rule.provider.path)}`
                  : containerPath,
              },
            };
          }

          const hostModule = await realpath(
            path.isAbsolute(rule.provider.module)
              ? rule.provider.module
              : resolveProviderModule(
                  path.join(process.cwd(), "package.json"),
                  rule.provider.module,
                ),
          );
          const packageRoot = await findProviderRoot(hostModule);
          let containerRoot = providerRoots.get(packageRoot);
          if (!containerRoot) {
            containerRoot = `/scriptfs/providers/${String(providerRoots.size)}`;
            providerRoots.set(packageRoot, containerRoot);
            mountArguments.push(
              "--volume",
              `${packageRoot}:${containerRoot}:ro`,
            );
          }
          const modulePath = path.join(
            containerRoot,
            path.relative(packageRoot, hostModule),
          );
          return {
            ...rule,
            provider: {
              ...rule.provider,
              module: modulePath.split(path.sep).join("/"),
            },
          };
        }),
      );

      return {
        ...filesystem,
        source,
        mountPoint: `/scriptfs/overlays/${String(filesystemIndex)}`,
        rules,
      };
    }),
  );

  return {
    config: {
      ...config,
      filesystems,
    },
    mountArguments,
  };
}

async function findProviderRoot(modulePath: string): Promise<string> {
  let root = await findPackageRoot(modulePath);
  let current = path.dirname(modulePath);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === "node_modules") root = path.dirname(current);
    else {
      try {
        if ((await stat(path.join(current, "node_modules"))).isDirectory()) {
          await access(path.join(current, "package.json"));
          root = current;
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    current = path.dirname(current);
  }
  return root;
}

async function findPackageRoot(modulePath: string): Promise<string> {
  let current = (await stat(modulePath)).isDirectory()
    ? modulePath
    : path.dirname(modulePath);
  for (;;) {
    try {
      await access(path.join(current, "package.json"));
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) {
        return path.dirname(modulePath);
      }

      current = parent;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function imageExists(
  image: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await runCommand(
    "podman",
    ["image", "inspect", "--format", "{{.Id}}", image],
    {
      allowFailure: true,
      signal,
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  return result.stdout.trim() !== "";
}

async function buildImage(
  image: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const packageRoot = await findPackageRoot(fileURLToPath(import.meta.url));
  const containerFile = path.join(packageRoot, "container", "Containerfile");
  await access(containerFile);
  const registry = (
    await runCommand(
      process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "npm config get registry"]
        : ["config", "get", "registry"],
      { signal, timeoutMs: COMMAND_TIMEOUT_MS },
    )
  ).stdout.trim();
  await runCommand(
    "podman",
    [
      "build",
      "--build-arg",
      `NPM_REGISTRY=${registry}`,
      "--tag",
      image,
      "--file",
      containerFile,
      packageRoot,
    ],
    { output: "inherit", signal, timeoutMs: 10 * 60_000 },
  );
}

async function waitUntilReady(
  containerId: string,
  containerExit: Promise<ContainerExitOutcome>,
  startupSignal: AbortSignal | undefined,
): Promise<void> {
  const controller = new AbortController();
  const signal = startupSignal
    ? AbortSignal.any([startupSignal, controller.signal])
    : controller.signal;
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error("Timed out waiting for the scriptfs container"),
      ),
    60_000,
  );
  let finished = false;
  void containerExit.then((outcome) => {
    if (!finished) controller.abort(containerExitError(containerId, outcome));
  });
  try {
    for (;;) {
      signal.throwIfAborted();
      const state = await runCommand(
        "podman",
        ["inspect", "--format", "{{.State.Status}}", containerId],
        { allowFailure: true, signal },
      );
      if (state.stdout.trim() !== "running") {
        throw new Error(`scriptfs container stopped during startup`);
      }
      const readiness = await runCommand(
        "podman",
        ["exec", containerId, "cat", "/tmp/scriptfs-ready"],
        { allowFailure: true, signal },
      );
      signal.throwIfAborted();
      if (readiness.stdout.trim() === "ready") return;
      try {
        await sleep(250, undefined, { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
  } finally {
    finished = true;
    clearTimeout(timeout);
  }
}

function monitorContainerExit(
  containerId: string,
  isStopping: () => boolean,
  signal: AbortSignal,
): Promise<ContainerExitOutcome> {
  return runCommand("podman", ["wait", containerId], { signal }).then(
    ({ stdout }) => ({
      expected: isStopping(),
      status: stdout.trim() || undefined,
    }),
    (error: unknown) => ({ expected: isStopping(), error }),
  );
}

function containerExitError(
  containerId: string,
  outcome: ContainerExitOutcome,
): Error {
  const monitorError =
    outcome.error instanceof Error
      ? outcome.error.message
      : typeof outcome.error === "string"
        ? outcome.error
        : "container monitor failed";
  const detail = outcome.status
    ? ` with status ${outcome.status}`
    : outcome.error
      ? `: ${monitorError}`
      : "";
  return new Error(`scriptfs container ${containerId} exited${detail}`, {
    cause: outcome.error,
  });
}

function getContainerLogs(containerId: string) {
  return runCommand("podman", ["logs", "--tail", "1000", containerId], {
    allowFailure: true,
    timeoutMs: 10_000,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateLogFollower(child: ChildProcess): Promise<void> {
  if (hasChildExited(child)) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(1_000)]);
  if (!hasChildExited(child)) {
    if (!child.kill("SIGKILL")) {
      throw new Error(
        `Failed to terminate container log follower ${String(child.pid)}`,
      );
    }
    await exited;
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function getPublishedPort(
  containerId: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const result = await runCommand("podman", ["port", containerId, "445/tcp"], {
    signal,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const match = /:(\d+)\s*$/.exec(result.stdout);
  if (!match?.[1]) {
    throw new Error(`Could not determine SMB port from: ${result.stdout}`);
  }
  return Number(match[1]);
}

function validateConfig(inputConfig: ScriptFsConfig): ScriptFsConfig {
  const config = scriptFsConfigSchema.parse(inputConfig);
  if (config.filesystems.length === 0) {
    throw new Error("At least one filesystem is required");
  }
  const names = config.filesystems.map((filesystem) =>
    filesystem.name.toLowerCase(),
  );
  if (new Set(names).size !== names.length) {
    throw new Error("Each filesystem must use a unique name");
  }
  for (const filesystem of config.filesystems) {
    for (const rule of filesystem.rules ?? []) {
      if (
        "provider" in rule &&
        "module" in rule.provider &&
        !path.isAbsolute(rule.provider.module) &&
        rule.provider.module.startsWith(".")
      ) {
        throw new Error(
          `Provider paths must be absolute after config loading: ${rule.provider.module}`,
        );
      }
    }
  }
  return config;
}

function followContainerLogs(containerId: string): ChildProcess {
  const follower = spawn(
    "podman",
    ["logs", "--follow", "--since", new Date().toISOString(), containerId],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  follower.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  follower.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  follower.on("error", (error) => {
    console.error(`Failed to follow scriptfs container logs: ${error.message}`);
  });
  return follower;
}
