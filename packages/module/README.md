# @scriptfs/module

Base classes and utilities for writing [ScriptFS](https://github.com/hoho/scriptfs)
modules. A module is a folder with a `scriptfs.module.json` manifest and a
JavaScript entry. ScriptFS runs it inside its container, connects the ports,
host folders, secrets, settings, and state the manifest declares, and serves
the files the module describes.

The ScriptFS container image ships this package, so a module imports it
without installing it. List it as an optional peer dependency, which keeps it
out of the module's installed dependencies, and as a dev dependency so editors
and type checkers can find it:

```json
{
  "type": "module",
  "peerDependencies": { "@scriptfs/module": ">=0.1.0" },
  "peerDependenciesMeta": { "@scriptfs/module": { "optional": true } },
  "devDependencies": { "@scriptfs/module": "^0.1.0" }
}
```

## Dependencies

ScriptFS mounts only the module folder into the container. To use other npm
packages, either bundle them inside the folder (the default,
`"dependencies": "bundled"`), or set `"dependencies": "install"` in the
manifest and commit a lockfile:

```sh
npm install marked
npm install --package-lock-only   # or `npm shrinkwrap` before publishing
```

ScriptFS then runs `npm ci --omit=dev --omit=peer` in the runtime image before
the session starts and caches the result on the host, so packages with native
code are built for the container. See
[Module dependencies](https://github.com/hoho/scriptfs#module-dependencies)
for the cache, registries, and authentication.

## Quick start

`scriptfs.module.json`:

```json
{
  "name": "weather",
  "entry": "./index.mjs",
  "settings": {
    "city": { "type": "string", "default": "Berlin" }
  },
  "secrets": {
    "apiKey": { "env": "WEATHER_API_KEY" }
  },
  "ports": {
    "api": { "direction": "outbound", "target": "127.0.0.1:8080" }
  }
}
```

The `scriptfs` package ships `scriptfs-module.schema.json` for editor
validation through `"$schema"`.

`index.mjs`:

```js
import { TreeModule, TtlCache } from "@scriptfs/module";

export default class Weather extends TreeModule {
  api = this.outbound("api");
  cache = new TtlCache({ ttl: 60_000 });

  constructor(runtime) {
    super(runtime);
    this.tree
      .directory("", () => ["today.json"])
      .file("today.json", () =>
        this.cache.get("today", async () =>
          JSON.stringify(
            await this.api.json("/forecast", {
              query: { city: this.settings.city },
              headers: { "x-api-key": this.secret("apiKey") },
            }),
          ),
        ),
      );
  }
}
```

Mount it with a ScriptFS configuration:

```json
{
  "modules": {
    "weather": { "manifest": "./weather", "settings": { "city": "Oslo" } }
  },
  "filesystems": [
    {
      "name": "home",
      "source": "./source",
      "mountPoint": "./mount",
      "rules": [
        {
          "match": "Weather/**",
          "root": "Weather",
          "opaque": true,
          "provider": { "module": "weather" }
        }
      ]
    }
  ]
}
```

The [examples](https://github.com/hoho/scriptfs/tree/main/examples) show
complete modules: `local-api` (outbound port, secret, writable files),
`notes` (host folder), and `inbox` (inbound port, state).

## Module lifecycle

ScriptFS imports the manifest `entry` and takes the `export` it names
(`default` unless set). A class is constructed with the `ModuleRuntime`;
any other value is used as is. ScriptFS then awaits `start(runtime)` on
every instance before serving files, and `stop()` in reverse order on
shutdown. `runtime.signal` aborts when the module is stopping.

## `ScriptFsModule`

The base class keeps the runtime and exposes everything the manifest
configured.

| Member                                | Description                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `runtime`                             | The frozen `ModuleRuntime`.                                                                           |
| `name`                                | Instance name from the configuration, such as `weather`.                                              |
| `settings`                            | Settings validated against the manifest, with defaults applied.                                       |
| `signal`                              | Aborts when the module stops.                                                                         |
| `start()` / `stop()`                  | Lifecycle hooks; call `super` when overriding. `stop()` runs the `onStop` callbacks in reverse order. |
| `onStop(dispose)`                     | Registers cleanup for `stop()`.                                                                       |
| `secret(key)`                         | A configured secret; throws when it was not configured.                                               |
| `optionalSecret(key)`                 | A secret or `undefined`, for `"required": false` secrets.                                             |
| `outbound(key, options?)`             | The `OutboundPort` for an outbound port. Requests are aborted on stop.                                |
| `inbound(key)`                        | The `InboundPort` for an inbound port. Servers it starts close on stop.                               |
| `hasPath(key)`                        | Whether an optional host path was bound.                                                              |
| `path(key, ...segments)`              | Container path inside a bound host path; fails with `EACCES` when `segments` escape it.               |
| `statePath(...segments)`              | Path inside the persistent state directory (`"state": true`).                                         |
| `state(initial, file = "state.json")` | A `StateStore` for a JSON file in the state directory.                                                |
| `log(...values)`                      | Writes to the ScriptFS log, prefixed with the instance name.                                          |

A subclass implements file system callbacks (`getattr`, `readdir`,
`readFile`, `writeFile`, `unlink`, `mkdir`, `rmdir`, `rename`, handle-based
`open`/`read`/`write`/`release`, and so on). Each receives a
`ProviderContext` with the request path relative to the rule `root`, the
rule `options`, and an abort `signal`. Operations without a callback are
unsupported for the module's paths; the ScriptFS README describes how each
one behaves.

ScriptFS treats every method whose name matches a callback as that callback,
including methods of `TreeModule` subclasses. Give helper methods other names:
a helper called `read` or `open` becomes a positional I/O callback and
changes how files are read. The reserved names are `getattr`, `fgetattr`,
`fsetattr`, `readdir`, `readlink`, `readFile`, `open`, `opendir`, `fsyncdir`,
`releasedir`, `create`, `read`, `write`, `writeFile`, `truncate`,
`ftruncate`, `flush`, `fsync`, `release`, `access`, `chmod`, `chown`,
`utimens`, `mkdir`, `unlink`, `rmdir`, and `rename`.

## `TreeModule` and `Tree`

`TreeModule` implements the callbacks from a route table in `this.tree`:

```js
this.tree
  .directory("", () => ["README.md", "users"])
  .file("README.md", () => "# Users\n")
  .directory("users", () => this.listUsers())
  .file("users/:id", {
    read: ({ params }) => this.loadUser(params.id),
    write: (contents, { params }) => this.saveUser(params.id, contents),
    unlink: ({ params }) => this.deleteUser(params.id),
  })
  .symlink("latest", () => "users/1")
  .directory("files/*rest", ({ params }) => this.listFiles(params.rest));
```

- `:name` matches one path segment; a trailing `*name` matches one or more
  remaining segments. Literal segments win over `:name`, and
  `:name` over `*name`; equal patterns match in registration order.
- A function is shorthand for `{ list }`, `{ read }`, or `{ target }`.
- Returning `undefined` from `list`, `read`, `target`, or `metadata` means
  the entry does not exist (`ENOENT`).
- A file without `metadata` is read to compute its size. Its mode is
  `0644` when the route has `write`, and `0444` otherwise.
- Only callbacks some route supports are exposed, so a tree without any
  `write` route is read-only. Mutating a route that lacks the handler
  fails with `EACCES`.
- Writes replace whole files. Creating a file writes it twice: once empty,
  then with its contents, so name files after something stable.

`Tree` can also be used on its own; `tree.provider()` returns the
callbacks for a plain object module.

## Ports

Outbound ports reach services on the host, such as a local API server,
through a tunnel ScriptFS opens for the module. `OutboundPort` points at
the container end of the tunnel:

| Member                       | Description                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| `origin`, `url(path, query)` | `http://127.0.0.1:<port>` and URLs under it.                             |
| `fetch(path, options)`       | `fetch` with `query`, `json` body, and `timeout` (default 30 s) options. |
| `request(path, options)`     | Like `fetch`, but non-2xx responses throw `HttpError`.                   |
| `json(path, options)`        | Parsed JSON response; `undefined` for 204.                               |
| `text()`, `bytes()`          | Response body as a string or `Buffer`.                                   |
| `connect()`                  | A raw TCP `net.Socket`, for databases and other non-HTTP protocols.      |

Network failures become `ETIMEDOUT`, `EINTR`, or `EIO` errors, and
`HttpError` carries a matching code (`401` → `EACCES`, `404` → `ENOENT`,
`409` → `EEXIST`, `429` → `EAGAIN`, …), so callbacks can let them propagate.

Inbound ports let host programs call the module. `InboundPort.listen(handler)`
starts an HTTP server (or listens with a given `net.Server`) on the
container port, published on the host at `publicUrl`
(`http://127.0.0.1:<hostPort>`). A handler may throw `HttpError` to answer
with its status. `readBody`, `readJson`, and `sendJson` help with request
and response bodies.

## Utilities

- `StateStore<T>` — a JSON file with serialized `read()`, `write(value)`,
  and `update(change)`; `change` mutates a draft or returns a new value.
  Writes are atomic.
- `TtlCache<K, V>` — `get(key, load)` caches results for `ttl`
  milliseconds, shares concurrent loads, does not cache failures, and
  evicts the least recently used entries past `max`.
- `fsError(code, message?)` — an error with a file system code such as
  `ENOENT`, `EACCES`, or `EEXIST`.
- `HttpError(status, message?)` and `httpErrorCode(status)`.
- `fileMetadata()`, `directoryMetadata()`, `symlinkMetadata(target)` —
  metadata with sensible modes.

## Testing

[`@scriptfs/testing`](https://github.com/hoho/scriptfs/tree/main/packages/testing) runs a module in a real ScriptFS
container and mounts it on the host for end-to-end tests, with fake host
services for outbound ports and free host ports for inbound ones. Its
`scriptfs-module init` command creates a module project that already has a
test.
