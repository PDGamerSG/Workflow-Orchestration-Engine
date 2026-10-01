import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, Queryable } from "./db";
import type { NormalizedGraph, Profile, RunStatus, Source, StepStatus, Usage } from "./types";

export type NewRun = {
  id: string;
  goal: string | null;
  profile: Profile | null;
  status: "planning" | "running";
  concurrency: number;
  maxReplans: number;
  budgetTokens: number | null;
  budgetUsd: number | null;
  now: number;
};

export type RunRow = {
  id: string;
  goal: string | null;
  profile: Profile | null;
  graph: NormalizedGraph | null;
  graphVersion: number;
  status: RunStatus;
  error: string | null;
  concurrency: number;
  maxReplans: number;
  replans: number;
  budgetTokens: number | null;
  budgetUsd: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type StepRow = {
  runId: string;
  stepId: string;
  graphVersion: number;
  status: StepStatus;
  attempt: number;
  resolvedPrompt: string | null;
  output: string | null;
  sources: Source[];
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  costUsd: number;
  cached: boolean;
  startedAt: number | null;
  finishedAt: number | null;
};

export type StepPatch = Partial<
  Pick<StepRow, "status" | "attempt" | "resolvedPrompt" | "output" | "sources" | "error" | "cached" | "startedAt" | "finishedAt">
>;

export type Totals = { inputTokens: number; outputTokens: number; searchCalls: number; costUsd: number };

export type RunSummary = Omit<RunRow, "graph"> & {
  stepCounts: Record<StepStatus, number>;
  totals: Totals;
};

export type EventRow = { id: number; runId: string; type: string; payload: unknown; createdAt: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  goal TEXT,
  profile TEXT,
  graph_json TEXT,
  graph_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  concurrency INTEGER NOT NULL,
  max_replans INTEGER NOT NULL,
  replans INTEGER NOT NULL DEFAULT 0,
  budget_tokens BIGINT,
  budget_usd DOUBLE PRECISION,
  planning_input_tokens BIGINT NOT NULL DEFAULT 0,
  planning_output_tokens BIGINT NOT NULL DEFAULT 0,
  planning_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status, lease_expires_at);

CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  graph_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  resolved_prompt TEXT,
  output TEXT,
  sources_json TEXT,
  error TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  search_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  cached BOOLEAN NOT NULL DEFAULT FALSE,
  started_at BIGINT,
  finished_at BIGINT,
  seq INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);

