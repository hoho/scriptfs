import { createHash } from "node:crypto";
import type { NodeMetadata } from "../types.js";
import {
  OverlayFileSystem,
  type OverlayFileHandle,
} from "../overlay/filesystem.js";
import type {
  FuseClass,
  FuseInstance,
  FuseOperations,
  FuseStat,
} from "./fuse-binding.js";

interface Queue {
  pending: Promise<void>;
}

interface FileState extends Queue {
  path: string;
  paths: Set<string>;
  identity?: string;
  kind?: NodeMetadata["kind"];
  // Whole-file callbacks retain their rule without retaining a closable resource.
  binding?: Pick<OverlayFileHandle, "binding">;
  contents?: Buffer;
  revision?: string;
  dirty: boolean;
  truncated: boolean;
  detached: boolean;
  stale: boolean;
  references: number;
  flushTimer?: NodeJS.Timeout;
}

interface Handle {
  file: FileState;
  flags: number;
  providerHandle: OverlayFileHandle;
  metadata?: NodeMetadata;
  seekable: boolean;
  nextReadPosition: number;
  nextWritePosition: number;
}

export function createFuseMount(
  Fuse: FuseClass,
  mountPoint: string,
  filesystem: OverlayFileSystem,
  debug: boolean,
): FuseInstance {
  const handles = new Map<number, Handle>();
  const files = new Map<string, FileState>();
  const resources = new Map<string, FileState>();
  const directoryHandles = new Map<
    number,
    Pick<Handle, "file" | "flags" | "providerHandle" | "metadata">
  >();
  const namespace: Queue = { pending: Promise.resolve() };
  const statFor = (metadata: NodeMetadata): FuseStat => {
    return toFuseStat(
      metadata,
      metadata.identity === undefined
        ? { ino: 0, dev: 0 }
        : hashIdentity(metadata.identity),
    );
  };
  let nextHandle = 1;
  const log = (...values: unknown[]): void => {
    if (debug) console.log("[scriptfs:fuse]", ...values);
  };
  const forgetPath = (file: FileState, filePath: string): void => {
    if (files.get(filePath) === file) files.delete(filePath);
    file.paths.delete(filePath);
    if (file.path === filePath)
      file.path = file.paths.values().next().value ?? filePath;
  };
  const rememberPath = (file: FileState, filePath: string): void => {
    if (file.paths.size === 0) file.path = filePath;
    file.paths.add(filePath);
    files.set(filePath, file);
    file.detached = false;
    file.stale = false;
  };
  const observedFile = (
    filePath: string,
    metadata: NodeMetadata | undefined,
  ): FileState | undefined => {
    let file = files.get(filePath);
    if (file && !sameResource(file, metadata)) {
      forgetPath(file, filePath);
      file = undefined;
    }
    if (!metadata) return undefined;
    file ??=
      metadata.kind === "file" && metadata.identity !== undefined
        ? resources.get(metadata.identity)
        : undefined;
    if (file) rememberPath(file, filePath);
    return file;
  };
  const identifyFile = (
    file: FileState,
    metadata: NodeMetadata | undefined,
  ): void => {
    file.identity = metadata?.identity;
    file.kind = metadata?.kind;
    if (metadata?.kind === "file" && metadata.identity !== undefined)
      resources.set(metadata.identity, file);
  };
  const fileFor = (
    filePath: string,
    metadata: NodeMetadata | undefined,
  ): FileState => {
    let file = observedFile(filePath, metadata);
    if (!file) {
      file = {
        path: filePath,
        paths: new Set([filePath]),
        dirty: false,
        truncated: false,
        detached: false,
        stale: false,
        references: 0,
        pending: Promise.resolve(),
      };
      identifyFile(file, metadata);
      files.set(filePath, file);
    }
    return file;
  };
  const addHandle = (
    file: FileState,
    flags: number,
    providerHandle: OverlayFileHandle,
    metadata?: NodeMetadata,
  ): number => {
    const fd = nextHandle++;
    file.binding ??= { binding: providerHandle.binding };
    file.references++;
    handles.set(fd, {
      file,
      flags,
      providerHandle,
      metadata: bufferedMetadata(
        capturedMetadata(metadata, providerHandle),
        file,
      ),
      seekable: metadata?.seekable ?? true,
      nextReadPosition: 0,
      nextWritePosition: 0,
    });
    return fd;
  };
  const refreshHandlePath = async (
    file: FileState,
    filePath: string,
  ): Promise<void> => {
    if (
      file.identity !== undefined &&
      file.paths.size === 0 &&
      filePath !== file.path
    ) {
      const metadata = await filesystem.getattr(filePath, file.binding);
      if (sameResource(file, metadata)) rememberPath(file, filePath);
    }
  };
  const withHandle = <T>(
    fd: number,
    operation: (handle: Handle) => Promise<T>,
    filePath?: string,
  ): Promise<T> => {
    const handle = handles.get(fd);
    if (!handle) return Promise.reject(fsError("EBADF"));
    return enqueue(handle.file, async () => {
      if (filePath !== undefined && !handle.providerHandle.native)
        await refreshHandlePath(handle.file, filePath);
      return operation(handle);
    });
  };
  const done = (
    callback: (error: number) => void,
    result: Promise<void>,
  ): void => {
    void result.then(
      () => callback(0),
      (error: unknown) => callback(toFuseError(Fuse, error)),
    );
  };
  const discardUnused = (file: FileState, released = false): void => {
    if (
      file.references === 0 &&
      (!file.dirty || (released && file.stale)) &&
      (!file.truncated || released)
    ) {
      for (const filePath of file.paths) forgetPath(file, filePath);
      if (file.identity !== undefined && resources.get(file.identity) === file)
        resources.delete(file.identity);
      if (file.flushTimer) clearTimeout(file.flushTimer);
    }
  };
  const scheduleFlush = (file: FileState): void => {
    if (file.flushTimer) clearTimeout(file.flushTimer);
    file.flushTimer = setTimeout(() => {
      void enqueue(file, () => flushFile(filesystem, file)).then(
        () => discardUnused(file),
        (error: unknown) => {
          console.error(error);
          discardUnused(file, true);
        },
      );
    }, 500);
  };
  const updateSize = (
    file: FileState,
    size: number,
    handle?: Pick<Handle, "providerHandle" | "metadata">,
    shared = buffered(file),
  ): void => {
    if (handle) handle.metadata = resizedMetadata(handle.metadata, size);
    for (const current of handles.values()) {
      if (
        current.file !== file ||
        (handle &&
          !shared &&
          file.identity === undefined &&
          current.providerHandle.value !== handle.providerHandle.value)
      )
        continue;
      current.metadata = resizedMetadata(current.metadata, size);
    }
  };
  const truncateFile = async (
    file: FileState,
    size: number,
    handle?: Pick<Handle, "flags" | "providerHandle" | "metadata">,
  ): Promise<void> => {
    if (!Number.isSafeInteger(size) || size < 0) throw fsError("EINVAL");
    const retainedTruncate =
      handle?.providerHandle.native !== undefined ||
      (handle?.providerHandle.value !== undefined &&
        handle.providerHandle.binding?.provider.ftruncate !== undefined);
    const retainSnapshot =
      file.detached &&
      file.contents !== undefined &&
      handle !== undefined &&
      hasRetainedWriter(handle.providerHandle);
    if (!file.detached && !retainedTruncate)
      await currentPathMetadata(filesystem, file);
    const metadata = handle
      ? file.detached && file.contents
        ? handle.metadata
        : await filesystem.fgetattr(
            file.path,
            handle.flags,
            handle.providerHandle,
            handle.metadata,
          )
      : await filesystem.getattr(file.path);
    const persist =
      !file.detached || file.contents === undefined || retainSnapshot;
    if (handle && persist)
      await checkCallbackIdentity(
        filesystem,
        { file, providerHandle: handle.providerHandle },
        "ftruncate",
      );
    const persisted =
      persist &&
      (handle
        ? await filesystem.ftruncate(
            file.path,
            size,
            handle.flags,
            handle.providerHandle,
          )
        : await filesystem.truncate(file.path, size));
    const unchanged =
      !file.detached &&
      size === 0 &&
      metadata?.size === 0 &&
      metadata.sizeMode !== "unbounded";
    if ((persisted || unchanged) && !file.dirty && !retainSnapshot) {
      file.contents = undefined;
      file.truncated = false;
      file.revision = undefined;
      updateSize(file, size, handle, !retainedTruncate);
      return;
    }
    const previous =
      size === 0
        ? Buffer.alloc(0)
        : await contentsFor(filesystem, file, false, handle);
    const contents = Buffer.alloc(size);
    previous.copy(contents, 0, 0, Math.min(previous.length, size));
    file.contents = contents;
    file.truncated = !persisted;
    file.revision = undefined;
    if (
      !persisted &&
      metadata?.sizeMode !== "zero" &&
      metadata?.sizeMode !== "unbounded" &&
      (size > 0 || (metadata?.size ?? 0) > 0)
    )
      file.dirty = true;
    updateSize(file, size, handle);
    if (file.dirty) scheduleFlush(file);
  };
  const affectedPaths = (filePath: string): [string, FileState][] =>
    [...files].filter(([candidate]) => within(candidate, filePath));
  const snapshot = async (file: FileState): Promise<void> => {
    const handle = [...handles.values()].find(
      (candidate) => candidate.file === file,
    );
    if (!handle) return;
    if (file.identity !== undefined) {
      // Stale aliases must not supply a snapshot or prevent last-link detachment.
      for (const filePath of file.paths) {
        const metadata = await pathMetadata(filesystem, file, filePath);
        if (!sameResource(file, metadata)) forgetPath(file, filePath);
      }
      if (file.paths.size === 0) throw fsError("ESTALE");
    }
    file.contents = await filesystem.snapshot(
      file.path,
      handle.flags,
      handle.providerHandle,
    );
  };

  const operations: FuseOperations = {
    statfs: (filePath, callback) => {
      void filesystem.statfs(filePath).then(
        (statistics) => callback(0, statistics),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    fsetattr: (_filePath, fd, changes, detached, callback) => {
      const handle = handles.get(fd) ?? directoryHandles.get(fd);
      if (!handle) {
        callback(Fuse.EBADF);
        return;
      }
      done(
        callback,
        enqueue(handle.file, async () => {
          if (!handle.providerHandle.native)
            await refreshHandlePath(handle.file, _filePath);
          await checkCallbackIdentity(filesystem, handle, "fsetattr");
          await filesystem.fsetattr(
            handle.file.path,
            changes,
            handle.flags,
            handle.providerHandle,
            detached,
          );
          for (const current of [
            ...handles.values(),
            ...directoryHandles.values(),
          ]) {
            if (
              current.file === handle.file &&
              (handle.file.identity !== undefined ||
                current.providerHandle.value === handle.providerHandle.value) &&
              current.metadata
            ) {
              current.metadata = {
                ...current.metadata,
                ...changes,
                ...(changes.mode === undefined
                  ? {}
                  : { mode: changes.mode & 0o7777 }),
              };
            }
          }
        }),
      );
    },
    fgetattr: (_filePath, fd, callback) => {
      log("fgetattr", _filePath, fd);
      const handle = handles.get(fd) ?? directoryHandles.get(fd);
      if (!handle) {
        callback(Fuse.EBADF);
        return;
      }
      void enqueue(handle.file, async () => {
        if (!handle.providerHandle.native)
          await refreshHandlePath(handle.file, _filePath);
        let metadata =
          ((handle.file.detached || handle.file.stale) &&
            handle.file.contents) ||
          (handle.file.detached &&
            handle.metadata?.kind === "directory" &&
            !handle.providerHandle.native &&
            !handle.providerHandle.binding?.provider.fgetattr)
            ? handle.metadata
            : await filesystem.fgetattr(
                handle.file.path,
                handle.flags,
                handle.providerHandle,
                handle.metadata,
              );
        if (
          !handle.providerHandle.native &&
          !handle.providerHandle.binding?.provider.fgetattr &&
          handle.providerHandle.value === undefined &&
          handle.metadata?.identity !== undefined &&
          metadata?.identity !== handle.metadata.identity
        )
          metadata = handle.metadata;
        if (
          handle.file.detached &&
          metadata &&
          (metadata.kind === "directory" || !handle.providerHandle.native)
        )
          metadata = { ...metadata, nlink: 0 };
        return bufferedMetadata(metadata, handle.file);
      }).then(
        (metadata) =>
          callback(
            metadata ? 0 : Fuse.ENOENT,
            metadata ? statFor(metadata) : undefined,
          ),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    getattr: (filePath, callback) => {
      log("getattr", filePath);
      void enqueue(namespace, async () => {
        const result = await filesystem.getattr(filePath);
        const file = observedFile(filePath, result);
        return file
          ? enqueue(file, () => Promise.resolve(bufferedMetadata(result, file)))
          : result;
      }).then(
        (metadata) =>
          callback(
            metadata ? 0 : Fuse.ENOENT,
            metadata ? statFor(metadata) : undefined,
          ),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    readdir: (directoryPath, callback) => {
      log("readdir", directoryPath);
      void filesystem.readdir(directoryPath).then(
        (entries) =>
          callback(
            entries ? 0 : Fuse.ENOENT,
            entries?.map((entry) => entry.name),
          ),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    readlink: (filePath, callback) => {
      void filesystem.readlink(filePath).then(
        (target) => callback(0, target),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    opendir: (directoryPath, flags, callback) => {
      void enqueue(namespace, async () => {
        const metadata = await filesystem.getattr(directoryPath);
        if (metadata?.kind !== "directory")
          throw fsError(metadata ? "ENOTDIR" : "ENOENT");
        const file = fileFor(directoryPath, metadata);
        return enqueue(file, async () => {
          const providerHandle = await filesystem.opendir(directoryPath, flags);
          const fd = nextHandle++;
          file.references++;
          directoryHandles.set(fd, {
            file,
            flags,
            providerHandle,
            metadata: capturedMetadata(metadata, providerHandle),
          });
          return fd;
        }).finally(() => discardUnused(file));
      }).then(
        (fd) => callback(0, fd),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    releasedir: (_directoryPath, fd, callback) => {
      const handle = directoryHandles.get(fd);
      if (!handle) {
        callback(Fuse.EBADF);
        return;
      }
      done(
        callback,
        enqueue(handle.file, async () => {
          try {
            await filesystem.releasedir(
              handle.file.path,
              handle.flags,
              handle.providerHandle,
            );
          } finally {
            directoryHandles.delete(fd);
            handle.file.references--;
            discardUnused(handle.file);
          }
        }),
      );
    },
    fsyncdir: (_directoryPath, dataSync, fd, callback) => {
      const handle = directoryHandles.get(fd);
      if (!handle) {
        callback(Fuse.EBADF);
        return;
      }
      done(
        callback,
        enqueue(handle.file, () =>
          filesystem.fsyncdir(
            handle.file.path,
            dataSync,
            handle.flags,
            handle.providerHandle,
          ),
        ),
      );
    },
    open: (filePath, flags, callback) => {
      void enqueue(namespace, async () => {
        const metadata = await filesystem.getattr(filePath);
        if (!metadata) throw fsError("ENOENT");
        if (metadata.kind === "directory") throw fsError("EISDIR");
        const file = fileFor(filePath, metadata);
        return enqueue(file, async () => {
          if (!file.dirty && !file.truncated) file.contents = undefined;
          const providerHandle = await filesystem.open(filePath, flags);
          // The inode backend validates this handle before applying O_TRUNC.
          return addHandle(file, flags, providerHandle, metadata);
        }).finally(() => discardUnused(file));
      }).then(
        (fd) => callback(0, fd, handles.get(fd)?.seekable === false),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    create: (filePath, mode, flags, callback) => {
      void enqueue(namespace, () => {
        const file = fileFor(filePath, undefined);
        return enqueue(file, async () => {
          const providerHandle = await filesystem.create(filePath, mode, flags);
          try {
            const positional = await filesystem.positional(
              filePath,
              providerHandle,
            );
            file.contents = positional ? undefined : Buffer.alloc(0);
            file.truncated = !positional;
            const metadata = await filesystem.getattr(filePath);
            identifyFile(file, metadata);
            return addHandle(file, flags, providerHandle, metadata);
          } catch (error) {
            file.truncated = false;
            file.contents = undefined;
            await filesystem.release(filePath, flags, providerHandle);
            throw error;
          }
        }).finally(() => discardUnused(file));
      }).then(
        (fd) => callback(0, fd, handles.get(fd)?.seekable === false),
        (error: unknown) => callback(toFuseError(Fuse, error)),
      );
    },
    read: (_filePath, fd, buffer, length, position, callback) => {
      void withHandle(
        fd,
        async (handle) => {
          log("read", handle.file.path, { fd, length, position });
          if ((handle.flags & 3) === 1) throw fsError("EBADF");
          if (!handle.seekable && position !== handle.nextReadPosition)
            throw fsError("ESPIPE");
          let bytesRead = 0;
          let positional = false;
          if (!buffered(handle.file)) {
            do {
              await checkCallbackIdentity(filesystem, handle, "read");
              const chunk = await filesystem.readChunk(
                handle.file.path,
                position + bytesRead,
                length - bytesRead,
                handle.flags,
                handle.providerHandle,
              );
              if (chunk === undefined) {
                if (positional) throw fsError("EIO");
                break;
              }
              positional = true;
              bytesRead += chunk.copy(buffer, bytesRead, 0, length - bytesRead);
              // Cached FUSE reads treat a short reply as EOF, unlike direct I/O.
              if (!handle.seekable || chunk.length === 0) break;
            } while (bytesRead < length);
          }
          if (!positional) {
            bytesRead = (
              await contentsFor(filesystem, handle.file, false, handle)
            )
              .subarray(position, position + length)
              .copy(buffer);
          }
          handle.nextReadPosition = position + bytesRead;
          return bytesRead;
        },
        _filePath,
      ).then(callback, (error: unknown) => {
        log("read failed", error);
        callback(toFuseError(Fuse, error));
      });
    },
    write: (_filePath, fd, buffer, length, position, callback) => {
      const chunk = Buffer.from(buffer.subarray(0, length));
      void withHandle(
        fd,
        async (handle) => {
          if ((handle.flags & 3) === 0) throw fsError("EBADF");
          if (!handle.seekable && position !== handle.nextWritePosition)
            throw fsError("ESPIPE");
          const snapshot =
            handle.file.detached && hasRetainedWriter(handle.providerHandle)
              ? handle.file.contents
              : undefined;
          if (!buffered(handle.file) || snapshot !== undefined)
            await checkCallbackIdentity(filesystem, handle, "write");
          const written =
            buffered(handle.file) && snapshot === undefined
              ? undefined
              : await filesystem.writeChunk(
                  handle.file.path,
                  chunk,
                  position,
                  handle.flags,
                  handle.providerHandle,
                );
          if (written !== undefined) {
            if (!Number.isInteger(written) || written < 0 || written > length)
              throw fsError("EIO");
            handle.nextWritePosition = position + written;
            handle.file.contents = snapshot
              ? writeBuffer(snapshot, chunk.subarray(0, written), position)
              : undefined;
            handle.file.truncated = false;
            if (written > 0)
              updateSize(
                handle.file,
                Math.max(handle.metadata?.size ?? 0, position + written),
                handle,
              );
            return written;
          }
          const previous = await contentsFor(
            filesystem,
            handle.file,
            true,
            handle,
          );
          const contents = writeBuffer(
            previous,
            chunk,
            !handle.seekable && handle.metadata?.sizeMode === "zero"
              ? previous.length
              : position,
          );
          handle.file.contents = contents;
          handle.file.dirty = true;
          handle.nextWritePosition = position + length;
          updateSize(handle.file, contents.length, handle);
          scheduleFlush(handle.file);
          return length;
        },
        _filePath,
      ).then(callback, (error: unknown) => callback(toFuseError(Fuse, error)));
    },
    flush: (_filePath, fd, callback) => {
      done(
        callback,
        withHandle(
          fd,
          async (handle) => {
            await flushFile(filesystem, handle.file);
            await filesystem.flush(
              handle.file.path,
              handle.flags,
              handle.providerHandle,
            );
          },
          _filePath,
        ),
      );
    },
    fsync: (_filePath, dataSync, fd, callback) => {
      done(
        callback,
        withHandle(
          fd,
          async (handle) => {
            await flushFile(filesystem, handle.file);
            await filesystem.fsync(
              handle.file.path,
              dataSync,
              handle.flags,
              handle.providerHandle,
            );
          },
          _filePath,
        ),
      );
    },
    release: (_filePath, fd, callback) => {
      done(
        callback,
        withHandle(fd, async (handle) => {
          try {
            await flushFile(filesystem, handle.file);
          } finally {
            try {
              await filesystem.release(
                handle.file.path,
                handle.flags,
                handle.providerHandle,
              );
            } finally {
              handles.delete(fd);
              handle.file.references--;
              discardUnused(handle.file, true);
            }
          }
        }),
      );
    },
    truncate: (filePath, size, callback) => {
      done(
        callback,
        enqueue(namespace, async () => {
          const file = fileFor(filePath, await filesystem.getattr(filePath));
          return enqueue(file, () => truncateFile(file, size)).finally(() =>
            discardUnused(file),
          );
        }),
      );
    },
    ftruncate: (_filePath, fd, size, callback) => {
      done(
        callback,
        withHandle(
          fd,
          async (handle) => {
            if ((handle.flags & 3) === 0) throw fsError("EBADF");
            await truncateFile(handle.file, size, handle);
          },
          _filePath,
        ),
      );
    },
    mkdir: (directoryPath, mode, callback) => {
      done(
        callback,
        enqueue(namespace, () => filesystem.mkdir(directoryPath, mode)),
      );
    },
    unlink: (filePath, callback) => {
      log("unlink", filePath);
      done(
        callback,
        enqueue(namespace, async () => {
          const metadata = await filesystem.getattr(filePath);
          const file = observedFile(filePath, metadata);
          if (!file) return filesystem.unlink(filePath);
          await withFiles([file], async () => {
            await flushFile(filesystem, file);
            if (file.references > 0) await snapshot(file);
            await filesystem.unlink(filePath);
            forgetPath(file, filePath);
            file.detached =
              file.paths.size === 0 && (metadata?.nlink ?? 1) <= 1;
            discardUnused(file);
          });
        }),
      );
    },
    rmdir: (directoryPath, callback) => {
      done(
        callback,
        enqueue(namespace, async () => {
          const file = observedFile(
            directoryPath,
            await filesystem.getattr(directoryPath),
          );
          if (!file) return filesystem.rmdir(directoryPath);
          await enqueue(file, async () => {
            await filesystem.rmdir(directoryPath);
            forgetPath(file, directoryPath);
            file.detached = true;
            discardUnused(file);
          });
        }),
      );
    },
    rename: (source, destination, callback) => {
      log("rename", source, destination);
      done(
        callback,
        enqueue(namespace, async () => {
          const from = await filesystem.getattr(source);
          const to = await filesystem.getattr(destination);
          observedFile(source, from);
          observedFile(destination, to);
          if (from?.identity && from.identity === to?.identity) {
            await filesystem.rename(source, destination);
            return;
          }
          const moved = affectedPaths(source);
          const replaced = affectedPaths(destination).filter(
            ([filePath]) =>
              !moved.some(([movedPath]) => movedPath === filePath),
          );
          const affected = [
            ...new Set([...moved, ...replaced].map(([, file]) => file)),
          ];
          await withFiles(affected, async () => {
            for (const [filePath] of moved) {
              await filesystem.assertSameProvider(
                filePath,
                destination + filePath.slice(source.length),
              );
            }
            for (const file of affected) {
              await flushFile(filesystem, file);
              if (
                replaced.some(([, candidate]) => candidate === file) &&
                file.references > 0
              )
                await snapshot(file);
            }
            await filesystem.rename(source, destination);
            for (const [filePath, file] of replaced) {
              forgetPath(file, filePath);
              file.detached =
                file.paths.size === 0 &&
                (file.kind !== "file" || (to?.nlink ?? 1) <= 1);
            }
            for (const [filePath, file] of moved) forgetPath(file, filePath);
            for (const [filePath, file] of moved) {
              rememberPath(file, destination + filePath.slice(source.length));
            }
            for (const file of affected) discardUnused(file);
          });
        }),
      );
    },
    access: (filePath, mode, callback) =>
      done(callback, filesystem.access(filePath, mode)),
    chmod: (filePath, mode, callback) =>
      done(callback, filesystem.chmod(filePath, mode)),
    chown: (filePath, uid, gid, callback) =>
      done(
        callback,
        filesystem.chown(
          filePath,
          uid === 0xffff_ffff ? -1 : uid,
          gid === 0xffff_ffff ? -1 : gid,
        ),
      ),
    utimens: (filePath, atime, mtime, callback) =>
      done(
        callback,
        filesystem.utimens(filePath, new Date(atime), new Date(mtime)),
      ),
  };

  return new Fuse(mountPoint, operations, {
    allowOther: true,
    autoUnmount: true,
    // A binding timeout drops late results without releasing acquired resources.
    timeout: false,
    // The binding omits numeric zero when serializing mount options.
    attrTimeout: "0",
    acAttrTimeout: "0",
    debug,
    entryTimeout: "0",
    force: true,
    mkdir: true,
  });
}

function hashIdentity(identity: string): Pick<FuseStat, "ino" | "dev"> {
  const hash = createHash("sha256").update(identity).digest();
  // The binding transports dev and ino as separate 32-bit fields.
  return { ino: hash.readUInt32LE(0) || 1, dev: hash.readUInt32LE(4) };
}

function enqueue<T>(queue: Queue, operation: () => Promise<T>): Promise<T> {
  const result = queue.pending.then(operation);
  queue.pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withFiles<T>(
  files: readonly FileState[],
  operation: () => Promise<T>,
): Promise<T> {
  const [first, ...rest] = files;
  return first ? enqueue(first, () => withFiles(rest, operation)) : operation();
}

function sameResource(
  file: FileState,
  metadata: NodeMetadata | undefined,
): boolean {
  return (
    metadata !== undefined &&
    (file.kind === undefined || file.kind === metadata.kind) &&
    (file.identity === undefined || file.identity === metadata.identity)
  );
}

async function currentPathMetadata(
  filesystem: OverlayFileSystem,
  file: FileState,
): Promise<NodeMetadata | undefined> {
  if (file.identity === undefined)
    return filesystem.getattr(file.path, file.binding);
  for (const filePath of new Set([file.path, ...file.paths])) {
    const metadata = await pathMetadata(filesystem, file, filePath);
    if (sameResource(file, metadata)) {
      file.path = filePath;
      file.stale = false;
      return metadata;
    }
  }
  file.stale = true;
  throw fsError("ESTALE");
}

async function pathMetadata(
  filesystem: OverlayFileSystem,
  file: FileState,
  filePath: string,
): Promise<NodeMetadata | undefined> {
  try {
    return await filesystem.getattr(filePath, file.binding);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ENOTDIR")
    )
      throw error;
    return undefined;
  }
}

async function checkCallbackIdentity(
  filesystem: OverlayFileSystem,
  handle: Pick<Handle, "file" | "providerHandle">,
  operation: "read" | "write" | "ftruncate" | "fsetattr",
): Promise<void> {
  if (
    // Metadata callbacks override native dispatch; they need their own resource.
    (!handle.providerHandle.native ||
      operation === "ftruncate" ||
      operation === "fsetattr") &&
    handle.providerHandle.value === undefined &&
    handle.file.identity !== undefined &&
    handle.providerHandle.binding?.provider[operation] !== undefined
  )
    await currentPathMetadata(filesystem, handle.file);
}

async function contentsFor(
  filesystem: OverlayFileSystem,
  file: FileState,
  forWrite = false,
  handle?: Pick<Handle, "flags" | "providerHandle">,
): Promise<Buffer> {
  if (!file.dirty && !file.truncated && !file.detached) {
    const metadata = await currentPathMetadata(filesystem, file);
    const revision = [
      metadata?.size,
      metadata?.mtime?.getTime(),
      metadata?.ctime?.getTime(),
      metadata?.birthtime?.getTime(),
    ].join(":");
    if (file.revision !== revision) file.contents = undefined;
    file.revision = revision;
    if (forWrite && metadata?.size === 0 && metadata.sizeMode !== "unbounded")
      file.contents = Buffer.alloc(0);
  }
  file.contents ??= await filesystem.readFile(
    file.path,
    handle?.providerHandle ?? file.binding,
    handle?.flags,
  );
  return file.contents;
}

async function flushFile(
  filesystem: OverlayFileSystem,
  file: FileState,
): Promise<void> {
  if (file.flushTimer) {
    clearTimeout(file.flushTimer);
    file.flushTimer = undefined;
  }
  if (file.dirty && file.contents) {
    if (!file.detached) {
      await currentPathMetadata(filesystem, file);
      await filesystem.writeFile(file.path, file.contents, file.binding);
    }
    file.dirty = false;
    file.truncated = false;
  }
}

function buffered(file: FileState): boolean {
  return (
    file.contents !== undefined &&
    (file.dirty || file.truncated || file.detached)
  );
}

function hasRetainedWriter(handle: OverlayFileHandle): boolean {
  return (
    handle.native !== undefined ||
    (handle.value !== undefined && handle.binding?.provider.write !== undefined)
  );
}

function writeBuffer(
  previous: Buffer,
  chunk: Buffer,
  position: number,
): Buffer {
  if (chunk.length === 0) return previous;
  const contents = Buffer.alloc(
    Math.max(previous.length, position + chunk.length),
  );
  previous.copy(contents);
  chunk.copy(contents, position);
  return contents;
}

function capturedMetadata(
  metadata: NodeMetadata | undefined,
  handle: OverlayFileHandle,
): NodeMetadata | undefined {
  return (
    metadata && {
      ...metadata,
      ...handle.nativeMetadata,
      identity: metadata.identity,
    }
  );
}

function bufferedMetadata(
  metadata: NodeMetadata | undefined,
  file: FileState | undefined,
): NodeMetadata | undefined {
  return file?.contents && buffered(file)
    ? resizedMetadata(metadata, file.contents.length)
    : metadata;
}

function resizedMetadata(
  metadata: NodeMetadata | undefined,
  size: number,
): NodeMetadata | undefined {
  return metadata?.kind === "file" &&
    metadata.sizeMode !== "zero" &&
    metadata.sizeMode !== "unbounded"
    ? { ...metadata, size }
    : metadata;
}

function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function toFuseStat(
  metadata: NodeMetadata,
  identity: Pick<FuseStat, "ino" | "dev">,
): FuseStat {
  const now = new Date();
  const type =
    metadata.kind === "directory"
      ? 0o040000
      : metadata.kind === "symlink"
        ? 0o120000
        : 0o100000;
  return {
    ...identity,
    atime: metadata.atime ?? now,
    mtime: metadata.mtime ?? now,
    ctime: metadata.ctime ?? now,
    birthtime: metadata.birthtime ?? now,
    nlink: metadata.nlink ?? (metadata.kind === "directory" ? 2 : 1),
    size: metadata.size ?? (metadata.kind === "directory" ? 4096 : 0),
    mode: type | (metadata.mode ?? 0o644),
    uid: metadata.uid ?? process.getuid?.() ?? 0,
    gid: metadata.gid ?? process.getgid?.() ?? 0,
  };
}

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function toFuseError(Fuse: FuseClass, error: unknown): number {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : undefined;
  switch (code) {
    case "ENOSYS":
    case "EOPNOTSUPP":
    case "ENOTSUP":
      // ENOSYS can disable an operation mount-wide instead of rejecting one provider.
      return Fuse.EOPNOTSUPP;
  }
  if (code && /^E[A-Z0-9]+$/.test(code)) {
    const errno: unknown = Reflect.get(Fuse, code);
    if (typeof errno === "number" && Number.isInteger(errno) && errno < 0)
      return errno;
  }
  console.error(error);
  return Fuse.EIO;
}
