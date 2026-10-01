export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** A Postgres database: Neon or any other server through node-postgres, or PGlite in process. */
export interface Db extends Queryable {
  /** Runs several statements separated by semicolons, without parameters. */
  exec(sql: string): Promise<void>;
  /** Runs `fn` on one connection between BEGIN and COMMIT, and rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>, opts?: { readOnly?: boolean }): Promise<T>;
  close(): Promise<void>;
}

const READ_ONLY = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

/** Connects through node-postgres. Use the pooled connection string on Neon. */
export async function openPostgres(url: string, opts: { max?: number } = {}): Promise<Db & { pool: import("pg").Pool }> {
  const { default: pg } = await import("pg");
  // Short idle timeout: a serverless instance should not hold connections it no longer uses.
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5, idleTimeoutMillis: 5_000 });
  return {
    pool,
    query: async (sql, params) => {
      const result = await pool.query(sql, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn, txOpts) => {
      const client = await pool.connect();
      try {
        await client.query(txOpts?.readOnly ? READ_ONLY : "BEGIN");
        const result = await fn({
          query: async (sql, params) => {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Postgres compiled to WebAssembly, in memory or in a directory. It has a single connection,
 * so every statement and transaction takes a turn here: a statement from elsewhere must never
 * land inside another caller's open transaction.
 */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create(dataDir);
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const run = async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const r = await db.query<T>(sql, params as unknown[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
  };

  return {
    query: (sql, params) => exclusive(() => run(sql, params)),
    exec: (sql) => exclusive(async () => void (await db.exec(sql))),
    transaction: (fn, txOpts) =>
      exclusive(async () => {
        await db.query(txOpts?.readOnly ? READ_ONLY : "BEGIN");
        try {
          const result = await fn({ query: run });
          await db.query("COMMIT");
          return result;
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      }),
    close: () => exclusive(() => db.close()),
  };
}
