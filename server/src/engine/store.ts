import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
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
  budget_tokens INTEGER,
  budget_usd REAL,
  planning_input_tokens INTEGER NOT NULL DEFAULT 0,
  planning_output_tokens INTEGER NOT NULL DEFAULT 0,
  planning_cost_usd REAL NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  search_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);

CREATE TABLE IF NOT EXISTS step_cache (
  key TEXT PRIMARY KEY,
  output TEXT NOT NULL,
  sources_json TEXT,
  created_at INTEGER NOT NULL
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

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.db.close();
  }

  /**
   * Prepared statements, finalized in close(). Bun's own db.query() cache can drop statements
   * without finalizing them, which leaves the database file open after close().
   */
  private readonly statements = new Map<string, Statement>();

  private q(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * Runs `fn` in an IMMEDIATE transaction so concurrent processes serialize writers.
   * A call inside an open transaction joins it.
   */
  tx<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    return this.db.transaction(fn).immediate();
  }

  createRun(r: NewRun): void {
    this
      .q(
        `INSERT INTO runs (id, goal, profile, status, concurrency, max_replans, budget_tokens, budget_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.goal, r.profile, r.status, r.concurrency, r.maxReplans, r.budgetTokens, r.budgetUsd, r.now, r.now);
  }

  getRun(id: string): RunRow | null {
    const row = this.q("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? toRun(row) : null;
  }

  listRuns(limit: number): RunSummary[] {
    const rows = this.q("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as Record<
      string,
      unknown
    >[];
    const counts = this.q("SELECT status, COUNT(*) AS n FROM steps WHERE run_id = ? GROUP BY status");

    return rows.map((row) => {
      const { graph: _graph, ...run } = toRun(row);
      const stepCounts = Object.fromEntries(ALL_STEP_STATUSES.map((s) => [s, 0])) as Record<StepStatus, number>;
      for (const c of counts.all(run.id) as { status: StepStatus; n: number }[]) stepCounts[c.status] = c.n;
      return { ...run, stepCounts, totals: this.totals(run.id) };
    });
  }

  setRunStatus(id: string, status: RunStatus, error: string | null, now: number, fence?: string): boolean {
    return this.guarded(
      "UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      [status, error, now, id],
      id,
      fence,
    );
  }

  incrementReplans(id: string, fence?: string): boolean {
    return this.guarded("UPDATE runs SET replans = replans + 1 WHERE id = ?", [id], id, fence);
  }

  /**
   * Makes `graph` the run's current graph. Steps new to this version are inserted as pending,
   * ids in `supersede` are retired, and rows that already exist keep their state.
   */
  installGraph(
    runId: string,
    graph: NormalizedGraph,
    version: number,
    supersede: string[],
    now: number,
    fence?: string,
  ): boolean {
    return this.tx(() => {
      const updated = this.guarded(
        "UPDATE runs SET graph_json = ?, graph_version = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(graph), version, now, runId],
        runId,
        fence,
      );
      if (!updated) return false;

      const retire = this.q("UPDATE steps SET status = 'superseded' WHERE run_id = ? AND step_id = ?");
      for (const id of supersede) retire.run(runId, id);

      const { next } = this.q("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM steps WHERE run_id = ?").get(runId) as {
        next: number;
      };
      const insert = this.q(
        "INSERT OR IGNORE INTO steps (run_id, step_id, graph_version, status, seq) VALUES (?, ?, ?, 'pending', ?)",
      );
      graph.order.forEach((id, i) => insert.run(runId, id, version, next + i));
      return true;
    });
  }

  getSteps(runId: string): StepRow[] {
    const rows = this.q("SELECT * FROM steps WHERE run_id = ? ORDER BY seq").all(runId) as Record<string, unknown>[];
    return rows.map(toStep);
  }

  updateStep(runId: string, stepId: string, patch: StepPatch, fence?: string): boolean {
    const entries = Object.entries(patch) as [keyof StepPatch, StepPatch[keyof StepPatch]][];
    if (entries.length === 0) return true;
    const sets = entries.map(([key]) => `${STEP_COLUMNS[key]} = ?`).join(", ");
    const values = entries.map(([key, value]) => {
      if (key === "sources") return JSON.stringify(value);
      if (key === "cached") return value ? 1 : 0;
      return value as SQLQueryBindings;
    });
    return this.guarded(`UPDATE steps SET ${sets} WHERE run_id = ? AND step_id = ?`, [...values, runId, stepId], runId, fence);
  }

  addStepUsage(runId: string, stepId: string, usage: Usage, costUsd: number, fence?: string): boolean {
    return this.guarded(
      `UPDATE steps SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         search_calls = search_calls + ?, cost_usd = cost_usd + ?
       WHERE run_id = ? AND step_id = ?`,
      [usage.inputTokens, usage.outputTokens, usage.searchCalls, costUsd, runId, stepId],
      runId,
      fence,
    );
  }

  addPlanningUsage(runId: string, usage: Usage, costUsd: number, fence?: string): boolean {
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
  resetSteps(runId: string, from: StepStatus[], to: StepStatus, fence?: string, clearAttempts = false): number {
    const placeholders = from.map(() => "?").join(", ");
    const attempts = clearAttempts ? ", attempt = 0" : "";
    let sql = `UPDATE steps SET status = ?, error = NULL, finished_at = NULL${attempts} WHERE run_id = ? AND status IN (${placeholders})`;
    const params: SQLQueryBindings[] = [to, runId, ...from];
    if (fence) {
      sql += ` AND ${FENCE}`;
      params.push(runId, fence);
    }
    return this.q(sql).run(...params).changes;
  }

  /**
   * The run, its steps and totals, plus the id of the last event already reflected in them.
   * One read transaction keeps the rows and the cursor consistent, so a client that streams
   * events after `lastEventId` sees every later change exactly once.
   */
  snapshot(runId: string): { run: RunRow; steps: StepRow[]; totals: Totals; lastEventId: number } | null {
    this.db.exec("BEGIN DEFERRED");
    try {
      const run = this.getRun(runId);
      if (!run) return null;
      const { last } = this.q("SELECT COALESCE(MAX(id), 0) AS last FROM events WHERE run_id = ?").get(runId) as { last: number };
      return { run, steps: this.getSteps(runId), totals: this.totals(runId), lastEventId: last };
    } finally {
      this.db.exec("COMMIT");
    }
  }

  totals(runId: string): Totals {
    const steps = this
      .q(
        `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
                COALESCE(SUM(search_calls), 0) AS s, COALESCE(SUM(cost_usd), 0) AS c
         FROM steps WHERE run_id = ?`,
      )
      .get(runId) as { i: number; o: number; s: number; c: number };
    const planning = this
      .q("SELECT planning_input_tokens AS i, planning_output_tokens AS o, planning_cost_usd AS c FROM runs WHERE id = ?")
      .get(runId) as { i: number; o: number; c: number } | null;

    return {
      inputTokens: steps.i + (planning?.i ?? 0),
      outputTokens: steps.o + (planning?.o ?? 0),
      searchCalls: steps.s,
      // Round away float noise from summing many small costs.
      costUsd: Math.round((steps.c + (planning?.c ?? 0)) * 1e8) / 1e8,
    };
  }

  appendEvent(runId: string, type: string, payload: unknown, now: number): number {
    const result = this
      .q("INSERT INTO events (run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, type, JSON.stringify(payload), now);
    return Number(result.lastInsertRowid);
  }

  eventsAfter(runId: string, afterId: number, limit = 500): EventRow[] {
    const rows = this
      .q("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(runId, afterId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      type: r.type as string,
      payload: JSON.parse(r.payload_json as string),
      createdAt: r.created_at as number,
    }));
  }

  claimRun(runId: string, workerId: string, now: number, ttlMs: number): boolean {
    return (
      this
        .q(
          `UPDATE runs SET lease_owner = ?, lease_expires_at = ?
           WHERE id = ? AND status IN ('planning', 'running')
             AND (lease_owner IS NULL OR lease_expires_at < ?)`,
        )
        .run(workerId, now + ttlMs, runId, now).changes === 1
    );
  }

  heartbeat(runId: string, workerId: string, now: number, ttlMs: number): boolean {
    return (
      this
        .q("UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?")
        .run(now + ttlMs, runId, workerId).changes === 1
    );
  }

  releaseRun(runId: string, workerId: string): void {
    this
      .q("UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?")
      .run(runId, workerId);
  }

  claimableRuns(now: number): string[] {
    const rows = this
      .q(
        `SELECT id FROM runs WHERE status IN ('planning', 'running')
           AND (lease_owner IS NULL OR lease_expires_at < ?)
         ORDER BY created_at`,
      )
      .all(now) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Removes a run with its steps and events. Returns false when the run is already gone. */
  deleteRun(runId: string): boolean {
    return this.tx(() => {
      this.q("DELETE FROM events WHERE run_id = ?").run(runId);
      this.q("DELETE FROM steps WHERE run_id = ?").run(runId);
      return this.q("DELETE FROM runs WHERE id = ?").run(runId).changes > 0;
    });
  }

  cacheGet(key: string): { output: string; sources: Source[] } | null {
    const row = this.q("SELECT output, sources_json FROM step_cache WHERE key = ?").get(key) as {
      output: string;
      sources_json: string | null;
    } | null;
    return row ? { output: row.output, sources: row.sources_json ? JSON.parse(row.sources_json) : [] } : null;
  }

  cachePut(key: string, output: string, sources: Source[], now: number): void {
    this
      .q("INSERT OR REPLACE INTO step_cache (key, output, sources_json, created_at) VALUES (?, ?, ?, ?)")
      .run(key, output, JSON.stringify(sources), now);
  }

  private guarded(sql: string, params: SQLQueryBindings[], runId: string, fence?: string): boolean {
    if (fence) {
      sql += ` AND ${FENCE}`;
      params = [...params, runId, fence];
    }
    return this.q(sql).run(...params).changes > 0;
  }
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
    budgetTokens: r.budget_tokens as number | null,
    budgetUsd: r.budget_usd as number | null,
    leaseOwner: r.lease_owner as string | null,
    leaseExpiresAt: r.lease_expires_at as number | null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
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
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    searchCalls: r.search_calls as number,
    costUsd: r.cost_usd as number,
    cached: r.cached === 1,
    startedAt: r.started_at as number | null,
    finishedAt: r.finished_at as number | null,
  };
}
