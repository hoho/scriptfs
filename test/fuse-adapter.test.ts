import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open as openNative,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate as truncateNative,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFuseMount } from "../src/container/fuse-adapter.js";
import type {
  FuseOperations,
  FuseStat,
} from "../src/container/fuse-binding.js";
import { OverlayFileSystem } from "../src/overlay/filesystem.js";
import { createProviderLoader } from "../src/overlay/provider-loader.js";
import type {
  FilesystemConfig,
  NodeMetadata,
  ScriptFsProvider,
} from "../src/types.js";

let source: string;
let operations: FuseOperations;
let mountOptions: Record<string, unknown> | undefined;
let openHandles: Set<number>;

class FakeFuse {
  static EACCES = -13;
  static EEXIST = -17;
  static EIO = -5;
  static EISDIR = -21;
  static ENOENT = -2;
  static ENOTDIR = -20;
  static ENOTEMPTY = -39;
  static ENOSYS = -38;
  static EPERM = -1;
  static EROFS = -30;
  static ESPIPE = -29;
  static EXDEV = -18;
  static EINVAL = -22;
  static EBADF = -9;
  static EBUSY = -16;
  static ESTALE = -116;
  static EOPNOTSUPP = -95;
  static ENOSPC = -28;
  static EDQUOT = -122;
  static EFBIG = -27;
  static ELOOP = -40;
  static EMFILE = -24;
  static ENFILE = -23;
  static ENOMEM = -12;
  static EINTR = -4;
  static EAGAIN = -11;
  static ENAMETOOLONG = -36;
  static ERANGE = -34;
  static ETIMEDOUT = -110;
  constructor(
    _mount: string,
    ops: FuseOperations,
    options?: Record<string, unknown>,
  ) {
    operations = ops;
    mountOptions = options;
  }

  mount(callback: (error?: Error) => void): void {
    callback();
  }
  unmount(callback: (error?: Error) => void): void {
    callback();
  }
}

it("passes explicit zero cache timeouts through the binding's truthy option checks", () => {
  expect(mountOptions).toMatchObject({
    attrTimeout: "0",
    entryTimeout: "0",
    acAttrTimeout: "0",
  });
});

it.each([
  [123, 0xffff_ffff, 123, -1],
  [0xffff_ffff, 456, -1, 456],
  [0xffff_ffff, 0xffff_ffff, -1, -1],
  [-1, -1, -1, -1],
  [0x8000_0000, 0xffff_fffe, 0x8000_0000, 0xffff_fffe],
  [0, 0, 0, 0],
])(
  "preserves ownership sentinel and unsigned IDs (%s, %s)",
  async (uid, gid, expectedUid, expectedGid) => {
    const chown = vi.fn();
    setup({ chown });
    await success((cb) => operations.chown("/data", uid, gid, cb));
    expect(chown).toHaveBeenCalledExactlyOnceWith(
      expectedUid,
      expectedGid,
      expect.objectContaining({ path: "data" }),
    );
  },
);

it("disables binding timeouts that discard late provider resource handles", () => {
  expect(mountOptions?.timeout).toBe(false);
});

it("materializes a new whole-file provider entry before create returns", async () => {
  const contents = new Map<string, Buffer>();
  const writer = vi.fn((value: Buffer, { path: name }: { path: string }) => {
    contents.set(name, Buffer.from(value));
  });
  setup({
    getattr: ({ path: name }) =>
      contents.has(name)
        ? { kind: "file", size: contents.get(name)?.length }
        : undefined,
    readFile: ({ path: name }) => {
      const value = contents.get(name);
      if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    writeFile: writer,
  });
  const empty = await value<number>((cb) =>
    operations.create("/empty", 0o644, 2, cb),
  );
  openHandles.add(empty);
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/empty", empty, cb)),
  ).toMatchObject({ size: 0 });
  expect(contents.get("empty")).toEqual(Buffer.alloc(0));
  expect(writer).toHaveBeenCalledExactlyOnceWith(
    Buffer.alloc(0),
    expect.objectContaining({ previousContents: undefined }),
  );
  await write(empty, "created");
  await flush(empty);
  expect((await read(await open("/empty"), 7)).toString()).toBe("created");
});

it.each(["open", "create"] as const)(
  "requests direct I/O for non-seekable %s handles",
  async (operation) => {
    setup({
      getattr: () => ({ kind: "file", size: 16, seekable: false }),
      create: () => ({}),
      read: (_position, length) => Buffer.alloc(length, "X"),
    });
    const flags = await new Promise<boolean | undefined>((resolve, reject) => {
      const callback = (
        code: number,
        fd?: number,
        directIO?: boolean,
      ): void => {
        if (code || fd === undefined) reject(new Error(String(code)));
        else {
          openHandles.add(fd);
          resolve(directIO);
        }
      };
      if (operation === "open") operations.open("/data", 0, callback);
      else operations.create("/data", 0o644, 2, callback);
    });
    expect(flags).toBe(true);
  },
);

beforeEach(async () => {
  source = await mkdtemp(path.join(tmpdir(), "scriptfs-fuse-test-"));
  openHandles = new Set();
  setup();
});

afterEach(async () => {
  try {
    for (const fd of openHandles)
      await success((cb) => operations.release("/unused", fd, cb));
  } finally {
    await rm(source, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

function setup(
  provider?: ScriptFsProvider,
  overrides: Partial<FilesystemConfig> = {},
): void {
  createFuseMount(
    FakeFuse,
    "/unused",
    new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: provider
          ? [{ match: "**", provider: { module: "memory" }, opaque: true }]
          : [],
        ...overrides,
      },
      provider ? () => Promise.resolve(provider) : createProviderLoader(),
    ),
    false,
  );
}

function success(
  invoke: (callback: (error: number) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) =>
    invoke((code) => (code < 0 ? reject(new Error(String(code))) : resolve())),
  );
}

function value<T>(
  invoke: (callback: (error: number, result?: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) =>
    invoke((code, result) => {
      if (code < 0) reject(new Error(String(code)));
      else if (result === undefined)
        reject(new Error("Missing callback result"));
      else resolve(result);
    }),
  );
}

async function open(file = "/data", flags = 2): Promise<number> {
  const fd = await value<number>((cb) => operations.open(file, flags, cb));
  openHandles.add(fd);
  // The native backend applies O_TRUNC after validating the acquired inode.
  if (flags & 0x200) {
    try {
      await success((cb) => operations.ftruncate(file, fd, 0, cb));
    } catch (error) {
      openHandles.delete(fd);
      await success((cb) => operations.release(file, fd, cb));
      throw error;
    }
  }
  return fd;
}

async function read(fd: number, size: number, position = 0): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  const length = await new Promise<number>((resolve, reject) => {
    operations.read("/unused", fd, buffer, size, position, (code) =>
      code < 0 ? reject(new Error(String(code))) : resolve(code),
    );
  });
  return buffer.subarray(0, length);
}

function write(fd: number, text: string, position = 0): Promise<void> {
  const buffer = Buffer.from(text);
  return success((cb) =>
    operations.write("/unused", fd, buffer, buffer.length, position, cb),
  );
}

function flush(fd: number): Promise<void> {
  return success((cb) => operations.flush("/unused", fd, cb));
}

it.each([0, 1, 2, 1 | 0x400, 1 | 0x101000])(
  "preserves create flags %# through provider callbacks and access checks",
  async (flags) => {
    const resource = {};
    const create = vi.fn(() => resource);
    const release = vi.fn();
    setup({
      getattr: () => ({ kind: "file", size: 0 }),
      create,
      read: () => Buffer.alloc(0),
      write: (contents) => contents.length,
      release,
    });
    const fd = await value<number>((cb) =>
      operations.create("/data", 0o644, flags, cb),
    );
    openHandles.add(fd);
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ flags }),
    );
    if ((flags & 3) === 0) await expect(write(fd, "X")).rejects.toThrow("-9");
    else await write(fd, "X");
    if ((flags & 3) === 1) await expect(read(fd, 1)).rejects.toThrow("-9");
    else expect(await read(fd, 1)).toEqual(Buffer.alloc(0));
    await success((cb) => operations.release("/data", fd, cb));
    openHandles.delete(fd);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ flags, handle: resource }),
    );
  },
);

it.each([true, false])(
  "handles short positional reads without changing direct I/O behavior (seekable: %s)",
  async (seekable) => {
    const contents = Buffer.from("abcdef");
    const reader = vi.fn((position: number, length: number) =>
      contents.subarray(position, position + Math.min(length, 2)),
    );
    setup({
      getattr: () => ({ kind: "file", size: contents.length, seekable }),
      read: reader,
    });
    const fd = await open("/data", 0);
    expect((await read(fd, 10)).toString()).toBe(seekable ? "abcdef" : "ab");
    expect(reader.mock.calls.map(([position]) => position)).toEqual(
      seekable ? [0, 2, 4, 6] : [0],
    );
    expect((await read(fd, 4, seekable ? 6 : 2)).toString()).toBe(
      seekable ? "" : "cd",
    );
  },
);

it("propagates errors while completing a short cached read", async () => {
  setup({
    getattr: () => ({ kind: "file", size: 6 }),
    read: (position) => {
      if (position > 0)
        throw Object.assign(new Error("read failed"), { code: "EACCES" });
      return Buffer.from("ab");
    },
  });
  await expect(read(await open("/data", 0), 6)).rejects.toThrow("-13");
});

it("preserves retained bytes when ftruncate precedes the first read", async () => {
  await writeFile(path.join(source, "data"), "abcdef");
  const fd = await open();
  await success((cb) => operations.ftruncate("/data", fd, 4, cb));
  expect((await read(fd, 4)).toString()).toBe("abcd");
  await write(fd, "Z", 3);
  await flush(fd);
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("abcZ");
});

it("derives stable inode numbers without retaining an identity registry", async () => {
  let identity = "provider:first";
  setup({
    getattr: () => ({ kind: "file", identity, size: 0 }),
  });
  const first = await value<FuseStat>((cb) => operations.getattr("/data", cb));
  const repeated = await value<FuseStat>((cb) =>
    operations.getattr("/data", cb),
  );
  identity = "provider:second";
  const second = await value<FuseStat>((cb) => operations.getattr("/data", cb));

  expect(first.ino).toBe(repeated.ino);
  expect(first.dev).toBe(repeated.dev);
  expect(first.dev).not.toBe(0);
  expect(first.ino).not.toBe(0);
  expect(second.ino).not.toBe(first.ino);
});

it("preserves source writes with lifecycle-only open hooks when truncating", async () => {
  const resource = { opened: true };
  const hook = vi.fn(() => resource);
  const synced = vi.fn();
  const released = vi.fn();
  setup(
    { open: hook, fsync: synced, release: released },
    { rules: [{ match: "**", provider: { module: "memory" } }] },
  );
  await writeFile(path.join(source, "data"), "0000");
  const fd = await open();
  await write(fd, "A");
  await success((cb) => operations.ftruncate("/data", fd, 3, cb));
  await success((cb) => operations.fsync("/data", false, fd, cb));
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("A00");
  expect(synced).toHaveBeenCalledWith(
    false,
    expect.objectContaining({ handle: resource }),
  );
  await success((cb) => operations.release("/data", fd, cb));
  openHandles.delete(fd);
  expect(released).toHaveBeenCalledWith(
    expect.objectContaining({ handle: resource }),
  );
});

