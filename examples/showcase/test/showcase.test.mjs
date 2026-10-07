import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { startModule } from "@scriptfs/testing";

describe("components module over a source folder", () => {
  let components;

  before(async () => {
    components = await startModule({
      module: new URL("../modules/components", import.meta.url),
      instance: "components",
      settings: { heading: "Read me first" },
      // The source folder the module overlays, like a real project.
      source: {
        "components/Button/Button.js": "export const Button = 1;\n",
        "components/Card/Card.js": "export const Card = 1;\n",
        "README.md": "# Project\n",
      },
      // Only AGENTS.md comes from the module; every other path is the source.
      rules: [
        {
          match: "components/*/AGENTS.md",
          provider: { module: "components" },
        },
      ],
    });
  });

  after(() => components?.stop());

  test("adds AGENTS.md next to every component", async () => {
    assert.equal(
      await components.readText("components/Card/AGENTS.md"),
      "# Read me first\n\nGenerated for `components/Card/AGENTS.md`.\n",
    );
    assert.equal(
      await components.readText("components/Button/Button.js"),
      "export const Button = 1;\n",
    );
    assert.equal(await components.readText("README.md"), "# Project\n");
  });

  test("leaves the rest of the source writable", async () => {
    await components.write("components/Card/Card.test.js", "test\n");
    assert.ok(
      (await components.list("components/Card")).includes("Card.test.js"),
    );
    assert.equal(await components.exists("components/Card/README.md"), false);
  });
});

describe("memory module", () => {
  let memory;

  before(async () => {
    memory = await startModule({
      module: new URL("../modules/memory", import.meta.url),
    });
  });

  after(() => memory?.stop());

  test("starts with its initial tree", async () => {
    assert.deepEqual(await memory.list(), [
      "AGENTS.md",
      "data.txt",
      "hidden.private",
      "latest",
    ]);
    // SMB clients may resolve the symlink on the server side, so read it.
    assert.equal(
      await memory.readText("latest"),
      await memory.readText("data.txt"),
    );
  });

  test("supports directories, renames and deletes", async () => {
    await mkdir(memory.path("drafts"));
    await writeFile(memory.path("drafts", "a.txt"), "first draft");
    await rename(memory.path("drafts", "a.txt"), memory.path("final.txt"));
    assert.deepEqual(await readdir(memory.path("drafts")), []);
    assert.equal(
      await readFile(memory.path("final.txt"), "utf8"),
      "first draft",
    );
    await rmdir(memory.path("drafts"));
    await unlink(memory.path("final.txt"));
    assert.equal(await memory.exists("drafts"), false);
    assert.equal(await memory.exists("final.txt"), false);
  });

  test("keeps changes until the session restarts", async () => {
    await memory.write("note.txt", "kept in memory");
    assert.equal(await memory.readText("note.txt"), "kept in memory");
    await memory.restart();
    assert.equal(await memory.exists("note.txt"), false);
  });
});
