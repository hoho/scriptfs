import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startModule } from "@scriptfs/testing";

let pages;

// The manifest sets "dependencies": "install", so starting the module
// installs marked from npm-shrinkwrap.json into a cache on first use.
before(async () => {
  pages = await startModule({
    module: new URL("..", import.meta.url),
    settings: { stylesheet: "body { color: teal }" },
    paths: {
      docs: {
        files: {
          "index.md": "# Welcome\n\nSee the *guides*.\n",
          "guides/setup.md": "## Setup\n\n- one\n- two\n",
          "guides/diagram.png": "not Markdown",
        },
      },
    },
  });
});

after(() => pages?.stop());

test("mirrors the docs folder as HTML pages", async () => {
  assert.deepEqual(await pages.list(), ["guides", "index.html"]);
  assert.deepEqual(await pages.list("guides"), ["setup.html"]);
  assert.equal(await pages.exists("guides/diagram.png"), false);
  assert.equal(await pages.exists("index.md"), false);
});

test("renders Markdown with the installed marked package", async () => {
  const page = await pages.readText("index.html");
  assert.match(page, /<title>index<\/title>/);
  assert.match(page, /<style>body \{ color: teal \}<\/style>/);
  assert.match(page, /<h1>Welcome<\/h1>/);
  assert.match(page, /<em>guides<\/em>/);
  assert.match(
    await pages.readText("guides/setup.html"),
    /<h2>Setup<\/h2>\n<ul>\n<li>one<\/li>/,
  );
});

test("serves pages read-only", async () => {
  await assert.rejects(pages.write("index.html", "changed"));
});
