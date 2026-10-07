import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  readdir as list,
  readFile as read,
  writeFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";

/** @typedef {{calls:number,timeNs:number,bytes:number,fileCalls:number,directoryCalls:number,lengths:Record<string,number>}} Counter */
/** @typedef {Record<string,Record<string,Counter>>} Counters */
/** @typedef {{name:string,cpuNs:number,readCalls:number,writeCalls:number,readChars:number,writeChars:number,voluntarySwitches:number,involuntarySwitches:number}} ProcessStats */
/** @typedef {Record<string,ProcessStats>} Processes */
/** @typedef {{name:string,operations:number,elapsedMs:number,counters:Counters,processes:Processes}} Profile */
const execute = promisify(execFile);

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is Counters} */
function isCounters(value) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (mode) =>
        isRecord(mode) &&
        Object.values(mode).every(
          (counter) =>
            isRecord(counter) &&
            ["calls", "timeNs", "bytes", "fileCalls", "directoryCalls"].every(
              (key) =>
                key in counter &&
                typeof counter[key] === "number" &&
                Number.isFinite(counter[key]) &&
                counter[key] >= 0,
            ) &&
            "lengths" in counter &&
            isRecord(counter.lengths) &&
            Object.values(counter.lengths).every(
              (count) =>
                typeof count === "number" &&
                Number.isFinite(count) &&
                count >= 0,
            ),
        ),
    )
  );
}

/** @param {unknown} value @returns {value is Processes} */
function isProcesses(value) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) =>
        isRecord(item) &&
        "name" in item &&
        typeof item.name === "string" &&
        [
          "cpuNs",
          "readCalls",
          "writeCalls",
          "readChars",
          "writeChars",
          "voluntarySwitches",
          "involuntarySwitches",
        ].every(
          (key) =>
            key in item &&
            typeof item[key] === "number" &&
            Number.isFinite(item[key]) &&
            item[key] >= 0,
        ),
    )
  );
}

/** @param {unknown} value @returns {value is Profile[]} */
export function isProfiles(value) {
  return (
    Array.isArray(value) &&
    value.length === 7 &&
    value.every(
      (item) =>
        isRecord(item) &&
        "name" in item &&
        typeof item.name === "string" &&
        "operations" in item &&
        typeof item.operations === "number" &&
        Number.isInteger(item.operations) &&
        item.operations > 0 &&
        "elapsedMs" in item &&
        typeof item.elapsedMs === "number" &&
        Number.isFinite(item.elapsedMs) &&
        item.elapsedMs > 0 &&
        "counters" in item &&
        isCounters(item.counters) &&
        "processes" in item &&
        isProcesses(item.processes),
    )
  );
}

