# @scriptfs/testing

End-to-end testing and development tools for
[ScriptFS](https://github.com/hoho/scriptfs#modules) modules.

`startModule()` runs a module the way users run it: ScriptFS starts a
container, binds the ports, host paths, secrets, and state the test asks for,
and mounts the module's files on the host. Tests then use ordinary file
system calls and HTTP requests, so they exercise the manifest, dependency
delivery, the container network, and the callbacks together.

The package also provides the `scriptfs-module` command for creating,
checking, and trying out modules.

## Requirements

- Node.js 22 or newer.
- The `scriptfs` package, a dependency of this one, and its host
  requirements: Podman with a running machine on macOS or Windows, and an
  SMB client. See
  [Host requirements](https://github.com/hoho/scriptfs#host-requirements).

## Getting started

```sh
npx -p @scriptfs/testing scriptfs-module init my-module
cd my-module
npm install
npm test
```

`init` creates a manifest, a `TreeModule` entry, a `package.json`, and an
end-to-end test. Inside a module project:

```sh
npx scriptfs-module check   # validate the manifest, entry, and lockfile
npx scriptfs-module dev     # mount the module until Ctrl+C
npm test                    # run the end-to-end tests
```

Add it to an existing module as a development dependency:

```sh
npm install --save-dev @scriptfs/testing @scriptfs/module scriptfs
```

## Writing tests

The harness works with any test runner. With `node:test`:

```js
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hostServer, startModule } from "@scriptfs/testing";

let api;
let module;

before(async () => {
  // Stands in for the local service the module's outbound port reaches.
  api = await hostServer((request) =>
    new URL(request.url).pathname === "/todos"
      ? Response.json([{ id: 1, title: "Buy milk" }])
      : undefined,
  );
  module = await startModule({
    module: new URL("..", import.meta.url), // the folder with the manifest
    settings: { refreshSeconds: 0 },
    secrets: { token: "test-token" },
    outbound: { api },
  });
});

after(async () => {
  await module?.stop();
  await api?.close();
});

test("lists todos from the API", async () => {
  assert.deepEqual(await module.list(), ["Buy milk.md"]);
  assert.equal(api.requests[0].headers.authorization, "Bearer test-token");
});
```

Starting a module takes a few seconds, so start one per test file and share it
between tests. Each harness gets its own container, mount point, and ports;
test files can run in parallel.

The [examples](https://github.com/hoho/scriptfs/tree/main/examples) test
each module this way:

| Test                                                                                                          | Shows                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`local-api`](https://github.com/hoho/scriptfs/blob/main/examples/local-api/module/test/todo-api.test.mjs)    | A fake host API, recorded requests, a secret, writes, and error mapping. |
| [`notes`](https://github.com/hoho/scriptfs/blob/main/examples/notes/module/test/notes-by-tag.test.mjs)        | Host folders generated from `files`, and changing them while mounted.    |
| [`inbox`](https://github.com/hoho/scriptfs/blob/main/examples/inbox/module/test/http-inbox.test.mjs)          | Requests to an inbound port, and state kept across `restart()`.          |
| [`markdown`](https://github.com/hoho/scriptfs/blob/main/examples/markdown/module/test/markdown-html.test.mjs) | Dependencies installed from a lockfile into the container.               |
| [`showcase`](https://github.com/hoho/scriptfs/blob/main/examples/showcase/test/showcase.test.mjs)             | Custom `rules` over `source` files, and a mutable tree with `restart()`. |

## `startModule(options)`

Returns a `ModuleHarness` once the module is mounted. A failed start removes
everything it created.

| Option     | Description                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`   | Required. A manifest file, a folder containing `scriptfs.module.json`, an installed package name, or a `file:` URL.                            |
| `cwd`      | Base for relative paths. Defaults to `process.cwd()`.                                                                                          |
| `instance` | Instance name. Defaults to `"module"`.                                                                                                         |
| `settings` | Setting values. Manifest defaults apply to the rest.                                                                                           |
| `secrets`  | Secret values by key. A string is written to a private temporary file; `{ env }` and `{ file }` read it on the host like a configuration does. |
| `outbound` | Outbound port targets by key: `"host:port"`, a port number on `127.0.0.1`, or anything with a `target`, such as a `hostServer()`.              |
| `inbound`  | Host ports for inbound ports by key. Inbound ports not listed get a free port.                                                                 |
| `paths`    | Host paths by key: an existing path, `{ files: { "a/b.txt": "…" } }` to create a folder, or `{ contents }` to create a file.                   |
| `state`    | Host state folder. Defaults to a temporary folder kept across `restart()`. Only for manifests with `state`.                                    |
| `options`  | Rule options, passed to every callback as `context.options`.                                                                                   |
| `source`   | Files of the source folder under the mount. Defaults to an empty folder.                                                                       |
| `rules`    | Filesystem rules. Defaults to the module serving the whole mount: `{ match: "**", opaque: true, provider: { module: instance } }`.             |
| `readOnly` | Mounts read-only.                                                                                                                              |
| `mount`    | Mount point. Defaults to a temporary folder. Required on Windows, where it is a free drive letter such as `"S:"`.                              |
| `image`    | Runtime image. Defaults to `SCRIPTFS_TEST_IMAGE`, then the image of the installed `scriptfs`.                                                  |
| `logLevel` | `"silent"`, `"info"`, or `"debug"`. Defaults to `SCRIPTFS_TEST_LOG_LEVEL`, then `"silent"`.                                                    |
| `signal`   | Cancels startup.                                                                                                                               |

Options for ports the manifest does not declare are errors, as is `state` for
a manifest without state. ScriptFS itself validates everything else, exactly
as for a configuration file.

### `ModuleHarness`

| Member                                 | Description                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `root`                                 | The mount point.                                                             |
| `path(...segments)`                    | An absolute path in the mount. Paths outside the mount are errors.           |
| `readText(path)` / `readJson(path)`    | Read a mounted file.                                                         |
| `list(path = "")`                      | Sorted entry names of a mounted folder.                                      |
| `write(path, contents)`                | Write a mounted file.                                                        |
| `exists(path)`                         | Whether a mounted path exists.                                               |
| `inbound(key)`                         | `{ host, port, url }` where host programs reach an inbound port.             |
| `hostPath(key)`                        | The host path bound to a manifest path, to change it while the module runs.  |
| `stateDir`                             | The host state folder, when the manifest enables state.                      |
| `logs()`                               | Output of the ScriptFS container, including the module's `this.log()` lines. |
| `restart()`                            | Stops and starts ScriptFS with the same configuration and state.             |
| `stop()`                               | Stops ScriptFS and removes temporary files. Safe to call more than once.     |
| `manifest`, `manifestPath`, `instance` | The validated manifest and the instance name.                                |
| `config`, `session`, `containerId`     | The ScriptFS configuration, the running session, and its container.          |

The harness is `AsyncDisposable`, so `await using module = await
startModule(…)` stops it where supported.

To debug a failing test, set `SCRIPTFS_TEST_LOG_LEVEL=info` to print ScriptFS
and module logs while tests run (`debug` also logs FUSE operations), or print
`await module.logs()`.

## Helpers

### `hostServer(handler)`

Starts an HTTP server on `127.0.0.1` that stands in for a local service.
The handler receives a Fetch API `Request` and returns a `Response`;
returning nothing answers `404`, and a thrown error answers `500`. The server
has `port`, `url`, `target` (the value for an outbound port), `requests`
(every request received, with `method`, `path`, `headers`, and `body`), and
`close()`. Pass the server itself as an `outbound` value.

### `waitFor(check, { timeout, interval })`

Calls `check` until it returns something other than `undefined`, `null`, or
`false` without throwing, and returns that value. Use it for changes a module
picks up after a cache expires or a watcher fires. The defaults are a 10
second timeout and a 100 ms interval; a timeout reports the last error as its
`cause`.

### `freePort()`

A TCP port on `127.0.0.1` that was free when checked.

## `scriptfs-module` command

```text
scriptfs-module init [dir] [--name <name>]
scriptfs-module check [dir]
scriptfs-module dev [dir] [options]
```

- `init` creates a module project in `dir` (default: the current folder),
  refusing to overwrite files. The name defaults to the folder name.
- `check` validates the manifest, checks that the entry exists and, for
  `"dependencies": "install"`, that a lockfile does, then prints what the
  module asks for.
- `dev` mounts the module until interrupted and prints the mount point and
  inbound port URLs. Bind what the manifest declares with `--setting
key=value` (parsed as JSON when valid), `--secret key=value`,
  `--secret-env key=NAME`, `--secret-file key=file`, `--path key=dir`,
  `--outbound key=host:port`, `--inbound key=port`, `--state dir`,
  `--options json`, `--mount dir`, `--image image`, and
  `--log-level level` (default `info`).

`check` and `dev` also accept a manifest file or an installed package name.

## Environment variables

| Variable                  | Effect                                               |
| ------------------------- | ---------------------------------------------------- |
| `SCRIPTFS_TEST_IMAGE`     | Runtime image for `startModule()` without `image`.   |
| `SCRIPTFS_TEST_LOG_LEVEL` | Log level for `startModule()` without `logLevel`.    |
| `SCRIPTFS_CACHE_DIR`      | Where ScriptFS caches installed module dependencies. |