it("shares source data between create-only lifecycle hooks and subsequent native opens", async () => {
  setup(
    {
      create: async (_metadata, { sourcePath }) => {
        await writeFile(sourcePath, "");
      },
    },
    { rules: [{ match: "**", provider: { module: "memory" } }] },
  );
  const first = await value<number>((cb) =>
    operations.create("/data", 0o644, 2, cb),
  );
  openHandles.add(first);
  await write(first, "A");
  const second = await open();
  expect((await read(second, 1)).toString()).toBe("A");
  await write(second, "B", 1);
  await flush(first);
  await flush(second);
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("AB");
});

it("opens source files during create with open-only lifecycle hooks", async () => {
  const opened = vi.fn();
  setup(
    { open: opened },
    { rules: [{ match: "**", provider: { module: "memory" } }] },
  );
  const fd = await value<number>((cb) =>
    operations.create("/data", 0o644, 2, cb),
  );
  openHandles.add(fd);
  await write(fd, "created");
  await flush(fd);
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("created");
  expect(opened).toHaveBeenCalledOnce();
});

it("retains directory handles through rename and forwards provider sync and release", async () => {
  const resource = { directory: true };
  const sync = vi.fn();
  const release = vi.fn();
  setup(
    { opendir: () => resource, fsyncdir: sync, releasedir: release },
    { rules: [{ match: "**", provider: { module: "memory" } }] },
  );
  await mkdir(path.join(source, "before"));
  const fd = await value<number>((cb) => operations.opendir("/before", 0, cb));
  try {
    await success((cb) => operations.rename("/before", "/after", cb));
    await success((cb) => operations.fsyncdir("/unused", false, fd, cb));
    expect(sync).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ path: "after", handle: resource }),
    );
    sync.mockRejectedValueOnce(
      Object.assign(new Error("sync failed"), { code: "EACCES" }),
    );
    await expect(
      success((cb) => operations.fsyncdir("/after", false, fd, cb)),
    ).rejects.toThrow("-13");
    sync.mockRejectedValueOnce(
      Object.assign(new Error("unsupported"), { code: "ENOSYS" }),
    );
    await expect(
      success((cb) => operations.fsyncdir("/after", false, fd, cb)),
    ).rejects.toThrow("-95");
  } finally {
    await success((cb) => operations.releasedir("/unused", fd, cb));
  }
  expect(release).toHaveBeenCalledWith(
    expect.objectContaining({ path: "after", handle: resource }),
  );
  await expect(
    success((cb) => operations.fsyncdir("/after", false, fd, cb)),
  ).rejects.toThrow("-9");
});

it("opens synthetic ancestors but rejects unsupported virtual directory synchronization", async () => {
  setup(
    { getattr: () => ({ kind: "directory" }) },
    {
      rules: [
        {
          match: "Nested/Deep/**",
          root: "Nested/Deep",
          opaque: true,
          provider: { module: "memory" },
        },
      ],
    },
  );
  for (const directory of ["/Nested", "/Nested/Deep"]) {
    const fd = await value<number>((cb) =>
      operations.opendir(directory, 0, cb),
    );
    try {
      await expect(
        success((cb) => operations.fsyncdir(directory, false, fd, cb)),
      ).rejects.toThrow("-95");
    } finally {
      await success((cb) => operations.releasedir(directory, fd, cb));
    }
  }
});

it("does not zero the next reader after pathname truncation", async () => {
  await writeFile(path.join(source, "data"), "abcdef");
  await success((cb) => operations.truncate("/data", 4, cb));
  expect((await read(await open("/data", 0), 4)).toString()).toBe("abcd");
});

it("invalidates a completed clean truncate when the backing file changes", async () => {
  await writeFile(path.join(source, "data"), "abcdef");
  await success((cb) => operations.truncate("/data", 4, cb));
  await writeFile(path.join(source, "data"), "NEW DATA");
  const fd = await open();
  expect((await read(fd, 8)).toString()).toBe("NEW DATA");
  await write(fd, "X", 0);
  await flush(fd);
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("XEW DATA");
});

it.each(["pathname", "descriptor", "open"] as const)(
  "refreshes whole-file contents after a no-op zero truncate through %s",
  async (operation) => {
    let contents = Buffer.alloc(0);
    const writer = vi.fn((next: Buffer) => {
      contents = Buffer.from(next);
    });
    setup({
      getattr: () => ({ kind: "file", size: contents.length }),
      readFile: () => contents,
      writeFile: writer,
    });
    let fd: number;
    if (operation === "pathname") {
      await success((cb) => operations.truncate("/data", 0, cb));
      fd = await open();
    } else {
      fd = await open("/data", operation === "open" ? 2 | 0x200 : 2);
      if (operation === "descriptor")
        await success((cb) => operations.ftruncate("/data", fd, 0, cb));
    }
    expect(writer).not.toHaveBeenCalled();
    contents = Buffer.from("ABCDE");
    expect((await read(fd, 5)).toString()).toBe("ABCDE");
    await write(fd, "X", 1);
    await flush(fd);
    expect(contents.toString()).toBe("AXCDE");
    expect(writer).toHaveBeenCalledOnce();
  },
);

it("retains zero padding after extending a dirty newly created file", async () => {
  const fd = await value<number>((cb) =>
    operations.create("/data", 0o644, 2, cb),
  );
  openHandles.add(fd);
  await write(fd, "abc");
  await success((cb) => operations.ftruncate("/data", fd, 6, cb));
  await flush(fd);
  expect(await readFile(path.join(source, "data"))).toEqual(
    Buffer.from([97, 98, 99, 0, 0, 0]),
  );
});

it("shares buffered contents between handles without losing disjoint writes", async () => {
  await writeFile(path.join(source, "data"), "0000");
  const first = await open();
  const second = await open();
  await read(first, 4);
  await read(second, 4);
  await write(first, "A", 0);
  await flush(first);
  await write(second, "B", 1);
  await flush(second);
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("AB00");
});

it("refreshes clean shared buffers when a backing file changes before a new open", async () => {
  await writeFile(path.join(source, "data"), "old");
  const first = await open();
  expect((await read(first, 3)).toString()).toBe("old");
  await writeFile(path.join(source, "data"), "new contents");
  expect((await read(first, 12)).toString()).toBe("new contents");
  const second = await open();
  expect((await read(second, 12)).toString()).toBe("new contents");
});

