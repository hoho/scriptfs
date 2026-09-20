import { open } from "node:fs/promises";
import path from "node:path";

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

function resized(contents, size) {
  const next = Buffer.alloc(size);
  contents.copy(next, 0, 0, Math.min(size, contents.length));
  return next;
}

export default {
  getattr({ path: name }) {
    if (name.startsWith("components/") && name.endsWith("/AGENTS.md"))
      return { kind: "file", mode: 0o444 };
  },
  readFile({ path: name, options }) {
    return `# ${options.heading}\n\nGenerated for \`${name}\`.\n`;
  },
};

const directories = new Map([
  [
    "",
    [
      "Datasets",
      "AGENTS.md",
      "ContentSized.txt",
      "FixedSize.bin",
      "CommandSink.txt",
      "GeneratedStream.bin",
      "SequentialStream.bin",
    ],
  ],
  ["Datasets", ["Batch1"]],
  ["Datasets/Batch1", ["Record1"]],
  ["Datasets/Batch1/Record1", ["data.txt", "action.txt"]],
]);
const contents = new Map([
  [
    "AGENTS.md",
    "Read data.txt; write commands to action.txt. Tools/Memory demonstrates mutable resources.\n",
  ],
  ["ContentSized.txt", "This size is derived from readFile.\n"],
  ["Datasets/Batch1/Record1/data.txt", "Generated record contents.\n"],
  ["Datasets/Batch1/Record1/action.txt", ""],
  ["hidden.private", "Hide rules filter generated files too.\n"],
]);

export const catalogProvider = {
  getattr({ relativePath }) {
    if (directories.has(relativePath))
      return { kind: "directory", mode: 0o755 };
    if (relativePath.endsWith("/action.txt"))
      return { kind: "file", mode: 0o200, size: 0 };
    if (contents.has(relativePath)) return { kind: "file" };
  },
  readdir({ relativePath }) {
    const listed = directories.get(relativePath);
    if (!listed) return;
    const prefix = relativePath ? `${relativePath}/` : "";
    const added = [...contents.keys()]
      .filter(
        (name) =>
          name.startsWith(prefix) && !name.slice(prefix.length).includes("/"),
      )
      .map((name) => name.slice(prefix.length));
    return [...new Set([...listed, ...added])];
  },
  readFile({ relativePath }) {
    const value = contents.get(relativePath);
    if (value === undefined) throw fsError("ENOENT");
    return value;
  },
  writeFile(value, { relativePath, previousContents, options }) {
    const parent = path.posix.dirname(relativePath);
    if (!directories.has(parent === "." ? "" : parent)) throw fsError("ENOENT");
    if (!relativePath.endsWith("/action.txt"))
      contents.set(relativePath, value.toString());
    console.log(
      `[${options?.catalogName ?? "catalog"}] write ${relativePath}: ${value.toString()} (previous ${previousContents?.length ?? 0} bytes)`,
    );
  },
};

const positionalResources = new Map();
function positionalResource({ path: name, options }) {
  let resource = positionalResources.get(name);
  if (!resource) {
    resource = {
      kind: options.kind,
      fill: String(options.fill ?? "0").slice(0, 1),
      contents: Buffer.alloc(
        options.size ?? 0,
        String(options.fill ?? "0").slice(0, 1),
      ),
    };
    positionalResources.set(name, resource);
  }
  return resource;
}
function positionalMetadata(resource) {
  return resource.kind === "file"
    ? { kind: "file", size: resource.contents.length, sizeMode: "explicit" }
    : { kind: "file" };
}
function truncateResource(resource, size) {
  if (resource.kind === "stream") throw fsError("EROFS");
  if (resource.kind === "file")
    resource.contents = resized(resource.contents, size);
}

