import type { SqlDriver, SqlValue } from "../../src/storage/sqlite.ts";

declare const Bun: unknown;

/**
 * Minimal synchronous database shape shared by `bun:sqlite`'s `Database` and
 * `node:sqlite`'s `DatabaseSync`.
 */
type RawDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): { changes: number | bigint };
    all(...params: SqlValue[]): unknown[];
  };
  close(): void;
};

/**
 * In-memory {@link SqlDriver} for tests: `bun:sqlite` under `bun test`,
 * `node:sqlite` (`DatabaseSync`) elsewhere, same async surface under both.
 *
 * `transaction` serializes callbacks on a promise-chain mutex and wraps each
 * in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. Statements issued outside a
 * transaction run in autocommit and, per same-connection SQLite semantics,
 * join an already-open transaction — the {@link SqlDriver} contract requires
 * only that *transactions* never interleave.
 */
export class SqliteTestDriver implements SqlDriver {
  readonly #db: RawDb;
  #txTail: Promise<void> = Promise.resolve();
  #injected: { pattern: RegExp | null; error: Error; skip: number } | undefined;

  private constructor(db: RawDb) {
    this.#db = db;
  }

  static async open(): Promise<SqliteTestDriver> {
    if (typeof Bun !== "undefined") {
      const specifier = "bun:sqlite";
      const mod = (await import(specifier)) as {
        Database: new (path: string) => RawDb;
      };
      return new SqliteTestDriver(new mod.Database(":memory:"));
    }
    const { DatabaseSync } = await import("node:sqlite");
    return new SqliteTestDriver(new DatabaseSync(":memory:"));
  }

  /**
   * Inject a one-shot failure: the next statement whose SQL matches `pattern`
   * (every statement when omitted) throws `error`. `skip` first lets that many
   * matching statements pass — e.g. `failOn(/^INSERT INTO events/, {skip: 1})`
   * fails a batch's second event insert.
   */
  failOn(pattern?: RegExp, opts?: { error?: Error; skip?: number }): void {
    this.#injected = {
      pattern: pattern ?? null,
      error: opts?.error ?? new Error("injected sqlite failure"),
      skip: opts?.skip ?? 0,
    };
  }

  #guard(sql: string): void {
    const injected = this.#injected;
    if (!injected) return;
    if (injected.pattern && !injected.pattern.test(sql)) return;
    if (injected.skip > 0) {
      injected.skip -= 1;
      return;
    }
    this.#injected = undefined;
    throw injected.error;
  }

  async exec(sql: string): Promise<void> {
    this.#guard(sql);
    this.#db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    this.#guard(sql);
    const result = this.#db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  async all<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
    this.#guard(sql);
    return this.#db.prepare(sql).all(...params) as Row[];
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const task = this.#txTail.then(async (): Promise<T> => {
      this.#db.exec("BEGIN IMMEDIATE");
      const tx: SqlDriver = {
        exec: (sql) => this.exec(sql),
        run: (sql, params) => this.run(sql, params),
        all: (sql, params) => this.all(sql, params),
        transaction: (inner) => inner(tx),
      };
      try {
        const value = await fn(tx);
        this.#db.exec("COMMIT");
        return value;
      } catch (err) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // The engine already rolled back (e.g. a fatal error); surface the
          // original failure.
        }
        throw err;
      }
    });
    this.#txTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Statement count and rows remain readable in tests. */
  raw(): RawDb {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }
}
