import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mountShare } from "../src/runtime/host-mount.js";
import { runCommand } from "../src/runtime/command-runner.js";

vi.mock("../src/runtime/command-runner.js", () => ({ runCommand: vi.fn() }));
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.each(["darwin", "linux", "win32"])(
  "propagates %s unmount failures",
  async (platform) => {
    const directory = await mkdtemp(path.join(tmpdir(), "scriptfs-host-test-"));
    directories.push(directory);
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key, receiver): unknown =>
          key === "platform" ? platform : Reflect.get(target, key, receiver),
      }),
    );
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: "", stderr: "" });
    const mounted = await mountShare(
      "127.0.0.1",
      445,
      "test",
      platform === "win32" ? "S:" : directory,
    );
    vi.mocked(runCommand).mockRejectedValueOnce(new Error("Resource busy"));
    await expect(mounted.unmount()).rejects.toThrow("Resource busy");
    expect(vi.mocked(runCommand).mock.calls.at(-1)?.[2]).toBeUndefined();
  },
);
