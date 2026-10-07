import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A JSON document persisted atomically. Updates are serialized, so
 * concurrent callers never lose each other's changes.
 */
export class StateStore<T> {
  readonly file: string;
  readonly #initial: () => T;
  #value: Promise<T> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, initial: T | (() => T)) {
    this.file = file;
    this.#initial =
      typeof initial === "function"
        ? (initial as () => T)
        : () => structuredClone(initial);
  }

  /** Current value. Treat it as read-only; change it through `update`. */
  read(): Promise<T> {
    this.#value ??= this.#load();
    return this.#value;
  }

  /**
   * Applies `change` to a copy of the current value and persists the result.
   * `change` may mutate its argument or return a replacement.
   */
  update(
    // Mutating callbacks return nothing, replacing ones return the new value.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    change: (value: T) => T | void | Promise<T | void>,
  ): Promise<T> {
    const next = this.#queue.then(async () => {
      const draft = structuredClone(await this.read());
      const replaced = await change(draft);
      const value = replaced === undefined ? draft : (replaced as T);
      await this.#persist(value);
      this.#value = Promise.resolve(value);
      return value;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  write(value: T): Promise<T> {
    return this.update(() => value);
  }

  async #load(): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.#initial();
      throw error;
    }
    return JSON.parse(text) as T;
  }

  async #persist(value: T): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        flush: true,
      });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
