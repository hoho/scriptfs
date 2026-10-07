import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The version of this package, used for the scaffold's dependencies. */
export async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return manifest.version;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Files of a new module project, by relative path. */
export function scaffold(
  name: string,
  version: string,
): Record<string, string> {
  if (!NAME.test(name))
    throw new Error(
      `Invalid module name ${JSON.stringify(name)}: use lowercase letters, numbers, ".", "_" and "-"`,
    );
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "scriptfs.module.json": json({
      $schema: "./node_modules/scriptfs/scriptfs-module.schema.json",
      name,
      version: "0.1.0",
      description: "Describe what the module shows.",
      entry: "./index.mjs",
      settings: {
        greeting: {
          type: "string",
          description: "Text of hello.txt.",
          default: "Hello from ScriptFS",
        },
      },
    }),
    "index.mjs": `import { TreeModule } from "@scriptfs/module";

export default class Module extends TreeModule {
  constructor(runtime) {
    super(runtime);
    this.tree
      .directory("", () => ["hello.txt"])
      .file("hello.txt", () => \`\${this.settings.greeting}\\n\`);
  }
}
`,
    "package.json": json({
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      files: ["index.mjs", "scriptfs.module.json"],
      scripts: { test: "node --test" },
      peerDependencies: { "@scriptfs/module": `>=${version}` },
      peerDependenciesMeta: { "@scriptfs/module": { optional: true } },
      devDependencies: {
        "@scriptfs/module": `^${version}`,
        "@scriptfs/testing": `^${version}`,
        "scriptfs": `^${version}`,
      },
    }),
    "test/module.test.mjs": `import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startModule } from "@scriptfs/testing";

let module;
before(async () => {
  module = await startModule({
    module: new URL("..", import.meta.url),
    settings: { greeting: "Hello, test" },
  });
});
after(() => module?.stop());

test("serves hello.txt with the configured greeting", async () => {
  assert.deepEqual(await module.list(), ["hello.txt"]);
  assert.equal(await module.readText("hello.txt"), "Hello, test\\n");
});
`,
    ".gitignore": "node_modules/\n",
    "README.md": `# ${name}

A [ScriptFS](https://github.com/hoho/scriptfs) module.

\`\`\`sh
npm install
npx scriptfs-module check     # validate the manifest
npx scriptfs-module dev       # mount the module and try it
npm test                      # run the end-to-end tests
\`\`\`
`,
  };
}

/** Writes a new module project into `directory`, which must not have one. */
export async function init(
  directory: string,
  name: string,
  version: string,
): Promise<string[]> {
  const files = scaffold(name, version);
  await mkdir(directory, { recursive: true });
  for (const relative of Object.keys(files)) {
    const existing = await readFile(path.join(directory, relative)).then(
      () => true,
      () => false,
    );
    if (existing)
      throw new Error(
        `${path.join(directory, relative)} already exists; choose an empty folder`,
      );
  }
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, { flag: "wx" });
  }
  return Object.keys(files);
}
