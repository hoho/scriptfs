import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FILE_COUNT = 128;
export const SMALL_SIZE = 4096;
export const LARGE_SIZE = 2 * 1024 * 1024;
export const WRITE_SIZE = 64 * 1024;

/** @typedef {{ name: string, operations: number, bytes: number, elapsedMs: number }} Measurement */

/** @param {number} count @param {number} seed */
export function contents(count, seed = 0) {
  const buffer = Buffer.alloc(count);
  for (let i = 0; i < count; i++) buffer[i] = (i + seed) % 251;
  return buffer;
}

/** @param {number} index */
export function filename(index) {
  return `file-${String(index).padStart(4, "0")}.bin`;
}

/** @param {number[]} values */
export function median(values) {
  assert.ok(values.length > 0, "Cannot summarize empty measurements");
  assert.ok(values.every(Number.isFinite), "Non-finite measurement");
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - (sorted.length % 2 === 0 ? 1 : 0)];
  const upper = sorted[middle];
  assert.ok(lower !== undefined && upper !== undefined);
  return (lower + upper) / 2;
}

/** @param {string} root @param {number} scale */
export async function measure(root, scale) {
  assert.ok(Number.isFinite(scale) && scale > 0, "Invalid benchmark scale");
  /** @type {Measurement[]} */
  const results = [];
  const modes = ["native", "proxy", "whole", "positional"];
  const small = contents(SMALL_SIZE);
  const large = contents(LARGE_SIZE);
  const written = contents(WRITE_SIZE, 17);

  for (const mode of modes) {
    const directory = path.join(root, mode);
    // Check full bytes before timing; timing loops check lengths and a checksum.
    assert.deepEqual(await readFile(path.join(directory, filename(0))), small);
    assert.deepEqual(await readFile(path.join(directory, "large.bin")), large);
    const listing = await readdir(directory);
    assert.equal(listing.length, FILE_COUNT + 2);
    assert.ok(listing.includes("mutable.bin"));

    /** @param {string} operation @param {number} base @param {number} bytes @param {(index: number) => Promise<void>} action */
    async function batch(operation, base, bytes, action) {
      const count = Math.max(1, Math.round(base * scale));
      for (let index = 0; index < Math.min(count, 8); index++)
        await action(index);
      const start = process.hrtime.bigint();
      for (let index = 0; index < count; index++) await action(index);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      results.push({
        name: `${mode}/${operation}`,
        operations: count,
        bytes: bytes * count,
        elapsedMs,
      });
    }

    await batch("stat", 512, 0, async (index) => {
      assert.equal(
        (await stat(path.join(directory, filename(index % FILE_COUNT)))).size,
        SMALL_SIZE,
      );
    });
    if (mode !== "proxy") {
      await batch("readdir", 24, 0, async () => {
        assert.equal((await readdir(directory)).length, FILE_COUNT + 2);
      });
    }
    await batch("read-4KiB", 128, SMALL_SIZE, async (index) => {
      const buffer = await readFile(
        path.join(directory, filename(index % FILE_COUNT)),
      );
      assert.equal(buffer.length, SMALL_SIZE);
      assert.equal(buffer[SMALL_SIZE - 1], small[SMALL_SIZE - 1]);
    });
    if (mode === "proxy") continue;

    await batch("read-2MiB", 8, LARGE_SIZE, async () => {
      const buffer = await readFile(path.join(directory, "large.bin"));
      assert.equal(buffer.length, LARGE_SIZE);
      assert.equal(buffer[LARGE_SIZE - 1], large[LARGE_SIZE - 1]);
    });

    const handle = await open(path.join(directory, "large.bin"), "r");
    try {
      const buffer = Buffer.alloc(SMALL_SIZE);
      await batch("random-read-4KiB", 256, SMALL_SIZE, async (index) => {
        const position =
          ((index * 104729) % (LARGE_SIZE / SMALL_SIZE)) * SMALL_SIZE;
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        assert.equal(bytesRead, SMALL_SIZE);
        assert.equal(buffer[0], position % 251);
      });
    } finally {
      await handle.close();
    }
    await batch("write-64KiB", 32, WRITE_SIZE, async () => {
      await writeFile(path.join(directory, "mutable.bin"), written);
    });
    assert.deepEqual(
      await readFile(path.join(directory, "mutable.bin")),
      written,
    );
  }
  return results;
}

/** @param {unknown} value @returns {value is Measurement[]} */
export function isMeasurements(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      /** @param {unknown} row */
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "name" in row &&
        typeof row.name === "string" &&
        "operations" in row &&
        typeof row.operations === "number" &&
        Number.isFinite(row.operations) &&
        Number.isInteger(row.operations) &&
        row.operations > 0 &&
        "bytes" in row &&
        typeof row.bytes === "number" &&
        Number.isFinite(row.bytes) &&
        row.bytes >= 0 &&
        "elapsedMs" in row &&
        typeof row.elapsedMs === "number" &&
        Number.isFinite(row.elapsedMs) &&
        row.elapsedMs > 0,
    )
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const root = process.argv[2];
  assert.ok(root, "Usage: benchmark-workload.mjs <mount> [scale]");
  console.log(
    JSON.stringify(await measure(root, Number(process.argv[3] ?? 1))),
  );
}
