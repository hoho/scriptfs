import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  contents,
  filename,
  FILE_COUNT,
  SMALL_SIZE,
  LARGE_SIZE,
  isMeasurements,
  median,
} from "./benchmark-workload.mjs";
import { isProfiles } from "./benchmark-profile-workload.mjs";

/** @typedef {import("./benchmark-workload.mjs").Measurement} Measurement */
/** @typedef {{ version: "before" | "after", round: number, startupMs: number, memoryKiB: number, runtime: { node: string, samba: string }, fuse: Measurement[], smb: Measurement[], diagnostics?: {fuse: import("./benchmark-profile-workload.mjs").Profile[], smb: import("./benchmark-profile-workload.mjs").Profile[],mountInfo:string} }} Sample */
const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const workspace = path.join(repository, "target", "benchmark");
const reference = process.env.BENCH_BASELINE ?? "HEAD";
const make = process.env.BENCH_MAKE ?? "make";
const pnpm = process.env.BENCH_PNPM ?? "pnpm";
const reportPath = path.resolve(
  process.env.BENCH_REPORT ?? path.join(workspace, "results.json"),
);

/** @param {import("node:child_process").ChildProcess} child */
function exit(child) {
  /** @type {Promise<{code: number | null, signal: NodeJS.Signals | null}>} */
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return exited;
}

