import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCommand } from "../src/runtime/command-runner.js";

let root: string;
const script = path.resolve("container/patch-fuse-binding.mjs");
const javascript = `const OpcodesAndDefaults = new Map([
  ['open', {
    op: binding.op_open,
    defaults: [0]
  }],
  ['create', {
    op: binding.op_create,
    defaults: [0]
  }],
  ['fgetattr', {
    op: binding.op_fgetattr,
    defaults: [getStatArray()]
  }],
])
class Fuse {
  _getImplementedArray () {
    return new Uint32Array(35)
  }
  _op_getattr(signal,path) { this.ops.getattr(path, callback); }
  _op_fgetattr (signal, path, fd) {
    this.ops.getattr(path, (err, stat) => signal(err,stat));
  }
  _op_open (signal, path, flags) {
    this.ops.open(path, flags, (err, fd) => {
      return signal(err, fd)
    })
  }
  _op_create (signal, path, mode) {
    this.ops.create(path, mode, (err, fd) => {
      return signal(err, fd)
    })
  }
  _op_utimens (signal, path, atimeLow, atimeHigh, mtimeLow, mtimeHigh) {
    const atime = getDoubleArg(atimeLow, atimeHigh)
    const mtime = getDoubleArg(mtimeLow, mtimeHigh)
    this.ops.utimens(path, atime, mtime, err => {
      return signal(err)
    })
  }
}
function getStatfsArray (statfs) {
  return new Uint32Array(11)
}
function setDoubleInt (arr, idx, num) {
  arr[idx] = num % 4294967296
  arr[idx + 1] = (num - arr[idx]) / 4294967296
}
function getStatArray (stat) {
  const ints = new Uint32Array(18)
  ints[6] = (stat && stat.nlink) || 1
  return ints
}`;
const native = `#include <pthread.h>
static const uint32_t op_rmdir = 33;
typedef struct {
  napi_ref handlers[35];
} fuse_thread_t;
static void populate_statvfs (uint32_t *ints, struct statvfs* statvfs) {
  statvfs->f_blocks = *ints++;
}
static void uint32s_to_timespec (struct timespec* ts, uint32_t** ints) {
  uint64_t ms = uint32s_to_uint64(ints);
  ts->tv_sec = ms / 1000;
  ts->tv_nsec = (ms % 1000) * 1000000;
}
FUSE_METHOD(open, 2, 1, (const char *path, struct fuse_file_info *info), {}, {}, {
  NAPI_ARGV_INT32(fd, 2)
})
FUSE_METHOD(create, 2, 1, (const char *path, mode_t mode, struct fuse_file_info *info), {}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_uint32(env, l->mode, &(argv[3]));
}, {
  NAPI_ARGV_INT32(fd, 2)
})
FUSE_METHOD_VOID(ftruncate, 4, 0, (const char *path, off_t size, struct fuse_file_info *info), {
  l->path = path;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
})
void mount(void) {
  for (int i = 0; i < 35; i++) {}
  struct fuse *fuse = fuse_new(ch, &args, &ops, sizeof(struct fuse_operations), ft);
}
NAPI_EXPORT_FUNCTION(fuse_native_signal_ftruncate)
NAPI_EXPORT_UINT32(op_ftruncate)
FUSE_UINT64_TO_INTS_ARGV(l->atime, 3)
FUSE_UINT64_TO_INTS_ARGV(l->atime, 5)
`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "scriptfs-native-patch-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@cocalc/fuse-native", version: "2.4.3" }),
  );
  await writeFile(path.join(root, "index.js"), javascript);
  await writeFile(path.join(root, "fuse-native.c"), native);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("patches descriptor metadata dispatch and the distinct modification timestamp", async () => {
  await runCommand(process.execPath, [script, root]);
  const patched = await readFile(path.join(root, "index.js"), "utf8");
  expect(patched).toContain("this.ops.fgetattr(path, fd,");
  expect(patched).toContain("binding.op_fsetattr");
  expect(patched).toContain("new Uint32Array(36)");
  expect(patched).toContain("_op_fsetattr");
  expect(patched).toContain(
    "_op_getattr(signal,path) { this.ops.getattr(path, callback); }",
  );
  const nativePatched = await readFile(
    path.join(root, "fuse-native.c"),
    "utf8",
  );
  expect(nativePatched).toContain('#include "fuse-inode-backend.h"');
  expect(nativePatched).toContain("static const uint32_t op_fsetattr = 34;");
  expect(nativePatched).toContain("napi_ref handlers[36];");
  expect(nativePatched).toContain("FUSE_METHOD_VOID(fsetattr");
  expect(nativePatched).toContain(
    "sfs_set_fsetattr(implemented[op_fsetattr] ? fuse_native_fsetattr : NULL);",
  );
  expect(nativePatched).toContain(
    "NAPI_EXPORT_FUNCTION(fuse_native_signal_fsetattr)",
  );
  expect(nativePatched).toContain("NAPI_EXPORT_UINT32(op_fsetattr)");
  expect(nativePatched).toContain("FUSE_UINT64_TO_INTS_ARGV(l->mtime, 5)");
});

it("rejects unsupported versions before patching", async () => {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@cocalc/fuse-native", version: "different" }),
  );
  await expect(runCommand(process.execPath, [script, root])).rejects.toThrow(
    "Review native compatibility patches",
  );
  expect(await readFile(path.join(root, "index.js"), "utf8")).toBe(javascript);
});

