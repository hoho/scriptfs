import {
  mkdir,
  mkdtemp,
  lstat,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverlayFileSystem } from "../src/overlay/filesystem.js";
import { createProviderLoader } from "../src/overlay/provider-loader.js";
import { loadConfig } from "../src/config.js";
import { openNativeFile } from "../src/overlay/native.js";
import { runCommand } from "../src/runtime/command-runner.js";
import type { ScriptFsProvider } from "../src/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: vi.fn(original.open),
    stat: vi.fn(original.stat),
  };
});

let source: string;
beforeEach(async () => {
  source = await mkdtemp(path.join(tmpdir(), "scriptfs-native-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(source, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32").each(["source", "directory"] as const)(
  "changes %s symlink timestamps without dereferencing its target, including dangling links",
  async (kind) => {
    const target = path.join(source, "target");
    const link = path.join(source, "link");
    await writeFile(target, "unchanged");
    await symlink("target", link);
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules:
          kind === "source"
            ? []
            : [
                {
                  match: "Proxy/**",
                  root: "Proxy",
                  provider: { type: "directory", path: source },
                },
              ],
      },
      createProviderLoader(),
    );
    const name = kind === "source" ? "link" : "Proxy/link";
    const original = await stat(target);
    await filesystem.utimens(name, new Date(100125), new Date(200750));
    expect(await lstat(link)).toMatchObject({
      atimeMs: 100125,
      mtimeMs: 200750,
    });
    expect(await stat(target)).toMatchObject({
      atimeMs: original.atimeMs,
      mtimeMs: original.mtimeMs,
    });
    await rm(target);
    await filesystem.utimens(name, new Date(300125), new Date(400750));
    expect(await lstat(link)).toMatchObject({
      atimeMs: 300125,
      mtimeMs: 400750,
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["source", "directory", "file"] as const)(
  "rejects FIFOs in %s backing without blocking or breaking directory listings",
  async (kind) => {
    await writeFile(path.join(source, "regular"), "ordinary");
    await runCommand("mkfifo", [path.join(source, "fifo")]);
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules:
          kind === "source"
            ? []
            : kind === "directory"
              ? [
                  {
                    match: "Proxy/**",
                    root: "Proxy",
                    provider: { type: "directory", path: source },
                  },
                ]
              : [
                  {
                    match: "Fixed",
                    provider: { type: "file", path: path.join(source, "fifo") },
                  },
                ],
      },
      createProviderLoader(),
    );
    const name =
      kind === "source"
        ? "fifo"
        : kind === "directory"
          ? "Proxy/fifo"
          : "Fixed";
    await expect(filesystem.getattr(name)).rejects.toMatchObject({
      code: "EOPNOTSUPP",
    });
    for (const flags of [0, 1, 2])
      await expect(filesystem.open(name, flags)).rejects.toMatchObject({
        code: "EOPNOTSUPP",
      });
    await expect(filesystem.readFile(name)).rejects.toMatchObject({
      code: "EOPNOTSUPP",
    });
    await expect(
      filesystem.writeFile(name, Buffer.from("X")),
    ).rejects.toMatchObject({ code: "EOPNOTSUPP" });
    const entries = await filesystem.readdir(
      kind === "directory" ? "Proxy" : "",
    );
    expect(entries?.map((entry) => entry.name)).toEqual(["regular"]);
    expect(
      (
        await filesystem.readFile(
          kind === "directory" ? "Proxy/regular" : "regular",
        )
      ).toString(),
    ).toBe("ordinary");
  },
);

it.skipIf(process.platform === "win32")(
  "does not block or leak a descriptor when a regular file becomes a FIFO before open",
  async () => {
    await writeFile(path.join(source, "regular"), "ordinary");
    const regular = await fsPromises.stat(path.join(source, "regular"));
    const fifo = path.join(source, "fifo");
    await runCommand("mkfifo", [fifo]);
    const opener = vi.mocked(fsPromises.open).mockClear();
    vi.mocked(fsPromises.stat).mockResolvedValueOnce(regular);
    await expect(
      openNativeFile(fifo, constants.O_RDONLY),
    ).rejects.toMatchObject({
      code: "EOPNOTSUPP",
    });
    expect(opener).toHaveBeenCalledWith(
      fifo,
      constants.O_RDONLY | constants.O_NONBLOCK,
      undefined,
    );
    const handle: unknown = await opener.mock.results[0]?.value;
    expect(handle).toMatchObject({ fd: -1 });
    await expect(
      openNativeFile(
        fifo,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a file proxy replaced by a symlink between metadata checks and descriptor acquisition",
  async () => {
    const target = path.join(source, "target");
    const actual = path.join(source, "actual");
    await writeFile(target, "original");
    await writeFile(actual, "unchanged");
    await symlink("actual", path.join(source, "replacement"));
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "Proxy", provider: { type: "file", path: target } }],
      },
      createProviderLoader(),
    );
    const metadata = await stat(target);
    vi.mocked(fsPromises.stat).mockImplementationOnce(async () => {
      await rename(path.join(source, "replacement"), target);
      return metadata;
    });
    await expect(
      filesystem.open("Proxy", constants.O_RDWR),
    ).rejects.toMatchObject({ code: "ELOOP" });
    expect(await readFile(actual, "utf8")).toBe("unchanged");
  },
);

it.skipIf(process.platform === "win32")(
  "still lists generated overrides of unsupported source nodes",
  async () => {
    await runCommand("mkfifo", [path.join(source, "generated.txt")]);
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "*.txt", provider: { module: "memory" } }],
      },
      () =>
        Promise.resolve({
          getattr: () => ({ kind: "file", size: 9 }),
          readFile: () => "generated",
        }),
    );
    expect((await filesystem.readdir(""))?.map((entry) => entry.name)).toEqual([
      "generated.txt",
    ]);
    expect((await filesystem.readFile("generated.txt")).toString()).toBe(
      "generated",
    );
  },
);

