import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpError,
  InboundPort,
  OutboundPort,
  ScriptFsModule,
  StateStore,
  Tree,
  TreeModule,
  TtlCache,
  directoryMetadata,
  fileMetadata,
  fsError,
  httpErrorCode,
  readJson,
  sendJson,
  symlinkMetadata,
  type ModuleRuntime,
  type ProviderContext,
  type WriteContext,
} from "../src/index.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "scriptfs-module-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as net.AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as net.AddressInfo).port;
}

function runtime(
  overrides: Partial<ModuleRuntime> = {},
): ModuleRuntime & { controller: AbortController } {
  const controller = new AbortController();
  return {
    version: 1,
    name: "instance",
    manifest: { name: "example", version: "1.0.0" },
    settings: { title: "Hello" },
    secrets: { token: "secret" },
    ports: {},
    paths: { notes: "/data/notes" },
    signal: controller.signal,
    controller,
    ...overrides,
  };
}

function context(relativePath: string): ProviderContext {
  return {
    path: relativePath ? `Root/${relativePath}` : "Root",
    relativePath,
    ruleRoot: "Root",
    sourcePath: `/source/Root/${relativePath}`,
    options: undefined,
    signal: new AbortController().signal,
  };
}

function writing(relativePath: string): WriteContext {
  return { ...context(relativePath), previousContents: undefined };
}

describe("errors and metadata", () => {
  it("maps HTTP statuses to file system codes", () => {
    expect(
      [400, 401, 403, 404, 405, 408, 409, 410, 413, 429, 500, 503, 507].map(
        httpErrorCode,
      ),
    ).toEqual([
      "EINVAL",
      "EACCES",
      "EACCES",
      "ENOENT",
      "EOPNOTSUPP",
      "ETIMEDOUT",
      "EEXIST",
      "ENOENT",
      "EFBIG",
      "EAGAIN",
      "EIO",
      "EAGAIN",
      "ENOSPC",
    ]);
    const error = new HttpError(404, undefined, { url: "http://x/y" });
    expect(error).toMatchObject({ status: 404, code: "ENOENT" });
    expect(error.message).toBe("HTTP 404 from http://x/y");
    expect(fsError("EEXIST")).toMatchObject({
      code: "EEXIST",
      message: "EEXIST",
    });
  });

  it("builds node metadata", () => {
    expect(fileMetadata({ size: 3 })).toEqual({
      kind: "file",
      mode: 0o644,
      size: 3,
    });
    expect(directoryMetadata({ mode: 0o555 })).toEqual({
      kind: "directory",
      mode: 0o555,
    });
    expect(symlinkMetadata("päth")).toEqual({
      kind: "symlink",
      mode: 0o777,
      size: 5,
      target: "päth",
    });
  });
});

describe("ScriptFsModule", () => {
  it("exposes the runtime", () => {
    const module = new ScriptFsModule(runtime());
    expect(module.name).toBe("instance");
    expect(module.settings).toEqual({ title: "Hello" });
    expect(module.secret("token")).toBe("secret");
    expect(module.optionalSecret("missing")).toBeUndefined();
    expect(() => module.secret("missing")).toThrow(
      'Module "instance" has no secret "missing"',
    );
    expect(
      () => new ScriptFsModule({ ...runtime(), version: 2 } as never),
    ).toThrow("Unsupported ScriptFS module runtime version 2");
  });

  it("keeps bound paths contained", () => {
    const module = new ScriptFsModule(runtime());
    expect(module.hasPath("notes")).toBe(true);
    expect(module.hasPath("other")).toBe(false);
    expect(module.path("notes")).toBe("/data/notes");
    expect(module.path("notes", "a", "b.md")).toBe("/data/notes/a/b.md");
    expect(() => module.path("notes", "../escape")).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
    expect(() => module.path("notes", "/etc/passwd")).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
    expect(() => module.path("other")).toThrow('no bound path "other"');
    expect(() => module.statePath()).toThrow('set "state": true');
  });

  it("runs stop callbacks in reverse and reports every failure", async () => {
    const module = new ScriptFsModule(runtime());
    const order: number[] = [];
    module.onStop(() => order.push(1));
    module.onStop(() => {
      order.push(2);
      throw new Error("two");
    });
    module.onStop(async () => {
      await Promise.resolve();
      order.push(3);
      throw new Error("three");
    });
    await expect(module.stop()).rejects.toThrow(AggregateError);
    expect(order).toEqual([3, 2, 1]);
    await module.stop();
    expect(order).toEqual([3, 2, 1]);
  });

  it("rejects ports with the wrong direction", () => {
    const module = new ScriptFsModule(
      runtime({
        ports: {
          api: { direction: "outbound", host: "127.0.0.1", port: 1 },
          web: {
            direction: "inbound",
            host: "0.0.0.0",
            port: 2,
            hostPort: 3,
          },
        },
      }),
    );
    expect(module.outbound("api")).toBe(module.outbound("api"));
    expect(module.inbound("web").publicUrl).toBe("http://127.0.0.1:3");
    expect(() => module.outbound("web")).toThrow('no outbound port "web"');
    expect(() => module.inbound("api")).toThrow('no inbound port "api"');
    expect(() => module.outbound("missing")).toThrow(
      'no outbound port "missing"',
    );
  });

  it("logs with the instance name", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      new ScriptFsModule(runtime()).log("loaded %d files", 3);
    } finally {
      console.log = original;
    }
    expect(lines).toEqual(["[instance] loaded 3 files"]);
  });
});

