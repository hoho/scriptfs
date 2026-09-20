export type MaybePromise<T> = T | Promise<T>;

export type NodeKind = "file" | "directory" | "symlink";
export type FileSizeMode = "content" | "explicit" | "zero" | "unbounded";

export interface NodeMetadata {
  kind: NodeKind;
  identity?: string;
  nlink?: number;
  size?: number;
  sizeMode?: FileSizeMode;
  seekable?: boolean;
  mode?: number;
  uid?: number;
  gid?: number;
  atime?: Date;
  mtime?: Date;
  ctime?: Date;
  birthtime?: Date;
  target?: string;
}

export interface DirectoryEntry {
  name: string;
  metadata?: NodeMetadata;
}

export interface ProviderContext<Options = unknown> {
  path: string;
  relativePath: string;
  ruleRoot: string;
  sourcePath: string;
  options: Options;
  signal: AbortSignal;
}

export interface WriteContext<
  Options = unknown,
> extends ProviderContext<Options> {
  previousContents: Buffer | undefined;
}

export interface RenameContext<
  Options = unknown,
> extends ProviderContext<Options> {
  destinationPath: string;
  destinationRelativePath: string;
}

export interface FileHandleContext<
  Options = unknown,
  Handle = unknown,
> extends ProviderContext<Options> {
  flags: number;
  handle: Handle | undefined;
}

export interface ProviderFileDefaults {
  mode?: number;
  size?: number;
  sizeMode?: FileSizeMode;
  seekable?: boolean;
}

export interface FileAttributeChanges {
  mode?: number;
  uid?: number;
  gid?: number;
  atime?: Date;
  mtime?: Date;
}

export interface FilesystemStatistics {
  bsize: number;
  frsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
  favail: number;
  fsid: number;
  flag: number;
  namemax: number;
}

export interface ScriptFsProvider<Options = unknown, Handle = unknown> {
  fsetattr?(
    changes: FileAttributeChanges,
    context: FileHandleContext<Options, Handle>,
  ): MaybePromise<void>;
  getattr?(
    context: ProviderContext<Options>,
  ): MaybePromise<NodeMetadata | undefined>;
  fgetattr?(
    context: FileHandleContext<Options, Handle>,
  ): MaybePromise<NodeMetadata | undefined>;
  readdir?(
    context: ProviderContext<Options>,
  ): MaybePromise<readonly (string | DirectoryEntry)[] | undefined>;
  readlink?(context: ProviderContext<Options>): MaybePromise<string>;
  readFile?(context: ProviderContext<Options>): MaybePromise<Buffer | string>;
  open?(context: FileHandleContext<Options>): MaybePromise<Handle>;
  opendir?(context: FileHandleContext<Options>): MaybePromise<Handle>;
  fsyncdir?(
    dataSync: boolean,
    context: FileHandleContext<Options, Handle>,
  ): MaybePromise<void>;
  releasedir?(context: FileHandleContext<Options, Handle>): MaybePromise<void>;
  create?(
    metadata: NodeMetadata,
    context: FileHandleContext<Options>,
  ): MaybePromise<Handle>;
  read?(
    position: number,
    length: number,
    context: FileHandleContext<Options, Handle>,
  ): MaybePromise<Buffer | string>;
  write?(
    contents: Buffer,
    position: number,
    context: FileHandleContext<Options, Handle>,
  ): MaybePromise<number | undefined>;
  writeFile?(
    contents: Buffer,
    context: WriteContext<Options>,
  ): MaybePromise<void>;
  truncate?(
    size: number,
    context: ProviderContext<Options>,
  ): MaybePromise<void>;
  ftruncate?(
    size: number,
    context: FileHandleContext<Options, Handle>,
  ): MaybePromise<void>;
  flush?(context: FileHandleContext<Options, Handle>): MaybePromise<void>;
  fsync?(
    dataSync: boolean,
    context: FileHandleContext<Options, Handle>,
  ): MaybePromise<void>;
  release?(context: FileHandleContext<Options, Handle>): MaybePromise<void>;
  access?(mode: number, context: ProviderContext<Options>): MaybePromise<void>;
  chmod?(mode: number, context: ProviderContext<Options>): MaybePromise<void>;
  chown?(
    uid: number,
    gid: number,
    context: ProviderContext<Options>,
  ): MaybePromise<void>;
  utimens?(
    atime: Date,
    mtime: Date,
    context: ProviderContext<Options>,
  ): MaybePromise<void>;
  mkdir?(
    metadata: NodeMetadata,
    context: ProviderContext<Options>,
  ): MaybePromise<void>;
  unlink?(context: ProviderContext<Options>): MaybePromise<void>;
  rmdir?(context: ProviderContext<Options>): MaybePromise<void>;
  rename?(context: RenameContext<Options>): MaybePromise<void>;
}

export interface ModuleProviderReference {
  type?: "module";
  module: string;
  export?: string;
  options?: unknown;
}

export interface FileProviderReference {
  type: "file";
  path: string;
}

export interface DirectoryProviderReference {
  type: "directory";
  path: string;
}

export type ProviderReference =
  ModuleProviderReference | FileProviderReference | DirectoryProviderReference;

export interface ProviderRule {
  match: string;
  root?: string;
  provider: ProviderReference;
  opaque?: boolean;
  file?: ProviderFileDefaults;
}

export interface HideRule {
  match: string;
  hide: true;
}

export type OverlayRule = ProviderRule | HideRule;

export interface FilesystemConfig {
  name: string;
  source: string;
  mountPoint: string;
  readOnly?: boolean;
  rules?: OverlayRule[];
}

export interface ContainerConfig {
  image?: string;
  rebuild?: boolean;
  smbHost?: string;
  smbPort?: number;
  logLevel?: "silent" | "info" | "debug";
}

export interface ScriptFsConfig {
  filesystems: FilesystemConfig[];
  container?: ContainerConfig;
}

export interface ScriptFsSession {
  readonly containerId: string;
  readonly mounts: ReadonlyMap<string, string>;
  wait(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartOptions {
  signal?: AbortSignal;
}
