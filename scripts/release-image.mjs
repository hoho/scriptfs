#!/usr/bin/env node
// Records and validates the runtime image a release pins. The release workflow
// writes container/runtime-image.json after pushing the image, and the native
// host pulls exactly that digest instead of building the image locally.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(root, "container/runtime-image.json");
// Podman cannot pull a reference with both a tag and a digest.
const reference = /^(?:[^\s@/]+\/)*[^\s@/:]+@sha256:[0-9a-f]{64}$/;

/**
 * @param {string} name
 * @returns {unknown}
 */
function readJson(name) {
  return JSON.parse(readFileSync(name, "utf8"));
}

function packageVersion() {
  const manifest = readJson(path.join(root, "package.json"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  )
    throw new Error("package.json has no version.");
  return manifest.version;
}

/** @param {string} image */
function write(image) {
  if (!reference.test(image))
    throw new Error(
      `Expected a digest-pinned image such as ghcr.io/owner/scriptfs-runtime@sha256:<digest>, got ${JSON.stringify(image)}.`,
    );
  const version = packageVersion();
  writeFileSync(file, `${JSON.stringify({ image, version }, null, 2)}\n`);
  console.log(`Pinned runtime image ${image} for ${version}`);
}

function check() {
  /** @type {unknown} */
  let pinned;
  try {
    pinned = readJson(file);
  } catch (error) {
    throw new Error(
      `${path.relative(root, file)} is missing or invalid; the release workflow writes it with make release-image-reference after pushing the runtime image.`,
      { cause: error },
    );
  }
  const version = packageVersion();
  if (
    typeof pinned !== "object" ||
    pinned === null ||
    !("image" in pinned) ||
    typeof pinned.image !== "string" ||
    !reference.test(pinned.image)
  )
    throw new Error(
      `${path.relative(root, file)} must pin the image as <name>@sha256:<digest>.`,
    );
  if (!("version" in pinned) || pinned.version !== version)
    throw new Error(
      `${path.relative(root, file)} was written for another version; expected ${version}.`,
    );
  console.log(`Validated runtime image ${pinned.image} for ${version}`);
}

const [mode, image] = process.argv.slice(2);
if (mode === "--write" && image !== undefined) write(image);
else if (mode === "--check") check();
else {
  console.error(
    "Usage: node scripts/release-image.mjs --write <name>@sha256:<digest> | --check",
  );
  process.exit(2);
}