describe("OutboundPort", () => {
  it("sends JSON requests with queries", async () => {
    const port = await serve((request, response) => {
      void (async () => {
        if (request.url?.startsWith("/fail")) {
          response.writeHead(403).end("nope");
          return;
        }
        if (request.url === "/empty") {
          response.writeHead(204).end();
          return;
        }
        sendJson(response, 200, {
          method: request.method,
          url: request.url,
          accept: request.headers.accept,
          authorization: request.headers.authorization,
          body: request.method === "POST" ? await readJson(request) : null,
        });
      })();
    });
    const api = new OutboundPort("api", {
      direction: "outbound",
      host: "127.0.0.1",
      port,
    });
    expect(api.origin).toBe(`http://127.0.0.1:${String(port)}`);
    expect(
      api.url("/items", { tag: ["a", "b"], skip: undefined, n: 1 }).href,
    ).toBe(`http://127.0.0.1:${String(port)}/items?tag=a&tag=b&n=1`);
    await expect(
      api.json("/items", {
        method: "POST",
        query: { q: "x y" },
        headers: { authorization: "Bearer t" },
        json: { title: "Buy milk" },
      }),
    ).resolves.toEqual({
      method: "POST",
      url: "/items?q=x+y",
      accept: "application/json",
      authorization: "Bearer t",
      body: { title: "Buy milk" },
    });
    await expect(api.json("/empty")).resolves.toBeUndefined();
    await expect(api.text("/fail")).rejects.toMatchObject({
      status: 403,
      code: "EACCES",
      body: "nope",
    });
    expect((await api.fetch("/fail")).status).toBe(403);
    expect((await api.bytes("/")).length).toBeGreaterThan(0);
  });

  it("maps network failures and timeouts", async () => {
    const closed = new OutboundPort("api", {
      direction: "outbound",
      host: "127.0.0.1",
      port: await freePort(),
    });
    await expect(closed.text("/")).rejects.toMatchObject({ code: "EIO" });
    await expect(closed.connect()).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    const port = await serve(() => undefined);
    const slow = new OutboundPort(
      "api",
      { direction: "outbound", host: "127.0.0.1", port },
      { timeout: 50 },
    );
    await expect(slow.text("/")).rejects.toMatchObject({ code: "ETIMEDOUT" });
    const controller = new AbortController();
    const aborted = new OutboundPort(
      "api",
      { direction: "outbound", host: "127.0.0.1", port },
      { signal: controller.signal },
    );
    const pending = aborted.text("/");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "EINTR" });
  });

  it("opens raw connections", async () => {
    const server = net.createServer((socket) => socket.end("hello"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => server.close());
    const port = new OutboundPort("raw", {
      direction: "outbound",
      host: "127.0.0.1",
      port: (server.address() as net.AddressInfo).port,
    });
    const socket = await port.connect();
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
  });
});