function backedWholeFileProvider(): ScriptFsProvider {
  return {
    async getattr({ sourcePath }) {
      try {
        const metadata = await stat(sourcePath, { bigint: true });
        return {
          kind: metadata.isDirectory() ? "directory" : "file",
          identity: `${String(metadata.dev)}:${String(metadata.ino)}`,
          nlink: Number(metadata.nlink),
          size: Number(metadata.size),
          mtime: metadata.mtime,
          ctime: metadata.ctime,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
    },
    readFile: ({ sourcePath }) => readFile(sourcePath),
    writeFile: (contents, { sourcePath }) => writeFile(sourcePath, contents),
    truncate: (size, { sourcePath }) => truncateNative(sourcePath, size),
    unlink: ({ sourcePath }) => unlink(sourcePath),
    rename: ({ sourcePath, destinationPath }) =>
      rename(sourcePath, path.join(source, destinationPath)),
  };
}

function backedPositionalFileProvider(): ScriptFsProvider {
  return {
    ...backedWholeFileProvider(),
    readFile: undefined,
    writeFile: undefined,
    read: async (position, length, { sourcePath }) =>
      (await readFile(sourcePath)).subarray(position, position + length),
    async write(contents, position, { sourcePath }) {
      const handle = await openNative(sourcePath, "r+");
      try {
        return (await handle.write(contents, 0, contents.length, position))
          .bytesWritten;
      } finally {
        await handle.close();
      }
    },
  };
}

it.each(
  ["whole", "whole-ftruncate", "positional"].flatMap((kind) =>
    ["remove", "replace"].flatMap((external) =>
      ["unlink", "replace"].flatMap((mounted) =>
        [false, true].flatMap((observe) =>
          [false, true].map((dirty) => ({
            kind,
            external,
            mounted,
            observe,
            dirty,
          })),
        ),
      ),
    ),
  ),
)(
  "retains $kind handles across external $external then mounted $mounted (observe=$observe, dirty=$dirty)",
  async ({ kind, external, mounted, observe, dirty }) => {
    const provider =
      kind === "positional"
        ? backedPositionalFileProvider()
        : backedWholeFileProvider();
    if (kind === "whole-ftruncate")
      provider.ftruncate = (size, { sourcePath }) =>
        truncateNative(sourcePath, size);
    setup(provider);
    await writeFile(path.join(source, "data"), "ORIGINAL");
    await link(path.join(source, "data"), path.join(source, "alias"));
    const first = await open();
    const second = await open("/alias");
    if (dirty) await write(first, "A");
    if (external === "replace") {
      await writeFile(path.join(source, "incoming"), "NEW");
      await rename(path.join(source, "incoming"), path.join(source, "data"));
    } else {
      await unlink(path.join(source, "data"));
    }
    if (observe) {
      const lookup = value<FuseStat>((cb) => operations.getattr("/data", cb));
      if (external === "remove") await expect(lookup).rejects.toThrow("-2");
      else await lookup;
    }
    if (mounted === "replace") {
      await writeFile(path.join(source, "incoming"), "NEXT");
      await success((cb) => operations.rename("/incoming", "/alias", cb));
    } else {
      await success((cb) => operations.unlink("/alias", cb));
    }
    for (const fd of [first, second]) {
      expect((await read(fd, 8)).toString()).toBe(
        dirty ? "ARIGINAL" : "ORIGINAL",
      );
      expect(
        await value<FuseStat>((cb) => operations.fgetattr("/alias", fd, cb)),
      ).toMatchObject({ size: 8, nlink: 0 });
    }
    await write(first, "UPDATED!");
    await flush(first);
    expect((await read(second, 8)).toString()).toBe("UPDATED!");
    await success((cb) => operations.ftruncate("/alias", first, 5, cb));
    await flush(first);
    expect((await read(second, 8)).toString()).toBe("UPDAT");
    if (external === "replace")
      expect(await readFile(path.join(source, "data"), "utf8")).toBe("NEW");
    else
      await expect(stat(path.join(source, "data"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    if (mounted === "replace")
      expect(await readFile(path.join(source, "alias"), "utf8")).toBe("NEXT");
    else
      await expect(stat(path.join(source, "alias"))).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);

it.each(["flush", "fsync", "timer"] as const)(
  "isolates replacement identities and rejects stale buffered %s writes",
  async (operation) => {
    setup(backedWholeFileProvider());
    await writeFile(path.join(source, "data"), "OLD");
    const old = await open();
    const flushFailed = deferred();
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => flushFailed.resolve());
    if (operation === "timer") vi.useFakeTimers();
    try {
      await write(old, "DIRTY");
      await writeFile(path.join(source, "replacement"), "NEW");
      await rename(path.join(source, "replacement"), path.join(source, "data"));
      expect(
        await value<FuseStat>((cb) => operations.getattr("/data", cb)),
      ).toMatchObject({ size: 3 });
      const fresh = await open();
      expect((await read(fresh, 8)).toString()).toBe("NEW");
      expect((await read(old, 8)).toString()).toBe("DIRTY");
      await expect(
        success((cb) => operations.ftruncate("/data", old, 0, cb)),
      ).rejects.toThrow("-116");
      if (operation === "timer") {
        await vi.advanceTimersByTimeAsync(500);
        await flushFailed.promise;
        expect(logged).toHaveBeenCalledWith(
          expect.objectContaining({ code: "ESTALE" }),
        );
      } else {
        await expect(
          operation === "flush"
            ? flush(old)
            : success((cb) => operations.fsync("/data", false, old, cb)),
        ).rejects.toThrow("-116");
      }
      openHandles.delete(old);
      await expect(
        success((cb) => operations.release("/data", old, cb)),
      ).rejects.toThrow("-116");
      await write(fresh, "X");
      await flush(fresh);
      expect(await readFile(path.join(source, "data"), "utf8")).toBe("XEW");
    } finally {
      vi.useRealTimers();
    }
  },
);

it("rejects stale whole-file reads and flushes without a replacement lookup", async () => {
  setup(backedWholeFileProvider());
  await writeFile(path.join(source, "data"), "OLD");
  const clean = await open();
  await writeFile(path.join(source, "replacement"), "NEW");
  await rename(path.join(source, "replacement"), path.join(source, "data"));
  await expect(read(clean, 3)).rejects.toThrow("-116");
  const dirty = await open();
  await write(dirty, "DIRTY");
  await writeFile(path.join(source, "replacement"), "NEXT");
  await rename(path.join(source, "replacement"), path.join(source, "data"));
  await expect(flush(dirty)).rejects.toThrow("-116");
  openHandles.delete(dirty);
  await expect(
    success((cb) => operations.release("/data", dirty, cb)),
  ).rejects.toThrow("-116");
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("NEXT");
});

it.each([false, true])(
  "rejects stale handleless positional I/O with replacement lookup=%s",
  async (lookup) => {
    let current = { identity: "original", contents: Buffer.from("ORIGINAL") };
    const reader = vi.fn((position: number, length: number) =>
      current.contents.subarray(position, position + length),
    );
    const writer = vi.fn((contents: Buffer, position: number) =>
      contents.copy(current.contents, position),
    );
    setup({
      getattr: () => ({
        kind: "file",
        identity: current.identity,
        size: current.contents.length,
      }),
      read: reader,
      write: writer,
    });
    const old = await open();
    await write(old, "A");
    expect((await read(old, 8)).toString()).toBe("ARIGINAL");
    current = { identity: "replacement", contents: Buffer.from("NEW") };
    if (lookup) await value<FuseStat>((cb) => operations.getattr("/data", cb));
    reader.mockClear();
    writer.mockClear();
    await expect(read(old, 8)).rejects.toThrow("-116");
    await expect(write(old, "BAD")).rejects.toThrow("-116");
    expect(reader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(current.contents.toString()).toBe("NEW");
    const fresh = await open();
    expect((await read(fresh, 3)).toString()).toBe("NEW");
    await write(fresh, "X");
    expect(current.contents.toString()).toBe("XEW");
  },
);

it("rechecks handleless positional identity between continuation reads", async () => {
  let current = { identity: "original", contents: Buffer.from("ORIGINAL") };
  const reader = vi.fn((position: number) => {
    const chunk = current.contents.subarray(position, position + 2);
    current = { identity: "replacement", contents: Buffer.from("NEW") };
    return chunk;
  });
  setup({
    getattr: () => ({
      kind: "file",
      identity: current.identity,
      size: current.contents.length,
    }),
    read: reader,
  });
  const fd = await open();
  await expect(read(fd, 8)).rejects.toThrow("-116");
  expect(reader).toHaveBeenCalledOnce();
});

it("keeps handleless positional I/O on a known surviving alias and detached snapshot", async () => {
  const original = { identity: "original", contents: Buffer.from("ORIGINAL") };
  const replacement = { identity: "replacement", contents: Buffer.from("NEW") };
  const entries = new Map([
    ["data", original],
    ["alias", original],
  ]);
  const entry = (name: string): typeof original => {
    const resource = entries.get(name);
    if (!resource)
      throw Object.assign(new Error("Missing entry"), { code: "ENOENT" });
    return resource;
  };
  setup({
    getattr: ({ path: name }) => {
      const resource = entries.get(name);
      return (
        resource && {
          kind: "file",
          identity: resource.identity,
          size: resource.contents.length,
          nlink: [...entries.values()].filter((value) => value === resource)
            .length,
        }
      );
    },
    read: (position, length, { path: name }) =>
      entry(name).contents.subarray(position, position + length),
    write: (contents, position, { path: name }) =>
      contents.copy(entry(name).contents, position),
    unlink: ({ path: name }) => {
      entries.delete(name);
    },
  });
  const first = await open();
  const alias = await open("/alias");
  entries.set("data", replacement);
  expect((await read(first, 8)).toString()).toBe("ORIGINAL");
  await write(first, "A");
  expect((await read(alias, 8)).toString()).toBe("ARIGINAL");
  await value<FuseStat>((cb) => operations.getattr("/data", cb));
  await success((cb) => operations.unlink("/alias", cb));
  expect((await read(first, 8)).toString()).toBe("ARIGINAL");
  await write(first, "B");
  expect((await read(alias, 8)).toString()).toBe("BRIGINAL");
  expect(replacement.contents.toString()).toBe("NEW");
});

it.each(["unlink", "replace", "external-unlink"] as const)(
  "persists whole-file writes through a surviving hard link after %s",
  async (operation) => {
    setup(backedWholeFileProvider());
    await writeFile(path.join(source, "data"), "ORIGINAL");
    await link(path.join(source, "data"), path.join(source, "alias"));
    const first = await open();
    const second = await open("/alias");
    await write(first, "A");
    await write(second, "B", 1);
    expect((await read(first, 8)).toString()).toBe("ABIGINAL");
    if (operation === "unlink")
      await success((cb) => operations.unlink("/data", cb));
    else if (operation === "replace") {
      await writeFile(path.join(source, "replacement"), "NEW");
      await success((cb) => operations.rename("/replacement", "/data", cb));
    } else {
      await unlink(path.join(source, "data"));
    }
    await write(first, "UPDATED!");
    await success((cb) => operations.fsync("/alias", false, first, cb));
    expect(await readFile(path.join(source, "alias"), "utf8")).toBe("UPDATED!");
    expect((await read(second, 8)).toString()).toBe("UPDATED!");
    for (const fd of [first, second])
      expect(
        await value<FuseStat>((cb) => operations.fgetattr("/alias", fd, cb)),
      ).toMatchObject({ nlink: 1 });
    if (operation === "replace")
      expect(await readFile(path.join(source, "data"), "utf8")).toBe("NEW");
  },
);

it("recovers a surviving hard-link path supplied by the native inode backend", async () => {
  setup(backedWholeFileProvider());
  await writeFile(path.join(source, "data"), "ORIGINAL");
  await link(path.join(source, "data"), path.join(source, "alias"));
  await value<FuseStat>((cb) => operations.getattr("/alias", cb));
  const fd = await open();
  await success((cb) => operations.unlink("/data", cb));
  await success((cb) =>
    operations.write("/alias", fd, Buffer.from("UPDATED!"), 8, 0, cb),
  );
  await success((cb) => operations.fsync("/alias", false, fd, cb));
  expect(await readFile(path.join(source, "alias"), "utf8")).toBe("UPDATED!");
});

it("refreshes captured sizes across distinct open handles sharing a provider identity", async () => {
  setup({ ...backedWholeFileProvider(), open: () => ({}) });
  await writeFile(path.join(source, "data"), "OLD");
  await link(path.join(source, "data"), path.join(source, "alias"));
  const first = await open();
  const second = await open("/alias");
  await write(first, "EXTENDED");
  await flush(first);
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/alias", second, cb)),
  ).toMatchObject({ size: 8 });
});

it.each([false, true])(
  "shares whole-file sizes without identities, including pending opens and truncate hooks=%s",
  async (truncateHook) => {
    let contents = Buffer.from("old");
    setup({
      getattr: () => ({ kind: "file", size: contents.length }),
      open: () => ({}),
      readFile: () => contents,
      writeFile: (next) => {
        contents = Buffer.from(next);
      },
      ...(truncateHook
        ? {
            truncate: (size: number) => {
              const next = Buffer.alloc(size);
              contents.copy(next);
              contents = next;
            },
          }
        : {}),
    });
    const first = await open();
    const second = await open();
    await write(first, "EXTENDED");
    const pending = await open();
    await flush(first);
    const descriptors = [first, second, pending];
    const expectContents = async (expected: string): Promise<void> => {
      expect(contents.toString()).toBe(expected);
      for (const fd of descriptors) {
        expect(
          await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
        ).toMatchObject({ size: expected.length });
        expect((await read(fd, 20)).toString()).toBe(expected);
      }
    };
    await expectContents("EXTENDED");
    await success((cb) => operations.ftruncate("/data", first, 4, cb));
    await success((cb) => operations.fsync("/data", false, first, cb));
    await expectContents("EXTE");
    const truncated = await open("/data", 2 | 0x200);
    descriptors.push(truncated);
    await flush(truncated);
    await expectContents("");
    await write(second, "another");
    await flush(second);
    await success((cb) => operations.truncate("/data", 3, cb));
    await flush(second);
    await expectContents("ano");
  },
);

it("keeps distinct positional resources' captured sizes independent without identities", async () => {
  const original = { contents: Buffer.from("ORIGINAL") };
  const replacement = { contents: Buffer.from("REPLACEMENT") };
  let current = original;
  const resource = (handle: unknown): typeof original => {
    if (handle === original) return original;
    if (handle === replacement) return replacement;
    throw new Error("Invalid resource");
  };
  setup({
    getattr: () => ({ kind: "file", size: current.contents.length }),
    open: () => current,
    read: (position, length, { handle }) =>
      resource(handle).contents.subarray(position, position + length),
    ftruncate: (size, { handle }) => {
      const entry = resource(handle);
      entry.contents = entry.contents.subarray(0, size);
    },
  });
  const first = await open();
  current = replacement;
  const second = await open();
  await success((cb) => operations.ftruncate("/data", first, 3, cb));
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/data", first, cb)),
  ).toMatchObject({ size: 3 });
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/data", second, cb)),
  ).toMatchObject({ size: 11 });
  expect((await read(second, 20)).toString()).toBe("REPLACEMENT");
});

it.each([0, 0x200])(
  "exposes native identity changes without premature truncation (flags=%i)",
  async (flags) => {
    await writeFile(path.join(source, "data"), "OLD");
    const before = await stat(path.join(source, "data"));
    setup(
      {
        open: async ({ sourcePath }) => {
          await writeFile(path.join(source, "replacement"), "NEW");
          await rename(path.join(source, "replacement"), sourcePath);
        },
      },
      { rules: [{ match: "**", provider: { module: "memory" } }] },
    );
    const beforeIdentity = await value<FuseStat>((cb) =>
      operations.getattr("/data", cb),
    );
    const fd = await value<number>((cb) => operations.open("/data", flags, cb));
    openHandles.add(fd);
    expect((await stat(path.join(source, "data"))).ino).not.toBe(before.ino);
    const actual = await value<FuseStat>((cb) =>
      operations.fgetattr("/data", fd, cb),
    );
    const expected = await value<FuseStat>((cb) =>
      operations.getattr("/data", cb),
    );
    expect([actual.dev, actual.ino]).toEqual([expected.dev, expected.ino]);
    expect([actual.dev, actual.ino]).not.toEqual([
      beforeIdentity.dev,
      beforeIdentity.ino,
    ]);
    expect(await readFile(path.join(source, "data"), "utf8")).toBe("NEW");
  },
);

it("reports an unknown surviving hard link instead of discarding buffered writes", async () => {
  setup(backedWholeFileProvider());
  await writeFile(path.join(source, "data"), "ORIGINAL");
  await link(path.join(source, "data"), path.join(source, "alias"));
  const fd = await open();
  await success((cb) => operations.unlink("/data", cb));
  await expect(write(fd, "UPDATED!")).rejects.toThrow("-116");
  await value<FuseStat>((cb) => operations.getattr("/alias", cb));
  await write(fd, "UPDATED!");
  await flush(fd);
  expect(await readFile(path.join(source, "alias"), "utf8")).toBe("UPDATED!");
});

it("serializes writes arriving while an asynchronous provider flush is pending", async () => {
  let contents = Buffer.from("0000");
  const started = deferred();
  const commit = deferred();
  let writes = 0;
  setup({
    getattr: () => ({ kind: "file", size: 4 }),
    readFile: () => contents,
    async writeFile(next) {
      if (++writes === 1) {
        started.resolve();
        await commit.promise;
      }
      contents = Buffer.from(next);
    },
  });
  const fd = await open();
  await write(fd, "A", 0);
  const flushing = flush(fd);
  await started.promise;
  const writing = write(fd, "B", 1);
  commit.resolve();
  await Promise.all([flushing, writing]);
  await flush(fd);
  expect(contents.toString()).toBe("AB00");
  expect(writes).toBe(2);
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let finish = (): void => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: () => finish() };
}

it("moves open handles when their file or parent directory is renamed", async () => {
  await mkdir(path.join(source, "directory"));
  await writeFile(path.join(source, "directory", "data"), "0000");
  const fd = await open("/directory/data");
  await write(fd, "A");
  await success((cb) => operations.rename("/directory", "/renamed", cb));
  await write(fd, "B", 1);
  await flush(fd);
  expect(await readFile(path.join(source, "renamed", "data"), "utf8")).toBe(
    "AB00",
  );
  await expect(stat(path.join(source, "directory"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["source", "proxy", "positional", "whole-file"] as const)(
  "retains %s descriptor I/O when a parent rename hides its path",
  async (kind) => {
    await mkdir(path.join(source, "before"));
    await writeFile(path.join(source, "before", "data.txt"), "abcdef");
    const prefix = kind === "proxy" ? "/Proxy" : "";
    const provider: ScriptFsProvider | undefined =
      kind === "whole-file"
        ? {
            readFile: ({ sourcePath }) => readFile(sourcePath),
            writeFile: (contents, { sourcePath }) =>
              writeFile(sourcePath, contents),
          }
        : kind === "positional"
          ? {
              read: async (position, length, { sourcePath }) =>
                (await readFile(sourcePath)).subarray(
                  position,
                  position + length,
                ),
              write: async (contents, position, { sourcePath }) => {
                const native = await openNative(sourcePath, "r+");
                try {
                  return (
                    await native.write(contents, 0, contents.length, position)
                  ).bytesWritten;
                } finally {
                  await native.close();
                }
              },
              truncate: (size, { sourcePath }) =>
                truncateNative(sourcePath, size),
            }
          : undefined;
    setup(provider, {
      rules: [
        ...(kind === "proxy"
          ? [
              {
                match: "Proxy/**",
                root: "Proxy",
                provider: { type: "directory" as const, path: source },
              },
            ]
          : provider
            ? [{ match: "**", provider: { module: "memory" } }]
            : []),
        { match: prefix ? "Proxy/after/*.txt" : "after/*.txt", hide: true },
      ],
    });
    const fd = await open(`${prefix}/before/data.txt`);
    await success((cb) =>
      operations.rename(`${prefix}/before`, `${prefix}/after`, cb),
    );
    expect(
      await value<FuseStat>((cb) => operations.fgetattr("/unused", fd, cb)),
    ).toMatchObject({ size: 6 });
    expect((await read(fd, 6)).toString()).toBe("abcdef");
    await write(fd, "X");
    await success((cb) => operations.ftruncate("/unused", fd, 3, cb));
    await success((cb) => operations.fsync("/unused", false, fd, cb));
    expect((await read(fd, 3)).toString()).toBe("Xbc");
    expect(await readFile(path.join(source, "after", "data.txt"), "utf8")).toBe(
      "Xbc",
    );
    await expect(open(`${prefix}/after/data.txt`)).rejects.toThrow("-2");
    await expect(
      value<FuseStat>((cb) =>
        operations.getattr(`${prefix}/after/data.txt`, cb),
      ),
    ).rejects.toThrow("-2");
  },
);

it("does not resurrect an unlinked file when an open handle is flushed", async () => {
  await writeFile(path.join(source, "data"), "0000");
  const fd = await open();
  await write(fd, "A");
  await success((cb) => operations.unlink("/data", cb));
  await write(fd, "B", 1);
  await flush(fd);
  expect((await read(fd, 4)).toString()).toBe("AB00");
  await expect(stat(path.join(source, "data"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps overwritten destination handles separate from the renamed file", async () => {
  await writeFile(path.join(source, "data"), "old");
  await writeFile(path.join(source, "new"), "new");
  const fd = await open();
  await success((cb) => operations.rename("/new", "/data", cb));
  await write(fd, "X");
  await flush(fd);
  expect((await read(fd, 3)).toString()).toBe("Xld");
  expect(await readFile(path.join(source, "data"), "utf8")).toBe("new");
});

it.each([
  { kind: "whole-file", mutation: "unlink" },
  { kind: "whole-file", mutation: "replace" },
  { kind: "positional", mutation: "unlink" },
  { kind: "positional", mutation: "replace" },
] as const)(
  "reports zero links for a detached $kind file after $mutation",
  async ({ kind, mutation }) => {
    const original = { identity: "old", contents: Buffer.from("OLD") };
    const replacement = { identity: "new", contents: Buffer.from("NEW") };
    const entries = new Map([
      ["data", original],
      ["replacement", replacement],
    ]);
    const metadata = (entry: typeof original): NodeMetadata => ({
      kind: "file",
      identity: entry.identity,
      size: entry.contents.length,
      nlink: 1,
    });
    const resource = (handle: unknown): typeof original => {
      if (handle === original) return original;
      if (handle === replacement) return replacement;
      throw new Error("Invalid resource");
    };
    let failRemoval = true;
    const assertRemoval = (): void => {
      if (failRemoval)
        throw Object.assign(new Error("Removal denied"), { code: "EACCES" });
    };
    setup({
      getattr: ({ path: name }) => {
        const entry = entries.get(name);
        return entry && metadata(entry);
      },
      open: ({ path: name }) => entries.get(name),
      ...(kind === "positional"
        ? {
            fgetattr: ({ handle }) => metadata(resource(handle)),
            read: (position, length, { handle }) =>
              resource(handle).contents.subarray(position, position + length),
          }
        : {
            readFile: ({ path: name }) => {
              const entry = entries.get(name);
              if (!entry) throw new Error("Missing entry");
              return entry.contents;
            },
          }),
      unlink: ({ path: name }) => {
        assertRemoval();
        entries.delete(name);
      },
      rename: ({ path: name, destinationPath }) => {
        assertRemoval();
        const entry = entries.get(name);
        if (!entry) throw new Error("Missing entry");
        entries.delete(name);
        entries.set(destinationPath, entry);
      },
    });
    const fd = await open();
    const remove = (): Promise<void> =>
      success((cb) =>
        mutation === "unlink"
          ? operations.unlink("/data", cb)
          : operations.rename("/replacement", "/data", cb),
      );
    await expect(remove()).rejects.toThrow("-13");
    expect(
      await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
    ).toMatchObject({ nlink: 1 });
    failRemoval = false;
    await remove();
    expect(
      await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
    ).toMatchObject({ nlink: 0 });
    expect((await read(fd, 20)).toString()).toBe("OLD");
    if (mutation === "replace")
      expect(
        await value<FuseStat>((cb) => operations.getattr("/data", cb)),
      ).toMatchObject({ nlink: 1 });
  },
);

it("does not dispatch detached positional writes against a replacement pathname", async () => {
  let current = Buffer.from("OLD");
  setup({
    getattr: () => ({ kind: "file", size: current.length }),
    readFile: () => current,
    read: (position, length) => current.subarray(position, position + length),
    write: (contents, position) => contents.copy(current, position),
    unlink: () => {
      current = Buffer.alloc(0);
    },
  });
  const fd = await open();
  await success((cb) => operations.unlink("/data", cb));
  current = Buffer.from("NEW");
  await write(fd, "X", 0);
  expect((await read(fd, 3)).toString()).toBe("XLD");
  expect(current.toString()).toBe("NEW");
});

it("snapshots whole-file provider handles that implement descriptor truncation", async () => {
  let current = Buffer.from("OLD");
  setup({
    getattr: () => ({ kind: "file", size: current.length }),
    readFile: () => current,
    open: () => ({ resource: "old" }),
    ftruncate: () => undefined,
    unlink: () => {
      current = Buffer.alloc(0);
    },
  });
  const fd = await open();
  await success((cb) => operations.unlink("/data", cb));
  current = Buffer.from("NEW");
  expect((await read(fd, 3)).toString()).toBe("OLD");
  expect(current.toString()).toBe("NEW");
});

it.each(["unlink", "replace"] as const)(
  "persists retained mixed-writer mutations after %s while keeping snapshot reads coherent",
  async (mutation) => {
    const original = {
      identity: "original",
      contents: Buffer.from("ORIGINAL"),
    };
    const replacement = {
      identity: "replacement",
      contents: Buffer.from("NEW"),
    };
    const entries = new Map([
      ["data", original],
      ["replacement", replacement],
    ]);
    const resource = (handle: unknown): typeof original => {
      if (handle === original) return original;
      if (handle === replacement) return replacement;
      throw new Error("Invalid resource handle");
    };
    const metadata = (entry: typeof original) => ({
      kind: "file" as const,
      identity: entry.identity,
      size: entry.contents.length,
    });
    let failWrites = false;
    let failTruncates = false;
    let writtenLimit = 2;
    const writer = vi.fn(
      (chunk: Buffer, position: number, { handle }: { handle: unknown }) => {
        if (failWrites)
          throw Object.assign(new Error("write failed"), { code: "EIO" });
        const entry = resource(handle);
        const written = Math.min(chunk.length, writtenLimit);
        if (written > 0) {
          const contents = Buffer.alloc(
            Math.max(entry.contents.length, position + written),
          );
          entry.contents.copy(contents);
          chunk.copy(contents, position, 0, written);
          entry.contents = contents;
        }
        return written;
      },
    );
    const truncate = vi.fn((size: number, { handle }: { handle: unknown }) => {
      if (failTruncates)
        throw Object.assign(new Error("truncate failed"), { code: "EIO" });
      const entry = resource(handle);
      const contents = Buffer.alloc(size);
      entry.contents.copy(contents);
      entry.contents = contents;
    });
    const synced = vi.fn();
    setup({
      getattr: ({ path: name }) => {
        const entry = entries.get(name);
        return entry && metadata(entry);
      },
      open: ({ path: name }) => entries.get(name),
      fgetattr: ({ handle }) => metadata(resource(handle)),
      readFile: ({ path: name }) => {
        const entry = entries.get(name);
        if (!entry)
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return entry.contents;
      },
      write: writer,
      ftruncate: truncate,
      fsync: synced,
      unlink: ({ path: name }) => {
        entries.delete(name);
      },
      rename: ({ path: from, destinationPath: to }) => {
        const moved = entries.get(from);
        if (!moved) throw new Error("Missing resource");
        entries.set(to, moved);
        entries.delete(from);
      },
    });
    const first = await open();
    const second = await open();
    if (mutation === "unlink")
      await success((cb) => operations.unlink("/data", cb));
    else await success((cb) => operations.rename("/replacement", "/data", cb));
    await write(first, "XYZ", 1);
    expect(original.contents.toString()).toBe("OXYGINAL");
    expect(await read(second, 20)).toEqual(original.contents);
    await write(second, "END", 10);
    expect(original.contents).toEqual(Buffer.from("OXYGINAL\0\0EN"));
    expect(await read(first, 20)).toEqual(original.contents);
    writtenLimit = 0;
    await write(first, "ignored", 100);
    expect(original.contents.length).toBe(12);
    expect(
      await value<FuseStat>((cb) => operations.fgetattr("/data", first, cb)),
    ).toMatchObject({ size: 12 });
    for (const size of [4, 8]) {
      await success((cb) => operations.ftruncate("/data", second, size, cb));
      expect(original.contents.length).toBe(size);
      expect(await read(first, 20)).toEqual(original.contents);
    }
    failWrites = failTruncates = true;
    await expect(write(first, "ignored")).rejects.toThrow("-5");
    await expect(
      success((cb) => operations.ftruncate("/data", first, 0, cb)),
    ).rejects.toThrow("-5");
    expect(await read(second, 20)).toEqual(Buffer.from("OXYG\0\0\0\0"));
    await success((cb) => operations.fsync("/data", false, first, cb));
    expect(synced).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ handle: original }),
    );
    expect(writer).toHaveBeenCalledTimes(4);
    expect(truncate).toHaveBeenCalledTimes(3);
    if (mutation === "replace")
      expect((await read(await open(), 20)).toString()).toBe("NEW");
    else await expect(open()).rejects.toThrow("-2");
  },
);

it("rejects unsupported retained mixed-writer truncation instead of acknowledging a snapshot-only change", async () => {
  const original = { contents: Buffer.from("ORIGINAL") };
  const truncate = vi.fn();
  setup({
    getattr: () => ({ kind: "file", size: original.contents.length }),
    open: () => original,
    readFile: () => original.contents,
    write: () => 0,
    truncate,
    unlink: () => undefined,
  });
  const fd = await open();
  await success((cb) => operations.unlink("/data", cb));
  await expect(
    success((cb) => operations.ftruncate("/data", fd, 0, cb)),
  ).rejects.toThrow("-95");
  expect(truncate).not.toHaveBeenCalled();
  expect((await read(fd, 20)).toString()).toBe("ORIGINAL");
});

it("supports positional-only truncation and open-file removal without readFile", async () => {
  let contents = Buffer.from("abcdef");
  const unlink = vi.fn();
  const provider = {
    getattr: () => ({ kind: "file" as const, size: contents.length }),
    read: (position: number, length: number) =>
      contents.subarray(position, position + length),
    write: (value: Buffer, position: number) => value.copy(contents, position),
    truncate: (size: number) => {
      contents = contents.subarray(0, size);
    },
    unlink,
  };
  setup(provider);
  const fd = await open();
  await success((cb) => operations.ftruncate("/data", fd, 4, cb));
  expect(contents.toString()).toBe("abcd");
  await success((cb) => operations.unlink("/data", cb));
  expect(unlink).toHaveBeenCalledOnce();
  contents = Buffer.from("new!");
  await write(fd, "X");
  expect((await read(fd, 4)).toString()).toBe("Xbcd");
  expect(contents.toString()).toBe("new!");
});

it("preserves a positional provider's stable per-open object after replacement", async () => {
  type Resource = { contents: Buffer };
  const resources = new Map<string, Resource>([
    ["data", { contents: Buffer.from("OLD") }],
    ["replacement", { contents: Buffer.from("NEW") }],
  ]);
  const resource = (handle: unknown): Resource => {
    if (
      !handle ||
      typeof handle !== "object" ||
      !("contents" in handle) ||
      !Buffer.isBuffer(handle.contents)
    ) {
      throw new Error("Invalid resource handle");
    }
    return { contents: handle.contents };
  };
  setup({
    getattr: ({ path: name }) => ({
      kind: "file",
      size: resources.get(name)?.contents.length ?? 0,
    }),
    open: ({ path: name }) => resources.get(name),
    read: (position, length, { handle }) =>
      resource(handle).contents.subarray(position, position + length),
    write: (value, position, { handle }) =>
      value.copy(resource(handle).contents, position),
    rename: ({ path: from, destinationPath: to }) => {
      const moved = resources.get(from);
      if (!moved) throw new Error("Missing resource");
      resources.set(to, moved);
      resources.delete(from);
    },
  });
  const fd = await open();
  await success((cb) => operations.rename("/replacement", "/data", cb));
  await write(fd, "X");
  expect((await read(fd, 3)).toString()).toBe("XLD");
  expect(resources.get("data")?.contents.toString()).toBe("NEW");
});

it("rejects a parent rename that would switch an open descendant's provider", async () => {
  await mkdir(path.join(source, "before"));
  const release = vi.fn();
  setup(
    {
      getattr: () => ({ kind: "file", size: 3 }),
      open: () => "original handle",
      readFile: () => "old",
      release,
    },
    {
      rules: [
        { match: "before/*.txt", provider: { module: "first" } },
        { match: "after/*.txt", provider: { module: "second" } },
      ],
    },
  );
  const fd = await open("/before/data.txt");
  await expect(
    success((cb) => operations.rename("/before", "/after", cb)),
  ).rejects.toThrow("-18");
  await success((cb) => operations.release("/unused", fd, cb));
  openHandles.delete(fd);
  expect(release).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "before/data.txt",
      handle: "original handle",
    }),
  );
});

it("reports acknowledged whole-file buffered extensions before flushing", async () => {
  let contents = Buffer.alloc(0);
  setup({
    getattr: () => ({ kind: "file", size: contents.length }),
    readFile: () => contents,
    writeFile: (next) => {
      contents = Buffer.from(next);
    },
  });
  const fd = await open();
  await write(fd, "hello");
  const metadata = await value<FuseStat>((cb) =>
    operations.getattr("/data", cb),
  );
  expect(metadata.size).toBe(5);
  expect(contents.length).toBe(0);
});

it("reports a created positional file's size before its creating handle closes", async () => {
  let contents = Buffer.alloc(0);
  setup({
    getattr: () => ({ kind: "file", size: contents.length }),
    create: () => undefined,
    write: (next) => {
      contents = Buffer.from(next);
      return next.length;
    },
    read: (position, length) => contents.subarray(position, position + length),
  });
  const fd = await value<number>((cb) =>
    operations.create("/data", 0o644, 2, cb),
  );
  openHandles.add(fd);
  await write(fd, "hello");
  expect(
    (await value<FuseStat>((cb) => operations.getattr("/data", cb))).size,
  ).toBe(5);
  expect((await read(fd, 5)).toString()).toBe("hello");
});

it("releases acquired resources if metadata fails before create returns a descriptor", async () => {
  const release = vi.fn();
  setup({
    create: () => ({ id: "resource" }),
    getattr: () => {
      throw Object.assign(new Error("metadata failed"), { code: "EACCES" });
    },
    release,
  });
  await expect(
    value<number>((cb) => operations.create("/data", 0o644, 2, cb)),
  ).rejects.toThrow("-13");
  expect(release).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ handle: { id: "resource" } }),
  );
});

it("does not allocate or retain full buffers for completed handleless source truncations", async () => {
  const allocation = vi.spyOn(Buffer, "alloc");
  for (let index = 0; index < 16; index++) {
    const name = `retention-${String(index)}`;
    await writeFile(path.join(source, name), "");
    await success((cb) => operations.truncate(`/${name}`, 1024 * 1024, cb));
  }
  expect(
    allocation.mock.calls.filter(([size]) => size >= 1024 * 1024),
  ).toHaveLength(0);
});

it("ftruncates a stable positional resource rather than its replacement", async () => {
  const original = { contents: Buffer.from("ORIGINAL") };
  let current = original;
  setup({
    getattr: () => ({ kind: "file", size: current.contents.length }),
    open: () => original,
    read: (position, length) =>
      original.contents.subarray(position, position + length),
    ftruncate: (size, { handle }) => {
      expect(handle).toBe(original);
      original.contents = original.contents.subarray(0, size);
    },
    truncate: () => {
      throw new Error("Must not truncate by pathname");
    },
  });
  const fd = await open();
  current = { contents: Buffer.from("REPLACEMENT") };
  await success((cb) => operations.ftruncate("/data", fd, 3, cb));
  expect((await read(fd, 3)).toString()).toBe("ORI");
  expect(current.contents.toString()).toBe("REPLACEMENT");
});

it.each(["content", "explicit", "zero", "unbounded"] as const)(
  "captures post-O_TRUNC metadata on stable resources with %s size policy",
  async (sizeMode) => {
    const resource = { contents: Buffer.from("abcdef") };
    setup({
      getattr: () => ({
        kind: "file",
        size: resource.contents.length,
        sizeMode,
      }),
      open: () => resource,
      read: (position, length) =>
        resource.contents.subarray(position, position + length),
      write: (contents, position) => {
        const next = Buffer.alloc(
          Math.max(resource.contents.length, position + contents.length),
        );
        resource.contents.copy(next);
        contents.copy(next, position);
        resource.contents = next;
        return contents.length;
      },
      ftruncate: (size) => {
        resource.contents = resource.contents.subarray(0, size);
      },
    });
    const first = await open();
    const second = await open("/data", 2 | 0x200);
    for (const fd of [first, second])
      expect(
        await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
      ).toMatchObject({ size: sizeMode === "unbounded" ? 6 : 0 });
    await write(second, "X");
    for (const fd of [first, second])
      expect(
        await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
      ).toMatchObject({
        size: sizeMode === "zero" ? 0 : sizeMode === "unbounded" ? 6 : 1,
      });
  },
);

it.each(["fsync", "flush", "access", "open"] as const)(
  "reports provider ENOSYS from %s without disabling the operation mount-wide",
  async (operation) => {
    setup({
      getattr: () => ({ kind: "file", size: 0 }),
      [operation]: () => {
        throw Object.assign(new Error("unsupported"), { code: "ENOSYS" });
      },
    });
    if (operation === "open") {
      await expect(open()).rejects.toThrow("-95");
    } else if (operation === "access") {
      await expect(
        success((cb) => operations.access("/data", 0, cb)),
      ).rejects.toThrow("-95");
    } else {
      const fd = await open();
      const pending =
        operation === "fsync"
          ? success((cb) => operations.fsync("/data", false, fd, cb))
          : flush(fd);
      await expect(pending).rejects.toThrow("-95");
    }
  },
);

it.each([
  ["ENOSPC", -28],
  ["EDQUOT", -122],
  ["EFBIG", -27],
  ["ELOOP", -40],
  ["EMFILE", -24],
  ["ENFILE", -23],
  ["ENOMEM", -12],
  ["EINTR", -4],
  ["EAGAIN", -11],
  ["ENAMETOOLONG", -36],
  ["ERANGE", -34],
  ["ETIMEDOUT", -110],
])(
  "preserves the binding's %s errno across provider operations",
  async (code, errno) => {
    const failure = () => {
      throw Object.assign(new Error(code), { code });
    };
    setup({
      getattr: () => ({ kind: "file", size: 0 }),
      write: failure,
      fsync: failure,
      mkdir: failure,
    });
    const fd = await open();
    await expect(write(fd, "X")).rejects.toThrow(String(errno));
    await expect(
      success((cb) => operations.fsync("/data", false, fd, cb)),
    ).rejects.toThrow(String(errno));
    await expect(
      success((cb) => operations.mkdir("/directory", 0o755, cb)),
    ).rejects.toThrow(String(errno));
  },
);

it("logs unknown provider errors and returns EIO", async () => {
  const error = Object.assign(new Error("unknown"), { code: "EUNKNOWN" });
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  setup({
    getattr: () => ({ kind: "file", size: 0 }),
    write: () => {
      throw error;
    },
  });
  await expect(write(await open(), "X")).rejects.toThrow("-5");
  expect(logged).toHaveBeenCalledExactlyOnceWith(error);
});

it.each([false, true])(
  "writes a zero-sized sink without reading it (read callback present: %s)",
  async (hasReader) => {
    const reader = vi.fn(() => {
      throw Object.assign(new Error("write only"), { code: "EACCES" });
    });
    const writer = vi.fn();
    setup({
      getattr: () => ({
        kind: "file",
        mode: 0o200,
        size: 0,
        sizeMode: "zero",
      }),
      ...(hasReader ? { readFile: reader } : {}),
      writeFile: writer,
    });
    const fd = await open("/data", 1);
    await write(fd, "run");
    await flush(fd);
    expect(writer).toHaveBeenCalledExactlyOnceWith(
      Buffer.from("run"),
      expect.objectContaining({ previousContents: Buffer.alloc(0) }),
    );
    expect(reader).not.toHaveBeenCalled();
  },
);

it.each(["zero", "explicit"] as const)(
  "resets clean %s-sized sink buffers across already-open writers",
  async (sizeMode) => {
    const timestamp = new Date(0);
    const reader = vi.fn(() => {
      throw Object.assign(new Error("write only"), { code: "EACCES" });
    });
    const writer = vi.fn();
    setup({
      getattr: () => ({
        kind: "file",
        mode: 0o200,
        size: 0,
        sizeMode,
        atime: timestamp,
        mtime: timestamp,
        ctime: timestamp,
        birthtime: timestamp,
      }),
      readFile: reader,
      writeFile: writer,
    });
    const first = await open("/data", 1);
    const second = await open("/data", 1);
    await write(first, "long-");
    await write(second, "command", 5);
    await flush(first);
    await write(second, "x");
    await success((cb) => operations.fsync("/data", false, second, cb));
    await write(first, "y");
    await write(second, "z", 1);
    await flush(second);
    expect(writer).toHaveBeenCalledTimes(3);
    for (const [index, contents] of ["long-command", "x", "yz"].entries())
      expect(writer).toHaveBeenNthCalledWith(
        index + 1,
        Buffer.from(contents),
        expect.objectContaining({ previousContents: Buffer.alloc(0) }),
      );
    expect(reader).not.toHaveBeenCalled();
  },
);

it("preserves pending command bytes after a failed flush", async () => {
  const writer = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("write failed"), { code: "EIO" }),
    )
    .mockResolvedValue(undefined);
  setup({
    getattr: () => ({ kind: "file", size: 0, sizeMode: "zero" }),
    writeFile: writer,
  });
  const first = await open("/data", 1);
  const second = await open("/data", 1);
  await write(first, "long-");
  await expect(flush(first)).rejects.toThrow("-5");
  await write(second, "command", 5);
  await flush(second);
  expect(writer).toHaveBeenLastCalledWith(
    Buffer.from("long-command"),
    expect.objectContaining({ previousContents: Buffer.alloc(0) }),
  );
});

