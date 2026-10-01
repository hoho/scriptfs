import { z } from "zod";
import { runCommand, type CommandResult } from "./command-runner.js";

const CHECK_TIMEOUT_MS = 10_000;
const machineListSchema = z.array(
  z.object({
    Name: z.string().min(1),
    Running: z.boolean(),
    Starting: z.boolean().optional(),
    Default: z.boolean().optional(),
    Port: z.number().int().positive().optional(),
  }),
);
const connectionListSchema = z.array(
  z.object({
    Name: z.string().min(1),
    URI: z.string().min(1),
    Default: z.boolean(),
  }),
);

export async function checkPodman(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const commandOptions = { signal, timeoutMs: CHECK_TIMEOUT_MS };
  try {
    await runCommand("podman", ["--version"], commandOptions);
  } catch (error) {
    signal?.throwIfAborted();
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    const guidance =
      process.platform === "win32"
        ? "Install Podman using the Windows installer, or run `winget install --id RedHat.Podman --exact`, then open a new terminal."
        : process.platform === "darwin"
          ? "Install the Podman macOS installer, or run `brew install podman`, then open a new terminal."
          : "Install Podman using your distribution's package manager (for example, `sudo apt-get install podman` on Debian/Ubuntu).";
    throw new Error(
      missing
        ? `Podman executable was not found on PATH. ${guidance}`
        : `Could not run the Podman CLI. Check its installation and executable permissions.\n${diagnostic(error)}`,
      { cause: error },
    );
  }

  const requiresMachine =
    process.platform === "win32" || process.platform === "darwin";
  if (requiresMachine) {
    await checkMachineRunning(signal);
  }

  let info: CommandResult;
  try {
    info = await runCommand(
      "podman",
      ["info", "--format", "{{.Host.OS}}"],
      commandOptions,
    );
  } catch (error) {
    signal?.throwIfAborted();
    const guidance = requiresMachine
      ? "The Podman VM is running, but the active connection is not reachable. Check `podman system connection list` and select the correct connection with `podman system connection default <name>`."
      : "Run `podman info` to diagnose runtime permissions and configuration. If using remote Podman, check `podman system connection list` and the selected connection.";
    throw new Error(
      `Podman is installed, but its runtime is unavailable. ${guidance}\n${diagnostic(error)}`,
      { cause: error },
    );
  }
  if (info.stdout.trim() !== "linux") {
    throw new Error(
      `ScriptFS requires a Linux Podman backend; podman info reported ${JSON.stringify(info.stdout.trim())}. Check the selected Podman connection.`,
    );
  }
}

async function checkMachineRunning(signal?: AbortSignal): Promise<void> {
  let machines: z.infer<typeof machineListSchema>;
  try {
    const result = await runCommand(
      "podman",
      ["machine", "list", "--format", "json"],
      { signal, timeoutMs: CHECK_TIMEOUT_MS },
    );
    machines = machineListSchema.parse(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `Could not determine Podman machine status. Run \`podman machine list\` and \`podman system connection list\`.\n${diagnostic(error)}`,
      { cause: error },
    );
  }
  if (machines.length === 0) {
    throw new Error(
      "No Podman machine exists. Run `podman machine init`, then `podman machine start`.",
    );
  }
  const connectionName = process.env.CONTAINER_CONNECTION;
  const connectionUri = process.env.CONTAINER_HOST;
  const overridden = !!(connectionName || connectionUri);
  let selected = overridden
    ? undefined
    : (machines.find((machine) => machine.Default) ??
      (machines.length === 1 ? machines[0] : undefined));
  if (
    overridden ||
    (!selected && machines.some((machine) => machine.Running))
  ) {
    try {
      const result = await runCommand(
        "podman",
        ["system", "connection", "list", "--format", "json"],
        { signal, timeoutMs: CHECK_TIMEOUT_MS },
      );
      const connection = connectionListSchema
        .parse(JSON.parse(result.stdout) as unknown)
        .find((connection) =>
          connectionName
            ? connection.Name === connectionName
            : connectionUri
              ? connection.URI === connectionUri
              : connection.Default,
        );
      if (connection) {
        const port = Number(new URL(connection.URI).port);
        const candidates = machines.filter(
          (machine) =>
            (machine.Name === connection.Name ||
              `${machine.Name}-root` === connection.Name) &&
            (machine.Port === undefined || machine.Port === port),
        );
        if (candidates.length === 1) selected = candidates[0];
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(
        `Could not determine the selected Podman connection. Run \`podman system connection list\`.\n${diagnostic(error)}`,
        { cause: error },
      );
    }
  }
  if (selected && (selected.Starting || !selected.Running)) {
    throw new Error(
      selected.Starting
        ? `Podman machine ${JSON.stringify(selected.Name)} is still starting. Wait for \`podman machine start\` to finish, then rerun ScriptFS.`
        : `Podman machine ${JSON.stringify(selected.Name)} is stopped. Run \`podman machine start --update-connection ${JSON.stringify(selected.Name)}\`.`,
    );
  }
  if (!selected && !machines.some((machine) => machine.Running)) {
    throw new Error(
      `No Podman machine is running. Available machines: ${machines.map((machine) => JSON.stringify(machine.Name)).join(", ")}. Run \`podman machine start --update-connection <name>\`.`,
    );
  }
  if (!selected) {
    throw new Error(
      `Cannot identify the selected Podman machine. Available machines: ${machines.map((machine) => JSON.stringify(machine.Name)).join(", ")}. Check \`podman system connection list\` and select the correct connection with \`podman system connection default <name>\`.`,
    );
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