describe("InboundPort", () => {
  it("serves async handlers and closes when the module stops", async () => {
    const port = await freePort();
    const module = new ScriptFsModule(
      runtime({
        ports: {
          web: {
            direction: "inbound",
            host: "127.0.0.1",
            port,
            hostPort: 9,
          },
        },
      }),
    );
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (error: unknown) => errors.push(error);
    cleanup.push(() => {
      console.error = original;
    });
    const server = await module
      .inbound("web")
      .listen(async (request, response) => {
        await Promise.resolve();
        if (request.url === "/missing")
          throw new HttpError(404, "No such item");
        if (request.url === "/crash") throw new Error("boom");
        if (request.url === "/echo") {
          sendJson(response, 201, await readJson(request, { limit: 8 }));
          return;
        }
        sendJson(response, 200, { ok: true });
      });
    const base = `http://127.0.0.1:${String(port)}`;
    expect(await (await fetch(base)).json()).toEqual({ ok: true });
    const missing = await fetch(`${base}/missing`);
    expect([missing.status, await missing.json()]).toEqual([
      404,
      { error: "No such item" },
    ]);
    const crash = await fetch(`${base}/crash`);
    expect([crash.status, await crash.json()]).toEqual([
      500,
      { error: "Internal Server Error" },
    ]);
    expect(errors).toEqual([new Error("boom")]);
    const echo = await fetch(`${base}/echo`, { method: "POST", body: "[1]" });
    expect([echo.status, await echo.json()]).toEqual([201, [1]]);
    const large = await fetch(`${base}/echo`, {
      method: "POST",
      body: "x".repeat(1000),
    });
    expect(large.status).toBe(413);
    const invalid = await fetch(`${base}/echo`, { method: "POST", body: "{" });
    expect(invalid.status).toBe(400);
    await module.stop();
    expect(server.listening).toBe(false);
    await expect(fetch(base)).rejects.toThrow();
  });

  it("reports listen failures", async () => {
    const blocker = net.createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    cleanup.push(() => blocker.close());
    const port = (blocker.address() as net.AddressInfo).port;
    const inbound = new InboundPort("web", {
      direction: "inbound",
      host: "127.0.0.1",
      port,
      hostPort: port,
    });
    await expect(inbound.listen(() => undefined)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});

describe("StateStore", () => {
  it("persists serialized updates atomically", async () => {
    const directory = await temporary();
    const module = new ScriptFsModule(runtime({ stateDir: directory }));
    const store = module.state({ count: 0, items: [] as string[] });
    expect(module.state({ count: 5, items: [] })).toBe(store);
    expect(await store.read()).toEqual({ count: 0, items: [] });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update((value) => {
          value.count++;
          value.items.push(String(index));
        }),
      ),
    );
    await expect(
      store.update(() => Promise.reject(new Error("no"))),
    ).rejects.toThrow("no");
    await store.update((value) => ({ ...value, count: value.count + 1 }));
    const saved = JSON.parse(
      await readFile(path.join(directory, "state.json"), "utf8"),
    ) as { count: number; items: string[] };
    expect(saved.count).toBe(21);
    expect(saved.items).toHaveLength(20);
    expect(await readdir(directory)).toEqual(["state.json"]);
    const reopened = new StateStore(path.join(directory, "state.json"), {
      count: 0,
      items: [],
    });
    expect((await reopened.read()).count).toBe(21);
    await reopened.write({ count: 1, items: [] });
    expect((await reopened.read()).count).toBe(1);
  });

  it("does not share the initial value between stores", async () => {
    const directory = await temporary();
    const initial = { list: [] as number[] };
    const first = new StateStore(path.join(directory, "a.json"), initial);
    await first.update((value) => {
      value.list.push(1);
    });
    expect(initial.list).toEqual([]);
    const nested = new StateStore(path.join(directory, "x", "b.json"), () => 7);
    await nested.write(8);
    expect(await readFile(path.join(directory, "x", "b.json"), "utf8")).toBe(
      "8\n",
    );
  });
});

describe("TtlCache", () => {
  it("shares loads, expires, and does not cache failures", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache<string, number>({ ttl: 100, now: () => now });
    const load = async () => {
      await Promise.resolve();
      return ++loads;
    };
    const [a, b] = await Promise.all([
      cache.get("k", load),
      cache.get("k", load),
    ]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    now = 99;
    expect(await cache.get("k", load)).toBe(1);
    now = 100;
    expect(await cache.get("k", load)).toBe(2);
    await expect(
      cache.get("bad", () => Promise.reject(new Error("down"))),
    ).rejects.toThrow("down");
    expect(await cache.get("bad", () => 5)).toBe(5);
    cache.set("k", 9);
    expect(await cache.get("k", load)).toBe(9);
    expect(cache.delete("k")).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entries", async () => {
    const cache = new TtlCache<string, string>({ ttl: 1000, max: 2 });
    await cache.get("a", () => "a");
    await cache.get("b", () => "b");
    await cache.get("a", () => "stale");
    await cache.get("c", () => "c");
    expect(await cache.get("a", () => "reloaded")).toBe("a");
    expect(await cache.get("b", () => "reloaded")).toBe("reloaded");
    expect(() => new TtlCache({ ttl: -1 })).toThrow(RangeError);
    expect(() => new TtlCache({ ttl: 1, max: 0 })).toThrow(RangeError);
  });
});

describe("Tree", () => {
  function notes() {
    const files = new Map([["a.md", "alpha"]]);
    const tree = new Tree()
      .directory("", () => ["notes", "latest", "README.md"])
      .file("README.md", () => "read me")
      .directory("notes", () => [...files.keys()])
      .file("notes/:name", {
        read: ({ params }) => files.get(params.name ?? ""),
        write: (contents, { params, previousContents }) => {
          if (previousContents === undefined && params.name === "taken.md")
            throw fsError("EEXIST");
          files.set(params.name ?? "", contents.toString());
        },
        unlink: ({ params }) => {
          if (!files.delete(params.name ?? "")) throw fsError("ENOENT");
        },
      })
      .file("notes/index.md", () => [...files.keys()].join("\n"))
      .symlink("latest", () => "notes/a.md")
      .directory("tags/*path", ({ params }) =>
        params.path?.endsWith("/gone") ? undefined : [params.path ?? ""],
      )
      .directory("tags/:tag", {
        list: ({ params }) => [`${params.tag ?? ""}.md`],
        metadata: () => directoryMetadata({ mode: 0o555 }),
      });
    return { tree, files };
  }

  it("matches the most specific pattern", () => {
    const { tree } = notes();
    expect(tree.match("notes/index.md")?.kind).toBe("file");
    expect(tree.match("notes/index.md")?.params).toEqual({});
    expect(tree.match("notes/b.md")?.params).toEqual({ name: "b.md" });
    expect(tree.match("tags/x")?.params).toEqual({ tag: "x" });
    expect(tree.match("tags/x/y/z")?.params).toEqual({ path: "x/y/z" });
    expect(tree.match("tags")).toBeUndefined();
    expect(tree.match("notes/a/b")).toBeUndefined();
    expect(tree.match("")?.kind).toBe("directory");
  });

  it("rejects invalid patterns", () => {
    const tree = new Tree();
    expect(() => tree.file("a//b", () => "")).toThrow("Empty segment");
    expect(() => tree.file("a/../b", () => "")).toThrow("Invalid segment");
    expect(() => tree.file(":a/:a", () => "")).toThrow("Duplicate");
    expect(() => tree.file("*rest/x", () => "")).toThrow("last segment");
    expect(() => tree.file(":1x", () => "")).toThrow("Invalid parameter");
  });

  it("answers provider callbacks", async () => {
    const { tree, files } = notes();
    expect(await tree.getattr(context(""))).toEqual(directoryMetadata());
    expect(await tree.getattr(context("README.md"))).toEqual({
      kind: "file",
      mode: 0o444,
      size: 7,
    });
    expect(await tree.getattr(context("notes/a.md"))).toEqual({
      kind: "file",
      mode: 0o644,
      size: 5,
    });
    expect(await tree.getattr(context("notes/zzz.md"))).toBeUndefined();
    expect(await tree.getattr(context("nothing"))).toBeUndefined();
    expect(await tree.getattr(context("tags/x"))).toEqual({
      kind: "directory",
      mode: 0o555,
    });
    expect(await tree.getattr(context("tags/missing/deeper"))).toEqual(
      directoryMetadata(),
    );
    expect(await tree.getattr(context("latest"))).toEqual(
      symlinkMetadata("notes/a.md"),
    );
    expect(await tree.readdir(context(""))).toEqual([
      "notes",
      "latest",
      "README.md",
    ]);
    expect((await tree.readFile(context("notes/a.md"))).toString()).toBe(
      "alpha",
    );
    expect(await tree.readlink(context("latest"))).toBe("notes/a.md");
    await tree.writeFile(Buffer.from("beta"), writing("notes/b.md"));
    expect(files.get("b.md")).toBe("beta");
    await tree.unlink(context("notes/a.md"));
    expect([...files.keys()]).toEqual(["b.md"]);
    expect((await tree.readFile(context("notes/index.md"))).toString()).toBe(
      "b.md",
    );

    await expect(tree.readdir(context("README.md"))).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(tree.readdir(context("tags/x/gone"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(tree.readdir(context("nothing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(tree.readFile(context("notes"))).rejects.toMatchObject({
      code: "EISDIR",
    });
    await expect(tree.readFile(context("latest"))).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(tree.readFile(context("notes/a.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(tree.readlink(context("README.md"))).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(
      tree.writeFile(Buffer.from(""), writing("README.md")),
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      tree.writeFile(Buffer.from(""), writing("notes")),
    ).rejects.toMatchObject({ code: "EISDIR" });
    await expect(
      tree.writeFile(Buffer.from(""), writing("other")),
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      tree.writeFile(Buffer.from(""), writing("notes/taken.md")),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(tree.unlink(context("README.md"))).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(tree.unlink(context("notes"))).rejects.toMatchObject({
      code: "EISDIR",
    });
    await expect(
      tree.mkdir(directoryMetadata(), context("notes")),
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(tree.rmdir(context("notes"))).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(tree.rmdir(context("README.md"))).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("exposes only the capabilities its routes implement", async () => {
    const readOnly = new Tree().file("a", () => "a");
    expect(Object.keys(readOnly.provider()).sort()).toEqual([
      "getattr",
      "readFile",
      "readdir",
      "readlink",
    ]);
    const made: string[] = [];
    const writable = new Tree()
      .directory(":dir", {
        list: () => [],
        mkdir: (_metadata, { params }) => {
          made.push(params.dir ?? "");
        },
        rmdir: () => undefined,
      })
      .symlink("link", { target: () => "a", unlink: () => undefined });
    expect(writable.supports("write")).toBe(false);
    expect(Object.keys(writable.provider()).sort()).toEqual([
      "getattr",
      "mkdir",
      "readFile",
      "readdir",
      "readlink",
      "rmdir",
      "unlink",
    ]);
    await writable.provider().mkdir?.(directoryMetadata(), context("new"));
    expect(made).toEqual(["new"]);
  });

  it("serves TreeModule subclasses", async () => {
    class ReadOnly extends TreeModule<{ title: string }> {
      constructor(runtime: ModuleRuntime<{ title: string }>) {
        super(runtime);
        this.tree.file("title.txt", () => `${this.settings.title}\n`);
      }
    }
    const module = new ReadOnly(
      runtime({ settings: { title: "Hi" } }) as unknown as ModuleRuntime<{
        title: string;
      }>,
    );
    expect(module.writeFile).toBeUndefined();
    expect(module.unlink).toBeUndefined();
    expect(module.mkdir).toBeUndefined();
    expect(module.rmdir).toBeUndefined();
    expect((await module.readFile(context("title.txt"))).toString()).toBe(
      "Hi\n",
    );

    const saved: string[] = [];
    class Writable extends TreeModule {
      override async start() {
        await super.start();
        this.tree
          .file("in/:name", {
            read: () => undefined,
            write: (contents) => {
              saved.push(contents.toString());
            },
            unlink: () => undefined,
          })
          .directory("in", { list: () => [], mkdir: () => undefined });
      }
    }
    const writable = new Writable(runtime());
    expect(writable.writeFile).toBeUndefined();
    await writable.start();
    await writable.writeFile?.(Buffer.from("x"), writing("in/a"));
    expect(saved).toEqual(["x"]);
    expect(typeof writable.unlink).toBe("function");
    expect(typeof writable.mkdir).toBe("function");
    expect(writable.rmdir).toBeUndefined();
  });
});
