export type FileSizeMode = "content" | "explicit" | "zero" | "unbounded";

export interface ProviderFileDefaults {
  mode?: number;
  size?: number;
  sizeMode?: FileSizeMode;
  seekable?: boolean;
}

/** Secret value read from the host when the session starts. */
export type ModuleSecretSource = { env: string } | { file: string };

/** Host target for an outbound port or host port for an inbound port. */
export type ModulePortBinding = { target: string } | { hostPort: number };

/** A module manifest (`scriptfs.module.json`) after validation. */
export interface ModuleManifest {
  name: string;
  version?: string;
  description?: string;
  entry: string;
  export?: string;
  dependencies?: "bundled" | "install";
  settings?: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean" | "array" | "object";
      description?: string;
      default?: unknown;
      required?: boolean;
      enum?: unknown[];
    }
  >;
  secrets?: Record<
    string,
    { description?: string; required?: boolean; env?: string }
  >;
  ports?: Record<
    string,
    | { direction: "outbound"; description?: string; target?: string }
    | {
        direction: "inbound";
        description?: string;
        port: number;
        hostPort?: number;
      }
  >;
  paths?: Record<
    string,
    {
      description?: string;
      type?: "directory" | "file";
      access?: "read-only" | "read-write";
      required?: boolean;
      default?: string;
      target?: string;
    }
  >;
  state?: boolean;
}

/** A located, validated module. */
export interface InspectedModule {
  /** Absolute path of `scriptfs.module.json`. */
  manifestPath: string;
  manifest: ModuleManifest;
}

/** One configured instance of a module. */
export interface ModuleConfig {
  /**
   * Manifest file, directory containing `scriptfs.module.json`, or installed
   * package name.
   */
  manifest: string;
  settings?: Record<string, unknown>;
  secrets?: Record<string, ModuleSecretSource>;
  ports?: Record<string, ModulePortBinding>;
  /** Host paths bound to the manifest paths. */
  paths?: Record<string, string>;
  /** Host directory for persistent module state. */
  state?: string;
}

export interface ModuleProviderReference {
  type?: "module";
  /** Instance name from the `modules` section. */
  module: string;
  /** Passed to every callback as `context.options`. */
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
  modules?: Record<string, ModuleConfig>;
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
