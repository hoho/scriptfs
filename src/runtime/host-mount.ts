import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command-runner.js";

export interface MountedShare {
  mountPoint: string;
  unmount(): Promise<void>;
}

export async function mountShare(
  host: string,
  port: number,
  share: string,
  mountPoint: string,
  credentialsPath?: string,
): Promise<MountedShare> {
  if (process.platform === "win32") {
    return mountWindows(host, port, share, mountPoint, credentialsPath);
  }

  await mkdir(mountPoint, { recursive: true });
  if (process.platform === "darwin") {
    const remote = `//guest:@${host}:${String(port)}/${share}`;
    await runCommand("/sbin/mount_smbfs", [
      "-N",
      "-o",
      "nomdatacache,nodatacache",
      remote,
      mountPoint,
    ]);
    return {
      mountPoint,
      unmount: async () => {
        await runCommand("/sbin/umount", [mountPoint]);
      },
    };
  }

  const remote = `//${host}/${share}`;
  await runCommand("mount", [
    "-t",
    "cifs",
    remote,
    mountPoint,
    "-o",
    `guest,port=${String(port)},vers=3.0`,
  ]);
  return {
    mountPoint,
    unmount: async () => {
      await runCommand("umount", [mountPoint]);
    },
  };
}

async function mountWindows(
  host: string,
  port: number,
  share: string,
  mountPoint: string,
  credentialsPath: string | undefined,
): Promise<MountedShare> {
  if (!/^[a-zA-Z]:$/.test(mountPoint)) {
    throw new Error(
      `Windows mount points must currently be drive letters such as "S:", received ${mountPoint}`,
    );
  }
  const drive = mountPoint.toUpperCase();
  const remote = `\\\\${host}\\${share}`;
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$mapping = @{",
    `LocalPath = ${quote(drive)}`,
    `RemotePath = ${quote(remote)}`,
    "Persistent = $false",
    "}",
    ...(credentialsPath
      ? [
          `$credentials = Get-Content -LiteralPath ${quote(credentialsPath)} -Raw | ConvertFrom-Json`,
          "$mapping.UserName = $credentials.username",
          "$mapping.Password = $credentials.password",
        ]
      : ["$mapping.UserName = 'guest'", "$mapping.Password = ''"]),
    ...(port === 445
      ? []
      : [
          "if (-not (Get-Command New-SmbMapping).Parameters.ContainsKey('TcpPort')) {",
          "throw 'Alternative SMB ports require Windows 11 24H2 or Windows Server 2025 or later. Older clients require smbPort: 445 on a dedicated SMB host.'",
          "}",
          `$mapping.TcpPort = ${String(port)}`,
        ]),
    "New-SmbMapping @mapping | Out-Null",
  ].join("\n");
  await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  return {
    mountPoint: drive,
    unmount: async () => {
      await runCommand("net", ["use", drive, "/delete", "/yes"]);
    },
  };
}

export function validateMountPoints(mountPoints: readonly string[]): void {
  const normalized = mountPoints.map((mountPoint) =>
    process.platform === "win32"
      ? mountPoint.toUpperCase()
      : path.resolve(mountPoint),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Each filesystem must use a unique mountPoint");
  }
}