it.each(["flush", "fsync", "timer"] as const)(
  "does not pad sequential zero-sized sinks after %s",
  async (operation) => {
    const writer = vi.fn<(contents: Buffer) => void>();
    setup({
      getattr: () => ({
        kind: "file",
        size: 0,
        sizeMode: "zero",
        seekable: false,
      }),
      writeFile: writer,
    });
    const fd = await open("/data", 1);
    if (operation === "timer") vi.useFakeTimers();
    try {
      const persist = async (): Promise<void> => {
        if (operation === "timer") await vi.advanceTimersByTimeAsync(500);
        else if (operation === "fsync")
          await success((cb) => operations.fsync("/data", false, fd, cb));
        else await flush(fd);
      };
      await write(fd, "one");
      await persist();
      await expect(write(fd, "wrong", 0)).rejects.toThrow("-29");
      await write(fd, "t", 3);
      await write(fd, "wo", 4);
      await persist();
      expect(writer.mock.calls.map(([contents]) => contents)).toEqual([
        Buffer.from("one"),
        Buffer.from("two"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("retains sequential sink chunks after failed flushes and combines open writers", async () => {
  const writer = vi
    .fn<(contents: Buffer) => Promise<void>>()
    .mockRejectedValueOnce(Object.assign(new Error("failed"), { code: "EIO" }))
    .mockResolvedValue(undefined);
  setup({
    getattr: () => ({
      kind: "file",
      size: 0,
      sizeMode: "zero",
      seekable: false,
    }),
    writeFile: writer,
  });
  const first = await open("/data", 1);
  const second = await open("/data", 1);
  await write(first, "one");
  await expect(flush(first)).rejects.toThrow("-5");
  await write(first, "-two", 3);
  await write(second, "-three");
  await flush(second);
  await write(first, "four", 7);
  await flush(first);
  expect(writer.mock.calls.map(([contents]) => contents)).toEqual([
    Buffer.from("one"),
    Buffer.from("one-two-three"),
    Buffer.from("four"),
  ]);
});

it("preserves finite sequential file offsets before and after the empty file is persisted", async () => {
  let contents = Buffer.alloc(0);
  setup({
    getattr: () => ({
      kind: "file",
      size: contents.length,
      sizeMode: "explicit",
      seekable: false,
    }),
    readFile: () => contents,
    writeFile: (next) => {
      contents = Buffer.from(next);
    },
  });
  const first = await open("/data", 1);
  const second = await open("/data", 1);
  await write(first, "one");
  await write(second, "X");
  await flush(second);
  expect(contents.toString()).toBe("Xne");
  await write(second, "Y", 1);
  await flush(second);
  expect(contents.toString()).toBe("XYe");
  await write(first, "two", 3);
  await flush(first);
  expect(contents.toString()).toBe("XYetwo");
});

it("does not discard unreadable nonempty contents when buffering a partial write", async () => {
  const writer = vi.fn();
  setup({
    getattr: () => ({ kind: "file", size: 4 }),
    writeFile: writer,
  });
  const fd = await open("/data", 1);
  await expect(write(fd, "X")).rejects.toThrow("-2");
  expect(writer).not.toHaveBeenCalled();
});

it("reports symlink type and returns the link target", async () => {
  await mkdir(path.join(source, "directory"));
  await symlink("directory", path.join(source, "link"));
  const metadata = await value<FuseStat>((cb) =>
    operations.getattr("/link", cb),
  );
  expect(metadata.mode & 0o170000).toBe(0o120000);
  expect(await value<string>((cb) => operations.readlink("/link", cb))).toBe(
    "directory",
  );
});

it("rejects read-only writes and invalid handles", async () => {
  await writeFile(path.join(source, "data"), "abc");
  const fd = await open("/data", 0);
  await expect(write(fd, "X")).rejects.toThrow("-9");
  await expect(flush(12345)).rejects.toThrow("-9");
  await expect(open("/missing")).rejects.toThrow("-2");
});

it("does not deliver empty command writes for truncate or close", async () => {
  const writeFileCallback = vi.fn();
  setup({
    getattr: () => ({ kind: "file", size: 0 }),
    readFile: () => "generated read contents",
    writeFile: writeFileCallback,
  });
  await success((cb) => operations.truncate("/data", 0, cb));
  const fd = await open();
  await flush(fd);
  expect(writeFileCallback).not.toHaveBeenCalled();
  await write(fd, "run");
  await flush(fd);
  expect(writeFileCallback).toHaveBeenCalledExactlyOnceWith(
    Buffer.from("run"),
    expect.anything(),
  );
});

it("reports native descriptor metadata after replacement by a shorter file", async () => {
  await writeFile(path.join(source, "data"), "ABCDEF");
  const fd = await open();
  await writeFile(path.join(source, "replacement"), "XY");
  await rename(path.join(source, "replacement"), path.join(source, "data"));
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
  ).toMatchObject({ size: 6 });
  expect((await read(fd, 6)).toString()).toBe("ABCDEF");
  await success((cb) => operations.ftruncate("/data", fd, 4, cb));
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
  ).toMatchObject({ size: 4 });
  expect(
    await value<FuseStat>((cb) => operations.getattr("/data", cb)),
  ).toMatchObject({ size: 2 });
});

it("uses provider resource metadata and preserves detached snapshot metadata", async () => {
  const resource = { contents: Buffer.from("ABCDEF") };
  let current = Buffer.from("ABCDEF");
  const fgetattr = vi.fn(() => ({
    kind: "file" as const,
    size: resource.contents.length,
  }));
  setup({
    getattr: () => ({ kind: "file", size: current.length }),
    open: () => resource,
    fgetattr,
    read: (position, length) =>
      resource.contents.subarray(position, position + length),
  });
  const fd = await open();
  current = Buffer.from("XY");
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
  ).toMatchObject({ size: 6 });
  expect(fgetattr).toHaveBeenCalledWith(
    expect.objectContaining({ handle: resource }),
  );
  expect((await read(fd, 6)).toString()).toBe("ABCDEF");
});

it("refreshes captured attributes on all handles sharing a provider resource", async () => {
  const resource = {};
  setup({
    getattr: () => ({ kind: "file", mode: 0o644, size: 0 }),
    open: () => resource,
    fsetattr: () => undefined,
  });
  const first = await open();
  const second = await open();
  await success((cb) =>
    operations.fsetattr(
      "/data",
      second,
      { mode: 0o100600, uid: 123 },
      false,
      cb,
    ),
  );
  for (const fd of [first, second]) {
    const metadata = await value<FuseStat>((cb) =>
      operations.fgetattr("/data", fd, cb),
    );
    expect(metadata.mode & 0o7777).toBe(0o600);
    expect(metadata.uid).toBe(123);
  }
});

it("captures native metadata after acquisition rather than before an open callback", async () => {
  await writeFile(path.join(source, "data"), "ORIGINAL");
  setup(
    {
      getattr: async ({ sourcePath }) => ({
        kind: "file",
        size: (await stat(sourcePath)).size,
      }),
      open: async ({ sourcePath }) => {
        await writeFile(sourcePath, "EXPANDED CONTENT");
      },
    },
    { rules: [{ match: "data", provider: { module: "memory" } }] },
  );
  const fd = await open();
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
  ).toMatchObject({ size: 16 });
  expect((await read(fd, 32)).toString()).toBe("EXPANDED CONTENT");
});

it("captures native directory metadata after acquisition and applies descriptor changes", async () => {
  await mkdir(path.join(source, "data"), { mode: 0o755 });
  setup(
    {
      getattr: async ({ sourcePath }) => ({
        kind: "directory",
        mode: (await stat(sourcePath)).mode & 0o7777,
      }),
      opendir: async ({ sourcePath }) => {
        await chmod(sourcePath, 0o700);
      },
    },
    { rules: [{ match: "data", provider: { module: "memory" } }] },
  );
  const fd = await value<number>((cb) => operations.opendir("/data", 0, cb));
  try {
    expect(
      (await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)))
        .mode & 0o7777,
    ).toBe(0o700);
    await success((cb) =>
      operations.fsetattr("/data", fd, { mode: 0o600 }, false, cb),
    );
    expect(
      (await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)))
        .mode & 0o7777,
    ).toBe(0o600);
  } finally {
    await success((cb) => operations.releasedir("/data", fd, cb));
  }
});