it.each(["source", "proxy", "create-hook"] as const)(
  "preserves native access and append flags when creating through %s",
  async (kind) => {
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules:
          kind === "source"
            ? []
            : kind === "proxy"
              ? [{ match: "**", provider: { type: "directory", path: source } }]
              : [{ match: "**", provider: { module: "hook" } }],
      },
      kind === "create-hook"
        ? () =>
            Promise.resolve({
              async create(metadata, { sourcePath }) {
                const handle = await open(sourcePath, "wx", metadata.mode);
                await handle.close();
              },
            })
        : createProviderLoader(),
    );
    const readonly = await filesystem.create(
      "readonly",
      0o644,
      constants.O_RDONLY,
    );
    try {
      await expect(
        filesystem.writeChunk(
          "readonly",
          Buffer.from("X"),
          0,
          constants.O_RDONLY,
          readonly,
        ),
      ).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await filesystem.release("readonly", constants.O_RDONLY, readonly);
    }
    const flags = constants.O_WRONLY | constants.O_APPEND;
    const append = await filesystem.create("append", 0o644, flags);
    try {
      await filesystem.writeChunk("append", Buffer.from("A"), 0, flags, append);
      if (!append.native) throw new Error("Expected native descriptor");
      await append.native.write(Buffer.from("B"), 0, 1, null);
      expect(await readFile(path.join(source, "append"), "utf8")).toBe("AB");
      await expect(
        filesystem.readChunk("append", 0, 2, flags, append),
      ).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await filesystem.release("append", flags, append);
    }
  },
);

it.each(["source", "proxy", "create-hook", "provider"] as const)(
  "preserves executable creation permissions through %s",
  async (kind) => {
    const create = vi.fn<NonNullable<ScriptFsProvider["create"]>>(
      async (metadata, { sourcePath }) => {
        if (kind === "create-hook") {
          const handle = await open(sourcePath, "wx", metadata.mode);
          await handle.close();
        }
      },
    );
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules:
          kind === "source"
            ? []
            : kind === "proxy"
              ? [{ match: "**", provider: { type: "directory", path: source } }]
              : [
                  {
                    match: "**",
                    opaque: kind === "provider",
                    provider: { module: "hook" },
                  },
                ],
      },
      kind === "source" || kind === "proxy"
        ? createProviderLoader()
        : () => Promise.resolve({ create }),
    );
    const flags = constants.O_WRONLY;
    const handle = await filesystem.create("executable", 0o100751, flags);
    try {
      if (kind === "create-hook" || kind === "provider") {
        expect(create).toHaveBeenCalledExactlyOnceWith(
          { kind: "file", mode: 0o751, size: 0, sizeMode: "explicit" },
          expect.objectContaining({ flags }),
        );
      }
      if (kind !== "provider") {
        expect(open).toHaveBeenCalledWith(
          path.join(source, "executable"),
          expect.anything(),
          0o751,
        );
      }
    } finally {
      await filesystem.release("executable", flags, handle);
    }
  },
);

