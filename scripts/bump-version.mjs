import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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
const releaseTag = check ? process.argv[3] : undefined;

if (!versionPattern.test(version)) {
  console.error(
    "Usage: node scripts/bump-version.mjs <major.minor.patch[-prerelease] | --check [vVERSION]>",
  );
  process.exit(1);
}
if (releaseTag !== undefined && releaseTag !== `v${String(version)}`) {
  throw new Error(
    `Release tag ${releaseTag} does not match package version ${String(version)}; expected v${String(version)}.`,
  );
}

/** Published packages that share the ScriptFS version. */
const packageManifests = [
  "packages/module/package.json",
  "packages/testing/package.json",
  ...readdirSync(path.join(root, "packages/native"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/native/${entry.name}/package.json`),
];
/** @type {unknown} */
const packageManifest = JSON.parse(packageText);
const optionalDependencies = Object.keys(
  typeof packageManifest === "object" &&
    packageManifest !== null &&
    "optionalDependencies" in packageManifest &&
    typeof packageManifest.optionalDependencies === "object" &&
    packageManifest.optionalDependencies !== null
    ? packageManifest.optionalDependencies
    : {},
).sort();
const platformPackages = packageManifests
  .filter((file) => file.startsWith("packages/native/"))
  .map((file) => `@scriptfs/${file.split("/")[2] ?? ""}`)
  .sort();
if (JSON.stringify(optionalDependencies) !== JSON.stringify(platformPackages)) {
  throw new Error(
    `package.json optionalDependencies (${optionalDependencies.join(", ")}) must list every platform package (${platformPackages.join(", ")}).`,
  );
}
const files = [
  ...new Set([
    ...execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
    "Cargo.toml",
    "Cargo.lock",
    ...packageManifests,
    ...readdirSync(path.join(root, "rust"))
      .filter((file) => file.endsWith(".rs") || file.endsWith(".mjs"))
      .map((file) => `rust/${file}`),
  ]),
];
const runtimeVersionPattern =
  /scriptfs-runtime:(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/g;
/** Version ranges on ScriptFS packages in examples, lockfiles, and docs. */
const dependencyRangePattern =
  /("@scriptfs\/[a-z0-9-]+": "(?:>=|\^|~)?)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)"/g;
let runtimeReferences = 0;
let dependencyRanges = 0;
let changedFiles = 0;
/** @type {string[]} */
const mismatches = [];

for (const file of files) {
  const filePath = path.join(root, file);
  if (!existsSync(filePath)) continue;
  const contents =
    file === "package.json" ? packageText : await readFile(filePath, "utf8");
  if (contents.includes("\0")) continue;

  let updated = contents;
  if (file === "Cargo.toml" || file === "Cargo.lock") {
    const pattern =
      file === "Cargo.toml"
        ? /^(version = ")([^"]+)(")$/m
        : /(\[\[package\]\]\r?\nname = "scriptfs"\r?\nversion = ")([^"]+)(")/;
    const match = pattern.exec(contents);
    if (
      !match ||
      match[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined
    )
      throw new Error(`Could not find the ScriptFS version in ${file}`);
    if (check) {
      if (match[2] !== version) mismatches.push(`${file}: ${match[2]}`);
    } else {
      updated = updated.replace(
        pattern,
        `${match[1]}${String(version)}${match[3]}`,
      );
    }
  }
  if (packageManifests.includes(file)) {
    const match = packageVersionPattern.exec(contents);
    if (!match) throw new Error(`Could not find the version in ${file}`);
    if (check && match[1] !== version)
      mismatches.push(`${file}: ${String(match[1])}`);
  }
  if (!check && (file === "package.json" || packageManifests.includes(file))) {
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
  updated = updated.replace(
    dependencyRangePattern,
    (reference, prefix, referenceVersion) => {
      dependencyRanges += 1;
      if (check) {
        if (referenceVersion !== version) {
          mismatches.push(`${file}: ${reference}`);
        }
        return reference;
      }
      return `${String(prefix)}${String(version)}"`;
    },
  );

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
    `Versions do not match package version ${String(version)}:\n${mismatches.join("\n")}`,
  );
}

if (check) {
  console.log(
    `Validated package version ${String(version)} against ${String(runtimeReferences)} runtime image references and ${String(dependencyRanges)} @scriptfs dependency ranges.`,
  );
} else {
  console.log(
    `Set ScriptFS, ${String(runtimeReferences)} runtime image references, and ${String(dependencyRanges)} @scriptfs dependency ranges to ${String(version)} in ${String(changedFiles)} files.`,
  );
}
