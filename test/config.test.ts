import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig, scriptFsConfigSchema } from "../src/config.js";
import { pathToFileURL } from "node:url";
import {
  compileRules,
  normalizeVirtualPath,
  staticChildForDirectory,
} from "../src/overlay/rules.js";

const temporaryDirectories: string[] = [];

it.each([
  "global",
  "GLOBAL",
  "gLoBaL",
  "homes",
  "HOMES",
  "printers",
  "Printers",
])(
  "rejects reserved Samba share name %s in config loading and the editor schema",
  async (name) => {
    const config = {
      filesystems: [{ name, source: ".", mountPoint: "mount" }],
    };
    expect(() => scriptFsConfigSchema.parse(config)).toThrow("reserved Samba");
    const directory = await mkdtemp(
      path.join(tmpdir(), "scriptfs-reserved-name-"),
    );
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadConfig(configPath)).rejects.toThrow("reserved Samba");
    const schema = JSON.parse(
      await readFile(
        new URL("../scriptfs.schema.json", import.meta.url),
        "utf8",
      ),
    ) as {
      properties: {
        filesystems: {
          items: { properties: { name: { not: { pattern: string } } } };
        };
      };
    };
    expect(
      new RegExp(
        schema.properties.filesystems.items.properties.name.not.pattern,
      ).test(name),
    ).toBe(true);
  },
);

it.each(["global-data", "my-homes", "printers_1"])(
  "allows share names containing but not equal to reserved names: %s",
  (name) => {
    expect(
      scriptFsConfigSchema.safeParse({
        filesystems: [{ name, source: ".", mountPoint: "mount" }],
      }).success,
    ).toBe(true);
  },
);

it("resolves installed providers with import-only exports relative to the config", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "scriptfs-import-provider-"),
  );
  temporaryDirectories.push(directory);
  const provider = path.join(directory, "node_modules", "provider");
  await mkdir(provider, { recursive: true });
  await writeFile(
    path.join(provider, "package.json"),
    JSON.stringify({
      name: "provider",
      type: "module",
      exports: { ".": { import: "./provider.mjs" } },
    }),
  );
  await writeFile(path.join(provider, "provider.mjs"), "export default {}");
  const configPath = path.join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      filesystems: [
        {
          name: "test",
          source: ".",
          mountPoint: "mount",
          rules: [{ match: "file", provider: { module: "provider" } }],
        },
      ],
    }),
  );
  const config = await loadConfig(configPath);
  const rule = config.filesystems[0]?.rules?.[0];
  // Windows realpath implementations can preserve or expand short names.
  expect(
    rule && "provider" in rule && "module" in rule.provider
      ? await realpath(rule.provider.module)
      : undefined,
  ).toBe(await realpath(path.join(provider, "provider.mjs")));
});

it("decodes file URLs containing escaped spaces", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scriptfs-file-url-"));
  temporaryDirectories.push(directory);
  const module = path.join(directory, "provider with space.mjs");
  await writeFile(module, "export default {}");
  const configPath = path.join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      filesystems: [
        {
          name: "test",
          source: ".",
          mountPoint: "mount",
          rules: [
            { match: "file", provider: { module: pathToFileURL(module).href } },
          ],
        },
      ],
    }),
  );
  const config = await loadConfig(configPath);
  expect(config.filesystems[0]?.rules?.[0]).toMatchObject({
    provider: { module },
  });
});

it("resolves relative file URLs from the configuration directory", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "scriptfs-relative-file-url-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      filesystems: [
        {
          name: "test",
          source: ".",
          mountPoint: "mount",
          rules: [
            {
              match: "file",
              provider: { module: "file:./providers/provider%20name.mjs" },
            },
          ],
        },
      ],
    }),
  );

  const config = await loadConfig(configPath);
  expect(config.filesystems[0]?.rules?.[0]).toMatchObject({
    provider: {
      module: path.join(directory, "providers", "provider name.mjs"),
    },
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("keeps the exhaustive example configuration valid", async () => {
  const config = await loadConfig(path.resolve("examples/config.json"));

  expect(config.filesystems).toHaveLength(2);
  expect(config.filesystems.map(({ readOnly }) => readOnly)).toEqual([
    false,
    true,
  ]);
  expect(config.container).toEqual({
    image: "localhost/scriptfs-runtime:0.0.2",
    rebuild: false,
    smbHost: "127.0.0.1",
    smbPort: 14_445,
    logLevel: "info",
  });

  const rules = config.filesystems[0]?.rules ?? [];
  expect(
    rules
      .filter((rule) => "file" in rule && rule.file?.sizeMode)
      .map((rule) => ("file" in rule ? rule.file?.sizeMode : undefined)),
  ).toEqual(
    expect.arrayContaining(["content", "explicit", "zero", "unbounded"]),
  );
  expect(
    rules
      .filter((rule) => "provider" in rule)
      .map((rule) => ("provider" in rule ? rule.provider.type : undefined)),
  ).toContain("module");
  expect(
    rules
      .filter((rule) => "provider" in rule)
      .map((rule) => ("provider" in rule ? rule.provider.type : undefined)),
  ).toContain("file");
  expect(
    rules
      .filter((rule) => "provider" in rule)
      .map((rule) => ("provider" in rule ? rule.provider.type : undefined)),
  ).toContain("directory");
  expect(rules.some((rule) => "hide" in rule)).toBe(true);
});

it("resolves filesystem and provider paths relative to the config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scriptfs-config-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      filesystems: [
        {
          name: "code",
          source: "./source",
          mountPoint: "./mount",
          rules: [
            {
              match: "GeneratedCatalog/**",
              provider: { module: "./providers/catalog.mjs" },
            },
          ],
        },
      ],
    }),
  );

  const config = await loadConfig(configPath);

  expect(config.filesystems[0]?.source).toBe(path.join(directory, "source"));
  expect(config.filesystems[0]?.mountPoint).toBe(path.join(directory, "mount"));
  const rule = config.filesystems[0]?.rules?.[0];
  expect(
    rule && "provider" in rule && "module" in rule.provider
      ? rule.provider.module
      : undefined,
  ).toBe(path.join(directory, "providers", "catalog.mjs"));
});

