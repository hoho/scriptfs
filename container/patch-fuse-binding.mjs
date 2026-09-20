import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  process.argv[2] ?? "node_modules/@cocalc/fuse-native",
);
const statfsFields = [
  "bsize",
  "frsize",
  "blocks",
  "bfree",
  "bavail",
  "files",
  "ffree",
  "favail",
  "fsid",
  "flag",
  "namemax",
];
const [fileAttributesC, fileAttributesJs] = await Promise.all([
  readFile(new URL("./fuse-file-attributes.c.inc", import.meta.url), "utf8"),
  readFile(new URL("./fuse-file-attributes.js.inc", import.meta.url), "utf8"),
]);
/** @type {unknown} */
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
if (
  !manifest ||
  typeof manifest !== "object" ||
  !("name" in manifest) ||
  !("version" in manifest) ||
  manifest.name !== "@cocalc/fuse-native" ||
  manifest.version !== "2.4.3"
) {
  throw new Error(
    "Review native compatibility patches before changing fuse-native versions",
  );
}

const patches = [
  {
    file: "fuse-native.c",
    edits: [
      ...["open", "create"].flatMap((operation) => [
        {
          pattern: new RegExp(`FUSE_METHOD\\(${operation}, 2, 1,`, "g"),
          replacement: `FUSE_METHOD(${operation}, 2, 2,`,
        },
        {
          pattern: new RegExp(
            `(FUSE_METHOD\\(${operation}, 2, 2,[\\s\\S]*?NAPI_ARGV_INT32\\(fd, 2\\))`,
            "g",
          ),
          replacement:
            "$1\n  NAPI_ARGV_UINT32(direct_io, 3)\n  l->info->direct_io = direct_io != 0;",
        },
      ]),
      {
        pattern: /FUSE_METHOD\(create, 2, 2,/g,
        replacement: "FUSE_METHOD(create, 3, 2,",
      },
      {
        pattern:
          /(FUSE_METHOD\(create, 3, 2,[\s\S]*?napi_create_uint32\(env, l->mode, &\(argv\[3\]\)\);)/g,
        replacement:
          "$1\n  napi_create_int32(env, l->info->flags, &(argv[4]));",
      },
      {
        pattern: /static void populate_statvfs \([^\n]+\) \{[\s\S]*?\n\}/g,
        replacement: [
          "static void populate_statvfs (uint32_t *ints, struct statvfs* statvfs) {",
          ...statfsFields.map(
            (field) => `  statvfs->f_${field} = uint32s_to_uint64(&ints);`,
          ),
          "}",
        ].join("\n"),
      },
      {
        pattern: /FUSE_UINT64_TO_INTS_ARGV\(l->atime, 5\)/g,
        replacement: "FUSE_UINT64_TO_INTS_ARGV(l->mtime, 5)",
      },
      {
        pattern: /static void uint32s_to_timespec \([^\n]+\) \{[\s\S]*?\n\}/g,
        replacement: [
          "static void uint32s_to_timespec (struct timespec* ts, uint32_t** ints) {",
          "  int64_t ms = (int64_t) uint32s_to_uint64(ints);",
          "  ts->tv_sec = ms / 1000;",
          "  int64_t remainder = ms % 1000;",
          "  if (remainder < 0) {",
          "    ts->tv_sec--;",
          "    remainder += 1000;",
          "  }",
          "  ts->tv_nsec = remainder * 1000000;",
          "}",
        ].join("\n"),
      },
      {
        pattern: /#include <pthread.h>/g,
        replacement: '#include <pthread.h>\n#include "fuse-inode-backend.h"',
      },
      {
        pattern: /static const uint32_t op_rmdir = 33;/g,
        replacement:
          "static const uint32_t op_rmdir = 33;\nstatic const uint32_t op_fsetattr = 34;",
      },
      {
        pattern: /napi_ref handlers\[35\];/g,
        replacement: "napi_ref handlers[36];",
      },
      {
        pattern: /(FUSE_METHOD_VOID\(ftruncate,[\s\S]*?\n\}\)\n)/g,
        replacement: `$1\n${fileAttributesC.trim()}\n`,
      },
      {
        pattern: /for \(int i = 0; i < 35; i\+\+\)/g,
        replacement: "for (int i = 0; i < 36; i++)",
      },
      {
        pattern:
          /(\s+)struct fuse \*fuse = fuse_new\(ch, &args, &ops, sizeof\(struct fuse_operations\), ft\);/g,
        replacement:
          "$1sfs_set_fsetattr(implemented[op_fsetattr] ? fuse_native_fsetattr : NULL);$1struct fuse *fuse = fuse_new(ch, &args, &ops, sizeof(struct fuse_operations), ft);",
      },
      {
        pattern: /NAPI_EXPORT_FUNCTION\(fuse_native_signal_ftruncate\)/g,
        replacement:
          "NAPI_EXPORT_FUNCTION(fuse_native_signal_ftruncate)\n  NAPI_EXPORT_FUNCTION(fuse_native_signal_fsetattr)",
      },
      {
        pattern: /NAPI_EXPORT_UINT32\(op_ftruncate\)/g,
        replacement:
          "NAPI_EXPORT_UINT32(op_ftruncate)\n  NAPI_EXPORT_UINT32(op_fsetattr)",
      },
    ],
  },
  {
    file: "index.js",
    edits: [
      {
        pattern: /\(stat && stat\.nlink\) \|\| 1/g,
        replacement: "(stat && stat.nlink) ?? 1",
      },
      ...["open", "create"].flatMap((operation) => [
        {
          pattern: new RegExp(
            `(\\['${operation}', \\{\\s+op: binding\\.op_${operation},\\s+defaults: )\\[0\\]`,
            "g",
          ),
          replacement: "$1[0, 0]",
        },
        {
          pattern: new RegExp(
            `(_op_${operation} \\(signal, path, (?:flags|mode)\\) \\{\\s+this\\.ops\\.${operation}\\(path, (?:flags|mode), )\\(err, fd\\) => \\{\\s+return signal\\(err, fd\\)`,
            "g",
          ),
          replacement:
            "$1(err, fd, directIO = false) => {\n      return signal(err, fd ?? 0, directIO ? 1 : 0)",
        },
      ]),
      {
        pattern: /_op_create \(signal, path, mode\)/g,
        replacement: "_op_create (signal, path, mode, flags)",
      },
      {
        pattern: /this\.ops\.create\(path, mode, /g,
        replacement: "this.ops.create(path, mode, flags, ",
      },
      {
        pattern: /function getStatfsArray \(statfs\) \{[\s\S]*?\n\}/g,
        replacement: [
          "function getStatfsArray (statfs) {",
          `  const ints = new Uint32Array(${String(statfsFields.length * 2)})`,
          ...statfsFields.map(
            (field, index) =>
              `  setDoubleInt(ints, ${String(index * 2)}, (statfs && statfs.${field}) || 0)`,
          ),
          "  return ints",
          "}",
        ].join("\n"),
      },
      {
        pattern:
          /(_op_fgetattr \(signal, path, fd\) \{[\s\S]*?)this\.ops\.getattr\(path,/g,
        replacement: "$1this.ops.fgetattr(path, fd,",
      },
      {
        pattern:
          /(\['fgetattr', \{\s+op: binding\.op_fgetattr,\s+defaults: \[getStatArray\(\)\]\s+\}\],)/g,
        replacement: "$1\n  ['fsetattr', {\n    op: binding.op_fsetattr\n  }],",
      },
      {
        pattern: /new Uint32Array\(35\)/g,
        replacement: "new Uint32Array(36)",
      },
      ...["atime", "mtime"].map((field) => ({
        pattern: new RegExp(`getDoubleArg\\(${field}Low, ${field}High\\)`, "g"),
        replacement: `(${field}High | 0) * 4294967296 + ${field}Low`,
      })),
      {
        pattern:
          /(\n {2}_op_fgetattr \(signal, path, fd\) \{[\s\S]*?\n {2}\})/g,
        replacement: `$1\n\n${fileAttributesJs.trimEnd()}`,
      },
    ],
  },
];
const changes = await Promise.all(
  patches.map(async ({ file, edits }) => {
    const target = path.join(root, file);
    let contents = await readFile(target, "utf8");
    for (const { pattern, replacement } of edits) {
      if ([...contents.matchAll(pattern)].length !== 1) {
        throw new Error(
          `Expected exactly one native compatibility patch location in ${file}`,
        );
      }
      contents = contents.replace(pattern, replacement);
    }
    return { target, contents };
  }),
);
await copyFile(
  new URL("./fuse-inode-backend.h", import.meta.url),
  path.join(root, "fuse-inode-backend.h"),
);
for (const { target, contents } of changes) await writeFile(target, contents);
