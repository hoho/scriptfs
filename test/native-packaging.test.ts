import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { nativeBinary } from "../src/native-binary.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const platforms = readdirSync("packages/native", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const executable = process.platform === "win32" ? "scriptfs.exe" : "scriptfs";
const platformPackage = `@scriptfs/${process.platform}-${process.arch}`;

async function temporary() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "scriptfs-native-package-")),
  );
  directories.push(root);
  return root;
}

async function put(file: string, contents: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function installedRoot(options: { local?: string; platform?: boolean }) {
  const root = await temporary();
  await put(path.join(root, "package.json"), "{}");
  if (options.local !== undefined) {
    await put(path.join(root, "dist", executable), "local");
    await put(
      path.join(root, "dist/native.json"),
      JSON.stringify({ platform: process.platform, arch: options.local }),
    );
  }
  const directory = path.join(root, "node_modules", platformPackage);
  await put(path.join(directory, "package.json"), "{}");
  if (options.platform) await put(path.join(directory, executable), "binary");
  return { root, platform: path.join(directory, executable) };
}

it("prefers a matching source build in dist", async () => {
  const { root } = await installedRoot({ local: process.arch, platform: true });
  expect(nativeBinary(root)).toBe(path.join(root, "dist", executable));
});

it("uses the installed platform package otherwise", async () => {
  const { root, platform } = await installedRoot({
    local: "incompatible",
    platform: true,
  });
  expect(nativeBinary(root)).toBe(platform);
});

it("explains a missing platform package or binary", async () => {
  const missingBinary = await installedRoot({});
  expect(() => nativeBinary(missingBinary.root)).toThrow(
    `${platformPackage} is missing ${executable}`,
  );
  // pnpm's launchers set NODE_PATH to the hoisted workspace store, which would
  // find the workspace platform package; installed packages do not rely on it.
  const notInstalled = await temporary();
  await put(path.join(notInstalled, "package.json"), "{}");
  const env = { ...process.env };
  delete env.NODE_PATH;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { nativeBinary } from ${JSON.stringify(pathToFileURL(path.resolve("src/native-binary.ts")).href)};
       try { nativeBinary(${JSON.stringify(notInstalled)}); } catch (error) { console.log(error.message); }`,
    ],
    { encoding: "utf8", env },
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`${platformPackage} is not installed`);
  expect(result.stdout).toContain(`make install-native in ${notInstalled}`);
});

it("declares one optional platform package per release target", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    version: string;
    optionalDependencies: Record<string, string>;
  };
  expect(platforms).toEqual([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  expect(Object.keys(manifest.optionalDependencies).sort()).toEqual(
    platforms.map((platform) => `@scriptfs/${platform}`).sort(),
  );
  expect(Object.values(manifest.optionalDependencies)).toEqual(
    platforms.map(() => "workspace:*"),
  );
  for (const platform of platforms) {
    const [os = "", cpu = ""] = platform.split("-");
    const name = os === "win32" ? "scriptfs.exe" : "scriptfs";
    expect(
      JSON.parse(
        await readFile(`packages/native/${platform}/package.json`, "utf8"),
      ),
    ).toMatchObject({
      name: `@scriptfs/${platform}`,
      version: manifest.version,
      os: [os],
      cpu: [cpu],
      files: [name],
      ...(os === "win32"
        ? {}
        : { publishConfig: { executableFiles: [`./${name}`] } }),
    });
  }
});

it.each([
  { name: "LF", newline: "\n" },
  { name: "CRLF", newline: "\r\n" },
])("checks and bumps versions with $name line endings", async ({ newline }) => {
  const root = await temporary();
  await put(
    path.join(root, "scripts/bump-version.mjs"),
    await readFile("scripts/bump-version.mjs"),
  );
  for (const file of [
    "package.json",
    "packages/module/package.json",
    "packages/testing/package.json",
  ])
    await put(
      path.join(root, file),
      JSON.stringify({ version: "1.2.3", private: true }, null, 2).replace(
        /\n/g,
        newline,
      ) + newline,
    );
  await mkdir(path.join(root, "packages/native"));
  await put(path.join(root, "Cargo.toml"), `version = "1.2.3"${newline}`);
  const lock = [
    "[[package]]",
    'name = "scriptfs"',
    'version = "1.2.3"',
    "",
  ].join(newline);
  await put(path.join(root, "Cargo.lock"), lock);
  await put(
    path.join(root, "rust/runtime.rs"),
    "// scriptfs-runtime:" + `1.2.3${newline}`,
  );
  for (const args of [["init"], ["add", "."]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/bump-version.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  for (const args of [
    ["--check", "v1.2.3"],
    ["2.0.0-rc.1"],
    ["--check", "v2.0.0-rc.1"],
  ]) {
    const result = run(...args);
    expect(result.status, result.stderr).toBe(0);
  }
  expect(await readFile(path.join(root, "Cargo.lock"), "utf8")).toBe(
    lock.replace("1.2.3", "2.0.0-rc.1"),
  );
  await put(path.join(root, "Cargo.lock"), lock);
  const mismatch = run("--check");
  expect(mismatch.status).not.toBe(0);
  expect(mismatch.stderr).toContain("Cargo.lock: 1.2.3");
});

/** Minimal executable headers recognised by the pre-publish check. */
function header(os: string, cpu: string) {
  const buffer = Buffer.alloc(256);
  if (os === "linux") {
    buffer.writeUInt32BE(0x7f454c46, 0);
    buffer.writeUInt16LE(cpu === "x64" ? 62 : 183, 18);
  } else if (os === "darwin") {
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(cpu === "x64" ? 0x01000007 : 0x0100000c, 4);
  } else {
    buffer.write("MZ", 0, "latin1");
    buffer.writeUInt32LE(0x80, 0x3c);
    buffer.write("PE\0\0", 0x80, "latin1");
    buffer.writeUInt16LE(cpu === "x64" ? 0x8664 : 0xaa64, 0x84);
  }
  return buffer;
}

async function releaseFixture() {
  const root = await temporary();
  await put(
    path.join(root, "scripts/build-native.mjs"),
    await readFile("scripts/build-native.mjs"),
  );
  await put(path.join(root, "package.json"), await readFile("package.json"));
  for (const platform of platforms) {
    const [os = "", cpu = ""] = platform.split("-");
    const directory = path.join(root, "packages/native", platform);
    await put(
      path.join(directory, "package.json"),
      await readFile(`packages/native/${platform}/package.json`),
    );
    const name = os === "win32" ? "scriptfs.exe" : "scriptfs";
    await put(path.join(directory, name), header(os, cpu));
    await chmod(path.join(directory, name), 0o644);
  }
  return root;
}

function check(root: string) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/build-native.mjs"), "--check"],
    { encoding: "utf8" },
  );
}

it("validates every platform binary before publishing", async () => {
  const root = await releaseFixture();
  const result = check(root);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  if (process.platform !== "win32")
    expect(
      (await stat(path.join(root, "packages/native/linux-x64/scriptfs"))).mode &
        0o777,
    ).toBe(0o755);
});

it("rejects missing and mismatched platform binaries", async () => {
  const root = await releaseFixture();
  await rm(path.join(root, "packages/native/win32-arm64/scriptfs.exe"));
  await writeFile(
    path.join(root, "packages/native/linux-arm64/scriptfs"),
    header("linux", "x64"),
  );
  const result = check(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "@scriptfs/win32-arm64: scriptfs.exe is missing",
  );
  expect(result.stderr).toContain(
    "@scriptfs/linux-arm64: scriptfs is a linux-x64 executable",
  );
  expect(result.stderr).not.toContain("@scriptfs/darwin-x64");
});

const npmLockfiles = [
  "container/npm-shrinkwrap.json",
  ...readdirSync("examples", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ["npm-shrinkwrap.json", "package-lock.json"].map(
        (name) => `examples/${entry.name}/module/${name}`,
      ),
    )
    .filter((file) => existsSync(file)),
];

it.each(npmLockfiles)("commits %s without registry URLs", async (lockfile) => {
  const lock = JSON.parse(await readFile(lockfile, "utf8")) as {
    packages?: Record<string, { resolved?: string; integrity?: string }>;
  };
  const entries = Object.entries(lock.packages ?? {});
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.filter(([, entry]) => entry.resolved !== undefined)).toEqual(
    [],
  );
  expect(
    entries.filter(([name, entry]) => name !== "" && !entry.integrity),
  ).toEqual([]);
});

it("commits pnpm-lock.yaml without tarball URLs", async () => {
  expect(npmLockfiles).toContain(
    "examples/markdown/module/npm-shrinkwrap.json",
  );
  expect(await readFile("pnpm-lock.yaml", "utf8")).not.toMatch(
    /\btarball:|https?:\/\//,
  );
});

const digest = `sha256:${"0123456789abcdef".repeat(4)}`;

async function releaseImageFixture(version: string) {
  const root = await temporary();
  await put(
    path.join(root, "scripts/release-image.mjs"),
    await readFile("scripts/release-image.mjs"),
  );
  await put(path.join(root, "package.json"), JSON.stringify({ version }));
  await mkdir(path.join(root, "container"));
  return root;
}

function releaseImage(root: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-image.mjs"), ...args],
    { encoding: "utf8" },
  );
}

it("pins the published runtime image by digest", async () => {
  const root = await releaseImageFixture("1.2.3");
  const missing = releaseImage(root, "--check");
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain(
    `${path.join("container", "runtime-image.json")} is missing or invalid`,
  );

  const image = `ghcr.io/example/runtime@${digest}`;
  const written = releaseImage(root, "--write", image);
  expect(written.stderr).toBe("");
  expect(written.status).toBe(0);
  expect(
    JSON.parse(
      await readFile(path.join(root, "container/runtime-image.json"), "utf8"),
    ),
  ).toEqual({ image, version: "1.2.3" });
  expect(releaseImage(root, "--check").status).toBe(0);
  for (const other of [`localhost:5000/runtime@${digest}`, `runtime@${digest}`])
    expect(releaseImage(root, "--write", other).status, other).toBe(0);

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "1.2.4" }),
  );
  const stale = releaseImage(root, "--check");
  expect(stale.status).not.toBe(0);
  expect(stale.stderr).toContain("was written for another version");
});

it("rejects runtime image references without a digest", async () => {
  const root = await releaseImageFixture("1.2.3");
  for (const image of [
    "ghcr.io/example/runtime:1.2.3",
    `ghcr.io/example/runtime:1.2.3@${digest}`,
    `ghcr.io/example/runtime@${digest.toUpperCase()}`,
    `@${digest}`,
    `ghcr.io/@${digest}`,
  ]) {
    const result = releaseImage(root, "--write", image);
    expect(result.status, image).not.toBe(0);
    expect(result.stderr).toContain("Expected a digest-pinned image");
  }
  expect(releaseImage(root, "--write").status).toBe(2);
});
