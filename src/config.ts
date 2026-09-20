import { lstat, readFile, stat } from "node:fs/promises";
import { resolve } from "import-meta-resolve";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { ScriptFsConfig } from "./types.js";

const providerReferenceSchema = z.union([
  z.object({
    type: z.literal("module").optional(),
    module: z.string().min(1),
    export: z.string().min(1).optional(),
    options: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("directory"),
    path: z.string().min(1),
  }),
]);

const providerRuleSchema = z.object({
  match: z.string().min(1),
  root: z.string().optional(),
  provider: providerReferenceSchema,
  opaque: z.boolean().optional(),
  file: z
    .object({
      mode: z.number().int().min(0).optional(),
      size: z.number().int().min(0).optional(),
      sizeMode: z.enum(["content", "explicit", "zero", "unbounded"]).optional(),
      seekable: z.boolean().optional(),
    })
    .optional(),
});

const hideRuleSchema = z.object({
  match: z.string().min(1),
  hide: z.literal(true),
});

const filesystemSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "must contain only letters, numbers, _ or -")
    .refine(
      (name) => !["global", "homes", "printers"].includes(name.toLowerCase()),
      "must not be a reserved Samba section name: global, homes, or printers",
    ),
  source: z.string().min(1),
  mountPoint: z.string().min(1),
  readOnly: z.boolean().optional(),
  rules: z.array(z.union([providerRuleSchema, hideRuleSchema])).optional(),
});

export const scriptFsConfigSchema = z.object({
  filesystems: z.array(filesystemSchema).min(1),
  container: z
    .object({
      image: z.string().min(1).optional(),
      rebuild: z.boolean().optional(),
      smbHost: z.string().min(1).optional(),
      smbPort: z.number().int().min(1).max(65_535).optional(),
      logLevel: z.enum(["silent", "info", "debug"]).optional(),
    })
    .optional(),
});

export async function loadConfig(configPath: string): Promise<ScriptFsConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absoluteConfigPath, "utf8")) as unknown;
  const configDirectory = path.dirname(absoluteConfigPath);
  const config = resolveHostPaths(
    scriptFsConfigSchema.parse(raw),
    configDirectory,
  );

  const resolvedConfig: ScriptFsConfig = {
    ...config,
    filesystems: config.filesystems.map((filesystem) => ({
      ...filesystem,
      rules: filesystem.rules?.map((rule) => {
        if ("hide" in rule || !("module" in rule.provider)) {
          return rule;
        }

        return {
          ...rule,
          provider: {
            ...rule.provider,
            module: resolveProviderModule(
              absoluteConfigPath,
              rule.provider.module,
            ),
          },
        };
      }),
    })),
  };
  await validateProxyTargets(resolvedConfig);
  return resolvedConfig;
}

export function resolveHostPaths(
  config: ScriptFsConfig,
  directory: string,
): ScriptFsConfig {
  return {
    ...config,
    filesystems: config.filesystems.map((filesystem) => ({
      ...filesystem,
      source: path.resolve(directory, filesystem.source),
      mountPoint: resolveMountPoint(directory, filesystem.mountPoint),
      rules: filesystem.rules?.map((rule) =>
        "hide" in rule || "module" in rule.provider
          ? rule
          : {
              ...rule,
              provider: {
                ...rule.provider,
                path: path.resolve(directory, rule.provider.path),
              },
            },
      ),
    })),
  };
}

export function resolveProviderModule(
  configPath: string,
  moduleName: string,
): string {
  if (
    moduleName.startsWith(".") ||
    moduleName.startsWith("/") ||
    moduleName.startsWith("file:") ||
    /^[a-zA-Z]:[\\/]/.test(moduleName)
  ) {
    if (moduleName.startsWith("file:")) {
      const reference = moduleName.slice("file:".length);
      if (
        !reference.startsWith("/") &&
        !reference.startsWith("\\") &&
        !/^[a-zA-Z]:[\\/]/.test(reference)
      ) {
        return path.resolve(
          path.dirname(configPath),
          decodeURIComponent(reference),
        );
      }
      return fileURLToPath(moduleName);
    }
    return path.resolve(path.dirname(configPath), moduleName);
  }

  return fileURLToPath(resolve(moduleName, pathToFileURL(configPath).href));
}

function resolveMountPoint(
  configDirectory: string,
  mountPoint: string,
): string {
  if (process.platform === "win32" && /^[a-zA-Z]:$/.test(mountPoint)) {
    return mountPoint.toUpperCase();
  }
  return path.resolve(configDirectory, mountPoint);
}

export async function validateProxyTargets(
  config: ScriptFsConfig,
): Promise<void> {
  for (const filesystem of config.filesystems) {
    for (const rule of filesystem.rules ?? []) {
      if ("hide" in rule || "module" in rule.provider) {
        continue;
      }
      const target = await (rule.provider.type === "file" ? lstat : stat)(
        rule.provider.path,
      );
      const valid =
        rule.provider.type === "file" ? target.isFile() : target.isDirectory();
      if (!valid) {
        throw new TypeError(
          `${rule.provider.type} provider target has the wrong type (expected ${rule.provider.type === "file" ? "a regular file, not a symbolic link" : "a directory"}): ${rule.provider.path}`,
        );
      }
    }
  }
}
