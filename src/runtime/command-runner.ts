import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  cwd?: string;
  allowFailure?: boolean;
  output?: "capture" | "inherit";
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) throw interruptionError(options.signal.reason);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 2_147_483_647)
    ) {
      throw new RangeError(
        "Command timeout must be an integer between 1 and 2147483647",
      );
    }
    const capture = options.output !== "inherit";
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let interrupted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const closeOutput = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const interrupt = (reason: unknown): void => {
      if (interrupted) return;
      interrupted = true;
      failure = interruptionError(reason);
      if (child.exitCode !== null || child.signalCode !== null) {
        closeOutput();
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000);
    };
    const onAbort = (): void => interrupt(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(
        () =>
          interrupt(
            Object.assign(
              new Error(
                `${command} ${args.join(" ")} timed out after ${String(options.timeoutMs)}ms`,
              ),
              { code: "ETIMEDOUT" },
            ),
          ),
        options.timeoutMs,
      );
    }
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      failure = failure
        ? new AggregateError([failure, error], error.message)
        : error;
    });
    child.once("exit", () => {
      clearTimeout(killTimer);
      // Descendants may still hold inherited pipes after the cancelled child exits.
      if (interrupted) closeOutput();
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code === 0 || options.allowFailure) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${String(code)}\n${stdout}${stderr}`.trim(),
        ),
      );
    });
  });
}

function interruptionError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("Command interrupted", { cause: reason });
}