export const positionalProvider = {
  getattr(context) {
    return positionalMetadata(positionalResource(context));
  },
  open(context) {
    context.signal.throwIfAborted();
    return positionalResource(context);
  },
  fgetattr({ handle }) {
    return positionalMetadata(handle);
  },
  read(position, length, { handle }) {
    if (handle.kind === "sink") throw fsError("EACCES");
    return handle.kind === "file"
      ? handle.contents.subarray(position, position + length)
      : Buffer.alloc(length, handle.fill);
  },
  write(value, position, { handle, path: name }) {
    if (handle.kind === "stream") throw fsError("EROFS");
    if (handle.kind === "file") {
      handle.contents = resized(
        handle.contents,
        Math.max(handle.contents.length, position + value.length),
      );
      value.copy(handle.contents, position);
    }
    console.log(`write ${value.length} bytes to ${name} at ${position}`);
    return value.length;
  },
  truncate(size, context) {
    truncateResource(positionalResource(context), size);
  },
  ftruncate(size, { handle }) {
    truncateResource(handle, size);
  },
};

let nextIdentity = 1;
function node(kind, mode, text = "") {
  const now = new Date();
  return {
    kind,
    mode,
    identity: `example-memory:${nextIdentity++}`,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    atime: now,
    mtime: now,
    ctime: now,
    birthtime: now,
    contents: kind === "file" ? Buffer.from(text) : undefined,
  };
}
const memory = new Map([
  ["", node("directory", 0o755)],
  [
    "AGENTS.md",
    node(
      "file",
      0o444,
      "This tree is in memory. Create, rename, truncate and delete files here. Changes reset on restart.\n",
    ),
  ],
  [
    "data.txt",
    node(
      "file",
      0o644,
      "Stable open resources survive rename, unlink and replacement.\n",
    ),
  ],
  ["latest", { ...node("symlink", 0o777), target: "data.txt" }],
  ["hidden.private", node("file", 0o600, "Hidden generated file.\n")],
]);
const observedSignals = new WeakSet();
function event(operation, context) {
  if (!observedSignals.has(context.signal)) {
    observedSignals.add(context.signal);
    context.signal.addEventListener(
      "abort",
      () => {
        console.log("[memory] shutdown signal received");
      },
      { once: true },
    );
  }
  console.log(`[memory] ${operation} ${context.path}`);
}
function lookup(name, kind) {
  const resource = memory.get(name);
  if (!resource) throw fsError("ENOENT");
  if (kind && resource.kind !== kind)
    throw fsError(
      kind === "directory"
        ? "ENOTDIR"
        : resource.kind === "directory"
          ? "EISDIR"
          : "EINVAL",
    );
  return resource;
}
function metadata(resource) {
  const { contents: bytes, ...attributes } = resource;
  return {
    ...attributes,
    size:
      bytes?.length ??
      (resource.kind === "symlink" ? Buffer.byteLength(resource.target) : 4096),
    sizeMode: "explicit",
  };
}
function parentOf(name) {
  const parent = path.posix.dirname(name);
  return lookup(parent === "." ? "" : parent, "directory");
}
function touch(resource) {
  resource.mtime = resource.ctime = new Date();
}
function applyAttributes(resource, changes) {
  Object.assign(resource, changes);
  resource.mode &= 0o7777;
  resource.ctime = new Date();
}
function createNode(name, kind, mode) {
  if (memory.has(name)) throw fsError("EEXIST");
  const parent = parentOf(name);
  const resource = node(kind, mode);
  memory.set(name, resource);
  touch(parent);
  return resource;
}
function hasChildren(name) {
  return [...memory.keys()].some((key) => key.startsWith(`${name}/`));
}