/** @template T @param {Promise<T>} promise @param {number} milliseconds */
async function deadline(promise, milliseconds) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    /** @type {Promise<never>} */
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("CLI cleanup timed out")),
        milliseconds,
      );
      timer.unref();
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @param {string} command @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env */
async function run(command, args, cwd = repository, env = process.env) {
  const result = await execute(command, args, {
    cwd,
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  return result.stdout.trim();
}

/** @param {string} command @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env */
async function build(command, args, cwd = repository, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  const { code, signal } = await exit(child);
  assert.equal(code, 0, `${command} failed: ${String(code)}/${String(signal)}`);
}

async function versions() {
  const before = await run("git", ["rev-parse", `${reference}^{commit}`]);
  try {
    await run("git", ["cat-file", "-e", `${before}:rust/module.rs`]);
  } catch {
    throw new Error(
      `Baseline ${reference} is not a ScriptFS revision with module manifests`,
    );
  }
  const after = await run("git", ["rev-parse", "HEAD"]);
  const applicationPaths = [
    "rust",
    "src",
    "container",
    "vendor",
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "pnpm-lock.yaml",
  ];
  const { stdout: diff } = await execute(
    "git",
    ["diff", "--no-ext-diff", "HEAD", "--", ...applicationPaths],
    { cwd: repository, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const hash = createHash("sha256").update(diff);
  const untracked = await run("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...applicationPaths,
  ]);
  for (const filename of untracked.split("\0").filter(Boolean).sort()) {
    hash
      .update(`\0${filename}\0`)
      .update(await readFile(path.join(repository, filename)));
  }
  const applicationDiffSha256 = hash.digest("hex");
  const suffix =
    diff.length || untracked ? `-${applicationDiffSha256.slice(0, 12)}` : "";
  return {
    before,
    after,
    beforePath: path.join(workspace, `baseline-${before.slice(0, 12)}`),
    beforeImage: `localhost/scriptfs-benchmark-before:${before.slice(0, 12)}`,
    afterImage: `localhost/scriptfs-benchmark-after:${after.slice(0, 12)}${suffix}`,
    applicationDiffSha256,
  };
}

async function prepare() {
  await mkdir(workspace, { recursive: true });
  const version = await versions();
  const marker = path.join(version.beforePath, ".benchmark-commit");
  try {
    assert.equal(await readFile(marker, "utf8"), version.before);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    await mkdir(version.beforePath);
    const archive = path.join(workspace, `baseline-${version.before}.tar`);
    const { stdout } = await execute("git", ["archive", version.before], {
      cwd: repository,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    await writeFile(archive, stdout);
    await run("tar", ["-xf", archive, "-C", version.beforePath]);
    await rm(archive);
    await writeFile(marker, version.before);
  }
  const registry = await run("npm", ["config", "get", "registry"]);
  const env = { ...process.env, npm_config_registry: registry };
  try {
    await access(
      path.join(version.beforePath, "node_modules", ".modules.yaml"),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    await build(
      make,
      ["pnpm-install", `PNPM=${pnpm}`],
      version.beforePath,
      env,
    );
  }
  await build(
    make,
    [
      "build",
      "build-image",
      `PNPM=${pnpm}`,
      `RUNTIME_IMAGE=${version.beforeImage}`,
    ],
    version.beforePath,
    env,
  );
  await build(make, [
    "build",
    "build-image",
    `RUNTIME_IMAGE=${version.afterImage}`,
  ]);
  await writeFile(
    path.join(workspace, "versions.json"),
    `${JSON.stringify(version, null, 2)}\n`,
  );
}

/** @param {string} root @param {string} image @param {boolean} diagnostic */
async function fixture(root, image, diagnostic) {
  const source = path.join(root, "source");
  const proxy = path.join(root, "proxy");
  for (const directory of [path.join(source, "native"), proxy]) {
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, index) =>
        writeFile(path.join(directory, filename(index)), contents(SMALL_SIZE)),
      ),
    );
    await writeFile(path.join(directory, "large.bin"), contents(LARGE_SIZE));
    await writeFile(path.join(directory, "mutable.bin"), "");
  }
  await mkdir(path.join(root, "module"));
  const entry = path.join(root, "module", "index.mjs");
  await copyFile(
    path.join(repository, "scripts", "benchmark-module.mjs"),
    entry,
  );
  if (diagnostic) {
    const instrumentation = `
      let profileCounts = {}, profileRevision = 0;
      for (const [mode, object] of Object.entries({whole,positional})) {
        for (const [operation, callback] of Object.entries(object)) {
          object[operation] = function(...args) {
            const context = args.at(-1), start = process.hrtime.bigint();
            let result;
            try { return result = callback.apply(this,args); }
            finally {
              const operations = profileCounts[mode] ??= {};
              const row = operations[operation] ??= {calls:0,timeNs:0,bytes:0,fileCalls:0,directoryCalls:0,lengths:{}};
              row.calls++; row.timeNs += Number(process.hrtime.bigint()-start);
              row[context.relativePath ? "fileCalls" : "directoryCalls"]++;
              if(operation==="read" || operation==="readFile") row.bytes += result?.length ?? 0;
              if(operation==="write" || operation==="writeFile") row.bytes += args[0].length;
              if(operation==="read") row.lengths[args[1]] = (row.lengths[args[1]] ?? 0)+1;
              profileRevision++;
            }
          };
        }
      }
      export const metrics = {
        getattr(){return {kind:"file",identity:"profile",size:Buffer.byteLength(JSON.stringify(profileCounts)),mtime:new Date(profileRevision)};},
        readFile(){return Buffer.from(JSON.stringify(profileCounts));},
        writeFile(){profileCounts={};profileRevision++;},
      };
    `;
    await writeFile(entry, (await readFile(entry, "utf8")) + instrumentation);
  }
  const exports = ["whole", "positional", ...(diagnostic ? ["metrics"] : [])];
  for (const name of exports)
    await writeFile(
      path.join(root, "module", `${name}.module.json`),
      JSON.stringify({
        name: `benchmark-${name}`,
        entry: "./index.mjs",
        export: name,
      }),
    );
  await mkdir(path.join(root, "mount"));
  await writeFile(
    path.join(root, "config.json"),
    JSON.stringify({
      modules: Object.fromEntries(
        exports.map((name) => [
          name,
          { manifest: path.join(root, "module", `${name}.module.json`) },
        ]),
      ),
      filesystems: [
        {
          name: "benchmark",
          source,
          mountPoint: path.join(root, "mount"),
          rules: [
            {
              match: "proxy/**",
              root: "proxy",
              opaque: true,
              provider: { type: "directory", path: proxy },
            },
            ...["whole", "positional"].map((mode) => ({
              match: `${mode}/**`,
              root: mode,
              opaque: true,
              provider: { module: mode },
            })),
            ...(diagnostic
              ? [
                  {
                    match: "__profile__",
                    opaque: true,
                    provider: { module: "metrics" },
                  },
                ]
              : []),
          ],
        },
      ],
      container: { image, rebuild: false, logLevel: "silent" },
    }),
  );
}

/** @param {string} image */
async function containers(image) {
  const text = await run("podman", [
    "ps",
    "--filter",
    `ancestor=${image}`,
    "--format",
    "{{.ID}}",
  ]);
  return text ? text.split("\n") : [];
}

/** @param {string} id */
async function memory(id) {
  // Proportional resident memory avoids double-counting shared library pages.
  const source = `
    const fs=require("node:fs");
    let kib=0;
    for(const entry of fs.readdirSync("/proc")) {
      if(!/^\\d+$/.test(entry) || Number(entry)===process.pid) continue;
      try {
        const name=fs.readFileSync("/proc/"+entry+"/comm","utf8").trim();
        if(name!=="node" && name!=="scriptfs") continue;
        const text=fs.readFileSync("/proc/"+entry+"/smaps_rollup","utf8");
        const match=/^Pss:\\s+(\\d+) kB$/m.exec(text);
        if(!match) throw new Error("PSS unavailable for "+entry);
        kib+=Number(match[1]);
      } catch(error) { if(error.code!=="ENOENT") throw error; }
    }
    console.log(kib);
  `;
  const value = Number(await run("podman", ["exec", id, "node", "-e", source]));
  assert.ok(Number.isFinite(value) && value > 0, "Invalid application PSS");
  return value;
}

/** @param {"before" | "after"} version @param {number} round @param {number} scale @param {Awaited<ReturnType<typeof versions>>} metadata @param {boolean} diagnostic */
async function sample(version, round, scale, metadata, diagnostic = false) {
  const image =
    version === "before" ? metadata.beforeImage : metadata.afterImage;
  const root = await mkdtemp(path.join(os.tmpdir(), "scriptfs-benchmark-"));
  await fixture(root, image, diagnostic);
  const existing = new Set(await containers(image));
  const cli = path.join(
    version === "before" ? metadata.beforePath : repository,
    "dist",
    "cli.js",
  );
  const started = process.hrtime.bigint();
  const child = spawn(process.execPath, [cli, path.join(root, "config.json")], {
    cwd: version === "before" ? metadata.beforePath : repository,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    output += String(text);
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    output += String(text);
  });
  /** @type {string | undefined} */
  let container;
  const exited = exit(child);
  /** @type {Sample | undefined} */
  let result;
  /** @type {unknown[]} */
  const errors = [];
  try {
    const deadline = Date.now() + 90_000;
    while (!output.includes("scriptfs is running; press Ctrl+C to stop")) {
      assert.ok(child.exitCode === null && child.signalCode === null, output);
      assert.ok(Date.now() < deadline, `Startup timed out:\n${output}`);
      await delay(50);
    }
    const startupMs = Number(process.hrtime.bigint() - started) / 1e6;
    const ids = (await containers(image)).filter((id) => !existing.has(id));
    assert.equal(ids.length, 1, "Cannot identify owned benchmark container");
    container = ids[0];
    assert.ok(container);
    const runtime = {
      node: await run("podman", ["exec", container, "node", "--version"]),
      samba: await run("podman", ["exec", container, "smbd", "--version"]),
    };
    const driver = `/tmp/scriptfs-benchmark-${randomUUID()}.mjs`;
    const driverSource = path.join(
      repository,
      "scripts",
      diagnostic ? "benchmark-profile-workload.mjs" : "benchmark-workload.mjs",
    );
    await run("podman", ["cp", driverSource, `${container}:${driver}`]);
    /** @type {unknown} */
    const fuse = JSON.parse(
      await run("podman", [
        "exec",
        container,
        "node",
        driver,
        "/scriptfs/overlays/0",
        String(scale),
      ]),
    );
    /** @type {unknown} */
    const smb = JSON.parse(
      await run(
        process.execPath,
        [driverSource, path.join(root, "mount"), String(scale)],
        repository,
        diagnostic
          ? {
              ...process.env,
              BENCH_PROFILE_CONTAINER: container,
              BENCH_PROFILE_DRIVER: driver,
            }
          : process.env,
      ),
    );
    const memoryKiB = await memory(container);
    if (diagnostic) {
      assert.ok(
        isProfiles(fuse) && isProfiles(smb),
        "Invalid diagnostic profile",
      );
      result = {
        version,
        round,
        startupMs,
        memoryKiB,
        runtime,
        fuse: [],
        smb: [],
        diagnostics: {
          fuse,
          smb,
          mountInfo: await run("podman", [
            "exec",
            container,
            "cat",
            "/proc/mounts",
          ]),
        },
      };
    } else {
      assert.ok(
        isMeasurements(fuse) && isMeasurements(smb),
        "Invalid benchmark output",
      );
      assert.equal(fuse.length, 20, "Missing FUSE workloads");
      assert.equal(smb.length, 20, "Missing SMB workloads");
      result = { version, round, startupMs, memoryKiB, runtime, fuse, smb };
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGINT");
    const outcome = await deadline(exited, 30_000);
    assert.deepEqual(outcome, { code: 0, signal: null }, output);
    if (container)
      assert.ok(
        !(await containers(image)).includes(container),
        "Runtime leaked",
      );
  } catch (error) {
    errors.push(error);
    let hostUnmounted = false;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await run("umount", [path.join(root, "mount")]);
        hostUnmounted = true;
      } catch (unmountError) {
        errors.push(unmountError);
      }
      child.kill("SIGTERM");
      try {
        await deadline(exited, 10_000);
      } catch (stopError) {
        errors.push(stopError);
        child.kill("SIGKILL");
      }
    }
    if (container && hostUnmounted) {
      try {
        await run("podman", ["rm", "--force", container]);
      } catch (removeError) {
        errors.push(removeError);
      }
    }
  }
  if (errors.length) {
    await writeFile(path.join(root, "cli.log"), output);
    throw new AggregateError(
      errors,
      `Benchmark failed; logs and fixtures: ${root}`,
    );
  }
  assert.ok(result);
  await rm(root, { recursive: true });
  return result;
}

/** @param {Sample[]} samples */
export function summarize(samples) {
  /** @type {{ layer: string, name: string, beforeMs: number, afterMs: number, speedup: number, beforeRange: number[], afterRange: number[], beforeMiBs?: number, afterMiBs?: number }[]} */
  const rows = [];
  const before = samples.filter((sample) => sample.version === "before");
  const after = samples.filter((sample) => sample.version === "after");
  assert.equal(before.length, after.length, "Unpaired benchmark samples");
  assert.ok(before.length > 0);
  const rounds = before.map((sample) => sample.round).toSorted((a, b) => a - b);
  assert.equal(new Set(rounds).size, rounds.length, "Duplicate rounds");
  assert.deepEqual(
    after.map((sample) => sample.round).toSorted((a, b) => a - b),
    rounds,
    "Unpaired rounds",
  );
  for (const sample of samples)
    assert.deepEqual(
      sample.runtime,
      before[0].runtime,
      "Runtime dependencies differ",
    );
  for (const layer of /** @type {const} */ (["fuse", "smb"])) {
    const names = before[0][layer].map((row) => row.name).toSorted();
    assert.equal(new Set(names).size, names.length, "Duplicate workloads");
    for (const sample of samples) {
      assert.deepEqual(
        sample[layer].map((row) => row.name).toSorted(),
        names,
        "Different workload sets",
      );
    }
    for (const workload of before[0][layer]) {
      const groups = [before, after].map((group) =>
        group.map((sample) => {
          const found = sample[layer].find((row) => row.name === workload.name);
          assert.ok(found, `Missing workload: ${workload.name}`);
          assert.equal(
            found.operations,
            workload.operations,
            "Different workloads",
          );
          assert.equal(found.bytes, workload.bytes, "Different byte counts");
          return found.elapsedMs;
        }),
      );
      const [oldTimes, newTimes] = groups;
      const oldMedian = median(oldTimes);
      const newMedian = median(newTimes);
      rows.push({
        layer,
        name: workload.name,
        beforeMs: oldMedian,
        afterMs: newMedian,
        speedup: oldMedian / newMedian,
        beforeRange: [Math.min(...oldTimes), Math.max(...oldTimes)],
        afterRange: [Math.min(...newTimes), Math.max(...newTimes)],
        ...(workload.bytes
          ? {
              beforeMiBs: workload.bytes / 1048576 / (oldMedian / 1000),
              afterMiBs: workload.bytes / 1048576 / (newMedian / 1000),
            }
          : {}),
      });
    }
  }
  return {
    workloads: rows,
    startup: {
      beforeMs: median(before.map((sample) => sample.startupMs)),
      afterMs: median(after.map((sample) => sample.startupMs)),
    },
    applicationPssMiB: {
      before: median(before.map((sample) => sample.memoryKiB / 1024)),
      after: median(after.map((sample) => sample.memoryKiB / 1024)),
    },
  };
}

/** @param {unknown} value @returns {value is Sample} */
function isSample(value) {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("version" in value) ||
    (value.version !== "before" && value.version !== "after") ||
    !("round" in value) ||
    typeof value.round !== "number" ||
    !Number.isInteger(value.round) ||
    value.round < 0
  )
    return false;
  if (
    !("startupMs" in value) ||
    typeof value.startupMs !== "number" ||
    !Number.isFinite(value.startupMs) ||
    value.startupMs <= 0 ||
    !("memoryKiB" in value) ||
    typeof value.memoryKiB !== "number" ||
    !Number.isFinite(value.memoryKiB) ||
    value.memoryKiB <= 0 ||
    !("runtime" in value) ||
    typeof value.runtime !== "object" ||
    value.runtime === null ||
    !("node" in value.runtime) ||
    typeof value.runtime.node !== "string" ||
    !("samba" in value.runtime) ||
    typeof value.runtime.samba !== "string"
  )
    return false;
  return (
    "fuse" in value &&
    isMeasurements(value.fuse) &&
    "smb" in value &&
    isMeasurements(value.smb)
  );
}

async function report() {
  /** @type {unknown} */
  const data = JSON.parse(await readFile(reportPath, "utf8"));
  assert.ok(typeof data === "object" && data !== null && "samples" in data);
  assert.ok(
    Array.isArray(data.samples) && data.samples.every(isSample),
    "Invalid benchmark report",
  );
  const summary = summarize(data.samples);
  console.table(
    summary.workloads.map((row) => ({
      layer: row.layer,
      workload: row.name,
      beforeMs: row.beforeMs.toFixed(2),
      afterMs: row.afterMs.toFixed(2),
      speedup: `${row.speedup.toFixed(2)}x`,
      beforeRangeMs: row.beforeRange
        .map((value) => value.toFixed(2))
        .join(".."),
      afterRangeMs: row.afterRange.map((value) => value.toFixed(2)).join(".."),
    })),
  );
  console.log(
    JSON.stringify(
      {
        pairs: data.samples.length / 2,
        startup: {
          ...summary.startup,
          changePercent:
            (summary.startup.afterMs / summary.startup.beforeMs - 1) * 100,
        },
        applicationPssMiB: {
          ...summary.applicationPssMiB,
          changePercent:
            (summary.applicationPssMiB.after /
              summary.applicationPssMiB.before -
              1) *
            100,
        },
      },
      null,
      2,
    ),
  );
}

async function cleanFailed() {
  const root = process.argv[3];
  assert.ok(root, "Specify the exact failed fixture path");
  const resolved = await realpath(root);
  assert.equal(
    path.dirname(resolved),
    await realpath(os.tmpdir()),
    "Not a benchmark temp directory",
  );
  assert.match(path.basename(resolved), /^scriptfs-benchmark-[a-zA-Z0-9]+$/);
  await access(path.join(resolved, "cli.log"));
  const mounted = await run("mount", []);
  assert.ok(
    !mounted.includes(`${resolved}/mount`) &&
      !mounted.includes(`${root}/mount`),
    "Fixture is still mounted",
  );
  const metadata = await versions();
  assert.equal(
    (await containers(metadata.beforeImage)).length,
    0,
    "Baseline runtime still active",
  );
  assert.equal(
    (await containers(metadata.afterImage)).length,
    0,
    "Current runtime still active",
  );
  await copyFile(
    path.join(resolved, "cli.log"),
    path.join(workspace, `${path.basename(resolved)}.log`),
  );
  await rm(resolved, { recursive: true });
}

async function profileRegressions() {
  await mkdir(workspace, { recursive: true });
  const lockPath = path.join(workspace, "run.lock");
  const lock = await open(lockPath, "wx");
  try {
    const metadata = await versions();
    /** @type {Sample[]} */
    const samples = [];
    for (const version of /** @type {const} */ (["before", "after"])) {
      console.log(
        `Profiling ${version}: callback instrumentation is enabled; these are NOT comparative benchmark timings.`,
      );
      samples.push(await sample(version, 0, 1, metadata, true));
    }
    assert.deepEqual(
      samples[0]?.runtime,
      samples[1]?.runtime,
      "Runtime dependencies differ",
    );
    await writeFile(
      reportPath,
      JSON.stringify({ metadata, samples }, null, 2) + "\n",
      { flag: "wx" },
    );
    for (const sample of samples) {
      assert.ok(sample.diagnostics);
      for (const layer of /** @type {const} */ (["fuse", "smb"])) {
        console.table(
          sample.diagnostics[layer].map((row) => ({
            version: sample.version,
            layer,
            name: row.name,
            operations: row.operations,
            elapsedMs: row.elapsedMs.toFixed(2),
            cpuMs: Object.values(row.processes)
              .reduce((total, process) => total + process.cpuNs / 1e6, 0)
              .toFixed(2),
            readCalls: Object.values(row.processes).reduce(
              (total, process) => total + process.readCalls,
              0,
            ),
            writeCalls: Object.values(row.processes).reduce(
              (total, process) => total + process.writeCalls,
              0,
            ),
            callbacks: Object.values(row.counters)
              .flatMap((mode) => Object.values(mode))
              .reduce((total, counter) => total + counter.calls, 0),
          })),
        );
      }
    }
    console.log(`Raw diagnostic counters: ${reportPath}`);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

async function benchmark() {
  assert.ok(
    ["darwin", "linux"].includes(process.platform),
    "Unix benchmark required",
  );
  const rounds = Number(process.env.BENCH_ROUNDS ?? 6);
  const scale = Number(process.env.BENCH_SCALE ?? 1);
  assert.ok(Number.isInteger(rounds) && rounds > 0, "Invalid round count");
  assert.ok(Number.isFinite(scale) && scale > 0, "Invalid benchmark scale");
  await mkdir(workspace, { recursive: true });
  const lockPath = path.join(workspace, "run.lock");
  const lock = await open(lockPath, "wx");
  try {
    const metadata = await versions();
    const info = await run("podman", ["info", "--format", "json"]);
    const images = await run("podman", [
      "image",
      "inspect",
      metadata.beforeImage,
      metadata.afterImage,
    ]);
    /** @type {unknown} */
    const podmanInfo = JSON.parse(info);
    /** @type {unknown} */
    const imageInfo = JSON.parse(images);
    const environment = {
      date: new Date().toISOString(),
      host: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        cpus: os.cpus().length,
        node: process.version,
      },
      podman: podmanInfo,
      images: imageInfo,
      applicationDiffSha256: metadata.applicationDiffSha256,
      rounds,
      scale,
      cachePolicy:
        "Warm per-workload; no global cache drops. Fresh app and fixture for every sample.",
      order: "Alternating before/after, then after/before.",
      client:
        "Sequential Node.js fs/promises; identical assertions and operation counts.",
      memory:
        "Sum of application process proportional resident memory (PSS), including the Node module worker; excludes Samba and client.",
    };
    /** @type {Sample[]} */
    const samples = [];
    for (let round = 0; round < rounds; round++) {
      /** @type {("before" | "after")[]} */
      const order = round % 2 === 0 ? ["before", "after"] : ["after", "before"];
      for (const version of order) {
        console.log(
          `Benchmark round ${String(round + 1)}/${String(rounds)}: ${version}`,
        );
        const measured = await sample(version, round, scale, metadata);
        if (samples.length)
          assert.deepEqual(
            measured.runtime,
            samples[0].runtime,
            "Runtime dependencies differ",
          );
        samples.push(measured);
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(
          reportPath,
          `${JSON.stringify({ metadata, environment, samples }, null, 2)}\n`,
        );
      }
    }
    const summary = summarize(samples);
    await writeFile(
      reportPath,
      `${JSON.stringify({ metadata, environment, samples, summary }, null, 2)}\n`,
    );
    console.table(
      summary.workloads.map((row) => ({
        layer: row.layer,
        workload: row.name,
        beforeMs: row.beforeMs.toFixed(2),
        afterMs: row.afterMs.toFixed(2),
        speedup: `${row.speedup.toFixed(2)}x`,
      })),
    );
    console.log(
      JSON.stringify(
        {
          startup: summary.startup,
          applicationPssMiB: summary.applicationPssMiB,
        },
        null,
        2,
      ),
    );
    console.log(`Raw measurements: ${reportPath}`);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv[2] === "prepare") await prepare();
  else if (process.argv[2] === "run") await benchmark();
  else if (process.argv[2] === "report") await report();
  else if (process.argv[2] === "clean-failed") await cleanFailed();
  else if (process.argv[2] === "profile") await profileRegressions();
  else
    throw new Error(
      "Usage: benchmark.mjs prepare|run|profile|report|clean-failed",
    );
}
