import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectModule,
  startScriptFs,
  type ModuleConfig,
  type ModuleManifest,
  type OverlayRule,
  type ScriptFsConfig,
  type ScriptFsSession,
} from "scriptfs";
import { freePort } from "./ports.js";

/** Files to create, by relative path. Directories are created as needed. */
export type Files = Readonly<Record<string, string | Uint8Array>>;

/**
 * A host path for a manifest path: an existing host path, a folder the
 * harness creates from `files`, or a file it creates from `contents`.
 */
export type PathInput =
  string | { files: Files } | { contents: string | Uint8Array };

/**
 * An outbound port target: `"host:port"`, a port on `127.0.0.1`, or anything
 * with a `target`, such as a {@link HostServer}.
 */
export type OutboundInput = string | number | { readonly target: string };

/** A secret value, or where ScriptFS reads it on the host. */
export type SecretInput = string | { env: string } | { file: string };

export type LogLevel = "silent" | "info" | "debug";

export interface StartModuleOptions {
  /**
   * The module: a manifest file, a folder containing `scriptfs.module.json`,
   * or an installed package name. Relative paths resolve against `cwd`. A
   * `file:` URL such as `new URL("..", import.meta.url)` is a path.
   */
  module: string | URL;
  /** Base for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Instance name. Defaults to `"module"`. */
  instance?: string;
  settings?: Record<string, unknown>;
  /** Secret values. Literal strings are written to private temporary files. */
  secrets?: Record<string, SecretInput>;
  /** Outbound port targets by key. */
  outbound?: Record<string, OutboundInput>;
  /**
   * Host ports for inbound ports by key. Inbound ports not listed here get a
   * free host port, so concurrent tests do not collide.
   */
  inbound?: Record<string, number>;
  /** Host paths by key. */
  paths?: Record<string, PathInput>;
  /**
   * Host state folder. Defaults to a fresh folder that lasts until the
   * harness stops and is kept across {@link ModuleHarness.restart}.
   */
  state?: string;
  /** Passed to every callback as `context.options`. */
  options?: unknown;
  /** Files of the source folder the module overlays. Defaults to none. */
  source?: Files;
  /** Rules of the filesystem. Defaults to the module serving the whole mount. */
  rules?: OverlayRule[];
  readOnly?: boolean;
  /**
   * Mount point. Defaults to a temporary folder. Required on Windows, where
   * it is a free drive letter such as `"S:"`.
   */
  mount?: string;
  /**
   * Runtime image. Defaults to `SCRIPTFS_TEST_IMAGE`, then the image of the
   * installed `scriptfs` package.
   */
  image?: string;
  /** Defaults to `SCRIPTFS_TEST_LOG_LEVEL`, then `"silent"`. */
  logLevel?: LogLevel;
  signal?: AbortSignal;
}

export interface InboundAddress {
  host: "127.0.0.1";
  port: number;
  /** `http://127.0.0.1:<port>` */
  url: string;
}

export interface ModuleHarness extends AsyncDisposable {
  /** The mount point. */
  readonly root: string;
  readonly instance: string;
  readonly manifest: ModuleManifest;
  readonly manifestPath: string;
  /** The configuration the session runs. */
  readonly config: ScriptFsConfig;
  readonly session: ScriptFsSession;
  readonly containerId: string;
  /** Host state folder, when the manifest enables state. */
  readonly stateDir: string | undefined;
  /** A location in the mount. */
  path(...segments: string[]): string;
  readText(relative: string): Promise<string>;
  readJson<T = unknown>(relative: string): Promise<T>;
  /** Sorted entry names of a mounted folder. */
  list(relative?: string): Promise<string[]>;
  write(relative: string, contents: string | Uint8Array): Promise<void>;
  exists(relative: string): Promise<boolean>;
  /** Where host programs reach an inbound port. */
  inbound(key: string): InboundAddress;
  /**
   * The host path bound to a manifest path, for changing it while the module
   * runs.
   */
  hostPath(key: string): string;
  /** Output of the ScriptFS container, including module logs. */
  logs(): Promise<string>;
  /** Stops and starts the session with the same configuration and state. */
  restart(): Promise<void>;
  /** Stops the session and removes temporary files. Safe to call twice. */
  stop(): Promise<void>;
}

