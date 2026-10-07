import path from "node:path";

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

const directories = new Map([
  [
    "",
    [
      "Datasets",
      "AGENTS.md",
      "ContentSized.txt",
      "FixedSize.bin",
      "CommandSink.txt",
      "GeneratedStream.bin",
      "SequentialStream.bin",
    ],
  ],
  ["Datasets", ["Batch1"]],
  ["Datasets/Batch1", ["Record1"]],
  ["Datasets/Batch1/Record1", ["data.txt", "action.txt"]],
]);
const contents = new Map([
  [
    "AGENTS.md",
    "Read data.txt; write commands to action.txt. Tools/Memory demonstrates mutable resources.\n",
  ],
  ["ContentSized.txt", "This size is derived from readFile.\n"],
  ["Datasets/Batch1/Record1/data.txt", "Generated record contents.\n"],
  ["Datasets/Batch1/Record1/action.txt", ""],
  ["hidden.private", "Hide rules filter generated files too.\n"],
]);

export default {
  getattr({ relativePath }) {
    if (directories.has(relativePath))
      return { kind: "directory", mode: 0o755 };
    if (relativePath.endsWith("/action.txt"))
      return { kind: "file", mode: 0o200, size: 0 };
    if (contents.has(relativePath)) return { kind: "file" };
  },
  readdir({ relativePath }) {
    const listed = directories.get(relativePath);
    if (!listed) return;
    const prefix = relativePath ? `${relativePath}/` : "";
    const added = [...contents.keys()]
      .filter(
        (name) =>
          name.startsWith(prefix) && !name.slice(prefix.length).includes("/"),
      )
      .map((name) => name.slice(prefix.length));
    return [...new Set([...listed, ...added])];
  },
  readFile({ relativePath }) {
    const value = contents.get(relativePath);
    if (value === undefined) throw fsError("ENOENT");
    return value;
  },
  writeFile(value, { relativePath, previousContents, options }) {
    const parent = path.posix.dirname(relativePath);
    if (!directories.has(parent === "." ? "" : parent)) throw fsError("ENOENT");
    if (!relativePath.endsWith("/action.txt"))
      contents.set(relativePath, value.toString());
    console.log(
      `[${options?.catalogName ?? "catalog"}] write ${relativePath}: ${value.toString()} (previous ${previousContents?.length ?? 0} bytes)`,
    );
  },
};
