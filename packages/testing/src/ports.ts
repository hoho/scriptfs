import { once } from "node:events";
import http from "node:http";
import net from "node:net";

/** A TCP port on `127.0.0.1` that was free when checked. */
export async function freePort(): Promise<number> {
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as net.AddressInfo;
  listener.close();
  await once(listener, "close");
  return port;
}

/** A request a {@link HostServer} received. */
export interface RecordedRequest {
  method: string;
  /** Path and query, such as `/todos?done=true`. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type HostHandler = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>;

export interface HostServer extends AsyncDisposable {
  readonly port: number;
  /** `127.0.0.1:<port>`, the value for an outbound port. */
  readonly target: string;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Every request received so far, in order. */
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Starts an HTTP server on the host's loopback interface for a module's
 * outbound port to reach, standing in for a local service. The handler gets a
 * Fetch API `Request` and returns a `Response`; returning nothing answers
 * `404`, and a thrown error answers `500`.
 */
export async function hostServer(handler: HostHandler): Promise<HostServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const method = incoming.method ?? "GET";
      const target = incoming.url ?? "/";
      requests.push({
        method,
        path: target,
        headers,
        body: body.toString("utf8"),
      });
      let response: Response;
      try {
        response =
          (await handler(
            new Request(new URL(target, "http://127.0.0.1"), {
              method,
              headers,
              ...(body.length && method !== "GET" && method !== "HEAD"
                ? { body }
                : {}),
            }),
          )) ?? new Response("Not found", { status: 404 });
      } catch (error) {
        response = new Response(String(error), { status: 500 });
      }
      outgoing.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      outgoing.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as net.AddressInfo;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    return closing;
  };
  return {
    port,
    target: `127.0.0.1:${String(port)}`,
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close,
    [Symbol.asyncDispose]: close,
  };
}

export interface WaitOptions {
  /** Milliseconds before giving up. Defaults to 10 seconds. */
  timeout?: number;
  /** Milliseconds between attempts. Defaults to 100. */
  interval?: number;
}

/**
 * Calls `check` until it returns a value other than `undefined`, `null`, or
 * `false` without throwing, and returns that value. Useful for changes a
 * module picks up after a cache expires.
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<Exclude<T, undefined | null | false>> {
  const deadline = Date.now() + (options.timeout ?? 10_000);
  let failure: unknown;
  for (;;) {
    try {
      const value: unknown = await check();
      if (value !== undefined && value !== null && value !== false)
        return value as Exclude<T, undefined | null | false>;
      failure = undefined;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for the condition", {
        cause: failure,
      });
    await new Promise((resolve) =>
      setTimeout(resolve, options.interval ?? 100),
    );
  }
}
