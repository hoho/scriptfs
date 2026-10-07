import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { startScriptFs, ScriptFsStartupError } from "../../src/session.js";
import { loadConfig } from "../../src/native-config.js";
import { runCommand } from "../helpers/command.js";
import type { ScriptFsConfig, ScriptFsSession } from "../../src/types.js";

let root: string;
let source: string;
let mount: string;
let session: ScriptFsSession | undefined;
let config: ScriptFsConfig;
const controller = new AbortController();

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-regression-e2e-"));
  source = path.join(root, "source");
  mount = path.join(root, "mount");
  const provider = path.join(root, "app", "node_modules", "provider");
  // Bundled dependencies live inside the module package's own node_modules.
  const dependency = path.join(provider, "node_modules", "helper");
  await mkdir(provider, { recursive: true });
  await mkdir(dependency, { recursive: true });
  await mkdir(path.join(source, "Generated"), { recursive: true });
  await mkdir(path.join(source, "directory"));
  await mkdir(path.join(source, "before"));
  await mkdir(path.join(source, "Existing"));
  await mkdir(path.join(source, "MetadataDirectory"));
  await mkdir(path.join(source, "RetainedWhole"));
  await mkdir(path.join(source, "IdentityWhole"));
  await mkdir(path.join(source, "IdentityPosition"));
  await mkdir(path.join(source, "PathMetadata"));
  await mkdir(path.join(source, "ClosedOwner"));
  await writeFile(path.join(source, "ClosedOwner", "native"), "native");
  await mkdir(path.join(source, "RetainedPosition"));
  await mkdir(path.join(source, "SameBacking"));
  await mkdir(path.join(source, "ModuleShadow", "directory"), {
    recursive: true,
  });
  await writeFile(path.join(source, "ModuleShadow", "file"), "SOURCE");
  await symlink("source-target", path.join(source, "ModuleShadow", "link"));
  await mkdir(path.join(source, "Additive", "native"), { recursive: true });
  await writeFile(path.join(source, "Additive", "source.txt"), "SOURCE");
  await writeFile(path.join(source, "MetadataDirectory", "native"), "native");
  await writeFile(path.join(source, "metadata-native"), "native");
  await writeFile(path.join(source, "metadata-mutable"), "ORIGINAL");
  await writeFile(path.join(source, "Existing", "original"), "source");
  await writeFile(path.join(source, "data"), "abcdef");
  await writeFile(path.join(source, "mixed-writeonly"), "abcdef");
  await writeFile(path.join(source, "no-op-whole"), "");
  await writeFile(path.join(source, "native-target"), "ORIGINAL");
  await writeFile(path.join(source, "hook-open"), "0000");
  await writeFile(path.join(source, "hook-open-broken"), "");
  await writeFile(path.join(source, "masked-source"), "not listed");
  await mkdir(path.join(source, "Merged"));
  await mkdir(path.join(root, "merged-proxy"));
  await writeFile(path.join(source, "Merged", "source-only"), "SOURCE");
  await writeFile(path.join(source, "Merged", "overlap"), "SOURCE overlap");
  await writeFile(path.join(root, "merged-proxy", "proxy-only"), "PROXY");
  await writeFile(path.join(root, "merged-proxy", "overlap"), "PROXY overlap");
  await writeFile(path.join(source, "directory", "data"), "0000");
  await writeFile(path.join(source, "Generated", "source-only"), "not listed");
  await symlink("directory", path.join(source, "directory-link"));
  await writeFile(path.join(root, "proxy-target"), "old");
  await writeFile(path.join(root, "proxy-guard"), "original");
  await writeFile(path.join(root, "app", "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(provider, "package.json"),
    '{"name":"provider","type":"module","exports":{".":{"import":"./index.mjs"}}}',
  );
  await writeFile(
    path.join(dependency, "package.json"),
    '{"name":"helper","type":"module","main":"index.mjs"}',
  );
  await writeFile(
    path.join(dependency, "index.mjs"),
    'export const value = "dependency works";',
  );
  await writeFile(path.join(provider, "index.mjs"), providerSource());
  config = {
    filesystems: [
      {
        name: "regression",
        source,
        mountPoint: mount,
        rules: [
          { match: "dependency", provider: { module: "provider" } },
          {
            match: "ContentOnly/**",
            provider: { module: "contentOnly" },
          },
          {
            match: "ContentOnly/defaults",
            file: { size: 18, mode: 0o600 },
            provider: { module: "contentOnly" },
          },
          {
            match: "ContentOnly/resource",
            provider: { module: "contentOnlyResource" },
          },
          ...["literal+name.txt", "literal@name.txt", "literal!name.txt"].map(
            (match) => ({
              match,
              provider: { module: "provider" },
            }),
          ),
          {
            match: "C++/*.txt",
            opaque: true,
            provider: { module: "inferred" },
          },
          {
            match: "Ownership/**",
            root: "Ownership",
            opaque: true,
            provider: { module: "partialOwnership" },
          },
          {
            match: "ModuleShadow/**",
            root: "ModuleShadow",
            provider: { module: "moduleShadow" },
          },
          {
            match: "Additive/**",
            root: "Additive",
            provider: { module: "additiveTree" },
          },
          {
            match: "Additive/provider-created.txt",
            provider: { module: "additiveTree" },
          },
          {
            match: "ShortReads*",
            opaque: true,
            provider: { module: "shortReads" },
          },
          {
            match: "CreateFlags/**",
            root: "CreateFlags",
            opaque: true,
            provider: { module: "createFlags" },
          },
          {
            match: "Layered/**",
            root: "Layered",
            opaque: true,
            provider: { module: "layeredBase" },
          },
          {
            match: "Layered/*.json",
            provider: { module: "layeredExtra" },
          },
          { match: "Layered/hidden.json", hide: true },
          {
            match: "Layered/masked.json",
            opaque: true,
            provider: { module: "additive" },
          },
          {
            match: "IdentityFirst",
            opaque: true,
            provider: { module: "localIdentity", options: "FIRST" },
          },
          {
            match: "IdentitySecond",
            opaque: true,
            provider: { module: "localIdentity", options: "SECOND" },
          },
          {
            match: "superseded-unavailable",
            provider: { module: "unavailable" },
          },
          { match: "superseded-unavailable", provider: { module: "provider" } },
          {
            match: "hidden-unavailable",
            provider: { module: "unavailable" },
          },
          { match: "hidden-unavailable", hide: true },
          {
            match: "metadata-native",
            provider: { module: "metadataFile" },
          },
          {
            match: "metadata-mutable",
            provider: { module: "mutableMetadataFile" },
          },
          {
            match: "ClosedDestinationAfter/**/*.txt",
            provider: { module: "provider" },
          },
          {
            match: "MetadataDirectory/**",
            root: "MetadataDirectory",
            provider: { module: "metadataDirectory" },
          },
          {
            match: "RetainedWhole/**",
            root: "RetainedWhole",
            provider: { module: "retainedWhole" },
          },
          {
            match: "IdentityWhole/**",
            root: "IdentityWhole",
            opaque: true,
            provider: { module: "identityWhole" },
          },
          {
            match: "IdentityPosition/**",
            root: "IdentityPosition",
            opaque: true,
            provider: { module: "identityPosition" },
          },
          {
            match: "PathMetadata/**",
            root: "PathMetadata",
            provider: { module: "pathMetadata" },
          },
          {
            match: "TruncateRace",
            provider: { module: "replaceDuringOpen" },
          },
          {
            match: "retained-final",
            provider: { module: "finalRelease" },
          },
          {
            match: "ShortSnapshot",
            opaque: true,
            provider: { module: "shortSnapshot" },
          },
          {
            match: "ClosedOwner/generated.txt",
            provider: { module: "provider" },
          },
          {
            match: "RetainedPosition/**",
            root: "RetainedPosition",
            provider: { module: "retainedPosition" },
          },
          { match: "retained-after/*.txt", hide: true },
          { match: "Merged/retained-after/*.txt", hide: true },
          { match: "RetainedWhole/retained-after/*.txt", hide: true },
          { match: "RetainedPosition/retained-after/*.txt", hide: true },
          {
            match: "MutableListing/**",
            root: "MutableListing",
            opaque: true,
            provider: { module: "mutableListing" },
          },
          {
            match: "CapturedSize",
            opaque: true,
            provider: { module: "capturedSize" },
          },
          {
            match: "CapturedAttributes",
            opaque: true,
            provider: { module: "capturedAttributes" },
          },
          {
            match: "RetainedDirectories/**",
            root: "RetainedDirectories",
            opaque: true,
            provider: { module: "retainedDirectories" },
          },
          {
            match: "WriteOnlyMixed",
            opaque: true,
            provider: { module: "writeOnlyMixed" },
          },
          {
            match: "WriteOnly",
            opaque: true,
            provider: { module: "writeOnly" },
          },
          {
            match: "SequentialSink",
            opaque: true,
            file: { seekable: false },
            provider: { module: "writeOnly" },
          },
          {
            match: "UnsupportedSync",
            provider: { module: "unsupportedSync" },
          },
          {
            match: "WholeFiles/**",
            root: "WholeFiles",
            opaque: true,
            provider: { module: "wholeFiles" },
          },
          {
            match: "Sequential/**",
            root: "Sequential",
            opaque: true,
            provider: { module: "sequential" },
          },
          {
            match: "whole",
            provider: { module: "whole" },
            opaque: true,
          },
          {
            match: "mixed",
            provider: { module: "mixed" },
            opaque: true,
          },
          {
            match: "MixedWriter*",
            provider: { module: "mixedWriter" },
            opaque: true,
          },
          {
            match: "no-op-whole",
            provider: { module: "backedWhole" },
            opaque: true,
          },
          {
            match: "Inferred/*.txt",
            provider: { module: "inferred" },
            opaque: true,
          },
          {
            match: "MutableLink",
            provider: { module: "mutableLink" },
            opaque: true,
          },
          {
            match: "ChangeLink",
            provider: { module: "changeLink" },
            opaque: true,
          },
          {
            match: "timestamps",
            provider: { module: "timestamps" },
            opaque: true,
          },
          { match: "hook-open", provider: { module: "openHook" } },
          {
            match: "hook-open-broken",
            provider: { module: "brokenOpen" },
          },
          { match: "hook-created", provider: { module: "createHook" } },
          { match: "hook-broken", provider: { module: "brokenHook" } },
          {
            match: "ReplacedCreate",
            provider: { module: "replacedCreate" },
          },
          {
            match: "Merged/**",
            root: "Merged",
            provider: {
              type: "directory",
              path: path.join(root, "merged-proxy"),
            },
          },
          {
            match: "Masked/**",
            root: "Masked",
            opaque: true,
            provider: { module: "tree" },
          },
          {
            match: "SameBacking/**",
            root: "SameBacking",
            provider: {
              type: "directory",
              path: path.join(source, "SameBacking"),
            },
          },
          {
            match: "Masked/visible",
            opaque: true,
            provider: { module: "additive" },
          },
          {
            match: "masked-source",
            opaque: true,
            provider: { module: "additive" },
          },
          { match: "Diagnostics", provider: { module: "diagnostics" } },
          {
            match: "SlowOpen",
            opaque: true,
            provider: { module: "slowOpen" },
          },
          {
            match: "shutdown-signal",
            provider: { module: "shutdownSignal" },
          },
          {
            match: "BrokenCreate",
            opaque: true,
            provider: { module: "brokenCreate" },
          },
          {
            match: "Native",
            opaque: true,
            provider: { module: "nativeProvider" },
          },
          {
            match: "Shadow/Nested/**",
            root: "Shadow/Nested",
            opaque: true,
            provider: { module: "tree" },
          },
          {
            match: "Shadow/**",
            root: "Shadow",
            opaque: true,
            provider: { module: "emptyTree" },
          },
          { match: "before/*.txt", provider: { module: "provider" } },
          { match: "after/*.txt", provider: { module: "provider" } },
          {
            match: "Position/**",
            root: "Position",
            opaque: true,
            provider: { module: "positional" },
          },
          {
            match: "Nested/Deep/**",
            root: "Nested/Deep",
            opaque: true,
            provider: { module: "tree" },
          },
          {
            match: "Existing/Generated/**",
            root: "Existing/Generated",
            opaque: true,
            provider: { module: "tree" },
          },
          { match: "slow", opaque: true, provider: { module: "slow" } },
          { match: "*.generated", provider: { module: "additive" } },
          {
            match: "Generated/**",
            root: "Generated",
            opaque: true,
            provider: { module: "tree" },
          },
          { match: "Hidden", provider: { module: "provider" } },
          {
            match: "HiddenRoot/**",
            root: "HiddenRoot",
            opaque: true,
            provider: { module: "tree" },
          },
          { match: "Hidden", hide: true },
          { match: "HiddenRoot", hide: true },
          {
            match: "Proxy",
            provider: { type: "file", path: path.join(root, "proxy-target") },
          },
          {
            match: "ProxyGuard",
            provider: { type: "file", path: path.join(root, "proxy-guard") },
          },
        ],
      },
    ],
    container: {
      image: process.env.SCRIPTFS_E2E_RUNTIME_IMAGE,
      rebuild: process.env.SCRIPTFS_E2E_REBUILD === "1",
      logLevel: process.env.SCRIPTFS_E2E_DEBUG ? "debug" : "silent",
    },
  };
  config.modules = await moduleInstances(provider, config);
  const configPath = path.join(root, "app", "scriptfs.json");
  await writeFile(configPath, JSON.stringify(config));
  config = await loadConfig(configPath);
  session = await startScriptFs(config, { signal: controller.signal });
}, 180_000);