export async function processStats() {
  /** @type {Processes} */
  const result = {};
  for (const pid of await list("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const root = `/proc/${pid}`;
      const name = (await read(`${root}/comm`, "utf8")).trim();
      if (!["node", "scriptfs"].includes(name)) continue;
      /** @type {Record<string,number>} */
      const io = {};
      for (const line of (await read(`${root}/io`, "utf8"))
        .trim()
        .split("\n")) {
        const colon = line.indexOf(":");
        io[line.slice(0, colon)] = Number(line.slice(colon + 1));
      }
      let cpuNs = 0,
        voluntarySwitches = 0,
        involuntarySwitches = 0;
      for (const tid of await list(`${root}/task`)) {
        const thread = `${root}/task/${tid}`;
        cpuNs += Number(
          (await read(`${thread}/schedstat`, "utf8")).split(" ")[0],
        );
        const status = await read(`${thread}/status`, "utf8");
        const voluntary = /^voluntary_ctxt_switches:\s+(\d+)$/m.exec(status);
        const involuntary = /^nonvoluntary_ctxt_switches:\s+(\d+)$/m.exec(
          status,
        );
        assert.ok(
          voluntary && involuntary,
          "Missing thread scheduling counters",
        );
        voluntarySwitches += Number(voluntary[1]);
        involuntarySwitches += Number(involuntary[1]);
      }
      result[pid] = {
        name,
        cpuNs,
        readCalls: io.syscr,
        writeCalls: io.syscw,
        readChars: io.rchar,
        writeChars: io.wchar,
        voluntarySwitches,
        involuntarySwitches,
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  assert.ok(
    isProcesses(result) && Object.keys(result).length > 0,
    "Missing application process counters",
  );
  return result;
}

async function snapshot() {
  if (!process.env.BENCH_PROFILE_CONTAINER) return processStats();
  assert.ok(process.env.BENCH_PROFILE_DRIVER);
  const { stdout } = await execute("podman", [
    "exec",
    process.env.BENCH_PROFILE_CONTAINER,
    "node",
    process.env.BENCH_PROFILE_DRIVER,
    "stats",
  ]);
  /** @type {unknown} */
  const value = JSON.parse(stdout);
  assert.ok(isProcesses(value));
  return value;
}

/** @param {Processes} before @param {Processes} after */
function difference(before, after) {
  /** @type {Processes} */
  const result = {};
  assert.deepEqual(
    Object.keys(before).sort(),
    Object.keys(after).sort(),
    "Application processes changed during profiling",
  );
  for (const [pid, a] of Object.entries(after)) {
    const b = before[pid];
    assert.ok(b && b.name === a.name);
    result[pid] = {
      name: a.name,
      cpuNs: a.cpuNs - b.cpuNs,
      readCalls: a.readCalls - b.readCalls,
      writeCalls: a.writeCalls - b.writeCalls,
      readChars: a.readChars - b.readChars,
      writeChars: a.writeChars - b.writeChars,
      voluntarySwitches: a.voluntarySwitches - b.voluntarySwitches,
      involuntarySwitches: a.involuntarySwitches - b.involuntarySwitches,
    };
  }
  assert.ok(isProcesses(result), "Non-monotonic process counters");
  return result;
}

/** @param {string} root */
export async function profile(root) {
  const metrics = path.join(root, "__profile__");
  /** @type {Profile[]} */
  const results = [];
  /** @param {string} name @param {number} count @param {()=>Promise<void>} action */
  async function phase(name, count, action) {
    await action();
    await writeFile(metrics, "reset");
    const before = await snapshot();
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++) await action();
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    await delay(50);
    /** @type {unknown} */
    const counters = JSON.parse(await read(metrics, "utf8"));
    assert.ok(isCounters(counters), "Invalid callback counters");
    const after = await snapshot();
    results.push({
      name,
      operations: count,
      elapsedMs,
      counters,
      processes: difference(before, after),
    });
  }
  await phase("control", 1, async () => {});
  for (const mode of ["whole", "positional"]) {
    const directory = path.join(root, mode);
    await phase(`${mode}/readdir`, 256, async () => {
      assert.equal((await list(directory)).length, 130);
    });
    await phase(`${mode}/read-2MiB`, 64, async () => {
      const bytes = await read(path.join(directory, "large.bin"));
      assert.equal(bytes.length, 2 * 1024 * 1024);
      assert.equal(bytes.at(-1), (bytes.length - 1) % 251);
    });
    const bytes = Buffer.alloc(64 * 1024, 17);
    await phase(`${mode}/write-64KiB`, 128, async () => {
      await writeFile(path.join(directory, "mutable.bin"), bytes);
    });
    assert.equal(
      (await stat(path.join(directory, "mutable.bin"))).size,
      bytes.length,
    );
    assert.deepEqual(await read(path.join(directory, "mutable.bin")), bytes);
  }
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert.ok(process.argv[2]);
  console.log(
    JSON.stringify(
      process.argv[2] === "stats"
        ? await processStats()
        : await profile(process.argv[2]),
    ),
  );
}
