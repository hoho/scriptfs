import type { NodeMetadata } from "./types.js";

/** POSIX error codes ScriptFS forwards to the file system client. */
export type FsErrorCode =
  | "ENOENT"
  | "ENOTDIR"
  | "EISDIR"
  | "EACCES"
  | "EPERM"
  | "EEXIST"
  | "EINVAL"
  | "EBADF"
  | "EXDEV"
  | "ENOTEMPTY"
  | "ESTALE"
  | "EBUSY"
  | "ESPIPE"
  | "ENOSPC"
  | "EFBIG"
  | "ELOOP"
  | "EMFILE"
  | "EDQUOT"
  | "ENFILE"
  | "ENOMEM"
  | "EINTR"
  | "EAGAIN"
  | "ENAMETOOLONG"
  | "ERANGE"
  | "ETIMEDOUT"
  | "EOPNOTSUPP"
  | "EROFS"
  | "EIO";

export interface FsError extends Error {
  code: FsErrorCode;
}

/** Creates an error that ScriptFS reports to the client as `code`. */
export function fsError(
  code: FsErrorCode,
  message: string = code,
  options?: ErrorOptions,
): FsError {
  return Object.assign(new Error(message, options), { code });
}

/** Maps an HTTP status to the closest file system error code. */
export function httpErrorCode(status: number): FsErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "EINVAL";
    case 401:
    case 403:
      return "EACCES";
    case 404:
    case 410:
      return "ENOENT";
    case 405:
    case 501:
      return "EOPNOTSUPP";
    case 408:
    case 504:
      return "ETIMEDOUT";
    case 409:
    case 412:
      return "EEXIST";
    case 413:
      return "EFBIG";
    case 429:
    case 503:
      return "EAGAIN";
    case 507:
      return "ENOSPC";
    default:
      return "EIO";
  }
}

/** A non-success HTTP response. `code` makes it a valid file system error. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly url: string | undefined;
  readonly body: string;
  readonly code: FsErrorCode;

  constructor(
    status: number,
    message?: string,
    options: { url?: string; body?: string; cause?: unknown } = {},
  ) {
    super(
      message ??
        `HTTP ${String(status)}${options.url ? ` from ${options.url}` : ""}`,
      { cause: options.cause },
    );
    this.status = status;
    this.url = options.url;
    this.body = options.body ?? "";
    this.code = httpErrorCode(status);
  }
}

export function fileMetadata(
  overrides: Omit<Partial<NodeMetadata>, "kind"> = {},
): NodeMetadata {
  return { kind: "file", mode: 0o644, ...overrides };
}

export function directoryMetadata(
  overrides: Omit<Partial<NodeMetadata>, "kind"> = {},
): NodeMetadata {
  return { kind: "directory", mode: 0o755, ...overrides };
}

export function symlinkMetadata(
  target: string,
  overrides: Omit<Partial<NodeMetadata>, "kind" | "target"> = {},
): NodeMetadata {
  return {
    kind: "symlink",
    mode: 0o777,
    size: Buffer.byteLength(target),
    ...overrides,
    target,
  };
}