export const memoryProvider = {
  getattr({ relativePath }) {
    const resource = memory.get(relativePath);
    return resource && metadata(resource);
  },
  fgetattr({ handle }) {
    return metadata(handle);
  },
  readdir({ relativePath }) {
    lookup(relativePath, "directory");
    const prefix = relativePath ? `${relativePath}/` : "";
    return [...memory.keys()]
      .filter(
        (name) =>
          name !== relativePath &&
          name.startsWith(prefix) &&
          !name.slice(prefix.length).includes("/"),
      )
      .map((name) => ({
        name: name.slice(prefix.length),
        metadata: metadata(lookup(name)),
      }));
  },
  readlink({ relativePath }) {
    return lookup(relativePath, "symlink").target;
  },
  access(mask, { relativePath }) {
    const resource = lookup(relativePath);
    if (((resource.mode >> 6) & mask) !== mask) throw fsError("EACCES");
  },
  open(context) {
    context.signal.throwIfAborted();
    event("open", context);
    return lookup(context.relativePath, "file");
  },
  create(attributes, context) {
    context.signal.throwIfAborted();
    event("create", context);
    return createNode(context.relativePath, "file", attributes.mode);
  },
  read(position, length, { handle }) {
    handle.atime = new Date();
    return handle.contents.subarray(position, position + length);
  },
  write(value, position, { handle }) {
    handle.contents = resized(
      handle.contents,
      Math.max(handle.contents.length, position + value.length),
    );
    value.copy(handle.contents, position);
    touch(handle);
    return value.length;
  },
  truncate(size, { relativePath }) {
    const resource = lookup(relativePath, "file");
    resource.contents = resized(resource.contents, size);
    touch(resource);
  },
  ftruncate(size, { handle }) {
    handle.contents = resized(handle.contents, size);
    touch(handle);
  },
  fsetattr(changes, { handle }) {
    applyAttributes(handle, changes);
  },
  chmod(mode, { relativePath }) {
    applyAttributes(lookup(relativePath), { mode });
  },
  chown(uid, gid, { relativePath }) {
    applyAttributes(lookup(relativePath), {
      ...(uid === -1 ? {} : { uid }),
      ...(gid === -1 ? {} : { gid }),
    });
  },
  utimens(atime, mtime, { relativePath }) {
    applyAttributes(lookup(relativePath), { atime, mtime });
  },
  flush(context) {
    event("flush", context);
  },
  // This provider is intentionally volatile; sync acknowledges in-memory state, not disk durability.
  fsync(dataSync, context) {
    event(dataSync ? "fdatasync" : "fsync", context);
  },
  release(context) {
    event("release", context);
  },
  opendir(context) {
    event("opendir", context);
    return lookup(context.relativePath, "directory");
  },
  fsyncdir(dataSync, context) {
    event(dataSync ? "fdatasyncdir" : "fsyncdir", context);
  },
  releasedir(context) {
    event("releasedir", context);
  },
  mkdir(attributes, { relativePath }) {
    createNode(relativePath, "directory", attributes.mode);
  },
  unlink({ relativePath }) {
    if (lookup(relativePath).kind === "directory") throw fsError("EISDIR");
    memory.delete(relativePath);
    touch(parentOf(relativePath));
  },
  rmdir({ relativePath }) {
    lookup(relativePath, "directory");
    if (!relativePath) throw fsError("EBUSY");
    if (hasChildren(relativePath)) throw fsError("ENOTEMPTY");
    memory.delete(relativePath);
    touch(parentOf(relativePath));
  },
  rename({ relativePath, destinationRelativePath }) {
    if (relativePath === destinationRelativePath) return;
    if (!relativePath || !destinationRelativePath) throw fsError("EBUSY");
    if (destinationRelativePath.startsWith(`${relativePath}/`))
      throw fsError("EINVAL");
    const resource = lookup(relativePath);
    const destinationParent = parentOf(destinationRelativePath);
    const replaced = memory.get(destinationRelativePath);
    if (replaced) {
      if (resource.kind === "directory" && replaced.kind !== "directory")
        throw fsError("ENOTDIR");
      if (resource.kind !== "directory" && replaced.kind === "directory")
        throw fsError("EISDIR");
      if (hasChildren(destinationRelativePath)) throw fsError("ENOTEMPTY");
    }
    const moved = [...memory].filter(
      ([name]) => name === relativePath || name.startsWith(`${relativePath}/`),
    );
    for (const [name] of moved) memory.delete(name);
    for (const [name, value] of moved)
      memory.set(
        destinationRelativePath + name.slice(relativePath.length),
        value,
      );
    resource.ctime = new Date();
    touch(parentOf(relativePath));
    touch(destinationParent);
  },
};

export const sourceHooks = {
  open(context) {
    console.log(`[source] open ${context.path}`);
    return { openedAt: new Date() };
  },
  async create(attributes, context) {
    const descriptor = await open(context.sourcePath, "wx", attributes.mode);
    await descriptor.close();
    return this.open(context);
  },
  fsync(dataSync, context) {
    console.log(`[source] ${dataSync ? "fdatasync" : "fsync"} ${context.path}`);
  },
  release(context) {
    console.log(
      `[source] release ${context.path} opened at ${context.handle.openedAt.toISOString()}`,
    );
  },
};