it("normalizes POSIX paths while preserving literal backslashes", () => {
  expect(normalizeVirtualPath("/GeneratedCatalog//Datasets/./Batch1")).toBe(
    "GeneratedCatalog/Datasets/Batch1",
  );
  for (const name of [
    "\\GeneratedCatalog\\Datasets\\Batch1",
    "..\\secret",
    "directory\\..\\secret",
  ]) {
    expect(normalizeVirtualPath(name)).toBe(name);
  }
});

it("rejects parent traversal components without rejecting similar names", () => {
  for (const invalid of [
    "../secret",
    "directory/../secret",
    "directory\\name/../secret",
    "directory/..",
  ]) {
    expect(() => normalizeVirtualPath(invalid)).toThrow("Invalid virtual path");
  }
  expect(normalizeVirtualPath("..notes")).toBe("..notes");
  expect(normalizeVirtualPath("directory/..notes")).toBe("directory/..notes");
});

it.each([
  ["C++/**", "C++"],
  ["team@host/*.txt", "team@host"],
  ["wow!/file.txt", "wow!"],
  ["literal{tag}/**", "literal{tag}"],
  ["escaped\\*/**", "escaped*"],
  ["back\\\\slash/**", "back\\slash"],
  ["@(one|two)/**", ""],
  ["root/+(one|two)/**", "root"],
  ["root/[ab]/*.txt", "root"],
  ["root/{one,two}/*.txt", "root"],
  ["!ignored.txt", ""],
])("infers the static root of %s as %s", (match, root) => {
  expect(
    compileRules([{ match, provider: { module: "memory" } }]).providers[0]
      ?.root,
  ).toBe(root);
});

it.each(["*", "?", "[ab]", "{one,two}", "@(one|two)", "+(one|two)", "!(one)"])(
  "does not synthesize a literal entry for the glob %s",
  (pattern) => {
    expect(staticChildForDirectory(`root/${pattern}`, "root")).toBeUndefined();
  },
);

it("distinguishes leading negation from literal exclamation marks in child names", () => {
  expect(staticChildForDirectory("!ignored.txt", "")).toBeUndefined();
  expect(staticChildForDirectory("root/!literal.txt", "root")).toBe(
    "!literal.txt",
  );
  expect(staticChildForDirectory("@(one|two)/data.txt", "one")).toBe(
    "data.txt",
  );
  expect(
    staticChildForDirectory("@(one|two)/data.txt", "three"),
  ).toBeUndefined();
});

it("accepts proxy providers only when their target type matches", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scriptfs-proxy-"));
  temporaryDirectories.push(directory);
  const targetFile = path.join(directory, "target.txt");
  const targetDirectory = path.join(directory, "target-directory");
  await writeFile(targetFile, "target");
  await mkdir(targetDirectory);

  const validConfigPath = path.join(directory, "valid.json");
  await writeFile(
    validConfigPath,
    JSON.stringify({
      filesystems: [
        {
          name: "proxy",
          source: ".",
          mountPoint: "./mount",
          rules: [
            {
              match: "ProxyFile.txt",
              provider: { type: "file", path: "./target.txt" },
            },
            {
              match: "ProxyDirectory/**",
              root: "ProxyDirectory",
              provider: {
                type: "directory",
                path: "./target-directory",
              },
            },
          ],
        },
      ],
    }),
  );
  const valid = await loadConfig(validConfigPath);
  const providers = valid.filesystems[0]?.rules
    ?.filter((rule) => "provider" in rule)
    .map((rule) => ("provider" in rule ? rule.provider : undefined));
  expect(providers).toEqual([
    { type: "file", path: targetFile },
    { type: "directory", path: targetDirectory },
  ]);

  const invalidConfigPath = path.join(directory, "invalid.json");
  await writeFile(
    invalidConfigPath,
    JSON.stringify({
      filesystems: [
        {
          name: "proxy",
          source: ".",
          mountPoint: "./mount",
          rules: [
            {
              match: "Wrong",
              provider: { type: "file", path: "./target-directory" },
            },
          ],
        },
      ],
    }),
  );
  await expect(loadConfig(invalidConfigPath)).rejects.toThrow(
    "file provider target has the wrong type",
  );
});

it.each(["file", "directory"] as const)(
  "validates symbolic-link targets for %s proxies",
  async (type) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "scriptfs-proxy-link-"),
    );
    temporaryDirectories.push(directory);
    const target = path.join(directory, "target");
    if (type === "file") await writeFile(target, "target");
    else await mkdir(target);
    await symlink("target", path.join(directory, "alias"));
    const configPath = path.join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        filesystems: [
          {
            name: "proxy",
            source: ".",
            mountPoint: "./mount",
            rules: [
              {
                match: "Proxy",
                provider: { type, path: "./alias" },
              },
            ],
          },
        ],
      }),
    );
    if (type === "file") {
      await expect(loadConfig(configPath)).rejects.toThrow(
        "a regular file, not a symbolic link",
      );
    } else {
      await expect(loadConfig(configPath)).resolves.toMatchObject({
        filesystems: [
          {
            rules: [
              { provider: { type, path: path.join(directory, "alias") } },
            ],
          },
        ],
      });
    }
  },
);
