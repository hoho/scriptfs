# Explore a complete ScriptFS overlay

This example combines generated files, an editable in-memory tree, host file
and directory proxies, hidden paths, and a second read-only share. Start with
the read-only exploration below, then try changing generated data to see how
filesystem operations reach module callbacks.

## 1. Start the showcase

Use Node.js 22 or newer, pnpm 12.4 or newer within version 12, Rust, GNU Make,
and a working Podman runtime. See the [host requirements](../../README.md#host-requirements).
Run these commands from the repository root in a macOS or Linux shell:

```sh
pnpm install --frozen-lockfile
make example EXAMPLE=showcase
```

The command builds ScriptFS and mounts two shares at `examples/showcase/mount`
and `examples/showcase/mount-readonly`, building the runtime image on first use.
Leave the CLI running and open another terminal at the repository root.

[config.json](config.json) reserves SMB host port `14445`. Change or remove
`container.smbPort` if another process uses that port. To adapt the config for
Windows, use drive letters for both mount points and follow the
[Windows host requirements](../../README.md#host-requirements).

## 2. Compare source files and generated files

```sh
cat examples/showcase/mount/passthrough.txt
cat examples/showcase/mount/components/Button/component.txt
cat examples/showcase/mount/components/Button/AGENTS.md
cat examples/showcase/mount/GeneratedCatalog/Datasets/Batch1/Record1/data.txt
ls examples/showcase/mount-readonly
```

The first two files come from [fixtures/source](fixtures/source). The
`AGENTS.md` beside the component is supplied by the
[components module](modules/components/index.mjs), using the heading setting
in its manifest and config. The dataset record comes from the
[catalog module](modules/catalog/index.mjs), which describes a generated tree.
The second share exposes [fixtures/reference-source](fixtures/reference-source)
read-only.

The `components/*/AGENTS.md` rule adds instructions while leaving ordinary
component files available. The `GeneratedCatalog/**` rule is opaque, so its
subtree is supplied by the module. Later rules specialize individual catalog
files and their size and seek behavior.

## 3. Write a generated file and send a command

```sh
node --input-type=module <<'JS'
import { writeFile, readFile } from "node:fs/promises";

const catalog = "examples/showcase/mount/GeneratedCatalog";
await writeFile(`${catalog}/ContentSized.txt`, "Updated catalog contents.\n", { flush: true });
console.log(await readFile(`${catalog}/ContentSized.txt`, "utf8"));
await writeFile(`${catalog}/CommandSink.txt`, "run\n", { flush: true });
JS
```

The whole-file callback receives the new text and keeps it in memory. The
command sink accepts writes but reports a size of zero; it logs the command
instead of storing a readable file. Watch the ScriptFS terminal for those
callbacks. Generated data resets when the session stops.

## 4. Create and rename files in memory

```sh
mkdir examples/showcase/mount/Tools/Memory/drafts
printf 'First draft\n' > examples/showcase/mount/Tools/Memory/drafts/note.txt
mv examples/showcase/mount/Tools/Memory/drafts/note.txt \
  examples/showcase/mount/Tools/Memory/final.txt
cat examples/showcase/mount/Tools/Memory/final.txt
rm examples/showcase/mount/Tools/Memory/final.txt
rmdir examples/showcase/mount/Tools/Memory/drafts
```

The [memory module](modules/memory/index.mjs) owns this tree. Its stable resource
identities let opened files survive renames and unlinks, and its lifecycle
callbacks log open, synchronization, release, and shutdown operations. The
`Tools` ancestor is synthesized from the rule root `Tools/Memory`.

## 5. Read a bounded sample from a generated stream

`GeneratedStream.bin` is unbounded: use an explicit offset and byte count rather
than reading the entire file. This reads 16 bytes starting at offset 100:

```sh
node --input-type=module <<'JS'
import { open } from "node:fs/promises";

const stream = await open("examples/showcase/mount/GeneratedCatalog/GeneratedStream.bin", "r");
try {
  const bytes = Buffer.alloc(16);
  const { bytesRead } = await stream.read(bytes, 0, bytes.length, 100);
  console.log(bytes.subarray(0, bytesRead).toString());
} finally {
  await stream.close();
}
JS
```

The result is 16 `S` characters. The [positional module](modules/positional/index.mjs)
also supplies a fixed-size buffer and a finite sequential stream; their rules
demonstrate `explicit`, `zero`, and `unbounded` size modes.

## 6. Explore proxies and hidden paths

```sh
cat examples/showcase/mount/ProxiedFile.txt
ls examples/showcase/mount/ProxiedDirectory
ls examples/showcase/mount/MergedDirectory
ls examples/showcase/mount/Tools/Memory
```

`ProxiedFile.txt` maps to [fixtures/proxy-file.txt](fixtures/proxy-file.txt).
`ProxiedDirectory` is an opaque view of
[fixtures/proxy-directory](fixtures/proxy-directory). `MergedDirectory` combines
that proxy with its source directory: overlapping names use the proxy, while
source-only entries remain visible. Writes to source and proxy paths modify the
fixture files on disk, unlike changes to the generated trees above.

The `**/*.private` hide rule filters both the source's `example.private` and the
memory module's `hidden.private`. The `*.native` rule demonstrates native source
I/O with custom lifecycle hooks in [modules/source-hooks](modules/source-hooks).
For a path-by-path reference, see the main README's
[complete runnable example](../../README.md#complete-runnable-example).

## 7. Stop and run the tests

Press `Ctrl+C` in the ScriptFS terminal. Generated changes disappear when you
restart; fixture changes remain on disk. From the repository root:

```sh
make test-examples
```

[test/showcase.test.mjs](test/showcase.test.mjs) tests additive component
instructions and the mutable memory tree through real mounts.
