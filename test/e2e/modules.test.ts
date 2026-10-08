import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../../src/native-config.js";
import { startScriptFs } from "../../src/session.js";
import { runCommand } from "../helpers/command.js";
import type { OverlayRule, ScriptFsSession } from "../../src/types.js";

const examples = path.resolve(import.meta.dirname, "../../examples");
const todoToken = "todo-e2e-token";
const inboxToken = "inbox-e2e-token";

let root: string;
let mount: string;
let configPath: string;
let apiPort: number;
let inboxPort: number;
let server: ChildProcess | undefined;
let session: ScriptFsSession | undefined;
let cache: string;
const previousCache = process.env.SCRIPTFS_CACHE_DIR;

async function freePort(): Promise<number> {
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as net.AddressInfo;
  listener.close();
  await once(listener, "close");
  return port;
}

// Reports what the module sees in the container and exercises its bound paths.
const probeSource = `import { readFile, writeFile } from "node:fs/promises";
import { TreeModule, fileMetadata } from "@scriptfs/module";

export default class Probe extends TreeModule {
  starts = this.state({ count: 0 });

  constructor(runtime) {
    super(runtime);
    this.tree
      .directory("", () => ["runtime.json", "config.txt", "readonly.txt", "drop"])
      .file("runtime.json", async () =>
        JSON.stringify({
          name: this.name,
          manifest: this.runtime.manifest.name,
          settings: this.settings,
          secret: this.secret("key"),
          paths: this.runtime.paths,
          stateDir: this.runtime.stateDir,
          starts: (await this.starts.read()).count,
        }),
      )
      .file("config.txt", () => readFile(this.path("config")))
      .file("readonly.txt", () =>
        writeFile(this.path("config"), "changed").then(
          () => "writable",
          (error) => error.code,
        ),
      )
      .directory("drop", () => [])
      .file("drop/:name", {
        metadata: ({ params }) =>
          readFile(this.path("drop", params.name)).then(
            (data) => fileMetadata({ size: data.length }),
            () => undefined,
          ),
        read: ({ params }) =>
          readFile(this.path("drop", params.name)).catch(() => undefined),
        write: (contents, { params }) =>
          writeFile(this.path("drop", params.name), contents),
      });
  }

  async start() {
    await this.starts.update((value) => {
      value.count++;
    });
  }
}
`;

function rule(name: string): OverlayRule[] {
  return [
    {
      match: `${name}/**`,
      root: name,
      opaque: true,
      provider: { module: name.toLowerCase() },
    },
  ];
}

