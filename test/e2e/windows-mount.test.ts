import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/native-config.js";
import { runCommand } from "../helpers/command.js";
import { ScriptFsStartupError, startScriptFs } from "../../src/session.js";
import type { ScriptFsSession } from "../../src/types.js";

describe.skipIf(process.platform !== "win32")(
  "Windows FUSE and SMB integration",
  () => {
    let root: string | undefined;
    let session: ScriptFsSession | undefined;
    const mount = "U:";
    const readonlyMount = "V:";

    afterEach(async () => {
      if (session) {
        await session.stop();
        session = undefined;
      }
      if (root) {
        await rm(root, { recursive: true, force: true });
        root = undefined;
      }
    }, 90_000);

    it("checks CLI readiness, mounts authenticated shares, and cleans up after real I/O", async () => {
      const readiness = await runCommand(process.execPath, [
        path.resolve("dist", "cli.js"),
        "--check",
      ]);
      expect(readiness.stdout).toContain("Linux runtime is ready");
      for (const drive of [mount, readonlyMount]) {
        await expect(access(`${drive}\\`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }

      root = await mkdtemp(path.join(tmpdir(), "scriptfs-windows-e2e-"));
      const source = path.join(root, "source");
      const skillDirectory = path.join(source, ".github", "skills", "demo");
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(path.join(source, "plain.txt"), "source contents");
      await writeFile(
        path.join(source, "AGENTS.md"),
        "repository instructions",
      );
      await writeFile(path.join(source, ".mcp.json"), '{"mcpServers":{}}');
      await writeFile(
        path.join(skillDirectory, "SKILL.md"),
        "repository skill",
      );
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      await writeFile(
        path.join(root, "scriptfs.module.json"),
        JSON.stringify({ name: "generated", entry: "./index.mjs" }),
      );
      await writeFile(
        path.join(root, "index.mjs"),
        `export default {
  getattr() { return { kind: "file", size: 17 }; },
  readFile() { return "generated overlay"; }
};
`,
      );
      const rules = [
        { match: "**/AGENTS.md", hide: true },
        { match: ".mcp.json", hide: true },
        { match: ".github/skills{,/**}", hide: true },
        { match: "generated.txt", provider: { module: "generated" } },
      ];
      const configPath = path.join(root, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          modules: { generated: { manifest: "." } },
          filesystems: [
            { name: "windows", source, mountPoint: mount, rules },
            {
              name: "readonly",
              source,
              mountPoint: readonlyMount,
              rules,
              readOnly: true,
            },
          ],
          container: {
            // Keep test credentials separate from an existing 127.0.0.1 mount.
            smbHost: "localhost",
            rebuild: process.env.SCRIPTFS_E2E_REBUILD === "1",
            logLevel: "silent",
          },
        }),
      );
      try {
        session = await startScriptFs(await loadConfig(configPath));
      } catch (error) {
        if (error instanceof ScriptFsStartupError) session = error.session;
        throw error;
      }
      const containerId = session.containerId;
      expect([...session.mounts.values()]).toEqual([mount, readonlyMount]);
      const mounted = (relative: string): string =>
        path.join(`${mount}\\`, relative);
      await expect(readFile(mounted("plain.txt"), "utf8")).resolves.toBe(
        "source contents",
      );
      await expect(readFile(mounted("generated.txt"), "utf8")).resolves.toBe(
        "generated overlay",
      );
      const entries = await readdir(`${mount}\\`);
      expect(entries).toContain("generated.txt");
      expect(entries).not.toContain("AGENTS.md");
      expect(entries).not.toContain(".mcp.json");
      expect(await readdir(mounted(".github"))).not.toContain("skills");
      for (const relative of [
        "AGENTS.md",
        ".mcp.json",
        ".github\\skills\\demo\\SKILL.md",
      ]) {
        await expect(readFile(mounted(relative))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          access(path.join(source, relative)),
        ).resolves.toBeUndefined();
      }

      await mkdir(mounted("created"));
      await writeFile(mounted("created\\file.txt"), "created through SMB");
      await expect(
        readFile(path.join(source, "created", "file.txt"), "utf8"),
      ).resolves.toBe("created through SMB");
      await rename(
        mounted("created\\file.txt"),
        mounted("created\\renamed.txt"),
      );
      await writeFile(mounted("created\\renamed.txt"), "updated through SMB");
      await expect(
        readFile(path.join(source, "created", "renamed.txt"), "utf8"),
      ).resolves.toBe("updated through SMB");
      await rm(mounted("created\\renamed.txt"));
      await rm(mounted("created"), { recursive: true });
      await expect(access(path.join(source, "created"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        writeFile(
          path.join(`${readonlyMount}\\`, "plain.txt"),
          "must not be written",
        ),
      ).rejects.toHaveProperty(
        "code",
        expect.stringMatching(/^(EACCES|EPERM)$/),
      );
      await expect(
        readFile(path.join(source, "plain.txt"), "utf8"),
      ).resolves.toBe("source contents");

      await session.stop();
      session = undefined;
      for (const drive of [mount, readonlyMount]) {
        await expect(access(`${drive}\\`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(
        runCommand("podman", ["inspect", containerId]),
      ).rejects.toThrow();
    }, 240_000);
  },
);
