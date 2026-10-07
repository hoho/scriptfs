import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rust release targets published as `@scriptfs/<os>-<cpu>` packages.
 * @type {Record<string, { os: string, cpu: string }>}
 */
export const nativeTargets = {
  "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
  "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
  "aarch64-unknown-linux-musl": { os: "linux", cpu: "arm64" },
  "x86_64-unknown-linux-musl": { os: "linux", cpu: "x64" },
  "aarch64-pc-windows-msvc": { os: "win32", cpu: "arm64" },
  "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
};

const root = fileURLToPath(new URL("../", import.meta.url));
const nativePackages = path.join(root, "packages/native");

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readManifest(file) {
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(manifest)) throw new Error(`${file} is not a JSON object.`);
  return manifest;
}

/** @param {string} os */
function executable(os) {
  return os === "win32" ? "scriptfs.exe" : "scriptfs";
}

/** @param {string} binary */
function machine(binary) {
  const header = readFileSync(binary).subarray(0, 4096);
  if (header.readUInt32BE(0) === 0x7f454c46) {
    const cpu = { 62: "x64", 183: "arm64" }[header.readUInt16LE(18)];
    return { os: "linux", cpu };
  }
  if (header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = { 0x01000007: "x64", 0x0100000c: "arm64" }[
      header.readUInt32LE(4)
    ];
    return { os: "darwin", cpu };
  }
  if (header.toString("latin1", 0, 2) === "MZ") {
    const pe = header.readUInt32LE(0x3c);
    if (header.toString("latin1", pe, pe + 4) === "PE\0\0") {
      const cpu = { 0x8664: "x64", 0xaa64: "arm64" }[
        header.readUInt16LE(pe + 4)
      ];
      return { os: "win32", cpu };
    }
  }
  return { os: undefined, cpu: undefined };
}

/** @param {string[]} args */
function cargo(args) {
  const result = spawnSync(process.env.CARGO ?? "cargo", args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** @param {string} target */
function buildPackage(target) {
  const platform = nativeTargets[target];
  if (!platform)
    throw new Error(
      `Unknown native target ${target}; expected one of ${Object.keys(nativeTargets).join(", ")}.`,
    );
  cargo(["build", "--release", "--locked", "--target", target]);
  const name = executable(platform.os);
  const binary = path.join(
    nativePackages,
    `${platform.os}-${platform.cpu}`,
    name,
  );
  copyFileSync(
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      target,
      "release",
      name,
    ),
    binary,
  );
  if (platform.os !== "win32") chmodSync(binary, 0o755);
  if (platform.os === process.platform && platform.cpu === process.arch) {
    const result = spawnSync(binary, ["--help"], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout.startsWith("Usage: scriptfs"))
      throw new Error(
        `The ${target} binary failed its smoke test:\n${result.stdout}${result.stderr}`,
      );
  }
  console.log(`Built ${path.relative(root, binary)}`);
}

/** Validates every platform package before publishing and restores executable modes lost by CI artifacts. */
function checkPackages() {
  const version = String(readManifest(path.join(root, "package.json")).version);
  const expected = Object.values(nativeTargets)
    .map(({ os, cpu }) => `${os}-${cpu}`)
    .sort();
  const actual = readdirSync(nativePackages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `packages/native contains ${actual.join(", ")}; expected ${expected.join(", ")}.`,
    );
  /** @type {string[]} */
  const problems = [];
  for (const { os, cpu } of Object.values(nativeTargets)) {
    const directory = path.join(nativePackages, `${os}-${cpu}`);
    const manifest = readManifest(path.join(directory, "package.json"));
    const publishConfig = isRecord(manifest.publishConfig)
      ? manifest.publishConfig
      : {};
    const name = executable(os);
    const binary = path.join(directory, name);
    if (
      manifest.name !== `@scriptfs/${os}-${cpu}` ||
      manifest.version !== version ||
      JSON.stringify(manifest.os) !== JSON.stringify([os]) ||
      JSON.stringify(manifest.cpu) !== JSON.stringify([cpu]) ||
      JSON.stringify(manifest.files) !== JSON.stringify([name]) ||
      (os !== "win32" &&
        JSON.stringify(publishConfig.executableFiles) !==
          JSON.stringify([`./${name}`]))
    ) {
      problems.push(
        `${String(manifest.name)}: package.json does not match ${os}-${cpu} ${version}`,
      );
      continue;
    }
    if (!existsSync(binary)) {
      problems.push(`${manifest.name}: ${name} is missing`);
      continue;
    }
    const detected = machine(binary);
    if (detected.os !== os || detected.cpu !== cpu) {
      problems.push(
        `${manifest.name}: ${name} is a ${String(detected.os)}-${String(detected.cpu)} executable`,
      );
      continue;
    }
    if (os !== "win32") chmodSync(binary, 0o755);
  }
  if (problems.length > 0)
    throw new Error(`Platform packages are not ready:\n${problems.join("\n")}`);
  console.log(
    `Validated ${String(expected.length)} platform packages for ${version}.`,
  );
}

/** Builds the host binary into dist/ for checkouts. */
function buildLocal() {
  cargo(["build", "--release", "--locked"]);
  const name = executable(process.platform);
  mkdirSync(path.join(root, "dist"), { recursive: true });
  const binary = path.join(root, "dist", name);
  copyFileSync(
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "release",
      name,
    ),
    binary,
  );
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  writeFileSync(
    path.join(root, "dist/native.json"),
    JSON.stringify({ platform: process.platform, arch: process.arch }) + "\n",
  );
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, target] = process.argv.slice(2);
  if (command === "--target" && target) buildPackage(target);
  else if (command === "--check") checkPackages();
  else if (command === undefined) buildLocal();
  else {
    console.error(
      "Usage: node scripts/build-native.mjs [--target <rust-target> | --check]",
    );
    process.exit(1);
  }
}