it.each([0o4755, 0o2755, 0o1755])(
  "preserves special permission bits in provider creation mode %o",
  async (mode) => {
    const create = vi.fn<NonNullable<ScriptFsProvider["create"]>>();
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "**", opaque: true, provider: { module: "memory" } }],
      },
      () => Promise.resolve({ create }),
    );
    const handle = await filesystem.create(
      "executable",
      mode | 0o100000,
      constants.O_WRONLY,
    );
    try {
      expect(create).toHaveBeenCalledExactlyOnceWith(
        { kind: "file", mode, size: 0, sizeMode: "explicit" },
        expect.objectContaining({ flags: constants.O_WRONLY }),
      );
    } finally {
      await filesystem.release("executable", constants.O_WRONLY, handle);
    }
  },
);

it.each(["source", "file", "directory"] as const)(
  "synchronizes the actual %s backing descriptor and propagates sync failures",
  async (kind) => {
    await writeFile(path.join(source, "data"), "old");
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules:
          kind === "source"
            ? []
            : kind === "file"
              ? [
                  {
                    match: "data",
                    provider: { type: "file", path: path.join(source, "data") },
                  },
                ]
              : [
                  {
                    match: "Proxy/**",
                    root: "Proxy",
                    provider: { type: "directory", path: source },
                  },
                ],
      },
      createProviderLoader(),
    );
    const name = kind === "directory" ? "Proxy/data" : "data";
    const handle = await filesystem.open(name, 2);
    try {
      if (!handle.native) throw new Error("Expected native file handle");
      const sync = vi.spyOn(handle.native, "sync");
      const datasync = vi.spyOn(handle.native, "datasync");
      await filesystem.writeChunk(name, Buffer.from("new"), 0, 2, handle);
      await filesystem.fsync(name, false, 2, handle);
      await filesystem.fsync(name, true, 2, handle);
      expect(sync).toHaveBeenCalledOnce();
      expect(datasync).toHaveBeenCalledOnce();
      sync.mockRejectedValueOnce(
        Object.assign(new Error("sync failed"), { code: "EIO" }),
      );
      await expect(
        filesystem.fsync(name, false, 2, handle),
      ).rejects.toMatchObject({ code: "EIO" });
    } finally {
      await filesystem.release(name, 2, handle);
    }
  },
);

it("preserves native descriptor identity when the source pathname is atomically replaced", async () => {
  const target = path.join(source, "data");
  await writeFile(target, "ORIGINAL");
  const filesystem = new OverlayFileSystem(
    { name: "test", source, mountPoint: "/unused" },
    createProviderLoader(),
  );
  const handle = await filesystem.open("data", 2);
  try {
    await writeFile(path.join(source, "replacement"), "REPLACEMENT");
    await rename(path.join(source, "replacement"), target);
    await filesystem.ftruncate("data", 3, 2, handle);
    expect(await readFile(target, "utf8")).toBe("REPLACEMENT");
    expect(
      (await filesystem.readChunk("data", 0, 3, 2, handle))?.toString(),
    ).toBe("ORI");
  } finally {
    await filesystem.release("data", 2, handle);
  }
});

it.each(["read", "fgetattr"] as const)(
  "releases temporary positional resources when %s fails during whole-file reads",
  async (operation) => {
    const failure = Object.assign(new Error("provider failed"), {
      code: "EIO",
    });
    const release = vi.fn();
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          { match: "data", opaque: true, provider: { module: "memory" } },
        ],
      },
      () =>
        Promise.resolve({
          getattr: () => ({ kind: "file", size: 4 }),
          open: () => "resource",
          fgetattr: () => {
            if (operation === "fgetattr") throw failure;
            return { kind: "file", size: 4 };
          },
          read: () => {
            throw failure;
          },
          release,
        }),
    );
    await expect(filesystem.readFile("data")).rejects.toBe(failure);
    expect(release).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ handle: "resource", flags: 0 }),
    );
  },
);

