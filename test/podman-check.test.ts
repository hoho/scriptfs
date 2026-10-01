import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkPodman } from "../src/runtime/podman-check.js";
import { runCommand } from "../src/runtime/command-runner.js";

vi.mock("../src/runtime/command-runner.js", () => ({ runCommand: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("CONTAINER_CONNECTION", "");
  vi.stubEnv("CONTAINER_HOST", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function platform(value: string): void {
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get: (target, key, receiver): unknown =>
        key === "platform" ? value : Reflect.get(target, key, receiver),
    }),
  );
}

it.each([
  ["win32", "winget install --id RedHat.Podman --exact"],
  ["darwin", "brew install podman"],
  ["linux", "sudo apt-get install podman"],
])("reports missing Podman on %s", async (host, guidance) => {
  platform(host);
  vi.mocked(runCommand).mockRejectedValue(
    Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" }),
  );
  await expect(checkPodman()).rejects.toThrow(
    `Podman executable was not found on PATH`,
  );
  await expect(checkPodman()).rejects.toThrow(guidance);
  expect(
    vi
      .mocked(runCommand)
      .mock.calls.every(([, args]) => args[0] === "--version"),
  ).toBe(true);
});

it("does not classify executable permission errors as a missing installation", async () => {
  vi.mocked(runCommand).mockRejectedValue(
    Object.assign(new Error("spawn podman EACCES"), { code: "EACCES" }),
  );
  await expect(checkPodman()).rejects.toThrow("executable permissions");
});

it.each(["linux", "darwin", "win32"])(
  "checks the required VM on %s before checking backend readiness",
  async (host) => {
    platform(host);
    vi.mocked(runCommand).mockResolvedValueOnce({
      stdout: "podman version 5.8.3\n",
      stderr: "",
    });
    if (host !== "linux") {
      vi.mocked(runCommand).mockResolvedValueOnce({
        stdout: JSON.stringify([
          { Name: "my-vm", Running: true, Default: true },
        ]),
        stderr: "",
      });
    }
    vi.mocked(runCommand).mockResolvedValueOnce({
      stdout: "linux\n",
      stderr: "",
    });
    const controller = new AbortController();
    await checkPodman(controller.signal);
    expect(runCommand).toHaveBeenNthCalledWith(
      host === "linux" ? 2 : 3,
      "podman",
      ["info", "--format", "{{.Host.OS}}"],
      { signal: controller.signal, timeoutMs: 10_000 },
    );
    if (host !== "linux") {
      expect(runCommand).toHaveBeenNthCalledWith(
        2,
        "podman",
        ["machine", "list", "--format", "json"],
        { signal: controller.signal, timeoutMs: 10_000 },
      );
    }
    expect(runCommand).toHaveBeenCalledTimes(host === "linux" ? 2 : 3);
  },
);

it("rejects a non-Linux backend", async () => {
  platform("linux");
  vi.mocked(runCommand)
    .mockResolvedValueOnce({ stdout: "version", stderr: "" })
    .mockResolvedValueOnce({ stdout: "freebsd\n", stderr: "" });
  await expect(checkPodman()).rejects.toThrow(
    "requires a Linux Podman backend",
  );
});

it("preserves native Linux runtime diagnostics without recommending a VM", async () => {
  platform("linux");
  vi.mocked(runCommand)
    .mockResolvedValueOnce({ stdout: "version", stderr: "" })
    .mockRejectedValueOnce(new Error("rootless permissions failure"));
  const error = await checkPodman().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : "";
  expect(message).toContain("runtime is unavailable");
  expect(message).toContain("rootless permissions failure");
  expect(message).not.toContain("machine init");
  expect(runCommand).toHaveBeenCalledTimes(2);
});

it.each(["darwin", "win32"])(
  "distinguishes missing, stopped, ambiguous, and unreachable machines on %s",
  async (host) => {
    platform(host);
    const cases = [
      { machines: [], message: "No Podman machine exists" },
      {
        machines: [{ Name: "my-vm", Running: false }],
        message: 'start --update-connection "my-vm"',
      },
      {
        machines: [
          { Name: "other", Running: false },
          { Name: "default", Running: false, Default: true },
        ],
        message: 'start --update-connection "default"',
      },
      {
        machines: [
          { Name: "unrelated", Running: true },
          { Name: "required", Running: false, Default: true },
        ],
        message: 'start --update-connection "required"',
      },
      {
        machines: [{ Name: "my-vm", Running: false, Starting: true }],
        message: "is still starting",
      },
      {
        machines: [{ Name: "my-vm", Running: true, Starting: true }],
        message: "is still starting",
      },
      {
        machines: [
          { Name: "one", Running: true },
          { Name: "two", Running: false },
        ],
        message: "Cannot identify the selected Podman machine",
      },
      {
        machines: [
          { Name: "one", Running: false },
          { Name: "two", Running: false },
        ],
        message: "Available machines",
      },
      {
        machines: [{ Name: "my-vm", Running: true }],
        message: "active connection is not reachable",
      },
    ];
    for (const { machines, message } of cases) {
      vi.mocked(runCommand)
        .mockResolvedValueOnce({ stdout: "version", stderr: "" })
        .mockResolvedValueOnce({
          stdout: JSON.stringify(machines),
          stderr: "",
        });
      if (message === "active connection is not reachable") {
        vi.mocked(runCommand).mockRejectedValueOnce(
          new Error("connection refused"),
        );
      } else if (message === "Cannot identify the selected Podman machine") {
        vi.mocked(runCommand).mockResolvedValueOnce({
          stdout: "[]",
          stderr: "",
        });
      }
      await expect(checkPodman()).rejects.toThrow(message);
    }
  },
);

it.each(["darwin", "win32"])(
  "checks the selected rootful VM rather than another machine on %s",
  async (host) => {
    platform(host);
    for (const running of [false, true]) {
      vi.mocked(runCommand)
        .mockResolvedValueOnce({ stdout: "version", stderr: "" })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            { Name: "unrelated", Running: true, Default: false, Port: 50001 },
            { Name: "required", Running: running, Default: false, Port: 50002 },
          ]),
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              Name: "required-root",
              URI: "ssh://root@127.0.0.1:50002/run/podman/podman.sock",
              Default: true,
            },
          ]),
          stderr: "",
        });
      if (running) {
        vi.mocked(runCommand).mockResolvedValueOnce({
          stdout: "linux",
          stderr: "",
        });
        await expect(checkPodman()).resolves.toBeUndefined();
      } else {
        await expect(checkPodman()).rejects.toThrow(
          'Podman machine "required" is stopped',
        );
      }
    }
  },
);

