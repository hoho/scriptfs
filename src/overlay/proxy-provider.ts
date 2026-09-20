import {
  access,
  chmod,
  lchown,
  lstat,
  lutimes,
  mkdir,
  open,
  readlink,
  readdir,
  rename,
  rm,
  rmdir,
  truncate,
} from "node:fs/promises";
import path from "node:path";
import type {
  DirectoryProviderReference,
  FileProviderReference,
  ScriptFsProvider,
} from "../types.js";
import {
  nativeMetadata as metadataFromStat,
  readNativeFile,
  UnsupportedNativeNodeError,
  writeNativeFile,
} from "./native.js";

type ProxyReference = FileProviderReference | DirectoryProviderReference;

export function createProxyProvider(
  reference: ProxyReference,
): ScriptFsProvider {
  const targetPath = (relativePath: string): string =>
    proxyTargetPath(reference, relativePath);

  return {
    async getattr({ relativePath }) {
      try {
        const target = await lstat(targetPath(relativePath), { bigint: true });
        if (reference.type === "file" && !target.isFile()) {
          throw new UnsupportedNativeNodeError(
            `File proxy target must be a regular file, not a symbolic link or directory: ${reference.path}`,
          );
        }
        return metadataFromStat(target);
      } catch (error) {
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async readdir({ relativePath }) {
      if (reference.type === "file") {
        return undefined;
      }
      try {
        return await readdir(targetPath(relativePath));
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    readlink: ({ relativePath }) => readlink(targetPath(relativePath)),
    readFile: ({ relativePath }) => readNativeFile(targetPath(relativePath)),
    writeFile: (contents, { relativePath }) =>
      writeNativeFile(targetPath(relativePath), contents),
    async create(metadata, { relativePath }) {
      if (reference.type === "file") {
        throw readOnlyProxy(reference.path);
      }
      const handle = await open(
        targetPath(relativePath),
        "wx",
        metadata.mode ?? 0o644,
      );
      await handle.close();
    },
    truncate: (size, { relativePath }) =>
      truncate(targetPath(relativePath), size),
    access: (mode, { relativePath }) => access(targetPath(relativePath), mode),
    chmod: (mode, { relativePath }) => chmod(targetPath(relativePath), mode),
    chown: (uid, gid, { relativePath }) =>
      lchown(targetPath(relativePath), uid, gid),
    utimens: (atime, mtime, { relativePath }) =>
      lutimes(targetPath(relativePath), atime, mtime),
    mkdir: (metadata, { relativePath }) =>
      mkdir(targetPath(relativePath), { mode: metadata.mode }),
    async unlink({ relativePath }) {
      if (reference.type === "file") throw readOnlyProxy(reference.path);
      await rm(targetPath(relativePath));
    },
    rmdir: ({ relativePath }) => rmdir(targetPath(relativePath)),
    async rename({ relativePath, destinationRelativePath }) {
      if (
        reference.type === "file" &&
        relativePath !== destinationRelativePath
      ) {
        throw Object.assign(new Error("Cannot rename a fixed file proxy"), {
          code: "EXDEV",
        });
      }
      await rename(
        targetPath(relativePath),
        targetPath(destinationRelativePath),
      );
    },
  };
}

export function proxyTargetPath(
  reference: ProxyReference,
  relativePath: string,
): string {
  if (reference.type === "file") return reference.path;
  const root = reference.path;
  const target = path.join(root, relativePath);
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Proxy path escapes target directory: ${relativePath}`);
  }
  return target;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function readOnlyProxy(target: string): Error {
  return Object.assign(
    new Error(`Cannot change the namespace of fixed file proxy ${target}`),
    { code: "EROFS" },
  );
}
