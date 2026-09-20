import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import type { FuseInstance } from "./fuse-binding.js";

interface ReadinessOptions {
  host?: string;
  timeoutMs?: number;
  retryMs?: number;
  signal?: AbortSignal;
  isAlive?: () => boolean;
}

export async function waitForTcpServer(
  port: number,
  options: ReadinessOptions = {},
): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const retryMs = options.retryMs ?? 50;
  let lastError: unknown;

  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    if (options.isAlive && !options.isAlive()) {
      throw new Error(
        `Server process exited before ${host}:${String(port)} was ready`,
        {
          cause: lastError,
        },
      );
    }
    try {
      await connectOnce(host, port);
      return;
    } catch (error) {
      lastError = error;
    }
    await abortableDelay(retryMs, options.signal);
  }

  throw new Error(`Timed out waiting for ${host}:${String(port)}`, {
    cause: lastError,
  });
}

export function unmountFuse(mount: FuseInstance): Promise<void> {
  return new Promise((resolve, reject) => {
    mount.unmount((error) => (error ? reject(error) : resolve()));
  });
}

export async function terminateChild(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  timeoutMs = 1_000,
): Promise<void> {
  if (hasExited(child)) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.kill(signal);
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (!hasExited(child)) {
    if (!child.kill("SIGKILL")) {
      throw new Error(`Failed to terminate child process ${String(child.pid)}`);
    }
    await exited;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function connectOnce(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });

    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted(): void {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      );
    }
  });
}
