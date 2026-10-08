# Receive HTTP messages as files

This example starts an HTTP endpoint inside a ScriptFS module. Posting a
message creates a readable file under `mount/Inbox`. The module stores messages
in persistent state, so stopping and restarting the mount keeps your inbox.

## 1. Start the inbox

Use Node.js 22 or newer, pnpm 12.4 or newer within version 12, Rust, GNU Make,
and a working Podman runtime. See the [host requirements](../../README.md#host-requirements).
Run these commands from the repository root in a macOS or Linux shell:

```sh
pnpm install --frozen-lockfile
make example EXAMPLE=inbox
```

Leave the CLI running. It builds ScriptFS and mounts the example, building the
local runtime image on first use. Open a second terminal at the repository root.

```sh
cat examples/inbox/mount/Inbox/README.txt
```

The generated instructions report the endpoint. With the supplied config it is
`http://127.0.0.1:18787/messages`: host port `18787` forwards to the module's
container port `8787`.

## 2. Post a message and read its file

```sh
curl --fail -H 'Content-Type: application/json' \
  -d '{"from":"me","subject":"Hi","body":"Hello from the host"}' \
  http://127.0.0.1:18787/messages

ls examples/inbox/mount/Inbox
```

With fresh state, the response is `{"id":1,"file":"0001-Hi.txt"}`. Use the
filename in your response if the inbox already contains messages:

```sh
cat examples/inbox/mount/Inbox/0001-Hi.txt
```

The file contains the sender, subject, receipt time, and message body. You can
also inspect the current messages over HTTP:

```sh
curl --fail http://127.0.0.1:18787/messages
```

The message files are read-only, but deleting one removes that message from the
stored inbox:

```sh
rm examples/inbox/mount/Inbox/0001-Hi.txt
```

## 3. Try persistent state

Post another message, then press `Ctrl+C` in the ScriptFS terminal. Start it again
with `make example EXAMPLE=inbox` and list `mount/Inbox`: the remaining messages
are still there, and new messages continue the ID sequence.

The manifest enables state with `"state": true`. ScriptFS stores it in
`examples/inbox/.scriptfs/state/inbox`, outside the generated inbox, and the
module uses `this.state()` to read and update it. The configured `maxMessages`
is 50; when that limit is exceeded, the oldest messages are dropped. Change
`modules.inbox.settings.maxMessages` in [config.json](config.json) and restart
to try a smaller limit.

## 4. Add a token or change the port

The optional token comes from `INBOX_TOKEN`. To require a bearer token for POST
requests, stop the mount and restart it with:

```sh
INBOX_TOKEN=dev-token make example EXAMPLE=inbox
```

Include the token when posting:

```sh
curl --fail -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Authenticated","body":"This request has a token"}' \
  http://127.0.0.1:18787/messages
```

Without that header, POST requests return `401`. GET requests remain readable.
To use a different host port, change `modules.inbox.ports.http.hostPort` in the
config and restart; the generated `Inbox/README.txt` will report the new URL.

## 5. Follow the module and run its tests

Read [module/scriptfs.module.json](module/scriptfs.module.json) for the inbound
port, optional secret, setting, and state declarations. In
[module/index.mjs](module/index.mjs), `start()` registers the HTTP handler and
`TreeModule` exposes the stored messages as files. The `Inbox/**` rule adds that
tree alongside the ordinary files from `module/`, which is the filesystem's
source. The mount and persistent state directories are outside that source.

Stop the CLI with `Ctrl+C`, then run all example tests from the repository root:

```sh
make test-examples
```

The [inbox tests](module/test/http-inbox.test.mjs) cover HTTP requests, tokens,
retention limits, deletion, and persistent state across restarts.
