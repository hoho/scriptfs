import { Buffer } from "node:buffer";

const fileCount = 128;
const smallSize = 4096;
const largeSize = 2 * 1024 * 1024;

/** @param {number} size */
function contents(size) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buffer[i] = i % 251;
  return buffer;
}

/** @param {boolean} positional */
function module(positional) {
  const small = contents(smallSize);
  const large = contents(largeSize);
  let mutable = Buffer.alloc(0);
  /** @param {string} name */
  function data(name) {
    if (name === "large.bin") return large;
    if (name === "mutable.bin") return mutable;
    if (/^file-\d{4}\.bin$/.test(name)) {
      const index = Number(name.slice(5, 9));
      if (index < fileCount) return small;
    }
    throw Object.assign(new Error(`Missing benchmark file: ${name}`), {
      code: "ENOENT",
    });
  }
  /** @param {{ relativePath: string }} context */
  function metadata({ relativePath }) {
    return relativePath
      ? { kind: "file", mode: 0o644, size: data(relativePath).length }
      : { kind: "directory", mode: 0o755 };
  }
  const base = {
    getattr: metadata,
    fgetattr: metadata,
    /** @param {{ relativePath: string }} context */
    readdir({ relativePath }) {
      if (relativePath) return undefined;
      return [
        ...Array.from({ length: fileCount }, (_, index) => ({
          name: `file-${String(index).padStart(4, "0")}.bin`,
          metadata: { kind: "file", mode: 0o644, size: smallSize },
        })),
        {
          name: "large.bin",
          metadata: { kind: "file", mode: 0o644, size: largeSize },
        },
        {
          name: "mutable.bin",
          metadata: { kind: "file", mode: 0o644, size: mutable.length },
        },
      ];
    },
    /** @param {{ relativePath: string }} context */
    open({ relativePath }) {
      return { relativePath };
    },
    release() {},
    /** @param {number} size */
    truncate(size) {
      const next = Buffer.alloc(size);
      mutable.copy(next, 0, 0, Math.min(size, mutable.length));
      mutable = next;
    },
    /** @param {Buffer} value */
    writeFile(value) {
      mutable = Buffer.from(value);
    },
  };
  if (!positional) {
    return {
      ...base,
      /** @param {{ relativePath: string }} context */
      readFile({ relativePath }) {
        return data(relativePath);
      },
    };
  }
  return {
    ...base,
    /** @param {number} size */
    ftruncate(size) {
      base.truncate(size);
    },
    /** @param {number} position @param {number} length @param {{ relativePath: string }} context */
    read(position, length, { relativePath }) {
      return data(relativePath).subarray(position, position + length);
    },
    /** @param {Buffer} value @param {number} position */
    write(value, position) {
      if (mutable.length < position + value.length) {
        const next = Buffer.alloc(position + value.length);
        mutable.copy(next);
        mutable = next;
      }
      value.copy(mutable, position);
      return value.length;
    },
  };
}

export const whole = module(false);
export const positional = module(true);
