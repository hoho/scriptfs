import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { startModule, waitFor } from "@scriptfs/testing";

let notes;

before(async () => {
  notes = await startModule({
    module: new URL("..", import.meta.url),
    // The harness creates the bound notes folder from these files.
    paths: {
      notes: {
        files: {
          "groceries.md": "Milk and #errands\n",
          "ideas.txt": "A #project idea\n",
          "journal.md": "Nothing to tag today\n",
          "projects/plan.md": "The #project plan, also #errands\n",
          "photo.jpg": "not a note",
        },
      },
    },
  });
});

after(() => notes?.stop());

test("groups notes by tag", async () => {
  assert.deepEqual(await notes.list(), ["Tags", "Untagged", "index.md"]);
  assert.deepEqual(await notes.list("Tags"), ["errands", "project"]);
  assert.deepEqual(await notes.list("Tags/project"), [
    "ideas.txt",
    "projects - plan.md",
  ]);
  assert.deepEqual(await notes.list("Untagged"), ["journal.md"]);
  assert.equal(
    await notes.readText("Tags/errands/groceries.md"),
    "Milk and #errands\n",
  );
  assert.equal(
    await notes.readText("index.md"),
    "# Tags\n\n- #errands: 2 note(s)\n- #project: 2 note(s)\n",
  );
});

test("serves notes read-only", async () => {
  await assert.rejects(notes.write("Untagged/journal.md", "changed"));
  await assert.rejects(notes.write("Untagged/new.md", "new"));
});

test("picks up changes to the host folder", async () => {
  const folder = notes.hostPath("notes");
  await writeFile(path.join(folder, "trip.md"), "Pack for the #trip\n");
  await rm(path.join(folder, "journal.md"));

  // Scans are cached for two seconds.
  await waitFor(async () => (await notes.list("Tags")).includes("trip"));
  assert.deepEqual(await notes.list("Tags/trip"), ["trip.md"]);
  assert.deepEqual(await notes.list("Untagged"), []);
});
