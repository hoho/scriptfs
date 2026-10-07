import {
  directoryMetadata,
  fileMetadata,
  fsError,
  symlinkMetadata,
} from "./errors.js";
import { ScriptFsModule } from "./module.js";
import type {
  DirectoryEntry,
  MaybePromise,
  NodeMetadata,
  ProviderContext,
  ScriptFsProvider,
  WriteContext,
} from "./types.js";

export type Params = Readonly<Record<string, string>>;

export type TreeContext<Options = unknown> = ProviderContext<Options> & {
  /** Values captured by `:name` and `*name` pattern segments. */
  params: Params;
};

export type TreeWriteContext<Options = unknown> = WriteContext<Options> & {
  params: Params;
};

export type Listing = readonly (string | DirectoryEntry)[];

export interface DirectoryRoute<Options = unknown> {
  /** Directory entries, or `undefined` when the directory does not exist. */
  list(context: TreeContext<Options>): MaybePromise<Listing | undefined>;
  /** Metadata without listing; `undefined` means the directory does not exist. */
  metadata?(
    context: TreeContext<Options>,
  ): MaybePromise<NodeMetadata | undefined>;
  mkdir?(
    metadata: NodeMetadata,
    context: TreeContext<Options>,
  ): MaybePromise<void>;
  rmdir?(context: TreeContext<Options>): MaybePromise<void>;
}

export interface FileRoute<Options = unknown> {
  /** File contents, or `undefined` when the file does not exist. */
  read(
    context: TreeContext<Options>,
  ): MaybePromise<Buffer | string | undefined>;
  /** Metadata without reading; `undefined` means the file does not exist. */
  metadata?(
    context: TreeContext<Options>,
  ): MaybePromise<NodeMetadata | undefined>;
  /** Replaces the whole file, creating it when it does not exist. */
  write?(
    contents: Buffer,
    context: TreeWriteContext<Options>,
  ): MaybePromise<void>;
  unlink?(context: TreeContext<Options>): MaybePromise<void>;
}

export interface SymlinkRoute<Options = unknown> {
  /** Link target, or `undefined` when the link does not exist. */
  target(context: TreeContext<Options>): MaybePromise<string | undefined>;
  unlink?(context: TreeContext<Options>): MaybePromise<void>;
}

type Segment =
  { kind: "literal"; value: string } | { kind: "param" | "rest"; name: string };

type Route<Options> =
  | { kind: "directory"; handler: DirectoryRoute<Options> }
  | { kind: "file"; handler: FileRoute<Options> }
  | { kind: "symlink"; handler: SymlinkRoute<Options> };

type Compiled<Options> = Route<Options> & {
  pattern: string;
  segments: Segment[];
  rank: number[];
};

type Matched<Options> = Route<Options> & { params: Params };

export type TreeCapability = "write" | "unlink" | "mkdir" | "rmdir";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RANK = { literal: 2, param: 1, rest: 0 } as const;

function compile(pattern: string): { segments: Segment[]; rank: number[] } {
  const trimmed = pattern.replace(/^\/+|\/+$/g, "");
  const parts = trimmed ? trimmed.split("/") : [];
  const names = new Set<string>();
  const segments = parts.map((part, index): Segment => {
    if (!part)
      throw new SyntaxError(`Empty segment in tree pattern "${pattern}"`);
    if (part === "." || part === "..")
      throw new SyntaxError(`Invalid segment in tree pattern "${pattern}"`);
    const kind = part.startsWith(":")
      ? "param"
      : part.startsWith("*")
        ? "rest"
        : "literal";
    if (kind === "literal") return { kind, value: part };
    const name = part.slice(1);
    if (!NAME.test(name))
      throw new SyntaxError(`Invalid parameter "${part}" in "${pattern}"`);
    if (names.has(name))
      throw new SyntaxError(`Duplicate parameter "${name}" in "${pattern}"`);
    if (kind === "rest" && index !== parts.length - 1)
      throw new SyntaxError(
        `"${part}" must be the last segment of "${pattern}"`,
      );
    names.add(name);
    return { kind, name };
  });
  return { segments, rank: segments.map((segment) => RANK[segment.kind]) };
}

