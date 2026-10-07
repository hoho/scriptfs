import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectModule } from "scriptfs";
import { hostServer, waitFor } from "@scriptfs/testing";
import { prepare } from "../src/harness.js";
import { describeManifest, devOptions, main } from "../src/commands.js";
import { init, packageVersion, scaffold } from "../src/scaffold.js";

let root: string;
let moduleDir: string;
let workspace: string;
const windows = process.platform === "win32";
const mountOptions = windows ? { mount: "S:" } : {};

const manifest = {
  name: "fixture",
  version: "1.2.3",
  description: "A module for harness tests.",
  entry: "./index.mjs",
  settings: {
    greeting: { type: "string", required: true },
    count: { type: "integer", default: 3 },
  },
  secrets: {
    token: { description: "API token" },
    extra: { required: false, env: "FIXTURE_EXTRA" },
  },
  ports: {
    api: { direction: "outbound", target: "127.0.0.1:9000" },
    http: { direction: "inbound", port: 8080 },
  },
  paths: {
    data: { access: "read-write" },
    config: { type: "file", required: false },
  },
  state: true,
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-testing-unit-"));
  moduleDir = path.join(root, "module");
  workspace = path.join(root, "workspace");
  await mkdir(moduleDir);
  await mkdir(workspace);
  await writeFile(
    path.join(moduleDir, "scriptfs.module.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    path.join(moduleDir, "index.mjs"),
    "export default class {}\n",
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("prepare", () => {
  it("builds a one-module configuration", async () => {
    const prepared = await prepare(
      {
        module: pathToFileURL(`${moduleDir}/`),
        ...mountOptions,
        cwd: root,
        instance: "fixture",
        settings: { greeting: "hi" },
        secrets: {
          token: "s3cret",
          extra: { env: "FIXTURE_EXTRA" },
        },
        outbound: { api: 4321 },
        paths: {
          data: { files: { "a.txt": "A", "nested/b.txt": "B" } },
          config: { contents: "key = value\n" },
        },
        options: { flag: true },
        source: { "README.md": "source\n" },
        readOnly: true,
        image: "localhost/example:test",
        logLevel: "debug",
      },
      workspace,
    );
    expect(prepared.manifestPath).toBe(
      path.join(root, "module", "scriptfs.module.json"),
    );
    expect(prepared.manifest.name).toBe("fixture");
    expect(prepared.instance).toBe("fixture");
    const inbound = prepared.inbound.get("http");
    expect(inbound).toBeGreaterThan(0);
    expect(prepared.stateDir).toBe(path.join(workspace, "state"));
    const mount = windows ? "S:" : path.join(workspace, "mount");
    expect(prepared.mount).toBe(mount);

    const secretFile = path.join(workspace, "secrets", "token");
    expect(prepared.config).toEqual({
      modules: {
        fixture: {
          manifest: prepared.manifestPath,
          settings: { greeting: "hi" },
          secrets: {
            token: { file: secretFile },
            extra: { env: "FIXTURE_EXTRA" },
          },
          ports: {
            api: { target: "127.0.0.1:4321" },
            http: { hostPort: inbound },
          },
          paths: {
            data: path.join(workspace, "paths", "data"),
            config: path.join(workspace, "paths", "config"),
          },
          state: path.join(workspace, "state"),
        },
      },
      filesystems: [
        {
          name: "module",
          source: path.join(workspace, "source"),
          mountPoint: mount,
          readOnly: true,
          rules: [
            {
              match: "**",
              opaque: true,
              provider: { module: "fixture", options: { flag: true } },
            },
          ],
        },
      ],
      container: { logLevel: "debug", image: "localhost/example:test" },
    });
    expect(await readFile(secretFile, "utf8")).toBe("s3cret");
    if (!windows) expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    expect(
      await readFile(path.join(workspace, "paths/data/nested/b.txt"), "utf8"),
    ).toBe("B");
    expect(await readFile(path.join(workspace, "paths/config"), "utf8")).toBe(
      "key = value\n",
    );
    expect(
      await readFile(path.join(workspace, "source/README.md"), "utf8"),
    ).toBe("source\n");
  });

  it("uses defaults and resolves host paths against cwd", async () => {
    vi.stubEnv("SCRIPTFS_TEST_IMAGE", "");
    vi.stubEnv("SCRIPTFS_TEST_LOG_LEVEL", "");
    const prepared = await prepare(
      {
        module: "./module",
        cwd: root,
        inbound: { http: 18080 },
        outbound: { api: { target: "10.0.0.1:80" } },
        paths: { data: "./data" },
        state: "./state",
        mount: windows ? "S:" : "./mnt",
      },
      workspace,
    );
    const module = prepared.config.modules?.module;
    expect(prepared.instance).toBe("module");
    expect(module?.ports).toEqual({
      api: { target: "10.0.0.1:80" },
      http: { hostPort: 18080 },
    });
    expect(module?.paths).toEqual({ data: path.join(root, "data") });
    expect(module?.state).toBe(path.join(root, "state"));
    expect(prepared.mount).toBe(windows ? "S:" : path.join(root, "mnt"));
    expect(prepared.config.container).toEqual({ logLevel: "silent" });
    expect(prepared.config.filesystems[0]?.rules).toEqual([
      { match: "**", opaque: true, provider: { module: "module" } },
    ]);
  });

  it("reads the image and log level from the environment", async () => {
    vi.stubEnv("SCRIPTFS_TEST_IMAGE", "localhost/from-env:1");
    vi.stubEnv("SCRIPTFS_TEST_LOG_LEVEL", "info");
    const { config } = await prepare(
      { module: moduleDir, ...mountOptions },
      workspace,
    );
    expect(config.container).toEqual({
      logLevel: "info",
      image: "localhost/from-env:1",
    });
    vi.stubEnv("SCRIPTFS_TEST_LOG_LEVEL", "loud");
    await expect(
      prepare({ module: moduleDir, ...mountOptions }, workspace),
    ).rejects.toThrow("SCRIPTFS_TEST_LOG_LEVEL must be silent, info or debug");
  });

  it("rejects ports and state the manifest does not declare", async () => {
    await expect(
      prepare({ module: moduleDir, outbound: { http: 1 } }, workspace),
    ).rejects.toThrow(
      'The manifest of fixture declares no outbound port "http"',
    );
    await expect(
      prepare({ module: moduleDir, inbound: { db: 1 } }, workspace),
    ).rejects.toThrow('The manifest of fixture declares no inbound port "db"');
    await writeFile(
      path.join(moduleDir, "scriptfs.module.json"),
      JSON.stringify({ name: "stateless", entry: "./index.mjs" }),
    );
    await expect(
      prepare({ module: moduleDir, state: "./state" }, workspace),
    ).rejects.toThrow("The manifest of stateless does not use state");
  });

  it("keeps generated files inside their folder", async () => {
    await expect(
      prepare(
        { module: moduleDir, source: { "../escape.txt": "x" } },
        workspace,
      ),
    ).rejects.toThrow('File "../escape.txt" is outside its folder');
  });

  it("reports invalid modules", async () => {
    await rm(path.join(moduleDir, "index.mjs"));
    await expect(prepare({ module: moduleDir }, workspace)).rejects.toThrow(
      /index\.mjs/,
    );
  });
});

describe("hostServer", () => {
  it("answers through the handler and records requests", async () => {
    const server = await hostServer(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/fail") throw new Error("boom");
      if (url.pathname !== "/echo") return undefined;
      return Response.json({
        method: request.method,
        body: await request.text(),
        auth: request.headers.get("authorization"),
      });
    });
    try {
      expect(server.target).toBe(`127.0.0.1:${String(server.port)}`);
      expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}`);
      const echo = await fetch(`${server.url}/echo?x=1`, {
        method: "POST",
        headers: { authorization: "Bearer t" },
        body: "hello",
      });
      expect(await echo.json()).toEqual({
        method: "POST",
        body: "hello",
        auth: "Bearer t",
      });
      expect((await fetch(`${server.url}/missing`)).status).toBe(404);
      const failed = await fetch(`${server.url}/fail`);
      expect(failed.status).toBe(500);
      expect(await failed.text()).toContain("boom");
      expect(server.requests.map(({ method, path }) => [method, path])).toEqual(
        [
          ["POST", "/echo?x=1"],
          ["GET", "/missing"],
          ["GET", "/fail"],
        ],
      );
      expect(server.requests[0]).toMatchObject({
        body: "hello",
        headers: { authorization: "Bearer t" },
      });
    } finally {
      await server.close();
    }
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});

describe("waitFor", () => {
  it("returns the first accepted value", async () => {
    let attempts = 0;
    const value = await waitFor(
      () => {
        attempts++;
        if (attempts === 1) throw new Error("not yet");
        return attempts < 3 ? false : attempts;
      },
      { interval: 1 },
    );
    expect(value).toBe(3);
  });

  it("times out with the last error as the cause", async () => {
    const error = await waitFor(
      () => {
        throw new Error("still failing");
      },
      { timeout: 20, interval: 5 },
    ).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Timed out waiting for the condition");
    expect((error.cause as Error).message).toBe("still failing");
  });
});

describe("scaffold", () => {
  it("creates a valid module project", async () => {
    const version = await packageVersion();
    const project = path.join(root, "hello");
    const files = await init(project, "hello", version);
    expect(files.sort()).toEqual([
      ".gitignore",
      "README.md",
      "index.mjs",
      "package.json",
      "scriptfs.module.json",
      "test/module.test.mjs",
    ]);
    const pkg = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    expect(pkg.devDependencies).toEqual({
      "@scriptfs/module": `^${version}`,
      "@scriptfs/testing": `^${version}`,
      "scriptfs": `^${version}`,
    });
    const { manifest: parsed } = await inspectModule(project);
    expect(parsed).toMatchObject({ name: "hello", entry: "./index.mjs" });
    await expect(init(project, "hello", version)).rejects.toThrow(
      "already exists",
    );
  });

  it("rejects invalid names", () => {
    expect(() => scaffold("Hello World", "1.0.0")).toThrow(
      'Invalid module name "Hello World"',
    );
  });
});

describe("commands", () => {
  it("describes a manifest", async () => {
    const { manifest: parsed, manifestPath } = await inspectModule(moduleDir);
    expect(describeManifest(parsed, manifestPath)).toBe(
      [
        `fixture@1.2.3: ${manifestPath}`,
        "  A module for harness tests.",
        "  entry: ./index.mjs",
        "  dependencies: bundled",
        "  settings: count (integer), greeting (string, required)",
        "  secrets: extra (optional, $FIXTURE_EXTRA), token",
        "  ports: api (outbound 127.0.0.1:9000), http (inbound 8080)",
        "  paths: config (file, read-only, optional), data (directory, read-write)",
        "  state: yes",
      ].join("\n"),
    );
  });

  it("parses dev options", () => {
    expect(
      devOptions([
        "./module",
        "--setting",
        "count=5",
        "--setting",
        "greeting=hi there",
        "--secret",
        "token=a=b",
        "--secret-env",
        "extra=EXTRA",
        "--secret-file",
        "other=./key",
        "--path",
        "data=./data",
        "--outbound",
        "api=127.0.0.1:9000",
        "--inbound",
        "http=8081",
        "--state",
        "./state",
        "--options",
        '{"x":1}',
        "--mount",
        "./mnt",
        "--image",
        "img",
        "--log-level",
        "debug",
      ]),
    ).toEqual({
      module: "./module",
      settings: { count: 5, greeting: "hi there" },
      secrets: {
        token: "a=b",
        extra: { env: "EXTRA" },
        other: { file: "./key" },
      },
      paths: { data: "./data" },
      outbound: { api: "127.0.0.1:9000" },
      inbound: { http: 8081 },
      state: "./state",
      options: { x: 1 },
      mount: "./mnt",
      image: "img",
      logLevel: "debug",
    });
    expect(devOptions([])).toMatchObject({ module: ".", logLevel: "info" });
    expect(() => devOptions(["a", "b"])).toThrow("dev accepts one module");
    expect(() => devOptions(["--setting", "novalue"])).toThrow(
      "--setting expects <key>=<value>",
    );
    expect(() => devOptions(["--inbound", "http=99999"])).toThrow(
      "--inbound http must be a port number",
    );
    expect(() => devOptions(["--log-level", "loud"])).toThrow(
      "--log-level must be silent, info or debug",
    );
  });

  it("runs check, help and unknown commands", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["check", moduleDir])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain("fixture@1.2.3");
    expect(await main(["--help"])).toBe(0);
    expect(await main([])).toBe(1);
    expect(log.mock.calls.at(-1)?.[0]).toContain("Usage: scriptfs-module");
    await expect(main(["frobnicate"])).rejects.toThrow(
      'Unknown command "frobnicate"',
    );
    await expect(main(["check", "a", "b"])).rejects.toThrow(
      "check accepts one module",
    );
  });
});
