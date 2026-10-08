# Turn a local API into editable files

This example exposes a todo service as Markdown files under `mount/Todos`.
Reading a file fetches a todo, writing it creates or updates a todo, and deleting
it sends a DELETE request to the API. The API runs on your host; the module runs
inside the ScriptFS container and reaches it through an outbound port.

## 1. Prepare the checkout

Use Node.js 22 or newer, pnpm 12.4 or newer within version 12, Rust, GNU Make,
and a working Podman runtime. See the [host requirements](../../README.md#host-requirements)
for your platform. The commands below use a macOS or Linux shell and start in
the repository root.

```sh
pnpm install --frozen-lockfile
```

## 2. Start the host API

In one terminal, start the included server with a development token:

```sh
TODO_API_TOKEN=dev-token node examples/local-api/server.mjs
```

Wait for `Todo API listening on http://127.0.0.1:4310/todos`. Leave this terminal
running. The server starts with two todos, `Buy milk` and `Water the plants`;
its data lives in memory and resets when you stop the server.

## 3. Mount the example

In a second terminal, also at the repository root:

```sh
TODO_API_TOKEN=dev-token make example EXAMPLE=local-api
```

This builds ScriptFS and starts the mount. The first run also builds the local
runtime image. Leave the CLI running while you use a third terminal for the
following commands.

```sh
ls examples/local-api/mount/Todos
cat 'examples/local-api/mount/Todos/Buy milk.md'
```

The file initially contains `- [ ] Buy milk`. The filename supplies the todo's
title, the checkbox supplies its completion status, and the remaining lines
become its notes.

## 4. Create, edit, and delete todos

Use ordinary filesystem operations. This Node.js snippet explicitly flushes
each write so the API has received it before you inspect the result:

```sh
node --input-type=module <<'JS'
import { writeFile, unlink } from "node:fs/promises";

const todos = "examples/local-api/mount/Todos";
await writeFile(`${todos}/Read the docs.md`, "- [ ] Read the docs\n", { flush: true });
await writeFile(`${todos}/Buy milk.md`, "- [x] Buy milk\n\nGet oat milk.\n", { flush: true });
await unlink(`${todos}/Water the plants.md`);
JS

curl --fail -H 'Authorization: Bearer dev-token' http://127.0.0.1:4310/todos
```

The API now includes `Read the docs`, marks `Buy milk` as done with the new
notes, and no longer includes `Water the plants`. Only `.md` todo files are
accepted by the module.

## 5. Understand the configuration

Read [config.json](config.json), then follow its `manifest` to
[module/scriptfs.module.json](module/scriptfs.module.json) and
[module/index.mjs](module/index.mjs).

- `secrets.token.env` takes the token from the host's `TODO_API_TOKEN`. The module
  retrieves it with `this.secret("token")` and sends a bearer header.
- `ports.api.target` points to the host's `127.0.0.1:4310`. The module calls
  `this.outbound("api")`; ScriptFS tunnels those requests out of the container.
- The `Todos/**` rule puts the module's tree under `Todos`. Its `root` makes
  filenames relative to that directory, and `opaque` makes the module own it.
- `source: "./module"` exposes the module's ordinary files alongside the
  generated tree. The mount and runtime state are outside this source folder.

The manifest's `cacheSeconds` setting defaults to two seconds. To disable the
todo-list cache while developing, add `"settings": { "cacheSeconds": 0 }` to
`modules.todos` in the config and restart the mount. The module clears its cache
after its own mutations.

## 6. Stop and test

Press `Ctrl+C` in the ScriptFS terminal to unmount, then stop the API terminal
with `Ctrl+C`. To run the module's tests from the repository root:

```sh
make test-examples
```

The [todo tests](module/test/todo-api.test.mjs) start their own host API and check
authentication, file reads, mutations, and rejected operations. They do not need
the server you started for this tutorial.
