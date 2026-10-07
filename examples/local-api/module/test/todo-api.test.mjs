import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { hostServer, startModule } from "@scriptfs/testing";

const TOKEN = "test-token";

// A fake of the todo API, running on the host like the real one would. The
// module reaches it through its outbound "api" port.
const todos = new Map();
let nextId = 1;
const json = (value, status = 200) => Response.json(value, { status });

async function handle(request) {
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`)
    return json({ error: "Unauthorized" }, 401);
  const [, collection, id] = new URL(request.url).pathname.split("/");
  if (collection !== "todos") return undefined;
  if (id === undefined) {
    if (request.method === "GET") return json([...todos.values()]);
    const input = await request.json();
    const todo = { id: nextId++, done: false, notes: "", ...input };
    todos.set(todo.id, todo);
    return json(todo, 201);
  }
  const todo = todos.get(Number(id));
  if (!todo) return json({ error: "No such todo" }, 404);
  if (request.method === "PATCH") {
    Object.assign(todo, await request.json());
    return json(todo);
  }
  if (request.method === "DELETE") {
    todos.delete(todo.id);
    return new Response(null, { status: 204 });
  }
  return undefined;
}

let api;
let todo;

before(async () => {
  api = await hostServer(handle);
  todo = await startModule({
    module: new URL("..", import.meta.url),
    secrets: { token: TOKEN },
    outbound: { api },
    // No caching, so every read sees the latest API state.
    settings: { cacheSeconds: 0 },
  });
});

after(async () => {
  await todo?.stop();
  await api?.close();
});

beforeEach(() => {
  todos.clear();
  todos.set(1, { id: 1, title: "Buy milk", done: false, notes: "" });
  todos.set(2, { id: 2, title: "Call mom", done: true, notes: "Sunday" });
  nextId = 3;
});

test("lists todos from the API as Markdown files", async () => {
  assert.deepEqual(await todo.list(), ["Buy milk.md", "Call mom.md"]);
  assert.equal(await todo.readText("Buy milk.md"), "- [ ] Buy milk\n");
  assert.equal(
    await todo.readText("Call mom.md"),
    "- [x] Call mom\n\nSunday\n",
  );
});

test("sends the token secret to the API", async () => {
  await todo.list();
  const last = api.requests.at(-1);
  assert.equal(last.method, "GET");
  assert.equal(last.path, "/todos");
  assert.equal(last.headers.authorization, `Bearer ${TOKEN}`);
});

test("creates, updates and deletes todos through files", async () => {
  await writeFile(todo.path("Water plants.md"), "- [ ] Water plants\n");
  assert.deepEqual(todos.get(3), {
    id: 3,
    title: "Water plants",
    done: false,
    notes: "",
  });

  await writeFile(todo.path("Buy milk.md"), "- [x] Buy milk\n\nOat milk\n");
  assert.equal(todos.get(1).done, true);
  assert.equal(todos.get(1).notes, "Oat milk");
  assert.equal(
    await readFile(todo.path("Buy milk.md"), "utf8"),
    "- [x] Buy milk\n\nOat milk\n",
  );

  await rm(todo.path("Call mom.md"));
  assert.equal(todos.has(2), false);
  assert.deepEqual(await todo.list(), ["Buy milk.md", "Water plants.md"]);
});

test("rejects files that are not todos", async () => {
  await assert.rejects(writeFile(todo.path("notes.txt"), "x"), {
    code: "EACCES",
  });
  await assert.rejects(rm(todo.path("Missing.md")), { code: "ENOENT" });
  assert.equal(todos.size, 2);
});
