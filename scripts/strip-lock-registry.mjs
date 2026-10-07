#!/usr/bin/env node
// Lockfiles generated behind a private registry record its URLs in "resolved"
// or "tarball", which would publish an internal host. Names, versions and
// integrity hashes identify every package on their own, so the URLs are dropped.
import fs from "node:fs";

const [target] = process.argv.slice(2);
if (!target) {
  console.error("Usage: strip-lock-registry.mjs <lockfile>");
  process.exit(1);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null;

const source = fs.readFileSync(target, "utf8");
let stripped = 0;
if (target.endsWith(".yaml")) {
  const cleaned = source.replace(
    /^( +resolution: \{integrity: [^,}\r\n]+), tarball: https?:\/\/[^}\r\n]+(\})$/gm,
    (_, resolution, end) => {
      stripped++;
      return `${String(resolution)}${String(end)}`;
    },
  );
  if (/\btarball:/.test(cleaned))
    throw new Error(`Unsupported tarball resolution in ${target}`);
  fs.writeFileSync(target, cleaned);
  console.log(`Stripped ${String(stripped)} registry URLs from ${target}.`);
  process.exit(0);
}

/** @type {unknown} */
const lock = JSON.parse(source);
if (!isRecord(lock) || !isRecord(lock.packages))
  throw new Error(`Invalid lockfile: ${target}`);
for (const entry of Object.values(lock.packages)) {
  if (!isRecord(entry) || !("resolved" in entry)) continue;
  delete entry.resolved;
  stripped++;
}
fs.writeFileSync(target, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Stripped ${String(stripped)} registry URLs from ${target}.`);