it.each(
  ["darwin", "win32"].flatMap((host) =>
    ["connection", "host", "both"].map((override) => [host, override]),
  ),
)(
  "honors the %s Podman %s override when checking VM state",
  async (host, override) => {
    platform(host);
    const uri = "ssh://root@127.0.0.1:50002/run/podman/podman.sock";
    if (override !== "host")
      vi.stubEnv("CONTAINER_CONNECTION", "required-root");
    if (override !== "connection")
      vi.stubEnv(
        "CONTAINER_HOST",
        override === "both"
          ? "ssh://root@127.0.0.1:50001/run/podman/podman.sock"
          : uri,
      );
    for (const running of [false, true]) {
      vi.mocked(runCommand).mockReset();
      vi.mocked(runCommand)
        .mockResolvedValueOnce({ stdout: "version", stderr: "" })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            { Name: "default", Running: !running, Default: true, Port: 50001 },
            { Name: "required", Running: running, Default: false, Port: 50002 },
          ]),
          stderr: "",
        })
        .mockImplementation((_command, args) =>
          Promise.resolve({
            stdout:
              args[0] === "system"
                ? JSON.stringify([
                    {
                      Name: "default",
                      URI: "ssh://root@127.0.0.1:50001/run/podman/podman.sock",
                      Default: true,
                    },
                    { Name: "required-root", URI: uri, Default: false },
                  ])
                : "linux",
            stderr: "",
          }),
        );
      if (running) {
        await expect(checkPodman()).resolves.toBeUndefined();
      } else {
        await expect(checkPodman()).rejects.toThrow(
          'Podman machine "required" is stopped',
        );
        expect(runCommand).toHaveBeenCalledTimes(3);
      }
    }
  },
);

