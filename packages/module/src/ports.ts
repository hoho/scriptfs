import http from "node:http";
import net from "node:net";
import { HttpError, fsError } from "./errors.js";
import type { InboundPortBinding, OutboundPortBinding } from "./types.js";

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** Appended to the URL; `null` and `undefined` values are skipped. */
  query?: Query;
  /** Raw request body. */
  body?: RequestInit["body"];
  /** Serialized as JSON with a JSON content type; replaces `body`. */
  json?: unknown;
  /** Milliseconds before the request fails with `ETIMEDOUT`. */
  timeout?: number;
}

export interface OutboundPortOptions {
  /** Aborts every request, usually the module shutdown signal. */
  signal?: AbortSignal;
  /** Default request timeout in milliseconds. */
  timeout?: number;
}

const DEFAULT_TIMEOUT = 30_000;

function networkError(error: unknown, url: string, timeout: number): Error {
  if (error instanceof HttpError) return error;
  const name = (error as { name?: unknown } | undefined)?.name;
  if (name === "TimeoutError")
    return fsError(
      "ETIMEDOUT",
      `Request to ${url} timed out after ${String(timeout)} ms`,
      {
        cause: error,
      },
    );
  if (name === "AbortError")
    return fsError("EINTR", `Request to ${url} was aborted`, { cause: error });
  const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause;
  const detail =
    typeof cause?.message === "string"
      ? cause.message
      : error instanceof Error
        ? error.message
        : String(error);
  return fsError("EIO", `Request to ${url} failed: ${detail}`, {
    cause: error,
  });
}

/**
 * A host service declared as an outbound port. ScriptFS tunnels the
 * container-local `host:port` to the configured host target.
 */
export class OutboundPort {
  readonly key: string;
  readonly host: string;
  readonly port: number;
  readonly #signal: AbortSignal | undefined;
  readonly #timeout: number;

  constructor(
    key: string,
    binding: OutboundPortBinding,
    options: OutboundPortOptions = {},
  ) {
    if ((binding.direction as string) !== "outbound")
      throw new TypeError(`Port "${key}" is not an outbound port`);
    this.key = key;
    this.host = binding.host;
    this.port = binding.port;
    this.#signal = options.signal;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /** `http://host:port` of the container-local tunnel listener. */
  get origin(): string {
    return `http://${this.host}:${String(this.port)}`;
  }

  /** Resolves `path` against the port origin and appends `query`. */
  url(path = "/", query: Query = {}): URL {
    const url = new URL(path, this.origin);
    for (const [name, value] of Object.entries(query))
      for (const item of Array.isArray(value) ? value : [value])
        if (item !== null && item !== undefined)
          url.searchParams.append(name, String(item));
    return url;
  }

  /**
   * Sends an HTTP request. Resolves with any response, including errors;
   * network failures and timeouts reject with file system error codes.
   */
  async fetch(path = "/", options: RequestOptions = {}): Promise<Response> {
    const { query, json, timeout = this.#timeout, signal, ...init } = options;
    const url = this.url(path, query);
    const headers = new Headers(init.headers);
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      if (!headers.has("content-type"))
        headers.set("content-type", "application/json");
    }
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    if (this.#signal) signals.push(this.#signal);
    try {
      return await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      throw networkError(error, url.href, timeout);
    }
  }

  /** Like `fetch`, but rejects with `HttpError` for non-2xx responses. */
  async request(path = "/", options: RequestOptions = {}): Promise<Response> {
    const response = await this.fetch(path, options);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HttpError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText} from ${response.url || this.url(path, options.query).href}${body ? `: ${body.slice(0, 200)}` : ""}`,
        { url: response.url, body },
      );
    }
    return response;
  }

  /** Requests JSON; resolves `undefined` for `204 No Content`. */
  async json<T = unknown>(
    path = "/",
    options: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    const response = await this.request(path, { ...options, headers });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      throw fsError("EIO", `Invalid JSON from ${response.url}`, {
        cause: error,
      });
    }
  }

  async text(path = "/", options: RequestOptions = {}): Promise<string> {
    return (await this.request(path, options)).text();
  }

  async bytes(path = "/", options: RequestOptions = {}): Promise<Buffer> {
    return Buffer.from(await (await this.request(path, options)).arrayBuffer());
  }

  /** Opens a raw TCP connection, for clients of non-HTTP protocols. */
  connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });
  }
}

export type RequestHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => unknown;

export interface InboundPortOptions {
  /** Called with the closer of every server the port starts listening. */
  track?: (close: () => Promise<void>) => void;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    if (server instanceof http.Server) server.closeAllConnections();
  });
}

/**
 * A container port published on the host loopback interface, so host tools
 * can reach a server the module runs.
 */
export class InboundPort {
  readonly key: string;
  readonly host: string;
  readonly port: number;
  readonly hostPort: number;
  readonly #track: InboundPortOptions["track"];

  constructor(
    key: string,
    binding: InboundPortBinding,
    options: InboundPortOptions = {},
  ) {
    if ((binding.direction as string) !== "inbound")
      throw new TypeError(`Port "${key}" is not an inbound port`);
    this.key = key;
    this.host = binding.host;
    this.port = binding.port;
    this.hostPort = binding.hostPort;
    this.#track = options.track;
  }

  /** URL host tools use to reach the port. */
  get publicUrl(): string {
    return `http://127.0.0.1:${String(this.hostPort)}`;
  }

  /**
   * Starts listening. A function becomes an HTTP server whose async failures
   * answer with the `HttpError` status, or 500. The server closes when the
   * module stops.
   */
  async listen<Server extends net.Server = http.Server>(
    handler: RequestHandler | Server,
  ): Promise<Server> {
    const server =
      typeof handler === "function"
        ? (http.createServer((request, response) => {
            void (async () => {
              try {
                await handler(request, response);
              } catch (error) {
                if (!(error instanceof HttpError)) console.error(error);
                if (response.headersSent) {
                  response.destroy();
                  return;
                }
                const status = error instanceof HttpError ? error.status : 500;
                sendJson(response, status, {
                  error:
                    error instanceof HttpError
                      ? error.message
                      : http.STATUS_CODES[status],
                });
              }
            })();
          }) as unknown as Server)
        : handler;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#track?.(() => closeServer(server));
    return server;
  }
}

/** Reads a request body, rejecting with `HttpError(413)` past `limit` bytes. */
export function readBody(
  request: http.IncomingMessage,
  { limit = 1024 * 1024 }: { limit?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", reject);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        // Drain the rest so the response can still be delivered.
        request.resume();
        reject(
          new HttpError(413, `Request body exceeds ${String(limit)} bytes`),
        );
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", reject);
  });
}

/** Reads a JSON request body, rejecting with `HttpError(400)` when invalid. */
export async function readJson<T = unknown>(
  request: http.IncomingMessage,
  options?: { limit?: number },
): Promise<T> {
  const body = await readBody(request, options);
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

export function sendJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
