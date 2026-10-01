import { afterEach, expect, it, vi } from "vitest";
import {
  configureSmbCredentials,
  createSmbConfig,
} from "../src/container/samba.js";
import { runCommand } from "../src/runtime/command-runner.js";

vi.mock("../src/runtime/command-runner.js", () => ({ runCommand: vi.fn() }));

afterEach(() => vi.resetAllMocks());

it.each([false, true])(
  "creates the existing guest configuration or authenticated configuration: %s",
  (authenticated) => {
    const config = createSmbConfig(
      {
        filesystems: [
          {
            name: "test",
            source: "/source",
            mountPoint: "/overlay",
            readOnly: true,
          },
        ],
      },
      authenticated,
    );
    expect(config).toContain("path = /overlay");
    expect(config).toContain("read only = yes");
    expect(config).toContain(`guest ok = ${authenticated ? "no" : "yes"}`);
    expect(config).toContain(
      `map to guest = ${authenticated ? "Never" : "Bad User"}`,
    );
    if (authenticated) expect(config).toContain("valid users = scriptfs");
    else expect(config).not.toContain("valid users");
  },
);

it("creates the SMB user and sends its password through stdin", async () => {
  vi.mocked(runCommand).mockResolvedValue({ stdout: "", stderr: "" });
  const credentials = {
    username: "scriptfs" as const,
    password: "a".repeat(64),
  };
  await configureSmbCredentials(credentials, "/tmp/smb.conf");
  expect(runCommand).toHaveBeenCalledWith("useradd", [
    "--no-create-home",
    "--shell",
    "/usr/sbin/nologin",
    "scriptfs",
  ]);
  expect(runCommand).toHaveBeenLastCalledWith(
    "smbpasswd",
    ["-s", "-a", "-c", "/tmp/smb.conf", "scriptfs"],
    { input: `${credentials.password}\n${credentials.password}\n` },
  );
});

it("rejects malformed credentials before running commands", async () => {
  await expect(
    configureSmbCredentials(
      { username: "scriptfs", password: "invalid\ninput" },
      "/tmp/smb.conf",
    ),
  ).rejects.toThrow("Invalid generated ScriptFS SMB credentials");
  expect(runCommand).not.toHaveBeenCalled();
});
