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
): Promise<MountedShare> {
  if (process.platform === "win32") {
    return mountWindows(host, port, share, mountPoint);
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
): Promise<MountedShare> {
  if (!/^[a-zA-Z]:$/.test(mountPoint)) {
    throw new Error(
      `Windows mount points must currently be drive letters such as "S:", received ${mountPoint}`,
    );
  }
  if (port !== 445) {
    throw new Error(
      "Windows SMB clients require scriptfs.container.smbPort to be 445",
    );
  }

  const drive = mountPoint.toUpperCase();
  const remote = `\\\\${host}\\${share}`;
  await runCommand("net", [
    "use",
    drive,
    remote,
    "",
    "/user:guest",
    "/persistent:no",
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