afterAll(async () => {
  if (session) await session.stop();
  if (root) {
    const mounts = await runCommand("mount", []);
    if (mounts.stdout.includes(root))
      throw new Error("Regression mount is still active; refusing cleanup");
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

afterEach(async ({ task }) => {
  if (task.result?.state === "fail" && session) {
    const logs = await runCommand("podman", ["logs", session.containerId], {
      allowFailure: true,
    });
    console.error(logs.stdout.split("\n").slice(-50).join("\n"));
    console.error(logs.stderr.split("\n").slice(-50).join("\n"));
  }
});

async function inFuse(script: string): Promise<void> {
  if (!session) throw new Error("Missing session");
  await runCommand("podman", [
    "exec",
    session.containerId,
    "node",
    "-e",
    `
    const fs = require("node:fs");
    const assert = require("node:assert/strict");
    const base = "/scriptfs/overlays/0";
    const source = "/scriptfs/sources/0";
    (async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
  ]);
}

async function inFusePython(script: string): Promise<void> {
  if (!session) throw new Error("Missing session");
  await runCommand("podman", [
    "exec",
    session.containerId,
    "python3",
    "-c",
    `import os, errno, json
base = "/scriptfs/overlays/0"
source = "/scriptfs/sources/0"
${script}`,
  ]);
}

it("uses per-container AppArmor settings without privileged mode", async () => {
  if (!session) throw new Error("Missing session");
  const inspected = await runCommand("podman", [
    "inspect",
    "--format",
    "{{.HostConfig.Privileged}} {{json .HostConfig.SecurityOpt}}",
    session.containerId,
  ]);
  expect(inspected.stdout).toMatch(/^false /);
  expect(inspected.stdout).toContain("apparmor=unconfined");
});

it("enumerates literal punctuation and infers generated roots through FUSE and SMB", async () => {
  const names = ["literal+name.txt", "literal@name.txt", "literal!name.txt"];
  await inFuse(`
    const names=${JSON.stringify(names)};
    const listed=fs.readdirSync(base);
    for(const name of names) {
      assert(listed.includes(name),name);
      assert.equal(fs.readFileSync(base+"/"+name,"utf8"),"dependency works");
    }
    assert(listed.includes("C++"));
    assert.deepEqual(fs.readdirSync(base+"/C++"),["data.txt"]);
    assert.equal(fs.readFileSync(base+"/C++/data.txt","utf8"),"inferred");
  `);
  const listed = await readdir(mount);
  for (const name of names) {
    expect(listed).toContain(name);
    expect(await readFile(path.join(mount, name), "utf8")).toBe(
      "dependency works",
    );
  }
  expect(await readFile(path.join(mount, "C++", "data.txt"), "utf8")).toBe(
    "inferred",
  );
});

it("reads complete content-only overlays through FUSE and SMB regardless of source size", async () => {
  await mkdir(path.join(source, "ContentOnly"));
  const cases: [string, string][] = [
    ["empty", ""],
    ["short", "x"],
    ["long", "source contents longer than the generated contents"],
    ["defaults", "x"],
    ["resource", "x"],
  ];
  for (const [name, contents] of cases) {
    await writeFile(path.join(source, "ContentOnly", name), contents);
  }
  await inFuse(`
    for (const name of ${JSON.stringify(cases.map(([name]) => name))}) {
      const target=base+"/ContentOnly/"+name;
      assert.equal(fs.statSync(target).size,18);
      const fd=fs.openSync(target,"r");
      try {
        assert.equal(fs.fstatSync(fd).size,18);
        assert.equal(fs.readFileSync(fd,"utf8"),"GENERATED-CONTENTS");
        if(name==="defaults")assert.equal(fs.fstatSync(fd).mode&0o777,0o600);
      } finally { fs.closeSync(fd); }
    }
  `);
  for (const [name] of cases) {
    const target = path.join(mount, "ContentOnly", name);
    expect((await stat(target)).size).toBe(18);
    expect(await readFile(target, "utf8")).toBe("GENERATED-CONTENTS");
  }
});

it("preserves omitted ownership fields for generated files, directories and symlinks", async () => {
  await inFusePython(`
for name in ["file", "directory", "link"]:
    target = base + "/Ownership/" + name
    for uid, gid, expected in [
        (123, -1, (123, 222)),
        (-1, 456, (123, 456)),
        (-1, -1, (123, 456)),
        (0, 0, (0, 0)),
    ]:
        os.lchown(target, uid, gid)
        actual = os.lstat(target)
        assert (actual.st_uid, actual.st_gid) == expected, (name, actual, expected)
`);
});

it("rejects module shadow removal without changing either backing", async () => {
  await inFuse(`
    const directory=base+"/ModuleShadow";
    const backing=source+"/ModuleShadow";
    const unsupported=error=>["ENOTSUP","EOPNOTSUPP"].includes(error.code);
    const original=fs.openSync(directory+"/file","r");
    try {
      for(const name of ["file","link"]) {
        assert.throws(()=>fs.unlinkSync(directory+"/"+name),unsupported);
        assert.throws(()=>fs.renameSync(directory+"/"+name,directory+"/moved-"+name),{code:"EXDEV"});
        assert(!fs.existsSync(directory+"/moved-"+name));
      }
      assert.throws(()=>fs.rmdirSync(directory+"/directory"),unsupported);
      assert.throws(()=>fs.renameSync(directory+"/directory",directory+"/moved-directory"),{code:"EXDEV"});
      assert.throws(()=>fs.renameSync(directory+"/replacement-directory",directory+"/directory"),{code:"EXDEV"});
      assert.equal(fs.readFileSync(original,"utf8"),"GENERATED");
      assert.equal(fs.readFileSync(directory+"/file","utf8"),"GENERATED");
      assert.equal(fs.readFileSync(backing+"/file","utf8"),"SOURCE");
      assert.equal(fs.readlinkSync(directory+"/link"),"file");
      assert.equal(fs.readlinkSync(backing+"/link"),"source-target");
      assert(fs.statSync(backing+"/directory").isDirectory());
    } finally { fs.closeSync(original); }
    fs.writeFileSync(directory+"/file","UPDATED");
    assert.equal(fs.readFileSync(directory+"/file","utf8"),"UPDATED");
    assert.equal(fs.readFileSync(backing+"/file","utf8"),"SOURCE");
    fs.renameSync(directory+"/file",directory+"/alias");
    assert.equal(fs.readFileSync(directory+"/file","utf8"),"UPDATED");
    fs.renameSync(directory+"/replacement",directory+"/file");
    assert.equal(fs.readFileSync(directory+"/file","utf8"),"NEW");
    assert.equal(fs.readFileSync(backing+"/file","utf8"),"SOURCE");
    assert(!fs.existsSync(directory+"/replacement"));
    fs.unlinkSync(directory+"/alias");
    assert(!fs.existsSync(directory+"/alias"));
  `);
});

it("retains and releases provider resources when open exceeds the binding's former timeout", async () => {
  await inFuse(`
    const metrics=()=>JSON.parse(fs.readFileSync(base+"/Diagnostics","utf8"));
    const before=metrics().active;
    const started=Date.now();
    const fd=fs.openSync(base+"/SlowOpen","r");
    try {
      assert(Date.now()-started>=15000);
      assert.equal(metrics().active,before+1);
      assert.equal(fs.fstatSync(fd).size,0);
    } finally { fs.closeSync(fd); }
    const deadline=Date.now()+5000;
    while(metrics().active!==before&&Date.now()<deadline)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(metrics().active,before);
  `);
}, 30_000);

it("rejects unsupported backing nodes without blocking unrelated FUSE operations", async () => {
  await inFusePython(`
import shutil
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"]
             if rule.get("root") == "Merged")
for backing, mounted in [(source, base), (proxy, base + "/Merged")]:
    directory = backing + "/special-nodes"
    visible = mounted + "/special-nodes"
    os.mkdir(directory)
    try:
        with open(directory + "/regular", "w") as file:
            file.write("ordinary")
        os.mkfifo(directory + "/fifo")
        for operation in [lambda: os.stat(visible + "/fifo"),
                          lambda: os.open(visible + "/fifo", os.O_RDONLY)]:
            try:
                operation()
            except OSError as error:
                assert error.errno == errno.EOPNOTSUPP, error
            else:
                raise AssertionError("FIFO was exposed as a regular file")
        assert os.listdir(visible) == ["regular"]
        assert open(visible + "/regular").read() == "ordinary"
    finally:
        shutil.rmtree(directory)
`);
});

it("appends through a write-only mixed provider using temporary readable resources", async () => {
  await inFuse(`
    const fd=fs.openSync(base+"/WriteOnlyMixed",fs.constants.O_WRONLY|fs.constants.O_APPEND);
    try {
      assert.equal(fs.writeSync(fd,"X"),1);
      fs.fsyncSync(fd);
      assert.equal(fs.readFileSync(source+"/mixed-writeonly","utf8"),"abcdefX");
    } finally { fs.closeSync(fd); }
    let events=[];
    const deadline=Date.now()+5000;
    do {
      events=fs.readFileSync(source+"/mixed-open-events","utf8").trim().split("\\n").map(JSON.parse);
      if(events.filter(event=>event.operation==="open").length===
         events.filter(event=>event.operation==="release").length)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    } while(Date.now()<deadline);
    const opened=events.filter(event=>event.operation==="open");
    const released=events.filter(event=>event.operation==="release");
    assert.equal(opened[0].flags&3,1);
    assert(opened[0].flags&fs.constants.O_APPEND);
    assert(opened.length>=2);
    assert(opened.slice(1).every(event=>event.flags===0));
    assert.equal(opened.length,released.length);
  `);
});

it("keeps captured inode attributes coherent after closing a distinct provider handle", async () => {
  await inFuse(`
    const first=fs.openSync(base+"/CapturedAttributes","r+");
    const second=fs.openSync(base+"/CapturedAttributes","r+");
    try {
      assert.equal(fs.fstatSync(first).ino,fs.fstatSync(second).ino);
      fs.fchmodSync(second,0o600);
      fs.fchownSync(second,123,456);
      fs.futimesSync(second,new Date(100125),new Date(200750));
    } finally { fs.closeSync(second); }
    try {
      const retained=fs.fstatSync(first);
      assert.equal(retained.mode&0o777,0o600);
      assert.equal(retained.uid,123);
      assert.equal(retained.gid,456);
      assert.equal(retained.atimeMs,100125);
      assert.equal(retained.mtimeMs,200750);
    } finally { fs.closeSync(first); }
  `);
});

it("preserves open resource-less directories after removal and replacement", async () => {
  await inFuse(`
    const parent=base+"/RetainedDirectories";
    for(const operation of ["rmdir","replace"]) {
      const name=parent+"/"+operation;
      fs.mkdirSync(name,0o755);
      const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
      const original=fs.fstatSync(fd);
      try {
        if(operation==="rmdir") {
          fs.rmdirSync(name);
          assert.equal(fs.fstatSync(fd).nlink,0);
          fs.mkdirSync(name,0o700);
        } else {
          fs.mkdirSync(name+"-replacement",0o700);
          fs.renameSync(name+"-replacement",name);
        }
        const retained=fs.fstatSync(fd);
        assert.equal(retained.ino,original.ino);
        assert.equal(retained.mode&0o777,0o755);
        assert.equal(retained.nlink,0);
        const replacement=fs.statSync(name);
        assert.notEqual(replacement.ino,original.ino);
        assert.equal(replacement.mode&0o777,0o700);
      } finally { fs.closeSync(fd); fs.rmdirSync(name); }
    }
  `);
});

it("binds relative programmatic sources and proxies to host paths", async () => {
  const relativeRoot = await mkdtemp(path.join(root, "relative-runtime-"));
  const sourceName = path.basename(relativeRoot);
  await writeFile(path.join(relativeRoot, "expected"), "host source");
  const entry = pathToFileURL(path.resolve("dist/index.js")).href;
  try {
    await runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import {readFile} from "node:fs/promises";
      import path from "node:path";
      import {startScriptFs} from ${JSON.stringify(entry)};
      const session=await startScriptFs({
        filesystems:[{
          name:"relative",
          source:${JSON.stringify(sourceName)},
          mountPoint:"relative-mount",
          rules:[{
            match:"Proxy/**",root:"Proxy",opaque:true,
            provider:{type:"directory",path:${JSON.stringify(sourceName)}}
          }]
        }],
        container:{logLevel:"silent"}
      });
      try {
        const mount=session.mounts.get("relative");
        assert.equal(mount,path.resolve("relative-mount"));
        assert.equal(await readFile(path.join(mount,"expected"),"utf8"),"host source");
        assert.equal(await readFile(path.join(mount,"Proxy/expected"),"utf8"),"host source");
      } finally { await session.stop(); }
    `,
      ],
      { cwd: root },
    );
  } finally {
    const volumes = await runCommand("podman", [
      "volume",
      "ls",
      "--filter",
      `name=${sourceName}`,
      "--format",
      "{{.Name}}",
    ]);
    if (volumes.stdout.trim().split("\n").includes(sourceName))
      await runCommand("podman", ["volume", "rm", sourceName]);
  }
}, 60_000);

it("completes short positional reads through cached FUSE and propagates continuation errors", async () => {
  await inFusePython(`
fd = os.open(base + "/ShortReads", os.O_RDONLY)
try:
    assert os.read(fd, 1) == b"a"
    assert os.read(fd, 10) == b"bcdef"
    assert os.read(fd, 1) == b""
    assert os.pread(fd, 4, 2) == b"cdef"
    assert os.fstat(fd).st_size == 6
finally:
    os.close(fd)
with open(base + "/ShortReads", "rb") as file:
    assert file.read() == b"abcdef"
fd = os.open(base + "/ShortReadsError", os.O_RDONLY)
try:
    try:
        os.read(fd, 6)
        raise AssertionError("Continuation error was hidden")
    except OSError as error:
        assert error.errno == errno.EIO, error
finally:
    os.close(fd)
`);
});

it("preserves real create access modes and append/sync flags through the native bridge", async () => {
  await inFusePython(`
cases = [
    ("readonly", os.O_RDONLY),
    ("writeonly", os.O_WRONLY),
    ("readwrite", os.O_RDWR),
    ("append", os.O_WRONLY | os.O_APPEND),
    ("sync", os.O_WRONLY | os.O_SYNC),
]
for name, flags in cases:
    fd = os.open(base + "/CreateFlags/" + name, os.O_CREAT | os.O_EXCL | flags, 0o644)
    try:
        if flags & os.O_ACCMODE != os.O_RDONLY:
            assert os.write(fd, b"data") == 4
        if flags & os.O_ACCMODE != os.O_WRONLY:
            os.lseek(fd, 0, os.SEEK_SET)
            assert os.read(fd, 4) == (b"" if flags == os.O_RDONLY else b"data")
    finally:
        os.close(fd)
with open(source + "/create-flag-events") as file:
    observed = {event["name"]: event["flags"] for event in map(json.loads, file)}
for name, flags in cases:
    mask = os.O_ACCMODE | os.O_APPEND | os.O_SYNC
    assert observed[name] & mask == flags & mask, (name, flags, observed[name])
`);
});

it("discovers later wildcard entries inside an opaque provider directory through FUSE and SMB", async () => {
  await inFusePython(`
assert sorted(os.listdir(base + "/Layered")) == ["base.txt", "extra.json"]
with open(base + "/Layered/extra.json") as file:
    assert file.read() == "{}"
`);
  expect((await readdir(path.join(mount, "Layered"))).sort()).toEqual([
    "base.txt",
    "extra.json",
  ]);
  expect(
    await readFile(path.join(mount, "Layered", "extra.json"), "utf8"),
  ).toBe("{}");
});

it("preserves literal backslash names without modifying similarly named nested files", async () => {
  await inFusePython(String.raw`
import shutil
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"] if rule.get("root") == "Merged")
for backing, mounted in [(source, base), (proxy, base + "/Merged")]:
    directory = backing + "/literal-names"
    visible = mounted + "/literal-names"
    os.makedirs(directory + "/dir")
    try:
        with open(directory + "/dir/name", "w") as file:
            file.write("NESTED")
        with open(directory + "/" + r"dir\name", "w") as file:
            file.write("LITERAL")
        assert r"dir\name" in os.listdir(visible)
        with open(visible + "/" + r"dir\name", "r+") as file:
            assert file.read() == "LITERAL"
            file.seek(0)
            file.write("X")
        os.rename(visible + "/" + r"dir\name", visible + "/" + r"moved\name")
        with open(directory + "/" + r"moved\name") as file:
            assert file.read() == "XITERAL"
        os.unlink(visible + "/" + r"moved\name")
        with open(directory + "/dir/name") as file:
            assert file.read() == "NESTED"
        assert not os.path.exists(directory + "/" + r"dir\name")
    finally:
        shutil.rmtree(directory)
`);
});

it("opens metadata-only source overlays with consistent native identities through FUSE and SMB", async () => {
  expect(await readFile(path.join(mount, "metadata-native"), "utf8")).toBe(
    "native",
  );
  expect(await readdir(path.join(mount, "MetadataDirectory"))).toEqual([
    "native",
  ]);
  await inFuse(`
    const filePath=base+"/metadata-native";
    const directoryPath=base+"/MetadataDirectory";
    const fileInode=fs.statSync(filePath).ino;
    const directoryInode=fs.statSync(directoryPath).ino;
    assert.equal(fs.statSync(filePath).size,6);
    assert.equal(fs.statSync(filePath).mode & 0o777,0o600);
    assert.equal(fs.statSync(directoryPath).mode & 0o777,0o750);
    const file=fs.openSync(filePath,"r");
    const directory=fs.openSync(directoryPath,"r");
    try {
      fs.linkSync(source+"/metadata-native",source+"/metadata-alias");
      const alias=fs.openSync(base+"/metadata-alias","r");
      try {
        assert.notEqual(fs.fstatSync(alias).ino,fileInode);
        assert.equal(fs.fstatSync(alias).mode & 0o777,fs.statSync(source+"/metadata-alias").mode & 0o777);
        assert.equal(fs.fstatSync(file).mode & 0o777,0o600);
      } finally {
        fs.closeSync(alias);
        fs.unlinkSync(source+"/metadata-alias");
      }
      assert.equal(fs.fstatSync(file).ino,fileInode);
      assert.equal(fs.fstatSync(directory).ino,directoryInode);
      assert.equal(fs.fstatSync(file).mode & 0o777,0o600);
      assert.equal(fs.statSync(filePath).mode & 0o777,0o600);
      assert.equal(fs.fstatSync(directory).mode & 0o777,0o750);
      assert.equal(fs.statSync(directoryPath).mode & 0o777,0o750);
      fs.renameSync(source+"/metadata-native",source+"/metadata-retained");
      fs.writeFileSync(source+"/metadata-native","REPLACEMENT");
      fs.renameSync(source+"/MetadataDirectory",source+"/MetadataRetained");
      fs.mkdirSync(source+"/MetadataDirectory");
      assert.notEqual(fs.statSync(filePath).ino,fileInode);
      assert.notEqual(fs.statSync(directoryPath).ino,directoryInode);
      assert.equal(fs.fstatSync(file).ino,fileInode);
      assert.equal(fs.fstatSync(directory).ino,directoryInode);
      assert.equal(fs.fstatSync(file).mode & 0o777,0o600);
      assert.equal(fs.fstatSync(directory).mode & 0o777,0o750);
      const bytes=Buffer.alloc(6);
      assert.equal(fs.readSync(file,bytes,0,6,0),6);
      assert.equal(bytes.toString(),"native");
      assert.deepEqual(fs.readdirSync(directoryPath),[]);
    } finally {
      fs.closeSync(file);
      fs.closeSync(directory);
    }
  `);
});

it("updates captured native metadata without truncating reads after writes", async () => {
  await inFuse(`
    const filePath=base+"/metadata-mutable";
    const first=fs.openSync(filePath,"r+");
    const second=fs.openSync(filePath,"r+");
    try {
      const inode=fs.fstatSync(first).ino;
      fs.ftruncateSync(first,0);
      for(const fd of [first,second])assert.equal(fs.fstatSync(fd).size,0);
      fs.writeSync(second,"EXPANDED CONTENT",0);
      for(const fd of [first,second]){
        assert.equal(fs.fstatSync(fd).size,16);
        const bytes=Buffer.alloc(32);
        assert.equal(fs.readSync(fd,bytes,0,32,0),16);
        assert.equal(bytes.subarray(0,16).toString(),"EXPANDED CONTENT");
      }
      fs.truncateSync(filePath,4);
      fs.fchmodSync(second,0o600);
      fs.futimesSync(second,new Date(1000),new Date(2000));
      fs.renameSync(source+"/metadata-mutable",source+"/metadata-mutable-retained");
      fs.writeFileSync(source+"/metadata-mutable","NEW");
      assert.notEqual(fs.statSync(filePath).ino,inode);
      for(const fd of [first,second]){
        const attributes=fs.fstatSync(fd);
        assert.equal(attributes.ino,inode);
        assert.equal(attributes.size,4);
        assert.equal(attributes.mode & 0o7777,0o600);
        assert.equal(attributes.mtimeMs,2000);
        const bytes=Buffer.alloc(32);
        assert.equal(fs.readSync(fd,bytes,0,32,0),4);
        assert.equal(bytes.subarray(0,4).toString(),"EXPA");
      }
      fs.writeSync(second,"RETAINED CONTENT",0);
      for(const fd of [first,second])assert.equal(fs.fstatSync(fd).size,16);
      assert.equal(fs.readFileSync(source+"/metadata-mutable","utf8"),"NEW");
    } finally {
      fs.closeSync(first);
      fs.closeSync(second);
    }
  `);
});