it.each([
  { kind: "file", descriptorMetadata: false },
  { kind: "file", descriptorMetadata: true },
  { kind: "directory", descriptorMetadata: false },
  { kind: "directory", descriptorMetadata: true },
] as const)(
  "uses native identity for a decorated $kind with fgetattr=$descriptorMetadata",
  async ({ kind, descriptorMetadata }) => {
    const target = path.join(source, "decorated");
    const materialize = async (): Promise<void> => {
      if (kind === "directory") await mkdir(target);
      else await writeFile(target, "native");
    };
    await materialize();
    const metadata = { kind, identity: "provider:decoration", mode: 0o750 };
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "decorated", provider: { module: "memory" } }],
      },
      () =>
        Promise.resolve({
          getattr: () => metadata,
          ...(descriptorMetadata ? { fgetattr: () => metadata } : {}),
        }),
    );
    const before = await filesystem.getattr("decorated");
    expect(before).toMatchObject({ kind, mode: 0o750 });
    if (kind === "file") expect(before?.size).toBe(6);
    expect(before?.identity).toMatch(/^native:/);
    const handle = await filesystem[kind === "directory" ? "opendir" : "open"](
      "decorated",
      0,
    );
    try {
      expect(await filesystem.fgetattr("decorated", 0, handle)).toMatchObject({
        identity: before?.identity,
        mode: 0o750,
        ...(kind === "file" ? { size: 6 } : {}),
      });
      if (kind === "file") {
        await writeFile(target, "native extended");
        expect(await filesystem.fgetattr("decorated", 0, handle)).toMatchObject(
          {
            mode: 0o750,
            size: 15,
          },
        );
      }
      await rename(target, path.join(source, "retained"));
      await materialize();
      expect((await filesystem.getattr("decorated"))?.identity).not.toBe(
        before?.identity,
      );
      expect(await filesystem.fgetattr("decorated", 0, handle)).toMatchObject({
        identity: before?.identity,
        mode: 0o750,
        ...(kind === "file" ? { size: 15 } : {}),
      });
      expect(metadata.identity).toBe("provider:decoration");
    } finally {
      await filesystem[kind === "directory" ? "releasedir" : "release"](
        "decorated",
        0,
        handle,
      );
    }
  },
);

it.each(["source", "directory"] as const)(
  "syncs %s directory descriptors after rename and closes them",
  async (kind) => {
    const backing = path.join(source, "backing");
    await mkdir(backing);
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules:
          kind === "source"
            ? []
            : [
                {
                  match: "Proxy/**",
                  root: "Proxy",
                  provider: { type: "directory", path: backing },
                },
              ],
      },
      createProviderLoader(),
    );

    const name = kind === "source" ? "backing" : "Proxy";
    const handle = await filesystem.opendir(name, 0);
    if (!handle.native) throw new Error("Expected directory descriptor");
    try {
      const sync = vi.spyOn(handle.native, "sync");
      const datasync = vi.spyOn(handle.native, "datasync");
      await rename(backing, path.join(source, "renamed"));
      await mkdir(backing);
      await filesystem.fsyncdir(name, false, 0, handle);
      await filesystem.fsyncdir(name, true, 0, handle);
      expect(sync).toHaveBeenCalledOnce();
      expect(datasync).toHaveBeenCalledOnce();
      sync.mockRejectedValueOnce(
        Object.assign(new Error("directory sync failed"), { code: "EIO" }),
      );
      await expect(
        filesystem.fsyncdir(name, false, 0, handle),
      ).rejects.toMatchObject({ code: "EIO" });
    } finally {
      await filesystem.releasedir(name, 0, handle);
    }
    expect(handle.native.fd).toBe(-1);
  },
);

