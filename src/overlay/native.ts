import { constants, type BigIntStats, type Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { NodeMetadata } from "../types.js";

export class UnsupportedNativeNodeError extends Error {
  readonly code = "EOPNOTSUPP";

  constructor(
    message = "Only regular files, directories, and symbolic links are supported",
  ) {
    super(message);
  }
}

export function nativeMetadata(stat: Stats | BigIntStats): NodeMetadata {
  if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
    throw new UnsupportedNativeNodeError();
  return {
    kind: stat.isDirectory()
      ? "directory"
      : stat.isSymbolicLink()
        ? "symlink"
        : "file",
    identity: `native:${String(stat.dev)}:${String(stat.ino)}`,
    nlink: Number(stat.nlink),
    sizeMode: "explicit",
    seekable: true,
    mode: Number(stat.mode) & 0o7777,
    size: Number(stat.size),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    atime: stat.atime,
    mtime: stat.mtime,
    ctime: stat.ctime,
    birthtime: stat.birthtime,
  };
}

export async function openNativeFile(
  target: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  const exclusive =
    (flags & (constants.O_CREAT | constants.O_EXCL)) ===
    (constants.O_CREAT | constants.O_EXCL);
  if (!exclusive) {
    try {
      assertRegularFile(await stat(target));
    } catch (error) {
      if (
        !(flags & constants.O_CREAT) ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  // A regular file can be replaced by a FIFO between stat and open.
  const handle = await open(target, flags | constants.O_NONBLOCK, mode);
  try {
    if (!exclusive) assertRegularFile(await handle.stat());
  } catch (error) {
    return closeAfterFailure(handle, error);
  }
  return handle;
}

export async function readNativeFile(target: string): Promise<Buffer> {
  const handle = await openNativeFile(target, constants.O_RDONLY);
  let contents: Buffer;
  try {
    contents = await handle.readFile();
  } catch (error) {
    return closeAfterFailure(handle, error);
  }
  await handle.close();
  return contents;
}

export async function writeNativeFile(
  target: string,
  contents: Buffer,
): Promise<void> {
  const handle = await openNativeFile(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
  );
  try {
    await handle.writeFile(contents);
  } catch (error) {
    return closeAfterFailure(handle, error);
  }
  await handle.close();
}

function assertRegularFile(stat: Stats): void {
  if (stat.isDirectory())
    throw Object.assign(new Error("Is a directory"), { code: "EISDIR" });
  if (!stat.isFile()) throw new UnsupportedNativeNodeError();
}

async function closeAfterFailure(
  handle: FileHandle,
  error: unknown,
): Promise<never> {
  try {
    await handle.close();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Native file operation failed and cleanup was incomplete",
    );
  }
  throw error;
}
