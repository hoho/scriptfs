// A small todo service that runs on the host, outside the ScriptFS container.
// Start it with: TODO_API_TOKEN=dev-token node examples/local-api/server.mjs
import http from "node:http";

const token = process.env.TODO_API_TOKEN;
if (!token) {
  console.error("Set TODO_API_TOKEN to the token the module should send.");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4310);
const todos = new Map();
let nextId = 1;
for (const title of ["Buy milk", "Water the plants"])
  todos.set(nextId, { id: nextId++, title, done: false, notes: "" });

function send(response, status, value) {
  const body = value === undefined ? "" : JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return undefined;
  }
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`)
    return send(response, 401, { error: "Unauthorized" });
  const [, collection, id] = request.url.split("?")[0].split("/");
  if (collection !== "todos")
    return send(response, 404, { error: "Not found" });
  const todo = id === undefined ? undefined : todos.get(Number(id));
  if (id !== undefined && !todo)
    return send(response, 404, { error: "No such todo" });
  if (request.method === "GET")
    return send(response, 200, todo ?? [...todos.values()]);
  if (request.method === "DELETE" && todo) {
    todos.delete(todo.id);
    return send(response, 204);
  }
  const input = await body(request);
  if (!input || typeof input !== "object")
    return send(response, 400, { error: "Invalid JSON" });
  if (request.method === "POST" && !todo) {
    if (typeof input.title !== "string" || !input.title.trim())
      return send(response, 400, { error: "title is required" });
    if ([...todos.values()].some((item) => item.title === input.title))
      return send(response, 409, { error: "A todo with this title exists" });
    const created = {
      id: nextId++,
      title: input.title,
      done: input.done === true,
      notes: typeof input.notes === "string" ? input.notes : "",
    };
    todos.set(created.id, created);
    return send(response, 201, created);
  }
  if (request.method === "PATCH" && todo) {
    if (typeof input.done === "boolean") todo.done = input.done;
    if (typeof input.notes === "string") todo.notes = input.notes;
    return send(response, 200, todo);
  }
  send(response, 405, { error: "Method not allowed" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Todo API listening on http://127.0.0.1:${port}/todos`);
});