function moreSpecific(left: number[], right: number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function match(segments: Segment[], parts: string[]): Params | undefined {
  const params: Record<string, string> = {};
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === "rest") {
      if (index >= parts.length) return undefined;
      params[segment.name] = parts.slice(index).join("/");
      return params;
    }
    const part = parts[index];
    if (part === undefined) return undefined;
    if (segment.kind === "literal") {
      if (segment.value !== part) return undefined;
    } else params[segment.name] = part;
  }
  return segments.length === parts.length ? params : undefined;
}

function contents(value: Buffer | string): Buffer {
  return typeof value === "string" ? Buffer.from(value) : value;
}

/**
 * Declarative virtual tree. Paths relative to the rule root are matched
 * against patterns where `:name` captures one segment and a trailing
 * `*name` captures the rest. Literal segments beat parameters, which beat
 * rest captures; equally specific patterns match in registration order.
 */
export class Tree<Options = unknown> {
  readonly #routes: Compiled<Options>[] = [];

  directory(
    pattern: string,
    route: DirectoryRoute<Options> | DirectoryRoute<Options>["list"],
  ): this {
    return this.#add(pattern, {
      kind: "directory",
      handler: typeof route === "function" ? { list: route } : route,
    });
  }

  file(
    pattern: string,
    route: FileRoute<Options> | FileRoute<Options>["read"],
  ): this {
    return this.#add(pattern, {
      kind: "file",
      handler: typeof route === "function" ? { read: route } : route,
    });
  }

  symlink(
    pattern: string,
    route: SymlinkRoute<Options> | SymlinkRoute<Options>["target"],
  ): this {
    return this.#add(pattern, {
      kind: "symlink",
      handler: typeof route === "function" ? { target: route } : route,
    });
  }

  /** Whether any route implements a mutating capability. */
  supports(capability: TreeCapability): boolean {
    return this.#routes.some(
      (route) =>
        (capability === "write" &&
          route.kind === "file" &&
          route.handler.write !== undefined) ||
        (capability === "unlink" &&
          route.kind !== "directory" &&
          route.handler.unlink !== undefined) ||
        ((capability === "mkdir" || capability === "rmdir") &&
          route.kind === "directory" &&
          route.handler[capability] !== undefined),
    );
  }

  /** The route and parameters for a path relative to the rule root. */
  match(relativePath: string): Matched<Options> | undefined {
    const parts = relativePath ? relativePath.split("/") : [];
    for (const route of this.#routes) {
      const params = match(route.segments, parts);
      if (params) return { ...route, params };
    }
    return undefined;
  }

  async getattr(
    context: ProviderContext<Options>,
  ): Promise<NodeMetadata | undefined> {
    const route = this.match(context.relativePath);
    if (!route) return undefined;
    const tree = { ...context, params: route.params };
    if (route.kind === "directory") {
      if (route.handler.metadata) {
        const metadata = await route.handler.metadata(tree);
        return metadata && { ...metadata, kind: "directory" };
      }
      return (await route.handler.list(tree)) ? directoryMetadata() : undefined;
    }
    if (route.kind === "file") {
      const mode = route.handler.write ? 0o644 : 0o444;
      if (route.handler.metadata) {
        const metadata = await route.handler.metadata(tree);
        return metadata && { mode, ...metadata, kind: "file" };
      }
      const value = await route.handler.read(tree);
      return value === undefined
        ? undefined
        : fileMetadata({ mode, size: contents(value).length });
    }
    const target = await route.handler.target(tree);
    return target === undefined ? undefined : symlinkMetadata(target);
  }

  async readdir(context: ProviderContext<Options>): Promise<Listing> {
    const route = this.#require(context.relativePath);
    if (route.kind !== "directory") throw fsError("ENOTDIR");
    const listing = await route.handler.list({
      ...context,
      params: route.params,
    });
    if (!listing) throw fsError("ENOENT");
    return listing;
  }

  async readFile(context: ProviderContext<Options>): Promise<Buffer> {
    const route = this.#require(context.relativePath);
    if (route.kind === "directory") throw fsError("EISDIR");
    if (route.kind === "symlink") throw fsError("EINVAL");
    const value = await route.handler.read({
      ...context,
      params: route.params,
    });
    if (value === undefined) throw fsError("ENOENT");
    return contents(value);
  }

  async readlink(context: ProviderContext<Options>): Promise<string> {
    const route = this.#require(context.relativePath);
    if (route.kind !== "symlink") throw fsError("EINVAL");
    const target = await route.handler.target({
      ...context,
      params: route.params,
    });
    if (target === undefined) throw fsError("ENOENT");
    return target;
  }

  async writeFile(
    contents: Buffer,
    context: WriteContext<Options>,
  ): Promise<void> {
    const route = this.match(context.relativePath);
    if (route?.kind === "directory") throw fsError("EISDIR");
    if (route?.kind !== "file" || !route.handler.write) throw fsError("EACCES");
    await route.handler.write(contents, { ...context, params: route.params });
  }

  async unlink(context: ProviderContext<Options>): Promise<void> {
    const route = this.#require(context.relativePath);
    if (route.kind === "directory") throw fsError("EISDIR");
    if (!route.handler.unlink) throw fsError("EACCES");
    await route.handler.unlink({ ...context, params: route.params });
  }

  async mkdir(
    metadata: NodeMetadata,
    context: ProviderContext<Options>,
  ): Promise<void> {
    const route = this.match(context.relativePath);
    if (route?.kind !== "directory" || !route.handler.mkdir)
      throw fsError("EACCES");
    await route.handler.mkdir(metadata, { ...context, params: route.params });
  }

  async rmdir(context: ProviderContext<Options>): Promise<void> {
    const route = this.#require(context.relativePath);
    if (route.kind !== "directory") throw fsError("ENOTDIR");
    if (!route.handler.rmdir) throw fsError("EACCES");
    await route.handler.rmdir({ ...context, params: route.params });
  }

  /** Provider callbacks for the routes registered so far. */
  provider(): ScriptFsProvider<Options> {
    const provider: ScriptFsProvider<Options> = {
      getattr: (context) => this.getattr(context),
      readdir: (context) => this.readdir(context),
      readFile: (context) => this.readFile(context),
      readlink: (context) => this.readlink(context),
    };
    if (this.supports("write"))
      provider.writeFile = (data, context) => this.writeFile(data, context);
    if (this.supports("unlink"))
      provider.unlink = (context) => this.unlink(context);
    if (this.supports("mkdir"))
      provider.mkdir = (metadata, context) => this.mkdir(metadata, context);
    if (this.supports("rmdir"))
      provider.rmdir = (context) => this.rmdir(context);
    return provider;
  }

  #require(relativePath: string): Matched<Options> {
    const route = this.match(relativePath);
    if (!route) throw fsError("ENOENT");
    return route;
  }

  #add(pattern: string, route: Route<Options>): this {
    const compiled = { ...route, pattern, ...compile(pattern) };
    const index = this.#routes.findIndex(
      (existing) => moreSpecific(compiled.rank, existing.rank) < 0,
    );
    if (index === -1) this.#routes.push(compiled);
    else this.#routes.splice(index, 0, compiled);
    return this;
  }
}

