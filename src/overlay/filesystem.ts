import { constants } from "node:fs";
import {
  access as fsAccess,
  chmod as fsChmod,
  lchown as fsLchown,
  lstat,
  lutimes as fsLutimes,
  mkdir,
  open as fsOpen,
  readlink,
  readdir,
  rename,
  rm,
  rmdir as fsRmdir,
  stat,
  statfs,
  truncate,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import type {
  DirectoryEntry,
  FileAttributeChanges,
  FileHandleContext,
  FilesystemConfig,
  FilesystemStatistics,
  NodeMetadata,
  ProviderContext,
  ScriptFsProvider,
} from "../types.js";
import type { ProviderLoader } from "./provider-loader.js";
import { proxyTargetPath } from "./proxy-provider.js";
import {
  nativeMetadata as metadataFromStat,
  openNativeFile,
  readNativeFile,
  UnsupportedNativeNodeError,
  writeNativeFile,
} from "./native.js";
import {
  compileRules,
  normalizeVirtualPath,
  rootChildForDirectory,
  staticChildForDirectory,
  type CompiledProviderRule,
} from "./rules.js";

interface ResolvedProvider {
  rule: CompiledProviderRule;
  provider: ScriptFsProvider;
  context: ProviderContext;
}

export interface OverlayFileHandle {
  readonly binding: ResolvedProvider | undefined;
  readonly value: unknown;
  readonly native?: FileHandle;
  readonly nativeMetadata?: NodeMetadata;
}

export class OverlayFileSystem {
  readonly #config: FilesystemConfig;
  readonly #loadProvider: ProviderLoader;
  readonly #rules;
  readonly #signal: AbortSignal;

  constructor(
    config: FilesystemConfig,
    loadProvider: ProviderLoader,
    signal: AbortSignal = new AbortController().signal,
  ) {
    this.#config = config;
    this.#loadProvider = loadProvider;
    this.#rules = compileRules(config.rules ?? []);
    this.#signal = signal;
  }

  async statfs(inputPath: string): Promise<FilesystemStatistics> {
    const virtualPath = normalizeVirtualPath(inputPath);
    const resolved = await this.#resolveProvider(virtualPath);
    const reference = resolved?.rule.rule.provider;
    const backing =
      reference && !("module" in reference)
        ? reference.path
        : this.#config.source;
    const statistics = await statfs(backing);
    return {
      bsize: statistics.bsize,
      blocks: statistics.blocks,
      bfree: statistics.bfree,
      bavail: statistics.bavail,
      files: statistics.files,
      ffree: statistics.ffree,
      frsize: statistics.bsize,
      favail: statistics.ffree,
      fsid: 0,
      flag: this.#config.readOnly ? 1 : 0,
      namemax: 255,
    };
  }

  async getattr(
    inputPath: string,
    binding?: Pick<OverlayFileHandle, "binding">,
  ): Promise<NodeMetadata | undefined> {
    const virtualPath = normalizeVirtualPath(inputPath);
    if (virtualPath === "") {
      return metadataFromStat(
        await lstat(this.#config.source, { bigint: true }),
      );
    }
    if (!binding && this.#rules.hidden(virtualPath)) {
      return undefined;
    }

    const resolved = binding
      ? this.#boundProvider(virtualPath, binding)
      : await this.#resolveProvider(virtualPath);
    if (this.#generatedAncestor(virtualPath, resolved?.rule)) {
      const nativePath = this.#nativeDirectoryPath(virtualPath, resolved);
      if (nativePath !== undefined) {
        try {
          const native = await stat(nativePath, { bigint: true });
          if (native.isDirectory()) return metadataFromStat(native);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      return normalizeMetadata({ kind: "directory", mode: 0o755 });
    }
    if (resolved?.provider.getattr) {
      const metadata = await resolved.provider.getattr(resolved.context);
      if (metadata) {
        let withDefaults =
          metadata.kind === "file"
            ? { ...resolved.rule.rule.file, ...metadata, kind: "file" as const }
            : metadata;
        const declaredSize = withDefaults.size;
        const nativePath =
          metadata.kind === "directory"
            ? this.#nativeDirectoryPath(virtualPath, resolved)
            : metadata.kind === "file"
              ? this.#nativePath(virtualPath, resolved)
              : undefined;
        if (
          "module" in resolved.rule.rule.provider &&
          nativePath !== undefined
        ) {
          try {
            const native = metadataFromStat(
              await stat(nativePath, { bigint: true }),
            );
            if (native.kind === metadata.kind)
              withDefaults = {
                ...native,
                ...withDefaults,
                identity: native.identity,
              };
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        }
        return this.#normalizeProviderMetadata(
          withDefaults,
          resolved,
          declaredSize,
        );
      }
    }
    if (resolved?.rule.rule.opaque) {
      return undefined;
    }

    let metadata: NodeMetadata;
    try {
      metadata = metadataFromStat(
        await lstat(this.#sourcePath(virtualPath), { bigint: true }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    if (
      metadata.kind === "file" &&
      resolved &&
      resolved.provider.getattr === undefined &&
      this.#nativePath(virtualPath, resolved) === undefined
    ) {
      const defaults = resolved.rule.rule.file;
      const size =
        defaults?.size ??
        (resolved.provider.readFile ? undefined : metadata.size);
      return this.#normalizeProviderMetadata(
        {
          ...metadata,
          ...defaults,
          size,
          sizeMode:
            defaults?.sizeMode ?? (size === undefined ? "content" : "explicit"),
        },
        resolved,
        defaults?.size,
      );
    }
    return this.#scopeIdentity(metadata, resolved);
  }

  async #normalizeProviderMetadata(
    metadata: NodeMetadata,
    resolved: ResolvedProvider,
    declaredSize: number | undefined,
  ): Promise<NodeMetadata> {
    const normalized = normalizeMetadata(metadata);
    const sizeMode =
      metadata.sizeMode ??
      (metadata.size === undefined ? "content" : "explicit");
    normalized.sizeMode = sizeMode;
    normalized.seekable = metadata.seekable ?? true;
    if (
      metadata.kind === "file" &&
      metadata.size === undefined &&
      sizeMode === "content" &&
      resolved.provider.readFile
    ) {
      normalized.size = Buffer.byteLength(
        await resolved.provider.readFile(resolved.context),
      );
    } else if (sizeMode === "zero") {
      normalized.size = 0;
    } else if (sizeMode === "unbounded") {
      normalized.size = declaredSize ?? 0x7fff_ffff_ffff;
    }
    return this.#scopeIdentity(normalized, resolved);
  }

  async readdir(inputPath: string): Promise<DirectoryEntry[] | undefined> {
    const virtualPath = normalizeVirtualPath(inputPath);
    if (this.#rules.hidden(virtualPath)) return undefined;
    const resolved = await this.#resolveProvider(virtualPath);
    const resolvedIndex = resolved
      ? this.#rules.providers.indexOf(resolved.rule)
      : this.#rules.providers.findLastIndex((rule) =>
          rule.matches(virtualPath),
        );
    const entries = new Map<string, DirectoryEntry>();
    let baseExists = false;

    try {
      for (const entry of resolved?.rule.rule.opaque
        ? []
        : await readdir(this.#sourcePath(virtualPath), {
            withFileTypes: true,
          })) {
        const childPath = joinVirtual(virtualPath, entry.name);
        if (!this.#rules.hidden(childPath)) {
          entries.set(entry.name, {
            name: entry.name,
            metadata: metadataFromDirent(entry),
          });
        }
      }
      baseExists = !resolved?.rule.rule.opaque;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    let providerExists = false;
    for (const [index, rule] of this.#rules.providers.entries()) {
      const provider = await this.#loadProvider(rule.rule.provider);
      if (
        provider.readdir &&
        isWithinRuleRoot(rule.root, virtualPath) &&
        index >= resolvedIndex
      ) {
        const generated = await provider.readdir(
          this.#context(rule, virtualPath),
        );
        if (generated) {
          providerExists = true;
          for (const entry of generated) {
            const normalized =
              typeof entry === "string" ? { name: entry } : entry;
            const childPath = joinVirtual(virtualPath, normalized.name);
            if (
              !this.#rules.hidden(childPath) &&
              (!resolved || resolved.rule === rule || rule.matches(childPath))
            ) {
              entries.set(normalized.name, normalized);
            }
          }
        }
      }

      const staticChild = staticChildForDirectory(rule.rule.match, virtualPath);
      if (staticChild && provider.getattr) {
        const childPath = joinVirtual(virtualPath, staticChild);
        if (!this.#rules.hidden(childPath)) {
          const metadata = await this.#listingMetadata(childPath, rule);
          if (metadata) {
            providerExists = true;
            entries.set(staticChild, {
              name: staticChild,
              metadata,
            });
          }
        }
      }
      const rootChild = rule.exposeRoot
        ? rootChildForDirectory(rule.root, virtualPath)
        : undefined;
      if (
        rootChild &&
        !this.#rules.hidden(joinVirtual(virtualPath, rootChild)) &&
        (await this.#listingMetadata(joinVirtual(virtualPath, rootChild)))
      ) {
        providerExists = true;
        entries.set(rootChild, {
          name: rootChild,
          metadata: { kind: "directory", mode: 0o755 },
        });
      }
    }

    if (!baseExists && !providerExists) return undefined;
    const visible = await Promise.all(
      [...entries.values()].map(async (entry) => {
        const metadata = await this.#listingMetadata(
          joinVirtual(virtualPath, entry.name),
        );
        return metadata ? { ...entry, metadata } : undefined;
      }),
    );
    return visible.filter((entry) => entry !== undefined);
  }

  async #listingMetadata(
    virtualPath: string,
    rule?: CompiledProviderRule,
  ): Promise<NodeMetadata | undefined> {
    try {
      if (rule) {
        const resolved = await this.#resolveProvider(virtualPath);
        if (resolved?.rule !== rule) return undefined;
        const metadata = await resolved.provider.getattr?.(resolved.context);
        return metadata && normalizeMetadata(metadata);
      }
      return await this.getattr(virtualPath);
    } catch (error) {
      if (error instanceof UnsupportedNativeNodeError) return undefined;
      throw error;
    }
  }

  async readlink(inputPath: string): Promise<string> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertVisible(virtualPath);
    const resolved = await this.#resolveProvider(virtualPath);
    if (resolved?.provider.readlink) {
      return resolved.provider.readlink(resolved.context);
    }
    const metadata = await this.getattr(virtualPath);
    if (metadata?.kind === "symlink" && metadata.target !== undefined) {
      return metadata.target;
    }
    if (resolved?.rule.rule.opaque) throw notFound(virtualPath);
    return readlink(this.#sourcePath(virtualPath));
  }

  async readFile(
    inputPath: string,
    binding?: OverlayFileHandle | Pick<OverlayFileHandle, "binding">,
    flags = 0,
  ): Promise<Buffer> {
    const virtualPath = normalizeVirtualPath(inputPath);
    if (!binding) this.#assertVisible(virtualPath);
    const resolved = binding
      ? this.#boundProvider(virtualPath, binding)
      : await this.#resolveProvider(virtualPath);
    if (resolved?.provider.readFile) {
      return Buffer.from(await resolved.provider.readFile(resolved.context));
    }
    if (resolved?.provider.read) {
      const retained =
        binding && "value" in binding && (flags & 3) !== 1
          ? binding
          : undefined;
      const readFlags = retained ? flags : 0;
      const handle: OverlayFileHandle = retained ?? {
        binding: resolved,
        value: await resolved.provider.open?.(
          this.#handleContext(resolved, readFlags, undefined),
        ),
      };
      let contents: Buffer;
      try {
        const metadata = await this.fgetattr(
          virtualPath,
          readFlags,
          handle,
          await this.getattr(virtualPath, handle),
        );
        contents = await this.#readPositionalContents(
          virtualPath,
          readFlags,
          handle,
          metadata,
        );
      } catch (error) {
        if (retained) throw error;
        return rollbackResources(error, () =>
          this.release(virtualPath, readFlags, handle),
        );
      }
      if (!retained) await this.release(virtualPath, readFlags, handle);
      return contents;
    }
    if (resolved?.rule.rule.opaque) {
      throw notFound(virtualPath);
    }
    return readNativeFile(this.#sourcePath(virtualPath));
  }

  async writeFile(
    inputPath: string,
    contents: Buffer,
    binding?: Pick<OverlayFileHandle, "binding">,
  ): Promise<void> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertWritable();
    if (!binding) this.#assertVisible(virtualPath);
    const resolved = binding
      ? this.#boundProvider(virtualPath, binding)
      : await this.#resolveProvider(virtualPath);
    if (resolved?.provider.writeFile) {
      let previousContents: Buffer | undefined;
      try {
        const metadata = await this.getattr(virtualPath, binding);
        previousContents =
          metadata?.size === 0 && metadata.sizeMode !== "unbounded"
            ? Buffer.alloc(0)
            : await this.readFile(virtualPath, binding);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
      await resolved.provider.writeFile(contents, {
        ...resolved.context,
        previousContents,
      });
      return;
    }
    if (resolved?.rule.rule.opaque) {
      throw readOnly(virtualPath);
    }
    await writeNativeFile(this.#sourcePath(virtualPath), contents);
  }

  async open(inputPath: string, flags: number): Promise<OverlayFileHandle> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertVisible(virtualPath);
    if ((flags & 3) !== 0 || (flags & 0x200) !== 0) this.#assertWritable();
    const resolved = await this.#resolveProvider(virtualPath);
    const nativePath = this.#nativePath(virtualPath, resolved);
    const value = resolved?.provider.open
      ? await resolved.provider.open(
          this.#handleContext(resolved, flags, undefined),
        )
      : undefined;
    let native: FileHandle | undefined;
    try {
      native =
        nativePath === undefined
          ? undefined
          : await openNativeFile(
              nativePath,
              (flags & ~0x200) |
                (resolved?.rule.rule.provider.type === "file"
                  ? constants.O_NOFOLLOW
                  : 0),
            );
      return await this.#openedHandle(resolved, value, native);
    } catch (error) {
      return rollbackResources(error, () =>
        releaseResources(native, () =>
          resolved?.provider.open
            ? resolved.provider.release?.(
                this.#handleContext(resolved, flags, value),
              )
            : undefined,
        ),
      );
    }
  }

  async create(
    inputPath: string,
    mode: number,
    flags: number,
  ): Promise<OverlayFileHandle> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertWritable();
    this.#assertVisible(virtualPath);
    const fileMode = mode & 0o7777;
    const resolved = await this.#resolveProvider(virtualPath, true);
    const nativePath = this.#nativePath(virtualPath, resolved);
    if (nativePath !== undefined) {
      if (resolved?.rule.rule.provider.type === "file")
        throw readOnly(virtualPath);
      const customCreate =
        resolved &&
        "module" in resolved.rule.rule.provider &&
        resolved.provider.create !== undefined;
      const value = customCreate
        ? await resolved.provider.create?.(
            { kind: "file", mode: fileMode, size: 0, sizeMode: "explicit" },
            this.#handleContext(resolved, flags, undefined),
          )
        : undefined;
      let native: FileHandle | undefined;
      let acquiredProvider = Boolean(customCreate);
      let opened = value;
      try {
        native = await openNativeFile(
          nativePath,
          (flags &
            ~(constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC)) |
            (customCreate ? 0 : constants.O_CREAT | constants.O_EXCL),
          fileMode,
        );
        if (!customCreate && resolved?.provider.open) {
          opened = await resolved.provider.open(
            this.#handleContext(resolved, flags, undefined),
          );
          acquiredProvider = true;
        }
        return await this.#openedHandle(resolved, opened, native);
      } catch (error) {
        // The pathname may have been replaced or written since creation.
        return rollbackResources(error, () =>
          releaseResources(native, () =>
            acquiredProvider && resolved
              ? resolved.provider.release?.(
                  this.#handleContext(resolved, flags, opened),
                )
              : undefined,
          ),
        );
      }
    }
    if (resolved?.provider.create) {
      const value = await resolved.provider.create(
        { kind: "file", mode: fileMode, size: 0, sizeMode: "explicit" },
        this.#handleContext(resolved, flags, undefined),
      );
      return { binding: resolved, value };
    }
    if (resolved?.provider.writeFile) {
      await resolved.provider.writeFile(Buffer.alloc(0), {
        ...resolved.context,
        previousContents: undefined,
      });
    }
    if (resolved?.provider.open) {
      const value = await resolved.provider.open(
        this.#handleContext(resolved, flags, undefined),
      );
      return { binding: resolved, value };
    }
    if (resolved?.provider.write && !resolved.provider.writeFile) {
      throw Object.assign(
        new Error(
          "Positional providers must implement create or open to create a file",
        ),
        { code: "EOPNOTSUPP" },
      );
    }
    if (
      resolved?.rule.rule.opaque &&
      !resolved.provider.write &&
      !resolved.provider.writeFile
    ) {
      throw readOnly(virtualPath);
    }
    if (!resolved?.provider.write && !resolved?.provider.writeFile) {
      const handle = await fsOpen(
        this.#sourcePath(virtualPath),
        "wx",
        fileMode,
      );
      await handle.close();
    }
    return { binding: resolved, value: undefined };
  }

  async readChunk(
    inputPath: string,
    position: number,
    length: number,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<Buffer | undefined> {
    const virtualPath = normalizeVirtualPath(inputPath);
    if (handle.native) {
      const contents = Buffer.alloc(length);
      const { bytesRead } = await handle.native.read(
        contents,
        0,
        length,
        position,
      );
      return contents.subarray(0, bytesRead);
    }

    const resolved = this.#boundProvider(virtualPath, handle);
    if (!resolved?.provider.read) {
      return undefined;
    }
    return Buffer.from(
      await resolved.provider.read(
        position,
        length,
        this.#handleContext(resolved, flags, handle.value),
      ),
    );
  }

  async fgetattr(
    inputPath: string,
    flags: number,
    handle: OverlayFileHandle,
    openedMetadata?: NodeMetadata,
  ): Promise<NodeMetadata | undefined> {
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    const suppliedMetadata = resolved?.provider.fgetattr
      ? await resolved.provider.fgetattr(
          this.#handleContext(resolved, flags, handle.value),
        )
      : handle.nativeMetadata;
    const metadata =
      suppliedMetadata && this.#scopeIdentity(suppliedMetadata, resolved);
    if (resolved?.provider.fgetattr && !metadata) return undefined;
    const native = handle.native
      ? this.#scopeIdentity(
          metadataFromStat(await handle.native.stat({ bigint: true })),
          resolved,
        )
      : undefined;
    const base = metadata ?? native;
    if (base) {
      const defaults =
        (metadata ?? native)?.kind === "file"
          ? resolved?.rule.rule.file
          : undefined;
      const overrides = { ...defaults, ...metadata };
      if (native && openedMetadata && !resolved?.provider.fgetattr) {
        // Captured decorations follow acknowledged handle mutations; other fields stay live.
        for (const field of [
          "size",
          "mode",
          "uid",
          "gid",
          "atime",
          "mtime",
        ] as const) {
          if (
            overrides[field] !== undefined &&
            openedMetadata[field] !== undefined
          )
            Object.assign(overrides, { [field]: openedMetadata[field] });
        }
      }
      const withDefaults = {
        ...native,
        ...overrides,
        kind: base.kind,
        identity:
          native?.identity ?? metadata?.identity ?? openedMetadata?.identity,
      };
      const normalized = normalizeMetadata(withDefaults);
      if (normalized.sizeMode === "zero") normalized.size = 0;
      else if (normalized.sizeMode === "unbounded")
        normalized.size = metadata?.size ?? defaults?.size ?? 0x7fff_ffff_ffff;
      return normalized;
    }
    return handle.value === undefined
      ? this.getattr(inputPath, handle)
      : openedMetadata;
  }

  async fsetattr(
    inputPath: string,
    changes: FileAttributeChanges,
    flags: number,
    handle: OverlayFileHandle,
    detached: boolean,
  ): Promise<void> {
    this.#assertWritable();
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    if (resolved?.provider.fsetattr) {
      await resolved.provider.fsetattr(
        changes,
        this.#handleContext(resolved, flags, handle.value),
      );
      return;
    }
    if (handle.native) {
      if (changes.mode !== undefined) await handle.native.chmod(changes.mode);
      if (changes.uid !== undefined || changes.gid !== undefined)
        await handle.native.chown(changes.uid ?? -1, changes.gid ?? -1);
      if (changes.atime !== undefined || changes.mtime !== undefined) {
        const current = await handle.native.stat();
        await handle.native.utimes(
          changes.atime ?? current.atime,
          changes.mtime ?? current.mtime,
        );
      }
      return;
    }
    if (detached)
      throw Object.assign(
        new Error(
          "Detached provider resources need fsetattr for metadata changes",
        ),
        { code: "EOPNOTSUPP" },
      );
    if (changes.mode !== undefined) await this.chmod(inputPath, changes.mode);
    if (changes.uid !== undefined || changes.gid !== undefined)
      await this.chown(inputPath, changes.uid ?? -1, changes.gid ?? -1);
    if (changes.atime !== undefined || changes.mtime !== undefined) {
      const current = await this.getattr(inputPath);
      if (!current?.atime || !current.mtime) throw notFound(inputPath);
      await this.utimens(
        inputPath,
        changes.atime ?? current.atime,
        changes.mtime ?? current.mtime,
      );
    }
  }

  async writeChunk(
    inputPath: string,
    contents: Buffer,
    position: number,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<number | undefined> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertWritable();
    if (handle.native) {
      return (await handle.native.write(contents, 0, contents.length, position))
        .bytesWritten;
    }
    const resolved = this.#boundProvider(virtualPath, handle);
    if (!resolved?.provider.write) {
      return undefined;
    }
    const written = await resolved.provider.write(
      contents,
      position,
      this.#handleContext(resolved, flags, handle.value),
    );
    return written ?? contents.length;
  }

  async flush(
    inputPath: string,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<void> {
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    await resolved?.provider.flush?.(
      this.#handleContext(resolved, flags, handle.value),
    );
  }

  async fsync(
    inputPath: string,
    dataSync: boolean,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<void> {
    if (handle.native) {
      await (dataSync ? handle.native.datasync() : handle.native.sync());
    }
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    await resolved?.provider.fsync?.(
      dataSync,
      this.#handleContext(resolved, flags, handle.value),
    );
  }

  async release(
    inputPath: string,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<void> {
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    await releaseResources(handle.native, () =>
      resolved?.provider.release?.(
        this.#handleContext(resolved, flags, handle.value),
      ),
    );
  }

  async opendir(inputPath: string, flags: number): Promise<OverlayFileHandle> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertVisible(virtualPath);
    const resolved = await this.#resolveProvider(virtualPath);
    const value = resolved?.provider.opendir
      ? await resolved.provider.opendir(
          this.#handleContext(resolved, flags, undefined),
        )
      : undefined;
    const nativePath = this.#nativeDirectoryPath(virtualPath, resolved);
    let native: FileHandle | undefined;
    try {
      if (nativePath !== undefined) {
        try {
          native = await fsOpen(
            nativePath,
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
        } catch (error) {
          if (
            !isNotFound(error) ||
            (await this.getattr(virtualPath))?.kind !== "directory"
          )
            throw error;
        }
      }
      return await this.#openedHandle(resolved, value, native);
    } catch (error) {
      return rollbackResources(error, () =>
        releaseResources(native, () =>
          resolved?.provider.opendir
            ? resolved.provider.releasedir?.(
                this.#handleContext(resolved, flags, value),
              )
            : undefined,
        ),
      );
    }
  }

  async fsyncdir(
    inputPath: string,
    dataSync: boolean,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<void> {
    try {
      if (handle.native)
        await (dataSync ? handle.native.datasync() : handle.native.sync());
      const resolved = this.#boundProvider(
        normalizeVirtualPath(inputPath),
        handle,
      );
      if (resolved?.provider.fsyncdir) {
        await resolved.provider.fsyncdir(
          dataSync,
          this.#handleContext(resolved, flags, handle.value),
        );
      } else if (!handle.native) {
        throw Object.assign(
          new Error(
            "Directory synchronization is not implemented by this provider",
          ),
          { code: "EOPNOTSUPP" },
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOSYS"
      ) {
        // ENOSYS disables fsyncdir for the entire FUSE mount, not just this provider.
        throw Object.assign(
          new Error("Directory synchronization is unsupported", {
            cause: error,
          }),
          { code: "EOPNOTSUPP" },
        );
      }
      throw error;
    }
  }

  async releasedir(
    inputPath: string,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<void> {
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    await releaseResources(handle.native, () =>
      resolved?.provider.releasedir?.(
        this.#handleContext(resolved, flags, handle.value),
      ),
    );
  }

  async mkdir(inputPath: string, mode = 0o755): Promise<void> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertWritable();
    this.#assertVisible(virtualPath);
    const resolved = await this.#resolveProvider(virtualPath, true);
    if (resolved?.provider.mkdir) {
      await resolved.provider.mkdir(
        { kind: "directory", mode },
        resolved.context,
      );
      return;
    }

    if (resolved?.rule.rule.opaque) {
      throw readOnly(virtualPath);
    }
    await mkdir(this.#sourcePath(virtualPath), { mode });
  }

  async truncate(
    inputPath: string,
    size: number,
    binding?: Pick<OverlayFileHandle, "binding">,
  ): Promise<boolean> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertWritable();
    if (!binding) this.#assertVisible(virtualPath);
    const resolved = binding
      ? this.#boundProvider(virtualPath, binding)
      : await this.#resolveProvider(virtualPath);
    if (resolved?.provider.truncate) {
      await resolved.provider.truncate(size, resolved.context);
      return true;
    }
    if (resolved?.provider.writeFile) {
      return false;
    }
    if (resolved?.rule.rule.opaque) {
      throw readOnly(virtualPath);
    }
    await truncate(this.#sourcePath(virtualPath), size);
    return true;
  }

  async positional(
    inputPath: string,
    handle?: OverlayFileHandle,
  ): Promise<boolean> {
    if (handle)
      return (
        Boolean(handle.native) ||
        handle.binding?.provider.read !== undefined ||
        handle.binding?.provider.write !== undefined
      );
    const resolved = await this.#resolveProvider(
      normalizeVirtualPath(inputPath),
    );
    return (
      this.#nativePath(normalizeVirtualPath(inputPath), resolved) !==
        undefined ||
      resolved?.provider.read !== undefined ||
      resolved?.provider.write !== undefined
    );
  }

  async snapshot(
    inputPath: string,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<Buffer | undefined> {
    if (handle.native) return undefined;
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    const bufferedWrites =
      resolved?.provider.writeFile !== undefined &&
      resolved.provider.write === undefined;
    if (
      handle.value !== undefined &&
      resolved?.provider.read &&
      !bufferedWrites
    )
      return undefined;
    if (!resolved || resolved.provider.readFile)
      return this.readFile(inputPath, handle, flags);
    if (handle.value !== undefined && !bufferedWrites) return undefined;
    const metadata = await this.fgetattr(
      inputPath,
      flags,
      handle,
      await this.getattr(inputPath, handle),
    );
    if (metadata?.sizeMode === "unbounded" || metadata?.size === undefined) {
      throw Object.assign(
        new Error(
          "An unbounded positional file needs a stable open handle before unlink or replacement",
        ),
        { code: "EBUSY" },
      );
    }
    return (flags & 3) === 1
      ? this.readFile(inputPath, handle, flags)
      : this.#readPositionalContents(inputPath, flags, handle, metadata);
  }

  async #readPositionalContents(
    inputPath: string,
    flags: number,
    handle: OverlayFileHandle,
    metadata: NodeMetadata | undefined,
  ): Promise<Buffer> {
    if (!metadata) throw notFound(inputPath);
    if (metadata.kind === "directory")
      throw Object.assign(new Error(`Is a directory: ${inputPath}`), {
        code: "EISDIR",
      });
    if (
      metadata.sizeMode === "unbounded" ||
      metadata.size === undefined ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      (metadata.seekable === false && metadata.size !== 0)
    ) {
      throw Object.assign(
        new Error(
          "Whole-file buffering requires a finite, seekable positional file",
        ),
        { code: "EOPNOTSUPP" },
      );
    }
    const contents = Buffer.alloc(metadata.size);
    let position = 0;
    while (position < contents.length) {
      if (
        !handle.native &&
        handle.value === undefined &&
        metadata.identity !== undefined
      ) {
        let current: NodeMetadata | undefined;
        try {
          current = await this.getattr(inputPath, handle);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        if (
          current?.identity !== metadata.identity ||
          current.kind !== metadata.kind
        )
          throw Object.assign(
            new Error(`Resource changed while buffering: ${inputPath}`),
            { code: "ESTALE" },
          );
      }
      const chunk = await this.readChunk(
        inputPath,
        position,
        Math.min(contents.length - position, 65_536),
        flags,
        handle,
      );
      if (!chunk) throw readOnly(inputPath);
      if (chunk.length === 0) break;
      position += chunk.copy(
        contents,
        position,
        0,
        Math.min(chunk.length, contents.length - position),
      );
    }
    return contents.subarray(0, position);
  }

  async assertSameProvider(source: string, destination: string): Promise<void> {
    const from = await this.#resolveProvider(normalizeVirtualPath(source));
    const to = await this.#resolveProvider(
      normalizeVirtualPath(destination),
      false,
      from ? undefined : (await this.getattr(source))?.kind,
    );
    if (from?.rule !== to?.rule) {
      throw Object.assign(new Error("Cannot rename across overlay providers"), {
        code: "EXDEV",
      });
    }
  }

  async ftruncate(
    inputPath: string,
    size: number,
    flags: number,
    handle: OverlayFileHandle,
  ): Promise<boolean> {
    this.#assertWritable();
    const resolved = this.#boundProvider(
      normalizeVirtualPath(inputPath),
      handle,
    );
    if (resolved?.provider.ftruncate) {
      await resolved.provider.ftruncate(
        size,
        this.#handleContext(resolved, flags, handle.value),
      );
      return true;
    }
    if (handle.native) {
      await handle.native.truncate(size);
      return true;
    }
    if (
      handle.value !== undefined &&
      (resolved?.provider.read || resolved?.provider.write)
    ) {
      if (resolved.provider.writeFile && !resolved.provider.write) return false;
      throw Object.assign(
        new Error(
          "Positional providers with open resources must implement ftruncate",
        ),
        { code: "ENOSYS" },
      );
    }
    return this.truncate(inputPath, size, handle);
  }

  async access(inputPath: string, mode: number): Promise<void> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertVisible(virtualPath);
    if (mode & 2) this.#assertWritable();
    const resolved = await this.#resolveProvider(virtualPath);
    if (resolved?.provider.access) {
      await resolved.provider.access(mode, resolved.context);
      return;
    }
    if (virtualPath === "") {
      await fsAccess(this.#config.source, mode);
      return;
    }
    const generated = this.#generatedAncestor(virtualPath, resolved?.rule)
      ? await this.getattr(virtualPath)
      : await resolved?.provider.getattr?.(resolved.context);
    if (generated) {
      const metadata = normalizeMetadata(
        generated.kind === "file"
          ? { ...resolved?.rule.rule.file, ...generated }
          : generated,
      );
      assertMetadataAccess(metadata, mode);
      return;
    }
    if (resolved?.rule.rule.opaque) throw notFound(virtualPath);
    await fsAccess(this.#sourcePath(virtualPath), mode);
  }

  async chmod(inputPath: string, mode: number): Promise<void> {
    await this.#metadataOperation(
      inputPath,
      (resolved) => resolved.provider.chmod !== undefined,
      (resolved) => resolved.provider.chmod?.(mode, resolved.context),
      () => fsChmod(this.#sourcePath(normalizeVirtualPath(inputPath)), mode),
    );
  }

  async chown(inputPath: string, uid: number, gid: number): Promise<void> {
    await this.#metadataOperation(
      inputPath,
      (resolved) => resolved.provider.chown !== undefined,
      (resolved) => resolved.provider.chown?.(uid, gid, resolved.context),
      () =>
        fsLchown(this.#sourcePath(normalizeVirtualPath(inputPath)), uid, gid),
    );
  }

  async utimens(inputPath: string, atime: Date, mtime: Date): Promise<void> {
    await this.#metadataOperation(
      inputPath,
      (resolved) => resolved.provider.utimens !== undefined,
      (resolved) => resolved.provider.utimens?.(atime, mtime, resolved.context),
      () =>
        fsLutimes(
          this.#sourcePath(normalizeVirtualPath(inputPath)),
          atime,
          mtime,
        ),
    );
  }

  async unlink(inputPath: string): Promise<void> {
    await this.#remove(inputPath, false);
  }

  async rmdir(inputPath: string): Promise<void> {
    await this.#remove(inputPath, true);
  }

  async rename(source: string, destination: string): Promise<void> {
    const sourcePath = normalizeVirtualPath(source);
    const destinationPath = normalizeVirtualPath(destination);
    this.#assertWritable();
    this.#assertVisible(sourcePath);
    this.#assertVisible(destinationPath);
    const resolved = await this.#resolveProvider(sourcePath);
    const target = await this.#resolveProvider(destinationPath);
    if (resolved?.rule !== target?.rule) {
      throw Object.assign(new Error("Cannot rename across overlay providers"), {
        code: "EXDEV",
      });
    }
    if (
      resolved?.rule.rule.provider.type === "file" &&
      sourcePath !== destinationPath
    ) {
      throw Object.assign(new Error("Cannot rename a fixed file proxy"), {
        code: "EXDEV",
      });
    }
    const from = await this.getattr(sourcePath);
    const to = await this.getattr(destinationPath);
    const sameNode =
      sourcePath === destinationPath ||
      (from?.identity !== undefined && from.identity === to?.identity);
    if (
      !sameNode &&
      ((await this.#hasMultipleBackings(sourcePath, resolved, "rename")) ||
        (to?.kind === "directory" &&
          (await this.#hasMultipleBackings(destinationPath, target, "rename"))))
    ) {
      throw Object.assign(
        new Error("Cannot rename a path with multiple overlay backings"),
        { code: "EXDEV" },
      );
    }
    if (!sameNode && to?.kind === "directory") {
      await this.#assertDirectoryEmpty(destinationPath);
    }
    if (!sameNode && from?.kind === "directory") {
      await this.#assertRenameOwnership(
        sourcePath,
        destinationPath,
        resolved?.rule,
      );
    }
    if (resolved?.provider.rename) {
      await resolved.provider.rename({
        ...resolved.context,
        destinationPath,
        destinationRelativePath: relativeToRule(
          resolved.rule.root,
          destinationPath,
        ),
      });
      return;
    }
    if (resolved?.rule.rule.opaque) {
      throw readOnly(sourcePath);
    }
    await rename(
      this.#sourcePath(sourcePath),
      this.#sourcePath(destinationPath),
    );
  }

  async #assertRenameOwnership(
    virtualPath: string,
    destinationPath: string,
    owner: CompiledProviderRule | undefined,
  ): Promise<void> {
    const crossing = (): Error =>
      Object.assign(
        new Error(
          "Cannot rename a directory containing another provider's subtree",
        ),
        { code: "EXDEV" },
      );
    if (this.#generatedAncestor(virtualPath, owner)) throw crossing();
    if (
      !this.#rules.providers.some(
        (rule) =>
          isWithinRuleRoot(rule.root, virtualPath) ||
          isWithinRuleRoot(virtualPath, rule.root) ||
          isWithinRuleRoot(rule.root, destinationPath) ||
          isWithinRuleRoot(destinationPath, rule.root),
      )
    )
      return;
    for (const entry of (await this.readdir(virtualPath)) ?? []) {
      const childPath = joinVirtual(virtualPath, entry.name);
      const destinationChild = joinVirtual(destinationPath, entry.name);
      const child = await this.#resolveProvider(childPath);
      if (child?.rule !== owner) throw crossing();
      await this.assertSameProvider(childPath, destinationChild);
      if (entry.metadata?.kind === "directory")
        await this.#assertRenameOwnership(childPath, destinationChild, owner);
    }
  }

  async #remove(inputPath: string, directory: boolean): Promise<void> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertWritable();
    this.#assertVisible(virtualPath);
    const resolved = await this.#resolveProvider(virtualPath);
    if (directory) await this.#assertDirectoryEmpty(virtualPath);
    if (
      await this.#hasMultipleBackings(
        virtualPath,
        resolved,
        directory ? "rmdir" : "unlink",
      )
    ) {
      throw Object.assign(
        new Error("Cannot remove a path with multiple overlay backings"),
        { code: "EOPNOTSUPP" },
      );
    }
    if (resolved) {
      if (directory && resolved.provider.rmdir) {
        await resolved.provider.rmdir(resolved.context);
        return;
      }
      if (!directory && resolved.provider.unlink) {
        await resolved.provider.unlink(resolved.context);
        return;
      }
    }
    if (resolved?.rule.rule.opaque) {
      throw readOnly(virtualPath);
    }
    if (directory) {
      await fsRmdir(this.#sourcePath(virtualPath));
    } else {
      await rm(this.#sourcePath(virtualPath));
    }
  }

  async #metadataOperation(
    inputPath: string,
    supportsProviderOperation: (resolved: ResolvedProvider) => boolean,
    providerOperation: (resolved: ResolvedProvider) => Promise<void> | void,
    sourceOperation: () => Promise<void>,
  ): Promise<void> {
    const virtualPath = normalizeVirtualPath(inputPath);
    this.#assertWritable();
    this.#assertVisible(virtualPath);
    const resolved = await this.#resolveProvider(virtualPath);
    if (resolved && supportsProviderOperation(resolved)) {
      await providerOperation(resolved);
      return;
    }

    if (resolved) {
      if (resolved.rule.rule.opaque) {
        throw readOnly(virtualPath);
      }
    }
    await sourceOperation();
  }

  async #assertDirectoryEmpty(virtualPath: string): Promise<void> {
    if ((await this.readdir(virtualPath))?.length) {
      throw Object.assign(new Error(`Directory is not empty: ${virtualPath}`), {
        code: "ENOTEMPTY",
      });
    }
  }

  async #hasMultipleBackings(
    virtualPath: string,
    resolved: ResolvedProvider | undefined,
    operation: "unlink" | "rmdir" | "rename",
  ): Promise<boolean> {
    if (!resolved || resolved.rule.rule.opaque) return false;
    const reference = resolved.rule.rule.provider;
    if (
      "module" in reference &&
      ((this.#nativePath(virtualPath, resolved) !== undefined &&
        !resolved.provider[operation]) ||
        !(await resolved.provider.getattr?.(resolved.context)))
    )
      return false;
    try {
      if ("module" in reference) {
        // Custom callbacks cannot prove that removing their node also removes the source name.
        await lstat(this.#sourcePath(virtualPath));
        return true;
      }
      if (reference.type !== "directory") return false;
      const targetPath = proxyTargetPath(
        reference,
        resolved.context.relativePath,
      );
      const sourcePath = this.#sourcePath(virtualPath);
      const target = await lstat(targetPath, { bigint: true });
      const source = await lstat(sourcePath, { bigint: true });
      if (source.dev !== target.dev || source.ino !== target.ino) return true;
      if (target.isDirectory()) return false;
      if (path.basename(sourcePath) !== path.basename(targetPath)) return true;
      const [sourceParent, targetParent] = await Promise.all([
        stat(path.dirname(sourcePath), { bigint: true }),
        stat(path.dirname(targetPath), { bigint: true }),
      ]);
      return (
        sourceParent.dev !== targetParent.dev ||
        sourceParent.ino !== targetParent.ino
      );
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async #resolveProvider(
    virtualPath: string,
    creating = false,
    movedSourceKind?: NodeMetadata["kind"],
  ): Promise<ResolvedProvider | undefined> {
    const ordered = [...this.#rules.providers].reverse();
    let rule = ordered.find((candidate) => candidate.matches(virtualPath));
    if (!rule) {
      rule = ordered.find(
        (candidate) =>
          candidate.exposeRoot &&
          candidate.root !== "" &&
          candidate.root === virtualPath,
      );
      if (!rule) return undefined;
      if (movedSourceKind === "directory") return undefined;
      try {
        if ((await stat(this.#sourcePath(virtualPath))).isDirectory())
          return undefined;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const resolved = {
      rule,
      provider: await this.#loadProvider(rule.rule.provider),
      context: this.#context(rule, virtualPath),
    };
    if (
      !rule.rule.opaque &&
      resolved.provider.getattr !== undefined &&
      (creating || !(await resolved.provider.getattr(resolved.context)))
    ) {
      // A moved source node will exist at its destination even before the rename does.
      if (movedSourceKind !== undefined) return undefined;
      try {
        await lstat(this.#sourcePath(virtualPath));
        return undefined;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const parentPath = normalizeVirtualPath(path.posix.dirname(virtualPath));
      if (
        (rule.rule.provider.type === "directory" ||
          ("module" in rule.rule.provider &&
            rule.matches(parentPath) &&
            !staticChildForDirectory(rule.rule.match, parentPath))) &&
        isWithinRuleRoot(rule.root, parentPath) &&
        !(await resolved.provider.getattr(this.#context(rule, parentPath)))
      ) {
        try {
          if ((await stat(this.#sourcePath(parentPath))).isDirectory())
            return undefined;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }
    return resolved;
  }

  #nativeDirectoryPath(
    virtualPath: string,
    resolved: ResolvedProvider | undefined,
  ): string | undefined {
    return resolved &&
      "module" in resolved.rule.rule.provider &&
      !resolved.rule.rule.opaque
      ? this.#sourcePath(virtualPath)
      : this.#nativePath(virtualPath, resolved);
  }

  #nativePath(
    virtualPath: string,
    resolved: ResolvedProvider | undefined,
  ): string | undefined {
    if (!resolved) return this.#sourcePath(virtualPath);
    const reference = resolved.rule.rule.provider;
    if (!("module" in reference))
      return proxyTargetPath(reference, resolved.context.relativePath);
    if (
      !resolved.rule.rule.opaque &&
      !resolved.provider.read &&
      !resolved.provider.write &&
      !resolved.provider.readFile &&
      !resolved.provider.writeFile
    )
      return this.#sourcePath(virtualPath);
    return undefined;
  }

  #boundProvider(
    virtualPath: string,
    handle: Pick<OverlayFileHandle, "binding">,
  ): ResolvedProvider | undefined {
    const binding = handle.binding;
    return binding
      ? { ...binding, context: this.#context(binding.rule, virtualPath) }
      : undefined;
  }

  async #openedHandle(
    binding: ResolvedProvider | undefined,
    value: unknown,
    native: FileHandle | undefined,
  ): Promise<OverlayFileHandle> {
    const nativeMetadata =
      native &&
      binding &&
      "module" in binding.rule.rule.provider &&
      !binding.provider.fgetattr &&
      binding.context.path !== "" &&
      !this.#generatedAncestor(binding.context.path, binding.rule)
        ? await binding.provider.getattr?.(binding.context)
        : undefined;
    return {
      binding,
      value,
      native,
      nativeMetadata: nativeMetadata && {
        ...(nativeMetadata.kind === "file" ? binding?.rule.rule.file : {}),
        ...nativeMetadata,
      },
    };
  }

  #scopeIdentity(
    metadata: NodeMetadata,
    resolved: ResolvedProvider | undefined,
  ): NodeMetadata {
    if (
      metadata.kind === "file" &&
      metadata.identity !== undefined &&
      resolved &&
      "module" in resolved.rule.rule.provider
    ) {
      // Resource identities are local to a provider rule, not to the mount.
      return {
        ...metadata,
        identity: `${metadata.identity}:rule:${String(this.#rules.providers.indexOf(resolved.rule))}`,
      };
    }
    return metadata;
  }

  #generatedAncestor(
    virtualPath: string,
    selected: CompiledProviderRule | undefined,
  ): boolean {
    const selectedIndex = selected
      ? this.#rules.providers.indexOf(selected)
      : -1;
    return this.#rules.providers.some(
      (rule, index) =>
        index >= selectedIndex &&
        rule.exposeRoot &&
        rule.root.startsWith(`${virtualPath}/`),
    );
  }

  #context(rule: CompiledProviderRule, virtualPath: string): ProviderContext {
    return {
      path: virtualPath,
      relativePath: relativeToRule(rule.root, virtualPath),
      ruleRoot: rule.root,
      sourcePath: this.#sourcePath(virtualPath),
      options:
        "options" in rule.rule.provider
          ? rule.rule.provider.options
          : undefined,
      signal: this.#signal,
    };
  }

  #handleContext(
    resolved: ResolvedProvider,
    flags: number,
    handle: unknown,
  ): FileHandleContext {
    return {
      ...resolved.context,
      flags,
      handle,
    };
  }

  #sourcePath(virtualPath: string): string {
    const sourcePath = path.join(this.#config.source, virtualPath);
    const relative = path.relative(this.#config.source, sourcePath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Path escapes source root: ${virtualPath}`);
    }
    return sourcePath;
  }

  #assertVisible(virtualPath: string): void {
    if (this.#rules.hidden(virtualPath)) {
      throw notFound(virtualPath);
    }
  }

  #assertWritable(): void {
    if (this.#config.readOnly) {
      throw Object.assign(new Error("Filesystem is read-only"), {
        code: "EROFS",
      });
    }
  }
}

async function rollbackResources(
  error: unknown,
  release: () => Promise<void>,
): Promise<never> {
  try {
    await release();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Opening a resource failed and rollback was incomplete",
    );
  }
  throw error;
}

async function releaseResources(
  native: FileHandle | undefined,
  ...releases: (() => Promise<void> | void)[]
): Promise<void> {
  const errors: unknown[] = [];
  for (const release of [() => native?.close(), ...releases]) {
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Failed to release resources");
}

function relativeToRule(root: string, virtualPath: string): string {
  return root === "" ? virtualPath : path.posix.relative(root, virtualPath);
}

function joinVirtual(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function isWithinRuleRoot(root: string, virtualPath: string): boolean {
  return (
    root === "" || virtualPath === root || virtualPath.startsWith(`${root}/`)
  );
}

function metadataFromDirent(
  entry: import("node:fs").Dirent,
): NodeMetadata | undefined {
  if (entry.isDirectory()) {
    return { kind: "directory", mode: 0o755 };
  }
  if (entry.isFile()) {
    return { kind: "file", mode: 0o644 };
  }
  if (entry.isSymbolicLink()) {
    return { kind: "symlink", mode: 0o777 };
  }
  return undefined;
}

function normalizeMetadata(metadata: NodeMetadata): NodeMetadata {
  const now = new Date();
  return {
    mode: metadata.kind === "directory" ? 0o755 : 0o644,
    size: metadata.kind === "directory" ? 4096 : 0,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    atime: now,
    mtime: now,
    ctime: now,
    birthtime: now,
    ...metadata,
  };
}

function assertMetadataAccess(metadata: NodeMetadata, mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) {
    throw Object.assign(new Error("Invalid access mode"), { code: "EINVAL" });
  }
  const uid = process.getuid?.() ?? 0;
  const permissions = metadata.mode ?? 0;
  if (uid === 0) {
    if (
      (mode & constants.X_OK) === 0 ||
      metadata.kind === "directory" ||
      (permissions & 0o111) !== 0
    )
      return;
  } else {
    const groups = new Set([
      process.getgid?.() ?? 0,
      ...(process.getgroups?.() ?? []),
    ]);
    const shift =
      uid === metadata.uid ? 6 : groups.has(metadata.gid ?? 0) ? 3 : 0;
    if (((permissions >> shift) & mode) === mode) return;
  }
  throw Object.assign(new Error("Generated path access denied"), {
    code: "EACCES",
  });
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function notFound(virtualPath: string): Error {
  return Object.assign(new Error(`No such file or directory: ${virtualPath}`), {
    code: "ENOENT",
  });
}

function readOnly(virtualPath: string): Error {
  return Object.assign(
    new Error(`Provider path is read-only: ${virtualPath}`),
    {
      code: "EROFS",
    },
  );
}
