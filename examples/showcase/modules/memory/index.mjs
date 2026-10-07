import path from "node:path";

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

function resized(contents, size) {
  const next = Buffer.alloc(size);
  contents.copy(next, 0, 0, Math.min(size, contents.length));
  return next;
}

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

export default {
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
