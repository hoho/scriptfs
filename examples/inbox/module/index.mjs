import {
  HttpError,
  TreeModule,
  fileMetadata,
  fsError,
  readJson,
  sendJson,
} from "@scriptfs/module";

function slug(text) {
  return (
    text
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "message"
  );
}

function render(message) {
  return [
    `From: ${message.from}`,
    `Subject: ${message.subject}`,
    `Date: ${message.receivedAt}`,
    "",
    message.body,
    "",
  ].join("\n");
}

// Host tools POST messages to the inbound port; they are kept in the state
// directory, listed as Inbox/<id>-<subject>.txt, and deleted with rm.
export default class HttpInbox extends TreeModule {
  store = this.state({ nextId: 1, messages: [] });

  constructor(runtime) {
    super(runtime);
    this.tree
      .directory("", async () => [
        "README.txt",
        ...(await this.store.read()).messages.map((message) =>
          this.fileName(message),
        ),
      ])
      .file(
        "README.txt",
        () =>
          `POST messages to ${this.inbound("http").publicUrl}/messages, e.g.\n\n` +
          `curl -d '{"from":"me","subject":"Hi","body":"Hello"}' \\\n` +
          `  ${this.inbound("http").publicUrl}/messages\n`,
      )
      .file(":file", {
        metadata: async ({ params }) => {
          const message = await this.find(params.file);
          return (
            message &&
            fileMetadata({
              mode: 0o444,
              size: Buffer.byteLength(render(message)),
              mtime: new Date(message.receivedAt),
            })
          );
        },
        read: async ({ params }) => {
          const message = await this.find(params.file);
          return message && render(message);
        },
        unlink: async ({ params }) => {
          const message = await this.find(params.file);
          if (!message) throw fsError("ENOENT");
          await this.store.update((state) => {
            state.messages = state.messages.filter(
              (item) => item.id !== message.id,
            );
          });
        },
      });
  }

  async start() {
    await super.start();
    await this.inbound("http").listen((request, response) =>
      this.handle(request, response),
    );
    this.log(`accepting messages at ${this.inbound("http").publicUrl}`);
  }

  async handle(request, response) {
    if (request.url !== "/messages") throw new HttpError(404, "Not found");
    if (request.method === "GET") {
      sendJson(response, 200, (await this.store.read()).messages);
      return;
    }
    if (request.method !== "POST") throw new HttpError(405, "Use GET or POST");
    const token = this.optionalSecret("token");
    if (token && request.headers.authorization !== `Bearer ${token}`)
      throw new HttpError(401, "Unauthorized");
    const input = await readJson(request);
    if (typeof input?.body !== "string")
      throw new HttpError(400, "body must be a string");
    const state = await this.store.update((state) => {
      state.messages.push({
        id: state.nextId++,
        from: String(input.from ?? "anonymous"),
        subject: String(input.subject ?? "(no subject)"),
        body: input.body,
        receivedAt: new Date().toISOString(),
      });
      state.messages = state.messages.slice(-this.settings.maxMessages);
    });
    const message = state.messages.at(-1);
    sendJson(response, 201, { id: message.id, file: this.fileName(message) });
  }

  fileName(message) {
    return `${String(message.id).padStart(4, "0")}-${slug(message.subject)}.txt`;
  }

  async find(file) {
    const id = Number.parseInt(file, 10);
    const message = (await this.store.read()).messages.find(
      (item) => item.id === id,
    );
    return message && this.fileName(message) === file ? message : undefined;
  }
}
