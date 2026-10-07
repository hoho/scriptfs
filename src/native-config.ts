import { spawnSync } from "node:child_process";
import { nativeBinary, nativeEnvironment } from "./native-binary.js";
import type {
  InspectedModule,
  ModuleManifest,
  ScriptFsConfig,
} from "./types.js";

export const SDK_PREFIX = "SCRIPTFS_SDK:";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConfig(value: unknown): value is ScriptFsConfig {
  return (
    isRecord(value) &&
    Array.isArray(value.filesystems) &&
    value.filesystems.every(
      (filesystem: unknown) =>
        isRecord(filesystem) &&
        typeof filesystem.name === "string" &&
        typeof filesystem.source === "string" &&
        typeof filesystem.mountPoint === "string",
    )
  );
}

type NativeRequest =
  | { op: "validate"; config: unknown }
  | { op: "load"; configPath: string }
  | { op: "module"; manifest: string };

function requestNative(
  request: NativeRequest,
  event: "config" | "module",
  cwd?: string,
): Record<string, unknown> {
  const result = spawnSync(nativeBinary(), ["--sdk-config"], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    env: nativeEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.error) throw result.error;
  const responses = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(SDK_PREFIX));
  const [responseLine] = responses;
  if (responses.length !== 1 || responseLine === undefined) {
    throw new Error(
      `Invalid native configuration response (exit ${String(result.status ?? result.signal)}): ${result.stderr.trim()}`,
    );
  }
  const response: unknown = JSON.parse(responseLine.slice(SDK_PREFIX.length));
  if (!isRecord(response))
    throw new Error("Invalid native configuration response");
  if (response.event === "error" && typeof response.message === "string")
    throw new Error(response.message);
  if (result.status !== 0 || response.event !== event) {
    throw new Error(
      `Invalid native configuration result (exit ${String(result.status ?? result.signal)}): ${result.stderr.trim()}`,
    );
  }
  return response;
}

function requestConfig(
  request: Exclude<NativeRequest, { op: "module" }>,
): ScriptFsConfig {
  const { config } = requestNative(request, "config");
  if (!isConfig(config)) throw new Error("Invalid native configuration result");
  return config;
}

type ParseResult =
  { success: true; data: ScriptFsConfig } | { success: false; error: Error };

export const scriptFsConfigSchema = {
  parse(input: unknown): ScriptFsConfig {
    return requestConfig({ op: "validate", config: input });
  },
  safeParse(input: unknown): ParseResult {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { success: false, error };
    }
  },
  parseAsync(input: unknown): Promise<ScriptFsConfig> {
    return Promise.resolve().then(() => this.parse(input));
  },
  safeParseAsync(input: unknown): Promise<ParseResult> {
    return Promise.resolve().then(() => this.safeParse(input));
  },
};

/**
 * Locates a module like a configuration's `manifest` reference (a manifest
 * file, a folder containing `scriptfs.module.json`, or an installed package
 * name, resolved against `cwd`) and validates its manifest, entry, and
 * dependency lockfile.
 */
export function inspectModule(
  manifest: string,
  options: { cwd?: string } = {},
): Promise<InspectedModule> {
  return Promise.resolve().then(() => {
    const { module } = requestNative(
      { op: "module", manifest },
      "module",
      options.cwd,
    );
    if (
      !isRecord(module) ||
      typeof module.manifestPath !== "string" ||
      !isRecord(module.manifest)
    )
      throw new Error("Invalid native module description");
    return {
      manifestPath: module.manifestPath,
      manifest: module.manifest as unknown as ModuleManifest,
    };
  });
}

export function loadConfig(configPath: string): Promise<ScriptFsConfig> {
  return Promise.resolve().then(() =>
    requestConfig({ op: "load", configPath }),
  );
}
