# ScriptFS

`ScriptFS` creates programmable overlays on local directories. Each source
directory is bind-mounted into a Podman container, exposed through a FUSE
filesystem, exported by Samba, and mounted back on the host.

```sh
scriptfs /path/to/config.json
```

The CLI stays in the foreground and unmounts the SMB shares and stops the
container on `Ctrl+C`.

## Contents

- [Motivation](#motivation)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Provider API](#provider-api)
- [Filesystem behavior](#filesystem-behavior)
- [Runtime lifecycle](#runtime-lifecycle)
- [Host requirements](#host-requirements)
- [Development](#development)

## Motivation

Agents already work effectively with filesystem operations: they can discover
directories, search paths, read contextual instructions, and write results.
ScriptFS uses that familiar interface to present the exact workspace an agent
needs without requiring every resource to exist as a regular repository file.

For example, a ScriptFS overlay can:

- expose only the relevant part of a large repository and hide files that
  would distract the agent
- add topic-specific `AGENTS.md` files to selected directories without
  modifying or committing them to the source repository
- adapt a repository for Claude Code by automatically presenting `AGENTS.md`
  as `CLAUDE.md` and `.agents/skills/` as `.claude/skills/` in the mounted view.
  For example, `.agents/skills/code-review/SKILL.md` becomes available at
  `.claude/skills/code-review/SKILL.md`, along with its supporting files,
  without creating or copying any of these paths into the source repository
- override generated configuration or documentation while preserving
  transparent access to unmatched source files
- expose dynamic systems such as chats, databases, queues, or service APIs as
  a navigable directory tree

A dynamic tree can provide readable files for queries and messages, writable
files for commands or updates, and an `AGENTS.md` at its root explaining the
available paths and operations. This lets an agent interact with external data
using the same filesystem tools it already understands. Hide and overlay rules
shape the mounted view, but they should not be treated as a security boundary.

## Architecture

```text
local source directories and provider modules
                      |
                Podman bind mounts
                      |
        ScriptFS overlay inside Linux container
                      |
                 Linux FUSE mount
                      |
                 Samba SMB share
                      |
        host SMB client and local mount point
```

ScriptFS uses FUSE inside the Linux container, where `/dev/fuse` is provided by
the Podman machine. It deliberately does not mount FUSE directly on the host.
In particular, direct FUSE mounting on macOS would require macFUSE and its
invasive system extension, which is disabled by default and requires additional
system configuration and approval.

Samba provides a less invasive host boundary using the SMB clients already
available on macOS, Linux, and Windows. This keeps provider and overlay behavior
inside one consistent Linux runtime and avoids requiring a platform-specific
filesystem driver on every host. The tradeoff is that some metadata, caching,
locking, and permission behavior is determined by the host SMB client rather
than FUSE alone.

At runtime, ScriptFS bind-mounts source directories, provider project roots, and
directory proxy targets into the container. File proxies mount their parent
directories so atomic replacement of the target remains visible. Provider
project mounts include ancestor dependency directories, preserving ordinary
npm, pnpm, and workspace dependency layouts; dependencies must be compatible
with the Linux runtime. These mounts are available to trusted provider code,
not just the paths exposed in the overlay. The TypeScript overlay
resolves each path against ordered rules, falls back to the source when
permitted, and serves the resulting filesystem through FUSE. Samba exports each
configured overlay as a separate share, and the host adapter mounts those
shares at the configured mount points.

## Configuration

```json
{
  "$schema": "./node_modules/scriptfs/scriptfs.schema.json",
  "filesystems": [
    {
      "name": "code",
      "source": "/path/to/my/codebase",
      "mountPoint": "/path/to/mounted-codebase",
      "readOnly": false,
      "rules": [
        {
          "match": "components/*/AGENTS.md",
          "provider": {
            "type": "module",
            "module": "./providers/component-agents.mjs",
            "export": "componentInstructions",
            "options": {
              "topic": "frontend components"
            }
          }
        },
        {
          "match": "GeneratedCatalog/**",
          "root": "GeneratedCatalog",
          "opaque": true,
          "provider": {
            "type": "module",
            "module": "./providers/catalog.mjs",
            "options": {
              "endpoint": "https://example.invalid"
            }
          }
        },
        {
          "match": "GeneratedCatalog/**/action.txt",
          "file": {
            "mode": 128,
            "size": 0,
            "sizeMode": "zero",
            "seekable": false
          },
          "provider": {
            "type": "module",
            "module": "./providers/catalog.mjs",
            "export": "actionProvider"
          }
        },
        {
          "match": "CurrentSettings.json",
          "provider": {
            "type": "file",
            "path": "./settings.json"
          }
        },
        {
          "match": "ReferenceData/**",
          "root": "ReferenceData",
          "opaque": true,
          "provider": {
            "type": "directory",
            "path": "./reference-data"
          }
        },
        {
          "match": "**/*.private",
          "hide": true
        }
      ]
    }
  ]
}
```

Paths are resolved relative to the config file. Provider modules may be file
paths or installed package names. `match` uses picomatch glob syntax. Later
rules win for path operations. Virtual paths, rule roots, and glob patterns use
POSIX `/` separators, regardless of the host platform. Backslashes in source
and proxy filenames remain literal characters rather than directory separators.
Directory enumeration skips metadata callbacks for hidden or superseded exact
entries.

Literal punctuation such as `+`, `@`, and embedded `!` is preserved in generated
exact entries and inferred roots; only actual picomatch glob expressions are
treated as patterns. Backslashes in patterns escape characters, including
another backslash.

- A provider rule adds or overrides matching paths.
- `root` identifies the provider-relative root for a generated subtree.
- `opaque` prevents fallback to the source when the provider does not return a
  path or implement an operation.
- A hide rule removes matching source or generated paths.
- Rules without `opaque` preserve normal reads and writes for unmatched source
  paths.

### Complete runnable example

[`examples/config.json`](examples/config.json) exercises every configuration
field:

- writable and read-only filesystems
- additive, opaque, exact, glob, and hide rules
- default and named module exports with provider options
- `content`, `explicit`, `zero`, and `unbounded` file-size modes
- seekable and non-seekable files
- transparent host file proxies, opaque directory proxies, and merged source/proxy directories
- synthesized ancestors, generated symlinks, and hidden generated entries
- whole-file creation and positional resources with stable identities
- file/directory lifecycle, synchronization, metadata, and shutdown callbacks
- every container setting

Its source and proxy targets are under `examples/fixtures`, while its generated
mount points are ignored. After building, run it on macOS or Linux with:

```sh
pnpm build
node dist/cli.js examples/config.json
```

The example reserves host SMB port `14445`; change or remove `smbPort` if that
port is unavailable. On Windows, use drive letters for `mountPoint` and set
`smbPort` to `445`.

The providers are deliberately local and require no service credentials. Generated
data is **in memory and resets when the session stops**. Source and proxy writes
modify the fixture files on disk. The example's memory-provider sync callbacks
acknowledge its current state and log the operation; they do not provide disk
durability.

| Mounted path                            | Demonstrates                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/Button/AGENTS.md`           | Additive instructions from the default export and provider options; no source file is required for access checks.                                       |
| `GeneratedCatalog/ContentSized.txt`     | Read/write whole-file contents with content-derived size. New files directly under `GeneratedCatalog` use the `writeFile` creation fallback.            |
| `GeneratedCatalog/FixedSize.bin`        | Initially 16 `F` bytes; positional writes and truncation really update the retained buffer and reported size.                                           |
| `GeneratedCatalog/CommandSink.txt`      | Write-only, zero-sized, non-seekable command sink. Truncating an existing sink does not send an empty command.                                          |
| `GeneratedCatalog/GeneratedStream.bin`  | Unbounded, seekable generated `S` bytes. **Always bound reads; do not use `cat`, `readFile`, or copy the whole file.**                                  |
| `GeneratedCatalog/SequentialStream.bin` | Finite, non-seekable generated `Q` bytes; repeated or skipped offsets fail at the FUSE boundary.                                                        |
| `Tools/Memory`                          | Synthesized `Tools` ancestor; a mutable tree with create, mkdir, rename, unlink, rmdir, metadata, stable file/directory handles, and lifecycle logging. |
| `Tools/Memory/latest`                   | Generated relative symlink to `data.txt`.                                                                                                               |
| `*.native`                              | Native source I/O with custom open/create, sync, and release hooks.                                                                                     |
| `ProxiedFile.txt`, `ProxiedDirectory`   | Fixed file proxy and opaque writable directory proxy.                                                                                                   |
| `MergedDirectory`                       | Source-only children remain visible, overlapping children come from the proxy, and new children use their parent directory's backing.                   |
| `*.private`                             | Hidden in both source and generated trees.                                                                                                              |
| `examples/mount-readonly`               | Separate read-only share.                                                                                                                               |

With the CLI running in another terminal, this bounded workflow only changes
in-memory data:

```sh
cat examples/mount/components/Button/AGENTS.md
printf 'updated\n' > examples/mount/GeneratedCatalog/ContentSized.txt
printf 'run\n' > examples/mount/GeneratedCatalog/CommandSink.txt

node --input-type=module <<'JS'
import { mkdtemp, open, readFile, rename, unlink, rmdir } from "node:fs/promises";

const root = "examples/mount/Tools/Memory";
const directory = await mkdtemp(`${root}/demo-`);
const original = `${directory}/original.txt`;
const renamed = `${directory}/renamed.txt`;
const handle = await open(original, "wx+");
try {
  await handle.write(Buffer.from("hello"), 0, 5, 0);
  await handle.truncate(3);
  await handle.sync();
  console.log("size:", (await handle.stat()).size);
} finally {
  await handle.close();
}
await rename(original, renamed);
console.log("contents:", await readFile(renamed, "utf8"));
await unlink(renamed);
await rmdir(directory);

const stream = await open("examples/mount/GeneratedCatalog/GeneratedStream.bin", "r");
try {
  const bytes = Buffer.alloc(16);
  await stream.read(bytes, 0, bytes.length, 100);
  console.log("bounded stream sample:", bytes.toString());
} finally {
  await stream.close();
}
JS
```

Host SMB clients may impose their own symlink, seek, metadata, and directory-sync
semantics. The provider and end-to-end suites also exercise these operations
directly through Linux FUSE, including open handles retained after unlink or
replacement. Watch the CLI's forwarded logs for memory and source lifecycle
callbacks and the memory provider's shutdown notification.

### Configuration fields

#### Top-level keys

| Key           | Required | Default | Meaning                                                                |
| ------------- | -------- | ------- | ---------------------------------------------------------------------- |
| `$schema`     | No       | None    | JSON Schema path used by editors; ScriptFS ignores it at runtime.      |
| `filesystems` | Yes      | None    | Non-empty array of source filesystems and their mounted overlay views. |
| `container`   | No       | `{}`    | Runtime image, SMB connection, rebuild, and logging configuration.     |

#### Filesystem keys

| Key          | Required | Default | Meaning                                                                              |
| ------------ | -------- | ------- | ------------------------------------------------------------------------------------ |
| `name`       | Yes      | None    | SMB share name containing only letters, numbers, `_`, and `-`.                       |
| `source`     | Yes      | None    | Local source path, resolved relative to the config file.                             |
| `mountPoint` | Yes      | None    | Host mount directory, resolved relative to the config, or a drive letter on Windows. |
| `readOnly`   | No       | `false` | Mount the source read-only and reject mutations through this overlay.                |
| `rules`      | No       | `[]`    | Ordered provider and hide rules. Later matching provider rules win path operations.  |

Each filesystem must use a distinct `mountPoint` and a share name that is unique
case-insensitively, matching SMB name resolution. Share names must not be
`global`, `homes`, or `printers` in any letter case; Samba reserves those
configuration sections.

#### Provider rule keys

| Key        | Required | Default                  | Meaning                                                                                          |
| ---------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `match`    | Yes      | None                     | Virtual-path pattern using picomatch glob syntax.                                                |
| `provider` | Yes      | None                     | Module, host-file proxy, or host-directory proxy used for matching paths.                        |
| `root`     | No       | Static prefix of `match` | Virtual subtree root used to calculate `context.relativePath` and expose generated roots.        |
| `opaque`   | No       | `false`                  | If `true`, do not fall back to the source when the provider does not supply a path or operation. |
| `file`     | No       | `{}`                     | Default metadata and I/O behavior applied to matching provider files.                            |

Provider rules add or override matching paths. Rules are evaluated in array
order, with later matching provider rules taking precedence for path
operations. This allows a broad generated subtree rule to be followed by more
specific rules for command files or positional streams.

**Source fallback.**
For a nonopaque module rule, an implemented `getattr` returning `undefined`
for an existing source node selects native source backing for its operations.
Omitting `getattr` instead keeps content-only and lifecycle-only overlays active.

**Content-only overlays.**
For existing source files served by custom I/O callbacks without `getattr`,
rule `file` defaults override inherited source metadata. Unless the rule specifies
a size or another size policy, `readFile` supplies the content-derived size,
including when the source file is empty or has a different length. Unspecified
native attributes and identity are retained. Lifecycle-only hooks keep native
file sizing; directories, symlinks, and missing paths do not derive metadata from
file content callbacks.

**Creation.**
New entries use source backing when their parent is a matching source-only
directory; exact generated-entry rules and provider-owned directories still
dispatch creation to the provider. Lookup errors propagate rather than triggering
fallback.

**Directory enumeration.**
Directory enumeration includes the selected directory provider's entries and
matching immediate children contributed by later rules, including wildcard
rules. Earlier directory providers remain superseded, and hide rules and
winning child metadata still determine which entries are visible.

**Inferred roots.**
An opaque rule's inferred root can expose a missing parent directory even when
the glob does not match the parent itself, such as `Generated/*.txt`. This
fallback does not override an existing source directory or a directly matching
provider rule. Set `root` explicitly when the rule should own that directory.

#### Hide rule keys

| Key     | Required | Value   | Meaning                                                      |
| ------- | -------- | ------- | ------------------------------------------------------------ |
| `match` | Yes      | Pattern | Virtual paths to remove from directory listings and lookups. |
| `hide`  | Yes      | `true`  | Identifies the rule as a hide rule.                          |

A hide rule does not use `provider`, `root`, `opaque`, or `file`.

#### Module provider keys

| Key       | Required | Default     | Meaning                                                                                  |
| --------- | -------- | ----------- | ---------------------------------------------------------------------------------------- |
| `type`    | No       | `"module"`  | Provider kind. It may be omitted when `module` is present.                               |
| `module`  | Yes      | None        | ECMAScript module path relative to the config, or an installed package name.             |
| `export`  | No       | `"default"` | Export containing the provider object. Use this to select a named provider export.       |
| `options` | No       | `undefined` | Arbitrary JSON-compatible value passed unchanged to every callback as `context.options`. |

For example, `"export": "catalogProvider"` loads
`export const catalogProvider = ...` from the module. The provider can define
its own shape for `options`; ScriptFS does not interpret that value.

#### File proxy keys

| Key    | Required | Value     | Meaning                                                               |
| ------ | -------- | --------- | --------------------------------------------------------------------- |
| `type` | Yes      | `"file"`  | Transparently proxy one existing host file.                           |
| `path` | Yes      | File path | Target resolved relative to the config file and validated at startup. |

File proxies are normally paired with an exact `match`.
Their targets must be regular files, not symbolic links. Configure the resolved
target path or use a directory proxy when links need to remain visible.

#### Directory proxy keys

| Key    | Required | Value          | Meaning                                                             |
| ------ | -------- | -------------- | ------------------------------------------------------------------- |
| `type` | Yes      | `"directory"`  | Transparently proxy an existing host directory tree.                |
| `path` | Yes      | Directory path | Root resolved relative to the config file and validated at startup. |

Directory proxies normally use a subtree glob such as `ReferenceData/**` and
set `root` to the virtual directory exposed by the rule.

#### File default keys

| Key        | Required | Default                                            | Meaning                                                                          |
| ---------- | -------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `mode`     | No       | `420` (`0644`)                                     | POSIX permission bits. JSON uses decimal numbers, so `0644` is written as `420`. |
| `size`     | No       | Mode-dependent                                     | Non-negative logical file size, required for useful `explicit` behavior.         |
| `sizeMode` | No       | `explicit` when `size` is set; otherwise `content` | How ScriptFS reports the logical size.                                           |
| `seekable` | No       | `true`                                             | Whether reads and writes may use non-sequential positions.                       |

`sizeMode` accepts:

- `content`: derive size by calling `readFile`
- `explicit`: report `size`
- `zero`: report zero for command sinks or `/dev/null`-like files
- `unbounded`: report a large logical size for generated-on-demand positional
  reads

Provider metadata returned by `getattr` can override these defaults for an
individual path.

#### Container keys

| Key        | Required | Default                            | Meaning                                                          |
| ---------- | -------- | ---------------------------------- | ---------------------------------------------------------------- |
| `image`    | No       | `localhost/scriptfs-runtime:0.0.1` | Podman runtime image to build or reuse.                          |
| `rebuild`  | No       | `false`                            | Rebuild `image` before starting even if it already exists.       |
| `smbHost`  | No       | `127.0.0.1`                        | SMB hostname or address used by the host mount adapter.          |
| `smbPort`  | No       | Podman-assigned loopback port      | Fixed host port mapped to the container's SMB port.              |
| `logLevel` | No       | `info`                             | `silent`, `info`, or `debug`; `debug` also logs FUSE operations. |

Windows currently requires `smbPort: 445`; macOS and Linux can use a fixed
non-privileged port or omit the key.

### Built-in file and directory proxies

A rule can transparently proxy an existing host file or directory without a
module:

```json
{
  "match": "CurrentSettings.json",
  "provider": {
    "type": "file",
    "path": "./settings.json"
  }
}
```

```json
{
  "match": "ReferenceData/**",
  "root": "ReferenceData",
  "opaque": true,
  "provider": {
    "type": "directory",
    "path": "./reference-data"
  }
}
```

Proxy paths are resolved relative to the config. Startup fails before mounting
if a `file` target is not a file or a `directory` target is not a directory.
File-proxy targets that are symbolic links are rejected at startup. If a target
is later replaced by a symlink or directory, fresh lookups fail with
`EOPNOTSUPP` and directory listings omit it; already-open descriptors retain the
original file. This prevents a host symlink from being resolved against unrelated
paths in the overlay. Replacing the target with another regular file remains
supported. Directory proxies continue to expose their entries' symlinks.

Reads, writes, creates, truncates, renames, and deletions operate directly on
the target. Renames are supported within a directory proxy or within the same
module-provider rule. Renames across provider rules or between a provider and
the source fail with `EXDEV` rather than silently modifying the wrong target.

A fixed file proxy cannot be deleted or renamed to another virtual path:
its configured name is permanent, while its contents remain writable. This
also prevents SMB clients from deleting that target before attempting an
unsupported replacement rename. Editors using
temporary-file-and-rename saves must use in-place writes for those paths.

Opaque directories do not merge source listings. Hide rules also filter
generated entries and generated subtree roots.

## Provider API

Providers are ECMAScript modules. `defineProvider` is an identity helper that
supplies TypeScript inference:

```ts
import { defineProvider, directoryMetadata, fileMetadata } from "scriptfs";

const directories = new Map([
  ["", ["Datasets", "AGENTS.md"]],
  ["Datasets", ["Batch1"]],
  ["Datasets/Batch1", ["Record1"]],
  ["Datasets/Batch1/Record1", ["data.txt", "action.txt"]],
]);

export default defineProvider({
  getattr({ relativePath }) {
    if (directories.has(relativePath)) return directoryMetadata();
    if (relativePath.endsWith("/action.txt")) {
      return fileMetadata({ size: 0 });
    }
    if (relativePath === "AGENTS.md" || relativePath.endsWith(".txt")) {
      return fileMetadata();
    }
  },
  readdir({ relativePath }) {
    return directories.get(relativePath);
  },
  readFile({ relativePath }) {
    return `Generated contents for ${relativePath}\n`;
  },
  async writeFile(contents, context) {
    await performAction(context.relativePath, contents);
  },
});
```

Select a named export and pass arbitrary JSON-compatible options in the
configuration:

```json
{
  "provider": {
    "type": "module",
    "module": "./provider.mjs",
    "export": "catalogProvider",
    "options": {
      "catalogName": "Example catalog"
    }
  }
}
```

`type: "module"` is optional when `module` is present. Provider callbacks
receive the configured value as `context.options`.

### Callback reference

Callbacks may be synchronous or asynchronous. Implement the operations your
provider needs:

| Purpose                       | Callbacks                                                     |
| ----------------------------- | ------------------------------------------------------------- |
| Discovery                     | `getattr`, `readdir`, `readlink`                              |
| File acquisition and release  | `open`, `create`, `release`                                   |
| Whole-file I/O                | `readFile`, `writeFile`                                       |
| Positional I/O and truncation | `read`, `write`, `truncate`, `ftruncate`                      |
| File synchronization          | `flush`, `fsync`                                              |
| Directory lifecycle           | `opendir`, `fsyncdir`, `releasedir`                           |
| Metadata and access           | `fgetattr`, `fsetattr`, `access`, `chmod`, `chown`, `utimens` |
| Namespace changes             | `mkdir`, `unlink`, `rmdir`, `rename`                          |

### Context and cancellation

Context includes the complete virtual path, provider-relative path, provider
options, underlying source path, an abort signal, and operation-specific data.
The abort signal fires when the ScriptFS container begins shutting down,
allowing providers to cancel pending work.

The native binding's automatic callback timeout is disabled: operations wait
for provider callbacks to settle, so slow acquisitions cannot lose their handles
before normal release. **Bound external requests and honor the shutdown signal:**
a callback that never settles can block subsequent operations.

## Filesystem behavior

### File I/O

#### Native source and proxy I/O

Source files and built-in proxies use native descriptors for positional I/O,
descriptor truncation, and `fsync`/`fdatasync`, preserving an open file's identity
when its pathname is replaced.

Native backing supports regular files, directories, and symbolic links.
FIFOs, sockets, and device nodes are omitted from directory listings; direct
lookups and file opens fail with `EOPNOTSUPP`. Native file acquisition also
guards against replacement by a FIFO during open, so unsupported nodes cannot
block unrelated namespace operations.

Lifecycle-only module hooks retain this native source I/O and receive their
own resources in `context.handle`; source-fallback `create` hooks must actually
create the source file. Native and provider resources are both released.

#### Creating and opening files

For a new whole-file node without a `create` callback, ScriptFS calls
`writeFile(Buffer.alloc(0), context)` with `previousContents: undefined` before
opening it. The provider must make that entry visible to `getattr` and `readdir`;
this also persists files that are created and closed without a write.

Implement `create` when empty writes have command side effects or namespace
creation needs different behavior. Positional-only providers must materialize
new entries in `create` or a creation-aware `open` callback; a `write` callback
alone cannot create a node. Existing command-file truncation remains separate
from writes.

Creation and subsequent handle callbacks receive the caller's actual open flags,
including the access mode, append, and synchronization flags. Source and proxy
descriptors preserve those flags as well.

The native backend verifies an acquired handle's identity before applying
`O_TRUNC` through descriptor truncation. A stale open fails without truncating
the replacement file. Provider `open` callbacks receive the original flags but
should acquire their resources without performing truncation themselves; leave
that operation to `ftruncate` or the supported truncation fallback.

File creation also preserves the caller's permission bits, including execute
and special bits, after the kernel applies the caller's umask. File-type bits
are removed before dispatch to providers or native creation. Samba's separate
`create mask = 0666` policy still applies to files created through SMB.

**A failed create can leave a file behind.** If native creation succeeds but a
subsequent provider `open` or metadata callback fails, ScriptFS reports the error
and releases acquired resources without deleting the backing pathname. This
avoids deleting concurrent writes or a replacement file; checking identity
before unlinking would still leave a replacement race.

#### Whole-file buffering and truncation

Whole-file module-provider buffers are shared by resource identity when supplied,
or by virtual path otherwise. Captured sizes stay consistent across handles
sharing a buffer, including handles opened before a pending write is flushed,
even when `open` returns distinct objects without an explicit identity.

Buffered changes take precedence over positional reads until persisted, and
ordinary finite-file truncations are flushed even without a subsequent write.
No-op truncations of empty finite files do not retain a stale empty buffer that
could hide or overwrite subsequent backing changes.

#### Command files and zero-sized sinks

Truncation is separate from writes so action-style files do not receive an empty
write before their real contents. Truncating an already zero-sized command sink
does not send an empty command.

Writable command/action files should report their intended current size
explicitly—usually `size: 0`—so SMB clients do not preserve or pad generated
read contents during a replacement write.

Zero-sized whole-file sinks can be written without a read callback or an initial
truncation. Their `writeFile` callback receives an empty `previousContents`
buffer; nonempty files still require readable contents to preserve bytes outside
a partial write.

After a successful flush, the next write to a still-zero-sized sink starts with
an empty buffer, even if its timestamps have not changed. Pending chunks remain
combined until flushed; if `writeFile` fails, those pending bytes remain available
for retry.

For non-seekable sinks using `sizeMode: "zero"`, sequential writes append to the
current pending payload. After a successful explicit or automatic flush, the
next payload starts without padding for bytes already consumed. Descriptor
offsets still advance and out-of-sequence writes remain invalid.

Concurrent non-seekable writers contribute chunks in arrival order; seekable
files and finite files using `explicit` or `content` sizes retain positional writes.

#### Positional resources

Positional providers should return a stable per-open resource from `open` or
`create`, and use `context.handle` rather than resolving the pathname again
after unlink or replacement. Bounded, seekable handleless providers are
snapshotted for detached I/O; an unbounded provider needs a stable handle for
those operations.

For handleless positional providers supplying a stable `identity`, reads and
writes check that a known pathname still names the original resource before
each callback. External replacement or removal returns `ESTALE` at the FUSE
boundary when no known surviving alias exists, rather than redirecting I/O to
the replacement. Linux cached reads may surface that failure as `EIO` instead.
Providers must coordinate changes that race within a callback itself.

Positional providers returning an open resource must implement `ftruncate`
for descriptor truncation, using `context.handle`; otherwise that operation
fails with an unsupported-operation error rather than truncating a replacement
by pathname. Providers whose writes use only `writeFile` may instead use
buffered descriptor truncation.

#### Mixing whole-file and positional callbacks

**Positional reads with whole-file writes.** Providers combining `read` with
`writeFile` can omit `readFile` for finite, seekable files. ScriptFS assembles
bounded chunks to preserve untouched bytes and populate `previousContents`.
Existing open resources are used when readable; otherwise temporary read-only
resources are opened and released.

This includes buffering writes, truncations, and unlink snapshots for
`O_WRONLY` or append-only handles, without changing the caller's original flags.
Handleless assembly rechecks a supplied identity before each chunk, including
when buffering writes or taking unlink snapshots, and rejects a mid-read
replacement or removal with `ESTALE`.

Without an explicit `readFile`, unbounded or nonempty non-seekable files cannot
be buffered for whole-file operations and return `EOPNOTSUPP`.

**Whole-file reads with positional writes.** Providers combining `readFile`
with `write` retain a read snapshot after unlink or replacement, but writes and
`ftruncate` still reach their stable open resource. Successful mutations update
the snapshot across shared handles; failed mutations leave it unchanged. These
providers must implement `ftruncate` to support descriptor truncation.

#### Size policies and seeking

File metadata supports four size policies, either from `getattr` or from a
rule's `file` defaults:

| Policy      | Reported size and use                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `content`   | Derives size from `readFile`.                                                                                             |
| `explicit`  | Uses the numeric `size`.                                                                                                  |
| `zero`      | Reports zero, suitable for command sinks and `/dev/null`-like files.                                                      |
| `unbounded` | Reports a very large logical size while positional `read` generates data on demand. **Consumers must bound their reads.** |

`seekable: false` rejects non-sequential reads and writes. These handles use
FUSE direct I/O so kernel read-ahead and cached reads cannot bypass the
per-handle position checks. Sequential positional requests remain supported
for SMB clients. Per-rule defaults are useful for static policy, while provider
metadata can choose behavior dynamically for each path.

Seekable positional readers may return short chunks: ScriptFS continues reading
at the next offset until the FUSE request is filled or the reader returns an
empty buffer to signal EOF. Errors from continuation reads are propagated.
Non-seekable readers retain direct-I/O semantics and return each chunk without
additional reads.

### Resource identity and metadata

#### Replacement and concurrent operations

Identities must remain stable for updates and change when a resource is replaced.
A new identity never inherits the previous resource's pending buffer. Module
file identities are scoped to their provider rule so unrelated providers can
reuse local identifiers and different rules retain independent decorations.
Hard-linked aliases within one view share resource identity; callbacks may use
another surviving name for that same resource.

Before reading backing contents, truncating by pathname, or flushing a buffer,
ScriptFS checks that a known name still identifies the original resource.
If an external replacement leaves no known surviving name, these operations
return `ESTALE` rather than reading or overwriting the replacement. Buffered
bytes remain available to existing handles, but cannot be persisted through a
stale name.

Providers needing descriptor-based persistence after external replacement should
use positional callbacks with stable open resources. **Identity checks are not
atomic with external updates:** providers must coordinate concurrent changes
within their callbacks.

Operations on a file, including asynchronous flushes, are serialized so
concurrent writes cannot overwrite a newer buffer. Renaming a file or directory
updates its open handles. If a parent rename makes an open file match a hide
rule, new path-based access is hidden, but existing descriptors retain their
read, write, truncate, and flush behavior, including whole-file buffering.

#### Hard links and retained handles

Opened handles retain their selected backing even if a pathname is replaced.
Existing source and proxy hard links share a FUSE inode and page cache, keeping
reads, writes, truncation, and shared memory mappings coherent across aliases.
Removing or replacing one name does not detach the other names or existing
descriptors.

Native link counts, including zero for an unlinked open file, are preserved;
providers may also supply `nlink` in their metadata. Providers exposing
hard-link aliases must report an accurate `nlink`; omitting it means one link
for a regular file. Generated file handles report zero links after their last
name is unlinked or replaced through the mount, while remaining readable
through those handles.

Whole-file providers with stable identities share buffers across observed
hard-link aliases and continue persisting through a surviving name. If other
links exist but no surviving name is known, pathname-based I/O returns `ESTALE`
until a matching alias is observed, rather than silently discarding writes.

Before snapshotting a resource for unlink or replacement, ScriptFS rechecks its
known names and drops missing or replaced aliases. Removing the last surviving
name therefore preserves the original open resource without requiring a prior
lookup of externally changed names.

**Creating new hard links through the mounted view is not supported.**

#### Linux O_PATH descriptors

Retained `O_PATH` inode metadata also accounts for links removed by unlink or
replacement through the mount. Once an inode is known to have zero links,
it cannot be reattached to a new file that recycles its backing inode number.
Retained descriptors keep the removed inode's metadata, and pathname-based
metadata changes through them fail rather than modifying the replacement.

Before releasing the final backing handle, ScriptFS captures its current
metadata so surviving `O_PATH` descriptors retain updates made after unlink,
including file-size changes from writes.

If a backing name disappears externally, retained `O_PATH` descriptors continue
returning cached inode metadata without requiring another pathname lookup.
Known surviving aliases refresh that metadata; without a backing descriptor or
surviving name, external metadata changes, including link counts, cannot be
refreshed.

#### Reading handle metadata

Implement `fgetattr` with an explicit resource-specific size to refresh metadata
on opened provider resources. Without it, resource metadata is captured at open
and updated for writes and truncations through that resource; it cannot discover
external changes. Native handles always obtain metadata from their descriptors.

Metadata-only module overlays using native source I/O, and nonopaque module
directories backed by source directories, inherit unspecified attributes and
identity from their native backing. Their `getattr` and `fgetattr` callbacks
may override other attributes, but cannot replace the native identity. Fully
generated resources continue to use provider-supplied identities.

Without `fgetattr`, explicit metadata-only overrides are captured when the
native handle opens; unspecified attributes continue to come from its live
descriptor. Opening the file therefore does not discard its decorations,
and replacing its pathname cannot substitute the replacement's metadata.

Successful writes and truncations update captured sizes across handles sharing
the resource, including sizes declared by a rule's file defaults. Descriptor
metadata changes update the explicitly changed captured attributes.
Explicit `fgetattr` callbacks remain authoritative.

#### Changing handle metadata

Use `fsetattr(changes, context)` to change mode, ownership, or timestamps through
`context.handle`, including after unlink or external pathname replacement.
Captured attributes are updated across generated handles sharing a stable
resource identity, even when each `open` returns a different resource object.

Without a safe descriptor or provider implementation, detached metadata changes
are rejected instead of modifying a replacement. Supplied resource metadata
should include a stable `identity` so replacement can be distinguished from an
update to the same resource.

Handleless `fsetattr` and `ftruncate` callbacks check that identity before
dispatch, just like handleless positional I/O. This also applies to callbacks
overriding native metadata operations: an implicit native I/O descriptor does
not make a callback using `context.sourcePath` safe after replacement. Return
and use a stable `context.handle` for descriptor-based provider mutations.

Provider `chown` callbacks receive `-1` for an owner or group that should remain
unchanged; other unsigned user and group IDs are preserved.

### Directories and namespace changes

#### Source/proxy merging

Nonopaque directory proxies use source backing for source-only children and
proxy backing for overlapping children. New children are created in the proxy
when their parent exists there; children of source-only directories are created
in the source.

The same selection applies to file creation, whole-file writes, directory
creation, and rename destinations. No proxy parent directories are created
implicitly, so existing directory identities and open handles remain stable.

#### Removing and replacing shadowed entries

A directory with distinct source and proxy backings has these restrictions:

| Operation                               | Result                                   |
| --------------------------------------- | ---------------------------------------- |
| Rename the directory or replace it      | `EXDEV`, before changing either backing. |
| Remove it while it has visible children | `ENOTEMPTY`.                             |
| Remove it when visibly empty            | `EOPNOTSUPP`.                            |

These restrictions prevent partial renames and directories reappearing after a
successful removal. Source-only, proxy-only, and opaque directories retain their
ordinary backing operations.

Files and symlinks that shadow a distinct source directory entry cannot be
unlinked (`EOPNOTSUPP`) or renamed away (`EXDEV`), since doing so would make the
source entry reappear after a successful removal. This also applies when the
two backing entries are hard links.

In-place writes and replacement of an overlapping proxy file remain supported,
as do no-op renames between hard links. Aliases of the same backing directory
entry, including bind mounts, retain ordinary namespace operations.

#### Module overlays with source backing

Nonopaque module overlays receive the same conservative protection when they
explicitly supply metadata for a path that also exists in the source and use
custom I/O or namespace callbacks. Removing such a path returns `EOPNOTSUPP`,
and renaming it away or replacing such a directory returns `EXDEV`, before
invoking the mutation callback.

Module callbacks cannot establish that removing their own resource also removes
the source entry, so even callbacks that wrap source operations are subject to
this restriction. Use `opaque: true` for these paths when their namespace must
be mutable without source fallback. Safe file replacement and same-resource
no-op renames remain supported.

Content-only and lifecycle-only source overlays that omit `getattr`, and
metadata-only overlays using native I/O and native namespace operations,
retain their normal source behavior.

#### Listing snapshots and open directories

Directory enumeration snapshots its entries on the first read and keeps that
listing until the directory handle closes. Concurrent additions or removals
therefore cannot shift pagination past unrelated entries; **reopen the directory
to obtain a fresh listing.**

If a backing directory is externally replaced, namespace operations through its
old inode are rejected as stale or missing rather than redirected to the
replacement. An existing listing snapshot remains readable, while a first read
through a stale directory is rejected.

Removing or replacing a directory through the mount preserves its open
descriptors and reports zero links, including generated directories without an
`opendir` resource or explicit identity. Recreating its name does not redirect
those descriptors to the new directory.

#### Generated descendants and directory renames

Directory removal and replacement check the visible overlay contents first:
generated children and synthesized subtrees make a directory nonempty even
when its backing directory is physically empty. These operations return
`ENOTEMPTY` without invoking a provider's removal callback or changing the
backing directory.

Directory renames that would redirect a visible descendant to a different
provider rule fail with `EXDEV`, whether that descendant is open or closed.
Source-backed descendants retain nonopaque source fallback at their new paths.

Renames also reject directories with nested generated roots or visible
descendants owned by another provider, even when those descendants are closed.
This preflight prevents a successful rename from moving only the native portion
of a logical tree; ordinary single-provider subtrees remain movable.

Multi-component generated roots synthesize their missing ancestor directories.
Existing native ancestor directories retain their backing metadata and identity,
so they can still be enumerated and opened alongside the generated descendants.

### Symbolic links

Symlinks can be supplied by `readlink`, or by returning `kind: "symlink"` and
`target` from `getattr`; source and directory-proxy symlinks are forwarded
through FUSE. SMB clients may impose additional symlink rules.

No-follow ownership and timestamp changes update the backing link itself,
including dangling links, without modifying its target.

Symlink lookup also captures the target for that inode. Retained Linux
`O_PATH` descriptors therefore keep the original target after unlink or
replacement, while fresh pathname lookups observe the new target. A generated
symlink target change creates a new FUSE inode even if its provider identity
is unchanged.

### Access, synchronization, and errors

#### Access checks

Access checks use provider `access` callbacks when supplied. Otherwise,
generated entries and synthesized directories are checked using their metadata,
while source and proxy paths use native access checks. Filesystem-wide
`readOnly` still rejects every write request.

#### Directory synchronization

Source and proxy directory handles forward `fsync`/`fdatasync` to their backing
descriptors. Virtual directories can implement `opendir`, `fsyncdir`, and
`releasedir`; without a sync implementation or native backing, directory
synchronization returns an unsupported-operation error rather than success.

#### Error mapping

| Error                          | FUSE behavior                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Provider `ENOSYS`              | Translated to `EOPNOTSUPP`, so one unsupported path cannot disable synchronization or other operations for the entire mount. |
| Other recognized native errors | Preserved, including `ENOSPC` for full backing storage and `EDQUOT` for exhausted quotas.                                    |
| Unknown errors                 | Logged and returned as `EIO`.                                                                                                |

#### Storage statistics

Storage statistics report the source filesystem's actual capacity and available
space. Requests targeting a built-in proxy use its backing filesystem instead.
Paths not owned by a built-in proxy, including generated nodes and the ordinary
share root, use source statistics: these describe backing storage, **not** a
provider's external-service quota or in-memory limit.

Providers needing a separate quota should expose it as a generated status file.

### Native compatibility patches

The runtime build applies version-checked compatibility patches to the pinned
native binding for descriptor metadata dispatch and distinct access/modification
timestamps, direct-I/O open flags, and 64-bit storage counters.
It also preserves zero link counts for unlinked open resources.
Source drift fails the build rather than silently skipping a patch.

Timestamp callbacks receive `Date` objects with millisecond precision, including
dates before the Unix epoch. Pathname and descriptor updates and returned
metadata preserve signed timestamps.

## Runtime lifecycle

### Programmatic usage

The CLI lifecycle is also available programmatically:

```ts
import { loadConfig, startScriptFs } from "scriptfs";

const session = await startScriptFs(await loadConfig("./scriptfs.json"));
console.log(session.mounts);
await session.wait(); // rejects if the runtime container exits unexpectedly
await session.stop();
```

Direct `startScriptFs()` calls resolve relative source, proxy, and mount-point
paths against the working directory at startup without mutating the supplied
configuration. `loadConfig()` instead resolves paths relative to the config
file; use it to resolve config-relative provider module paths as well.
Both entry points use the schema-normalized configuration, including removal of
unknown fields, before interpreting rules or preparing container mounts.

### Startup and cancellation

The container receives a unique name before creation and its ID is recorded
before it is started, so startup failures such as an occupied SMB port also
remove the unstarted container. The name also permits rollback when cancellation
interrupts `podman create` before it returns an ID.

Cancellation during startup interrupts pending Podman commands and rolls back
created containers and completed mounts. Interrupted commands receive `SIGTERM`,
then `SIGKILL` after one second if needed; rollback waits for the child to exit.
Explicit cancellation skips failure-log retrieval.

| Operation                                | Timeout                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| Container readiness                      | 60 seconds; the deadline also interrupts stalled commands. |
| Other short startup and cleanup commands | 60 seconds.                                                |
| Runtime image build                      | 10 minutes.                                                |
| Failure-log retrieval                    | 10 seconds.                                                |
| Host mount and unmount                   | No imposed timeout.                                        |

An in-progress host mount command is allowed to finish so its result can be
recorded before rollback.

### Shutdown and recovery

Shutdown errors are reported rather than ignored: if a host mount is busy, the
container stays available. Release the busy mount's users and call
`session.stop()` again to retry unfinished cleanup. Successful cleanup is
idempotent.

`session.wait()` resolves during an intentional stop and rejects if the runtime
container exits unexpectedly. Once cleanup completes, the CLI reports unexpected
runtime exits and exits with a nonzero status without requiring another signal.

If startup and rollback both fail, the exported `ScriptFsStartupError` exposes
`error.session`: after releasing busy mount users, call
`error.session.stop()` to retry cleanup. This preserves ownership of resources
even when startup could not return a normal session. If creation did not return
an ID, that recovery session's `containerId` is the preassigned container name.

### Host-side cache visibility

Changes made directly on the host, including atomic proxy-target replacement,
are visible after the Podman VM and SMB client's metadata caches invalidate;
they are not guaranteed to appear instantaneously.

### macOS 15 AppleHV hard-link limitation

On macOS 15.7.9, AppleHV/virtiofs has been observed to violate hard-link
semantics for directories shared with the Podman machine. Replacing one link
can make a surviving link and an already-open descriptor return the
replacement's contents even though the paths still report distinct inode
numbers. The same standalone filesystem probe behaves correctly on macOS
26.6.2 and 27.0 with the same Podman server, VM kernel, and architecture,
confirming that the failure occurs below ScriptFS.

This can break source or proxy files with multiple hard links and causes the
hard-link end-to-end regressions to fail. Running
`pnpm test:e2e:rebuild` reproduces the problem with the existing test suite,
including the surviving-link and open-handle replacement cases. Do not ignore
those failures or rely on affected mounts for data-preserving hard-link
operations. Upgrade macOS, run the source from storage local to the Podman VM,
or use another machine provider whose hard-link behavior has been verified.

## Host requirements

- Podman with a running Linux machine and `/dev/fuse` support.
- macOS uses `mount_smbfs`.
- Linux uses `mount -t cifs`.
- Windows support is isolated behind the host mount adapter. The current
  adapter accepts drive-letter mount points such as `S:` and requires SMB port
  `445`; broader Windows directory-mount support can be added without changing
  provider modules or overlay semantics.

Runtime containers receive `/dev/fuse` and `SYS_ADMIN`, with SELinux label
separation and AppArmor confinement disabled for that container only
(`label=disable`, `apparmor=unconfined`). The default AppArmor container policy
denies mounts even with `SYS_ADMIN`. This exception allows FUSE on AppArmor-enabled
Linux hosts without changing host-wide Podman configuration or enabling
`--privileged`; it also means provider code must be trusted. Hosts enforcing a
mandatory policy that forbids this exception are not supported by the current
launcher.

Runtime image builds use the effective local npm registry configuration on
all supported hosts, including Windows installations with an `npm.cmd` launcher.

SMB clients may apply host-specific ownership and mode semantics. In
particular, macOS `mount_smbfs` does not reliably forward `chmod` and `chown`
from the mounted share. ScriptFS forwards those operations through FUSE when
the client sends them, but applications should not depend on POSIX ownership
changes through a macOS SMB mount.

New regular files are created with read/write permissions only; ScriptFS strips
execute bits supplied by SMB clients. Directory creation retains its requested
execute/search permissions. The runtime preserves caller-masked creation modes
without applying an additional container-daemon umask.

The runtime image is built on first use. It installs Linux FUSE, Samba, and the
container-only `@cocalc/fuse-native` binding. The host package has no native
FUSE dependency.

## Development

`src/container/fuse-binding.ts` defines and loads the native binding;
`fuse-adapter.ts` translates overlay operations into FUSE callbacks.
`src/runtime/command-runner.ts` executes external commands, while
`src/provider-helpers.ts` contains the public provider and metadata helpers.
Native inode handling lives in `container/fuse-inode-backend.h`, with its
corresponding `.test.c` suite. `patch-fuse-binding.mjs` prepares the pinned
binding; `.inc` marks source fragments rather than standalone compilation units.

Test filenames identify their scope: `overlay-filesystem`, `filesystem-io`,
`podman-runtime`, and `fuse-binding-patch` cover the corresponding components.
The e2e suites distinguish CLI mounting (`cli-mount.test.ts`) from broader
runtime regressions (`runtime-regressions.test.ts`).

```sh
pnpm install
pnpm check
pnpm test:e2e
pnpm test:e2e:rebuild
```

Checkouts use public npm by default. Configure a mirror only in your local
`.npmrc` (already ignored by Git) or user npm configuration. Runtime image builds
forward that effective registry setting. Keep registry-specific tarball URLs
out of `pnpm-lock.yaml` so it remains portable between registries.

Development requires Node.js `>=22` and pnpm `>=12.4.0 <13`, as declared in
`package.json`'s `engines`. Use any installed pnpm version in that range;
the project does not pin or automatically download a particular pnpm release.
`pnpm-lock.yaml` locks application dependencies, not the package manager itself.

`test:e2e` reuses the existing runtime image when available.
`test:e2e:rebuild` rebuilds it first. Both targets launch the built CLI and
exercise real source passthrough, module providers, file and directory proxies,
hidden paths, whole-file and positional I/O, create, replace, append, seek,
truncate, rename, delete, directory lifecycle, metadata callbacks, provider log
forwarding, unmount, and container cleanup.
Regression coverage also exercises overlapping rules, atomic host replacement
of file proxies, installed provider dependencies, asynchronous flushes,
nonzero truncation, open-handle renames, symlinks, cancellation, and busy-mount
cleanup retries. Unit tests inject command failures without requiring Podman.

For a release candidate, run `pnpm run ci` on the final worktree: portable checks
alone, or integration tests against an older runtime image, are not the release
gate. Filesystem fixes should extend operation-sequence regressions across
relevant provider types, checking original and replacement contents, retained
metadata, and cleanup ownership rather than only successful callback returns.
The alias matrices deliberately vary lookup timing and pending writes. A quiet
audit or passing suite is evidence for these cases, not proof that arbitrary
provider callbacks are race-free.

The Makefile provides equivalent convenience targets:

```sh
make start-podman
make check-deps
make pnpm-install
make check
make test-e2e
make test-e2e-rebuild
make example
```

`make install-deps` can install Node.js and Podman with Homebrew, then installs
a compatible pnpm release through npm using the effective registry configuration.
On other systems, install Node.js 22 or newer, pnpm in the supported range, and
Podman, then run `make check-deps`.

`make start-podman` leaves a working Podman runtime alone. Otherwise it starts
the VM marked as default, or the only existing VM. If no machines exist, it
initializes the default VM first. It selects the started VM's connection and
verifies that Podman is reachable. To select a specific VM, use
`make start-podman PODMAN_MACHINE=my-vm`; ambiguous selections list the available
names rather than creating another VM. Failures are reported without
resetting or deleting any VM; `make check-deps` only checks readiness.

### GitHub Actions

`.github/workflows/ci.yml` runs on pushes, pull requests, and manual dispatch.
It uses Node.js 22 and pnpm 12.4.0 as a fixed CI baseline, caches the pnpm store,
installs with the frozen lockfile, and runs `pnpm check` on Ubuntu 24.04 and macOS.

Ubuntu also installs Podman and CIFS support, builds a fresh runtime image,
and runs the real FUSE/SMB end-to-end suite as root so the Linux host can mount
SMB shares. The image build runs before the tests to keep a cold build outside
their startup timeout. Integration uses the same per-container AppArmor settings
as ordinary startup, without a CI-only Podman policy override. Registry
configuration is preserved for both dependency installation and runtime image
builds.

Hosted macOS runs portable checks only: its nested-virtualization restriction
precludes the Podman machine required by the end-to-end suite. Run
`pnpm test:e2e:rebuild` on a development Mac to cover the real macOS SMB adapter.
The workflow has read-only repository permissions and does not publish packages.

## License

[MIT License](LICENSE).

Copyright (c) 2026 Marat Abdullin.