it.each(["metadata", "defaults"] as const)(
  "updates captured native sizes and attributes from %s across shared handles",
  async (sizeFrom) => {
    await writeFile(path.join(source, "data"), "ORIGINAL");
    setup(
      {
        getattr: async ({ sourcePath }) => ({
          kind: "file",
          ...(sizeFrom === "metadata"
            ? { size: (await stat(sourcePath)).size }
            : {}),
          mode: 0o750,
          mtime: new Date(1_000),
        }),
      },
      {
        rules: [
          {
            match: "data",
            provider: { module: "memory" },
            ...(sizeFrom === "defaults" ? { file: { size: 8 } } : {}),
          },
        ],
      },
    );
    const first = await open();
    const second = await open();
    const initial = await value<FuseStat>((cb) =>
      operations.fgetattr("/data", first, cb),
    );
    expect(initial).toMatchObject({ size: 8, mtime: new Date(1_000) });
    expect(initial.mode & 0o7777).toBe(0o750);
    const expectSize = async (size: number): Promise<void> => {
      for (const fd of [first, second])
        expect(
          await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
        ).toMatchObject({ ino: initial.ino, size });
    };
    await success((cb) => operations.ftruncate("/data", first, 0, cb));
    await expectSize(0);
    await write(second, "EXPANDED CONTENT");
    await expectSize(16);
    expect((await read(first, 32)).toString()).toBe("EXPANDED CONTENT");
    await success((cb) => operations.truncate("/data", 4, cb));
    await expectSize(4);
    await success((cb) =>
      operations.fsetattr(
        "/data",
        second,
        { mode: 0o600, mtime: new Date(2_000) },
        false,
        cb,
      ),
    );
    for (const fd of [first, second]) {
      const metadata = await value<FuseStat>((cb) =>
        operations.fgetattr("/data", fd, cb),
      );
      expect(metadata.mode & 0o7777).toBe(0o600);
      expect(metadata.mtime).toEqual(new Date(2_000));
    }
    await rename(path.join(source, "data"), path.join(source, "retained"));
    await writeFile(path.join(source, "data"), "NEW");
    await expectSize(4);
    expect((await read(first, 32)).toString()).toBe("EXPA");
    await write(second, "RETAINED CONTENT");
    await expectSize(16);
    expect(await readFile(path.join(source, "data"), "utf8")).toBe("NEW");
  },
);

