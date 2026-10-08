# Render Markdown as a filesystem view

This example reads Markdown documents from `docs/` and exposes rendered HTML
under `mount/Pages`. Subfolders keep their structure, and each `.md` filename
becomes `.html`. Reading a page renders it on demand; no HTML output files are
written into the documents folder.

## 1. Start the example

Use Node.js 22 or newer, pnpm 12.4 or newer within version 12, Rust, GNU Make,
and a working Podman runtime. See the [host requirements](../../README.md#host-requirements).
Run these commands from the repository root in a macOS or Linux shell:

```sh
pnpm install --frozen-lockfile
make example EXAMPLE=markdown
```

Leave the CLI running and open another terminal at the repository root. The
first run builds the local runtime image and installs the module's locked
`marked` dependency in the container. Later starts reuse its dependency cache.
You do not need to install `marked` into the host module folder.

## 2. Read the rendered pages

```sh
ls examples/markdown/mount/Pages
cat examples/markdown/mount/Pages/index.html
cat examples/markdown/mount/Pages/guides/getting-started.html
```

The top level contains `index.html` and `guides`. Compare the rendered HTML with
[docs/index.md](docs/index.md): the page includes a `Welcome` heading, bold and
italic text, a link to the guide, and the module's stylesheet. You can open the
mounted HTML file in a browser as well.

## 3. Add a document on the host

The docs binding and mounted view are read-only inside the container. Edit the
host documents instead:

```sh
printf '# A new page\n\nRendered when you read it.\n' \
  > examples/markdown/docs/demo.md
cat examples/markdown/mount/Pages/demo.html
```

You should see `<h1>A new page</h1>` in the HTML. The module exposes only folders
and rendered Markdown pages under `Pages`; other file types are omitted.
Remove the tutorial document when you finish:

```sh
rm examples/markdown/docs/demo.md
```

## 4. Change the documents or stylesheet

In [config.json](config.json), change `modules.markdown.paths.docs` to another
host folder and restart. Relative paths are resolved from this example
directory. The manifest's default is `~/Documents` if you omit the binding.
To show that folder's original Markdown at the mount's root too, also update
`filesystems[0].source`.

To change the CSS embedded in every HTML page, merge this settings object into
`modules.markdown` and restart:

```json
{
  "settings": { "stylesheet": "body { font-family: system-ui; color: teal; }" }
}
```

The filesystem uses `docs/` as its source, so the original Markdown documents
are also available at the mount's root. The `Pages/**` rule provides the
generated HTML subtree alongside them.

## 5. Follow the callbacks and test the module

[module/scriptfs.module.json](module/scriptfs.module.json) sets
`"dependencies": "install"`, so ScriptFS installs dependencies from
[module/npm-shrinkwrap.json](module/npm-shrinkwrap.json) for its Linux runtime.
[module/index.mjs](module/index.mjs) extends `ScriptFsModule` and implements
`getattr`, `readdir`, and `readFile` directly. These callbacks translate mounted
HTML paths into source Markdown paths, report metadata, and render pages using
`marked`.

Press `Ctrl+C` to unmount. To run the examples' tests from the repository root:

```sh
make test-examples
```

The [Markdown tests](module/test/markdown-html.test.mjs) check folder mirroring,
rendered content, stylesheet settings, locked dependency installation, and
read-only behavior.
