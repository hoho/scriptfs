import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const executable = process.platform === "win32" ? "scriptfs.exe" : "scriptfs";

/** A binary built from source with `make install-native`, as used by checkouts. */
function localBinary(root: string): string | undefined {
  const metadata = path.join(root, "dist", "native.json");
  const binary = path.join(root, "dist", executable);
  if (!existsSync(metadata) || !existsSync(binary)) return undefined;
  const target: unknown = JSON.parse(readFileSync(metadata, "utf8"));
  return typeof target === "object" &&
    target !== null &&
    "platform" in target &&
    "arch" in target &&
    target.platform === process.platform &&
    target.arch === process.arch
    ? binary
    : undefined;
}

/** Locates the ScriptFS executable: a local source build, or the installed `@scriptfs/<os>-<cpu>` package. */
export function nativeBinary(root = packageRoot): string {
  const local = localBinary(root);
  if (local) return local;
  const name = `@scriptfs/${process.platform}-${process.arch}`;
  let binary: string | undefined;
  try {
    binary = path.join(
      path.dirname(
        createRequire(path.join(root, "package.json")).resolve(
          `${name}/package.json`,
        ),
      ),
      executable,
    );
  } catch {
    // Reported below together with unsupported platforms.
  }
  if (binary !== undefined && existsSync(binary)) return binary;
  throw new Error(
    `ScriptFS has no prebuilt binary for ${process.platform}-${process.arch}: ${name} is ${binary === undefined ? "not installed (optional dependencies may be disabled, or the platform is unsupported)" : `missing ${executable}`}. Reinstall scriptfs with optional dependencies, or build from source by running make install-native in ${root} with Rust/Cargo installed.`,
  );
}

export function nativeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SCRIPTFS_NODE: process.execPath,
    SCRIPTFS_JS_ROOT: packageRoot,
  };
}
