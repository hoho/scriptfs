import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  ScriptFsModule,
  directoryMetadata,
  fileMetadata,
  fsError,
} from "@scriptfs/module";
// ScriptFS installs this package in the container from npm-shrinkwrap.json,
// because the manifest sets "dependencies": "install".
import { marked } from "marked";

// Mirrors the bound docs folder, showing each *.md file as a rendered *.html
// page. It implements the provider callbacks directly instead of using
// TreeModule, because the folder structure is only known at runtime.
export default class MarkdownHtml extends ScriptFsModule {
  async getattr({ relativePath }) {
    const found = await this.resolve(relativePath);
    if (found?.directory) return directoryMetadata({ mode: 0o555 });
    if (found) {
      const page = await this.render(found.source, relativePath);
      return fileMetadata({ mode: 0o444, size: page.length });
    }
  }

  async readdir({ relativePath }) {
    const found = await this.resolve(relativePath);
    if (!found?.directory) throw fsError(found ? "ENOTDIR" : "ENOENT");
    const entries = await readdir(found.source, { withFileTypes: true });
    return entries.flatMap((entry) => {
      if (entry.isDirectory()) return [entry.name];
      if (entry.isFile() && entry.name.endsWith(".md"))
        return [`${entry.name.slice(0, -3)}.html`];
      return [];
    });
  }

  async readFile({ relativePath }) {
    const found = await this.resolve(relativePath);
    if (!found) throw fsError("ENOENT");
    if (found.directory) throw fsError("EISDIR");
    return this.render(found.source, relativePath);
  }

  // Maps a mount path to its host folder or Markdown file.
  async resolve(relativePath) {
    const directory = this.path("docs", relativePath);
    if ((await stat(directory).catch(() => undefined))?.isDirectory())
      return { directory: true, source: directory };
    if (!relativePath.endsWith(".html")) return undefined;
    const source = this.path("docs", `${relativePath.slice(0, -5)}.md`);
    if ((await stat(source).catch(() => undefined))?.isFile())
      return { directory: false, source };
    return undefined;
  }

  async render(source, relativePath) {
    const body = await marked.parse(await readFile(source, "utf8"));
    const title = path.posix.basename(relativePath, ".html");
    return Buffer.from(
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title>` +
        `<style>${this.settings.stylesheet}</style></head>\n<body>\n${body}</body></html>\n`,
    );
  }
}