it("does not decorate the mount root with a broad file metadata provider", async () => {
  const getattr = vi.fn(() => ({ kind: "file" as const, mode: 0o400 }));
  const filesystem = new OverlayFileSystem(
    {
      name: "test",
      source,
      mountPoint: "/unused",
      rules: [{ match: "**", provider: { module: "memory" } }],
    },
    () => Promise.resolve({ getattr }),
  );
  const before = await filesystem.getattr("");
  const handle = await filesystem.opendir("", 0);
  try {
    expect(await filesystem.fgetattr("", 0, handle)).toMatchObject({
      kind: "directory",
      identity: before?.identity,
      mode: before?.mode,
    });
    expect(getattr).not.toHaveBeenCalled();
  } finally {
    await filesystem.releasedir("", 0, handle);
  }
});

it.each([false, true])(
  "captures native creation metadata and releases resources on failure=%s",
  async (failMetadata) => {
    const resource = {};
    let opened = false;
    const release = vi.fn();
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "created", provider: { module: "memory" } }],
      },
      () =>
        Promise.resolve({
          open: () => {
            opened = true;
            return resource;
          },
          getattr: () => {
            expect(opened).toBe(true);
            if (failMetadata)
              throw Object.assign(new Error("metadata failed"), {
                code: "EIO",
              });
            return { kind: "file", mode: 0o640 };
          },
          release,
        }),
    );
    if (failMetadata) {
      const opener = vi.mocked(fsPromises.open).mockClear();
      await expect(
        filesystem.create("created", 0o644, 2),
      ).rejects.toMatchObject({ code: "EIO" });
      expect(release).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ handle: resource }),
      );
      expect(await readFile(path.join(source, "created"))).toEqual(
        Buffer.alloc(0),
      );
      const native: unknown = await opener.mock.results[0]?.value;
      expect(native).toMatchObject({ fd: -1 });
    } else {
      const handle = await filesystem.create("created", 0o644, 2);
      try {
        expect(await filesystem.fgetattr("created", 2, handle)).toMatchObject({
          mode: 0o640,
          size: 0,
        });
      } finally {
        await filesystem.release("created", 2, handle);
      }
    }
  },
);

it.each([
  { failureAt: "open", mutation: "replace" },
  { failureAt: "open", mutation: "write" },
  { failureAt: "getattr", mutation: "replace" },
  { failureAt: "getattr", mutation: "write" },
])(
  "preserves concurrent $mutation when $failureAt fails after native creation",
  async ({ failureAt, mutation }) => {
    const target = path.join(source, "created");
    const replacement = path.join(source, "replacement");
    await writeFile(replacement, "concurrent contents");
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continued = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const failure = Object.assign(new Error("provider failed"), {
      code: "EIO",
    });
    const fail = async (): Promise<never> => {
      entered();
      await continued;
      throw failure;
    };
    const resource = {};
    const release = vi.fn();
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "created", provider: { module: "memory" } }],
      },
      () =>
        Promise.resolve({
          open: failureAt === "open" ? fail : () => resource,
          getattr: failureAt === "getattr" ? fail : () => ({ kind: "file" }),
          release,
        }),
    );
    const opener = vi.mocked(fsPromises.open).mockClear();
    const rejected = expect(
      filesystem.create("created", 0o644, 2),
    ).rejects.toBe(failure);
    await started;
    try {
      if (mutation === "replace") await rename(replacement, target);
      else await writeFile(target, "concurrent contents");
    } finally {
      resume();
    }
    await rejected;
    expect(await readFile(target, "utf8")).toBe("concurrent contents");
    const native: unknown = await opener.mock.results[0]?.value;
    expect(native).toMatchObject({ fd: -1 });
    if (failureAt === "getattr")
      expect(release).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ handle: resource }),
      );
    else expect(release).not.toHaveBeenCalled();
  },
);

it.each(["zero", "unbounded"] as const)(
  "preserves an explicit %s size policy on native-backed metadata overlays",
  async (sizeMode) => {
    await writeFile(path.join(source, "data"), "native");
    const metadata = { kind: "file" as const, sizeMode };
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "data", provider: { module: "memory" } }],
      },
      () =>
        Promise.resolve({
          getattr: () => metadata,
          fgetattr: () => metadata,
        }),
    );
    const expected = {
      sizeMode,
      size: sizeMode === "zero" ? 0 : 0x7fff_ffff_ffff,
    };
    expect(await filesystem.getattr("data")).toMatchObject(expected);
    const handle = await filesystem.open("data", 0);
    try {
      expect(await filesystem.fgetattr("data", 0, handle)).toMatchObject(
        expected,
      );
    } finally {
      await filesystem.release("data", 0, handle);
    }
  },
);

