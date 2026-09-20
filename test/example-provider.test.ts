import { cp, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { OverlayFileSystem } from "../src/overlay/filesystem.js";
import { createProviderLoader } from "../src/overlay/provider-loader.js";

let root: string;
let workspace: OverlayFileSystem;
let reference: OverlayFileSystem;
let controller: AbortController;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-example-"));
  await cp(path.resolve("examples/fixtures"), path.join(root, "fixtures"), {
    recursive: true,
  });
  const config = await loadConfig(path.resolve("examples/config.json"));
  const loader = createProviderLoader();
  const fixtures = path.resolve("examples/fixtures");
  const suffix = `?example-test=${randomUUID()}`;
  controller = new AbortController();
  const filesystems = config.filesystems.map(
    (filesystem) =>
      new OverlayFileSystem(
        {
          ...filesystem,
          source: path.join(
            root,
            "fixtures",
            path.relative(fixtures, filesystem.source),
          ),
          mountPoint: path.join(root, filesystem.name),
          rules: filesystem.rules?.map((rule) =>
            "hide" in rule
              ? rule
              : {
                  ...rule,
                  provider:
                    "module" in rule.provider
                      ? {
                          ...rule.provider,
                          module:
                            pathToFileURL(rule.provider.module).href + suffix,
                        }
                      : {
                          ...rule.provider,
                          path: path.join(
                            root,
                            "fixtures",
                            path.relative(fixtures, rule.provider.path),
                          ),
                        },
                },
          ),
        },
        loader,
        controller.signal,
      ),
  );
  const [first, second] = filesystems;
  if (!first || !second) throw new Error("Expected both example filesystems");
  workspace = first;
  reference = second;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  controller.abort();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("demonstrates additive instructions, synthetic ancestors, symlinks, and hidden generated entries", async () => {
  const instructions = "components/Button/AGENTS.md";
  await workspace.access(instructions, 4);
  expect((await workspace.readFile(instructions)).toString()).toContain(
    "Component instructions",
  );
  await workspace.access("Tools", 1);
  expect(await workspace.readlink("Tools/Memory/latest")).toBe("data.txt");
  expect(
    (await workspace.readFile("MergedDirectory/source-only.txt")).toString(),
  ).toContain("source side");
  expect(await workspace.readFile("MergedDirectory/existing.txt")).toEqual(
    await readFile(path.join(root, "fixtures/proxy-directory/existing.txt")),
  );
  for (const directory of ["", "GeneratedCatalog", "Tools/Memory"]) {
    expect(
      (await workspace.readdir(directory))?.some((entry) =>
        entry.name.endsWith(".private"),
      ),
    ).toBe(false);
  }
});

it("creates high-level files and implements real finite positional writes and truncation", async () => {
  const created = "GeneratedCatalog/created.txt";
  const createdHandle = await workspace.create(created, 0o644, 2);
  await workspace.release(created, 2, createdHandle);
  expect((await workspace.getattr(created))?.size).toBe(0);
  await workspace.writeFile(created, Buffer.from("whole-file"));
  expect((await workspace.readFile(created)).toString()).toBe("whole-file");
  expect(
    (await workspace.readdir("GeneratedCatalog"))?.map((entry) => entry.name),
  ).toContain("created.txt");

  const fixed = "GeneratedCatalog/FixedSize.bin";
  expect(await workspace.getattr(fixed)).toMatchObject({
    size: 16,
    sizeMode: "explicit",
  });
  const handle = await workspace.open(fixed, 2);
  try {
    await workspace.writeChunk(fixed, Buffer.from("OK"), 2, 2, handle);
    expect(
      (await workspace.readChunk(fixed, 0, 6, 2, handle))?.toString(),
    ).toBe("FFOKFF");
    await workspace.ftruncate(fixed, 4, 2, handle);
    expect(await workspace.fgetattr(fixed, 2, handle)).toMatchObject({
      size: 4,
    });
  } finally {
    await workspace.release(fixed, 2, handle);
  }
});

it("demonstrates zero, unbounded and non-seekable policies without silently writable streams", async () => {
  const sink = "GeneratedCatalog/CommandSink.txt";
  expect(await workspace.getattr(sink)).toMatchObject({
    size: 0,
    sizeMode: "zero",
    seekable: false,
  });
  const command = await workspace.open(sink, 1);
  await workspace.ftruncate(sink, 0, 1, command);
  await workspace.writeChunk(sink, Buffer.from("run"), 0, 1, command);
  await workspace.release(sink, 1, command);
  expect(
    vi
      .mocked(console.log)
      .mock.calls.filter(([message]) =>
        String(message).includes("write 3 bytes"),
      ),
  ).toHaveLength(1);

  const stream = "GeneratedCatalog/GeneratedStream.bin";
  expect(await workspace.getattr(stream)).toMatchObject({
    sizeMode: "unbounded",
    seekable: true,
  });
  const handle = await workspace.open(stream, 0);
  try {
    expect(
      (await workspace.readChunk(stream, 10, 4, 0, handle))?.toString(),
    ).toBe("SSSS");
    await expect(
      workspace.writeChunk(stream, Buffer.from("X"), 0, 2, handle),
    ).rejects.toMatchObject({ code: "EROFS" });
  } finally {
    await workspace.release(stream, 0, handle);
  }
  expect(
    await workspace.getattr("GeneratedCatalog/SequentialStream.bin"),
  ).toMatchObject({ size: 4096, seekable: false });
});

it("keeps mutable resources and directory handles stable across namespace changes", async () => {
  const base = "Tools/Memory";
  await workspace.mkdir(`${base}/before`, 0o755);
  const directory = await workspace.opendir(`${base}/before`, 0);
  let name = `${base}/before/file`;
  const handle = await workspace.create(name, 0o644, 2);
  try {
    await workspace.writeChunk(name, Buffer.from("original"), 0, 2, handle);
    await workspace.fsetattr(
      name,
      { mode: 0o600, atime: new Date(1000), mtime: new Date(2000) },
      2,
      handle,
      false,
    );
    await workspace.chown(name, 123, 456);
    expect(await workspace.fgetattr(name, 2, handle)).toMatchObject({
      size: 8,
      mode: 0o600,
      uid: 123,
      gid: 456,
      mtime: new Date(2000),
    });
    await workspace.rename(`${base}/before`, `${base}/after`);
    name = `${base}/after/file`;
    await workspace.flush(name, 2, handle);
    await workspace.fsync(name, false, 2, handle);
    await workspace.fsyncdir(`${base}/after`, true, 0, directory);
    await expect(workspace.rmdir(`${base}/after`)).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    await workspace.unlink(name);
    const replacement = await workspace.create(name, 0o644, 2);
    await workspace.release(name, 2, replacement);
    expect((await workspace.readChunk(name, 0, 8, 2, handle))?.toString()).toBe(
      "original",
    );
    await workspace.ftruncate(name, 3, 2, handle);
    expect(await workspace.fgetattr(name, 2, handle)).toMatchObject({
      size: 3,
    });
    expect(await workspace.getattr(name)).toMatchObject({ size: 0 });
    await workspace.unlink(name);
    await workspace.rmdir(`${base}/after`);
  } finally {
    await workspace.release(name, 2, handle);
    await workspace.releasedir(`${base}/after`, 0, directory);
  }
  controller.abort();
  expect(console.log).toHaveBeenCalledWith("[memory] shutdown signal received");
});

it("demonstrates source lifecycle hooks, writable proxies and a read-only filesystem", async () => {
  const handle = await workspace.create("created.native", 0o644, 2);
  try {
    expect(handle.native).toBeDefined();
    await workspace.writeChunk(
      "created.native",
      Buffer.from("native"),
      0,
      2,
      handle,
    );
    await workspace.fsync("created.native", false, 2, handle);
  } finally {
    await workspace.release("created.native", 2, handle);
  }
  expect(
    await readFile(path.join(root, "fixtures/source/created.native"), "utf8"),
  ).toBe("native");
  await workspace.writeFile("ProxiedFile.txt", Buffer.from("proxy"));
  expect(
    await readFile(path.join(root, "fixtures/proxy-file.txt"), "utf8"),
  ).toBe("proxy");
  const proxy = await workspace.create("ProxiedDirectory/new", 0o644, 2);
  await workspace.release("ProxiedDirectory/new", 2, proxy);
  await workspace.rename("ProxiedDirectory/new", "ProxiedDirectory/renamed");
  await workspace.unlink("ProxiedDirectory/renamed");
  await expect(
    reference.writeFile("README.txt", Buffer.from("not allowed")),
  ).rejects.toMatchObject({ code: "EROFS" });
  expect(await reference.statfs("/")).toMatchObject({ flag: 1 });
});
