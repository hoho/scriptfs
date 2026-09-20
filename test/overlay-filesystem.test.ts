import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  statfs,
  rename as renameHost,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineProvider,
  directoryMetadata,
  fileMetadata,
} from "../src/index.js";
import { OverlayFileSystem } from "../src/overlay/filesystem.js";
import type { ProviderLoader } from "../src/overlay/provider-loader.js";
import { createProviderLoader } from "../src/overlay/provider-loader.js";
import type { ProviderFileDefaults, ScriptFsProvider } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OverlayFileSystem", () => {
  it("checks generated files and synthetic ancestors without requiring source counterparts", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ relativePath }) =>
          relativePath === ""
            ? directoryMetadata()
            : relativePath === "generated"
              ? fileMetadata({ size: 0 })
              : undefined,
      },
      [
        {
          match: "Nested/Deep/**",
          root: "Nested/Deep",
          opaque: true,
          provider: { module: "memory" },
        },
        { match: "generated", provider: { module: "memory" } },
      ],
    );
    await expect(filesystem.access("generated", 0)).resolves.toBeUndefined();
    await expect(filesystem.access("Nested", 1)).resolves.toBeUndefined();
    await expect(filesystem.access("Nested/Deep", 1)).resolves.toBeUndefined();
    await expect(filesystem.access("generated", 1)).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(filesystem.access("missing", 0)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      filesystem.access("Nested/Deep/missing", 0),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(source, "source-only"), "");
    await expect(filesystem.access("source-only", 4)).resolves.toBeUndefined();
  });

  it("reports real source and proxy storage statistics with a source fallback for virtual nodes", async () => {
    const source = await createSource();
    const proxy = await createSource();
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          {
            match: "Proxy/**",
            root: "Proxy",
            provider: { type: "directory", path: proxy },
          },
          {
            match: "Virtual/**",
            root: "Virtual",
            opaque: true,
            provider: { module: "memory" },
          },
        ],
      },
      async (reference) =>
        "module" in reference ? {} : createProviderLoader()(reference),
    );
    for (const [virtualPath, backing] of [
      ["/", source],
      ["Virtual", source],
      ["Proxy", proxy],
    ]) {
      if (!virtualPath || !backing) throw new Error("Missing fixture path");
      const expected = await statfs(backing);
      const actual = await filesystem.statfs(virtualPath);
      expect(actual).toMatchObject({
        bsize: expected.bsize,
        frsize: expected.bsize,
        blocks: expected.blocks,
      });
      expect(actual.files).toBeGreaterThanOrEqual(0);
    }
    await rm(source, { recursive: true });
    await expect(filesystem.statfs("/")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adds generated files to matching real directories", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "components", "Button"), { recursive: true });
    const provider = defineProvider({
      getattr: ({ path: virtualPath }) =>
        virtualPath.endsWith("/AGENTS.md")
          ? fileMetadata({ size: 18 })
          : undefined,
      readFile: ({ path: virtualPath }) => `Instructions for ${virtualPath}`,
    });
    const filesystem = createFilesystem(source, provider, [
      {
        match: "components/*/AGENTS.md",
        provider: { module: "test-provider" },
      },
    ]);

    const entries = await filesystem.readdir("components/Button");

    expect(entries?.map((entry) => entry.name)).toContain("AGENTS.md");
    await expect(
      filesystem.readFile("components/Button/AGENTS.md"),
    ).resolves.toEqual(
      Buffer.from("Instructions for components/Button/AGENTS.md"),
    );
  });

  it("adds exact root-level provider files to the root directory", async () => {
    const source = await createSource();
    const provider = defineProvider({
      getattr: ({ path: virtualPath }) =>
        virtualPath === "ProxiedFile.txt"
          ? fileMetadata({ size: 7 })
          : undefined,
    });
    const filesystem = createFilesystem(source, provider, [
      {
        match: "ProxiedFile.txt",
        provider: { module: "test-provider" },
      },
    ]);

    expect((await filesystem.readdir(""))?.map((entry) => entry.name)).toEqual([
      "ProxiedFile.txt",
    ]);
  });

  it.each([
    ["hello+world.txt", "hello+world.txt"],
    ["user@example.txt", "user@example.txt"],
    ["wow!.txt", "wow!.txt"],
    ["literal{tag}.txt", "literal{tag}.txt"],
    ["escaped\\*.txt", "escaped*.txt"],
    ["back\\\\slash.txt", "back\\slash.txt"],
  ])("enumerates the literal exact rule %s", async (match, name) => {
    const filesystem = createFilesystem(
      await createSource(),
      {
        getattr: ({ path: nameOfPath }) =>
          nameOfPath === name ? fileMetadata({ size: 1 }) : undefined,
        readFile: () => "X",
      },
      [{ match, provider: { module: "memory" } }],
    );
    expect((await filesystem.readdir(""))?.map((entry) => entry.name)).toEqual([
      name,
    ]);
    expect(await filesystem.getattr(name)).toMatchObject({ kind: "file" });
    expect((await filesystem.readFile(name)).toString()).toBe("X");
  });

  it.each(["C++", "team@host", "wow!", "literal{tag}"])(
    "exposes a generated root and correct relative paths for %s/**",
    async (root) => {
      const filesystem = createFilesystem(
        await createSource(),
        {
          getattr: ({ relativePath }) =>
            relativePath === ""
              ? directoryMetadata()
              : relativePath === "data.txt"
                ? fileMetadata({ size: 1 })
                : undefined,
          readdir: ({ relativePath }) =>
            relativePath === "" ? ["data.txt"] : undefined,
          readFile: ({ relativePath }) => {
            expect(relativePath).toBe("data.txt");
            return "X";
          },
        },
        [{ match: `${root}/**`, opaque: true, provider: { module: "memory" } }],
      );
      expect(
        (await filesystem.readdir(""))?.map((entry) => entry.name),
      ).toEqual([root]);
      expect(
        (await filesystem.readdir(root))?.map((entry) => entry.name),
      ).toEqual(["data.txt"]);
      expect((await filesystem.readFile(`${root}/data.txt`)).toString()).toBe(
        "X",
      );
    },
  );

  it("uses source backing consistently when an additive module declines a path", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "Mixed", "native"), { recursive: true });
    await writeFile(path.join(source, "Mixed", "source.txt"), "SOURCE");
    const writer = vi.fn();
    const reader = vi.fn(({ relativePath }: { relativePath: string }) => {
      if (relativePath !== "generated.txt")
        throw Object.assign(new Error("Not generated"), { code: "ENOENT" });
      return "GENERATED";
    });
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ relativePath }) =>
          relativePath === "generated.txt"
            ? fileMetadata({ size: 9 })
            : undefined,
        readdir: ({ relativePath }) =>
          relativePath === "" ? ["generated.txt"] : undefined,
        readFile: reader,
        writeFile: writer,
      },
      [{ match: "Mixed/**", root: "Mixed", provider: { module: "memory" } }],
    );
    expect(
      (await filesystem.readdir("Mixed"))?.map(({ name }) => name).sort(),
    ).toEqual(["generated.txt", "native", "source.txt"]);
    expect((await filesystem.readFile("Mixed/generated.txt")).toString()).toBe(
      "GENERATED",
    );
    reader.mockClear();
    expect((await filesystem.readFile("Mixed/source.txt")).toString()).toBe(
      "SOURCE",
    );
    await filesystem.writeFile("Mixed/source.txt", Buffer.from("UPDATED"));
    const handle = await filesystem.open("Mixed/source.txt", 2);
    expect(handle.native).toBeDefined();
    expect(handle.binding).toBeUndefined();
    try {
      await filesystem.rename("Mixed/source.txt", "Mixed/renamed.txt");
      await filesystem.ftruncate("Mixed/renamed.txt", 3, 2, handle);
      expect(
        (
          await filesystem.readChunk("Mixed/renamed.txt", 0, 3, 2, handle)
        )?.toString(),
      ).toBe("UPD");
    } finally {
      await filesystem.release("Mixed/renamed.txt", 2, handle);
    }
    await filesystem.chmod("Mixed/renamed.txt", 0o600);
    expect(
      (await stat(path.join(source, "Mixed", "renamed.txt"))).mode & 0o777,
    ).toBe(0o600);
    await filesystem.unlink("Mixed/renamed.txt");
    const created = await filesystem.create(
      "Mixed/native/created.txt",
      0o644,
      2,
    );
    await filesystem.release("Mixed/native/created.txt", 2, created);
    expect(
      await readFile(path.join(source, "Mixed", "native", "created.txt")),
    ).toEqual(Buffer.alloc(0));
    await filesystem.mkdir("Mixed/native/created-directory");
    await filesystem.rmdir("Mixed/native/created-directory");
    expect(reader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it("preserves content-only overlays and creation of exact generated entries", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "existing.txt"), "SOURCE");
    const contents = new Map<string, Buffer>();
    const provider: ScriptFsProvider = {
      getattr: ({ path: name }) =>
        contents.has(name)
          ? fileMetadata({ size: contents.get(name)?.length })
          : undefined,
      readFile: ({ path: name }) => contents.get(name) ?? Buffer.alloc(0),
      writeFile: (value, { path: name }) => {
        contents.set(name, Buffer.from(value));
      },
    };
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          { match: "existing.txt", provider: { module: "content-only" } },
          { match: "created.txt", root: "", provider: { module: "generated" } },
        ],
      },
      (reference) =>
        Promise.resolve(
          "module" in reference && reference.module === "content-only"
            ? { readFile: () => "OVERRIDE" }
            : provider,
        ),
    );
    expect((await filesystem.readFile("existing.txt")).toString()).toBe(
      "OVERRIDE",
    );
    const created = await filesystem.create("created.txt", 0o644, 2);
    await filesystem.release("created.txt", 2, created);
    expect(contents.get("created.txt")).toEqual(Buffer.alloc(0));
    await expect(stat(path.join(source, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(
    ["", "x", "source contents longer than the generated file"].flatMap(
      (contents) => [false, true].map((resource) => ({ contents, resource })),
    ),
  )(
    "sizes content-only overlays independently of source '$contents' (resource=$resource)",
    async ({ contents, resource }) => {
      const source = await createSource();
      await writeFile(path.join(source, "data"), contents);
      const native = await lstat(path.join(source, "data"), { bigint: true });
      const generated = "generated \u00e9";
      const filesystem = createFilesystem(
        source,
        {
          readFile: () => generated,
          ...(resource ? { open: () => ({}) } : {}),
        },
        [{ match: "data", provider: { module: "content-only" } }],
      );
      const metadata = await filesystem.getattr("data");
      const expected = {
        kind: "file",
        size: Buffer.byteLength(generated),
        sizeMode: "content",
        seekable: true,
        identity: `native:${String(native.dev)}:${String(native.ino)}:rule:0`,
        mode: Number(native.mode) & 0o7777,
        uid: Number(native.uid),
        gid: Number(native.gid),
        mtime: native.mtime,
      };
      expect(metadata).toMatchObject(expected);
      expect(await filesystem.readdir("")).toMatchObject([
        { name: "data", metadata: expected },
      ]);
      const handle = await filesystem.open("data", 0);
      try {
        expect(
          await filesystem.fgetattr("data", 0, handle, metadata),
        ).toMatchObject(expected);
        expect((await filesystem.readFile("data", handle)).toString()).toBe(
          generated,
        );
      } finally {
        await filesystem.release("data", 0, handle);
      }
    },
  );

  it.each<{
    file: ProviderFileDefaults;
    size: number;
    sizeMode: string;
    reads: number;
  }>([
    { file: { size: 3 }, size: 3, sizeMode: "explicit", reads: 0 },
    {
      file: { sizeMode: "content" },
      size: 9,
      sizeMode: "content",
      reads: 1,
    },
    {
      file: { sizeMode: "zero", seekable: false },
      size: 0,
      sizeMode: "zero",
      reads: 0,
    },
    {
      file: { sizeMode: "unbounded" },
      size: 0x7fff_ffff_ffff,
      sizeMode: "unbounded",
      reads: 0,
    },
    {
      file: { sizeMode: "unbounded", size: 123 },
      size: 123,
      sizeMode: "unbounded",
      reads: 0,
    },
    {
      file: { sizeMode: "explicit", size: 0 },
      size: 0,
      sizeMode: "explicit",
      reads: 0,
    },
  ])(
    "applies content-only file defaults $file",
    async ({ file, size, sizeMode, reads }) => {
      const source = await createSource();
      await writeFile(path.join(source, "data"), "x");
      const reader = vi.fn(() => Buffer.from("GENERATED"));
      const filesystem = createFilesystem(source, { readFile: reader }, [
        {
          match: "data",
          provider: { module: "content-only" },
          file: { ...file, mode: 0o600 },
        },
      ]);
      expect(await filesystem.getattr("data")).toMatchObject({
        size,
        sizeMode,
        mode: 0o600,
        seekable: file.seekable ?? true,
      });
      expect(reader).toHaveBeenCalledTimes(reads);
    },
  );

  it("applies positional file defaults without inheriting the source size for unbounded files", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "data"), "x");
    const reader = vi.fn(() => "generated");
    const filesystem = createFilesystem(source, { read: reader }, [
      {
        match: "data",
        provider: { module: "positional" },
        file: { sizeMode: "unbounded", seekable: false },
      },
    ]);
    expect(await filesystem.getattr("data")).toMatchObject({
      size: 0x7fff_ffff_ffff,
      sizeMode: "unbounded",
      seekable: false,
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("preserves native sizes for lifecycle-only hooks and source fallback", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "data"), "SOURCE");
    const reader = vi.fn(() => "GENERATED");
    for (const provider of [
      { open: () => ({}) },
      { getattr: () => undefined, readFile: reader },
    ]) {
      const filesystem = createFilesystem(source, provider, [
        { match: "data", provider: { module: "native" } },
      ]);
      const metadata = await filesystem.getattr("data");
      expect(metadata).toMatchObject({ size: 6, sizeMode: "explicit" });
      const handle = await filesystem.open("data", 0);
      try {
        expect(handle.native).toBeDefined();
        expect(
          await filesystem.fgetattr("data", 0, handle, metadata),
        ).toMatchObject({ size: 6, sizeMode: "explicit" });
      } finally {
        await filesystem.release("data", 0, handle);
      }
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it("does not derive content-only metadata for directories, symlinks, or missing paths", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "directory"));
    await symlink("directory", path.join(source, "link"));
    const reader = vi.fn(() => "GENERATED");
    const filesystem = createFilesystem(source, { readFile: reader }, [
      {
        match: "**",
        provider: { module: "content-only" },
        file: { size: 123 },
      },
    ]);
    expect(await filesystem.getattr("directory")).toMatchObject({
      kind: "directory",
    });
    expect(await filesystem.getattr("link")).toMatchObject({ kind: "symlink" });
    expect(await filesystem.getattr("missing")).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(["ENOENT", "EIO"])(
    "propagates content-only size calculation errors (%s)",
    async (code) => {
      const source = await createSource();
      await writeFile(path.join(source, "data"), "SOURCE");
      const error = Object.assign(new Error("Provider read failed"), { code });
      const filesystem = createFilesystem(
        source,
        {
          readFile: () => {
            throw error;
          },
        },
        [{ match: "data", provider: { module: "content-only" } }],
      );
      await expect(filesystem.getattr("data")).rejects.toBe(error);
    },
  );

  it("keeps earlier directory providers superseded when the winning module uses source backing", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "Mixed"));
    await writeFile(path.join(source, "Mixed", "source.txt"), "SOURCE");
    const superseded = vi.fn(() => {
      throw new Error("Superseded directory provider");
    });
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          { match: "Mixed/**", root: "Mixed", provider: { module: "earlier" } },
          { match: "Mixed/**", root: "Mixed", provider: { module: "later" } },
        ],
      },
      (reference) =>
        Promise.resolve(
          "module" in reference && reference.module === "earlier"
            ? { readdir: superseded }
            : {
                getattr: ({ relativePath }) =>
                  relativePath === "generated.txt"
                    ? fileMetadata({ size: 0 })
                    : undefined,
                readdir: () => ["generated.txt"],
              },
        ),
    );
    expect(
      (await filesystem.readdir("Mixed"))?.map(({ name }) => name).sort(),
    ).toEqual(["generated.txt", "source.txt"]);
    expect(superseded).not.toHaveBeenCalled();
  });

  it("does not fall back to source contents when module lookup fails", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "data"), "SOURCE");
    const filesystem = createFilesystem(
      source,
      {
        getattr: () => {
          throw Object.assign(new Error("Lookup failed"), { code: "EACCES" });
        },
        readFile: () => "GENERATED",
      },
      [{ match: "data", provider: { module: "memory" } }],
    );
    await expect(filesystem.readFile("data")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it.each(["hidden", "superseded"] as const)(
    "does not call a %s exact-entry metadata provider during enumeration",
    async (kind) => {
      const source = await createSource();
      await writeFile(path.join(source, "unrelated"), "source");
      const rejected = vi.fn(() => {
        throw Object.assign(new Error("provider unavailable"), { code: "EIO" });
      });
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            { match: "data", provider: { module: "earlier" } },
            ...(kind === "hidden"
              ? [{ match: "data", hide: true as const }]
              : [{ match: "data", provider: { module: "later" } }]),
          ],
        },
        (reference) =>
          Promise.resolve(
            "module" in reference && reference.module === "earlier"
              ? { getattr: rejected }
              : {
                  getattr: () => fileMetadata({ size: 3 }),
                  readFile: () => "NEW",
                },
          ),
      );
      expect(
        (await filesystem.readdir(""))?.map(({ name }) => name).sort(),
      ).toEqual(kind === "hidden" ? ["unrelated"] : ["data", "unrelated"]);
      expect(rejected).not.toHaveBeenCalled();
      if (kind === "superseded")
        expect((await filesystem.readFile("data")).toString()).toBe("NEW");
    },
  );

  it("propagates errors from the winning exact-entry metadata provider", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(
      source,
      {
        getattr: () => {
          throw Object.assign(new Error("lookup denied"), { code: "EACCES" });
        },
      },
      [{ match: "data", provider: { module: "memory" } }],
    );
    await expect(filesystem.readdir("")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("provides a fully generated writable subtree", async () => {
    const source = await createSource();
    const recordWrite = vi.fn();
    const tree = new Map<string, readonly string[]>([
      ["", ["Pinned", "Datasets", "AGENTS.md"]],
      ["Pinned", []],
      ["Datasets", ["Batch1"]],
      ["Datasets/Batch1", ["Record1", "Record2"]],
      ["Datasets/Batch1/Record1", ["data.txt", "action.txt"]],
      ["Datasets/Batch1/Record2", ["data.txt", "action.txt"]],
    ]);
    const provider = defineProvider({
      getattr: ({ relativePath }) => {
        if (tree.has(relativePath)) {
          return directoryMetadata();
        }
        if (
          relativePath === "AGENTS.md" ||
          relativePath.endsWith("/data.txt") ||
          relativePath.endsWith("/action.txt")
        ) {
          return fileMetadata();
        }
        return undefined;
      },
      readdir: ({ relativePath }) => tree.get(relativePath),
      readFile: ({ relativePath }) =>
        relativePath === "AGENTS.md"
          ? "Write to action.txt to trigger an operation."
          : `Data for ${relativePath}`,
      writeFile: (contents, { relativePath }) => {
        recordWrite(relativePath, contents.toString());
      },
    });
    const filesystem = createFilesystem(source, provider, [
      {
        match: "GeneratedCatalog/**",
        root: "GeneratedCatalog",
        provider: { module: "test-provider" },
        opaque: true,
      },
    ]);

    expect((await filesystem.readdir(""))?.map((entry) => entry.name)).toEqual([
      "GeneratedCatalog",
    ]);
    expect(
      (
        await filesystem.readdir("GeneratedCatalog/Datasets/Batch1/Record2")
      )?.map((entry) => entry.name),
    ).toEqual(["data.txt", "action.txt"]);
    await expect(
      filesystem.readFile("GeneratedCatalog/Datasets/Batch1/Record2/data.txt"),
    ).resolves.toEqual(
      Buffer.from("Data for Datasets/Batch1/Record2/data.txt"),
    );

    await filesystem.writeFile(
      "GeneratedCatalog/Datasets/Batch1/Record2/action.txt",
      Buffer.from("run"),
    );
    expect(recordWrite).toHaveBeenCalledWith(
      "Datasets/Batch1/Record2/action.txt",
      "run",
    );
  });

  it("hides matching source files while preserving passthrough files", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "visible.txt"), "visible");
    await writeFile(path.join(source, "secret.txt"), "secret");
    const filesystem = createFilesystem(source, {}, [
      { match: "secret.txt", hide: true },
    ]);

    expect((await filesystem.readdir(""))?.map((entry) => entry.name)).toEqual([
      "visible.txt",
    ]);
    await expect(filesystem.readFile("visible.txt")).resolves.toEqual(
      Buffer.from("visible"),
    );
    await expect(filesystem.readFile("secret.txt")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("passes ordinary writes through to the source", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(source, {}, []);

    await filesystem.writeFile("created.txt", Buffer.from("created"));

    await expect(
      readFile(path.join(source, "created.txt"), "utf8"),
    ).resolves.toBe("created");
  });

  it.each([0o644, 0o755, 0o777])(
    "preserves caller permissions when creating regular files with mode %i",
    async (mode) => {
      const source = await createSource();
      const providerCreate = vi.fn();
      const provider = defineProvider({ create: providerCreate });
      const filesystem = createFilesystem(source, provider, [
        {
          match: "Generated/**",
          root: "Generated",
          opaque: true,
          provider: { module: "test-provider" },
        },
      ]);

      const sourceHandle = await filesystem.create("source.txt", mode, 0x42);
      await filesystem.release("source.txt", 0x42, sourceHandle);
      await writeFile(path.join(source, "reference.txt"), "", { mode });
      const providerHandle = await filesystem.create(
        "Generated/provider.txt",
        0o100000 | mode,
        0x42,
      );
      await filesystem.release("Generated/provider.txt", 0x42, providerHandle);

      expect((await stat(path.join(source, "source.txt"))).mode & 0o777).toBe(
        (await stat(path.join(source, "reference.txt"))).mode & 0o777,
      );
      expect(providerCreate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "file", mode }),
        expect.anything(),
      );
    },
  );

  it("preserves execute bits when creating directories", async () => {
    const source = await createSource();
    const providerMkdir = vi.fn();
    const provider = defineProvider({ mkdir: providerMkdir });
    const filesystem = createFilesystem(source, provider, [
      {
        match: "Generated/**",
        root: "Generated",
        provider: { module: "test-provider" },
      },
    ]);

    await filesystem.mkdir("source-directory", 0o777);
    await filesystem.mkdir("Generated/provider-directory", 0o777);

    expect(
      (await stat(path.join(source, "source-directory"))).mode & 0o111,
    ).not.toBe(0);
    expect(providerMkdir).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "directory", mode: 0o777 }),
      expect.anything(),
    );
  });

  it("does not list source children of an opaque provider directory", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "Generated"));
    await writeFile(path.join(source, "Generated", "source-only"), "source");
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ relativePath }) =>
          relativePath === "" ? directoryMetadata() : undefined,
        readdir: () => [],
      },
      [
        {
          match: "Generated/**",
          root: "Generated",
          opaque: true,
          provider: { module: "test" },
        },
      ],
    );
    expect(await filesystem.readdir("Generated")).toEqual([]);
    expect(await filesystem.getattr("Generated/source-only")).toBeUndefined();
  });

  it("synthesizes traversable ancestors for nested generated roots", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ relativePath }) =>
          relativePath === "" ? directoryMetadata() : fileMetadata({ size: 5 }),
        readdir: ({ relativePath }) =>
          relativePath === "" ? ["value"] : undefined,
        readFile: () => "value",
      },
      [
        {
          match: "Generated/Nested/**",
          root: "Generated/Nested",
          opaque: true,
          provider: { module: "test" },
        },
      ],
    );
    expect(await filesystem.getattr("Generated")).toMatchObject({
      kind: "directory",
    });
    expect(
      (await filesystem.readdir("Generated"))?.map(({ name }) => name),
    ).toEqual(["Nested"]);
    expect(
      (await filesystem.readFile("Generated/Nested/value")).toString(),
    ).toBe("value");
  });

  it.each(["Generated/*.txt", "Generated/data.txt", "Nested/Generated/*.txt"])(
    "exposes the inferred opaque root for %s without hiding source siblings",
    async (match) => {
      const source = await createSource();
      await writeFile(path.join(source, "source-only"), "source");
      const root = path.posix.dirname(match);
      const filesystem = createFilesystem(
        source,
        {
          getattr: ({ relativePath }) =>
            relativePath === ""
              ? directoryMetadata()
              : fileMetadata({ size: 4 }),
          readdir: ({ relativePath }) =>
            relativePath === "" ? ["data.txt"] : undefined,
          readFile: () => "data",
        },
        [{ match, opaque: true, provider: { module: "test" } }],
      );
      expect(await filesystem.getattr(root)).toMatchObject({
        kind: "directory",
      });
      await expect(filesystem.access(root, 1)).resolves.toBeUndefined();
      expect((await filesystem.readdir(root))?.map(({ name }) => name)).toEqual(
        ["data.txt"],
      );
      expect((await filesystem.readFile(`${root}/data.txt`)).toString()).toBe(
        "data",
      );
      expect(
        (await filesystem.readdir(""))?.map(({ name }) => name).sort(),
      ).toEqual([root.split("/")[0], "source-only"].sort());
    },
  );

  it("does not claim the mount root for an opaque root-level file", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "source-only"), "source");
    const filesystem = createFilesystem(
      source,
      {
        getattr: () => fileMetadata({ size: 4 }),
        readFile: () => "data",
      },
      [{ match: "data.txt", opaque: true, provider: { module: "test" } }],
    );
    expect(
      (await filesystem.readdir(""))?.map(({ name }) => name).sort(),
    ).toEqual(["data.txt", "source-only"]);
  });

  it("does not replace existing source directories with inferred opaque roots", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "Generated"));
    await writeFile(path.join(source, "Generated", "source-only"), "source");
    const native = await stat(path.join(source, "Generated"), { bigint: true });
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ relativePath }) =>
          relativePath === "" ? directoryMetadata() : fileMetadata({ size: 4 }),
        readFile: () => "data",
      },
      [
        {
          match: "Generated/data.txt",
          opaque: true,
          provider: { module: "test" },
        },
      ],
    );
    expect(await filesystem.getattr("Generated")).toMatchObject({
      identity: `native:${String(native.dev)}:${String(native.ino)}`,
    });
    expect(
      (await filesystem.readdir("Generated"))?.map(({ name }) => name).sort(),
    ).toEqual(["data.txt", "source-only"]);
  });

  it.each(["source", "proxy"] as const)(
    "preserves native %s directory identity beneath a generated root",
    async (backing) => {
      const source = await createSource();
      const target = backing === "source" ? source : await createSource();
      await mkdir(path.join(target, "Existing"), { mode: 0o750 });
      await writeFile(path.join(target, "Existing", "source-only"), "source");
      const directory = backing === "source" ? "Existing" : "Proxy/Existing";
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            ...(backing === "proxy"
              ? [
                  {
                    match: "Proxy/**",
                    root: "Proxy",
                    provider: { type: "directory" as const, path: target },
                  },
                ]
              : []),
            {
              match: `${directory}/Generated/**`,
              root: `${directory}/Generated`,
              opaque: true,
              provider: { module: "memory" },
            },
          ],
        },
        async (reference) =>
          "module" in reference
            ? { getattr: () => directoryMetadata() }
            : createProviderLoader()(reference),
      );
      const native = await stat(path.join(target, "Existing"), {
        bigint: true,
      });
      const expected = {
        identity: `native:${String(native.dev)}:${String(native.ino)}`,
        mode: 0o750,
        kind: "directory",
      };
      expect(await filesystem.getattr(directory)).toMatchObject(expected);
      const handle = await filesystem.opendir(directory, 0);
      try {
        expect(await filesystem.fgetattr(directory, 0, handle)).toMatchObject(
          expected,
        );
        expect(
          (await filesystem.readdir(directory))?.map(({ name }) => name).sort(),
        ).toEqual(["Generated", "source-only"]);
      } finally {
        await filesystem.releasedir(directory, 0, handle);
      }
    },
  );

  it("does not borrow native identity for generated ancestors inside an opaque module", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "Tree"));
    await writeFile(path.join(source, "Tree", "hidden-source"), "hidden");
    const filesystem = createFilesystem(
      source,
      { getattr: () => directoryMetadata(), readdir: () => [] },
      [
        {
          match: "Tree/**",
          root: "Tree",
          opaque: true,
          provider: { module: "memory" },
        },
        {
          match: "Tree/Nested/**",
          root: "Tree/Nested",
          opaque: true,
          provider: { module: "memory" },
        },
      ],
    );
    expect((await filesystem.getattr("Tree"))?.identity).toBeUndefined();
    const handle = await filesystem.opendir("Tree", 0);
    try {
      expect(handle.native).toBeUndefined();
      expect(
        (await filesystem.fgetattr("Tree", 0, handle))?.identity,
      ).toBeUndefined();
      expect(
        (await filesystem.readdir("Tree"))?.map(({ name }) => name),
      ).toEqual(["Nested"]);
    } finally {
      await filesystem.releasedir("Tree", 0, handle);
    }
  });

  it("omits a generated root overridden by a later opaque directory", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ relativePath }) =>
          relativePath === "" ? directoryMetadata() : undefined,
        readdir: () => [],
      },
      [
        {
          match: "Tree/Nested/**",
          root: "Tree/Nested",
          opaque: true,
          provider: { module: "old" },
        },
        {
          match: "Tree/**",
          root: "Tree",
          opaque: true,
          provider: { module: "new" },
        },
      ],
    );
    expect(await filesystem.readdir("Tree")).toEqual([]);
    expect(await filesystem.getattr("Tree/Nested")).toBeUndefined();
  });

  it("hides generated exact entries and generated roots from listings", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ path: virtualPath }) =>
          virtualPath === "secret" ? fileMetadata() : directoryMetadata(),
      },
      [
        { match: "secret", provider: { module: "test" } },
        {
          match: "Tree/**",
          root: "Tree",
          opaque: true,
          provider: { module: "test" },
        },
        { match: "secret", hide: true },
        { match: "Tree", hide: true },
      ],
    );
    expect(await filesystem.readdir("")).toEqual([]);
    expect(await filesystem.readdir("Tree")).toBeUndefined();
  });

  it("uses the winning provider for overlapping directory listings", async () => {
    const source = await createSource();
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          { match: "Tree/**", root: "Tree", provider: { module: "first" } },
          {
            match: "Tree/**",
            root: "Tree",
            opaque: true,
            provider: { module: "second" },
          },
        ],
      },
      (reference) =>
        Promise.resolve({
          getattr: () => directoryMetadata(),
          readdir: () => ["module" in reference ? reference.module : "invalid"],
        }),
    );
    expect((await filesystem.readdir("Tree"))?.map(({ name }) => name)).toEqual(
      ["second"],
    );
  });

  it.each([false, true])(
    "enumerates later wildcard contributions to a provider directory (opaque: %s)",
    async (opaque) => {
      const source = await createSource();
      const superseded = vi.fn(() => {
        throw new Error("Superseded directory must not be enumerated");
      });
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            { match: "Tree/**", root: "Tree", provider: { module: "old" } },
            {
              match: "Tree/**",
              root: "Tree",
              opaque,
              provider: { module: "base" },
            },
            { match: "Tree/*.json", provider: { module: "extra" } },
            { match: "Tree/hidden.json", hide: true },
            {
              match: "Tree/masked.json",
              opaque: true,
              provider: { module: "empty" },
            },
          ],
        },
        (reference) => {
          if (!("module" in reference)) throw new Error("Expected module");
          switch (reference.module) {
            case "old":
              return Promise.resolve({ readdir: superseded });
            case "base":
              return Promise.resolve({
                getattr: ({ relativePath }) =>
                  relativePath === ""
                    ? directoryMetadata()
                    : fileMetadata({ size: 4 }),
                readdir: () => ["base.txt"],
              });
            case "extra":
              return Promise.resolve({
                getattr: () => fileMetadata({ size: 2 }),
                readdir: () => [
                  "extra.json",
                  "hidden.json",
                  "masked.json",
                  "unmatched.txt",
                ],
                readFile: () => "{}",
              });
            default:
              return Promise.resolve({});
          }
        },
      );
      expect(
        (await filesystem.readdir("Tree"))?.map(({ name }) => name).sort(),
      ).toEqual(["base.txt", "extra.json"]);
      expect((await filesystem.readFile("Tree/extra.json")).toString()).toBe(
        "{}",
      );
      expect(superseded).not.toHaveBeenCalled();
    },
  );

  it("falls back to creating source files for a nonopaque provider without write operations", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(source, {}, [
      { match: "**/*.txt", provider: { module: "test" } },
    ]);
    const handle = await filesystem.create("empty.txt", 0o644, 0x42);
    await filesystem.release("empty.txt", 0x42, handle);
    expect((await stat(path.join(source, "empty.txt"))).size).toBe(0);
    await expect(
      filesystem.create("empty.txt", 0o644, 0x42),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("retains a source file when its provider open hook rejects during create", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(
      source,
      {
        open: () => {
          throw new Error("open hook failed");
        },
      },
      [{ match: "**/*.txt", provider: { module: "test" } }],
    );

    await expect(filesystem.create("failed.txt", 0o644, 0x42)).rejects.toThrow(
      "open hook failed",
    );
    expect(await readFile(path.join(source, "failed.txt"))).toEqual(
      Buffer.alloc(0),
    );
  });

  it("rejects unsupported creates for opaque providers", async () => {
    const source = await createSource();
    const filesystem = createFilesystem(source, {}, [
      { match: "**", opaque: true, provider: { module: "test" } },
    ]);
    await expect(filesystem.create("empty", 0o644, 0x42)).rejects.toMatchObject(
      { code: "EROFS" },
    );
  });

  it("rejects cross-provider rename without changing either backing file", async () => {
    const source = await createSource();
    const target = path.join(source, "target");
    await writeFile(target, "old");
    await writeFile(path.join(source, "temporary"), "new");
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [{ match: "config", provider: { type: "file", path: target } }],
      },
      createProviderLoader(),
    );
    await expect(
      filesystem.rename("temporary", "config"),
    ).rejects.toMatchObject({ code: "EXDEV" });
    await expect(
      filesystem.rename("config", "elsewhere"),
    ).rejects.toMatchObject({ code: "EXDEV" });
    await expect(filesystem.unlink("config")).rejects.toMatchObject({
      code: "EROFS",
    });
    expect(await readFile(path.join(source, "temporary"), "utf8")).toBe("new");
    expect((await filesystem.readFile("config")).toString()).toBe("old");
  });

  it.each([false, true])(
    "rejects file proxy symlink replacements without redirecting retained handles (opaque: %s)",
    async (opaque) => {
      const source = await createSource();
      const proxy = await createSource();
      const target = path.join(proxy, "target");
      await writeFile(target, "original");
      await writeFile(path.join(proxy, "actual"), "intended");
      await writeFile(path.join(source, "actual"), "unrelated");
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            {
              match: "Proxy",
              opaque,
              provider: { type: "file", path: target },
            },
          ],
        },
        createProviderLoader(),
      );
      const handle = await filesystem.open("Proxy", 2);
      try {
        await symlink("actual", path.join(proxy, "replacement"));
        await renameHost(path.join(proxy, "replacement"), target);
        await expect(filesystem.getattr("Proxy")).rejects.toMatchObject({
          code: "EOPNOTSUPP",
        });
        expect(
          (await filesystem.readdir(""))?.map(({ name }) => name),
        ).not.toContain("Proxy");
        await expect(filesystem.open("Proxy", 2)).rejects.toHaveProperty(
          "code",
        );
        await filesystem.writeChunk("Proxy", Buffer.from("X"), 0, 2, handle);
        expect(
          (await filesystem.readChunk("Proxy", 0, 8, 2, handle))?.toString(),
        ).toBe("Xriginal");
        expect(await readFile(path.join(source, "actual"), "utf8")).toBe(
          "unrelated",
        );
        expect(await readFile(path.join(proxy, "actual"), "utf8")).toBe(
          "intended",
        );
        await writeFile(path.join(proxy, "regular"), "restored");
        await renameHost(path.join(proxy, "regular"), target);
        expect((await filesystem.readFile("Proxy")).toString()).toBe(
          "restored",
        );
      } finally {
        await filesystem.release("Proxy", 2, handle);
      }
    },
  );

  it("allows renames within a directory proxy and follows host file replacement", async () => {
    const source = await createSource();
    const target = await createSource();
    await writeFile(path.join(target, "old"), "value");
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          {
            match: "Proxy/**",
            root: "Proxy",
            opaque: true,
            provider: { type: "directory", path: target },
          },
        ],
      },
      createProviderLoader(),
    );
    await filesystem.rename("Proxy/old", "Proxy/new");
    expect((await filesystem.readFile("Proxy/new")).toString()).toBe("value");
    await writeFile(path.join(target, "replacement"), "replacement");
    await renameHost(
      path.join(target, "replacement"),
      path.join(target, "new"),
    );
    expect((await filesystem.readFile("Proxy/new")).toString()).toBe(
      "replacement",
    );
    await expect(filesystem.getattr("Proxy/old")).resolves.toBeUndefined();
  });

  it("reads source, directory-proxy, and generated symlink targets", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "file"), "value");
    await symlink("file", path.join(source, "link"));
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          {
            match: "Proxy/**",
            root: "Proxy",
            provider: { type: "directory", path: source },
          },
          { match: "Generated", provider: { module: "test" } },
        ],
      },
      async (reference) =>
        "module" in reference
          ? { getattr: () => ({ kind: "symlink", target: "file" }) }
          : createProviderLoader()(reference),
    );
    expect(await filesystem.readlink("link")).toBe("file");
    expect(await filesystem.readlink("Proxy/link")).toBe("file");
    expect(await filesystem.readlink("Generated")).toBe("file");
  });

  it("rejects hidden mutations and writable opens on a read-only filesystem", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "secret"), "secret");
    const filesystem = createFilesystem(source, {}, [
      { match: "secret", hide: true },
    ]);
    await expect(filesystem.unlink("secret")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      filesystem.create("secret", 0o644, 0x42),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(filesystem.rename("secret", "visible")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const readonly = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        readOnly: true,
      },
      createProviderLoader(),
    );
    await expect(readonly.open("secret", 2)).rejects.toMatchObject({
      code: "EROFS",
    });
    await expect(readonly.access("secret", 2)).rejects.toMatchObject({
      code: "EROFS",
    });
    expect(await readFile(path.join(source, "secret"), "utf8")).toBe("secret");
  });

  it("uses the existing backing for every nonopaque directory proxy child", async () => {
    const source = await createSource();
    const target = await createSource();
    const base = path.join(source, "Proxy");
    await mkdir(base);
    await writeFile(path.join(base, "source-only"), "SOURCE");
    await writeFile(path.join(base, "overlap"), "SOURCE overlap");
    await writeFile(path.join(target, "proxy-only"), "PROXY");
    await writeFile(path.join(target, "overlap"), "PROXY overlap");
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          {
            match: "Proxy/**",
            root: "Proxy",
            provider: { type: "directory", path: target },
          },
        ],
      },
      createProviderLoader(),
    );
    expect(
      (await filesystem.readdir("Proxy"))?.map((entry) => entry.name).sort(),
    ).toEqual(["overlap", "proxy-only", "source-only"]);
    for (const [name, expected, backing] of [
      ["source-only", "SOURCE", base],
      ["proxy-only", "PROXY", target],
      ["overlap", "PROXY overlap", target],
    ] as const) {
      expect(await filesystem.getattr("Proxy/" + name)).toMatchObject({
        size: expected.length,
      });
      expect((await filesystem.readFile("Proxy/" + name)).toString()).toBe(
        expected,
      );
      const handle = await filesystem.open("Proxy/" + name, 2);
      try {
        await filesystem.writeChunk(
          "Proxy/" + name,
          Buffer.from("X"),
          0,
          2,
          handle,
        );
        await filesystem.ftruncate("Proxy/" + name, 3, 2, handle);
        expect(await readFile(path.join(backing, name), "utf8")).toBe(
          "X" + expected.slice(1, 3),
        );
        await writeFile(path.join(backing, "replacement"), "REPLACEMENT");
        await renameHost(
          path.join(backing, "replacement"),
          path.join(backing, name),
        );
        await filesystem.ftruncate("Proxy/" + name, 2, 2, handle);
        expect(
          (
            await filesystem.readChunk("Proxy/" + name, 0, 2, 2, handle)
          )?.toString(),
        ).toBe("X" + expected.slice(1, 2));
        expect(await readFile(path.join(backing, name), "utf8")).toBe(
          "REPLACEMENT",
        );
      } finally {
        await filesystem.release("Proxy/" + name, 2, handle);
      }
      await filesystem.writeFile("Proxy/" + name, Buffer.from("updated"));
      await filesystem.truncate("Proxy/" + name, 3);
      expect(await readFile(path.join(backing, name), "utf8")).toBe("upd");
    }
    expect(await readFile(path.join(base, "overlap"), "utf8")).toBe(
      "SOURCE overlap",
    );
    await filesystem.chmod("Proxy/source-only", 0o600);
    expect((await stat(path.join(base, "source-only"))).mode & 0o777).toBe(
      0o600,
    );
    await filesystem.unlink("Proxy/source-only");
    expect(await filesystem.getattr("Proxy/source-only")).toBeUndefined();
    const handle = await filesystem.create("Proxy/new", 0o644, 2);
    await filesystem.release("Proxy/new", 2, handle);
    expect(await readFile(path.join(target, "new"), "utf8")).toBe("");
  });

  it("creates and renames children on their merged parent directory's backing", async () => {
    const source = await createSource();
    const target = await createSource();
    await mkdir(path.join(source, "Proxy", "source-only", "nested"), {
      recursive: true,
    });
    await mkdir(path.join(source, "Proxy", "merged"));
    await mkdir(path.join(target, "merged"));
    await mkdir(path.join(target, "proxy-only"));
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          {
            match: "Proxy/**",
            root: "Proxy",
            provider: { type: "directory", path: target },
          },
        ],
      },
      createProviderLoader(),
    );
    for (const [parent, backing] of [
      ["source-only/nested", path.join(source, "Proxy")],
      ["merged", target],
      ["proxy-only", target],
    ] as const) {
      const directory = `Proxy/${parent}`;
      const before = await filesystem.getattr(directory);
      const handle = await filesystem.opendir(directory, 0);
      try {
        const file = await filesystem.create(`${directory}/created`, 0o644, 2);
        await filesystem.release(`${directory}/created`, 2, file);
        await filesystem.writeFile(
          `${directory}/written`,
          Buffer.from("written"),
        );
        await filesystem.mkdir(`${directory}/child`);
        await filesystem.rename(`${directory}/created`, `${directory}/renamed`);
        expect(
          (await filesystem.readdir(directory))?.map(({ name }) => name).sort(),
        ).toEqual(["child", "renamed", "written"]);
        expect(await filesystem.getattr(directory)).toMatchObject({
          identity: before?.identity,
        });
        expect(await filesystem.fgetattr(directory, 0, handle)).toMatchObject({
          identity: before?.identity,
        });
        expect(
          await readFile(path.join(backing, parent, "renamed"), "utf8"),
        ).toBe("");
        expect(
          await readFile(path.join(backing, parent, "written"), "utf8"),
        ).toBe("written");
        expect(
          (await stat(path.join(backing, parent, "child"))).isDirectory(),
        ).toBe(true);
      } finally {
        await filesystem.releasedir(directory, 0, handle);
      }
    }
    await expect(stat(path.join(target, "source-only"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      filesystem.create("Proxy/missing/new", 0o644, 2),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects partial removal and rename of multiply backed directories", async () => {
    const source = await createSource();
    const target = await createSource();
    for (const backing of [path.join(source, "Proxy"), target]) {
      await mkdir(path.join(backing, "merged"), { recursive: true });
      await mkdir(path.join(backing, "empty"));
    }
    await writeFile(path.join(source, "Proxy", "merged", "source"), "source");
    await writeFile(path.join(target, "merged", "proxy"), "proxy");
    await mkdir(path.join(target, "single"));
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          {
            match: "Proxy/**",
            root: "Proxy",
            provider: { type: "directory", path: target },
          },
        ],
      },
      createProviderLoader(),
    );
    await expect(filesystem.rmdir("Proxy/merged")).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    await expect(
      filesystem.rename("Proxy/merged", "Proxy/moved"),
    ).rejects.toMatchObject({ code: "EXDEV" });
    await expect(filesystem.rmdir("Proxy/empty")).rejects.toMatchObject({
      code: "EOPNOTSUPP",
    });
    await expect(
      filesystem.rename("Proxy/single", "Proxy/empty"),
    ).rejects.toMatchObject({ code: "EXDEV" });
    await filesystem.rename("Proxy/merged", "Proxy/merged");
    expect(
      (await filesystem.readdir("Proxy/merged"))
        ?.map(({ name }) => name)
        .sort(),
    ).toEqual(["proxy", "source"]);
    for (const backing of [path.join(source, "Proxy"), target]) {
      expect((await stat(path.join(backing, "empty"))).isDirectory()).toBe(
        true,
      );
      await expect(stat(path.join(backing, "moved"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect((await stat(path.join(target, "single"))).isDirectory()).toBe(true);
    await rm(path.join(target, "merged", "proxy"));
    await expect(filesystem.rmdir("Proxy/merged")).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
  });

  it.each(["file", "symlink", "hardlink", "source-directory"] as const)(
    "rejects namespace removal that would reveal an overlapping %s backing",
    async (kind) => {
      const source = await createSource();
      const target = await createSource();
      await mkdir(path.join(source, "Proxy"));
      const sourcePath = path.join(source, "Proxy", "data");
      const targetPath = path.join(target, "data");
      if (kind === "symlink") {
        await symlink("source-target", sourcePath);
        await symlink("proxy-target", targetPath);
      } else {
        if (kind === "source-directory") await mkdir(sourcePath);
        else await writeFile(sourcePath, "SOURCE");
        if (kind === "hardlink") await link(sourcePath, targetPath);
        else await writeFile(targetPath, "PROXY");
      }
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            {
              match: "Proxy/**",
              root: "Proxy",
              provider: { type: "directory", path: target },
            },
          ],
        },
        createProviderLoader(),
      );
      const before = await filesystem.getattr("Proxy/data");
      await expect(filesystem.unlink("Proxy/data")).rejects.toMatchObject({
        code: "EOPNOTSUPP",
      });
      await expect(
        filesystem.rename("Proxy/data", "Proxy/moved"),
      ).rejects.toMatchObject({ code: "EXDEV" });
      await filesystem.rename("Proxy/data", "Proxy/data");
      expect(await filesystem.getattr("Proxy/data")).toMatchObject({
        identity: before?.identity,
      });
      expect(await lstat(sourcePath)).toBeDefined();
      expect(await lstat(targetPath)).toBeDefined();
      await expect(lstat(path.join(target, "moved"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("allows safe replacement of an overlapping proxy file and same-inode renames", async () => {
    const source = await createSource();
    const target = await createSource();
    await mkdir(path.join(source, "Proxy"));
    await writeFile(path.join(source, "Proxy", "data"), "SOURCE");
    await writeFile(path.join(target, "data"), "OLD");
    await writeFile(path.join(target, "replacement"), "NEW");
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          {
            match: "Proxy/**",
            root: "Proxy",
            provider: { type: "directory", path: target },
          },
        ],
      },
      createProviderLoader(),
    );
    await filesystem.rename("Proxy/replacement", "Proxy/data");
    expect(await filesystem.getattr("Proxy/replacement")).toBeUndefined();
    expect((await filesystem.readFile("Proxy/data")).toString()).toBe("NEW");
    expect(await readFile(path.join(source, "Proxy", "data"), "utf8")).toBe(
      "SOURCE",
    );
    await link(path.join(target, "data"), path.join(target, "alias"));
    await filesystem.rename("Proxy/data", "Proxy/alias");
    expect((await filesystem.readFile("Proxy/data")).toString()).toBe("NEW");
    expect((await filesystem.readFile("Proxy/alias")).toString()).toBe("NEW");
  });

  it.each(["file", "directory", "symlink"] as const)(
    "rejects module namespace mutations that would reveal a shadowed source %s",
    async (kind) => {
      const source = await createSource();
      if (kind === "directory") await mkdir(path.join(source, "data"));
      else if (kind === "symlink")
        await symlink("source-target", path.join(source, "data"));
      else await writeFile(path.join(source, "data"), "SOURCE");
      const original = await lstat(path.join(source, "data"));
      const remove = vi.fn();
      const move = vi.fn();
      const filesystem = createFilesystem(
        source,
        {
          getattr: ({ path: name }) =>
            name === ""
              ? directoryMetadata()
              : name === "data" || name === "alias"
                ? {
                    kind,
                    identity: "generated",
                    size: 9,
                    target: "generated-target",
                  }
                : name === "replacement"
                  ? { kind, identity: "replacement", size: 3 }
                  : undefined,
          readdir: () => [],
          readFile: () => "GENERATED",
          unlink: remove,
          rmdir: remove,
          rename: move,
        },
        [{ match: "**", provider: { module: "memory" } }],
      );
      await expect(
        kind === "directory"
          ? filesystem.rmdir("data")
          : filesystem.unlink("data"),
      ).rejects.toMatchObject({ code: "EOPNOTSUPP" });
      await expect(filesystem.rename("data", "moved")).rejects.toMatchObject({
        code: "EXDEV",
      });
      if (kind === "directory")
        await expect(
          filesystem.rename("replacement", "data"),
        ).rejects.toMatchObject({ code: "EXDEV" });
      expect(remove).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
      expect(await lstat(path.join(source, "data"))).toMatchObject({
        ino: original.ino,
      });
      expect(await filesystem.getattr("data")).toMatchObject({ kind });
      await filesystem.rename("data", "data");
      expect(move).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "preserves module-only removals and safe replacement (opaque=%s)",
    async (opaque) => {
      const source = await createSource();
      await writeFile(path.join(source, "data"), "SOURCE");
      const original = {
        kind: "file" as const,
        identity: "original",
        size: 3,
        contents: "OLD",
      };
      const replacement = {
        ...original,
        identity: "replacement",
        contents: "NEW",
      };
      const entries = new Map([
        ["data", original],
        ["alias", original],
        ["replacement", replacement],
      ]);
      const filesystem = createFilesystem(
        source,
        {
          getattr: ({ path: name }) =>
            name === "" ? directoryMetadata() : entries.get(name),
          readFile: ({ path: name }) => entries.get(name)?.contents ?? "",
          unlink: ({ path: name }) => {
            entries.delete(name);
          },
          rename: ({ path: from, destinationPath: to }) => {
            const resource = entries.get(from);
            if (!resource) throw new Error("Missing test resource");
            if (resource === entries.get(to)) return;
            entries.set(to, resource);
            entries.delete(from);
          },
        },
        [{ match: "**", opaque, provider: { module: "memory" } }],
      );
      await filesystem.rename("data", "alias");
      expect((await filesystem.readFile("data")).toString()).toBe("OLD");
      await filesystem.rename("replacement", "data");
      expect((await filesystem.readFile("data")).toString()).toBe("NEW");
      expect(await filesystem.getattr("replacement")).toBeUndefined();
      await filesystem.unlink("alias");
      expect(await filesystem.getattr("alias")).toBeUndefined();
      if (opaque) {
        await filesystem.rename("data", "moved");
        expect(await filesystem.getattr("data")).toBeUndefined();
        await filesystem.unlink("moved");
      } else {
        await expect(filesystem.unlink("data")).rejects.toMatchObject({
          code: "EOPNOTSUPP",
        });
      }
      expect(await readFile(path.join(source, "data"), "utf8")).toBe("SOURCE");
    },
  );

  it.each(["content-only", "metadata-only"] as const)(
    "preserves native namespace operations for %s source overlays",
    async (kind) => {
      const source = await createSource();
      await writeFile(path.join(source, "data"), "SOURCE");
      const filesystem = createFilesystem(
        source,
        kind === "content-only"
          ? { readFile: ({ sourcePath }) => readFile(sourcePath) }
          : { getattr: () => fileMetadata() },
        [{ match: "**", provider: { module: "memory" } }],
      );
      await filesystem.rename("data", "moved");
      expect(await readFile(path.join(source, "moved"), "utf8")).toBe("SOURCE");
      await filesystem.unlink("moved");
      await expect(lstat(path.join(source, "moved"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["ENOENT", "EIO"])(
    "propagates module metadata errors while checking removal safety (%s)",
    async (code) => {
      const source = await createSource();
      await writeFile(path.join(source, "data"), "SOURCE");
      const remove = vi.fn();
      const getattr = vi
        .fn<NonNullable<ScriptFsProvider["getattr"]>>()
        .mockResolvedValueOnce(fileMetadata({ size: 9 }))
        .mockRejectedValueOnce(
          Object.assign(new Error("metadata failed"), { code }),
        );
      const filesystem = createFilesystem(
        source,
        {
          getattr,
          readFile: () => "GENERATED",
          unlink: remove,
        },
        [{ match: "**", provider: { module: "memory" } }],
      );
      await expect(filesystem.unlink("data")).rejects.toMatchObject({ code });
      expect(remove).not.toHaveBeenCalled();
      expect(await readFile(path.join(source, "data"), "utf8")).toBe("SOURCE");
    },
  );

  it.each(["opaque", "same-backing"] as const)(
    "preserves directory mutations for a %s proxy",
    async (kind) => {
      const source = await createSource();
      await mkdir(path.join(source, "Proxy"));
      const target =
        kind === "same-backing"
          ? path.join(source, "Proxy")
          : await createSource();
      await mkdir(path.join(target, "directory"));
      await writeFile(path.join(target, "directory", "child"), "proxy");
      if (kind === "opaque") {
        await mkdir(path.join(source, "Proxy", "directory"));
        await writeFile(
          path.join(source, "Proxy", "directory", "source"),
          "source",
        );
      }
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            {
              match: "Proxy/**",
              root: "Proxy",
              opaque: kind === "opaque",
              provider: { type: "directory", path: target },
            },
          ],
        },
        createProviderLoader(),
      );
      await filesystem.rename("Proxy/directory", "Proxy/moved");
      expect(await filesystem.getattr("Proxy/directory")).toBeUndefined();
      expect((await filesystem.readFile("Proxy/moved/child")).toString()).toBe(
        "proxy",
      );
      await filesystem.unlink("Proxy/moved/child");
      await filesystem.rmdir("Proxy/moved");
      expect(await filesystem.getattr("Proxy/moved")).toBeUndefined();
      await writeFile(path.join(target, "file"), "file");
      if (kind === "opaque")
        await writeFile(path.join(source, "Proxy", "file"), "source");
      await filesystem.rename("Proxy/file", "Proxy/renamed");
      expect(await filesystem.getattr("Proxy/file")).toBeUndefined();
      await filesystem.unlink("Proxy/renamed");
      expect(await filesystem.getattr("Proxy/renamed")).toBeUndefined();
    },
  );

  it.each(["source", "proxy", "module"] as const)(
    "rejects removing a %s directory containing generated children",
    async (kind) => {
      const source = await createSource();
      const backing = await createSource();
      await mkdir(path.join(source, "Parent"));
      let hidden = false;
      const remove = vi.fn();
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            ...(kind === "proxy"
              ? [
                  {
                    match: "Parent/**",
                    root: "Parent",
                    opaque: true,
                    provider: { type: "directory" as const, path: backing },
                  },
                ]
              : kind === "module"
                ? [
                    {
                      match: "Parent/**",
                      root: "Parent",
                      opaque: true,
                      provider: { module: "directory" },
                    },
                  ]
                : []),
            {
              match: "Parent/AGENTS.md",
              provider: { module: "instructions" },
            },
          ],
        },
        async (reference) => {
          if (!("module" in reference))
            return createProviderLoader()(reference);
          return reference.module === "directory"
            ? {
                getattr: () => ({ kind: "directory" }),
                readdir: () => [],
                rmdir: remove,
              }
            : {
                getattr: () => (hidden ? undefined : { kind: "file", size: 0 }),
              };
        },
      );
      expect(
        (await filesystem.readdir("Parent"))?.map(({ name }) => name),
      ).toEqual(["AGENTS.md"]);
      await expect(filesystem.rmdir("Parent")).rejects.toMatchObject({
        code: "ENOTEMPTY",
      });
      if (kind === "source") {
        await mkdir(path.join(source, "Replacement"));
        await expect(
          filesystem.rename("Replacement", "Parent"),
        ).rejects.toMatchObject({ code: "ENOTEMPTY" });
        expect(
          (await stat(path.join(source, "Replacement"))).isDirectory(),
        ).toBe(true);
      }
      expect(remove).not.toHaveBeenCalled();
      expect((await stat(path.join(source, "Parent"))).isDirectory()).toBe(
        true,
      );
      expect((await stat(backing)).isDirectory()).toBe(true);
      hidden = true;
      await filesystem.rmdir("Parent");
      if (kind === "module") expect(remove).toHaveBeenCalledOnce();
    },
  );

  it("rejects removing native ancestors of generated subtrees", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "Parent"));
    const filesystem = createFilesystem(
      source,
      {
        getattr: () => directoryMetadata(),
        readdir: () => [],
      },
      [
        {
          match: "Parent/Generated/**",
          root: "Parent/Generated",
          opaque: true,
          provider: { module: "memory" },
        },
      ],
    );
    await expect(filesystem.rmdir("Parent")).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    expect((await stat(path.join(source, "Parent"))).isDirectory()).toBe(true);
  });

  it.each(["source", "proxy", "module"] as const)(
    "rejects renaming a %s directory with closed descendants owned by another provider",
    async (kind) => {
      const source = await createSource();
      await mkdir(path.join(source, "before"));
      await writeFile(path.join(source, "before", "native"), "native");
      const renamed = vi.fn();
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            ...(kind === "source"
              ? []
              : [
                  {
                    match: "**",
                    root: "",
                    opaque: true,
                    provider:
                      kind === "proxy"
                        ? { type: "directory" as const, path: source }
                        : { module: "directory" },
                  },
                ]),
            { match: "before/generated", provider: { module: "generated" } },
          ],
        },
        async (reference) => {
          if (!("module" in reference))
            return createProviderLoader()(reference);
          return reference.module === "directory"
            ? {
                getattr: ({ path: name }) =>
                  name === "before"
                    ? directoryMetadata()
                    : name === "before/native"
                      ? fileMetadata({ size: 6 })
                      : undefined,
                readdir: () => ["native"],
                rename: renamed,
              }
            : {
                getattr: () => fileMetadata({ size: 1 }),
                readFile: () => "x",
              };
        },
      );
      await expect(filesystem.rename("before", "after")).rejects.toMatchObject({
        code: "EXDEV",
      });
      expect(renamed).not.toHaveBeenCalled();
      expect(
        await readFile(path.join(source, "before", "native"), "utf8"),
      ).toBe("native");
      await expect(stat(path.join(source, "after"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await filesystem.getattr("before/generated")).toMatchObject({
        kind: "file",
      });
    },
  );

  it("rejects renaming ancestors of generated roots before changing the backing", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "before"));
    await writeFile(path.join(source, "before", "native"), "native");
    const filesystem = createFilesystem(
      source,
      {
        getattr: () => directoryMetadata(),
        readdir: () => [],
      },
      [
        {
          match: "before/nested/generated/**",
          root: "before/nested/generated",
          opaque: true,
          provider: { module: "memory" },
        },
      ],
    );
    await expect(filesystem.rename("before", "after")).rejects.toMatchObject({
      code: "EXDEV",
    });
    expect(await filesystem.getattr("before/nested/generated")).toMatchObject({
      kind: "directory",
    });
    expect(await readFile(path.join(source, "before", "native"), "utf8")).toBe(
      "native",
    );
    await expect(stat(path.join(source, "after"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      filesystem.rename("before", "before"),
    ).resolves.toBeUndefined();
  });

  it.each(["source", "proxy", "module"] as const)(
    "rejects a %s directory rename that redirects closed descendants at the destination",
    async (kind) => {
      const source = await createSource();
      await mkdir(path.join(source, "before", "nested"), { recursive: true });
      await writeFile(
        path.join(source, "before", "nested", "data.txt"),
        "ORIGINAL",
      );
      const renamed = vi.fn();
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            ...(kind === "source"
              ? []
              : [
                  {
                    match: "**",
                    root: "",
                    opaque: true,
                    provider:
                      kind === "proxy"
                        ? { type: "directory" as const, path: source }
                        : { module: "owner" },
                  },
                ]),
            { match: "after/**/*.txt", provider: { module: "destination" } },
          ],
        },
        async (reference) => {
          if (!("module" in reference))
            return createProviderLoader()(reference);
          return reference.module === "destination"
            ? {
                getattr: () => fileMetadata({ size: 9 }),
                readFile: () => "GENERATED",
              }
            : {
                getattr: ({ path: name }) =>
                  name === "before" || name === "before/nested"
                    ? directoryMetadata()
                    : name === "before/nested/data.txt"
                      ? fileMetadata({ size: 8 })
                      : undefined,
                readdir: ({ path: name }) =>
                  name === "before"
                    ? ["nested"]
                    : name === "before/nested"
                      ? ["data.txt"]
                      : [],
                rename: renamed,
              };
        },
      );
      await expect(filesystem.rename("before", "after")).rejects.toMatchObject({
        code: "EXDEV",
      });
      expect(renamed).not.toHaveBeenCalled();
      expect(
        await readFile(
          path.join(source, "before", "nested", "data.txt"),
          "utf8",
        ),
      ).toBe("ORIGINAL");
      await expect(stat(path.join(source, "after"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("retains nonopaque source fallback for descendants of a renamed directory", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "before", "nested"), { recursive: true });
    await writeFile(
      path.join(source, "before", "nested", "data.txt"),
      "ORIGINAL",
    );
    const filesystem = createFilesystem(source, { getattr: () => undefined }, [
      { match: "after/**/*.txt", provider: { module: "memory" } },
    ]);
    await filesystem.rename("before", "after");
    expect(
      (await filesystem.readFile("after/nested/data.txt")).toString(),
    ).toBe("ORIGINAL");
  });

  it("propagates destination metadata errors before moving a directory", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "before"));
    await writeFile(path.join(source, "before", "data.txt"), "ORIGINAL");
    const filesystem = createFilesystem(
      source,
      {
        getattr: () => {
          throw Object.assign(new Error("unavailable"), { code: "EACCES" });
        },
      },
      [{ match: "after/*.txt", provider: { module: "memory" } }],
    );
    await expect(filesystem.rename("before", "after")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(
      await readFile(path.join(source, "before", "data.txt"), "utf8"),
    ).toBe("ORIGINAL");
  });

  it("allows ordinary directory renames past hidden exact entries and unrelated roots", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "before"));
    await writeFile(path.join(source, "before", "native"), "native");
    const filesystem = createFilesystem(
      source,
      {
        getattr: ({ path: name }) =>
          name === "before/generated"
            ? fileMetadata({ size: 1 })
            : directoryMetadata(),
        readdir: () => [],
      },
      [
        { match: "before/generated", provider: { module: "memory" } },
        { match: "before/generated", hide: true },
        {
          match: "unrelated/**",
          root: "unrelated",
          opaque: true,
          provider: { module: "memory" },
        },
      ],
    );
    await filesystem.rename("before", "after");
    expect(await readFile(path.join(source, "after", "native"), "utf8")).toBe(
      "native",
    );
    expect(await filesystem.getattr("before")).toBeUndefined();
  });

  it.each([
    { opaque: true, readOnly: false, code: "ENOENT" },
    { opaque: false, readOnly: true, code: "EROFS" },
  ])(
    "rejects source-parent creation with opaque=$opaque and readOnly=$readOnly",
    async ({ opaque, readOnly, code }) => {
      const source = await createSource();
      const target = await createSource();
      await mkdir(path.join(source, "Proxy", "source-only"), {
        recursive: true,
      });
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          readOnly,
          rules: [
            {
              match: "Proxy/**",
              root: "Proxy",
              opaque,
              provider: { type: "directory", path: target },
            },
          ],
        },
        createProviderLoader(),
      );
      await expect(
        filesystem.create("Proxy/source-only/new", 0o644, 2),
      ).rejects.toMatchObject({ code });
      await expect(
        stat(path.join(source, "Proxy", "source-only", "new")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["EACCES", "EIO"])(
    "does not fall back to source after a proxy %s failure",
    async (code) => {
      const source = await createSource();
      await writeFile(path.join(source, "file"), "source");
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules: [
            {
              match: "file",
              provider: { type: "file", path: path.join(source, "target") },
            },
          ],
        },
        () =>
          Promise.resolve({
            getattr: () => {
              throw Object.assign(new Error("proxy failure"), { code });
            },
          }),
      );
      for (const operation of [
        filesystem.getattr("file"),
        filesystem.open("file", 0),
        filesystem.writeFile("file", Buffer.from("changed")),
      ]) {
        await expect(operation).rejects.toMatchObject({ code });
      }
      expect(await readFile(path.join(source, "file"), "utf8")).toBe("source");
    },
  );

  it("reconciles source and generated directory entries against later opaque child overrides", async () => {
    const source = await createSource();
    await mkdir(path.join(source, "Tree"));
    await writeFile(path.join(source, "passthrough.txt"), "source");
    await writeFile(path.join(source, "Tree", "source"), "source");
    const filesystem = new OverlayFileSystem(
      {
        name: "test",
        source,
        mountPoint: "/unused",
        rules: [
          { match: "Tree/**", root: "Tree", provider: { module: "tree" } },
          {
            match: "passthrough.txt",
            opaque: true,
            provider: { module: "empty" },
          },
          {
            match: "Tree/generated",
            opaque: true,
            provider: { module: "empty" },
          },
          { match: "Tree/source", opaque: true, provider: { module: "empty" } },
        ],
      },
      (reference) =>
        Promise.resolve(
          "module" in reference && reference.module === "tree"
            ? {
                getattr: ({ relativePath }) =>
                  relativePath === ""
                    ? { kind: "directory" }
                    : { kind: "file", size: 0 },
                readdir: () => ["generated", "visible"],
              }
            : {},
        ),
    );
    expect((await filesystem.readdir(""))?.map((entry) => entry.name)).toEqual([
      "Tree",
    ]);
    expect(
      (await filesystem.readdir("Tree"))?.map((entry) => entry.name),
    ).toEqual(["visible"]);
    for (const name of ["passthrough.txt", "Tree/generated", "Tree/source"])
      expect(await filesystem.getattr(name)).toBeUndefined();
  });

  it("accepts legal dot-prefixed file names without mistaking them for traversal", async () => {
    const source = await createSource();
    await writeFile(path.join(source, "..notes"), "value");
    const filesystem = createFilesystem(source, {}, []);
    expect((await filesystem.readFile("..notes")).toString()).toBe("value");
  });

  it.skipIf(process.platform === "win32").each(["source", "proxy"] as const)(
    "keeps literal backslashes distinct from path separators in %s names",
    async (kind) => {
      const source = await createSource();
      await mkdir(path.join(source, "dir"));
      await writeFile(path.join(source, "dir", "name"), "NESTED");
      await writeFile(path.join(source, "dir\\name"), "LITERAL");
      await writeFile(path.join(source, "..\\name"), "not traversal");
      const filesystem = new OverlayFileSystem(
        {
          name: "test",
          source,
          mountPoint: "/unused",
          rules:
            kind === "proxy"
              ? [
                  {
                    match: "Proxy/**",
                    root: "Proxy",
                    provider: { type: "directory", path: source },
                  },
                ]
              : [],
        },
        createProviderLoader(),
      );
      const prefix = kind === "proxy" ? "Proxy/" : "";
      expect(
        (await filesystem.readdir(prefix))?.map(({ name }) => name),
      ).toContain("dir\\name");
      expect((await filesystem.readFile(prefix + "dir\\name")).toString()).toBe(
        "LITERAL",
      );
      expect((await filesystem.readFile(prefix + "..\\name")).toString()).toBe(
        "not traversal",
      );
      await expect(filesystem.readFile(prefix + "dir/../name")).rejects.toThrow(
        "Invalid virtual path",
      );
      const handle = await filesystem.open(prefix + "dir\\name", 2);
      try {
        await filesystem.writeChunk(
          prefix + "dir\\name",
          Buffer.from("X"),
          0,
          2,
          handle,
        );
      } finally {
        await filesystem.release(prefix + "dir\\name", 2, handle);
      }
      await filesystem.rename(prefix + "dir\\name", prefix + "moved\\name");
      expect(await readFile(path.join(source, "moved\\name"), "utf8")).toBe(
        "XITERAL",
      );
      await filesystem.unlink(prefix + "moved\\name");
      expect(await readFile(path.join(source, "dir", "name"), "utf8")).toBe(
        "NESTED",
      );
      await expect(stat(path.join(source, "dir\\name"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

async function createSource(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "scriptfs-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createFilesystem(
  source: string,
  provider: ScriptFsProvider,
  rules: import("../src/types.js").OverlayRule[],
): OverlayFileSystem {
  const loader: ProviderLoader = () => Promise.resolve(provider);
  return new OverlayFileSystem(
    {
      name: "test",
      source,
      mountPoint: path.join(source, "mount"),
      rules,
    },
    loader,
  );
}
