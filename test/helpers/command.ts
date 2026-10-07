import { execFile } from "node:child_process";

interface CommandOptions {
  allowFailure?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (
          error &&
          !(options.allowFailure && typeof error.code === "number")
        ) {
          reject(new Error(error.message, { cause: error }));
          return;
        }
        resolve({
          stdout,
          stderr,
          code: error && typeof error.code === "number" ? error.code : 0,
        });
      },
    );
  });
}