it.each(["zero", "unbounded"] as const)(
  "preserves the %s policy of captured native size overrides",
  async (sizeMode) => {
    await writeFile(path.join(source, "data"), "ORIGINAL");
    setup(
      { getattr: () => ({ kind: "file", size: 8, sizeMode }) },
      { rules: [{ match: "data", provider: { module: "memory" } }] },
    );
    const fd = await open();
    await success((cb) => operations.ftruncate("/data", fd, 0, cb));
    await write(fd, "X");
    expect(
      await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
    ).toMatchObject({ size: sizeMode === "zero" ? 0 : 8 });
  },
);

it("keeps explicit native fgetattr callbacks authoritative after writes", async () => {
  await writeFile(path.join(source, "data"), "ORIGINAL");
  setup(
    {
      getattr: () => ({ kind: "file", size: 8 }),
      fgetattr: () => ({ kind: "file", size: 23 }),
    },
    { rules: [{ match: "data", provider: { module: "memory" } }] },
  );
  const fd = await open();
  await write(fd, "X");
  expect(
    await value<FuseStat>((cb) => operations.fgetattr("/data", fd, cb)),
  ).toMatchObject({ size: 23 });
});

it.each(
  (["file", "directory"] as const).flatMap((kind) =>
    [
      "unchanged",
      "replace",
      "remove",
      ...(kind === "file" ? ["alias"] : []),
    ].map((change) => ({ kind, change })),
  ),
)(
  "checks handleless $kind identity before metadata changes after $change",
  async ({ kind, change }) => {
    const original: NodeMetadata = { kind, identity: "original", mode: 0o755 };
    const replacement: NodeMetadata = {
      kind,
      identity: "replacement",
      mode: 0o755,
    };
    const entries = new Map([["data", original]]);
    const fsetattr = vi.fn<NonNullable<ScriptFsProvider["fsetattr"]>>(
      (changes, { path: name }) => {
        const metadata = entries.get(name);
        if (!metadata)
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        Object.assign(metadata, changes);
      },
    );
    setup({ getattr: ({ path: name }) => entries.get(name), fsetattr });
    const fd =
      kind === "file"
        ? await open()
        : await value<number>((cb) => operations.opendir("/data", 0, cb));
    try {
      if (change === "alias") {
        entries.set("alias", original);
        await value<FuseStat>((cb) => operations.getattr("/alias", cb));
      }
      if (change === "remove") entries.delete("data");
      else if (change !== "unchanged") entries.set("data", replacement);
      const changing = success((cb) =>
        operations.fsetattr(
          "/data",
          fd,
          { mode: 0o700 },
          change !== "unchanged",
          cb,
        ),
      );
      if (change === "unchanged" || change === "alias") {
        await changing;
        expect(original.mode).toBe(0o700);
        expect(fsetattr).toHaveBeenCalledOnce();
      } else {
        await expect(changing).rejects.toThrow("-116");
        expect(original.mode).toBe(0o755);
        expect(fsetattr).not.toHaveBeenCalled();
      }
      expect(replacement.mode).toBe(0o755);
    } finally {
      if (kind === "directory")
        await success((cb) => operations.releasedir("/data", fd, cb));
    }
  },
);

