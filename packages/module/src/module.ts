import path from "node:path";
import { format } from "node:util";
import { fsError } from "./errors.js";
import {
  InboundPort,
  OutboundPort,
  type OutboundPortOptions,
} from "./ports.js";
import { StateStore } from "./state.js";
import type { ModuleRuntime } from "./types.js";

/**
 * Base class for ScriptFS modules. ScriptFS constructs the manifest export
 * with the module runtime, awaits `start()`, and calls `stop()` on shutdown.
 * Subclasses add the provider callbacks they support.
 */
export class ScriptFsModule<Settings extends object = Record<string, unknown>> {
  readonly runtime: ModuleRuntime<Settings>;
  readonly #disposers: (() => unknown)[] = [];
  readonly #outbound = new Map<string, OutboundPort>();
  readonly #inbound = new Map<string, InboundPort>();
  readonly #stores = new Map<string, StateStore<unknown>>();

  constructor(runtime: ModuleRuntime<Settings>) {
    if ((runtime.version as number) !== 1)
      throw new Error(
        `Unsupported ScriptFS module runtime version ${String(runtime.version)}`,
      );
    this.runtime = runtime;
  }

  /** Instance name from the configuration. */
  get name(): string {
    return this.runtime.name;
  }

  get settings(): Readonly<Settings> {
    return this.runtime.settings;
  }

  /** Aborted when ScriptFS shuts down. */
  get signal(): AbortSignal {
    return this.runtime.signal;
  }

  /** Called once after construction. Override to prepare resources. */
  async start(): Promise<void> {}

  /**
   * Called once on shutdown. Runs `onStop` callbacks in reverse order and
   * closes inbound servers. Overrides must call `super.stop()`.
   */
  async stop(): Promise<void> {
    const failures: unknown[] = [];
    for (const dispose of this.#disposers.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        `Module "${this.name}" failed to stop`,
      );
  }

  /** Registers cleanup that runs when the module stops. */
  onStop(dispose: () => unknown): void {
    this.#disposers.push(dispose);
  }

  /** A required secret, or one the configuration supplied. */
  secret(key: string): string {
    const value = this.runtime.secrets[key];
    if (value === undefined)
      throw new Error(`Module "${this.name}" has no secret "${key}"`);
    return value;
  }

  optionalSecret(key: string): string | undefined {
    return this.runtime.secrets[key];
  }

  outbound(
    key: string,
    options: Omit<OutboundPortOptions, "signal"> = {},
  ): OutboundPort {
    let port = this.#outbound.get(key);
    if (!port) {
      const binding = this.runtime.ports[key];
      if (binding?.direction !== "outbound")
        throw new Error(`Module "${this.name}" has no outbound port "${key}"`);
      port = new OutboundPort(key, binding, {
        ...options,
        signal: this.signal,
      });
      this.#outbound.set(key, port);
    }
    return port;
  }

  inbound(key: string): InboundPort {
    let port = this.#inbound.get(key);
    if (!port) {
      const binding = this.runtime.ports[key];
      if (binding?.direction !== "inbound")
        throw new Error(`Module "${this.name}" has no inbound port "${key}"`);
      port = new InboundPort(key, binding, {
        track: (close) => this.onStop(close),
      });
      this.#inbound.set(key, port);
    }
    return port;
  }

  /** Whether the configuration bound the path `key`. */
  hasPath(key: string): boolean {
    return this.runtime.paths[key] !== undefined;
  }

  /**
   * Container location of the bound path `key`, joined with `segments`.
   * Segments that would escape the bound path fail with `EACCES`.
   */
  path(key: string, ...segments: string[]): string {
    const root = this.runtime.paths[key];
    if (root === undefined)
      throw new Error(`Module "${this.name}" has no bound path "${key}"`);
    return within(root, segments);
  }

  /** Location inside the persistent state directory. */
  statePath(...segments: string[]): string {
    const root = this.runtime.stateDir;
    if (root === undefined)
      throw new Error(
        `Module "${this.name}" has no state directory; set "state": true in its manifest`,
      );
    return within(root, segments);
  }

  /** A JSON document in the state directory, shared per file name. */
  state<T>(initial: T | (() => T), file = "state.json"): StateStore<T> {
    const location = this.statePath(file);
    let store = this.#stores.get(location);
    if (!store) {
      store = new StateStore<unknown>(location, initial);
      this.#stores.set(location, store);
    }
    return store as StateStore<T>;
  }

  /** Writes a line prefixed with the instance name to the ScriptFS log. */
  log(...values: unknown[]): void {
    console.log(`[${this.name}] ${format(...values)}`);
  }
}

function within(root: string, segments: readonly string[]): string {
  const paths =
    path.win32.isAbsolute(root) && !path.posix.isAbsolute(root)
      ? path.win32
      : path.posix;
  const resolved = paths.resolve(root, ...segments);
  const relative = paths.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  )
    throw fsError("EACCES", `${segments.join("/")} escapes ${root}`);
  return resolved;
}
