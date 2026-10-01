import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  terminateChild,
  unmountFuse,
  waitForTcpServer,
} from "../src/container/lifecycle.js";
import type { FuseInstance } from "../src/container/fuse-binding.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

it("waits until a delayed TCP listener accepts connections", async () => {
  const reservation = createServer();
  servers.push(reservation);
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  servers.splice(servers.indexOf(reservation), 1);

  const server = createServer();
  servers.push(server);
  const waiting = waitForTcpServer(port, { timeoutMs: 2_000, retryMs: 10 });
  setTimeout(() => server.listen(port, "127.0.0.1"), 50);
  await waiting;
});

it("stops waiting if the server process exits", async () => {
  await expect(
    waitForTcpServer(1, {
      timeoutMs: 2_000,
      retryMs: 10,
      isAlive: () => false,
    }),
  ).rejects.toThrow("exited before");
});

it("propagates FUSE unmount callback errors", async () => {
  const failure = new Error("busy");
  const mount = {
    unmount: (callback: (error?: Error) => void) => callback(failure),
  } as FuseInstance;
  await expect(unmountFuse(mount)).rejects.toBe(failure);
});

it("waits for a child process to terminate", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('ready');setInterval(() => {}, 1000)",
  ]);
  await once(child.stdout, "data");
  const exit = vi.fn();
  child.once("exit", exit);
  await terminateChild(child);
  expect(exit).toHaveBeenCalledOnce();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "forcefully terminates a child that ignores the graceful signal",
  async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
    ]);
    await once(child.stdout, "data");
    await terminateChild(child, "SIGTERM", 50);
    expect(child.signalCode).toBe("SIGKILL");
  },
);