it.each([true, false])(
  "shares captured attributes across distinct open resources only with a stable identity (%s)",
  async (identified) => {
    setup({
      getattr: () => ({
        kind: "file",
        ...(identified ? { identity: "shared" } : {}),
        mode: 0o644,
        size: 0,
      }),
      open: () => ({}),
      fsetattr: () => undefined,
    });
    const first = await open();
    const second = await open();
    const changes = {
      mode: 0o100600,
      uid: 123,
      gid: 456,
      atime: new Date(1000),
      mtime: new Date(2000),
    };
    await success((cb) =>
      operations.fsetattr("/data", second, changes, false, cb),
    );
    expect(
      await value<FuseStat>((cb) => operations.fgetattr("/data", second, cb)),
    ).toMatchObject(changes);
    await success((cb) => operations.release("/data", second, cb));
    openHandles.delete(second);
    const retained = await value<FuseStat>((cb) =>
      operations.fgetattr("/data", first, cb),
    );
    if (identified) expect(retained).toMatchObject(changes);
    else expect(retained.mode & 0o7777).toBe(0o644);
  },
);

it.each(["ftruncate", "fsetattr"] as const)(
  "checks path-based %s overrides even when native I/O retains a descriptor",
  async (operation) => {
    const ftruncate = vi.fn<NonNullable<ScriptFsProvider["ftruncate"]>>(
      (size, { sourcePath }) => truncateNative(sourcePath, size),
    );
    const fsetattr = vi.fn<NonNullable<ScriptFsProvider["fsetattr"]>>(
      async (changes, { sourcePath }) => {
        if (changes.mode !== undefined) await chmod(sourcePath, changes.mode);
      },
    );
    setup(
      { ftruncate, fsetattr },
      { rules: [{ match: "**", provider: { module: "test" } }] },
    );
    await writeFile(path.join(source, "data"), "ORIGINAL");
    const fd = await open();
    await writeFile(path.join(source, "replacement"), "NEW");
    await chmod(path.join(source, "replacement"), 0o644);
    await rename(path.join(source, "replacement"), path.join(source, "data"));
    await expect(
      success((cb) => {
        if (operation === "ftruncate") operations.ftruncate("/data", fd, 0, cb);
        else operations.fsetattr("/data", fd, { mode: 0o600 }, true, cb);
      }),
    ).rejects.toThrow("-116");
    expect(ftruncate).not.toHaveBeenCalled();
    expect(fsetattr).not.toHaveBeenCalled();
    expect((await read(fd, 8)).toString()).toBe("ORIGINAL");
    expect(await readFile(path.join(source, "data"), "utf8")).toBe("NEW");
    expect((await stat(path.join(source, "data"))).mode & 0o777).toBe(0o644);
  },
);

it.each([
  { operation: "rmdir", identified: false },
  { operation: "rmdir", identified: true },
  { operation: "replace", identified: false },
  { operation: "replace", identified: true },
] as const)(
  "retains virtual directory metadata through $operation with identity=$identified",
  async ({ operation, identified }) => {
    const entries = new Map<string, NodeMetadata>([
      [
        "old",
        {
          kind: "directory",
          mode: 0o755,
          ...(identified ? { identity: "old" } : {}),
        },
      ],
      [
        "replacement",
        {
          kind: "directory",
          mode: 0o700,
          ...(identified ? { identity: "new" } : {}),
        },
      ],
    ]);
    let failRemoval = true;
    setup({
      getattr: ({ path: name }) => entries.get(name),
      readdir: () => [],
      rmdir: ({ path: name }) => {
        if (failRemoval)
          throw Object.assign(new Error("busy"), { code: "ENOTEMPTY" });
        entries.delete(name);
      },
      mkdir: (metadata, { path: name }) => {
        entries.set(name, metadata);
      },
      rename: ({ path: name, destinationPath }) => {
        const metadata = entries.get(name);
        if (!metadata) throw new Error("Missing source directory");
        entries.delete(name);
        entries.set(destinationPath, metadata);
      },
    });
    const fd = await value<number>((cb) => operations.opendir("/old", 0, cb));
    try {
      if (operation === "rmdir") {
        await expect(
          success((cb) => operations.rmdir("/old", cb)),
        ).rejects.toThrow("-39");
        expect(
          await value<FuseStat>((cb) => operations.fgetattr("/old", fd, cb)),
        ).toMatchObject({ nlink: 2 });
        failRemoval = false;
        await success((cb) => operations.rmdir("/old", cb));
        await success((cb) => operations.mkdir("/old", 0o700, cb));
      } else {
        await success((cb) => operations.rename("/replacement", "/old", cb));
      }
      expect(
        await value<FuseStat>((cb) => operations.getattr("/old", cb)),
      ).toMatchObject({ mode: 0o040700 });
      expect(
        await value<FuseStat>((cb) => operations.fgetattr("/old", fd, cb)),
      ).toMatchObject({
        mode: 0o040755,
        nlink: 0,
      });
      const replacement = await value<number>((cb) =>
        operations.opendir("/old", 0, cb),
      );
      try {
        expect(
          await value<FuseStat>((cb) =>
            operations.fgetattr("/old", replacement, cb),
          ),
        ).toMatchObject({
          mode: 0o040700,
          nlink: 2,
        });
      } finally {
        await success((cb) => operations.releasedir("/old", replacement, cb));
      }
    } finally {
      await success((cb) => operations.releasedir("/old", fd, cb));
    }
  },
);

