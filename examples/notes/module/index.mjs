import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { TreeModule, TtlCache, fileMetadata } from "@scriptfs/module";

const TAG = /(?:^|\s)#([\p{L}\p{N}_-]+)/gu;

// Tags/<tag>/<note> lists every note mentioning #tag, Untagged/ the rest, and
// index.md summarizes the tags. Note files are read from the bound host path.
export default class NotesByTag extends TreeModule {
  scans = new TtlCache({ ttl: 2000 });

  constructor(runtime) {
    super(runtime);
    this.tree
      .directory("", () => ["index.md", "Tags", "Untagged"])
      .file("index.md", async () => {
        const { tags } = await this.scan();
        const lines = [...tags]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tag, notes]) => `- #${tag}: ${notes.size} note(s)`);
        return `# Tags\n\n${lines.join("\n")}\n`;
      })
      .directory("Tags", async () => [...(await this.scan()).tags.keys()])
      .directory("Tags/:tag", async ({ params }) => {
        const notes = (await this.scan()).tags.get(params.tag);
        return notes && [...notes.keys()];
      })
      .file("Tags/:tag/:note", {
        metadata: ({ params }) =>
          this.noteMetadata((scan) => scan.tags.get(params.tag), params.note),
        read: ({ params }) =>
          this.noteContents((scan) => scan.tags.get(params.tag), params.note),
      })
      .directory("Untagged", async () => [
        ...(await this.scan()).untagged.keys(),
      ])
      .file("Untagged/:note", {
        metadata: ({ params }) =>
          this.noteMetadata((scan) => scan.untagged, params.note),
        read: ({ params }) =>
          this.noteContents((scan) => scan.untagged, params.note),
      });
  }

  // Maps every tag to { display name -> note } and collects untagged notes.
  scan() {
    return this.scans.get("notes", async () => {
      const tags = new Map();
      const untagged = new Map();
      const files = await readdir(this.path("notes"), { recursive: true });
      for (const relative of files.sort()) {
        if (!this.settings.extensions.includes(path.extname(relative)))
          continue;
        const file = this.path("notes", relative);
        const text = await readFile(file, "utf8").catch(() => undefined);
        if (text === undefined) continue;
        const note = { file, size: Buffer.byteLength(text) };
        const found = new Set([...text.matchAll(TAG)].map((match) => match[1]));
        if (!found.size) add(untagged, relative, note);
        for (const tag of found) {
          if (!tags.has(tag)) tags.set(tag, new Map());
          add(tags.get(tag), relative, note);
        }
      }
      return { tags, untagged };
    });
  }

  // Helper names must not collide with filesystem callbacks such as read.
  async noteMetadata(select, name) {
    const note = select(await this.scan())?.get(name);
    return note && fileMetadata({ mode: 0o444, size: note.size });
  }

  async noteContents(select, name) {
    const note = select(await this.scan())?.get(name);
    return note && readFile(note.file);
  }
}

// Notes from subfolders keep their folder in the name: "projects - plan.md".
function add(notes, relative, note) {
  const base = relative.split(path.sep).join(" - ");
  let name = base;
  for (let copy = 2; notes.has(name); copy++) {
    const extension = path.extname(base);
    name = `${base.slice(0, -extension.length)} (${copy})${extension}`;
  }
  notes.set(name, note);
}