type Callback<Name extends keyof ScriptFsProvider> = NonNullable<
  ScriptFsProvider[Name]
>;

/**
 * A module served by a `Tree`. Register routes on `this.tree` in the
 * constructor or in `start()`; mutating callbacks are exposed only when a
 * route implements them, so read-only trees stay read-only.
 */
export class TreeModule<
  Settings extends object = Record<string, unknown>,
  Options = unknown,
> extends ScriptFsModule<Settings> {
  readonly tree = new Tree<Options>();

  getattr(
    context: ProviderContext<Options>,
  ): Promise<NodeMetadata | undefined> {
    return this.tree.getattr(context);
  }

  readdir(context: ProviderContext<Options>): Promise<Listing> {
    return this.tree.readdir(context);
  }

  readFile(context: ProviderContext<Options>): Promise<Buffer> {
    return this.tree.readFile(context);
  }

  readlink(context: ProviderContext<Options>): Promise<string> {
    return this.tree.readlink(context);
  }

  get writeFile(): Callback<"writeFile"> | undefined {
    return this.tree.supports("write")
      ? (data, context) =>
          this.tree.writeFile(data, context as WriteContext<Options>)
      : undefined;
  }

  get unlink(): Callback<"unlink"> | undefined {
    return this.tree.supports("unlink")
      ? (context) => this.tree.unlink(context as ProviderContext<Options>)
      : undefined;
  }

  get mkdir(): Callback<"mkdir"> | undefined {
    return this.tree.supports("mkdir")
      ? (metadata, context) =>
          this.tree.mkdir(metadata, context as ProviderContext<Options>)
      : undefined;
  }

  get rmdir(): Callback<"rmdir"> | undefined {
    return this.tree.supports("rmdir")
      ? (context) => this.tree.rmdir(context as ProviderContext<Options>)
      : undefined;
  }
}