it.each([0, 3, 9])(
  "persists ordinary whole-file truncation to %i bytes across fsync and reopen",
  async (size) => {
    let contents = Buffer.from("abcdef");
    const written = vi.fn((next: Buffer) => {
      contents = Buffer.from(next);
    });
    setup({
      getattr: () => ({ kind: "file", size: contents.length }),
      readFile: () => contents,
      writeFile: written,
    });
    const fd = await open();
    await success((cb) => operations.ftruncate("/data", fd, size, cb));
    await success((cb) => operations.fsync("/data", false, fd, cb));
    await success((cb) => operations.release("/data", fd, cb));
    openHandles.delete(fd);
    const expected = Buffer.alloc(size);
    Buffer.from("abcdef").copy(expected, 0, 0, Math.min(size, 6));
    expect(contents).toEqual(expected);
    expect(await read(await open(), size)).toEqual(expected);
    expect(written).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "keeps mixed I/O coherent with partial writes and O_TRUNC (readFile: %s)",
  async (hasReadFile) => {
    let contents = Buffer.from("abcdef");
    setup({
      getattr: () => ({ kind: "file", size: contents.length }),
      read: (position, length) =>
        contents.subarray(position, position + length),
      ...(hasReadFile ? { readFile: () => contents } : {}),
      writeFile: (next) => {
        contents = Buffer.from(next);
      },
    });
    const first = await open();
    await write(first, "Y");
    expect((await read(first, 6)).toString()).toBe("Ybcdef");
    await flush(first);
    const second = await open("/data", 2 | 0x200);
    await write(second, "X");
    expect((await read(second, 6)).toString()).toBe("X");
    await success((cb) => operations.fsync("/data", false, second, cb));
    expect(contents.toString()).toBe("X");
    expect((await read(await open(), 6)).toString()).toBe("X");
  },
);

it("assembles short positional reads using retained and temporary provider resources", async () => {
  let contents = Buffer.from("abcdef");
  const opener = vi.fn(() => "resource");
  const release = vi.fn();
  const writer = vi.fn((next: Buffer) => {
    contents = Buffer.from(next);
  });
  setup({
    getattr: () => ({ kind: "file", size: contents.length }),
    fgetattr: () => ({ kind: "file", size: contents.length }),
    open: opener,
    read: (position, length, { handle }) => {
      expect(handle).toBe("resource");
      return contents.subarray(position, position + Math.min(length, 2));
    },
    writeFile: writer,
    release,
  });
  const fd = await open();
  await write(fd, "X", 2);
  expect((await read(fd, 6)).toString()).toBe("abXdef");
  expect(opener).toHaveBeenCalledOnce();
  await flush(fd);
  expect(writer).toHaveBeenLastCalledWith(
    Buffer.from("abXdef"),
    expect.objectContaining({ previousContents: Buffer.from("abcdef") }),
  );
  expect(opener).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
  await success((cb) => operations.ftruncate("/data", fd, 4, cb));
  await flush(fd);
  expect(contents.toString()).toBe("abXd");
});

it.each(
  ["write", "unlink"].flatMap((operation) =>
    ["replace", "remove"].map((change) => ({ operation, change })),
  ),
)(
  "rejects $change while assembling a positional buffer for $operation",
  async ({ operation, change }) => {
    const replacement = {
      identity: "replacement",
      contents: Buffer.from("REPLACED"),
    };
    let current: typeof replacement | undefined = {
      identity: "original",
      contents: Buffer.from("ORIGINAL"),
    };
    const reader = vi.fn((position: number, length: number) => {
      const bytes = current?.contents.subarray(
        position,
        position + Math.min(length, 2),
      );
      if (position === 0)
        current = change === "replace" ? replacement : undefined;
      return bytes ?? Buffer.alloc(0);
    });
    const writer = vi.fn();
    const remove = vi.fn(() => {
      current = undefined;
    });
    setup({
      getattr: () =>
        current && {
          kind: "file",
          identity: current.identity,
          size: current.contents.length,
        },
      read: reader,
      writeFile: writer,
      unlink: remove,
    });
    const fd = await open();
    const result = await new Promise<number>((callback) => {
      if (operation === "write")
        operations.write("/data", fd, Buffer.from("X"), 1, 0, callback);
      else operations.unlink("/data", callback);
    });
    const released = await new Promise<number>((callback) =>
      operations.release("/data", fd, callback),
    );
    openHandles.delete(fd);
    expect(result).toBe(-116);
    expect(released).toBe(0);
    expect(reader).toHaveBeenCalledOnce();
    expect(writer).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(current).toBe(change === "replace" ? replacement : undefined);
  },
);

it.each([false, true])(
  "uses and releases readable resources for write-only mixed I/O (read failure: %s)",
  async (failRead) => {
    const target = path.join(source, "mixed");
    await writeFile(target, "abcdef");
    const resources = new Map<number, FileHandle>();
    const resource = (handle: unknown): FileHandle => {
      const file =
        typeof handle === "number" ? resources.get(handle) : undefined;
      if (!file) throw new Error("Missing retained resource");
      return file;
    };
    const opener = vi.fn(async ({ flags }: { flags: number }) => {
      const file = await openNative(target, flags & 3);
      resources.set(file.fd, file);
      return file.fd;
    });
    const reader = vi.fn(
      async (
        position: number,
        length: number,
        { handle, flags }: { handle: unknown; flags: number },
      ) => {
        expect(flags).toBe(0);
        if (failRead)
          throw Object.assign(new Error("read failed"), { code: "EIO" });
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await resource(handle).read(
          buffer,
          0,
          length,
          position,
        );
        return buffer.subarray(0, bytesRead);
      },
    );
    const writer = vi.fn((contents: Buffer) => writeFile(target, contents));
    const release = vi.fn(async ({ handle }: { handle: unknown }) => {
      const file = resource(handle);
      resources.delete(file.fd);
      await file.close();
    });
    setup({
      getattr: async () => ({
        kind: "file",
        identity: "mixed",
        size: (await stat(target)).size,
      }),
      fgetattr: async ({ handle }) => ({
        kind: "file",
        identity: "mixed",
        size: (await resource(handle).stat()).size,
      }),
      open: opener,
      read: reader,
      writeFile: writer,
      release,
    });
    const fd = await open("/data", 1 | 0x400);
    if (failRead) {
      await expect(write(fd, "X", 6)).rejects.toThrow("-5");
      expect(writer).not.toHaveBeenCalled();
      expect(await readFile(target, "utf8")).toBe("abcdef");
    } else {
      await write(fd, "X", 6);
      await flush(fd);
      expect(await readFile(target, "utf8")).toBe("abcdefX");
    }
    expect(opener.mock.calls[0]?.[0].flags).toBe(1 | 0x400);
    expect(
      opener.mock.calls.slice(1).every(([context]) => context.flags === 0),
    ).toBe(true);
    expect(release).toHaveBeenCalledTimes(opener.mock.calls.length - 1);
    expect(resources.size).toBe(1);
    await success((cb) => operations.release("/data", fd, cb));
    openHandles.delete(fd);
    expect(resources.size).toBe(0);
  },
);

it("snapshots mixed I/O resources before unlink instead of writing to their replacement", async () => {
  let contents = Buffer.from("OLD");
  setup({
    getattr: () => ({ kind: "file", size: contents.length }),
    open: () => contents,
    read: (position, length, { handle }) => {
      if (!Buffer.isBuffer(handle)) throw new Error("Missing resource");
      return handle.subarray(position, position + length);
    },
    writeFile: (next) => {
      contents = Buffer.from(next);
    },
    unlink: () => {
      contents = Buffer.from("NEW");
    },
  });
  const fd = await open();
  await success((cb) => operations.unlink("/data", cb));
  await write(fd, "X");
  await flush(fd);
  expect((await read(fd, 3)).toString()).toBe("XLD");
  expect(contents.toString()).toBe("NEW");
});

it("snapshots write-only mixed resources using a separate reader before unlink", async () => {
  let exists = true;
  const writer = vi.fn();
  const release = vi.fn();
  const opener = vi.fn(() => ({}));
  setup({
    getattr: () =>
      exists ? { kind: "file", identity: "mixed", size: 3 } : undefined,
    open: opener,
    read: (position, length, { flags }) => {
      if ((flags & 3) === 1)
        throw Object.assign(new Error("write-only"), { code: "EBADF" });
      return Buffer.from("ABC").subarray(position, position + length);
    },
    writeFile: writer,
    unlink: () => {
      exists = false;
    },
    release,
  });
  const writerFd = await open("/data", 1);
  const readerFd = await open("/data", 0);
  await success((cb) => operations.unlink("/data", cb));
  expect(opener).toHaveBeenCalledTimes(3);
  expect(release).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ flags: 0 }),
  );
  await write(writerFd, "X");
  await flush(writerFd);
  expect((await read(readerFd, 3)).toString()).toBe("XBC");
  expect(writer).not.toHaveBeenCalled();
});

it.each(["unbounded", "non-seekable"] as const)(
  "rejects whole-file buffering of a %s positional reader",
  async (kind) => {
    const reader = vi.fn(() => Buffer.from("data"));
    const writer = vi.fn();
    setup({
      getattr: () => ({
        kind: "file",
        size: 4,
        sizeMode: kind === "unbounded" ? "unbounded" : "explicit",
        seekable: kind !== "non-seekable",
      }),
      read: reader,
      writeFile: writer,
    });
    const fd = await open();
    await expect(write(fd, "X")).rejects.toThrow("-95");
    expect(reader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  },
);

it("preserves dirty buffered writes when a provider also implements truncate", async () => {
  let contents = Buffer.from("abcdef");
  setup({
    getattr: () => ({ kind: "file", size: contents.length }),
    read: (position, length) => contents.subarray(position, position + length),
    readFile: () => contents,
    writeFile: (next) => {
      contents = Buffer.from(next);
    },
    truncate: (size) => {
      contents = contents.subarray(0, size);
    },
  });
  const fd = await open();
  await write(fd, "X");
  await success((cb) => operations.ftruncate("/data", fd, 3, cb));
  await flush(fd);
  expect(contents.toString()).toBe("Xbc");
});

it("converts native millisecond timestamps to Dates for source and provider operations", async () => {
  await writeFile(path.join(source, "data"), "data");
  await success((cb) => operations.utimens("/data", 100125, 200750, cb));
  expect(await stat(path.join(source, "data"))).toMatchObject({
    atimeMs: 100125,
    mtimeMs: 200750,
  });
  const utimens = vi.fn();
  setup({ utimens });
  await success((cb) => operations.utimens("/data", 100125, 200750, cb));
  expect(utimens).toHaveBeenCalledWith(
    new Date(100125),
    new Date(200750),
    expect.anything(),
  );
});

it("honors non-seekable metadata on created provider files", async () => {
  setup({
    create: () => undefined,
    getattr: () => ({ kind: "file", size: 0, seekable: false }),
    write: (contents) => contents.length,
  });
  const fd = await value<number>((cb) =>
    operations.create("/data", 0o644, 2, cb),
  );
  openHandles.add(fd);
  await expect(write(fd, "X", 1)).rejects.toThrow("-29");
  await write(fd, "X", 0);
});
