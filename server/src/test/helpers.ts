import { openPglite, openPostgres, type Db } from "../engine/db";
import { validateGraph } from "../engine/graph";
import type { ManualClock } from "../engine/clock";
import { Store } from "../engine/store";
import type { NormalizedGraph } from "../engine/types";

export function makeGraph(input: unknown): NormalizedGraph {
  const result = validateGraph(input);
  if (!result.ok) throw new Error("invalid test graph: " + result.issues.join("; "));
  return result.graph;
}

let shared: Promise<Db> | undefined;

/**
 * A store on an empty database. Every test file shares one in-memory PGlite, since starting
 * one takes most of a second, and each call empties its tables. Set TEST_DATABASE_URL to run
 * the same tests against a real Postgres server instead.
 */
export async function testStore(): Promise<Store> {
  const db = await testDb();
  return Store.open(db);
}

/** The shared test database with its tables emptied. Its close() is a no-op. */
export async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  shared ??= (url ? openPostgres(url, { max: 10 }) : openPglite()).then(async (db) => {
    await Store.open(db);
    return { ...db, close: async () => {} };
  });
  const db = await shared;
  await db.exec("TRUNCATE runs, steps, events, step_cache RESTART IDENTITY");
  return db;
}

export async function setupRun(
  store: Store,
  graph: NormalizedGraph,
  opts: { id?: string; workerId?: string; concurrency?: number; goal?: string | null; budgetTokens?: number | null; budgetUsd?: number | null; now?: number } = {},
): Promise<string> {
  const id = opts.id ?? `run_${crypto.randomUUID().slice(0, 8)}`;
  const now = opts.now ?? 0;
  await store.createRun({
    id,
    goal: opts.goal ?? null,
    profile: null,
    status: "running",
    concurrency: opts.concurrency ?? 4,
    maxReplans: 0,
    budgetTokens: opts.budgetTokens ?? null,
    budgetUsd: opts.budgetUsd ?? null,
    now,
  });
  await store.installGraph(id, graph, 1, [], now);
  if (opts.workerId !== null) await store.claimRun(id, opts.workerId ?? "w1", now, 3_600_000);
  return id;
}

/** Advances a manual clock in steps until `promise` settles, giving database I/O a moment between steps. */
export async function drive<T>(promise: Promise<T>, clock: ManualClock, stepMs = 250, maxSteps = 10_000): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < maxSteps && !done; i++) {
    await ioTurn();
    await clock.advance(stepMs);
  }
  if (!done) throw new Error("promise did not settle while driving the clock");
  return promise;
}

/** Waits in real time until `check` passes. Database calls to a real server finish on a later turn. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await ioTurn();
  }
}

function ioTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

export async function stepMap(store: Store, runId: string) {
  return Object.fromEntries((await store.getSteps(runId)).map((s) => [s.stepId, s]));
}

export async function eventTypes(store: Store, runId: string): Promise<string[]> {
  return (await store.eventsAfter(runId, 0, 10_000)).map((e) => e.type);
}
