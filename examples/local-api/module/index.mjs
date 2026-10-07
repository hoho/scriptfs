import { TreeModule, TtlCache, fsError } from "@scriptfs/module";

// Each todo is a Markdown file named after its title:
//
//   - [ ] Buy milk
//
//   Optional notes.
//
// Creating a file creates a todo, editing the checkbox or notes updates it,
// and deleting the file deletes the todo.
function render(todo) {
  const notes = todo.notes ? `\n${todo.notes.trimEnd()}\n` : "";
  return `- [${todo.done ? "x" : " "}] ${todo.title}\n${notes}`;
}

function parse(text) {
  const [first = "", ...rest] = text.split(/\r?\n/);
  return {
    done: /^\s*-\s*\[[xX]\]/.test(first),
    notes: rest.join("\n").trim(),
  };
}

export default class TodoApi extends TreeModule {
  api = this.outbound("api");
  headers = { authorization: `Bearer ${this.secret("token")}` };
  todos = new TtlCache({ ttl: this.settings.cacheSeconds * 1000 });

  constructor(runtime) {
    super(runtime);
    this.tree
      .directory("", async () =>
        (await this.list()).map((todo) => `${todo.title}.md`),
      )
      .file(":name", {
        read: async ({ params }) => {
          const todo = await this.find(params.name);
          return todo && render(todo);
        },
        write: (contents, { params }) => this.save(params.name, contents),
        unlink: ({ params }) => this.remove(params.name),
      });
  }

  list() {
    return this.todos.get("all", () =>
      this.api.json("/todos", { headers: this.headers }),
    );
  }

  async find(name) {
    if (!name.endsWith(".md")) return undefined;
    const title = name.slice(0, -3);
    return (await this.list()).find((todo) => todo.title === title);
  }

  async save(name, contents) {
    if (!name.endsWith(".md")) throw fsError("EACCES", "Todos are .md files");
    const changes = parse(contents.toString("utf8"));
    const todo = await this.find(name);
    try {
      if (todo)
        await this.api.json(`/todos/${todo.id}`, {
          method: "PATCH",
          headers: this.headers,
          json: changes,
        });
      else
        await this.api.json("/todos", {
          method: "POST",
          headers: this.headers,
          json: { title: name.slice(0, -3), ...changes },
        });
    } finally {
      this.todos.clear();
    }
    this.log(`${todo ? "updated" : "created"} ${name}`);
  }

  async remove(name) {
    const todo = await this.find(name);
    if (!todo) throw fsError("ENOENT");
    try {
      await this.api.request(`/todos/${todo.id}`, {
        method: "DELETE",
        headers: this.headers,
      });
    } finally {
      this.todos.clear();
    }
  }
}
