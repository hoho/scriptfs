import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCommand } from "../helpers/command.js";

interface ProviderEvent {
  operation: string;
  path: string;
  contents?: string;
  destinationPath?: string;
  length?: number;
  position?: number;
  size?: number;
}

let root = "";
let mount = "";
let source = "";
let eventsPath = "";
let child: ChildProcess | undefined;
let runtimeContainerId: string | undefined;
let stdout = "";
let stderr = "";

beforeEach(async () => {
  child = undefined;
  runtimeContainerId = undefined;
  stdout = "";
  stderr = "";
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-e2e-"));
  mount = path.join(root, "mount");
  source = path.join(root, "source");
  eventsPath = path.join(source, "provider-events.jsonl");
  const moduleDirectory = path.join(root, "module");
  await mkdir(path.join(source, "components", "Button"), {
    recursive: true,
  });
  await writeFile(path.join(source, "passthrough.txt"), "0123456789");
  await writeFile(path.join(source, "hidden.private"), "still in source");
  await writeFile(path.join(root, "proxy-file.txt"), "proxy file");
  await mkdir(path.join(root, "proxy-directory"));
  await writeFile(
    path.join(root, "proxy-directory", "existing.txt"),
    "proxy directory",
  );
  await mkdir(moduleDirectory);
  await writeFile(path.join(moduleDirectory, "index.mjs"), providerSource());
  await writeFile(
    path.join(moduleDirectory, "scriptfs.module.json"),
    JSON.stringify({ name: "e2e-catalog", entry: "./index.mjs" }),
  );
  await writeFile(
    path.join(moduleDirectory, "positional.module.json"),
    JSON.stringify({
      name: "e2e-positional",
      entry: "./index.mjs",
      export: "positionalProvider",
    }),
  );
  await writeFile(
    path.join(root, "config.json"),
    JSON.stringify(createConfig()),
  );
}, 30_000);

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child).catch(() => undefined);
  }
  await forceCleanup();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("executes matched and passthrough operations through the real CLI mount", async () => {
  const running = await startCli();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(running.exitCode).toBeNull();
  expect(stderr).not.toContain("unsettled top-level await");

  await exercisePassthroughOperations();
  await exerciseProviderOperations();
  await exerciseProxyAndHideOperations();
  await assertProviderCallbacks();

  expect(running.kill("SIGINT")).toBe(true);
  await expect(waitForExit(running)).resolves.toEqual({
    code: 0,
    signal: null,
  });
  expect(stderr).not.toContain("unsettled top-level await");
  await expect(
    readFile(path.join(mount, "passthrough.txt"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await listRuntimeContainers()).not.toContain(runtimeContainerId);
  runtimeContainerId = undefined;
}, 180_000);

it("exits with failure and cleans up after an unexpected runtime exit", async () => {
  const running = await startCli();
  if (!runtimeContainerId)
    throw new Error("Runtime container ID was not captured");
  const containerId = runtimeContainerId;
  // Release the host share before taking its server away; a dead SMB mount can block macOS unmount.
  await unmountHostShare();
  await runCommand("podman", [
    "exec",
    containerId,
    "node",
    "-e",
    "process.kill(1, 'SIGTERM')",
  ]);
  await expect(waitForExit(running)).resolves.toEqual({
    code: 1,
    signal: null,
  });
  expect(stderr).toContain(`scriptfs container ${containerId} exited`);
  await expect(
    runCommand("podman", ["inspect", containerId]),
  ).rejects.toThrow();
  await expect(
    readFile(path.join(mount, "passthrough.txt"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  runtimeContainerId = undefined;
}, 90_000);

async function startCli(): Promise<ChildProcess> {
  const containersBefore = await listRuntimeContainers();
  const running = spawn(
    process.execPath,
    [path.resolve("dist/cli.js"), path.join(root, "config.json")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child = running;
  running.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  running.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  await waitForText("scriptfs is running; press Ctrl+C to stop");
  const containersDuring = await listRuntimeContainers();
  runtimeContainerId = [...containersDuring].find(
    (containerId) => !containersBefore.has(containerId),
  );
  expect(runtimeContainerId).toBeDefined();
  return running;
}

async function exercisePassthroughOperations(): Promise<void> {
  const mountedFile = path.join(mount, "passthrough.txt");
  await expect(readFile(mountedFile, "utf8")).resolves.toBe("0123456789");

  const readHandle = await open(mountedFile, "r");
  const readBuffer = Buffer.alloc(4);
  await readHandle.read(readBuffer, 0, readBuffer.length, 3);
  await readHandle.close();
  expect(readBuffer.toString()).toBe("3456");

  await writeFile(mountedFile, "replaced");
  await expect(
    readFile(path.join(source, "passthrough.txt"), "utf8"),
  ).resolves.toBe("replaced");
  if (!runtimeContainerId) {
    throw new Error("Runtime container ID was not captured");
  }
  await runCommand("podman", [
    "exec",
    runtimeContainerId,
    "node",
    "-e",
    [
      "const fs=require('node:fs');",
      "const p='/scriptfs/overlays/0/passthrough.txt';",
      "fs.chmodSync(p,0o600);",
      "fs.utimesSync(p,new Date(1000),new Date(2000));",
    ].join(""),
  ]);
  expect((await stat(path.join(source, "passthrough.txt"))).mode & 0o777).toBe(
    0o600,
  );
  const sourceMtime = (
    await stat(path.join(source, "passthrough.txt"))
  ).mtime.getTime();
  expect(sourceMtime).toBeGreaterThan(0);
  expect(sourceMtime).toBeLessThan(10_000_000);
  await access(mountedFile);

  const createdMountPath = path.join(mount, "created.txt");
  const createdSourcePath = path.join(source, "created.txt");
  await writeFile(createdMountPath, "alpha");
  await expect(readFile(createdSourcePath, "utf8")).resolves.toBe("alpha");
  expect((await stat(createdSourcePath)).mode & 0o111).toBe(0);

  await appendFile(createdMountPath, "beta");
  await expect(readFile(createdSourcePath, "utf8")).resolves.toBe("alphabeta");

  const writeHandle = await open(createdMountPath, "r+");
  await writeHandle.write(Buffer.from("ZZ"), 0, 2, 2);
  await writeHandle.sync();
  await writeHandle.close();
  await expect(readFile(createdSourcePath, "utf8")).resolves.toBe("alZZabeta");

  await truncate(createdMountPath, 5);
  await expect(readFile(createdSourcePath, "utf8")).resolves.toBe("alZZa");

  const emptyMountPath = path.join(mount, "empty.txt");
  const emptyHandle = await open(emptyMountPath, "w");
  await emptyHandle.close();
  await expect(stat(path.join(source, "empty.txt"))).resolves.toMatchObject({
    size: 0,
  });
  expect((await stat(path.join(source, "empty.txt"))).mode & 0o111).toBe(0);

  const renamedMountPath = path.join(mount, "renamed.txt");
  const renamedSourcePath = path.join(source, "renamed.txt");
  await rename(createdMountPath, renamedMountPath);
  await expect(readFile(renamedSourcePath, "utf8")).resolves.toBe("alZZa");
  await rm(renamedMountPath);
  await expect(access(renamedSourcePath)).rejects.toMatchObject({
    code: "ENOENT",
  });

  const directoryMountPath = path.join(mount, "created-directory");
  const directorySourcePath = path.join(source, "created-directory");
  await mkdir(directoryMountPath);
  expect((await stat(directorySourcePath)).isDirectory()).toBe(true);
  expect((await stat(directorySourcePath)).mode & 0o111).not.toBe(0);
  await rmdir(directoryMountPath);
  await expect(access(directorySourcePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
}

async function exerciseProviderOperations(): Promise<void> {
  const generatedRoot = path.join(mount, "GeneratedCatalog");
  await expect(
    readFile(path.join(mount, "components", "Button", "AGENTS.md"), "utf8"),
  ).resolves.toBe("Instructions for components/Button/AGENTS.md");
  await expect(
    readFile(
      path.join(generatedRoot, "Datasets", "Batch1", "Record2", "data.txt"),
      "utf8",
    ),
  ).resolves.toBe("0123456789");

  const seekReadHandle = await open(
    path.join(generatedRoot, "Datasets", "Batch1", "Record2", "data.txt"),
    "r",
  );
  const seekReadBuffer = Buffer.alloc(4);
  await seekReadHandle.read(seekReadBuffer, 0, 4, 3);
  await seekReadHandle.sync();
  await seekReadHandle.close();
  expect(seekReadBuffer.toString()).toBe("3456");

  const mutablePath = path.join(generatedRoot, "mutable.txt");
  await writeFile(mutablePath, "replace");
  await appendFile(mutablePath, "+append");
  await expect(readFile(mutablePath, "utf8")).resolves.toBe("replace+append");

  const seekWriteHandle = await open(mutablePath, "r+");
  await seekWriteHandle.write(Buffer.from("XY"), 0, 2, 1);
  await seekWriteHandle.sync();
  await seekWriteHandle.close();
  await expect(readFile(mutablePath, "utf8")).resolves.toBe("rXYlace+append");

  await truncate(mutablePath, 4);
  await expect(readFile(mutablePath, "utf8")).resolves.toBe("rXYl");

  const newPath = path.join(generatedRoot, "new.txt");
  await writeFile(newPath, "new contents");
  await expect(readFile(newPath, "utf8")).resolves.toBe("new contents");

  const emptyPath = path.join(generatedRoot, "empty.txt");
  const emptyHandle = await open(emptyPath, "w");
  await emptyHandle.close();
  await expect(stat(emptyPath)).resolves.toMatchObject({ size: 0 });

  const renamedPath = path.join(generatedRoot, "renamed.txt");
  await rename(newPath, renamedPath);
  await expect(readFile(renamedPath, "utf8")).resolves.toBe("new contents");
  await rm(renamedPath);
  await expect(access(renamedPath)).rejects.toMatchObject({ code: "ENOENT" });

  const dynamicDirectory = path.join(generatedRoot, "Dynamic");
  await mkdir(dynamicDirectory);
  await writeFile(path.join(dynamicDirectory, "child.txt"), "child");
  await rm(path.join(dynamicDirectory, "child.txt"));
  expect(await readdir(dynamicDirectory)).toEqual([]);
  await rmdir(dynamicDirectory);

  const positionalPath = path.join(generatedRoot, "positional.bin");
  const positionalHandle = await open(positionalPath, "r+");
  const positionalRead = Buffer.alloc(3);
  await positionalHandle.read(positionalRead, 0, 3, 2);
  expect(positionalRead.toString()).toBe("CDE");
  await positionalHandle.write(Buffer.from("zz"), 0, 2, 1);
  await positionalHandle.sync();
  await positionalHandle.close();
  await expect(readFile(positionalPath)).resolves.toEqual(
    Buffer.from("AzzDEFGH"),
  );

  const actionPath = path.join(
    generatedRoot,
    "Datasets",
    "Batch1",
    "Record2",
    "action.txt",
  );
  await expect(stat(actionPath)).resolves.toMatchObject({ size: 0 });
  const writesBefore = (await readEvents()).filter(
    (event) =>
      event.operation === "writeFile" && event.path.endsWith("action.txt"),
  );
  expect(writesBefore).toEqual([]);
  await writeFile(actionPath, "hello");
  await waitForProviderEvent(
    (event) =>
      event.operation === "writeFile" &&
      event.path.endsWith("action.txt") &&
      event.contents === "hello",
  );
  await waitForText("provider writeFile");

  const configUnbounded = await stat(
    path.join(generatedRoot, "config-unbounded.bin"),
  );
  expect(configUnbounded.size).toBeGreaterThan(1_000_000_000_000);
  const moduleUnbounded = await stat(
    path.join(generatedRoot, "module-unbounded.bin"),
  );
  expect(moduleUnbounded.size).toBeGreaterThan(1_000_000_000_000);

  if (!runtimeContainerId) {
    throw new Error("Runtime container ID was not captured");
  }
  const metadataScript = [
    "const fs=require('node:fs');",
    "const p='/scriptfs/overlays/0/GeneratedCatalog/mutable.txt';",
    "fs.accessSync(p);",
    "fs.chmodSync(p,0o600);",
    "fs.chownSync(p,123,456);",
    "fs.utimesSync(p,new Date(1000),new Date(2000));",
  ].join("");
  await runCommand("podman", [
    "exec",
    runtimeContainerId,
    "node",
    "-e",
    metadataScript,
  ]);
}

async function exerciseProxyAndHideOperations(): Promise<void> {
  const rootEntries = await readdir(mount);
  expect(rootEntries).toContain("ProxiedFile.txt");
  expect(rootEntries).toContain("ProxiedDirectory");
  expect(rootEntries).not.toContain("hidden.private");
  const hiddenMountPath = path.join(mount, "hidden.private");
  await expect(access(hiddenMountPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    readFile(path.join(source, "hidden.private"), "utf8"),
  ).resolves.toBe("still in source");

  const proxiedFile = path.join(mount, "ProxiedFile.txt");
  const targetFile = path.join(root, "proxy-file.txt");
  await expect(readFile(proxiedFile, "utf8")).resolves.toBe("proxy file");
  await writeFile(proxiedFile, "replaced proxy");
  await appendFile(proxiedFile, "+append");
  await expect(readFile(targetFile, "utf8")).resolves.toBe(
    "replaced proxy+append",
  );

  const proxyDirectory = path.join(mount, "ProxiedDirectory");
  const targetDirectory = path.join(root, "proxy-directory");
  await expect(
    readFile(path.join(proxyDirectory, "existing.txt"), "utf8"),
  ).resolves.toBe("proxy directory");

  const created = path.join(proxyDirectory, "created.txt");
  const targetCreated = path.join(targetDirectory, "created.txt");
  await writeFile(created, "created through proxy");
  await expect(readFile(targetCreated, "utf8")).resolves.toBe(
    "created through proxy",
  );
  expect((await stat(targetCreated)).mode & 0o111).toBe(0);
  const renamed = path.join(proxyDirectory, "renamed.txt");
  const targetRenamed = path.join(targetDirectory, "renamed.txt");
  await rename(created, renamed);
  await expect(readFile(targetRenamed, "utf8")).resolves.toBe(
    "created through proxy",
  );
  await rm(renamed);
  await expect(access(targetRenamed)).rejects.toMatchObject({ code: "ENOENT" });

  const createdDirectory = path.join(proxyDirectory, "Nested");
  const targetCreatedDirectory = path.join(targetDirectory, "Nested");
  await mkdir(createdDirectory);
  expect((await stat(targetCreatedDirectory)).isDirectory()).toBe(true);
  expect((await stat(targetCreatedDirectory)).mode & 0o111).not.toBe(0);
  await rmdir(createdDirectory);
  await expect(access(targetCreatedDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
}

async function assertProviderCallbacks(): Promise<void> {
  const events = await readEvents();
  for (const operation of [
    "open",
    "create",
    "readFile",
    "writeFile",
    "truncate",
    "flush",
    "fsync",
    "release",
    "mkdir",
    "unlink",
    "rmdir",
    "rename",
    "positionalRead",
    "positionalWrite",
    "access",
    "chmod",
    "chown",
    "utimens",
    "getattr",
    "readdir",
  ]) {
    expect(
      events.some((event) => event.operation === operation),
      `missing provider callback event: ${operation}`,
    ).toBe(true);
  }

  const actionWrites = events.filter(
    (event) =>
      event.operation === "writeFile" && event.path.endsWith("action.txt"),
  );
  expect(actionWrites).toEqual([
    expect.objectContaining({ contents: "hello" }),
  ]);
}

function createConfig(): object {
  const options = { events: "/scriptfs/sources/0/provider-events.jsonl" };
  const provider = { module: "catalog", options };
  const positional = { module: "positional", options };
  return {
    modules: {
      catalog: { manifest: "./module" },
      positional: { manifest: "./module/positional.module.json" },
    },
    filesystems: [
      {
        name: "workspace",
        source,
        mountPoint: mount,
        rules: [
          {
            match: "components/*/AGENTS.md",
            provider,
          },
          {
            match: "GeneratedCatalog/**",
            root: "GeneratedCatalog",
            opaque: true,
            provider,
          },
          {
            match: "GeneratedCatalog/positional.bin",
            provider: positional,
            file: { size: 8, sizeMode: "explicit" },
          },
          {
            match: "GeneratedCatalog/config-unbounded.bin",
            provider: positional,
            file: { sizeMode: "unbounded" },
          },
          {
            match: "GeneratedCatalog/**/action.txt",
            provider,
            file: { sizeMode: "zero" },
          },
          {
            match: "ProxiedFile.txt",
            provider: {
              type: "file",
              path: path.join(root, "proxy-file.txt"),
            },
          },
          {
            match: "ProxiedDirectory/**",
            root: "ProxiedDirectory",
            opaque: true,
            provider: {
              type: "directory",
              path: path.join(root, "proxy-directory"),
            },
          },
          {
            match: "hidden.private",
            hide: true,
          },
        ],
      },
    ],
    container: {
      rebuild: process.env.SCRIPTFS_E2E_REBUILD === "1",
    },
  };
}

function providerSource(): string {
  return `
import { appendFile } from "node:fs/promises";

const directories = new Set([
  "",
  "Datasets",
  "Datasets/Batch1",
  "Datasets/Batch1/Record2",
]);
const files = new Map([
  ["AGENTS.md", Buffer.from("Generated catalog instructions")],
  ["Datasets/Batch1/Record2/data.txt", Buffer.from("0123456789")],
  ["Datasets/Batch1/Record2/action.txt", Buffer.alloc(0)],
  ["mutable.txt", Buffer.from("abcdef")],
  ["module-unbounded.bin", Buffer.alloc(0)],
]);
let positionalContents = Buffer.from("ABCDEFGH");

async function record(options, event) {
  await appendFile(options.events, JSON.stringify(event) + "\\n");
}

function children(relativePath) {
  const prefix = relativePath ? relativePath + "/" : "";
  const names = new Set();
  for (const candidate of [...directories, ...files.keys(), "positional.bin", "config-unbounded.bin"]) {
    if (!candidate.startsWith(prefix) || candidate === relativePath) continue;
    const child = candidate.slice(prefix.length).split("/")[0];
    if (child) names.add(child);
  }
  return [...names];
}

const wholeFileProvider = {
  async getattr({ path, relativePath, options }) {
    await record(options, { operation: "getattr", path });
    if (path.startsWith("components/") && path.endsWith("/AGENTS.md")) {
      return { kind: "file", mode: 0o644, size: Buffer.byteLength("Instructions for " + path) };
    }
    if (directories.has(relativePath)) return { kind: "directory", mode: 0o755 };
    const contents = files.get(relativePath);
    if (!contents) return undefined;
    if (relativePath === "module-unbounded.bin") {
      return { kind: "file", mode: 0o644, sizeMode: "unbounded" };
    }
    return { kind: "file", mode: 0o644, size: contents.length };
  },
  async readdir({ path, relativePath, options }) {
    await record(options, { operation: "readdir", path });
    if (path.startsWith("components")) return undefined;
    return directories.has(relativePath) ? children(relativePath) : undefined;
  },
  async open({ path, flags, options }) {
    await record(options, { operation: "open", path, flags });
    return { path };
  },
  async create(_metadata, { path, relativePath, flags, options }) {
    files.set(relativePath, Buffer.alloc(0));
    await record(options, { operation: "create", path, flags });
    return { path };
  },
  async readFile({ path, relativePath, options }) {
    await record(options, { operation: "readFile", path });
    if (path.startsWith("components/")) return "Instructions for " + path;
    const contents = files.get(relativePath);
    if (!contents) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return contents;
  },
  async writeFile(contents, { path, relativePath, options }) {
    files.set(relativePath, Buffer.from(contents));
    await record(options, {
      operation: "writeFile",
      path,
      contents: contents.toString(),
    });
    console.log("provider writeFile", path, contents.toString());
  },
  async truncate(size, { path, relativePath, options }) {
    const previous = files.get(relativePath) ?? Buffer.alloc(0);
    const contents = Buffer.alloc(size);
    previous.copy(contents, 0, 0, Math.min(previous.length, size));
    files.set(relativePath, contents);
    await record(options, { operation: "truncate", path, size });
  },
  async flush({ path, options }) {
    await record(options, { operation: "flush", path });
  },
  async fsync(_dataSync, { path, options }) {
    await record(options, { operation: "fsync", path });
  },
  async release({ path, options }) {
    await record(options, { operation: "release", path });
  },
  async mkdir(_metadata, { path, relativePath, options }) {
    directories.add(relativePath);
    await record(options, { operation: "mkdir", path });
  },
  async unlink({ path, relativePath, options }) {
    files.delete(relativePath);
    await record(options, { operation: "unlink", path });
  },
  async rmdir({ path, relativePath, options }) {
    directories.delete(relativePath);
    await record(options, { operation: "rmdir", path });
  },
  async rename({ path, relativePath, destinationPath, destinationRelativePath, options }) {
    const contents = files.get(relativePath);
    if (contents) {
      files.delete(relativePath);
      files.set(destinationRelativePath, contents);
    }
    await record(options, { operation: "rename", path, destinationPath });
  },
  async access(_mode, { path, options }) {
    await record(options, { operation: "access", path });
  },
  async chmod(_mode, { path, options }) {
    await record(options, { operation: "chmod", path });
  },
  async chown(_uid, _gid, { path, options }) {
    await record(options, { operation: "chown", path });
  },
  async utimens(_atime, _mtime, { path, options }) {
    await record(options, { operation: "utimens", path });
  },
};

export default wholeFileProvider;

export const positionalProvider = {
  async getattr({ path, options }) {
    await record(options, { operation: "getattr", path });
    if (path.endsWith("config-unbounded.bin")) {
      return { kind: "file", mode: 0o644 };
    }
    return { kind: "file", mode: 0o644, size: positionalContents.length };
  },
  async open({ path, flags, options }) {
    await record(options, { operation: "open", path, flags });
    return { path };
  },
  async read(position, length, { path, options }) {
    await record(options, { operation: "positionalRead", path, position, length });
    if (path.endsWith("config-unbounded.bin")) return Buffer.alloc(length);
    return positionalContents.subarray(position, position + length);
  },
  async write(contents, position, { path, options }) {
    const length = Math.max(positionalContents.length, position + contents.length);
    const next = Buffer.alloc(length);
    positionalContents.copy(next);
    contents.copy(next, position);
    positionalContents = next;
    await record(options, {
      operation: "positionalWrite",
      path,
      position,
      contents: contents.toString(),
    });
    console.log("provider positionalWrite", path, contents.toString());
    return contents.length;
  },
  async flush({ path, options }) {
    await record(options, { operation: "flush", path });
  },
  async fsync(_dataSync, { path, options }) {
    await record(options, { operation: "fsync", path });
  },
  async release({ path, options }) {
    await record(options, { operation: "release", path });
  },
};
`;
}

async function listRuntimeContainers(): Promise<Set<string>> {
  const result = await runCommand("podman", [
    "ps",
    "--no-trunc",
    "--filter",
    "ancestor=localhost/scriptfs-runtime:0.1.0",
    "--format",
    "{{.ID}}",
  ]);
  return new Set(result.stdout.split(/\s+/).filter(Boolean));
}

async function readEvents(): Promise<ProviderEvent[]> {
  try {
    const contents = await readFile(eventsPath, "utf8");
    return contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProviderEvent);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function waitForProviderEvent(
  matches: (event: ProviderEvent) => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await readEvents()).some(matches)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the expected provider event");
}

async function waitForText(expected: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (stdout.includes(expected)) {
      return;
    }
    if (child?.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `CLI exited before expected output.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for CLI output containing "${expected}".\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}

function waitForExit(
  processToWatch: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (processToWatch.exitCode !== null || processToWatch.signalCode !== null) {
    return Promise.resolve({
      code: processToWatch.exitCode,
      signal: processToWatch.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for CLI process to exit")),
      30_000,
    );
    processToWatch.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function forceCleanup(): Promise<void> {
  await unmountHostShare(true);
  if (runtimeContainerId) {
    await runCommand("podman", ["rm", "--force", runtimeContainerId], {
      allowFailure: true,
    });
  }
}

async function unmountHostShare(allowFailure = false): Promise<void> {
  if (process.platform === "darwin" && mount) {
    await runCommand("/sbin/umount", [mount], { allowFailure });
  } else if (process.platform === "linux" && mount) {
    await runCommand("umount", [mount], { allowFailure });
  } else if (process.platform === "win32" && /^[a-zA-Z]:$/.test(mount)) {
    await runCommand("net", ["use", mount, "/delete", "/yes"], {
      allowFailure,
    });
  }
}
