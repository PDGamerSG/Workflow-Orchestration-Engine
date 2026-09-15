import { validateGraph } from "../engine/graph";
import type { ManualClock } from "../engine/clock";
import type { Store } from "../engine/store";
import type { NormalizedGraph } from "../engine/types";

export function makeGraph(input: unknown): NormalizedGraph {
  const result = validateGraph(input);
  if (!result.ok) throw new Error("invalid test graph: " + result.issues.join("; "));
  return result.graph;
}

export function setupRun(
  store: Store,
  graph: NormalizedGraph,
  opts: { id?: string; workerId?: string; concurrency?: number; goal?: string | null; budgetTokens?: number | null; budgetUsd?: number | null; now?: number } = {},
): string {
  const id = opts.id ?? `run_${crypto.randomUUID().slice(0, 8)}`;
  const now = opts.now ?? 0;
  store.createRun({
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
  store.installGraph(id, graph, 1, [], now);
  if (opts.workerId !== null) store.claimRun(id, opts.workerId ?? "w1", now, 3_600_000);
  return id;
}

/** Advances a manual clock in steps until `promise` settles. */
export async function drive<T>(promise: Promise<T>, clock: ManualClock, stepMs = 250, maxSteps = 10_000): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < maxSteps && !done; i++) await clock.advance(stepMs);
  if (!done) throw new Error("promise did not settle while driving the clock");
  return promise;
}

export function stepMap(store: Store, runId: string) {
  return Object.fromEntries(store.getSteps(runId).map((s) => [s.stepId, s]));
}

export function eventTypes(store: Store, runId: string): string[] {
  return store.eventsAfter(runId, 0, 10_000).map((e) => e.type);
}