it("rejects destination-provider redirection of closed descendants through FUSE and SMB", async () => {
  await mkdir(path.join(source, "ClosedDestinationBefore", "nested"), {
    recursive: true,
  });
  await writeFile(
    path.join(source, "ClosedDestinationBefore", "nested", "data.txt"),
    "ORIGINAL",
  );
  await inFuse(`
    assert.throws(()=>fs.renameSync(base+"/ClosedDestinationBefore",base+"/ClosedDestinationAfter"),{code:"EXDEV"});
    assert.equal(fs.readFileSync(base+"/ClosedDestinationBefore/nested/data.txt","utf8"),"ORIGINAL");
    assert.equal(fs.existsSync(source+"/ClosedDestinationAfter"),false);
  `);
  await expect(
    rename(
      path.join(mount, "ClosedDestinationBefore"),
      path.join(mount, "ClosedDestinationAfter"),
    ),
  ).rejects.toThrow();
  expect(
    await readFile(
      path.join(source, "ClosedDestinationBefore", "nested", "data.txt"),
      "utf8",
    ),
  ).toBe("ORIGINAL");
  await expect(
    stat(path.join(source, "ClosedDestinationAfter")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not alias matching resource identifiers from different provider rules", async () => {
  await inFuse(`
    const first=fs.openSync(base+"/IdentityFirst","r");
    const second=fs.openSync(base+"/IdentitySecond","r");
    try {
      assert.notEqual(fs.fstatSync(first).ino,fs.fstatSync(second).ino);
      assert.equal(fs.readFileSync(first,"utf8"),"FIRST");
      assert.equal(fs.readFileSync(second,"utf8"),"SECOND");
    } finally {
      fs.closeSync(first);
      fs.closeSync(second);
    }
  `);
});

it("shares hard-link inode caches through writes, truncation, rename and replacement", async () => {
  await inFuse(`
    const runtime=JSON.parse(fs.readFileSync("/scriptfs/config.json","utf8"));
    const proxy=runtime.filesystems[0].rules.find(rule=>rule.root==="Merged").provider.path;
    for (const [backing,visible] of [[source,base],[proxy,base+"/Merged"]]) {
      const original=backing+"/hard-a";
      fs.writeFileSync(original,"ORIGINAL");
      fs.linkSync(original,backing+"/hard-b");
      const a=fs.openSync(visible+"/hard-a","r+");
      const b=fs.openSync(visible+"/hard-b","r+");
      const read=(fd,length)=>{const bytes=Buffer.alloc(length);return bytes.subarray(0,fs.readSync(fd,bytes,0,length,0)).toString();};
      try {
        const inode=fs.fstatSync(a).ino;
        assert.equal(fs.fstatSync(b).ino,inode);
        assert.equal(fs.fstatSync(a).nlink,2);
        assert.equal(read(a,8),"ORIGINAL");
        fs.writeSync(b,"CHANGED!",0);
        assert.equal(read(a,8),"CHANGED!");
        fs.fsyncSync(b);
        assert.equal(read(a,8),"CHANGED!");
        fs.ftruncateSync(b,3);
        assert.equal(fs.fstatSync(a).size,3);
        assert.equal(read(a,8),"CHA");
        fs.renameSync(visible+"/hard-b",visible+"/hard-c");
        assert.equal(fs.statSync(visible+"/hard-c").ino,inode);
        fs.renameSync(visible+"/hard-a",visible+"/hard-c");
        assert.equal(fs.statSync(visible+"/hard-a").ino,inode);
        assert.equal(fs.statSync(visible+"/hard-c").ino,inode);
        fs.writeFileSync(backing+"/hard-replacement","NEW");
        fs.renameSync(backing+"/hard-replacement",original);
        assert.notEqual(fs.statSync(visible+"/hard-a").ino,inode);
        assert.equal(fs.statSync(visible+"/hard-c").ino,inode);
        const surviving=fs.openSync(visible+"/hard-c","r");
        try { assert.equal(read(surviving,8),"CHA"); }
        finally { fs.closeSync(surviving); }
        fs.unlinkSync(visible+"/hard-c");
        fs.writeSync(a,"OLD",0);
        assert.equal(read(b,8),"OLD");
        assert.equal(fs.fstatSync(a).nlink,0);
        assert.equal(fs.readFileSync(visible+"/hard-a","utf8"),"NEW");
      } finally {
        fs.closeSync(a);
        fs.closeSync(b);
        fs.unlinkSync(original);
      }
    }
  `);
});

it("retains shared mmap behavior and surviving externally removed hard links", async () => {
  await inFusePython(`
import mmap
first = source + "/mapped-first"
second = source + "/mapped-second"
with open(first, "wb") as file:
    file.write(b"ORIGINAL")
os.link(first, second)
a = os.open(base + "/mapped-first", os.O_RDWR)
b = os.open(base + "/mapped-second", os.O_RDWR)
try:
    assert os.fstat(a).st_ino == os.fstat(b).st_ino
    with mmap.mmap(a, 8) as mapped:
        os.pwrite(b, b"CHANGED!", 0)
        assert mapped[:] == b"CHANGED!"
        mapped[0:3] = b"MAP"
        mapped.flush()
        assert os.pread(b, 8, 0) == b"MAPNGED!"
    os.unlink(first)
    assert os.access(base + "/mapped-second", os.R_OK)
    surviving = os.open(base + "/mapped-second", os.O_RDONLY)
    try:
        assert os.pread(surviving, 8, 0) == b"MAPNGED!"
    finally:
        os.close(surviving)
finally:
    os.close(a)
    os.close(b)
    os.unlink(second)

with open(first, "wb") as file:
    file.write(b"ORIGINAL")
a = os.open(base + "/mapped-first", os.O_RDWR)
try:
    assert os.pread(a, 8, 0) == b"ORIGINAL"
    os.link(first, second)
    os.unlink(first)
    b = os.open(base + "/mapped-second", os.O_RDWR)
    try:
        assert os.fstat(a).st_ino == os.fstat(b).st_ino
        os.pwrite(b, b"CHANGED!", 0)
        assert os.pread(a, 8, 0) == b"CHANGED!"
    finally:
        os.close(b)
finally:
    os.close(a)
    os.unlink(second)
`);
});

it("isolates replaced whole-file identities and reports stale persistence through FUSE", async () => {
  await inFusePython(`
backing = source + "/IdentityWhole"
visible = base + "/IdentityWhole"
with open(backing + "/data", "w") as file:
    file.write("OLD")
old = os.open(visible + "/data", os.O_RDWR)
fresh = None
try:
    os.pwrite(old, b"DIRTY", 0)
    with open(backing + "/replacement", "w") as file:
        file.write("NEW")
    os.rename(backing + "/replacement", backing + "/data")
    fresh = os.open(visible + "/data", os.O_RDWR)
    assert os.fstat(old).st_ino != os.fstat(fresh).st_ino
    assert os.pread(fresh, 8, 0) == b"NEW"
    assert os.pread(old, 8, 0) == b"DIRTY"
    for operation in [lambda: os.fsync(old), lambda: os.ftruncate(old, 0)]:
        try:
            operation()
        except OSError as error:
            assert error.errno == errno.ESTALE, error
        else:
            raise AssertionError("stale whole-file operation succeeded")
    assert open(backing + "/data").read() == "NEW"
    os.pwrite(fresh, b"X", 0)
    os.fsync(fresh)
    assert open(backing + "/data").read() == "XEW"
finally:
    if fresh is not None:
        os.close(fresh)
    try:
        os.close(old)
    except OSError as error:
        assert error.errno == errno.ESTALE, error
    os.unlink(backing + "/data")
`);
});

it("persists whole-file writes through surviving hard links after unlink and replacement", async () => {
  await inFusePython(`
backing = source + "/IdentityWhole"
visible = base + "/IdentityWhole"
for mutation in ["unlink", "replace"]:
    with open(backing + "/first", "w") as file:
        file.write("ORIGINAL")
    os.link(backing + "/first", backing + "/second")
    first = os.open(visible + "/first", os.O_RDWR)
    second = os.open(visible + "/second", os.O_RDWR)
    try:
        assert os.fstat(first).st_ino == os.fstat(second).st_ino
        if mutation == "unlink":
            os.unlink(visible + "/first")
        else:
            with open(backing + "/replacement", "w") as file:
                file.write("NEW")
            os.rename(visible + "/replacement", visible + "/first")
        os.pwrite(first, b"UPDATED!", 0)
        os.fsync(first)
        assert os.pread(second, 8, 0) == b"UPDATED!"
        assert open(backing + "/second").read() == "UPDATED!"
        if mutation == "replace":
            assert open(backing + "/first").read() == "NEW"
    finally:
        os.close(first)
        os.close(second)
        os.unlink(backing + "/second")
        if mutation == "replace":
            os.unlink(backing + "/first")
`);
});

it("preserves handles across external alias changes followed by last-link removal", async () => {
  await inFusePython(`
for subtree in ["IdentityWhole", "IdentityPosition"]:
    backing = source + "/" + subtree
    visible = base + "/" + subtree
    for external in ["remove", "replace"]:
        for mounted in ["unlink", "replace"]:
            data, alias, incoming = [backing + "/" + name for name in ["data", "alias", "incoming"]]
            with open(data, "wb") as file:
                file.write(b"ORIGINAL")
            os.link(data, alias)
            first = os.open(visible + "/data", os.O_RDWR)
            second = os.open(visible + "/alias", os.O_RDWR)
            try:
                if external == "replace":
                    with open(incoming, "wb") as file:
                        file.write(b"NEW")
                    os.replace(incoming, data)
                else:
                    os.unlink(data)
                if mounted == "replace":
                    with open(incoming, "wb") as file:
                        file.write(b"NEXT")
                    os.replace(visible + "/incoming", visible + "/alias")
                else:
                    os.unlink(visible + "/alias")
                for fd in [first, second]:
                    assert os.pread(fd, 8, 0) == b"ORIGINAL", (subtree, external, mounted)
                    assert os.fstat(fd).st_nlink == 0
                os.pwrite(first, b"UPDATED!", 0)
                os.fsync(first)
                assert os.pread(second, 8, 0) == b"UPDATED!"
                os.ftruncate(first, 5)
                os.fsync(first)
                assert os.pread(second, 8, 0) == b"UPDAT"
                if external == "replace":
                    assert open(data, "rb").read() == b"NEW"
                if mounted == "replace":
                    assert open(alias, "rb").read() == b"NEXT"
            finally:
                os.close(first)
                os.close(second)
                for name in [data, alias, incoming]:
                    if os.path.exists(name):
                        os.unlink(name)
`);
});

it("rejects stale path-based metadata callbacks, including native I/O overrides", async () => {
  await inFusePython(`
import errno, stat
for subtree in ["IdentityPosition", "PathMetadata"]:
    for kind in ["file", "directory"]:
        backing = source + "/" + subtree + "/metadata-" + kind
        retained = backing + "-retained"
        visible = base + "/" + subtree + "/metadata-" + kind
        if kind == "directory":
            os.mkdir(backing)
        else:
            with open(backing, "wb") as file:
                file.write(b"ORIGINAL")
        os.chmod(backing, 0o755)
        fd = os.open(visible, os.O_RDONLY | os.O_DIRECTORY if kind == "directory" else os.O_RDWR)
        try:
            os.rename(backing, retained)
            if kind == "directory":
                os.mkdir(backing)
            else:
                with open(backing, "wb") as file:
                    file.write(b"NEW")
            os.chmod(backing, 0o755)
            try:
                os.fchmod(fd, 0o700)
                raise AssertionError("stale metadata callback succeeded: " + subtree + "/" + kind)
            except OSError as error:
                assert error.errno == errno.ESTALE, error
            if subtree == "PathMetadata" and kind == "file":
                try:
                    os.ftruncate(fd, 0)
                    raise AssertionError("stale truncation callback succeeded")
                except OSError as error:
                    assert error.errno == errno.ESTALE, error
                assert os.pread(fd, 8, 0) == b"ORIGINAL"
            assert stat.S_IMODE(os.stat(backing).st_mode) == 0o755
            assert stat.S_IMODE(os.stat(retained).st_mode) == 0o755
            if kind == "file":
                assert open(backing, "rb").read() == b"NEW"
                assert open(retained, "rb").read() == b"ORIGINAL"
        finally:
            os.close(fd)
            for name in [backing, retained]:
                (os.rmdir if kind == "directory" else os.unlink)(name)
`);
});

it("rejects replacement during internal positional buffering", async () => {
  await inFusePython(`
backing = source + "/ShortSnapshot"
with open(backing, "wb") as file:
    file.write(b"ORIGINAL")
with open(backing + ".replacement", "wb") as file:
    file.write(b"REPLACED")
fd = os.open(base + "/ShortSnapshot", os.O_RDWR | os.O_DIRECT)
try:
    try:
        os.pwrite(fd, b"X", 0)
        raise AssertionError("write accepted a buffer assembled across identities")
    except OSError as error:
        assert error.errno == errno.ESTALE, error
    assert open(backing, "rb").read() == b"REPLACED"
finally:
    try:
        os.close(fd)
    except OSError as error:
        assert error.errno == errno.ESTALE, error
    for name in [backing, backing + ".replacement"]:
        if os.path.exists(name):
            os.unlink(name)
`);
});

it.each([false, true])(
  "rejects stale handleless positional I/O through FUSE (direct=%s)",
  async (direct) => {
    await inFusePython(`
backing = source + "/IdentityPosition"
visible = base + "/IdentityPosition"
for mutation in ["replace", "remove"]:
    with open(backing + "/data", "wb") as file:
        file.write(b"ORIGINAL")
    old = os.open(visible + "/data", os.O_RDWR | ${direct ? "os.O_DIRECT" : "0"})
    fresh = None
    try:
        before = os.fstat(old)
        if mutation == "replace":
            with open(backing + "/replacement", "wb") as file:
                file.write(b"NEW")
            os.replace(backing + "/replacement", backing + "/data")
        else:
            os.unlink(backing + "/data")
        for name, operation in [("read", lambda: os.pread(old, 8, 0)), ("write", lambda: os.pwrite(old, b"BAD", 0))]:
            try:
                operation()
            except OSError as error:
                # Cached reads may translate the FUSE ESTALE reply into EIO.
                expected = (errno.ESTALE, errno.EIO) if name == "read" and ${direct ? "False" : "True"} else (errno.ESTALE,)
                assert error.errno in expected, (mutation, name, error)
            else:
                raise AssertionError("stale positional operation succeeded")
        assert os.fstat(old).st_size == before.st_size
        if mutation == "replace":
            assert open(backing + "/data", "rb").read() == b"NEW"
            fresh = os.open(visible + "/data", os.O_RDWR)
            assert os.fstat(fresh).st_ino != before.st_ino
            assert os.pread(fresh, 3, 0) == b"NEW"
            assert os.pwrite(fresh, b"X", 0) == 1
            assert open(backing + "/data", "rb").read() == b"XEW"
    finally:
        if fresh is not None:
            os.close(fresh)
        os.close(old)
        if mutation == "replace":
            os.unlink(backing + "/data")
`);
  },
);

it("rejects stale truncating opens before changing a replacement", async () => {
  await inFusePython(`
target = source + "/TruncateRace"
with open(target, "wb") as file:
    file.write(b"ORIGINAL")
with open(target + ".replacement", "wb") as file:
    file.write(b"DO NOT TRUNCATE")
retained = os.open(base + "/TruncateRace", os.O_PATH)
try:
    before = os.fstat(retained)
    try:
        unexpected = os.open("/proc/self/fd/" + str(retained), os.O_WRONLY | os.O_TRUNC)
    except OSError as error:
        assert error.errno == errno.ESTALE, error
    else:
        os.close(unexpected)
        raise AssertionError("stale truncating open succeeded")
    assert open(target, "rb").read() == b"DO NOT TRUNCATE"
    after = os.fstat(retained)
    assert (after.st_ino, after.st_size) == (before.st_ino, before.st_size)
    assert open(target + ".released").read() == "released"
finally:
    os.close(retained)
    os.unlink(target)
    os.unlink(target + ".released")
`);
});

it("rejects partial directory renames with closed generated descendants", async () => {
  await inFuse(`
    for(const [name,generated] of [["Existing","Generated"],["ClosedOwner","generated.txt"]]) {
      const before=base+"/"+name;
      const after=base+"/"+name+"-moved";
      assert.throws(()=>fs.renameSync(before,after),{code:"EXDEV"});
      assert(fs.existsSync(before+"/"+generated));
      assert(fs.existsSync(source+"/"+name));
      assert(!fs.existsSync(after));
      assert(!fs.existsSync(source+"/"+name+"-moved"));
    }
  `);
});

it("updates retained O_PATH link counts after namespace removals without an open callback", async () => {
  await inFusePython(`
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"] if rule.get("root") == "Merged")
for backing, visible in [(source, base), (proxy, base + "/Merged")]:
    for kind in ["file", "symlink", "directory", "replace", "external-link"]:
        target = backing + "/opath-count"
        mounted = visible + "/opath-count"
        if kind == "symlink":
            os.symlink("missing-target", target)
        elif kind == "directory":
            os.mkdir(target)
        else:
            with open(target, "w") as file:
                file.write("ORIGINAL")
        handle = os.open(mounted, os.O_PATH | os.O_NOFOLLOW)
        try:
            if kind == "directory":
                os.rmdir(mounted)
            elif kind == "replace":
                with open(backing + "/opath-replacement", "w") as file:
                    file.write("NEW")
                os.rename(visible + "/opath-replacement", mounted)
            else:
                if kind == "external-link":
                    os.link(target, backing + "/opath-alias")
                os.unlink(mounted)
            assert os.fstat(handle).st_nlink == (1 if kind == "external-link" else 0), (kind, os.fstat(handle))
        finally:
            os.close(handle)
            if kind == "replace":
                os.unlink(target)
            if kind == "external-link":
                os.unlink(backing + "/opath-alias")
`);
});

it("retains O_PATH metadata after external deletion without needing a negative lookup", async () => {
  await inFusePython(`
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"] if rule.get("root") == "Merged")
for backing, visible in [(source, base), (proxy, base + "/Merged")]:
    for kind in ["file", "symlink", "directory", "alias"]:
        target = backing + "/opath-external"
        mounted = visible + "/opath-external"
        alias = backing + "/opath-external-alias"
        if kind == "symlink":
            os.symlink("missing-target", target)
        elif kind == "directory":
            os.mkdir(target)
        else:
            with open(target, "w") as file:
                file.write("ORIGINAL")
        if kind == "alias":
            os.link(target, alias)
        handle = os.open(mounted, os.O_PATH | os.O_NOFOLLOW)
        try:
            before = os.fstat(handle)
            if kind == "alias":
                assert os.stat(visible + "/opath-external-alias").st_ino == before.st_ino
            if kind == "directory":
                os.rmdir(target)
            else:
                os.unlink(target)
            after = os.fstat(handle)
            assert (after.st_ino, after.st_mode, after.st_size) == (before.st_ino, before.st_mode, before.st_size), (kind, after)
            if kind == "alias":
                assert after.st_nlink == 1, after
                os.unlink(alias)
                assert os.fstat(handle).st_ino == before.st_ino
            try:
                os.lstat(mounted)
                raise AssertionError("Deleted name remains visible")
            except FileNotFoundError:
                pass
            assert os.fstat(handle).st_ino == before.st_ino
        finally:
            os.close(handle)
`);
});

it.each(["", "IdentityWhole"])(
  "captures final handle metadata for retained O_PATH descriptors in %s",
  async (subtree) => {
    await inFusePython(`
import time
backing = source + ${JSON.stringify(subtree ? `/${subtree}` : "")} + "/retained-final"
mounted = base + ${JSON.stringify(subtree ? `/${subtree}` : "")} + "/retained-final"
marker = backing + ".released"
def wait_for_release(flags):
    deadline = time.monotonic() + 5
    while True:
        if os.path.exists(marker) and open(marker).read() == str(flags):
            return
        assert time.monotonic() < deadline, "final handle was not released"
        time.sleep(0.01)
for last_reader in [False, True]:
    with open(backing, "wb") as file:
        file.write(b"before")
    writer = os.open(mounted, os.O_RDWR)
    retained = os.open(mounted, os.O_PATH)
    reader = os.open(mounted, os.O_RDONLY) if last_reader else None
    try:
        before = os.fstat(retained)
        os.unlink(mounted)
        assert os.pwrite(writer, b"x" * 29, 0) == 29
        os.close(writer)
        writer = None
        wait_for_release(os.O_RDWR)
        if reader is not None:
            os.close(reader)
            reader = None
            wait_for_release(os.O_RDONLY)
        after = os.fstat(retained)
        assert (after.st_ino, after.st_size, after.st_nlink) == (before.st_ino, 29, 0), after
    finally:
        if writer is not None:
            os.close(writer)
        if reader is not None:
            os.close(reader)
        os.close(retained)
        if os.path.exists(marker):
            os.unlink(marker)
`);
  },
);

it("preserves native disk-full errors through FUSE", async () => {
  await inFusePython(`
import subprocess
backing = source + "/disk-full"
os.mkdir(backing)
try:
    subprocess.run(["mount", "-t", "tmpfs", "-o", "size=64k", "tmpfs", backing], check=True)
    try:
        with open(backing + "/fill", "wb") as file:
            file.write(b"x" * 65536)
        for directory in [backing, base + "/disk-full"]:
            handle = os.open(directory + "/empty", os.O_WRONLY | os.O_CREAT, 0o600)
            try:
                try:
                    os.write(handle, b"x")
                    raise AssertionError("Write to a full backing succeeded")
                except OSError as error:
                    assert error.errno == errno.ENOSPC, (directory, error)
            finally:
                os.close(handle)
    finally:
        subprocess.run(["umount", backing], check=True)
finally:
    os.rmdir(backing)
`);
});

it.each(["source", "proxy"] as const)(
  "preserves symlink metadata and caller-masked creation modes in %s backing",
  async (kind) => {
    await inFusePython(`
import subprocess
with open("/scriptfs/config.json") as config_file:
    runtime = json.load(config_file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"]
             if rule["match"] == "Merged/**")
backing = (source if ${JSON.stringify(kind)} == "source" else proxy) + "/native-attributes"
visible = (base if ${JSON.stringify(kind)} == "source" else base + "/Merged") + "/native-attributes"
os.mkdir(backing)
try:
    subprocess.run(["mount", "-t", "tmpfs", "tmpfs", backing], check=True)
    try:
        target, link = backing + "/target", backing + "/link"
        with open(target, "w") as file:
            file.write("unchanged")
        os.symlink("target", link)
        original = os.stat(target)
        os.lchown(visible + "/link", 123, 456)
        os.utime(visible + "/link", ns=(100125000000, 200750000000), follow_symlinks=False)
        changed = os.lstat(link)
        assert (changed.st_uid, changed.st_gid) == (123, 456), changed
        assert (changed.st_atime_ns, changed.st_mtime_ns) == (100125000000, 200750000000), changed
        unchanged = os.stat(target)
        assert (unchanged.st_uid, unchanged.st_gid, unchanged.st_atime_ns, unchanged.st_mtime_ns) == (
            original.st_uid, original.st_gid, original.st_atime_ns, original.st_mtime_ns), unchanged
        os.lchown(visible + "/link", 789, -1)
        partial = os.lstat(link)
        assert (partial.st_uid, partial.st_gid) == (789, 456), partial
        os.lchown(visible + "/link", -1, 987)
        partial = os.lstat(link)
        assert (partial.st_uid, partial.st_gid) == (789, 987), partial
        os.unlink(target)
        os.lchown(visible + "/link", 456, 123)
        os.utime(visible + "/link", ns=(300125000000, 400750000000), follow_symlinks=False)
        dangling = os.lstat(link)
        assert (dangling.st_uid, dangling.st_gid, dangling.st_mtime_ns) == (456, 123, 400750000000), dangling
        for mask in [0, 0o027, 0o077]:
            previous_mask = os.umask(mask)
            try:
                name = "/mode-" + str(mask)
                for mode in [0o666, 0o755, 0o711, 0o111]:
                    file_name = name + "-" + str(mode)
                    handle = os.open(visible + file_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
                    os.close(handle)
                    assert os.stat(backing + file_name).st_mode & 0o777 == mode & ~mask
                    assert os.stat(visible + file_name).st_mode & 0o777 == mode & ~mask
                os.mkdir(visible + name + "-directory", 0o777)
                assert os.stat(backing + name + "-directory").st_mode & 0o777 == 0o777 & ~mask
            finally:
                os.umask(previous_mask)
    finally:
        subprocess.run(["umount", backing], check=True)
finally:
    os.rmdir(backing)
`);
  },
);

it("rejects removing or replacing directories with generated descendants", async () => {
  await inFuse(`
    fs.mkdirSync(source+"/Existing/Empty");
    assert(fs.readdirSync(base+"/Existing").includes("Generated"));
    assert.throws(()=>fs.rmdirSync(base+"/Existing"),{code:"ENOTEMPTY"});
    fs.rmdirSync(source+"/Existing/Empty");
    fs.unlinkSync(source+"/Existing/original");
    assert.throws(()=>fs.rmdirSync(base+"/Existing"),{code:"ENOTEMPTY"});
    fs.mkdirSync(source+"/empty-replacement");
    assert.throws(()=>fs.renameSync(base+"/empty-replacement",base+"/Existing"),{code:"ENOTEMPTY"});
    assert(fs.statSync(source+"/Existing").isDirectory());
    fs.rmdirSync(source+"/empty-replacement");
    fs.writeFileSync(source+"/Existing/original","source");
  `);
});

it("enumerates winning entries without invoking hidden or superseded metadata callbacks", async () => {
  const names = await readdir(mount);
  expect(names).toContain("superseded-unavailable");
  expect(names).not.toContain("hidden-unavailable");
  await inFuse(`
    const names=fs.readdirSync(base);
    assert(names.includes("superseded-unavailable"));
    assert(!names.includes("hidden-unavailable"));
    assert.equal(fs.readFileSync(base+"/superseded-unavailable","utf8"),"dependency works");
  `);
});

it("rejects merged-directory mutations before either backing is changed", async () => {
  await inFusePython(`
import shutil
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"] if rule.get("root") == "Merged")
for backing in [source + "/Merged", proxy]:
    os.mkdir(backing + "/mutation-merged")
    os.mkdir(backing + "/mutation-empty")
with open(source + "/Merged/mutation-merged/source-child", "w") as file:
    file.write("SOURCE")
os.mkdir(proxy + "/mutation-single")
directory = os.open(base + "/Merged/mutation-merged", os.O_RDONLY | os.O_DIRECTORY)
try:
    operations = [
        (errno.ENOTEMPTY, lambda: os.rmdir(base + "/Merged/mutation-merged")),
        (errno.EXDEV, lambda: os.rename(base + "/Merged/mutation-merged", base + "/Merged/mutation-moved")),
        (errno.EOPNOTSUPP, lambda: os.rmdir(base + "/Merged/mutation-empty")),
        (errno.EXDEV, lambda: os.rename(base + "/Merged/mutation-single", base + "/Merged/mutation-empty")),
    ]
    for expected, operation in operations:
        try:
            operation()
        except OSError as error:
            assert error.errno == expected, error
        else:
            raise AssertionError("partial namespace mutation succeeded")
    os.rename(base + "/Merged/mutation-merged", base + "/Merged/mutation-merged")
    assert os.listdir(directory) == ["source-child"]
    with open(proxy + "/mutation-merged/proxy-child", "w") as file:
        file.write("PROXY")
    try:
        os.rename(base + "/Merged/mutation-merged", base + "/Merged/mutation-moved")
    except OSError as error:
        assert error.errno == errno.EXDEV, error
    else:
        raise AssertionError("rename split a merged directory")
    assert sorted(os.listdir(base + "/Merged/mutation-merged")) == ["proxy-child", "source-child"]
    for backing in [source + "/Merged", proxy]:
        assert os.path.isdir(backing + "/mutation-empty")
        assert not os.path.exists(backing + "/mutation-moved")
    assert os.path.isdir(proxy + "/mutation-single")
finally:
    os.close(directory)
    for backing in [source + "/Merged", proxy]:
        for name in ["mutation-merged", "mutation-empty", "mutation-single", "mutation-moved"]:
            if os.path.exists(backing + "/" + name):
                shutil.rmtree(backing + "/" + name)
`);
});

it("keeps acquired source, proxy and provider descriptors usable after their paths become hidden", async () => {
  await inFuse(`
    const runtime=JSON.parse(fs.readFileSync("/scriptfs/config.json","utf8"));
    const proxy=runtime.filesystems[0].rules.find(rule=>rule.root==="Merged").provider.path;
    for(const [backing,mounted] of [
      [source,base],
      [proxy,base+"/Merged"],
      [source+"/RetainedWhole",base+"/RetainedWhole"],
      [source+"/RetainedPosition",base+"/RetainedPosition"],
    ]) {
      fs.mkdirSync(backing+"/retained-before");
      fs.writeFileSync(backing+"/retained-before/data.txt","abcdef");
      const fd=fs.openSync(mounted+"/retained-before/data.txt","r+");
      try {
        fs.renameSync(mounted+"/retained-before",mounted+"/retained-after");
        assert.equal(fs.fstatSync(fd).size,6);
        const bytes=Buffer.alloc(6);
        assert.equal(fs.readSync(fd,bytes,0,6,0),6);
        assert.equal(bytes.toString(),"abcdef");
        fs.writeSync(fd,"X",0);
        fs.ftruncateSync(fd,3);
        fs.fsyncSync(fd);
        assert.equal(fs.fstatSync(fd).size,3);
        assert.equal(fs.readSync(fd,bytes,0,3,0),3);
        assert.equal(bytes.subarray(0,3).toString(),"Xbc");
        assert.equal(fs.readFileSync(backing+"/retained-after/data.txt","utf8"),"Xbc");
        assert.throws(()=>fs.openSync(mounted+"/retained-after/data.txt","r"),{code:"ENOENT"});
        assert.deepEqual(fs.readdirSync(mounted+"/retained-after"),[]);
      } finally {
        fs.closeSync(fd);
        fs.rmSync(backing+"/retained-after",{recursive:true});
      }
    }
  `);
});

it("rejects namespace operations through externally replaced source and proxy directories", async () => {
  await inFusePython(`
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"] if rule.get("root") == "Merged")
for backing, mounted in [(source, base), (proxy, base + "/Merged")]:
    for operation in ["lookup", "create", "unlink", "mkdir", "rename-from", "rename-to", "readdir"]:
        name = "stale-" + operation
        original = backing + "/" + name
        os.mkdir(original)
        with open(original + "/common", "w") as file:
            file.write("ORIGINAL")
        directory = os.open(mounted + "/" + name, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.stat("common", dir_fd=directory)
            os.rename(original, original + "-retained")
            os.mkdir(original)
            with open(original + "/common", "w") as file:
                file.write("REPLACEMENT")
            incoming = mounted + "/incoming-" + operation
            with open(incoming, "w") as file:
                file.write("INCOMING")
            try:
                if operation == "lookup":
                    unexpected = os.open("common", os.O_RDONLY, dir_fd=directory)
                    os.close(unexpected)
                elif operation == "create":
                    unexpected = os.open("created", os.O_WRONLY | os.O_CREAT, 0o644, dir_fd=directory)
                    os.close(unexpected)
                elif operation == "unlink":
                    os.unlink("common", dir_fd=directory)
                elif operation == "mkdir":
                    os.mkdir("created", dir_fd=directory)
                elif operation == "rename-from":
                    os.rename("common", mounted + "/moved-" + operation, src_dir_fd=directory)
                elif operation == "rename-to":
                    os.rename(incoming, "arrived", dst_dir_fd=directory)
                else:
                    os.listdir(directory)
            except OSError as error:
                assert error.errno in (errno.ESTALE, errno.ENOENT), (operation, error)
            else:
                raise AssertionError("stale operation succeeded: " + operation)
            with open(original + "/common") as file:
                assert file.read() == "REPLACEMENT"
            with open(original + "-retained/common") as file:
                assert file.read() == "ORIGINAL"
            assert os.path.exists(incoming)
            assert sorted(os.listdir(original)) == ["common"]
        finally:
            os.close(directory)
        os.unlink(original + "/common")
        os.rmdir(original)
        os.unlink(original + "-retained/common")
        os.rmdir(original + "-retained")
        os.unlink(backing + "/incoming-" + operation)
  `);
}, 30_000);

it("keeps directory pagination stable across mutations, replacement and independent opens", async () => {
  await inFusePython(`
import ctypes, struct
getdents = ctypes.CDLL(None, use_errno=True).getdents64
getdents.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t]
getdents.restype = ctypes.c_ssize_t
def page(directory):
    buffer = ctypes.create_string_buffer(128)
    size = getdents(directory, buffer, len(buffer))
    if size < 0:
        raise OSError(ctypes.get_errno(), "getdents64")
    names, offset = [], 0
    while offset < size:
        length = struct.unpack_from("H", buffer.raw, offset + 16)[0]
        names.append(buffer.raw[offset + 19:offset + length].split(b"\\0", 1)[0].decode())
        offset += length
    return names
for generated in [False, True]:
    mounted = base + ("/MutableListing" if generated else "/changing-listing")
    backing = source + "/changing-listing"
    expected = {"item-%04d" % i for i in range(1000)}
    if not generated:
        os.mkdir(backing)
        for name in expected:
            with open(backing + "/" + name, "w"):
                pass
    directory = os.open(mounted, os.O_RDONLY | os.O_DIRECTORY)
    second = os.open(mounted, os.O_RDONLY | os.O_DIRECTORY)
    try:
        first = page(directory)
        assert len(first) >= 2
        for name in first[:2]:
            os.unlink(mounted + "/" + name)
        with open(mounted + "/added", "w"):
            pass
        fresh = os.listdir(second)
        assert set(fresh) == expected - set(first[:2]) | {"added"}
        if not generated:
            os.rename(backing, backing + "-retained")
            os.mkdir(backing)
            with open(backing + "/replacement", "w"):
                pass
        names = list(first)
        while True:
            following = page(directory)
            if not following:
                break
            names.extend(following)
        assert len(names) == len(set(names)) == len(expected)
        assert set(names) == expected
    finally:
        os.close(directory)
        os.close(second)
    assert set(os.listdir(mounted)) == (expected - set(first[:2]) | {"added"} if generated else {"replacement"})
  `);
}, 30_000);

it("updates captured resource sizes when open truncates before returning the handle", async () => {
  await inFuse(`
    const first = fs.openSync(base+"/CapturedSize", "r+");
    const second = fs.openSync(base+"/CapturedSize", "w+");
    try {
      for(const fd of [first,second]) assert.equal(fs.fstatSync(fd).size,0);
      fs.writeSync(second,"X",0);
      for(const fd of [first,second]) assert.equal(fs.fstatSync(fd).size,1);
      const bytes=Buffer.alloc(8);
      assert.equal(fs.readSync(second,bytes,0,8,0),1);
      assert.equal(bytes[0],88);
    } finally { fs.closeSync(first); fs.closeSync(second); }
    assert.equal(fs.statSync(base+"/CapturedSize").size,1);
  `);
});

it("writes an existing whole-file sink without truncating or reading it", async () => {
  await inFuse(`
    const fd = fs.openSync(base+"/WriteOnly",fs.constants.O_WRONLY);
    try {
      assert.equal(fs.writeSync(fd,"run",0),3);
      fs.fsyncSync(fd);
      assert.equal(fs.readFileSync(source+"/WriteOnly-received","utf8"),"run");
      assert.equal(fs.fstatSync(fd).size,0);
    } finally { fs.closeSync(fd); }
  `);
});

it("resets flushed zero-sized sinks across already-open FUSE writers", async () => {
  await inFuse(`
    const first=fs.openSync(base+"/WriteOnly",fs.constants.O_WRONLY);
    const second=fs.openSync(base+"/WriteOnly",fs.constants.O_WRONLY);
    try {
      fs.writeSync(first,"long-",0);
      fs.writeSync(second,"command",5);
      fs.fsyncSync(first);
      assert.equal(fs.readFileSync(source+"/WriteOnly-received","utf8"),"long-command");
      fs.writeSync(second,"x",0);
      fs.fsyncSync(second);
      assert.equal(fs.readFileSync(source+"/WriteOnly-received","utf8"),"x");
      fs.writeSync(first,"y",0);
      fs.writeSync(second,"z",1);
      fs.fsyncSync(first);
      assert.equal(fs.readFileSync(source+"/WriteOnly-received","utf8"),"yz");
    } finally { fs.closeSync(first); fs.closeSync(second); }
  `);
});

it("keeps sequential sink payloads unpadded across explicit and automatic flushes", async () => {
  await inFuse(`
      const name="SequentialSink";
      const received=source+"/"+name+"-received";
      const fd=fs.openSync(base+"/"+name,fs.constants.O_WRONLY);
      try {
        assert.equal(fs.writeSync(fd,"one"),3);
        fs.fsyncSync(fd);
        assert.equal(fs.readFileSync(received,"utf8"),"one");
        assert.equal(fs.writeSync(fd,"t"),1);
        assert.equal(fs.writeSync(fd,"wo"),2);
        fs.fsyncSync(fd);
        assert.equal(fs.readFileSync(received,"utf8"),"two");
        assert.equal(fs.writeSync(fd,"three"),5);
        const deadline=Date.now()+5000;
        while(fs.readFileSync(received,"utf8")!=="three"&&Date.now()<deadline)
          await new Promise(resolve=>setTimeout(resolve,50));
        assert.equal(fs.readFileSync(received,"utf8"),"three");
        assert.equal(fs.writeSync(fd,"four"),4);
        fs.fsyncSync(fd);
        assert.equal(fs.readFileSync(received,"utf8"),"four");
      } finally { fs.closeSync(fd); }
    `);
});

it("does not let a provider ENOSYS disable later native fsync or fdatasync", async () => {
  await inFuse(`
    fs.mkdirSync(source+"/sync-errors");
    fs.writeFileSync(source+"/sync-errors/sync-fail","");
    fs.writeFileSync(source+"/UnsupportedSync","");
    fs.writeFileSync(source+"/sync-after","");
    const failed=fs.openSync(base+"/sync-errors/sync-fail","r+");
    const unsupported=fs.openSync(base+"/UnsupportedSync","r+");
    try {
      for(const sync of [fs.fsyncSync,fs.fdatasyncSync]) {
        assert.throws(()=>sync(failed),{code:"EIO"});
        assert.throws(()=>sync(unsupported),error=>["ENOTSUP","EOPNOTSUPP"].includes(error.code));
        assert.throws(()=>sync(failed),{code:"EIO"});
      }
      for(const name of ["sync-after","Proxy"]) {
        const fd=fs.openSync(base+"/"+name,"r+");
        try { fs.fsyncSync(fd); fs.fdatasyncSync(fd); }
        finally { fs.closeSync(fd); }
      }
      const events=fs.readFileSync(source+"/sync-events","utf8").trim().split("\\n").map(JSON.parse);
      for(const kind of ["sync","datasync"])
        assert(events.some(event=>event.kind===kind && event.path.endsWith("/sync-after")));
    } finally { fs.closeSync(failed); fs.closeSync(unsupported); }
  `);
});

it("preserves truncation prefixes, zero extensions, and concurrent handles through FUSE", async () => {
  await inFuse(`
    const p = base + "/data";
    const fd = fs.openSync(p, "r+");
    fs.ftruncateSync(fd, 4);
    const bytes = Buffer.alloc(4);
    fs.readSync(fd, bytes, 0, 4, 0);
    assert.equal(bytes.toString(), "abcd");
    fs.writeSync(fd, "Z", 3);
    fs.fsyncSync(fd);
    assert.equal(fs.readFileSync(source + "/data", "utf8"), "abcZ");
    fs.ftruncateSync(fd, 8);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.deepEqual(fs.readFileSync(source + "/data"), Buffer.from([97,98,99,90,0,0,0,0]));
    fs.truncateSync(p, 3);
    assert.equal(fs.readFileSync(p, "utf8"), "abc");
    const one = fs.openSync(p, "r+");
    const two = fs.openSync(p, "r+");
    fs.readSync(one, Buffer.alloc(3), 0, 3, 0);
    fs.readSync(two, Buffer.alloc(3), 0, 3, 0);
    fs.writeSync(one, "A", 0);
    fs.fsyncSync(one);
    fs.writeSync(two, "B", 1);
    fs.fsyncSync(two);
    fs.closeSync(one);
    fs.closeSync(two);
    assert.equal(fs.readFileSync(source + "/data", "utf8"), "ABc");
  `);
});

it("persists whole-file truncations and coherently combines positional reads with buffered writes", async () => {
  await inFuse(`
    const p=base+"/whole";
    const fd=fs.openSync(p,"r+");
    fs.ftruncateSync(fd,3);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(p,"utf8"),"abc");
    fs.truncateSync(p,6);
    const extended=fs.openSync(p,"r+");
    fs.fsyncSync(extended);
    fs.closeSync(extended);
    assert.deepEqual(fs.readFileSync(p),Buffer.from([97,98,99,0,0,0]));
    const empty=fs.openSync(p,"w");
    fs.fsyncSync(empty);
    fs.closeSync(empty);
    assert.equal(fs.readFileSync(p,"utf8"),"");
    const mixed=fs.openSync(base+"/mixed","r+");
    fs.writeSync(mixed,"Y",0);
    const before=Buffer.alloc(6);
    fs.readSync(mixed,before,0,6,0);
    assert.equal(before.toString(),"Ybcdef");
    fs.fsyncSync(mixed);
    fs.closeSync(mixed);
    const replaced=fs.openSync(base+"/mixed","w+");
    fs.writeSync(replaced,"X",0);
    const after=Buffer.alloc(6);
    assert.equal(fs.readSync(replaced,after,0,6,0),1);
    assert.equal(after.subarray(0,1).toString(),"X");
    fs.fsyncSync(replaced);
    fs.closeSync(replaced);
    assert.equal(fs.readFileSync(base+"/mixed","utf8"),"X");
  `);
  expect(await readFile(path.join(mount, "mixed"), "utf8")).toBe("X");
});

it("persists detached mixed-writer resources rather than only updating their read snapshots", async () => {
  await inFusePython(`
for mutation in ["unlink", "replace"]:
    name = "MixedWriter-" + mutation
    mounted = base + "/" + name
    first = os.open(mounted, os.O_RDWR)
    second = os.open(mounted, os.O_RDWR)
    try:
        if mutation == "unlink":
            os.unlink(mounted)
        else:
            os.rename(mounted + "-replacement", mounted)
        assert os.pwrite(first, b"AFTER!", 0) == 6
        for size, expected in [(6, b"AFTER!"), (9, b"AFTER!\\0\\0\\0")]:
            os.ftruncate(second, size)
            os.fsync(first)
            assert os.pread(first, 20, 0) == expected
            assert os.pread(second, 20, 0) == expected
            assert os.fstat(first).st_size == size
            with open(source + "/" + name + "-persisted", "rb") as file:
                assert file.read() == expected
        if mutation == "replace":
            with open(mounted, "rb") as file:
                assert file.read() == b"NEW"
    finally:
        os.close(first)
        os.close(second)
`);
});

it("refreshes whole-file buffers after a no-op pathname truncate without losing later writes", async () => {
  await inFusePython(`
target = base + "/no-op-whole"
os.truncate(target, 0)
with open(source + "/no-op-whole", "wb") as file:
    file.write(b"ABCDE")
handle = os.open(target, os.O_RDWR)
try:
    assert os.pread(handle, 5, 0) == b"ABCDE"
    assert os.pwrite(handle, b"X", 1) == 1
    os.fsync(handle)
finally:
    os.close(handle)
with open(source + "/no-op-whole", "rb") as file:
    assert file.read() == b"AXCDE"
`);
  expect(await readFile(path.join(mount, "no-op-whole"), "utf8")).toBe("AXCDE");
});

it("preserves full native descriptor reads and metadata after a shorter replacement", async () => {
  await inFuse(`
    fs.writeFileSync(source+"/descriptor","ABCDEF");
    const fd=fs.openSync(base+"/descriptor","r+");
    fs.writeFileSync(source+"/descriptor-replacement","XY");
    fs.renameSync(source+"/descriptor-replacement",source+"/descriptor");
    assert.equal(fs.statSync(base+"/descriptor").size,2);
    assert.equal(fs.fstatSync(fd).size,6);
    const replacementMode=fs.statSync(base+"/descriptor").mode&0o777;
    fs.fchmodSync(fd,0o600);
    assert.deepEqual(
      {
        descriptor: fs.fstatSync(fd).mode&0o777,
        replacement: fs.statSync(base+"/descriptor").mode&0o777,
      },
      {descriptor:0o600,replacement:replacementMode},
    );
    const bytes=Buffer.alloc(6);
    assert.equal(fs.readSync(fd,bytes,0,6,0),6);
    assert.equal(bytes.toString(),"ABCDEF");
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(base+"/descriptor","utf8"),"XY");
  `);
});

it("changes the retained inode without first looking up its external replacement", async () => {
  await inFuse(`
    for (const flags of ["r", "r+"]) {
      const original=source+"/unlooked-replacement";
      fs.writeFileSync(original,"ORIGINAL",{mode:0o644});
      fs.chmodSync(original,0o644);
      const fd=fs.openSync(base+"/unlooked-replacement",flags);
      try {
        fs.writeFileSync(source+"/replacement-next","NEW",{mode:0o644});
        fs.renameSync(source+"/replacement-next",original);
        fs.fchmodSync(fd,0o600);
        fs.futimesSync(fd,new Date(100125),new Date(200750));
        assert.equal(fs.fstatSync(fd).mode&0o777,0o600);
        assert.equal(fs.fstatSync(fd).mtimeMs,200750);
        assert.equal(fs.statSync(original).mode&0o777,0o644);
        assert.notEqual(fs.statSync(original).mtimeMs,200750);
      } finally { fs.closeSync(fd); }
    }
    const fd=fs.openSync(base+"/unlooked-replacement","r");
    try {
      fs.truncateSync(base+"/unlooked-replacement",2);
      assert.equal(fs.readFileSync(source+"/unlooked-replacement","utf8"),"NE");
    } finally { fs.closeSync(fd); }
  `);
});

it("checks access to generated files and synthesized ancestors", async () => {
  await inFuse(`
    fs.accessSync(base+"/dependency",fs.constants.F_OK|fs.constants.R_OK);
    fs.accessSync(base+"/Nested",fs.constants.X_OK);
    fs.accessSync(base+"/Nested/Deep",fs.constants.X_OK);
    assert.throws(()=>fs.accessSync(base+"/Nested/Deep/missing"),{code:"ENOENT"});
    assert.throws(()=>fs.accessSync(base+"/Hidden"),{code:"ENOENT"});
  `);
});

it("creates and persists empty and populated whole-file provider entries", async () => {
  await inFuse(`
    for (const contents of ["","new content"]) {
      const p=base+"/WholeFiles/"+(contents?"populated":"empty");
      const fd=fs.openSync(p,"wx+");
      assert.equal(fs.fstatSync(fd).size,0);
      fs.writeSync(fd,contents);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      assert.equal(fs.readFileSync(p,"utf8"),contents);
    }
    assert.deepEqual(fs.readdirSync(base+"/WholeFiles").sort(),["empty","populated"]);
  `);
  await writeFile(path.join(mount, "WholeFiles", "smb-created"), "SMB content");
  expect(
    await readFile(path.join(mount, "WholeFiles", "smb-created"), "utf8"),
  ).toBe("SMB content");
});

it("keeps path-shared whole-file sizes and reads coherent across distinct open resources", async () => {
  await inFuse(`
    const p=base+"/WholeFiles/shared-sizes";
    fs.writeFileSync(p,"old");
    const handles=[];
    try {
      handles.push(fs.openSync(p,"r+"),fs.openSync(p,"r+"));
      fs.writeSync(handles[0],"EXTENDED",0);
      handles.push(fs.openSync(p,"r+"));
      fs.fsyncSync(handles[0]);
      const verify=expected=>{
        assert.equal(fs.statSync(p).size,expected.length);
        for(const fd of handles) {
          assert.equal(fs.fstatSync(fd).size,expected.length);
          const buffer=Buffer.alloc(20);
          const count=fs.readSync(fd,buffer,0,buffer.length,0);
          assert.equal(buffer.subarray(0,count).toString(),expected);
        }
      };
      verify("EXTENDED");
      fs.ftruncateSync(handles[0],4);
      fs.fsyncSync(handles[0]);
      verify("EXTE");
      handles.push(fs.openSync(p,"w+"));
      fs.fsyncSync(handles[handles.length-1]);
      verify("");
      fs.closeSync(handles.pop());
      verify("");
    } finally {
      for(const fd of handles.reverse())fs.closeSync(fd);
      fs.unlinkSync(p);
    }
  `);
});

it("reports zero links on generated file handles after unlink and replacement", async () => {
  await inFuse(`
    for(const parent of ["WholeFiles","Position"]) {
      for(const operation of ["unlink","replace"]) {
        const p=base+"/"+parent+"/retained-"+operation;
        fs.writeFileSync(p,"OLD");
        const fd=fs.openSync(p,"r+");
        const original=fs.fstatSync(fd);
        try {
          assert.equal(original.nlink,1);
          if(operation==="unlink")fs.unlinkSync(p);
          else {
            fs.writeFileSync(p+"-replacement","NEW");
            fs.renameSync(p+"-replacement",p);
            assert.equal(fs.statSync(p).nlink,1);
            assert.notEqual(fs.statSync(p).ino,original.ino);
          }
          const retained=fs.fstatSync(fd);
          assert.equal(retained.ino,original.ino);
          assert.equal(retained.nlink,0);
          const buffer=Buffer.alloc(3);
          assert.equal(fs.readSync(fd,buffer,0,3,0),3);
          assert.equal(buffer.toString(),"OLD");
        } finally {
          fs.closeSync(fd);
          if(fs.existsSync(p))fs.unlinkSync(p);
          if(fs.existsSync(p+"-replacement"))fs.unlinkSync(p+"-replacement");
        }
      }
    }
  `);
});

it("enforces non-sequential reads on opened and created FUSE resources", async () => {
  await inFuse(`
    for (const [name,flags] of [["data","r"],["created","wx+"]]) {
      const fd=fs.openSync(base+"/Sequential/"+name,flags);
      try {
        const bytes=Buffer.alloc(1);
        assert.equal(fs.readSync(fd,bytes,0,1,0),1);
        assert.throws(()=>fs.readSync(fd,bytes,0,1,0),{code:"ESPIPE"});
        assert.throws(()=>fs.readSync(fd,bytes,0,1,100),{code:"ESPIPE"});
        assert.equal(fs.readSync(fd,bytes,0,1,1),1);
      } finally { fs.closeSync(fd); }
    }
  `);
});

it("reports backing storage capacity through the real statfs callback", async () => {
  await inFuse(`
    const backing=fs.statfsSync(source);
    const mounted=fs.statfsSync(base);
    const after=fs.statfsSync(source);
    assert.equal(mounted.bsize,backing.bsize);
    assert.equal(mounted.blocks,backing.blocks);
    assert.equal(mounted.files,backing.files);
    assert(mounted.bavail>=Math.min(backing.bavail,after.bavail));
    assert(mounted.bavail<=Math.max(backing.bavail,after.bavail));
    assert.equal(fs.statfsSync(base+"/Nested/Deep").blocks,backing.blocks);
  `);
});

it("round-trips signed millisecond timestamps through source, proxy, and module providers", async () => {
  await inFuse(`
    fs.writeFileSync(source+"/timestamp-source","timestamp");
    for(const name of ["timestamp-source","Merged/proxy-only","timestamps"]) {
      const path=base+"/"+name;
      for(const [atime,mtime] of [[100125,200750],[-4294967297,-200750],[-1,0],[0,1],[1,-4294967297]]) {
        fs.utimesSync(path,new Date(atime),new Date(mtime));
        const result=fs.statSync(path);
        assert.equal(result.atime.getTime(),atime,name);
        assert.equal(result.mtime.getTime(),mtime,name);
        const handle=fs.openSync(path,"r+");
        try {
          fs.futimesSync(handle,new Date(mtime),new Date(atime));
          const retained=fs.fstatSync(handle);
          assert.equal(retained.atime.getTime(),mtime,name);
          assert.equal(retained.mtime.getTime(),atime,name);
        } finally { fs.closeSync(handle); }
      }
    }
    fs.utimesSync(source+"/timestamp-source",new Date(-100125),new Date(-200750));
    assert.equal(fs.statSync(base+"/timestamp-source").mtime.getTime(),-200750);
  `);
});

it("uses native backing for source-only nodes inside additive module trees through FUSE and SMB", async () => {
  expect((await readdir(path.join(mount, "Additive"))).sort()).toEqual([
    "generated.txt",
    "native",
    "source.txt",
  ]);
  expect(
    await readFile(path.join(mount, "Additive", "source.txt"), "utf8"),
  ).toBe("SOURCE");
  expect(
    await readFile(path.join(mount, "Additive", "generated.txt"), "utf8"),
  ).toBe("GENERATED");
  await writeFile(path.join(mount, "Additive", "native", "host.txt"), "HOST");
  expect(
    await readFile(path.join(source, "Additive", "native", "host.txt"), "utf8"),
  ).toBe("HOST");
  await writeFile(
    path.join(mount, "Additive", "provider-created.txt"),
    "PROVIDER",
  );
  expect(
    await readFile(
      path.join(mount, "Additive", "provider-created.txt"),
      "utf8",
    ),
  ).toBe("PROVIDER");
  await expect(
    stat(path.join(source, "Additive", "provider-created.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await inFuse(`
    const before=base+"/Additive/source.txt";
    const after=base+"/Additive/renamed.txt";
    const handle=fs.openSync(before,"r+");
    try {
      fs.renameSync(before,after);
      fs.writeSync(handle,"X",0);
      fs.ftruncateSync(handle,3);
      fs.fsyncSync(handle);
      assert.equal(fs.readFileSync(after,"utf8"),"XOU");
      fs.writeFileSync(source+"/Additive/replacement","NEW");
      fs.renameSync(source+"/Additive/replacement",source+"/Additive/renamed.txt");
      const bytes=Buffer.alloc(3);
      assert.equal(fs.readSync(handle,bytes,0,3,0),3);
      assert.equal(bytes.toString(),"XOU");
      assert.equal(fs.readFileSync(after,"utf8"),"NEW");
    } finally { fs.closeSync(handle); }
    fs.unlinkSync(after);
    fs.mkdirSync(base+"/Additive/native/created");
    fs.writeFileSync(base+"/Additive/native/created/data","data");
    fs.renameSync(base+"/Additive/native/created",base+"/Additive/native/moved");
    assert.equal(fs.readFileSync(source+"/Additive/native/moved/data","utf8"),"data");
    fs.unlinkSync(base+"/Additive/native/moved/data");
    fs.rmdirSync(base+"/Additive/native/moved");
  `);
});

it("preserves writes across asynchronous provider flushes", async () => {
  await inFuse(`
    const p = base + "/slow";
    const fd = fs.openSync(p, "r+");
    fs.writeSync(fd, "A", 0);
    await new Promise(resolve => setTimeout(resolve, 550));
    fs.writeSync(fd, "B", 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(p, "utf8"), "AB00");
  `);
}, 30_000);

it("preserves native source I/O with lifecycle-only open and create hooks", async () => {
  await inFuse(`
    const first=fs.openSync(base+"/hook-open","r+");
    fs.writeSync(first,"A",0);
    fs.ftruncateSync(first,3);
    fs.fsyncSync(first);
    fs.closeSync(first);
    assert.equal(fs.readFileSync(source+"/hook-open","utf8"),"A00");
    const created=fs.openSync(base+"/hook-created","wx+");
    fs.writeSync(created,"A",0);
    const second=fs.openSync(base+"/hook-created","r+");
    const bytes=Buffer.alloc(1);
    fs.readSync(second,bytes,0,1,0);
    assert.equal(bytes.toString(),"A");
    fs.writeSync(second,"B",1);
    fs.fsyncSync(created);
    fs.fsyncSync(second);
    fs.closeSync(second);
    fs.closeSync(created);
    assert.equal(fs.readFileSync(source+"/hook-created","utf8"),"AB");
    assert.throws(()=>fs.openSync(base+"/hook-open-broken","r"),{code:"EACCES"});
    assert.throws(()=>fs.openSync(base+"/hook-broken","wx+"),{code:"ENOENT"});
    assert.equal(JSON.parse(fs.readFileSync(base+"/Diagnostics","utf8")).active,0);
  `);
});

it("uses source-only, proxy-only, and overlapping children consistently through FUSE and SMB", async () => {
  expect((await readdir(path.join(mount, "Merged"))).sort()).toEqual([
    "overlap",
    "proxy-only",
    "source-only",
  ]);
  expect(
    await readFile(path.join(mount, "Merged", "source-only"), "utf8"),
  ).toBe("SOURCE");
  expect(await readFile(path.join(mount, "Merged", "overlap"), "utf8")).toBe(
    "PROXY overlap",
  );
  await inFuse(`
    const names=[["source-only","SOURCE"],["proxy-only","PROXY"],["overlap","PROXY overlap"]];
    for(const [name,initial] of names) {
      const p=base+"/Merged/"+name;
      assert.equal(fs.statSync(p).size,initial.length);
      const fd=fs.openSync(p,"r+");
      fs.writeSync(fd,"X",0);
      fs.ftruncateSync(fd,3);
      fs.fsyncSync(fd);
      assert.equal(fs.readFileSync(p,"utf8"),"X"+initial.slice(1,3));
      fs.closeSync(fd);
    }
    const old=fs.openSync(base+"/Merged/source-only","r+");
    fs.writeFileSync(source+"/Merged/replacement","NEW");
    fs.renameSync(source+"/Merged/replacement",source+"/Merged/source-only");
    fs.ftruncateSync(old,2);
    const bytes=Buffer.alloc(2);
    fs.readSync(old,bytes,0,2,0);
    assert.equal(bytes.toString(),"XO");
    assert.equal(fs.readFileSync(base+"/Merged/source-only","utf8"),"NEW");
    fs.closeSync(old);
    assert.equal(fs.readFileSync(source+"/Merged/overlap","utf8"),"SOURCE overlap");
    fs.truncateSync(base+"/Merged/source-only",2);
    assert.equal(fs.readFileSync(source+"/Merged/source-only","utf8"),"NE");
    fs.unlinkSync(base+"/Merged/source-only");
    assert.equal(fs.existsSync(source+"/Merged/source-only"),false);
    fs.writeFileSync(base+"/Merged/new","created");
  `);
  expect(
    await readFile(path.join(root, "merged-proxy", "proxy-only"), "utf8"),
  ).toBe("XRO");
  expect(
    await readFile(path.join(root, "merged-proxy", "overlap"), "utf8"),
  ).toBe("XRO");
  expect(await readFile(path.join(root, "merged-proxy", "new"), "utf8")).toBe(
    "created",
  );
});

it("creates inside source-only merged directories without replacing their open directory identity", async () => {
  await inFusePython(`
with open("/scriptfs/config.json") as config_file:
    runtime = json.load(config_file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"]
             if rule.get("provider", {}).get("type") == "directory")
os.makedirs(source+"/Merged/source-only-dir/deep")
os.mkdir(source+"/Merged/shared-dir")
os.mkdir(proxy+"/shared-dir")
for relative, backing in [("source-only-dir/deep", source+"/Merged"), ("shared-dir", proxy)]:
    directory = base+"/Merged/"+relative
    handle = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        inode = os.fstat(handle).st_ino
        created = os.open("created", os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o644, dir_fd=handle)
        try:
            os.write(created, b"created")
            os.fsync(created)
        finally:
            os.close(created)
        os.mkdir("child", dir_fd=handle)
        os.rename("created", "renamed", src_dir_fd=handle, dst_dir_fd=handle)
        assert os.stat(directory).st_ino == inode
        assert os.fstat(handle).st_ino == inode
        assert sorted(os.listdir(handle)) == ["child", "renamed"]
        with open(backing+"/"+relative+"/renamed", "rb") as contents:
            assert contents.read() == b"created"
        assert os.path.isdir(backing+"/"+relative+"/child")
        os.fsync(handle)
    finally:
        os.close(handle)
assert not os.path.exists(proxy+"/source-only-dir")
`);
  for (const [relative, backing] of [
    ["source-only-dir/deep", path.join(source, "Merged")],
    ["shared-dir", path.join(root, "merged-proxy")],
  ] as const) {
    await writeFile(path.join(mount, "Merged", relative, "smb"), "SMB");
    expect(await readFile(path.join(backing, relative, "smb"), "utf8")).toBe(
      "SMB",
    );
  }
});

it("rejects overlapping proxy file removals while allowing same-backing namespace changes", async () => {
  await writeFile(
    path.join(source, "Merged", "overlapping-hardlink"),
    "SOURCE",
  );
  await link(
    path.join(source, "Merged", "overlapping-hardlink"),
    path.join(root, "merged-proxy", "overlapping-hardlink"),
  );
  await inFusePython(`
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"]
             if rule.get("root") == "Merged")
for kind in ["file", "symlink", "hardlink"]:
    name = "overlapping-" + kind
    native = source + "/Merged/" + name
    target = proxy + "/" + name
    visible = base + "/Merged/" + name
    if kind == "symlink":
        os.symlink("source-target", native)
        os.symlink("proxy-target", target)
    elif kind != "hardlink":
        with open(native, "w") as file:
            file.write("SOURCE")
        with open(target, "w") as file:
            file.write("PROXY")
    try:
        before = os.lstat(visible).st_ino
        for operation, expected in [
            (lambda: os.unlink(visible), errno.EOPNOTSUPP),
            (lambda: os.rename(visible, visible + "-moved"), errno.EXDEV),
        ]:
            try:
                operation()
                raise AssertionError("namespace mutation succeeded")
            except OSError as error:
                assert error.errno == expected, error
        assert os.lstat(visible).st_ino == before
        assert os.path.lexists(native) and os.path.lexists(target)
        assert not os.path.lexists(visible + "-moved")
    finally:
        os.unlink(native)
        os.unlink(target)
same = base + "/SameBacking"
with open(same + "/file", "w") as file:
    file.write("same backing")
os.rename(same + "/file", same + "/renamed")
assert not os.path.exists(same + "/file")
os.unlink(same + "/renamed")
assert not os.path.exists(same + "/renamed")
`);
});

it("omits source and generated entries hidden by opaque child overrides", async () => {
  expect(await readdir(mount)).not.toContain("masked-source");
  expect(await readdir(path.join(mount, "Masked"))).toEqual([]);
  await inFuse(`
    assert(!fs.readdirSync(base).includes("masked-source"));
    assert.deepEqual(fs.readdirSync(base+"/Masked"),[]);
    assert.throws(()=>fs.statSync(base+"/masked-source"),{code:"ENOENT"});
    assert.throws(()=>fs.statSync(base+"/Masked/visible"),{code:"ENOENT"});
  `);
});

it("keeps dirty handles attached after file and directory renames", async () => {
  await inFuse(`
    const fd = fs.openSync(base + "/directory/data", "r+");
    fs.writeSync(fd, "A", 0);
    fs.renameSync(base + "/directory", base + "/renamed-directory");
    fs.writeSync(fd, "B", 1);
    fs.renameSync(base + "/renamed-directory/data", base + "/renamed-directory/renamed");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.equal(fs.existsSync(source + "/directory"), false);
    assert.equal(fs.existsSync(source + "/renamed-directory/data"), false);
    assert.equal(fs.readFileSync(source + "/renamed-directory/renamed", "utf8"), "AB00");
  `);
});

it("rejects directory renames that would redirect open descendants to another provider", async () => {
  await inFuse(`
    const fd = fs.openSync(base + "/before/data.txt", "r");
    assert.throws(() => fs.renameSync(base + "/before", base + "/after"), {code:"EXDEV"});
    assert.equal(fs.readFileSync(base + "/before/data.txt", "utf8"), "dependency works");
    fs.closeSync(fd);
  `);
});

it("invalidates completed truncation buffers and reports acknowledged pending sizes", async () => {
  await inFuse(`
    fs.writeFileSync(source + "/truncated", "abcdef");
    fs.truncateSync(base + "/truncated", 4);
    fs.writeFileSync(source + "/truncated", "NEW DATA");
    const fd = fs.openSync(base + "/truncated", "r+");
    const bytes = Buffer.alloc(8);
    fs.readSync(fd, bytes, 0, 8, 0);
    assert.equal(bytes.toString(), "NEW DATA");
    fs.writeSync(fd, "X", 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(source + "/truncated", "utf8"), "XEW DATA");
    fs.writeFileSync(source + "/pending", "");
    const pending = fs.openSync(base + "/pending", "r+");
    fs.writeSync(pending, "hello", 0);
    assert.equal(fs.statSync(base + "/pending").size, 5);
    assert.equal(fs.readFileSync(base + "/pending", "utf8"), "hello");
    fs.closeSync(pending);
  `);
});

it("supports positional-only truncation and preserves open identity after unlink and replacement", async () => {
  await inFuse(`
    const p = base + "/Position";
    const fd = fs.openSync(p + "/data", "r+");
    fs.ftruncateSync(fd, 3);
    fs.unlinkSync(p + "/data");
    fs.writeFileSync(p + "/data", "NEW");
    fs.writeSync(fd, "X", 0);
    fs.fsyncSync(fd);
    const old = Buffer.alloc(3);
    fs.readSync(fd, old, 0, 3, 0);
    assert.equal(old.toString(), "XLD");
    assert.equal(fs.readFileSync(p + "/data", "utf8"), "NEW");
    fs.closeSync(fd);
    const replaced = fs.openSync(p + "/data", "r+");
    fs.renameSync(p + "/replacement", p + "/data");
    fs.writeSync(replaced, "Y", 0);
    fs.fsyncSync(replaced);
    assert.equal(fs.readFileSync(p + "/data", "utf8"), "replacement");
    fs.closeSync(replaced);
    const created = fs.openSync(p + "/new", "w+");
    fs.writeSync(created, "hello");
    assert.equal(fs.statSync(p + "/new").size, 5);
    assert.equal(fs.readFileSync(p + "/new","utf8"),"hello");
    fs.closeSync(created);
  `);
});

it("ftruncates the original native resource after atomic replacement", async () => {
  await inFuse(`
    const fd=fs.openSync(base+"/Native","r+");
    fs.writeFileSync(source+"/native-replacement","XY");
    fs.renameSync(source+"/native-replacement",source+"/native-target");
    assert.equal(fs.fstatSync(fd).size,8);
    const full=Buffer.alloc(8);
    assert.equal(fs.readSync(fd,full,0,8,0),8);
    assert.equal(full.toString(),"ORIGINAL");
    fs.ftruncateSync(fd,3);
    const bytes=Buffer.alloc(3);
    fs.readSync(fd,bytes,0,3,0);
    assert.equal(bytes.toString(),"ORI");
    assert.equal(fs.readFileSync(source+"/native-target","utf8"),"XY");
    fs.closeSync(fd);
  `);
});

it("calls real backing sync and datasync operations for source and proxy files", async () => {
  await inFuse(`
    fs.writeFileSync(source+"/sync-check","");
    for(const p of [base+"/sync-check",base+"/Proxy"]) {
      const fd=fs.openSync(p,"r+");
      fs.fsyncSync(fd);
      fs.fdatasyncSync(fd);
      fs.closeSync(fd);
    }
    const events=fs.readFileSync(source+"/sync-events","utf8").trim().split("\\n").map(JSON.parse);
    for(const suffix of ["/sync-check","/proxy-target"]) {
      for(const kind of ["sync","datasync"]) assert(events.some(event=>event.kind===kind && event.path.endsWith(suffix)));
    }
  `);
});

it("syncs real source and proxy directory descriptors, including after rename, and propagates failures", async () => {
  await inFuse(`
    fs.mkdirSync(source+"/sync-dir");
    fs.mkdirSync(source+"/sync-fail");
    const fd=fs.openSync(base+"/sync-dir",fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    fs.renameSync(base+"/sync-dir",base+"/sync-dir-moved");
    fs.fsyncSync(fd);
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
    const proxy=fs.openSync(base+"/Merged","r");
    fs.fsyncSync(proxy);
    fs.fdatasyncSync(proxy);
    fs.closeSync(proxy);
    for(const name of ["Generated","Nested"]) {
      const virtual=fs.openSync(base+"/"+name,"r");
      assert.throws(()=>fs.fsyncSync(virtual),error=>["ENOTSUP","EOPNOTSUPP"].includes(error.code));
      fs.closeSync(virtual);
    }
    const failed=fs.openSync(base+"/sync-fail","r");
    assert.throws(()=>fs.fsyncSync(failed),{code:"EIO"});
    fs.closeSync(failed);
    const events=fs.readFileSync(source+"/sync-events","utf8").trim().split("\\n").map(JSON.parse);
    for(const kind of ["sync","datasync"]) {
      assert(events.some(event=>event.kind===kind && event.directory && event.path===source+"/sync-dir-moved"));
      assert(events.some(event=>event.kind===kind && event.directory && event.path.startsWith("/scriptfs/proxies/")));
    }
  `);
});

it("releases real descriptors on create completion failure", async () => {
  await inFuse(`
    assert.throws(()=>fs.openSync(base+"/BrokenCreate","w"),{code:"EACCES"});
    const metrics=JSON.parse(fs.readFileSync(base+"/Diagnostics","utf8"));
    assert.equal(metrics.active,0);
    assert(metrics.released>=1);
  `);
});

it("preserves a replacement written during a failing native create hook", async () => {
  await inFuse(`
    assert.throws(()=>fs.openSync(base+"/ReplacedCreate","wx"),{code:"EACCES"});
    assert.equal(fs.readFileSync(source+"/ReplacedCreate","utf8"),"concurrent replacement");
  `);
});

it("does not retain closed-file truncate buffers proportional to the workload", async () => {
  if (!session) throw new Error("Missing session");
  const before = await runCommand("podman", [
    "exec",
    session.containerId,
    "node",
    "-e",
    'console.log(JSON.parse(require("node:fs").readFileSync("/scriptfs/overlays/0/Diagnostics","utf8")).buffers)',
  ]);
  await runCommand("podman", [
    "exec",
    session.containerId,
    "python3",
    "-c",
    [
      "import os",
      "for i in range(32):",
      " p='/scriptfs/sources/0/memory-'+str(i)",
      " open(p,'w').close()",
      " os.truncate('/scriptfs/overlays/0/memory-'+str(i),1048576)",
    ].join("\n"),
  ]);
  const after = await runCommand("podman", [
    "exec",
    session.containerId,
    "node",
    "-e",
    'console.log(JSON.parse(require("node:fs").readFileSync("/scriptfs/overlays/0/Diagnostics","utf8")).buffers)',
  ]);
  expect(Number(after.stdout) - Number(before.stdout)).toBeLessThan(
    8 * 1024 * 1024,
  );
});

it("rejects cross-provider atomic saves instead of losing the replacement", async () => {
  await writeFile(path.join(mount, "temporary"), "replacement");
  await expect(
    rename(path.join(mount, "temporary"), path.join(mount, "Proxy")),
  ).rejects.toBeDefined();
  expect(await readFile(path.join(root, "proxy-target"), "utf8")).toBe("old");
  expect(await readFile(path.join(mount, "Proxy"), "utf8")).toBe("old");
  expect(await readFile(path.join(mount, "temporary"), "utf8")).toBe(
    "replacement",
  );
  await inFuse(`
    assert.throws(() => fs.renameSync(base + "/temporary", base + "/Proxy"), { code: "EXDEV" });
    assert.throws(() => fs.renameSync(base + "/Proxy", base + "/other"), { code: "EXDEV" });
  `);
});

it("follows atomic host replacement of a file proxy", async () => {
  await writeFile(path.join(root, "replacement"), "new host target");
  await rename(path.join(root, "replacement"), path.join(root, "proxy-target"));
  // Host-to-VM filesystem metadata invalidation is asynchronous.
  await expect
    .poll(() => readFile(path.join(mount, "Proxy"), "utf8"), {
      timeout: 10_000,
      interval: 50,
    })
    .toBe("new host target");
}, 15_000);

it("rejects file-proxy symlink replacements through FUSE and SMB without changing unrelated files", async () => {
  const proxyRule = `
    const runtime=JSON.parse(fs.readFileSync("/scriptfs/config.json","utf8"));
    const target=runtime.filesystems[0].rules.find(rule=>rule.match==="ProxyGuard").provider.path;
    const actual=require("node:path").join(require("node:path").dirname(target),"proxy-actual");
  `;
  try {
    await inFuse(`
      ${proxyRule}
      fs.writeFileSync(actual,"intended");
      fs.writeFileSync(source+"/proxy-actual","unrelated");
      fs.symlinkSync("proxy-actual",target+"-link");
      fs.renameSync(target+"-link",target);
      const unsupported=error=>["ENOTSUP","EOPNOTSUPP"].includes(error.code);
      assert.throws(()=>fs.readFileSync(base+"/ProxyGuard"),unsupported);
      assert.throws(()=>fs.writeFileSync(base+"/ProxyGuard","wrong write"),unsupported);
      assert(!fs.readdirSync(base).includes("ProxyGuard"));
      assert.equal(fs.readFileSync(actual,"utf8"),"intended");
      assert.equal(fs.readFileSync(source+"/proxy-actual","utf8"),"unrelated");
    `);
    await expect(
      readFile(path.join(mount, "ProxyGuard")),
    ).rejects.toBeDefined();
    await expect(
      writeFile(path.join(mount, "ProxyGuard"), "wrong SMB write"),
    ).rejects.toBeDefined();
    expect(await readFile(path.join(source, "proxy-actual"), "utf8")).toBe(
      "unrelated",
    );
    expect(await readFile(path.join(root, "proxy-actual"), "utf8")).toBe(
      "intended",
    );
  } finally {
    await inFuse(`
      ${proxyRule}
      fs.writeFileSync(target+"-regular","restored");
      fs.renameSync(target+"-regular",target);
      assert.equal(fs.readFileSync(base+"/ProxyGuard","utf8"),"restored");
    `);
  }
});

it("resolves installed provider dependencies and consistent opaque/hidden listings", async () => {
  expect(await readFile(path.join(mount, "dependency"), "utf8")).toBe(
    "dependency works",
  );
  expect(
    await readFile(path.join(mount, "Nested", "Deep", "visible"), "utf8"),
  ).toBe("visible");
  const entries = await readdir(mount);
  expect(entries).not.toContain("Hidden");
  expect(entries).not.toContain("HiddenRoot");
  expect(await readdir(path.join(mount, "Generated"))).toEqual(["visible"]);
  expect(await readdir(path.join(mount, "Shadow"))).toEqual([]);
  await expect(
    access(path.join(mount, "Generated", "source-only")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("enumerates native ancestors of generated roots through FUSE and SMB", async () => {
  expect((await readdir(path.join(mount, "Existing"))).sort()).toEqual([
    "Generated",
    "original",
  ]);
  expect(
    await readFile(
      path.join(mount, "Existing", "Generated", "visible"),
      "utf8",
    ),
  ).toBe("visible");
  await inFuse(`
    const directory=base+"/Existing";
    const before=fs.statSync(directory);
    const handle=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    try {
      assert.equal(fs.fstatSync(handle).ino,before.ino);
      assert.deepEqual(fs.readdirSync(directory).sort(),["Generated","original"]);
      fs.writeFileSync(directory+"/created","native");
      assert.equal(fs.statSync(directory).ino,before.ino);
      assert.equal(fs.fstatSync(handle).ino,before.ino);
      assert.equal(fs.readFileSync(source+"/Existing/created","utf8"),"native");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  `);
});

it("exposes inferred opaque roots through FUSE and SMB without claiming the mount root", async () => {
  expect(await readFile(path.join(mount, "Inferred", "data.txt"), "utf8")).toBe(
    "inferred",
  );
  expect(await readdir(path.join(mount, "Inferred"))).toEqual(["data.txt"]);
  await inFuse(`
    assert(fs.statSync(base+"/Inferred").isDirectory());
    assert.equal(fs.readFileSync(base+"/Inferred/data.txt","utf8"),"inferred");
    assert(fs.readdirSync(base).includes("Inferred"));
    assert(fs.readdirSync(base).includes("data"));
  `);
});

it("creates empty source files under nonopaque provider rules", async () => {
  await writeFile(path.join(mount, "empty.generated"), "");
  expect((await stat(path.join(source, "empty.generated"))).size).toBe(0);
});

it("supports directory and generated symlinks in FUSE", async () => {
  await symlink("Generated", path.join(source, "generated-link"));
  await inFuse(`
    assert.equal(fs.lstatSync(base + "/generated-link").isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(base + "/generated-link"), "Generated");
    assert.equal(fs.readFileSync(base + "/generated-link/visible", "utf8"), "visible");
    assert.equal(fs.lstatSync(base + "/directory-link").isSymbolicLink(), true);
  `);
});

it("retains symlink inode targets across source, proxy, and generated replacements", async () => {
  await inFusePython(`
import shutil
with open("/scriptfs/config.json") as file:
    runtime = json.load(file)
proxy = next(rule["provider"]["path"] for rule in runtime["filesystems"][0]["rules"]
             if rule.get("root") == "Merged")
for backing, mounted in [(source, base), (proxy, base + "/Merged")]:
    directory = backing + "/retained-symlinks"
    visible = mounted + "/retained-symlinks"
    os.mkdir(directory)
    try:
        for kind in ["external", "mounted"]:
            original = directory + "/" + kind
            link = visible + "/" + kind
            os.symlink("original-target", original)
            handle = os.open(link, os.O_PATH | os.O_NOFOLLOW)
            try:
                if kind == "external":
                    os.rename(original, original + "-retained")
                else:
                    os.unlink(link)
                os.symlink("replacement-target", original)
                assert os.readlink("", dir_fd=handle) == "original-target"
                assert os.readlink(link) == "replacement-target"
                assert os.readlink("", dir_fd=handle) == "original-target"
                os.unlink(original)
                assert os.readlink("", dir_fd=handle) == "original-target"
            finally:
                os.close(handle)
    finally:
        shutil.rmtree(directory)
handle = os.open(base + "/MutableLink", os.O_PATH | os.O_NOFOLLOW)
try:
    before = os.fstat(handle).st_ino
    with open(base + "/ChangeLink", "w") as file:
        file.write("changed-target")
    assert os.fstat(handle).st_size == len("original-target")
    assert os.readlink(base + "/MutableLink") == "changed-target"
    assert os.stat(base + "/MutableLink", follow_symlinks=False).st_ino != before
    assert os.readlink("", dir_fd=handle) == "original-target"
finally:
    os.close(handle)
`);
});

it("removes a created container when its SMB port is already occupied", async () => {
  if (!session) throw new Error("Missing session");
  const published = await runCommand("podman", [
    "port",
    session.containerId,
    "445/tcp",
  ]);
  const port = /:(\d+)\s*$/.exec(published.stdout)?.[1];
  if (!port) throw new Error("Missing published SMB port");
  const failedSource = path.join(root, "failed-start-source");
  await mkdir(failedSource);
  const sourcePath = await realpath(failedSource);
  const result = await startScriptFs({
    filesystems: [
      {
        name: "collision",
        source: sourcePath,
        mountPoint: path.join(root, "failed-start-mount"),
      },
    ],
    container: { smbPort: Number(port), logLevel: "silent" },
  }).then(
    (started) => ({ session: started, error: undefined }),
    (error: unknown) => ({ session: undefined, error }),
  );
  if (result.session) await result.session.stop();
  const listed = await runCommand("podman", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `ancestor=${config.container?.image ?? "localhost/scriptfs-runtime:0.1.0"}`,
  ]);
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  const containers = ids.length
    ? (JSON.parse((await runCommand("podman", ["inspect", ...ids])).stdout) as {
        Id: string;
        Mounts: { Source: string }[];
      }[])
    : [];
  const leftovers = containers.filter((container) =>
    container.Mounts.some((mount) => mount.Source === sourcePath),
  );
  try {
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(ScriptFsStartupError);
    expect(leftovers).toEqual([]);
    await expect(
      access(path.join(root, "failed-start-mount")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (result.error instanceof ScriptFsStartupError)
      await result.error.session.stop();
    for (const container of leftovers)
      await runCommand("podman", ["rm", "--force", "--ignore", container.Id]);
  }
}, 30_000);

it("reports a busy mount without stopping the server and retries after it is released", async () => {
  if (!session) throw new Error("Missing session");
  const holder = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready");setInterval(() => {}, 1000)'],
    {
      cwd: mount,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await once(holder.stdout, "data");
    await expect(session.stop()).rejects.toThrow(/busy|in use/i);
    const state = await runCommand("podman", [
      "inspect",
      "--format",
      "{{.State.Status}}",
      session.containerId,
    ]);
    expect(state.stdout.trim()).toBe("running");
  } finally {
    const exited = once(holder, "exit");
    holder.kill("SIGTERM");
    await exited;
  }
}, 30_000);

it.each(["create", "exec"])(
  "cancels a stalled real Podman %s command without leaving its container behind",
  async (operation) => {
    const podman = (await runCommand("which", ["podman"])).stdout.trim();
    const bin = path.join(root, `stalled-${operation}`);
    const marker = path.join(bin, "interrupted.json");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "podman"),
      `#!${process.execPath}
const {spawn}=require("node:child_process");
const fs=require("node:fs");
const args=process.argv.slice(2);
const child=spawn(${JSON.stringify(podman)},args,{stdio:["ignore","pipe","pipe"]});
let stdout="",stderr="";
child.stdout.on("data",chunk=>stdout+=chunk);
child.stderr.on("data",chunk=>stderr+=chunk);
child.on("error",error=>{console.error(error);process.exitCode=1;});
child.on("close",code=>{
  if(code===0 && args[0]===${JSON.stringify(operation)}){
    fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({
      containerId:args[0]==="create"?stdout.trim():args[1],
      pid:process.pid
    }));
    setInterval(()=>{},1000);
    return;
  }
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode=code??1;
});
`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    const cancellation = new AbortController();
    let containerId: string | undefined;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    const running = startScriptFs(
      {
        filesystems: [
          {
            name: `cancel-${operation}`,
            source,
            mountPoint: path.join(root, `cancel-${operation}-mount`),
          },
        ],
        container: { logLevel: "silent" },
      },
      { signal: cancellation.signal },
    );
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await expect
        .poll(() => access(marker), { timeout: 30_000, interval: 50 })
        .toBeUndefined();
      const interrupted = JSON.parse(await readFile(marker, "utf8")) as {
        containerId: string;
        pid: number;
      };
      containerId = interrupted.containerId;
      cancellation.abort();
      await rejected;
      expect(() => process.kill(interrupted.pid, 0)).toThrow();
      await expect(
        runCommand(podman, ["inspect", containerId]),
      ).rejects.toThrow();
    } finally {
      cancellation.abort();
      try {
        await running.then(
          (started) => started.stop(),
          async (error: unknown) => {
            if (error instanceof ScriptFsStartupError)
              await error.session.stop();
          },
        );
      } finally {
        process.env.PATH = originalPath;
        if (containerId)
          await runCommand(podman, ["rm", "--ignore", "--force", containerId]);
      }
    }
  },
  60_000,
);

it("cleans up a running session on cancellation", async () => {
  if (!session) throw new Error("Missing session");
  await stat(path.join(mount, "shutdown-signal"));
  controller.abort();
  await session.stop();
  await expect(
    readFile(path.join(source, "provider-aborted"), "utf8"),
  ).resolves.toBe("aborted");
  await expect(access(path.join(mount, "data"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    runCommand("podman", ["inspect", session.containerId]),
  ).rejects.toThrow();
});

it("rolls back cancellation while mounting multiple real shares", async () => {
  const abort = new AbortController();
  const filesystems = Array.from({ length: 4 }, (_, index) => ({
    name: `cancel${String(index)}`,
    source,
    mountPoint: path.join(root, `cancel${String(index)}`),
  }));
  const starting = startScriptFs(
    {
      filesystems,
      container: { logLevel: "silent" },
    },
    { signal: abort.signal },
  ).then(
    (started) => ({ session: started, error: undefined }),
    (error: unknown) => ({ session: undefined, error }),
  );
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await access(path.join(root, "cancel0", "data"));
        break;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for first cancellation share");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  } finally {
    abort.abort();
  }
  const result = await starting;
  if (result.session) await result.session.stop();
  expect(result.error).toBeDefined();
  for (const filesystem of filesystems) {
    await expect(
      access(path.join(filesystem.mountPoint, "data")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 60_000);

it("exposes cleanup recovery after a real partial-startup busy rollback", async () => {
  const mountPoints = Array.from({ length: 5 }, (_, index) =>
    path.join(root, `rollback${String(index)}`),
  );
  const invalid = path.join(root, "invalid-mount");
  await writeFile(invalid, "not a directory");
  const starting = startScriptFs({
    filesystems: [
      ...mountPoints.map((mountPoint, index) => ({
        name: `rollback${String(index)}`,
        source,
        mountPoint,
      })),
      { name: "invalid", source, mountPoint: invalid },
    ],
    container: { logLevel: "silent" },
  }).then(
    (started) => ({ session: started, error: undefined }),
    (error: unknown) => ({ session: undefined, error }),
  );
  const first = mountPoints[0];
  if (!first) throw new Error("Missing rollback mount");
  await expect
    .poll(() => access(path.join(first, "data")), {
      timeout: 30_000,
      interval: 2,
    })
    .toBeUndefined();
  const holder = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready");setInterval(() => {}, 1000)'],
    {
      cwd: first,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let result: Awaited<typeof starting>;
  try {
    await once(holder.stdout, "data");
    result = await starting;
  } finally {
    const exited = once(holder, "exit");
    holder.kill("SIGTERM");
    await exited;
  }
  if (result.session) {
    await result.session.stop();
    throw new Error("Startup should have failed");
  }
  expect(result.error).toBeInstanceOf(ScriptFsStartupError);
  if (!(result.error instanceof ScriptFsStartupError)) throw result.error;
  const recovery = result.error.session;
  expect(recovery.mounts.size).toBe(1);
  await recovery.stop();
  expect(recovery.mounts.size).toBe(0);
  await expect(
    runCommand("podman", ["inspect", recovery.containerId]),
  ).rejects.toThrow();
}, 60_000);

it("rejects case-colliding shares without mounting them", async () => {
  await expect(
    startScriptFs({
      filesystems: [
        { name: "Work", source, mountPoint: path.join(root, "case-upper") },
        { name: "work", source, mountPoint: path.join(root, "case-lower") },
      ],
    }),
  ).rejects.toThrow("unique name");
  await expect(access(path.join(root, "case-upper"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(access(path.join(root, "case-lower"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("exercises the shipped whole-file, positional, mutable-tree and read-only examples", async () => {
  const example = await loadConfig(
    path.resolve("examples/showcase/config.json"),
  );
  example.filesystems = example.filesystems.map((filesystem, index) => ({
    ...filesystem,
    mountPoint: path.join(root, `example-${String(index)}`),
  }));
  example.container = { logLevel: "silent" };
  const running = await startScriptFs(example);
  try {
    const exampleMount = example.filesystems[0]?.mountPoint;
    if (!exampleMount) throw new Error("Missing example mount");
    const content = path.join(
      exampleMount,
      "GeneratedCatalog",
      "ContentSized.txt",
    );
    await writeFile(content, "updated example");
    expect(await readFile(content, "utf8")).toBe("updated example");
    await writeFile(
      path.join(exampleMount, "GeneratedCatalog", "CommandSink.txt"),
      "run",
    );
    const logs = await runCommand("podman", ["logs", running.containerId]);
    expect(
      (logs.stdout + logs.stderr).match(/write 3 bytes to .*CommandSink.txt/g),
    ).toHaveLength(1);
    await runCommand("podman", [
      "exec",
      running.containerId,
      "node",
      "-e",
      `
      const fs=require("node:fs");
      const assert=require("node:assert/strict");
      const base="/scriptfs/overlays/0";
      fs.accessSync(base+"/components/Button/AGENTS.md",fs.constants.R_OK);
      fs.accessSync(base+"/Tools",fs.constants.X_OK);
      fs.writeFileSync(base+"/GeneratedCatalog/created.txt","whole creation");
      assert.equal(fs.readFileSync(base+"/GeneratedCatalog/created.txt","utf8"),"whole creation");
      assert(!fs.readdirSync(base+"/GeneratedCatalog").includes("hidden.private"));
      assert.equal(fs.readlinkSync(base+"/Tools/Memory/latest"),"data.txt");
      assert.equal(fs.readFileSync(base+"/MergedDirectory/existing.txt","utf8"),
        fs.readFileSync(base+"/ProxiedDirectory/existing.txt","utf8"));
      assert(fs.readFileSync(base+"/MergedDirectory/source-only.txt","utf8").includes("source side"));

      const fixed=fs.openSync(base+"/GeneratedCatalog/FixedSize.bin","r+");
      try {
        fs.writeSync(fixed,"OK",2);
        fs.ftruncateSync(fixed,4);
        const bytes=Buffer.alloc(4);
        assert.equal(fs.readSync(fixed,bytes,0,4,0),4);
        assert.equal(bytes.toString(),"FFOK");
        assert.equal(fs.fstatSync(fixed).size,4);
      } finally { fs.closeSync(fixed); }
      const stream=fs.openSync(base+"/GeneratedCatalog/GeneratedStream.bin","r");
      try {
        const bytes=Buffer.alloc(16);
        assert.equal(fs.readSync(stream,bytes,0,16,100),16);
        assert.equal(bytes.toString(),"S".repeat(16));
      } finally { fs.closeSync(stream); }
      const sequential=fs.openSync(base+"/GeneratedCatalog/SequentialStream.bin","r");
      try {
        const bytes=Buffer.alloc(1);
        assert.equal(fs.readSync(sequential,bytes,0,1,0),1);
        assert.throws(()=>fs.readSync(sequential,bytes,0,1,0),{code:"ESPIPE"});
        assert.equal(fs.readSync(sequential,bytes,0,1,1),1);
      } finally { fs.closeSync(sequential); }

      const before=base+"/Tools/Memory/before";
      const after=base+"/Tools/Memory/after";
      fs.mkdirSync(before);
      const directory=fs.openSync(before,"r");
      const handle=fs.openSync(before+"/file","wx+");
      try {
        fs.writeSync(handle,"original",0);
        fs.fsyncSync(handle);
        fs.fchmodSync(handle,0o600);
        fs.fchownSync(handle,123,456);
        fs.futimesSync(handle,new Date(100125),new Date(200750));
        assert.equal(fs.fstatSync(handle).mode&0o777,0o600);
        assert.equal(fs.fstatSync(handle).uid,123);
        assert.equal(fs.fstatSync(handle).gid,456);
        assert.equal(fs.fstatSync(handle).mtimeMs,200750);
        fs.renameSync(before,after);
        fs.fsyncSync(directory);
        fs.unlinkSync(after+"/file");
        fs.writeFileSync(after+"/file","replacement");
        fs.ftruncateSync(handle,3);
        const bytes=Buffer.alloc(3);
        assert.equal(fs.readSync(handle,bytes,0,3,0),3);
        assert.equal(bytes.toString(),"ori");
        assert.equal(fs.readFileSync(after+"/file","utf8"),"replacement");
      } finally { fs.closeSync(handle); fs.closeSync(directory); }
      fs.unlinkSync(after+"/file");
      fs.rmdirSync(after);
      assert.throws(()=>fs.writeFileSync("/scriptfs/overlays/1/README.txt","no"),{code:"EROFS"});
      `,
    ]);
  } finally {
    await running.stop();
  }
}, 60_000);

/**
 * Declares one module instance per export the rules use. The default export is
 * referenced by package name; named exports use manifests next to it.
 */
async function moduleInstances(
  directory: string,
  input: ScriptFsConfig,
): Promise<NonNullable<ScriptFsConfig["modules"]>> {
  const names = new Set(
    input.filesystems.flatMap((filesystem) =>
      (filesystem.rules ?? []).flatMap((rule) =>
        "provider" in rule && "module" in rule.provider
          ? [rule.provider.module]
          : [],
      ),
    ),
  );
  const modules: NonNullable<ScriptFsConfig["modules"]> = {};
  for (const name of names) {
    const file =
      name === "provider" ? "scriptfs.module.json" : `${name}.module.json`;
    await writeFile(
      path.join(directory, file),
      JSON.stringify({
        name,
        entry: "./index.mjs",
        ...(name === "provider" ? {} : { export: name }),
      }),
    );
    modules[name] = {
      manifest:
        name === "provider" ? "provider" : `./node_modules/provider/${file}`,
    };
  }
  return modules;
}

function providerSource(): string {
  return `
import { value } from "helper";
import { open, appendFile, chmod, readFile, readlink, readdir, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
setFlagsFromString("--expose-gc");
const gc=runInNewContext("gc");
export const contentOnly={readFile(){return "GENERATED-CONTENTS";}};
export const contentOnlyResource={...contentOnly,open(){return {};}};
export const shortReads={
  getattr({path}){return {kind:"file",identity:path,size:6};},
  read(position,length,{path}){
    if(path==="ShortReadsError"&&position>0)
      throw Object.assign(new Error("Continuation failed"),{code:"EIO"});
    return Buffer.from("abcdef").subarray(position,position+Math.min(length,2));
  },
};
const flagEntries=new Map();
export const createFlags={
  getattr({relativePath}){
    if(!relativePath)return {kind:"directory"};
    const entry=flagEntries.get(relativePath);
    if(entry)return {kind:"file",identity:relativePath,size:entry.contents.length};
  },
  readdir(){return [...flagEntries.keys()];},
  async create(_metadata,{relativePath,flags}){
    const modes={readonly:0,writeonly:1,readwrite:2,append:1,sync:1};
    if((flags&3)!==modes[relativePath])
      throw Object.assign(new Error("Incorrect create access mode"),{code:"EACCES"});
    if(relativePath==="append"&&!(flags&0x400))throw new Error("Append flag missing");
    if(relativePath==="sync"&&(flags&0x101000)!==0x101000)throw new Error("Sync flag missing");
    await appendFile("/scriptfs/sources/0/create-flag-events",JSON.stringify({name:relativePath,flags})+"\\n");
    const entry={name:relativePath,flags,contents:Buffer.alloc(0)};
    flagEntries.set(relativePath,entry);
    return entry;
  },
  fgetattr({handle}){return {kind:"file",identity:handle.name,size:handle.contents.length};},
  read(position,length,{handle,flags}){
    if(flags!==handle.flags)throw new Error("Read flags changed");
    return handle.contents.subarray(position,position+length);
  },
  write(contents,position,{handle,flags}){
    if(flags!==handle.flags)throw new Error("Write flags changed");
    const next=Buffer.alloc(Math.max(handle.contents.length,position+contents.length));
    handle.contents.copy(next);
    contents.copy(next,position);
    handle.contents=next;
    return contents.length;
  },
  release({handle,flags}){if(flags!==handle.flags)throw new Error("Release flags changed");},
};
export const layeredBase={
  getattr({relativePath}){return relativePath===""?{kind:"directory"}:{kind:"file",size:4};},
  readdir(){return ["base.txt"];},
  readFile(){return "base";},
};
export const layeredExtra={
  getattr(){return {kind:"file",size:2};},
  readdir(){return ["extra.json","hidden.json","masked.json","outside.txt"];},
  readFile(){return "{}";},
};
const active=new Set();
let released=0;
let failLookup=false;
async function acquireHookResource() {
  const handle=await open("/scriptfs/sources/0/hook-resource","w+");
  active.add(handle);
  return handle;
}
async function releaseHookResource({handle}) {
  if(!handle)return;
  await handle.close();
  if(handle.fd!==-1)throw new Error("hook resource still open");
  active.delete(handle);
}
export const openHook={open:acquireHookResource,release:releaseHookResource};
export const slowOpen={
  getattr(){return {kind:"file",size:0};},
  async open(){
    const handle=await acquireHookResource();
    await new Promise(resolve=>setTimeout(resolve,16000));
    return handle;
  },
  release:releaseHookResource,
};
export const brokenOpen={
  open(){throw Object.assign(new Error("injected open failure"),{code:"EACCES"});},
};
export const createHook={
  async create(_metadata,{sourcePath}){const source=await open(sourcePath,"wx");await source.close();return acquireHookResource();},
  release:releaseHookResource,
};
export const brokenHook={create:acquireHookResource,release:releaseHookResource};
export const replacedCreate={
  async open({sourcePath}){
    await writeFile(sourcePath+"-replacement","concurrent replacement");
    await rename(sourcePath+"-replacement",sourcePath);
    throw Object.assign(new Error("injected open failure"),{code:"EACCES"});
  },
};
export const diagnostics={
  getattr(){return {kind:"file",size:512};},
  readFile(){gc();return JSON.stringify({buffers:process.memoryUsage().arrayBuffers,active:active.size,released}).padEnd(512," ");},
};
export const shutdownSignal={
  getattr({signal}){
    signal.addEventListener("abort",()=>writeFileSync("/scriptfs/sources/0/provider-aborted","aborted"),{once:true});
    return {kind:"file",size:0};
  },
};
export const brokenCreate={
  getattr(){if(failLookup){failLookup=false;throw Object.assign(new Error("metadata failure"),{code:"EACCES"});}},
  async create(){const handle=await open("/scriptfs/sources/0/leaked-resource","w+");active.add(handle);failLookup=true;return handle;},
  async release({handle}){await handle.close();if(handle.fd!==-1)throw new Error("descriptor still open");active.delete(handle);released++;},
};
export const nativeProvider={
  async getattr(){const metadata=await stat("/scriptfs/sources/0/native-target");return {kind:"file",size:metadata.size};},
  async fgetattr({handle}){return {kind:"file",size:(await handle.stat()).size};},
  open(){return open("/scriptfs/sources/0/native-target","r+");},
  ftruncate(size,{handle}){return handle.truncate(size);},
  async read(position,length,{handle}){const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,position);return buffer.subarray(0,bytesRead);},
  release({handle}){return handle.close();},
};
export const metadataFile={
  getattr(){return {kind:"file",mode:0o600};},
};
export const mutableMetadataFile={
  async getattr({sourcePath}){
    return {kind:"file",size:(await stat(sourcePath)).size,mode:0o750,mtime:new Date(1000)};
  },
};
export const localIdentity={
  getattr({options}){return {kind:"file",identity:"resource:1",size:options.length};},
  readFile({options}){return options;},
};
const ownershipEntries=new Map([
  ["",{kind:"directory",identity:"ownership-root",uid:111,gid:222}],
  ["file",{kind:"file",identity:"ownership-file",size:1,uid:111,gid:222}],
  ["directory",{kind:"directory",identity:"ownership-directory",uid:111,gid:222}],
  ["link",{kind:"symlink",identity:"ownership-link",target:"file",uid:111,gid:222}],
]);
export const partialOwnership={
  getattr({relativePath}){return ownershipEntries.get(relativePath);},
  readdir({relativePath}){return relativePath===""?["file","directory","link"]:[];},
  readFile(){return "X";},
  chown(uid,gid,{relativePath}){
    const resource=ownershipEntries.get(relativePath);
    if(uid!==-1)resource.uid=uid;
    if(gid!==-1)resource.gid=gid;
  },
};
const shadowOriginal={kind:"file",identity:"shadow-original",contents:"GENERATED"};
const shadowEntries=new Map([
  ["",{kind:"directory",identity:"shadow-root"}],
  ["file",shadowOriginal],
  ["alias",shadowOriginal],
  ["directory",{kind:"directory",identity:"shadow-directory"}],
  ["link",{kind:"symlink",identity:"shadow-link",target:"file"}],
  ["replacement",{kind:"file",identity:"shadow-replacement",contents:"NEW"}],
  ["replacement-directory",{kind:"directory",identity:"shadow-replacement-directory"}],
]);
export const moduleShadow={
  getattr({relativePath}){
    const resource=shadowEntries.get(relativePath);
    return resource&&{...resource,size:resource.contents?.length??0,
      nlink:resource.kind==="directory"?2:[...shadowEntries.values()].filter(value=>value===resource).length};
  },
  readdir({relativePath}){return relativePath===""?[...shadowEntries.keys()].filter(Boolean):[];},
  readFile({relativePath}){return shadowEntries.get(relativePath).contents;},
  writeFile(contents,{relativePath}){shadowEntries.get(relativePath).contents=contents.toString();},
  unlink({relativePath}){shadowEntries.delete(relativePath);},
  rmdir({relativePath}){shadowEntries.delete(relativePath);},
  rename({relativePath,destinationRelativePath}){
    const resource=shadowEntries.get(relativePath);
    if(resource===shadowEntries.get(destinationRelativePath))return;
    shadowEntries.set(destinationRelativePath,resource);
    shadowEntries.delete(relativePath);
  },
};
let capturedAttributesMetadata={kind:"file",identity:"captured-attributes",size:0,mode:0o644};
export const capturedAttributes={
  getattr(){return {...capturedAttributesMetadata};},
  open(){return {};},
  fsetattr(changes){Object.assign(capturedAttributesMetadata,changes);},
};
const retainedDirectoryEntries=new Map([["",{kind:"directory",mode:0o755}]]);
export const retainedDirectories={
  getattr({relativePath}){return retainedDirectoryEntries.get(relativePath);},
  readdir({relativePath}){return relativePath===""?[...retainedDirectoryEntries.keys()].filter(Boolean):[];},
  mkdir(metadata,{relativePath}){retainedDirectoryEntries.set(relativePath,metadata);},
  rmdir({relativePath}){retainedDirectoryEntries.delete(relativePath);},
  rename({relativePath,destinationRelativePath}){
    const metadata=retainedDirectoryEntries.get(relativePath);
    retainedDirectoryEntries.delete(relativePath);
    retainedDirectoryEntries.set(destinationRelativePath,metadata);
  },
};
const mixedWriteOnlyTarget="/scriptfs/sources/0/mixed-writeonly";
export const writeOnlyMixed={
  async getattr(){return {kind:"file",size:(await stat(mixedWriteOnlyTarget)).size};},
  async open({flags}){
    const handle=await open(mixedWriteOnlyTarget,flags);
    await appendFile("/scriptfs/sources/0/mixed-open-events",JSON.stringify({operation:"open",flags})+"\\n");
    return handle;
  },
  fgetattr:nativeProvider.fgetattr,
  read:nativeProvider.read,
  writeFile(contents){return writeFile(mixedWriteOnlyTarget,contents);},
  async release({handle,flags}){
    await handle.close();
    await appendFile("/scriptfs/sources/0/mixed-open-events",JSON.stringify({operation:"release",flags})+"\\n");
  },
};
export const metadataDirectory={
  getattr({relativePath}){if(relativePath==="")return {kind:"directory",mode:0o750};},
  readdir(){return [];},
};
export const unavailable={
  getattr(){throw Object.assign(new Error("unavailable superseded provider"),{code:"EIO"});},
};
export const retainedWhole={
  readFile({sourcePath}){return readFile(sourcePath);},
  writeFile(contents,{sourcePath}){return writeFile(sourcePath,contents);},
};
export const backedWhole={
  ...retainedWhole,
  async getattr({sourcePath}) {
    const metadata=await stat(sourcePath);
    return {kind:"file",size:metadata.size,mtime:metadata.mtime,ctime:metadata.ctime};
  },
};
export const finalRelease={
  release({sourcePath,flags}){
    if(sourcePath.endsWith("/retained-final"))
      return writeFile(sourcePath+".released",String(flags&3));
  },
};
export const identityWhole={
  ...retainedWhole,
  ...finalRelease,
  async getattr({sourcePath}) {
    try {
      const metadata=await stat(sourcePath,{bigint:true});
      return {
        kind:metadata.isDirectory()?"directory":"file",
        identity:metadata.dev+":"+metadata.ino,
        nlink:Number(metadata.nlink),size:Number(metadata.size),
        mtime:metadata.mtime,ctime:metadata.ctime
      };
    } catch(error) {
      if(error.code==="ENOENT")return;
      throw error;
    }
  },
  readdir({sourcePath}){return readdir(sourcePath);},
  truncate(size,{sourcePath}){return truncate(sourcePath,size);},
  unlink({sourcePath}){return unlink(sourcePath);},
  rename({sourcePath,destinationPath}){return rename(sourcePath,"/scriptfs/sources/0/"+destinationPath);},
};
export const pathMetadata={
  getattr:identityWhole.getattr,
  async fsetattr(changes,{sourcePath}){
    if(changes.mode!==undefined)await chmod(sourcePath,changes.mode&0o7777);
  },
  ftruncate(size,{sourcePath}){return truncate(sourcePath,size);},
};
export const identityPosition={
  getattr:identityWhole.getattr,
  fsetattr:pathMetadata.fsetattr,
  readdir:identityWhole.readdir,
  unlink:identityWhole.unlink,
  rename:identityWhole.rename,
  async read(position,length,{sourcePath}){
    return (await readFile(sourcePath)).subarray(position,position+length);
  },
  async write(contents,position,{sourcePath}){
    const handle=await open(sourcePath,"r+");
    try {return (await handle.write(contents,0,contents.length,position)).bytesWritten;}
    finally {await handle.close();}
  },
};
export const replaceDuringOpen={
  async open({sourcePath,flags}){
    if(!(flags&0x200))throw new Error("Truncation flag missing");
    await rename(sourcePath+".replacement",sourcePath);
  },
  release({sourcePath}){return writeFile(sourcePath+".released","released");},
};
export const shortSnapshot={
  getattr:identityWhole.getattr,
  writeFile:identityWhole.writeFile,
  async read(position,length,{sourcePath}){
    const contents=await readFile(sourcePath);
    if(position===0)await rename(sourcePath+".replacement",sourcePath);
    return contents.subarray(position,position+Math.min(length,2));
  },
};
export const inferred={
  getattr({relativePath}) {
    if(relativePath==="")return {kind:"directory"};
    if(relativePath==="data.txt")return {kind:"file",size:8};
  },
  readdir({relativePath}){if(relativePath==="")return ["data.txt"];},
  readFile(){return "inferred";},
};
let linkTarget="original-target";
export const mutableLink={
  getattr(){return {kind:"symlink",identity:"mutable-link",target:linkTarget,size:linkTarget.length};},
};
export const changeLink={
  getattr(){return {kind:"file",size:0,sizeMode:"zero"};},
  writeFile(contents){linkTarget=contents.toString();},
};
export const retainedPosition={
  open({sourcePath}){return open(sourcePath,"r+");},
  opendir({sourcePath}){return open(sourcePath,"r");},
  read:nativeProvider.read,
  async write(contents,position,{handle}){return (await handle.write(contents,0,contents.length,position)).bytesWritten;},
  async fgetattr({handle}){const metadata=await handle.stat();return {kind:metadata.isDirectory()?"directory":"file",size:metadata.size};},
  ftruncate:nativeProvider.ftruncate,
  release:nativeProvider.release,
  releasedir:nativeProvider.release,
};
export const emptyTree={
  getattr({relativePath}){if(relativePath==="")return {kind:"directory"};},
  readdir(){return [];},
};
export const unsupportedSync={
  fsync(){throw Object.assign(new Error("provider synchronization unsupported"),{code:"ENOSYS"});},
};
export const writeOnly={
  getattr(){const timestamp=new Date(0);return {kind:"file",mode:0o200,size:0,sizeMode:"zero",atime:timestamp,mtime:timestamp,ctime:timestamp,birthtime:timestamp};},
  readFile(){throw Object.assign(new Error("write only"),{code:"EACCES"});},
  writeFile(contents,{sourcePath}){writeFileSync(sourcePath+"-received",contents);},
};
const listedNames=new Set(Array.from({length:1000},(_,index)=>"item-"+String(index).padStart(4,"0")));
export const mutableListing={
  getattr({relativePath}){
    if(relativePath==="")return {kind:"directory"};
    if(listedNames.has(relativePath))return {kind:"file",size:0};
  },
  readdir({relativePath}){if(relativePath==="")return [...listedNames].sort();},
  create(_metadata,{relativePath}){listedNames.add(relativePath);},
  unlink({relativePath}){listedNames.delete(relativePath);},
};
export default {
  getattr() { return { kind: "file", size: value.length }; },
  readFile() { return value; },
};
export const additive = {};
const additiveEntries=new Map([["generated.txt",Buffer.from("GENERATED")]]);
export const additiveTree={
  getattr({relativePath}){
    const contents=additiveEntries.get(relativePath);
    if(contents)return {kind:"file",size:contents.length};
  },
  readdir({relativePath}){if(relativePath==="")return [...additiveEntries.keys()];},
  readFile({relativePath}){
    const contents=additiveEntries.get(relativePath);
    if(!contents)throw Object.assign(new Error("Not generated"),{code:"ENOENT"});
    return contents;
  },
  writeFile(contents,{relativePath}){
    if(!additiveEntries.has(relativePath)&&relativePath!=="provider-created.txt")
      throw Object.assign(new Error("Not generated"),{code:"ENOENT"});
    additiveEntries.set(relativePath,Buffer.from(contents));
  },
};
let wholeContents=Buffer.from("abcdef");
export const whole={
  getattr(){return {kind:"file",size:wholeContents.length};},
  readFile(){return wholeContents;},
  writeFile(value){wholeContents=Buffer.from(value);},
};
const wholeEntries=new Map();
export const wholeFiles={
  getattr({relativePath}){
    if(relativePath==="")return {kind:"directory"};
    const contents=wholeEntries.get(relativePath);
    if(contents)return {kind:"file",size:contents.length};
  },
  readdir(){return [...wholeEntries.keys()];},
  open(){return {};},
  readFile({relativePath}){
    const contents=wholeEntries.get(relativePath);
    if(!contents)throw Object.assign(new Error("missing"),{code:"ENOENT"});
    return contents;
  },
  writeFile(contents,{relativePath}){wholeEntries.set(relativePath,Buffer.from(contents));},
  unlink({relativePath}){wholeEntries.delete(relativePath);},
  rename({relativePath,destinationRelativePath}){
    const contents=wholeEntries.get(relativePath);
    if(!contents)throw Object.assign(new Error("missing"),{code:"ENOENT"});
    wholeEntries.set(destinationRelativePath,contents);
    wholeEntries.delete(relativePath);
  },
};
const sequentialEntries=new Set(["data"]);
export const sequential={
  getattr({relativePath}){
    if(relativePath==="")return {kind:"directory"};
    if(sequentialEntries.has(relativePath))return {kind:"file",size:4096,seekable:false};
  },
  readdir(){return [...sequentialEntries];},
  open(){return {};},
  create(_metadata,{relativePath}){sequentialEntries.add(relativePath);return {};},
  read(_position,length){return Buffer.alloc(length,"Q");},
};
let mixedContents=Buffer.from("abcdef");
export const mixed={
  getattr(){return {kind:"file",size:mixedContents.length};},
  read(position,length){return mixedContents.subarray(position,position+length);},
  writeFile(value){mixedContents=Buffer.from(value);},
};
const mixedWriterEntries=new Map();
for(const mutation of ["unlink","replace"]) {
  const name="MixedWriter-"+mutation;
  mixedWriterEntries.set(name,{identity:name,contents:Buffer.from("ORIGINAL")});
  mixedWriterEntries.set(name+"-replacement",{identity:name+"-replacement",contents:Buffer.from("NEW")});
}
const mixedWriterMetadata=entry=>({kind:"file",identity:entry.identity,size:entry.contents.length});
export const mixedWriter={
  getattr({path}){const entry=mixedWriterEntries.get(path);return entry&&mixedWriterMetadata(entry);},
  open({path}){return mixedWriterEntries.get(path);},
  fgetattr({handle}){return mixedWriterMetadata(handle);},
  readFile({path}){
    const entry=mixedWriterEntries.get(path);
    if(!entry)throw Object.assign(new Error("missing"),{code:"ENOENT"});
    return entry.contents;
  },
  write(contents,position,{handle}){
    const next=Buffer.alloc(Math.max(handle.contents.length,position+contents.length));
    handle.contents.copy(next);
    contents.copy(next,position);
    handle.contents=next;
    return contents.length;
  },
  ftruncate(size,{handle}){
    const next=Buffer.alloc(size);
    handle.contents.copy(next);
    handle.contents=next;
  },
  fsync(_dataSync,{handle}){return writeFile("/scriptfs/sources/0/"+handle.identity+"-persisted",handle.contents);},
  unlink({path}){mixedWriterEntries.delete(path);},
  rename({path,destinationPath}){
    const entry=mixedWriterEntries.get(path);
    if(!entry)throw Object.assign(new Error("missing"),{code:"ENOENT"});
    mixedWriterEntries.set(destinationPath,entry);
    mixedWriterEntries.delete(path);
  },
};
let accessTime=new Date();
let modificationTime=new Date();
export const timestamps={
  getattr(){return {kind:"file",size:0,atime:accessTime,mtime:modificationTime};},
  utimens(atime,mtime){
    if(!(atime instanceof Date) || !(mtime instanceof Date))throw new TypeError("Expected Dates");
    accessTime=atime;modificationTime=mtime;
  },
};
const resources = new Map([
  ["data", {contents: Buffer.from("OLD data")}],
  ["replacement", {contents: Buffer.from("replacement")}],
]);
export const positional = {
  getattr({relativePath}) {
    if (relativePath === "") return {kind:"directory"};
    const resource = resources.get(relativePath);
    if (resource) return {kind:"file",size:resource.contents.length};
  },
  readdir({relativePath}) { if(relativePath === "") return [...resources.keys()]; },
  open({relativePath}) { return resources.get(relativePath); },
  fgetattr({handle}) {return {kind:"file",size:handle.contents.length};},
  create(_metadata,{relativePath}) {
    const resource = {contents:Buffer.alloc(0)};
    resources.set(relativePath,resource);
    return resource;
  },
  read(position,length,{handle}) { return handle.contents.subarray(position,position+length); },
  write(value,position,{handle}) {
    const next = Buffer.alloc(Math.max(handle.contents.length,position+value.length));
    handle.contents.copy(next);
    value.copy(next,position);
    handle.contents = next;
    return value.length;
  },
  truncate(size,{relativePath}) {
    const resource = resources.get(relativePath);
    const next = Buffer.alloc(size);
    resource.contents.copy(next,0,0,Math.min(size,resource.contents.length));
    resource.contents = next;
  },
  ftruncate(size,{handle}) {
    const next=Buffer.alloc(size);
    handle.contents.copy(next,0,0,Math.min(size,handle.contents.length));
    handle.contents=next;
  },
  unlink({relativePath}) { resources.delete(relativePath); },
  rename({relativePath,destinationRelativePath}) {
    const resource = resources.get(relativePath);
    resources.set(destinationRelativePath,resource);
    resources.delete(relativePath);
  },
};
const capturedResource={contents:Buffer.from("abcdef")};
export const capturedSize={
  getattr(){return {kind:"file",size:capturedResource.contents.length};},
  open(){return capturedResource;},
  read:positional.read,
  write:positional.write,
  ftruncate:positional.ftruncate,
};
export const tree = {
  getattr({relativePath}) {
    if (relativePath === "") return {kind:"directory"};
    if (relativePath === "visible") return {kind:"file", size:7};
  },
  readdir({relativePath}) { if (relativePath === "") return ["visible"]; },
  readFile() { return "visible"; },
};
let contents = Buffer.from("0000");
export const slow = {
  getattr() { return {kind:"file", size:4}; },
  readFile() { return contents; },
  async writeFile(value) {
    await new Promise(resolve => setTimeout(resolve, 200));
    contents = Buffer.from(value);
  },
};
`;
}
