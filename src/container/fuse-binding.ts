import type { FileAttributeChanges, FilesystemStatistics } from "../types.js";

export interface FuseStat {
  ino: number;
  dev: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  birthtime: Date;
  nlink: number;
  size: number;
  mode: number;
  uid: number;
  gid: number;
}

export interface FuseOperations {
  statfs(
    path: string,
    callback: (error: number, statistics?: FilesystemStatistics) => void,
  ): void;
  fsetattr(
    path: string,
    fd: number,
    changes: FileAttributeChanges,
    detached: boolean,
    callback: (error: number) => void,
  ): void;
  getattr(
    path: string,
    callback: (error: number, stat?: FuseStat) => void,
  ): void;
  fgetattr(
    path: string,
    fd: number,
    callback: (error: number, stat?: FuseStat) => void,
  ): void;
  readdir(
    path: string,
    callback: (error: number, names?: string[]) => void,
  ): void;
  readlink(
    path: string,
    callback: (error: number, target?: string) => void,
  ): void;
  opendir(
    path: string,
    flags: number,
    callback: (error: number, fd?: number) => void,
  ): void;
  releasedir(path: string, fd: number, callback: (error: number) => void): void;
  fsyncdir(
    path: string,
    dataSync: boolean,
    fd: number,
    callback: (error: number) => void,
  ): void;
  open(
    path: string,
    flags: number,
    callback: (error: number, fd?: number, directIO?: boolean) => void,
  ): void;
  create(
    path: string,
    mode: number,
    flags: number,
    callback: (error: number, fd?: number, directIO?: boolean) => void,
  ): void;
  read(
    path: string,
    fd: number,
    buffer: Buffer,
    length: number,
    position: number,
    callback: (result: number) => void,
  ): void;
  write(
    path: string,
    fd: number,
    buffer: Buffer,
    length: number,
    position: number,
    callback: (result: number) => void,
  ): void;
  flush(path: string, fd: number, callback: (error: number) => void): void;
  fsync(
    path: string,
    dataSync: boolean,
    fd: number,
    callback: (error: number) => void,
  ): void;
  ftruncate(
    path: string,
    fd: number,
    size: number,
    callback: (error: number) => void,
  ): void;
  release(path: string, fd: number, callback: (error: number) => void): void;
  truncate(path: string, size: number, callback: (error: number) => void): void;
  mkdir(path: string, mode: number, callback: (error: number) => void): void;
  unlink(path: string, callback: (error: number) => void): void;
  rmdir(path: string, callback: (error: number) => void): void;
  rename(
    source: string,
    destination: string,
    callback: (error: number) => void,
  ): void;
  access(path: string, mode: number, callback: (error: number) => void): void;
  chmod(path: string, mode: number, callback: (error: number) => void): void;
  chown(
    path: string,
    uid: number,
    gid: number,
    callback: (error: number) => void,
  ): void;
  utimens(
    path: string,
    atime: number,
    mtime: number,
    callback: (error: number) => void,
  ): void;
}

export interface FuseInstance {
  mount(callback: (error?: Error) => void): void;
  unmount(callback: (error?: Error) => void): void;
}

export interface FuseClass {
  new (
    mountPoint: string,
    operations: FuseOperations,
    options?: Record<string, unknown>,
  ): FuseInstance;
  EACCES: number;
  EEXIST: number;
  EIO: number;
  EISDIR: number;
  ENOENT: number;
  ENOTDIR: number;
  ENOTEMPTY: number;
  ENOSYS: number;
  EPERM: number;
  EROFS: number;
  ESPIPE: number;
  EXDEV: number;
  EINVAL: number;
  EBADF: number;
  EBUSY: number;
  ESTALE: number;
  EOPNOTSUPP: number;
}

export async function loadFuse(): Promise<FuseClass> {
  const packageName = "@cocalc/fuse-native";
  const loaded = (await import(packageName)) as {
    default?: unknown;
  };
  if (typeof loaded.default !== "function") {
    throw new TypeError(
      "@cocalc/fuse-native did not export a FUSE constructor",
    );
  }
  return loaded.default as FuseClass;
}
