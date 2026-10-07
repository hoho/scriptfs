import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { format } from "node:util";

const require = createRequire(
  path.join(process.env.SCRIPTFS_JS_ROOT ?? process.cwd(), "package.json"),
);
const picomatch = require("picomatch");
const sendBytes = process.stdout.write.bind(process.stdout);
function send(response, data = Buffer.alloc(0)) {
  const header = Buffer.from(
    JSON.stringify({ ...response, bodyLength: data.length }),
  );
  return sendEncoded(header, data);
}
function sendEncoded(header, data = Buffer.alloc(0)) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.length);
  process.stdout.cork();
  try {
    sendBytes(size);
    const written = sendBytes(header);
    return data.length ? sendBytes(data) : written;
  } finally {
    process.stdout.uncork();
  }
}
process.stdout.write = (chunk, encoding, callback) => {
  const body = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
  const written = send({ event: "stdout" }, body);
  const done = typeof encoding === "function" ? encoding : callback;
  done?.();
  return written;
};
for (const method of ["log", "info", "debug"])
  console[method] = (...args) => process.stdout.write(`${format(...args)}\n`);
for (const method of ["warn", "error"])
  console[method] = (...args) => process.stderr.write(`${format(...args)}\n`);
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
const instances = new Map();
const handles = new Map();
const objectResources = new WeakMap();
const primitiveResources = new Map();
let nextHandle = 1;
let nextResource = 1;
const prefix = Buffer.allocUnsafe(4);
let incoming = prefix;
let received = 0;
let phase = "size";
let incomingRequest;
let processing = Promise.resolve();

function resourceIdentity(value) {
  if (nextResource > Number.MAX_SAFE_INTEGER)
    throw new RangeError("Provider resource identities exhausted");
  if (
    (value !== null && typeof value === "object") ||
    typeof value === "function"
  ) {
    let identity = objectResources.get(value);
    if (identity === undefined) {
      identity = nextResource++;
      objectResources.set(value, identity);
    }
    return identity;
  }
  if (Number.isNaN(value)) return nextResource++;
  let resource = primitiveResources.get(value);
  if (resource === undefined) {
    resource = { identity: nextResource++, references: 0 };
    primitiveResources.set(value, resource);
  }
  resource.references++;
  return resource.identity;
}

function forgetHandle(handle) {
  const value = handles.get(handle);
  const resource = primitiveResources.get(value);
  if (resource !== undefined && --resource.references === 0)
    primitiveResources.delete(value);
  handles.delete(handle);
}

