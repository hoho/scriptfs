function fsError(code) {
  return Object.assign(new Error(code), { code });
}

function resized(contents, size) {
  const next = Buffer.alloc(size);
  contents.copy(next, 0, 0, Math.min(size, contents.length));
  return next;
}

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

export default {
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