it("preserves zero links for unlinked open files", async () => {
  await runCommand(process.execPath, [script, root]);
  const patched = await readFile(path.join(root, "index.js"), "utf8");
  const functions = patched.slice(patched.indexOf("function getStatfsArray"));
  const links = runInNewContext(
    `${functions}; [getStatArray({nlink:0})[6], getStatArray({nlink:2})[6], getStatArray()[6]]`,
  ) as number[];
  expect(links).toEqual([0, 2, 1]);
});

it("decodes signed pathname and descriptor timestamps without changing unsigned counters", async () => {
  await runCommand(process.execPath, [script, root]);
  const patched = await readFile(path.join(root, "index.js"), "utf8");
  const constructor = patched.slice(
    patched.indexOf("class Fuse"),
    patched.indexOf("function getStatfsArray"),
  );
  const functions = patched.slice(patched.indexOf("function getStatfsArray"));
  const times = [-4294967297, -200750, -1, 0, 1, 4294967297];
  const decoded = runInNewContext(
    `${constructor}
    ${functions}
    const calls = [];
    const fuse = new Fuse();
    fuse.ops = {
      utimens(path, atime, mtime, cb) { calls.push([atime, mtime]); cb(0); },
      fsetattr(path, fd, changes, detached, cb) {
        calls.push([changes.atime.getTime(), changes.mtime.getTime()]);
        cb(0);
      },
    };
    for (const time of ${JSON.stringify(times)}) {
      const ints = new Uint32Array(4);
      setDoubleInt(ints, 0, time);
      setDoubleInt(ints, 2, -time);
      fuse._op_utimens(() => {}, "/data", ...ints);
      fuse._op_fsetattr(() => {}, "/data", 1, 48, 0, 0, 0, ...ints, false);
    }
    calls;`,
  ) as number[][];
  expect(decoded).toEqual(
    times.flatMap((time) => [
      [time, -time || 0],
      [time, -time || 0],
    ]),
  );
  const nativePatched = await readFile(
    path.join(root, "fuse-native.c"),
    "utf8",
  );
  expect(nativePatched).toContain(
    "int64_t ms = (int64_t) uint32s_to_uint64(ints);",
  );
  expect(nativePatched).toContain("if (remainder < 0)");
  expect(nativePatched).toContain("remainder += 1000;");
  expect(nativePatched).toContain(
    "statvfs->f_blocks = uint32s_to_uint64(&ints);",
  );
});

it("transports direct-I/O policy and full-width storage counters", async () => {
  await runCommand(process.execPath, [script, root]);
  const patched = await readFile(path.join(root, "index.js"), "utf8");
  expect(patched.match(/defaults: \[0, 0\]/g)).toHaveLength(2);
  expect(
    patched.match(/signal\(err, fd \?\? 0, directIO \? 1 : 0\)/g),
  ).toHaveLength(2);
  const functions = patched.slice(patched.indexOf("function getStatfsArray"));
  const counters = runInNewContext(
    `${functions}; getStatfsArray({blocks: 4294967303, bavail: 8589934597})`,
  ) as Uint32Array;
  expect([...counters.slice(4, 6)]).toEqual([7, 1]);
  expect([...counters.slice(8, 10)]).toEqual([5, 2]);
  const nativePatched = await readFile(
    path.join(root, "fuse-native.c"),
    "utf8",
  );
  expect(
    nativePatched.match(/l->info->direct_io = direct_io != 0/g),
  ).toHaveLength(2);
  expect(nativePatched).toContain(
    "statvfs->f_blocks = uint32s_to_uint64(&ints);",
  );
  const constructor = patched.slice(
    patched.indexOf("class Fuse"),
    patched.indexOf("function getStatfsArray"),
  );
  const signals = runInNewContext(`${constructor};
    const signals = [];
    const fuse = new Fuse();
    fuse.ops = {
      open(path, flags, cb) { cb(-2); },
      create(path, mode, flags, cb) { cb(-13); },
    };
    fuse._op_open((...args) => signals.push(args), "/missing", 0);
    fuse._op_create((...args) => signals.push(args), "/denied", 420, 65);
    signals;
  `) as number[][];
  expect(signals).toEqual([
    [-2, 0, 0],
    [-13, 0, 0],
  ]);
});

it("transports caller create flags across both sides of the native bridge", async () => {
  await runCommand(process.execPath, [script, root]);
  const nativePatched = await readFile(
    path.join(root, "fuse-native.c"),
    "utf8",
  );
  expect(nativePatched).toContain("FUSE_METHOD(create, 3, 2,");
  expect(nativePatched).toContain(
    "napi_create_int32(env, l->info->flags, &(argv[4]));",
  );
  const patched = await readFile(path.join(root, "index.js"), "utf8");
  const constructor = patched.slice(
    patched.indexOf("class Fuse"),
    patched.indexOf("function getStatfsArray"),
  );
  const calls = runInNewContext(`${constructor};
    const calls = [];
    const fuse = new Fuse();
    fuse.ops = {
      create(path, mode, flags, cb) {
        calls.push([path, mode, flags]);
        cb(0, 7, true);
      },
    };
    for (const flags of [64, 65, 66, 1089, 1052737]) {
      fuse._op_create((...args) => calls.push(args), "/created", 420, flags);
    }
    calls;
  `) as (string | number)[][];
  expect(calls).toEqual(
    [64, 65, 66, 1089, 1052737].flatMap((flags) => [
      ["/created", 420, flags],
      [0, 7, 1],
    ]),
  );
});

it("rejects source drift without partially patching other files", async () => {
  await writeFile(path.join(root, "index.js"), "unexpected source");
  await expect(runCommand(process.execPath, [script, root])).rejects.toThrow(
    "Expected exactly one native compatibility patch location",
  );
  expect(await readFile(path.join(root, "fuse-native.c"), "utf8")).toBe(native);
});
