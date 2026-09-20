import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCommand } from "../src/runtime/command-runner.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-command-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("captures output and only permits ordinary command failures with allowFailure", async () => {
  const args = [
    "-e",
    'process.stdout.write("output"); process.stderr.write("error"); process.exitCode=3;',
  ];
  await expect(
    runCommand(process.execPath, args, { allowFailure: true }),
  ).resolves.toEqual({ stdout: "output", stderr: "error" });
  await expect(runCommand(process.execPath, args)).rejects.toThrow(
    "failed with exit code 3\noutputerror",
  );
  await expect(
    runCommand(path.join(root, "missing-command"), [], { allowFailure: true }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not spawn a command when already aborted", async () => {
  const reason = new Error("cancelled before spawn");
  const marker = path.join(root, "spawned");
  await expect(
    runCommand(
      process.execPath,
      ["-e", 'require("fs").writeFileSync(process.argv[1], "spawned")', marker],
      { signal: AbortSignal.abort(reason), allowFailure: true },
    ),
  ).rejects.toBe(reason);
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
  "rejects invalid command timeout %s",
  async (timeoutMs) => {
    await expect(
      runCommand(process.execPath, ["-e", ""], { timeoutMs }),
    ).rejects.toBeInstanceOf(RangeError);
  },
);

it.skipIf(process.platform === "win32")(
  "waits for an aborted command's cleanup and exit even when it exits successfully",
  async () => {
    const controller = new AbortController();
    const reason = new Error("cancel during command");
    const marker = path.join(root, "pid");
    const cleaned = path.join(root, "cleaned");
    const running = runCommand(
      process.execPath,
      [
        "-e",
        `
        const fs = require("fs");
        process.on("SIGTERM", () => setTimeout(() => {
          fs.writeFileSync(process.argv[2], "cleaned");
          process.exit(0);
        }, 50));
        fs.writeFileSync(process.argv[1], String(process.pid));
        setInterval(() => {}, 1000);
      `,
        marker,
        cleaned,
      ],
      { signal: controller.signal, allowFailure: true },
    );
    const rejected = expect(running).rejects.toBe(reason);
    await vi.waitFor(() => access(marker));
    controller.abort(reason);
    await rejected;
    await expect(readFile(cleaned, "utf8")).resolves.toBe("cleaned");
    const pid = Number(await readFile(marker, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  },
);

it.each(["abort", "timeout"] as const)(
  "terminates and reaps a command ignoring SIGTERM on %s",
  async (kind) => {
    const controller = new AbortController();
    const marker = path.join(root, "pid");
    const running = runCommand(
      process.execPath,
      [
        "-e",
        `
          process.on("SIGTERM", () => {});
          require("fs").writeFileSync(process.argv[1], String(process.pid));
          setInterval(() => {}, 1000);
        `,
        marker,
      ],
      {
        signal: controller.signal,
        timeoutMs: kind === "timeout" ? 1_000 : undefined,
        allowFailure: true,
      },
    );
    const rejected =
      kind === "timeout"
        ? expect(running).rejects.toMatchObject({ code: "ETIMEDOUT" })
        : expect(running).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => access(marker));
    if (kind === "abort") controller.abort();
    await rejected;
    const pid = Number(await readFile(marker, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  },
);

it("removes the abort listener after a command completes", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  await runCommand(process.execPath, ["-e", ""], {
    signal: controller.signal,
    timeoutMs: 1_000,
  });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  controller.abort();
});