async function start(): Promise<ScriptFsSession> {
  return startScriptFs(await loadConfig(configPath));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-modules-e2e-"));
  mount = path.join(root, "mount");
  cache = path.join(root, "cache");
  process.env.SCRIPTFS_CACHE_DIR = cache;
  apiPort = await freePort();
  inboxPort = await freePort();
  process.env.SCRIPTFS_E2E_TODO_TOKEN = todoToken;
  process.env.SCRIPTFS_E2E_INBOX_TOKEN = inboxToken;

  const api = spawn(
    process.execPath,
    [path.join(examples, "local-api/server.mjs")],
    {
      env: {
        ...process.env,
        PORT: String(apiPort),
        TODO_API_TOKEN: todoToken,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  server = api;
  await once(api.stdout, "data");

  const probe = path.join(root, "probe");
  await mkdir(probe);
  await mkdir(path.join(root, "drop"));
  await mkdir(path.join(root, "source"));
  await writeFile(path.join(probe, "index.mjs"), probeSource);
  await writeFile(
    path.join(probe, "scriptfs.module.json"),
    JSON.stringify({
      name: "e2e-probe",
      entry: "./index.mjs",
      settings: {
        greeting: { type: "string", required: true },
        count: { type: "integer", default: 3 },
      },
      secrets: { key: { required: true } },
      paths: {
        drop: { access: "read-write", target: "/drop" },
        config: { type: "file" },
      },
      state: true,
    }),
  );
  await writeFile(path.join(root, "probe.conf"), "probe configuration\n");
  await writeFile(path.join(root, "probe.key"), "s3cret\n");
  await cp(
    path.join(examples, "notes/sample-notes"),
    path.join(root, "notes"),
    {
      recursive: true,
    },
  );

  const config = {
    modules: {
      todos: {
        manifest: path.join(examples, "local-api/module"),
        secrets: { token: { env: "SCRIPTFS_E2E_TODO_TOKEN" } },
        ports: { api: { target: `127.0.0.1:${String(apiPort)}` } },
      },
      notes: {
        manifest: path.join(examples, "notes/module"),
        settings: { extensions: [".md"] },
        paths: { notes: "./notes" },
      },
      inbox: {
        manifest: path.join(examples, "inbox/module"),
        settings: { maxMessages: 2 },
        secrets: { token: { env: "SCRIPTFS_E2E_INBOX_TOKEN" } },
        ports: { http: { hostPort: inboxPort } },
        state: "./inbox-state",
      },
      markdown: {
        manifest: path.join(examples, "markdown/module"),
        paths: { docs: path.join(examples, "markdown/docs") },
      },
      probe: {
        manifest: "./probe",
        settings: { greeting: "hello" },
        secrets: { key: { file: "./probe.key" } },
        paths: { drop: "./drop", config: "./probe.conf" },
      },
    },
    filesystems: [
      {
        name: "modules",
        source: "./source",
        mountPoint: "./mount",
        rules: ["Todos", "Notes", "Inbox", "Markdown", "Probe"].flatMap(rule),
      },
    ],
    container: {
      image: process.env.SCRIPTFS_E2E_RUNTIME_IMAGE,
      rebuild: process.env.SCRIPTFS_E2E_REBUILD === "1",
      logLevel: process.env.SCRIPTFS_E2E_DEBUG ? "debug" : "silent",
    },
  };
  configPath = path.join(root, "scriptfs.json");
  await writeFile(configPath, JSON.stringify(config));
  session = await start();
}, 180_000);

afterAll(async () => {
  await session?.stop();
  if (previousCache === undefined) delete process.env.SCRIPTFS_CACHE_DIR;
  else process.env.SCRIPTFS_CACHE_DIR = previousCache;
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  if (root) {
    const mounts = await runCommand("mount", []);
    if (mounts.stdout.includes(root))
      throw new Error("Module mount is still active; refusing cleanup");
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("reaches a host server through an outbound port with an env secret", async () => {
  const todos = path.join(mount, "Todos");
  expect((await readdir(todos)).sort()).toEqual([
    "Buy milk.md",
    "Water the plants.md",
  ]);
  expect(await readFile(path.join(todos, "Buy milk.md"), "utf8")).toBe(
    "- [ ] Buy milk\n",
  );
  await writeFile(path.join(todos, "Call mom.md"), "- [x] Call mom\n");
  const response = await fetch(`http://127.0.0.1:${String(apiPort)}/todos`, {
    headers: { authorization: `Bearer ${todoToken}` },
  });
  expect(await response.json()).toContainEqual(
    expect.objectContaining({ title: "Call mom", done: true }),
  );
});

it("reads a read-only host path with configured settings", async () => {
  const notes = path.join(mount, "Notes");
  expect((await readdir(path.join(notes, "Tags"))).sort()).toEqual([
    "errands",
    "home",
    "work",
  ]);
  expect(await readdir(path.join(notes, "Tags", "work"))).toEqual([
    "projects - plan.md",
  ]);
  await writeFile(path.join(root, "notes", "new.md"), "Fresh #ideas\n");
  await expect
    .poll(() => readdir(path.join(notes, "Tags")), { timeout: 10_000 })
    .toContain("ideas");
});

async function installed(): Promise<string[]> {
  return readdir(path.join(cache, "dependencies"));
}

it("installs locked npm dependencies into the container", async () => {
  const pages = path.join(mount, "Markdown");
  expect((await readdir(pages)).sort()).toEqual(["guides", "index.html"]);
  expect(await readFile(path.join(pages, "index.html"), "utf8")).toContain(
    "<strong>Markdown</strong>",
  );
  expect(
    await readFile(path.join(pages, "guides", "getting-started.html"), "utf8"),
  ).toContain("<h1>Getting started</h1>");
  const entries = await installed();
  expect(entries).toHaveLength(1);
  const entry = String(entries[0]);
  const marked = JSON.parse(
    await readFile(
      path.join(
        cache,
        "dependencies",
        entry,
        "node_modules/marked/package.json",
      ),
      "utf8",
    ),
  ) as { version: string };
  expect(marked.version).toBe("18.0.14");
  await expect(
    readdir(path.join(examples, "markdown/module/node_modules")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("exposes bound paths, settings, file secrets and state to a module", async () => {
  const probe = path.join(mount, "Probe");
  const runtime = JSON.parse(
    await readFile(path.join(probe, "runtime.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(runtime).toEqual({
    name: "probe",
    manifest: "e2e-probe",
    settings: { greeting: "hello", count: 3 },
    secret: "s3cret",
    paths: { drop: "/drop", config: "/scriptfs/paths/probe/config" },
    stateDir: "/scriptfs/state/probe",
    starts: 1,
  });
  expect(await readFile(path.join(probe, "config.txt"), "utf8")).toBe(
    "probe configuration\n",
  );
  expect(await readFile(path.join(probe, "readonly.txt"), "utf8")).toBe(
    "EROFS",
  );
  // The backing path bypasses SMB; flush its buffered write before reading it.
  await writeFile(path.join(probe, "drop", "out.txt"), "from the container", {
    flush: true,
  });
  expect(await readFile(path.join(root, "drop", "out.txt"), "utf8")).toBe(
    "from the container",
  );
});

it("publishes an inbound port and keeps module state across restarts", async () => {
  const url = `http://127.0.0.1:${String(inboxPort)}/messages`;
  const inbox = path.join(mount, "Inbox");
  expect(await readFile(path.join(inbox, "README.txt"), "utf8")).toContain(url);
  const message = JSON.stringify({ from: "e2e", subject: "Hi", body: "Hello" });
  expect((await fetch(url, { method: "POST", body: message })).status).toBe(
    401,
  );
  const accepted = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${inboxToken}` },
    body: message,
  });
  expect(accepted.status).toBe(201);
  expect(await readdir(inbox)).toEqual(["0001-Hi.txt", "README.txt"]);

  const dependencies = await installed();
  await session?.stop();
  session = undefined;
  session = await start();
  expect(await installed()).toEqual(dependencies);

  expect(await readdir(inbox)).toEqual(["0001-Hi.txt", "README.txt"]);
  expect(await readFile(path.join(inbox, "0001-Hi.txt"), "utf8")).toContain(
    "Hello",
  );
  const runtime = JSON.parse(
    await readFile(path.join(mount, "Probe", "runtime.json"), "utf8"),
  ) as { starts: number };
  expect(runtime.starts).toBe(2);
}, 180_000);
