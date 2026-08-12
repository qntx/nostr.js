/**
 * Minimal request coalescer (DataLoader-style).
 * Batches keys within a microtask; no global state.
 */
export type BatchLoadFn<K, V> = (keys: readonly K[]) => Promise<readonly (V | Error)[]>;

export type DataLoaderOptions<K, C = K> = {
  cacheKeyFn?: (key: K) => C;
  maxBatchSize?: number;
  /** When false, only coalesces in-flight requests (no durable memoization). Default true. */
  cache?: boolean;
};

export class DataLoader<K, V, C = K> {
  readonly #batchLoadFn: BatchLoadFn<K, V>;
  readonly #cacheKeyFn: (key: K) => C;
  readonly #maxBatchSize: number;
  readonly #useCache: boolean;
  readonly #cache = new Map<C, Promise<V>>();
  readonly #inflight = new Map<C, Promise<V>>();
  #queue: Array<{
    key: K;
    resolve: (v: V) => void;
    reject: (e: unknown) => void;
  }> = [];
  #scheduled = false;

  constructor(batchLoadFn: BatchLoadFn<K, V>, options: DataLoaderOptions<K, C> = {}) {
    this.#batchLoadFn = batchLoadFn;
    this.#cacheKeyFn = options.cacheKeyFn ?? ((k: K) => k as unknown as C);
    this.#maxBatchSize = options.maxBatchSize ?? Infinity;
    this.#useCache = options.cache !== false;
  }

  load(key: K): Promise<V> {
    const cacheKey = this.#cacheKeyFn(key);
    if (this.#useCache) {
      const cached = this.#cache.get(cacheKey);
      if (cached) return cached;
    }
    const inflight = this.#inflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = new Promise<V>((resolve, reject) => {
      this.#queue.push({ key, resolve, reject });
      if (this.#queue.length >= this.#maxBatchSize) {
        this.#dispatch();
      } else if (!this.#scheduled) {
        this.#scheduled = true;
        queueMicrotask(() => this.#dispatch());
      }
    }).finally(() => {
      this.#inflight.delete(cacheKey);
    });

    this.#inflight.set(cacheKey, promise);
    if (this.#useCache) this.#cache.set(cacheKey, promise);
    return promise;
  }

  clear(key: K): void {
    this.#cache.delete(this.#cacheKeyFn(key));
    this.#inflight.delete(this.#cacheKeyFn(key));
  }

  clearAll(): void {
    this.#cache.clear();
    this.#inflight.clear();
  }

  #dispatch(): void {
    this.#scheduled = false;
    const batch = this.#queue.splice(0, this.#maxBatchSize);
    if (batch.length === 0) return;

    const keys = batch.map((b) => b.key);
    void this.#batchLoadFn(keys)
      .then((values) => {
        if (values.length !== keys.length) {
          const err = new Error(
            `DataLoader batch function must return array of length ${keys.length}, got ${values.length}`,
          );
          for (const item of batch) item.reject(err);
          return;
        }
        for (let i = 0; i < batch.length; i++) {
          const value = values[i]!;
          if (value instanceof Error) batch[i]!.reject(value);
          else batch[i]!.resolve(value);
        }
      })
      .catch((err) => {
        for (const item of batch) item.reject(err);
      });

    if (this.#queue.length > 0) {
      this.#scheduled = true;
      queueMicrotask(() => this.#dispatch());
    }
  }
}
