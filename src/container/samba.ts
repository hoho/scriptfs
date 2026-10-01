import type { ScriptFsConfig } from "../types.js";
import { runCommand } from "../runtime/command-runner.js";

export interface SmbCredentials {
  username: string;
  password: string;
}

export async function configureSmbCredentials(
  credentials: SmbCredentials,
  configPath: string,
): Promise<void> {
  if (
    credentials.username !== "scriptfs" ||
    !/^[a-f0-9]{64}$/.test(credentials.password)
  ) {
    throw new Error("Invalid generated ScriptFS SMB credentials");
  }
  await runCommand("useradd", [
    "--no-create-home",
    "--shell",
    "/usr/sbin/nologin",
    credentials.username,
  ]);
  await runCommand(
    "smbpasswd",
    ["-s", "-a", "-c", configPath, credentials.username],
    { input: `${credentials.password}\n${credentials.password}\n` },
  );
}

export function createSmbConfig(
  runtimeConfig: ScriptFsConfig,
  authenticated: boolean,
): string {
  const shares = runtimeConfig.filesystems
    .map(
      (filesystem) => `
[${filesystem.name}]
path = ${filesystem.mountPoint}
browseable = yes
guest ok = ${authenticated ? "no" : "yes"}
${authenticated ? "valid users = scriptfs\n" : ""}read only = ${filesystem.readOnly ? "yes" : "no"}
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
map to guest = ${authenticated ? "Never" : "Bad User"}
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
