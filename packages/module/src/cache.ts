export interface TtlCacheOptions {
  /** Milliseconds a loaded value stays fresh. */
  ttl: number;
  /** Maximum number of entries; the least recently used are evicted first. */
  max?: number;
  /** Clock used for expiry, in milliseconds. */
  now?: () => number;
}

interface Entry<V> {
  value: Promise<V>;
  expires: number;
}

/**
 * Caches loader results for a limited time. Concurrent requests for the same
 * key share one load, and failed loads are not cached.
 */
export class TtlCache<K, V> {
  readonly #ttl: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #entries = new Map<K, Entry<V>>();

  constructor({ ttl, max = Infinity, now = Date.now }: TtlCacheOptions) {
    if (!(ttl >= 0)) throw new RangeError("TtlCache ttl must be >= 0");
    if (!(max >= 1)) throw new RangeError("TtlCache max must be >= 1");
    this.#ttl = ttl;
    this.#max = max;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Returns the cached value for `key`, loading it when missing or stale. */
  get(key: K, load: (key: K) => V | Promise<V>): Promise<V> {
    const entry = this.#entries.get(key);
    if (entry && entry.expires > this.#now()) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      return entry.value;
    }
    const value = Promise.resolve().then(() => load(key));
    const loading = { value, expires: Infinity };
    this.#store(key, loading);
    value.then(
      () => {
        if (this.#entries.get(key) === loading)
          loading.expires = this.#now() + this.#ttl;
      },
      () => {
        if (this.#entries.get(key) === loading) this.#entries.delete(key);
      },
    );
    return value;
  }

  set(key: K, value: V): void {
    this.#store(key, {
      value: Promise.resolve(value),
      expires: this.#now() + this.#ttl,
    });
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  #store(key: K, entry: Entry<V>): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}