CREATE TABLE IF NOT EXISTS step_cache (
  key TEXT PRIMARY KEY,
  output TEXT NOT NULL,
  sources_json TEXT,
  created_at BIGINT NOT NULL
);
`;

// A write guarded by a fence only lands while `fence` holds the run's lease and the run is still active.
// A cancel from any process therefore blocks the owner's writes right away, before its next heartbeat.
const FENCE =
  "EXISTS (SELECT 1 FROM runs WHERE runs.id = ? AND runs.lease_owner = ? AND runs.status IN ('planning', 'running'))";

const STEP_COLUMNS: Record<keyof StepPatch, string> = {
  status: "status",
  attempt: "attempt",
  resolvedPrompt: "resolved_prompt",
  output: "output",
  sources: "sources_json",
  error: "error",
  cached: "cached",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

const ALL_STEP_STATUSES: StepStatus[] = ["pending", "running", "succeeded", "failed", "skipped", "superseded"];

/** Writes SQL with `?` placeholders, numbered here into Postgres's `$1, $2, ...`. */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export class Store {
  private readonly db: Db;
  /** The transaction the current async call chain is inside, if any. */
  private readonly current = new AsyncLocalStorage<Queryable>();

  private constructor(db: Db) {
    this.db = db;
  }

  /** Creates the tables if they are missing. */
  static async open(db: Db): Promise<Store> {
    await db.exec(SCHEMA);
    return new Store(db);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  private async q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return (this.current.getStore() ?? this.db).query<T>(numbered(sql), params);
  }

  /**
   * Runs `fn` in a transaction. `lockRun` takes the run's row lock first, so every write to one
   * run is serialized across processes and its events get ids in commit order. A call inside an
   * open transaction joins it.
   */
  async tx<T>(fn: () => Promise<T>, opts: { lockRun?: string; readOnly?: boolean } = {}): Promise<T> {
    if (this.current.getStore()) return fn();
    return this.db.transaction(
      (tx) =>
        this.current.run(tx, async () => {
          if (opts.lockRun) await this.q("SELECT 1 FROM runs WHERE id = ? FOR UPDATE", [opts.lockRun]);
          return fn();
        }),
      { readOnly: opts.readOnly },
    );
  }

  async createRun(r: NewRun): Promise<void> {
    await this.q(
      `INSERT INTO runs (id, goal, profile, status, concurrency, max_replans, budget_tokens, budget_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.goal, r.profile, r.status, r.concurrency, r.maxReplans, r.budgetTokens, r.budgetUsd, r.now, r.now],
    );
  }

  async getRun(id: string): Promise<RunRow | null> {
    const { rows } = await this.q("SELECT * FROM runs WHERE id = ?", [id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** Recent runs with step counts and totals, in two queries however many runs there are. */
  async listRuns(limit: number): Promise<RunSummary[]> {
    const { rows } = await this.q("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?", [limit]);
    const runs = rows.map(toRun);
    const { rows: groups } = await this.q<{ run_id: string; status: StepStatus; n: number; i: number; o: number; s: number; c: number }>(
      `SELECT run_id, status, COUNT(*)::int AS n, SUM(input_tokens)::float8 AS i, SUM(output_tokens)::float8 AS o,
              SUM(search_calls)::float8 AS s, SUM(cost_usd)::float8 AS c
       FROM steps WHERE run_id = ANY(?) GROUP BY run_id, status`,
      [runs.map((r) => r.id)],
    );

    return runs.map(({ graph: _graph, ...run }, i) => {
      const stepCounts = Object.fromEntries(ALL_STEP_STATUSES.map((s) => [s, 0])) as Record<StepStatus, number>;
      const steps = { i: 0, o: 0, s: 0, c: 0 };
      for (const g of groups) {
        if (g.run_id !== run.id) continue;
        stepCounts[g.status] = g.n;
        steps.i += g.i;
        steps.o += g.o;
        steps.s += g.s;
        steps.c += g.c;
      }
      return { ...run, stepCounts, totals: sumTotals(steps, planningOf(rows[i]!)) };
    });
  }

  setRunStatus(id: string, status: RunStatus, error: string | null, now: number, fence?: string): Promise<boolean> {
    return this.guarded("UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?", [status, error, now, id], id, fence);
  }

  incrementReplans(id: string, fence?: string): Promise<boolean> {
    return this.guarded("UPDATE runs SET replans = replans + 1 WHERE id = ?", [id], id, fence);
  }

  /**
   * Makes `graph` the run's current graph. Steps new to this version are inserted as pending,
   * ids in `supersede` are retired, and rows that already exist keep their state.
   */
  installGraph(runId: string, graph: NormalizedGraph, version: number, supersede: string[], now: number, fence?: string): Promise<boolean> {
    return this.tx(async () => {
      const updated = await this.guarded(
        "UPDATE runs SET graph_json = ?, graph_version = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(graph), version, now, runId],
        runId,
        fence,
      );
      if (!updated) return false;

      for (const id of supersede) {
        await this.q("UPDATE steps SET status = 'superseded' WHERE run_id = ? AND step_id = ?", [runId, id]);
      }
      const { rows } = await this.q<{ next: number }>("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM steps WHERE run_id = ?", [runId]);
      const next = rows[0]!.next;
      for (const [i, id] of graph.order.entries()) {
        await this.q(
          "INSERT INTO steps (run_id, step_id, graph_version, status, seq) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING",
          [runId, id, version, next + i],
        );
      }
      return true;
    });
  }

  async getSteps(runId: string): Promise<StepRow[]> {
    const { rows } = await this.q("SELECT * FROM steps WHERE run_id = ? ORDER BY seq", [runId]);
    return rows.map(toStep);
  }

  updateStep(runId: string, stepId: string, patch: StepPatch, fence?: string): Promise<boolean> {
    const entries = Object.entries(patch) as [keyof StepPatch, StepPatch[keyof StepPatch]][];
    if (entries.length === 0) return Promise.resolve(true);
    const sets = entries.map(([key]) => `${STEP_COLUMNS[key]} = ?`).join(", ");
    const values = entries.map(([key, value]) => (key === "sources" ? JSON.stringify(value) : value));
    return this.guarded(`UPDATE steps SET ${sets} WHERE run_id = ? AND step_id = ?`, [...values, runId, stepId], runId, fence);
  }

  addStepUsage(runId: string, stepId: string, usage: Usage, costUsd: number, fence?: string): Promise<boolean> {
    return this.guarded(
      `UPDATE steps SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         search_calls = search_calls + ?, cost_usd = cost_usd + ?
       WHERE run_id = ? AND step_id = ?`,
      [usage.inputTokens, usage.outputTokens, usage.searchCalls, costUsd, runId, stepId],
      runId,
      fence,
    );
  }

  addPlanningUsage(runId: string, usage: Usage, costUsd: number, fence?: string): Promise<boolean> {
    return this.guarded(
      `UPDATE runs SET planning_input_tokens = planning_input_tokens + ?,
         planning_output_tokens = planning_output_tokens + ?, planning_cost_usd = planning_cost_usd + ?
       WHERE id = ?`,
      [usage.inputTokens, usage.outputTokens, costUsd, runId],
      runId,
      fence,
    );
  }

  /**
   * Moves steps in any of `from` to `to`, clearing error and finish time. Returns the count moved.
   * `clearAttempts` restarts the retry count, which a manual retry of a failed run needs.
   */
  async resetSteps(runId: string, from: StepStatus[], to: StepStatus, fence?: string, clearAttempts = false): Promise<number> {
    const attempts = clearAttempts ? ", attempt = 0" : "";
    let sql = `UPDATE steps SET status = ?, error = NULL, finished_at = NULL${attempts} WHERE run_id = ? AND status = ANY(?)`;
    const params: unknown[] = [to, runId, from];
    if (fence) {
      sql += ` AND ${FENCE}`;
      params.push(runId, fence);
    }
    return (await this.q(sql, params)).rowCount;
  }

  /**
   * The run, its steps and totals, plus the id of the last event already reflected in them.
   * One read transaction keeps the rows and the cursor consistent, so a client that reads
   * events after `lastEventId` sees every later change exactly once.
   */
  snapshot(runId: string): Promise<{ run: RunRow; steps: StepRow[]; totals: Totals; lastEventId: number } | null> {
    return this.tx(
      async () => {
        const run = await this.getRun(runId);
        if (!run) return null;
        const { rows } = await this.q<{ last: string }>("SELECT COALESCE(MAX(id), 0) AS last FROM events WHERE run_id = ?", [runId]);
        return { run, steps: await this.getSteps(runId), totals: await this.totals(runId), lastEventId: Number(rows[0]!.last) };
      },
      { readOnly: true },
    );
  }

  async totals(runId: string): Promise<Totals> {
    const { rows } = await this.q<{ i: number; o: number; s: number; c: number }>(
      `SELECT COALESCE(SUM(input_tokens), 0)::float8 AS i, COALESCE(SUM(output_tokens), 0)::float8 AS o,
              COALESCE(SUM(search_calls), 0)::float8 AS s, COALESCE(SUM(cost_usd), 0)::float8 AS c
       FROM steps WHERE run_id = ?`,
      [runId],
    );
    const { rows: runRows } = await this.q("SELECT * FROM runs WHERE id = ?", [runId]);
    return sumTotals(rows[0]!, runRows[0] ? planningOf(runRows[0]) : { i: 0, o: 0, c: 0 });
  }

  async appendEvent(runId: string, type: string, payload: unknown, now: number): Promise<number> {
    const { rows } = await this.q<{ id: string }>(
      "INSERT INTO events (run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      [runId, type, JSON.stringify(payload), now],
    );
    return Number(rows[0]!.id);
  }

  async eventsAfter(runId: string, afterId: number, limit = 500): Promise<EventRow[]> {
    const { rows } = await this.q("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?", [runId, afterId, limit]);
    return rows.map((r) => ({
      id: Number(r.id),
      runId: r.run_id as string,
      type: r.type as string,
      payload: JSON.parse(r.payload_json as string),
      createdAt: Number(r.created_at),
    }));
  }

  async claimRun(runId: string, workerId: string, now: number, ttlMs: number): Promise<boolean> {
    const { rowCount } = await this.q(
      `UPDATE runs SET lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND status IN ('planning', 'running')
         AND (lease_owner IS NULL OR lease_expires_at < ?)`,
      [workerId, now + ttlMs, runId, now],
    );
    return rowCount === 1;
  }

  async heartbeat(runId: string, workerId: string, now: number, ttlMs: number): Promise<boolean> {
    const { rowCount } = await this.q("UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?", [now + ttlMs, runId, workerId]);
    return rowCount === 1;
  }

  async releaseRun(runId: string, workerId: string): Promise<void> {
    await this.q("UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?", [runId, workerId]);
  }

  async claimableRuns(now: number): Promise<string[]> {
    const { rows } = await this.q<{ id: string }>(
      `SELECT id FROM runs WHERE status IN ('planning', 'running')
         AND (lease_owner IS NULL OR lease_expires_at < ?)
       ORDER BY created_at`,
      [now],
    );
    return rows.map((r) => r.id);
  }

  /** Removes a run with its steps and events. Returns false when the run is already gone. */
  deleteRun(runId: string): Promise<boolean> {
    return this.tx(async () => {
      await this.q("DELETE FROM events WHERE run_id = ?", [runId]);
      await this.q("DELETE FROM steps WHERE run_id = ?", [runId]);
      return (await this.q("DELETE FROM runs WHERE id = ?", [runId])).rowCount > 0;
    });
  }

  async cacheGet(key: string): Promise<{ output: string; sources: Source[] } | null> {
    const { rows } = await this.q<{ output: string; sources_json: string | null }>(
      "SELECT output, sources_json FROM step_cache WHERE key = ?",
      [key],
    );
    const row = rows[0];
    return row ? { output: row.output, sources: row.sources_json ? JSON.parse(row.sources_json) : [] } : null;
  }

  async cachePut(key: string, output: string, sources: Source[], now: number): Promise<void> {
    await this.q(
      `INSERT INTO step_cache (key, output, sources_json, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET output = EXCLUDED.output, sources_json = EXCLUDED.sources_json, created_at = EXCLUDED.created_at`,
      [key, output, JSON.stringify(sources), now],
    );
  }

  private async guarded(sql: string, params: unknown[], runId: string, fence?: string): Promise<boolean> {
    if (fence) {
      sql += ` AND ${FENCE}`;
      params = [...params, runId, fence];
    }
    return (await this.q(sql, params)).rowCount > 0;
  }
}

function planningOf(r: Record<string, unknown>) {
  return { i: Number(r.planning_input_tokens), o: Number(r.planning_output_tokens), c: Number(r.planning_cost_usd) };
}

function sumTotals(steps: { i: number; o: number; s: number; c: number }, planning: { i: number; o: number; c: number }): Totals {
  return {
    inputTokens: steps.i + planning.i,
    outputTokens: steps.o + planning.o,
    searchCalls: steps.s,
    // Round away float noise from summing many small costs.
    costUsd: Math.round((steps.c + planning.c) * 1e8) / 1e8,
  };
}

/** Postgres returns BIGINT columns as strings. */
function num(value: unknown): number {
  return Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toRun(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as string,
    goal: r.goal as string | null,
    profile: r.profile as Profile | null,
    graph: r.graph_json ? (JSON.parse(r.graph_json as string) as NormalizedGraph) : null,
    graphVersion: r.graph_version as number,
    status: r.status as RunStatus,
    error: r.error as string | null,
    concurrency: r.concurrency as number,
    maxReplans: r.max_replans as number,
    replans: r.replans as number,
    budgetTokens: numOrNull(r.budget_tokens),
    budgetUsd: numOrNull(r.budget_usd),
    leaseOwner: r.lease_owner as string | null,
    leaseExpiresAt: numOrNull(r.lease_expires_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

function toStep(r: Record<string, unknown>): StepRow {
  return {
    runId: r.run_id as string,
    stepId: r.step_id as string,
    graphVersion: r.graph_version as number,
    status: r.status as StepStatus,
    attempt: r.attempt as number,
    resolvedPrompt: r.resolved_prompt as string | null,
    output: r.output as string | null,
    sources: r.sources_json ? (JSON.parse(r.sources_json as string) as Source[]) : [],
    error: r.error as string | null,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    searchCalls: num(r.search_calls),
    costUsd: num(r.cost_usd),
    cached: r.cached === true,
    startedAt: numOrNull(r.started_at),
    finishedAt: numOrNull(r.finished_at),
  };
}