/** The session configuration for one module instance. */
export interface Prepared {
  config: ScriptFsConfig;
  manifest: ModuleManifest;
  manifestPath: string;
  instance: string;
  inbound: ReadonlyMap<string, number>;
  paths: Readonly<Record<string, string>>;
  stateDir: string | undefined;
  mount: string;
}

async function createFiles(root: string, files: Files): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.resolve(root, relative);
    const inside = path.relative(root, file);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
      throw new Error(`File ${JSON.stringify(relative)} is outside its folder`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
}

function outboundTarget(value: OutboundInput): string {
  if (typeof value === "number") return `127.0.0.1:${String(value)}`;
  return typeof value === "string" ? value : value.target;
}

function logLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "silent" || value === "info" || value === "debug") return value;
  throw new Error(
    `SCRIPTFS_TEST_LOG_LEVEL must be silent, info or debug, not ${JSON.stringify(value)}`,
  );
}

const DRIVE = /^[A-Za-z]:$/;

function mountPoint(
  mount: string | undefined,
  cwd: string,
  workspace: string,
): string {
  if (process.platform === "win32") {
    if (mount === undefined || !DRIVE.test(mount))
      throw new Error(
        'On Windows, mount must be a free drive letter such as "S:"',
      );
    return mount;
  }
  return mount === undefined
    ? path.join(workspace, "mount")
    : path.resolve(cwd, mount);
}

/**
 * Validates the module and writes the files a session needs into
 * `workspace`, returning the configuration to start.
 */
export async function prepare(
  options: StartModuleOptions,
  workspace: string,
): Promise<Prepared> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const instance = options.instance ?? "module";
  const { manifest, manifestPath } = await inspectModule(
    typeof options.module === "string"
      ? options.module
      : fileURLToPath(options.module),
    { cwd },
  );
  const declared = (direction: "inbound" | "outbound") =>
    Object.entries(manifest.ports ?? {})
      .filter(([, port]) => port.direction === direction)
      .map(([key]) => key);
  const check = (kind: string, given: object | undefined, keys: string[]) => {
    const extra = Object.keys(given ?? {}).filter((key) => !keys.includes(key));
    if (extra.length)
      throw new Error(
        `The manifest of ${manifest.name} declares no ${kind} ${extra.map((key) => JSON.stringify(key)).join(", ")}`,
      );
  };
  check("outbound port", options.outbound, declared("outbound"));
  check("inbound port", options.inbound, declared("inbound"));

  const module: ModuleConfig = { manifest: manifestPath };
  if (options.settings) module.settings = options.settings;

  const secrets: NonNullable<ModuleConfig["secrets"]> = {};
  for (const [key, value] of Object.entries(options.secrets ?? {})) {
    if (typeof value !== "string") {
      secrets[key] =
        "file" in value ? { file: path.resolve(cwd, value.file) } : value;
      continue;
    }
    const folder = path.join(workspace, "secrets");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, key);
    await writeFile(file, value, { mode: 0o600 });
    await chmod(file, 0o600);
    secrets[key] = { file };
  }
  if (Object.keys(secrets).length) module.secrets = secrets;

  const ports: NonNullable<ModuleConfig["ports"]> = {};
  for (const [key, value] of Object.entries(options.outbound ?? {}))
    ports[key] = { target: outboundTarget(value) };
  const inbound = new Map<string, number>();
  for (const key of declared("inbound")) {
    const hostPort = options.inbound?.[key] ?? (await freePort());
    ports[key] = { hostPort };
    inbound.set(key, hostPort);
  }
  if (Object.keys(ports).length) module.ports = ports;

  const paths: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.paths ?? {})) {
    if (typeof value === "string") {
      paths[key] = path.resolve(cwd, value);
      continue;
    }
    const target = path.join(workspace, "paths", key);
    if ("files" in value) await createFiles(target, value.files);
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value.contents);
    }
    paths[key] = target;
  }
  if (Object.keys(paths).length) module.paths = paths;

  let stateDir: string | undefined;
  if (manifest.state) {
    stateDir = options.state
      ? path.resolve(cwd, options.state)
      : path.join(workspace, "state");
    await mkdir(stateDir, { recursive: true });
    module.state = stateDir;
  } else if (options.state !== undefined) {
    throw new Error(`The manifest of ${manifest.name} does not use state`);
  }

  const source = path.join(workspace, "source");
  await createFiles(source, options.source ?? {});
  const mount = mountPoint(options.mount, cwd, workspace);
  if (!DRIVE.test(mount)) await mkdir(mount, { recursive: true });
  const image = options.image ?? process.env.SCRIPTFS_TEST_IMAGE;
  const config: ScriptFsConfig = {
    modules: { [instance]: module },
    filesystems: [
      {
        name: "module",
        source,
        mountPoint: mount,
        ...(options.readOnly ? { readOnly: true } : {}),
        rules: options.rules ?? [
          {
            match: "**",
            opaque: true,
            provider:
              options.options === undefined
                ? { module: instance }
                : { module: instance, options: options.options },
          },
        ],
      },
    ],
    container: {
      logLevel:
        options.logLevel ??
        logLevel(process.env.SCRIPTFS_TEST_LOG_LEVEL) ??
        "silent",
      ...(image ? { image } : {}),
    },
  };
  return {
    config,
    manifest,
    manifestPath,
    instance,
    inbound,
    paths,
    stateDir,
    mount,
  };
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.stderr.on("data", (data: Buffer) => (output += data.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else
        reject(new Error(`${command} exited with ${String(code)}: ${output}`));
    });
  });
}