function normalize(input) {
  if (input.split("/").includes(".."))
    throw new Error(`Invalid virtual path: ${input}`);
  return path.posix.normalize(`/${input}`).slice(1);
}
function unescape(input) {
  return input.replace(/\\(.)/gs, "$1");
}
function pattern(rule) {
  const match = normalize(rule.match);
  const scan = picomatch.scan(match);
  const base = unescape(scan.base);
  const root = normalize(
    rule.root ??
      (scan.negated ? "" : scan.isGlob ? base : path.posix.dirname(base)),
  );
  const child = path.posix.basename(match);
  const childScan = picomatch.scan(child, { nonegate: true });
  const parent = path.posix.dirname(match);
  return {
    regex: picomatch.makeRe(match, { dot: true }).source,
    root,
    exposeRoot: rule.root != null || rule.opaque === true,
    explicitRoot: rule.root != null,
    child: childScan.isGlob || scan.negated ? null : unescape(childScan.base),
    parentRegex:
      parent === "." ? "^$" : picomatch.makeRe(parent, { dot: true }).source,
    parentIsRoot: parent === ".",
  };
}
function provider(reference) {
  const instance = instances.get(reference.module);
  if (instance === undefined)
    throw new Error(`Module "${reference.module}" is not loaded`);
  return instance;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function load(modules) {
  if (!modules || typeof modules !== "object")
    throw new TypeError("Invalid module load request");
  for (const [name, spec] of Object.entries(modules)) {
    if (instances.has(name))
      throw new Error(`Module "${name}" is already loaded`);
    try {
      const namespace = await import(pathToFileURL(spec.entry).href);
      if (!(spec.export in namespace))
        throw new TypeError(`${spec.entry} has no export "${spec.export}"`);
      const exported = namespace[spec.export];
      const runtime = Object.freeze({
        ...freeze(spec.runtime),
        signal: controller.signal,
      });
      const instance =
        typeof exported === "function" ? new exported(runtime) : exported;
      if (!instance || typeof instance !== "object")
        throw new TypeError(
          `Export "${spec.export}" of ${spec.entry} is neither a class nor an object`,
        );
      if (typeof instance.start === "function") await instance.start(runtime);
      instances.set(name, instance);
    } catch (error) {
      const stopped = await unload().catch(
        (/** @type {unknown} */ failure) => failure,
      );
      const message = `Module "${name}" failed to start: ${String(error?.message ?? error)}`;
      throw Object.assign(
        new Error(
          stopped instanceof Error ? `${message}; ${stopped.message}` : message,
          { cause: error },
        ),
        { code: error?.code },
      );
    }
  }
}
async function unload() {
  const failures = [];
  for (const [name, instance] of [...instances].reverse()) {
    instances.delete(name);
    try {
      if (typeof instance.stop === "function") await instance.stop();
    } catch (error) {
      console.error(error);
      failures.push(
        `Module "${name}" failed to stop: ${String(error?.message ?? error)}`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}
function revive(value) {
  if (!value || typeof value !== "object") return value;
  if (value.$date !== undefined) return new Date(value.$date);
  if (Array.isArray(value)) return value.map(revive);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, revive(child)]),
  );
}
function encode(value) {
  if (value instanceof Date) return { $date: value.getTime() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encode(child)]),
    );
  return value;
}
async function dispatch(request, body) {
  if (request.op === "patterns") return { value: request.rules.map(pattern) };
  if (request.op === "metadataBatch") {
    if (
      !Array.isArray(request.requests) ||
      request.requests.some((item) => item.op !== "getattr")
    )
      throw new TypeError("Invalid metadata batch");
    let values = [];
    let length = 0;
    for (const item of request.requests) {
      let result;
      try {
        result = await dispatch(item, Buffer.alloc(0));
      } catch (error) {
        console.error(error);
        result = {
          error: { message: String(error.message ?? error), code: error.code },
        };
      }
      const encoded = JSON.stringify(result);
      const size = Buffer.byteLength(encoded) + 1;
      if (values.length && length + size > 1024 * 1024) {
        sendEncoded(metadataHeader(request.id, values));
        values = [];
        length = 0;
      }
      values.push(encoded);
      length += size;
    }
    return { header: metadataHeader(request.id, values) };
  }
  if (request.op === "load") {
    await load(request.modules);
    return {};
  }
  if (request.op === "unload") {
    await unload();
    return {};
  }
  if (request.op === "abort") {
    controller.abort();
    return {};
  }
  if (request.op === "discard") {
    if (!handles.has(request.handle))
      throw Object.assign(new Error("Unknown provider handle"), {
        code: "EBADF",
      });
    forgetHandle(request.handle);
    return {};
  }
  const object = provider(request.provider);
  if (request.op === "describe")
    return {
      value: [
        "getattr",
        "fgetattr",
        "fsetattr",
        "readdir",
        "readlink",
        "readFile",
        "open",
        "opendir",
        "fsyncdir",
        "releasedir",
        "create",
        "read",
        "write",
        "writeFile",
        "truncate",
        "ftruncate",
        "flush",
        "fsync",
        "release",
        "access",
        "chmod",
        "chown",
        "utimens",
        "mkdir",
        "unlink",
        "rmdir",
        "rename",
      ].filter((key) => typeof object[key] === "function"),
    };
  const context = request.context;
  if (!("options" in context)) context.options = undefined;
  context.signal = controller.signal;
  if (request.handle !== undefined) {
    if (!handles.has(request.handle))
      throw Object.assign(new Error("Unknown provider handle"), {
        code: "EBADF",
      });
    context.handle = handles.get(request.handle);
  } else if (request.flags !== undefined) context.handle = undefined;
  if (request.flags !== undefined) context.flags = request.flags;
  if (request.op === "writeFile")
    context.previousContents = request.previousMissing
      ? undefined
      : body.subarray(request.contentsLength);
  const args = revive(request.args ?? []);
  if (["write", "writeFile"].includes(request.op))
    args.unshift(body.subarray(0, request.contentsLength ?? body.length));
  const method = object[request.op];
  if (typeof method !== "function")
    throw Object.assign(
      new Error(`Unsupported provider callback: ${request.op}`),
      { code: "EOPNOTSUPP" },
    );
  try {
    const value = await method.call(object, ...args, context);
    if (["open", "opendir", "create"].includes(request.op)) {
      if (value === undefined) return {};
      if (nextHandle > Number.MAX_SAFE_INTEGER)
        throw new RangeError("Provider handle identities exhausted");
      const handle = nextHandle++;
      const resource = resourceIdentity(value);
      handles.set(handle, value);
      return { value: handle, resource };
    }
    if (["read", "readFile"].includes(request.op))
      return { body: Buffer.from(value) };
    return { value: encode(value) };
  } finally {
    if (["release", "releasedir"].includes(request.op))
      forgetHandle(request.handle);
  }
}
function metadataHeader(id, values) {
  return Buffer.from(
    `{"id":${id},"value":[${values.join(",")}],"bodyLength":0}`,
  );
}
async function respond(request, body) {
  let response;
  try {
    response = await dispatch(request, body);
  } catch (error) {
    console.error(error);
    response = {
      error: { message: String(error.message ?? error), code: error.code },
    };
  }
  const data = response.body ?? Buffer.alloc(0);
  delete response.body;
  if (response.header !== undefined) sendEncoded(response.header, data);
  else send({ id: request.id, ...response }, data);
}
// A response that cannot be framed desynchronizes the stream, and the chained
// queue would stay rejected and silently stop answering. Close the pipe instead
// so the native host observes the exit rather than waiting forever.
function fatal(error) {
  console.error(error);
  process.exit(1);
}
process.stdin.on("data", (chunk) => {
  let offset = 0;
  while (offset < chunk.length || received === incoming.length) {
    const length = Math.min(chunk.length - offset, incoming.length - received);
    chunk.copy(incoming, received, offset, offset + length);
    offset += length;
    received += length;
    if (received !== incoming.length) break;
    if (phase === "size") {
      const size = incoming.readUInt32LE();
      if (size > 16 * 1024 * 1024)
        throw new Error("Provider request header is too large");
      incoming = Buffer.allocUnsafe(size);
      phase = "header";
    } else if (phase === "header") {
      incomingRequest = JSON.parse(incoming);
      const size = incomingRequest.bodyLength;
      if (!Number.isSafeInteger(size) || size < 0)
        throw new Error("Invalid provider body length");
      incoming = Buffer.allocUnsafe(size);
      phase = "body";
    } else {
      const request = incomingRequest;
      const body = incoming;
      processing = processing.then(() => respond(request, body)).catch(fatal);
      incomingRequest = undefined;
      incoming = prefix;
      phase = "size";
    }
    received = 0;
  }
});
process.stdin.on("end", () => {
  controller.abort();
  void processing.then(() =>
    process.exit(phase !== "size" || received !== 0 ? 1 : 0),
  );
});
