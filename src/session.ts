import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { nativeBinary, nativeEnvironment } from "./native-binary.js";
import { isRecord, SDK_PREFIX } from "./native-config.js";
import type { ScriptFsConfig, ScriptFsSession, StartOptions } from "./types.js";

export class ScriptFsStartupError extends AggregateError {
  readonly session: ScriptFsSession;

  constructor(errors: unknown[], message: string, session: ScriptFsSession) {
    super(errors, message);
    this.name = "ScriptFsStartupError";
    this.session = session;
  }
}

function readMounts(value: unknown): Map<string, string> {
  if (!Array.isArray(value)) throw new Error("Invalid native mount response");
  const mounts = new Map<string, string>();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    )
      throw new Error("Invalid native mount response");
    mounts.set(entry[0], entry[1]);
  }
  return mounts;
}

export async function startScriptFs(
  config: ScriptFsConfig,
  options: StartOptions = {},
): Promise<ScriptFsSession> {
  options.signal?.throwIfAborted();
  const request = `${JSON.stringify({ op: "start", config })}\n`;
  const child = spawn(nativeBinary(), ["--sdk"], {
    stdio: "pipe",
    env: nativeEnvironment(),
  });
  const startup = Promise.withResolvers<ScriptFsSession>();
  const completion = Promise.withResolvers<undefined>();
  const cleanup = Promise.withResolvers<undefined>();
  // Preserve failures for wait()/stop() even when callers attach them later.
  void completion.promise.catch(() => {});
  void cleanup.promise.catch(() => {});
  let containerId = "";
  const mounts = new Map<string, string>();
  let ready = false;
  let stopped = false;
  let closed = false;
  let aborted = false;
  let error: Error | undefined;
  let stopRequest:
    ReturnType<typeof Promise.withResolvers<undefined>> | undefined;
  let stderr = "";

  const session: ScriptFsSession = {
    get containerId() {
      return containerId;
    },
    get mounts() {
      return mounts;
    },
    wait: () => completion.promise,
    stop() {
      if (closed || stopped) return cleanup.promise;
      if (stopRequest) return stopRequest.promise;
      const request = Promise.withResolvers<undefined>();
      stopRequest = request;
      sendStop();
      return request.promise;
    },
  };

  function sendStop() {
    if (child.stdin.destroyed) {
      child.kill("SIGTERM");
      return;
    }
    child.stdin.write('{"op":"stop"}\n');
  }

  function fail(reason: Error) {
    error = reason;
    startup.reject(reason);
    completion.reject(reason);
  }

  function updateMounts(value: unknown) {
    const current = readMounts(value);
    mounts.clear();
    for (const [name, mount] of current) mounts.set(name, mount);
  }

  const abort = () => {
    aborted = true;
    sendStop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
    process.stderr.write(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("error", (reason: Error) => {
    fail(reason);
    child.kill("SIGTERM");
  });
  lines.on("line", (line) => {
    if (!line.startsWith(SDK_PREFIX)) {
      process.stdout.write(`${line}\n`);
      return;
    }
    try {
      const message: unknown = JSON.parse(line.slice(SDK_PREFIX.length));
      if (!isRecord(message))
        throw new Error("Invalid native session response");
      if (message.event === "ready") {
        if (
          ready ||
          stopped ||
          typeof message.containerId !== "string" ||
          !message.containerId
        )
          throw new Error("Invalid native readiness response");
        containerId = message.containerId;
        updateMounts(message.mounts);
        ready = true;
        if (!aborted) startup.resolve(session);
      } else if (message.event === "stopped") {
        stopped = true;
        mounts.clear();
      } else if (
        message.event === "error" &&
        typeof message.message === "string"
      ) {
        if (typeof message.containerId === "string")
          containerId = message.containerId;
        if (message.mounts !== undefined) updateMounts(message.mounts);
        const reason = new Error(message.message);
        if (message.retryable === true) {
          if (!ready)
            startup.reject(
              new ScriptFsStartupError([reason], message.message, session),
            );
          completion.reject(reason);
          stopRequest?.reject(reason);
          stopRequest = undefined;
        } else {
          const cancellation: unknown = options.signal?.reason;
          if (!ready && aborted) {
            error = reason;
            startup.reject(cancellation ?? reason);
            completion.reject(cancellation ?? reason);
          } else fail(reason);
        }
      } else {
        throw new Error("Unknown native session response");
      }
    } catch (reason) {
      if (!(reason instanceof Error)) throw reason;
      fail(reason);
      child.kill("SIGTERM");
    }
  });
  child.on("error", (reason) => fail(reason));
  child.stdin.on("error", (reason) => {
    if (!stopped) {
      fail(reason);
      child.kill("SIGTERM");
    }
  });
  child.on("close", (code, signal) => {
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    lines.close();
    if (!stopped || code !== 0) {
      const reason =
        error ??
        new Error(
          `Native ScriptFS exited unexpectedly (${String(code ?? signal)}): ${stderr.trim()}`,
        );
      fail(reason);
      if (!stopped) {
        cleanup.reject(reason);
        stopRequest?.reject(reason);
        return;
      }
    } else if (!ready || aborted) {
      startup.reject(
        options.signal?.reason ??
          new Error("Native ScriptFS stopped before readiness"),
      );
    }
    cleanup.resolve(undefined);
    stopRequest?.resolve(undefined);
    if (!error) completion.resolve(undefined);
  });
  child.stdin.write(request);
  if (options.signal?.aborted) abort();
  return startup.promise;
}