/**
 * Starts ScriptFS with one instance of a module and mounts it on the host,
 * so a test uses the module's files the way any other program would.
 */
export async function startModule(
  options: StartModuleOptions,
): Promise<ModuleHarness> {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "scriptfs-test-")),
  );
  let session: ScriptFsSession | undefined;
  const cleanup = async () => {
    const running = session;
    session = undefined;
    await running?.stop();
    // rmdir refuses a mount point that is still mounted, so a failed unmount
    // never deletes files through the mount.
    await rmdir(path.join(workspace, "mount")).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rm(workspace, { recursive: true, force: true });
  };
  try {
    const prepared = await prepare(options, workspace);
    const start = () =>
      startScriptFs(
        prepared.config,
        options.signal ? { signal: options.signal } : {},
      );
    session = await start();
    const current = () => {
      if (!session) throw new Error("The module harness is stopped");
      return session;
    };
    const resolve = (relative: string) => {
      const file = path.resolve(prepared.mount, relative);
      const inside = path.relative(prepared.mount, file);
      if (inside.startsWith("..") || path.isAbsolute(inside))
        throw new Error(`${JSON.stringify(relative)} is outside the mount`);
      return file;
    };
    let stopping: Promise<void> | undefined;
    const harness: ModuleHarness = {
      root: prepared.mount,
      instance: prepared.instance,
      manifest: prepared.manifest,
      manifestPath: prepared.manifestPath,
      config: prepared.config,
      get session() {
        return current();
      },
      get containerId() {
        return current().containerId;
      },
      stateDir: prepared.stateDir,
      path: (...segments) => resolve(path.join("", ...segments)),
      readText: (relative) => readFile(resolve(relative), "utf8"),
      readJson: async <T>(relative: string) =>
        JSON.parse(await readFile(resolve(relative), "utf8")) as T,
      list: async (relative = "") => (await readdir(resolve(relative))).sort(),
      write: (relative, contents) => writeFile(resolve(relative), contents),
      exists: (relative) =>
        stat(resolve(relative)).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return false;
            throw error;
          },
        ),
      inbound(key) {
        const port = prepared.inbound.get(key);
        if (port === undefined)
          throw new Error(
            `The manifest declares no inbound port ${JSON.stringify(key)}`,
          );
        return {
          host: "127.0.0.1",
          port,
          url: `http://127.0.0.1:${String(port)}`,
        };
      },
      hostPath(key) {
        const bound = prepared.paths[key];
        if (bound === undefined)
          throw new Error(
            `No host path is bound to ${JSON.stringify(key)}; pass it in paths`,
          );
        return bound;
      },
      logs: () => capture("podman", ["logs", current().containerId]),
      async restart() {
        const running = current();
        session = undefined;
        await running.stop();
        session = await start();
      },
      stop() {
        stopping ??= cleanup();
        return stopping;
      },
      [Symbol.asyncDispose]() {
        return harness.stop();
      },
    };
    return harness;
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