it.each(["open", "create", "opendir"] as const)(
  "releases acquired provider resources if native %s fails",
  async (operation) => {
    const resource = await open(path.join(source, "resource"), "w+");
    const release = vi.fn(async () => {
      await resource.close();
    });
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "missing", provider: { module: "memory" } }],
      },
      () =>
        Promise.resolve({
          [operation]: () => resource,
          release,
          releasedir: release,
        }),
    );
    try {
      const pending =
        operation === "create"
          ? filesystem.create("missing", 0o644, 2)
          : filesystem[operation]("missing", 0);
      await expect(pending).rejects.toMatchObject({ code: "ENOENT" });
      expect(release).toHaveBeenCalledOnce();
      expect(resource.fd).toBe(-1);
    } finally {
      if (resource.fd !== -1) await resource.close();
    }
  },
);

it("preserves native acquisition and provider cleanup errors together", async () => {
  const filesystem = new OverlayFileSystem(
    {
      name: "test",
      source,
      mountPoint: "/unused",
      rules: [{ match: "missing", provider: { module: "memory" } }],
    },
    () =>
      Promise.resolve({
        open: () => ({ resource: true }),
        release: () => {
          throw Object.assign(new Error("cleanup failed"), { code: "EIO" });
        },
      }),
  );
  await expect(filesystem.open("missing", 0)).rejects.toMatchObject({
    errors: [{ code: "ENOENT" }, { code: "EIO" }],
  });
});

it("closes a native source descriptor even when its custom release hook fails", async () => {
  await writeFile(path.join(source, "data"), "data");
  const resource = { opened: true };
  const release = vi.fn(() => {
    throw Object.assign(new Error("release failed"), { code: "EIO" });
  });
  const filesystem = new OverlayFileSystem(
    {
      name: "test",
      source,
      mountPoint: "/unused",
      rules: [{ match: "data", provider: { module: "memory" } }],
    },
    () => Promise.resolve({ open: () => resource, release }),
  );
  const handle = await filesystem.open("data", 2);
  await expect(filesystem.release("data", 2, handle)).rejects.toMatchObject({
    code: "EIO",
  });
  expect(handle.native?.fd).toBe(-1);
  expect(release).toHaveBeenCalledWith(
    expect.objectContaining({ handle: resource }),
  );
});

it("writes the actual content-sized example without options and resets its command sink", async () => {
  const config = await loadConfig(path.resolve("examples/config.json"));
  const filesystemConfig = config.filesystems[0];
  if (!filesystemConfig) throw new Error("Missing example filesystem");
  const filesystem = new OverlayFileSystem(
    filesystemConfig,
    createProviderLoader(),
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await filesystem.writeFile(
    "GeneratedCatalog/ContentSized.txt",
    Buffer.from("updated example"),
  );
  expect(
    (await filesystem.readFile("GeneratedCatalog/ContentSized.txt")).toString(),
  ).toBe("updated example");
  const sink = "GeneratedCatalog/CommandSink.txt";
  const handle = await filesystem.open(sink, 1);
  try {
    await filesystem.ftruncate(sink, 0, 1, handle);
    await filesystem.writeChunk(sink, Buffer.from("run"), 0, 1, handle);
    expect(
      log.mock.calls.filter((call) =>
        String(call[0]).includes("write 3 bytes"),
      ),
    ).toHaveLength(1);
  } finally {
    await filesystem.release(sink, 1, handle);
  }
});

it("preserves zero-size policy while ordinary whole-file metadata is buffered", async () => {
  const provider: ScriptFsProvider = {
    getattr: () => ({ kind: "file", sizeMode: "zero" }),
    readFile: () => "",
    writeFile: () => undefined,
  };
  const filesystem = new OverlayFileSystem(
    {
      name: "test",
      source,
      mountPoint: "/unused",
      rules: [
        { match: "command", opaque: true, provider: { module: "memory" } },
      ],
    },
    () => Promise.resolve(provider),
  );
  await filesystem.writeFile("command", Buffer.from("run"));
  expect(await filesystem.getattr("command")).toMatchObject({
    size: 0,
    sizeMode: "zero",
  });
});
