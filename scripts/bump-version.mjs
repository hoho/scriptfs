import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requestedVersion = process.argv[2] ?? "";
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const packageText = await readFile(packagePath, "utf8");
const packageVersionPattern = /^ {2}"version": "([^"]+)",$/m;
const packageVersionMatch = packageVersionPattern.exec(packageText);

if (!packageVersionMatch) {
  throw new Error("Could not find the package version in package.json");
}

const check = requestedVersion === "--check";
const version = check ? packageVersionMatch[1] : requestedVersion;

if (!versionPattern.test(version)) {
  console.error(
    "Usage: node scripts/bump-version.mjs <major.minor.patch[-prerelease] | --check>",
  );
  process.exit(1);
}

const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const runtimeVersionPattern =
  /scriptfs-runtime:(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/g;
let runtimeReferences = 0;
let changedFiles = 0;
/** @type {string[]} */
const mismatches = [];

for (const file of files) {
  const filePath = path.join(root, file);
  const contents =
    file === "package.json" ? packageText : await readFile(filePath, "utf8");
  if (contents.includes("\0")) continue;

  let updated = contents;
  if (!check && file === "package.json") {
    updated = updated.replace(
      packageVersionPattern,
      `  "version": "${String(version)}",`,
    );
  }
  updated = updated.replace(runtimeVersionPattern, (reference) => {
    runtimeReferences += 1;
    if (check) {
      if (reference !== `scriptfs-runtime:${String(version)}`) {
        mismatches.push(`${file}: ${reference}`);
      }
      return reference;
    }
    return `scriptfs-runtime:${String(version)}`;
  });

  if (updated !== contents) {
    await writeFile(filePath, updated);
    changedFiles += 1;
  }
}

if (runtimeReferences === 0) {
  throw new Error("No scriptfs-runtime image references were found");
}

if (mismatches.length > 0) {
  throw new Error(
    `Runtime image versions do not match package version ${String(version)}:\n${mismatches.join("\n")}`,
  );
}

if (check) {
  console.log(
    `Validated package version ${String(version)} against ${String(runtimeReferences)} runtime image references.`,
  );
} else {
  console.log(
    `Set ScriptFS and ${String(runtimeReferences)} runtime image references to ${String(version)} in ${String(changedFiles)} files.`,
  );
}
