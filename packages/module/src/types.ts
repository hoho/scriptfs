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

export interface FileAttributeChanges {
  mode?: number;
  uid?: number;
  gid?: number;
  atime?: Date;
  mtime?: Date;
}

/** File system callbacks a module may implement. Every callback is optional. */
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

/** Container-local listener that tunnels to a host service. */
export interface OutboundPortBinding {
  readonly direction: "outbound";
  readonly host: string;
  readonly port: number;
}

/** Container port published on the host loopback interface. */
export interface InboundPortBinding {
  readonly direction: "inbound";
  readonly host: string;
  readonly port: number;
  readonly hostPort: number;
}

export type PortBinding = OutboundPortBinding | InboundPortBinding;

/**
 * Everything ScriptFS resolved for one module instance. It is passed to the
 * module constructor and to `start()`, and is deeply frozen.
 */
export interface ModuleRuntime<
  Settings extends object = Record<string, unknown>,
> {
  readonly version: 1;
  /** Instance name from the `modules` section of the configuration. */
  readonly name: string;
  readonly manifest: { readonly name: string; readonly version?: string };
  readonly settings: Readonly<Settings>;
  /** Configured secrets; optional secrets that were not configured are absent. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly ports: Readonly<Record<string, PortBinding>>;
  /** Container paths of bound host paths; unbound optional paths are absent. */
  readonly paths: Readonly<Record<string, string>>;
  /** Persistent writable directory, present when the manifest enables state. */
  readonly stateDir?: string;
  /** Aborted when ScriptFS shuts down. */
  readonly signal: AbortSignal;
}
