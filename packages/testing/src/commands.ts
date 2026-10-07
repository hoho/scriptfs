import path from "node:path";
import { parseArgs } from "node:util";
import { inspectModule, type ModuleManifest } from "scriptfs";
import {
  startModule,
  type SecretInput,
  type StartModuleOptions,
} from "./harness.js";
import { init, packageVersion } from "./scaffold.js";

const USAGE = `Usage: scriptfs-module <command> [options]

Commands:
  init [dir] [--name <name>]   Create a module project with an end-to-end test
  check [dir]                  Validate a module's manifest, entry and lockfile
  dev [dir] [options]          Mount a module until interrupted

dev options:
  --mount <dir>                Mount point (default: a temporary folder)
  --setting <key>=<value>      Setting value, parsed as JSON when valid
  --secret <key>=<value>       Secret value
  --secret-env <key>=<NAME>    Secret read from an environment variable
  --secret-file <key>=<file>   Secret read from a file
  --path <key>=<host path>     Host path for a manifest path
  --outbound <key>=<host:port> Target of an outbound port
  --inbound <key>=<port>       Host port of an inbound port (default: free port)
  --state <dir>                Host state folder (default: temporary)
  --options <json>             Rule options passed to every callback
  --image <image>              Runtime image
  --log-level <level>          silent, info (default) or debug

[dir] defaults to the current folder; check and dev also accept a manifest
file or an installed package name.`;

function pairs(values: string[] | undefined, flag: string): [string, string][] {
  return (values ?? []).map((value) => {
    const separator = value.indexOf("=");
    if (separator < 1) throw new Error(`${flag} expects <key>=<value>`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  });
}

function settingValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** A short description of what a manifest asks for. */
export function describeManifest(
  manifest: ModuleManifest,
  manifestPath: string,
): string {
  const lines = [
    `${manifest.name}${manifest.version ? `@${manifest.version}` : ""}: ${manifestPath}`,
  ];
  if (manifest.description) lines.push(`  ${manifest.description}`);
  lines.push(
    `  entry: ${manifest.entry}${manifest.export && manifest.export !== "default" ? ` (export ${manifest.export})` : ""}`,
  );
  lines.push(`  dependencies: ${manifest.dependencies ?? "bundled"}`);
  const list = (label: string, entries: [string, string][]) => {
    if (entries.length)
      lines.push(
        `  ${label}: ${entries.map(([key, detail]) => (detail ? `${key} (${detail})` : key)).join(", ")}`,
      );
  };
  list(
    "settings",
    Object.entries(manifest.settings ?? {}).map(([key, setting]) => [
      key,
      setting.type +
        (setting.default === undefined && setting.required ? ", required" : ""),
    ]),
  );
  list(
    "secrets",
    Object.entries(manifest.secrets ?? {}).map(([key, secret]) => [
      key,
      [
        secret.required === false ? "optional" : "",
        secret.env ? `$${secret.env}` : "",
      ]
        .filter(Boolean)
        .join(", "),
    ]),
  );
  list(
    "ports",
    Object.entries(manifest.ports ?? {}).map(([key, port]) => [
      key,
      port.direction === "inbound"
        ? `inbound ${String(port.port)}`
        : `outbound${port.target ? ` ${port.target}` : ""}`,
    ]),
  );
  list(
    "paths",
    Object.entries(manifest.paths ?? {}).map(([key, spec]) => [
      key,
      [
        spec.type ?? "directory",
        spec.access ?? "read-only",
        spec.required === false ? "optional" : "",
      ]
        .filter(Boolean)
        .join(", "),
    ]),
  );
  if (manifest.state) lines.push("  state: yes");
  return lines.join("\n");
}

/** Options for `startModule` from `dev` arguments. */
export function devOptions(argv: string[]): StartModuleOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "mount": { type: "string" },
      "setting": { type: "string", multiple: true },
      "secret": { type: "string", multiple: true },
      "secret-env": { type: "string", multiple: true },
      "secret-file": { type: "string", multiple: true },
      "path": { type: "string", multiple: true },
      "outbound": { type: "string", multiple: true },
      "inbound": { type: "string", multiple: true },
      "state": { type: "string" },
      "options": { type: "string" },
      "image": { type: "string" },
      "log-level": { type: "string" },
    },
  });
  if (positionals.length > 1) throw new Error("dev accepts one module");
  const secrets: Record<string, SecretInput> = {};
  for (const [key, value] of pairs(values.secret, "--secret"))
    secrets[key] = value;
  for (const [key, env] of pairs(values["secret-env"], "--secret-env"))
    secrets[key] = { env };
  for (const [key, file] of pairs(values["secret-file"], "--secret-file"))
    secrets[key] = { file };
  const inbound: Record<string, number> = {};
  for (const [key, value] of pairs(values.inbound, "--inbound")) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`--inbound ${key} must be a port number`);
    inbound[key] = port;
  }
  const level = values["log-level"] ?? "info";
  if (level !== "silent" && level !== "info" && level !== "debug")
    throw new Error("--log-level must be silent, info or debug");
  return {
    module: positionals[0] ?? ".",
    settings: Object.fromEntries(
      pairs(values.setting, "--setting").map(([key, value]) => [
        key,
        settingValue(value),
      ]),
    ),
    secrets,
    paths: Object.fromEntries(pairs(values.path, "--path")),
    outbound: Object.fromEntries(pairs(values.outbound, "--outbound")),
    inbound,
    ...(values.state ? { state: values.state } : {}),
    ...(values.options
      ? { options: JSON.parse(values.options) as unknown }
      : {}),
    ...(values.mount ? { mount: values.mount } : {}),
    ...(values.image ? { image: values.image } : {}),
    logLevel: level,
  };
}

async function dev(argv: string[]): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const module = await startModule({
    ...devOptions(argv),
    signal: controller.signal,
  });
  console.log(describeManifest(module.manifest, module.manifestPath));
  console.log(`\nMounted at ${module.root}`);
  for (const key of Object.keys(module.manifest.ports ?? {})) {
    if (module.manifest.ports?.[key]?.direction === "inbound")
      console.log(`Inbound port ${key}: ${module.inbound(key).url}`);
  }
  console.log("Press Ctrl+C to stop.");
  await Promise.race([
    module.session.wait(),
    new Promise((resolve) =>
      controller.signal.addEventListener("abort", resolve, { once: true }),
    ),
  ]).finally(() => module.stop());
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === "init") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { name: { type: "string" } },
    });
    if (positionals.length > 1) throw new Error("init accepts one folder");
    const directory = path.resolve(positionals[0] ?? ".");
    const name = values.name ?? path.basename(directory).toLowerCase();
    const files = await init(directory, name, await packageVersion());
    console.log(
      `Created ${name} in ${directory}:\n${files.map((file) => `  ${file}`).join("\n")}\n\nNext: npm install && npm test`,
    );
    return 0;
  }
  if (command === "check") {
    if (rest.length > 1) throw new Error("check accepts one module");
    const { manifest, manifestPath } = await inspectModule(rest[0] ?? ".");
    console.log(describeManifest(manifest, manifestPath));
    return 0;
  }
  if (command === "dev") {
    await dev(rest);
    return 0;
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
}
