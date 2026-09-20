import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createProviderLoader } from "../overlay/provider-loader.js";
import { OverlayFileSystem } from "../overlay/filesystem.js";
import type { ScriptFsConfig } from "../types.js";
import { createFuseMount } from "./fuse-adapter.js";
import { loadFuse, type FuseInstance } from "./fuse-binding.js";
import { terminateChild, unmountFuse, waitForTcpServer } from "./lifecycle.js";

// FUSE has already applied the caller's umask to creation modes.
process.umask(0);

const config = JSON.parse(
  await readFile("/scriptfs/config.json", "utf8"),
) as ScriptFsConfig;
const Fuse = await loadFuse();
const loadProvider = createProviderLoader();
const mounts: FuseInstance[] = [];
const shutdownController = new AbortController();

for (const filesystemConfig of config.filesystems) {
  await mkdir(filesystemConfig.mountPoint, { recursive: true, mode: 0o755 });
  const filesystem = new OverlayFileSystem(
    filesystemConfig,
    loadProvider,
    shutdownController.signal,
  );
  const mount = createFuseMount(
    Fuse,
    filesystemConfig.mountPoint,
    filesystem,
    config.container?.logLevel === "debug",
  );
  await mountFuse(mount);
  mounts.push(mount);
}

const smbConfigPath = "/tmp/scriptfs-smb.conf";
await writeFile(smbConfigPath, createSmbConfig(config), { mode: 0o644 });
const samba = spawn(
  "smbd",
  ["--foreground", "--no-process-group", "--configfile", smbConfigPath],
  { stdio: "inherit" },
);
let shutdownPromise: Promise<void> | undefined;
samba.on("error", (error) => {
  console.error(error);
  void shutdown(1);
});
samba.on("exit", (code) => void shutdown(code ?? 1));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

try {
  await waitForTcpServer(445, {
    signal: shutdownController.signal,
    isAlive: () => samba.exitCode === null && samba.signalCode === null,
  });
  await writeFile("/tmp/scriptfs-ready", "ready\n", { mode: 0o644 });
  console.log("SCRIPTFS_READY");
} catch (error) {
  console.error(error);
  await shutdown(1);
}

function shutdown(exitCode: number): Promise<void> {
  shutdownPromise ??= (async () => {
    const errors: unknown[] = [];
    shutdownController.abort();
    try {
      await terminateChild(samba);
    } catch (error) {
      errors.push(error);
    }
    for (const mount of [...mounts].reverse()) {
      try {
        await unmountFuse(mount);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      console.error(
        new AggregateError(
          errors,
          "ScriptFS container shutdown was incomplete",
        ),
      );
      process.exitCode = 1;
    } else {
      process.exitCode = exitCode;
    }
  })();
  return shutdownPromise;
}

function mountFuse(mount: FuseInstance): Promise<void> {
  return new Promise((resolve, reject) => {
    mount.mount((error) => (error ? reject(error) : resolve()));
  });
}

function createSmbConfig(runtimeConfig: ScriptFsConfig): string {
  const shares = runtimeConfig.filesystems
    .map(
      (filesystem) => `
[${filesystem.name}]
path = ${filesystem.mountPoint}
browseable = yes
guest ok = yes
read only = ${filesystem.readOnly ? "yes" : "no"}
force user = root
create mask = 0666
force create mode = 0000
veto files = /._*/.DS_Store/
delete veto files = yes
`,
    )
    .join("\n");

  return `[global]
server role = standalone server
security = user
map to guest = Bad User
guest account = nobody
server min protocol = SMB2
smb ports = 445
load printers = no
printing = bsd
disable spoolss = yes
stat cache = no
getwd cache = no
smb2 leases = no
oplocks = no
level2 oplocks = no
kernel change notify = no
change notify = no
directory name cache size = 0
${shares}`;
}