it.each(["CONTAINER_CONNECTION", "CONTAINER_HOST"])(
  "does not fall back to a sole running machine for an unknown %s override",
  async (variable) => {
    platform("win32");
    vi.stubEnv(
      variable,
      variable === "CONTAINER_CONNECTION"
        ? "unknown"
        : "ssh://root@127.0.0.1:50002/run/podman/podman.sock",
    );
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ stdout: "version", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { Name: "default", Running: true, Default: true, Port: 50001 },
        ]),
        stderr: "",
      })
      .mockImplementation((_command, args) =>
        Promise.resolve({
          stdout:
            args[0] === "system"
              ? JSON.stringify([
                  {
                    Name: "default",
                    URI: "ssh://root@127.0.0.1:50001/run/podman/podman.sock",
                    Default: true,
                  },
                ])
              : "linux",
          stderr: "",
        }),
      );
    await expect(checkPodman()).rejects.toThrow(
      "Cannot identify the selected Podman machine",
    );
    expect(runCommand).toHaveBeenCalledTimes(3);
  },
);

it("reports a failed connection lookup without assuming a running VM is selected", async () => {
  platform("win32");
  vi.mocked(runCommand)
    .mockResolvedValueOnce({ stdout: "version", stderr: "" })
    .mockResolvedValueOnce({
      stdout: JSON.stringify([
        { Name: "one", Running: true, Default: false },
        { Name: "two", Running: false, Default: false },
      ]),
      stderr: "",
    })
    .mockRejectedValueOnce(new Error("connection listing failed"));
  await expect(checkPodman()).rejects.toThrow("connection listing failed");
  expect(runCommand).toHaveBeenCalledTimes(3);
});

it.each(["darwin", "win32"])(
  "rejects a stopped required VM before checking even an otherwise reachable backend on %s",
  async (host) => {
    platform(host);
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ stdout: "version", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { Name: "required-vm", Running: false, Default: true },
        ]),
        stderr: "",
      })
      .mockResolvedValue({ stdout: "linux\n", stderr: "" });
    await expect(checkPodman()).rejects.toThrow(
      'Podman machine "required-vm" is stopped',
    );
    expect(runCommand).toHaveBeenCalledTimes(2);
  },
);

it.each(["invalid json", "{}", '[{"Name":"bad-status"}]'])(
  "reports malformed machine status rather than assuming a missing VM: %s",
  async (stdout) => {
    platform("win32");
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ stdout: "version", stderr: "" })
      .mockResolvedValueOnce({ stdout, stderr: "" });
    await expect(checkPodman()).rejects.toThrow(
      "Could not determine Podman machine status",
    );
  },
);

it("preserves a failed machine-list diagnostic", async () => {
  platform("darwin");
  vi.mocked(runCommand)
    .mockResolvedValueOnce({ stdout: "version", stderr: "" })
    .mockRejectedValueOnce(new Error("machine listing failed"));
  await expect(checkPodman()).rejects.toThrow("machine listing failed");
});

it("does not spawn when the check is already cancelled", async () => {
  await expect(checkPodman(AbortSignal.abort())).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(runCommand).not.toHaveBeenCalled();
});

it("preserves cancellation while checking VM state", async () => {
  platform("win32");
  const controller = new AbortController();
  const reason = new Error("cancelled while checking VM state");
  vi.mocked(runCommand)
    .mockResolvedValueOnce({ stdout: "version", stderr: "" })
    .mockImplementationOnce(() => {
      controller.abort(reason);
      return Promise.reject(reason);
    });
  await expect(checkPodman(controller.signal)).rejects.toBe(reason);
  expect(runCommand).toHaveBeenCalledTimes(2);
});
it("preserves cancellation during runtime diagnosis", async () => {
  platform("win32");
  const controller = new AbortController();
  const reason = new Error("cancelled during runtime diagnosis");
  vi.mocked(runCommand)
    .mockResolvedValueOnce({ stdout: "version", stderr: "" })
    .mockResolvedValueOnce({
      stdout: JSON.stringify([{ Name: "my-vm", Running: true, Default: true }]),
      stderr: "",
    })
    .mockImplementationOnce(() => {
      controller.abort(reason);
      return Promise.reject(reason);
    });
  await expect(checkPodman(controller.signal)).rejects.toBe(reason);
  expect(runCommand).toHaveBeenCalledTimes(3);
});
