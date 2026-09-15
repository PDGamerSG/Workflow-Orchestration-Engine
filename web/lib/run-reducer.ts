import type { Run, RunEvent, RunSnapshot, Step, Totals } from "./types";

export type RunState = {
  run: Run;
  steps: Record<string, Step>;
  /** Tokens and cost from planner calls, which belong to the run but to no step. */
  planning: Totals;
  totals: Totals;
  events: RunEvent[];
  lastEventId: number;
};

export type RunAction = { type: "snapshot"; snapshot: RunSnapshot } | { type: "event"; event: RunEvent };

const ZERO: Totals = { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 };

export function initRunState(snapshot: RunSnapshot): RunState {
  const steps = Object.fromEntries(snapshot.steps.map((s) => [s.stepId, s]));
  const stepSum = sumSteps(steps);
  return {
    run: snapshot.run,
    steps,
    planning: {
      inputTokens: snapshot.totals.inputTokens - stepSum.inputTokens,
      outputTokens: snapshot.totals.outputTokens - stepSum.outputTokens,
      searchCalls: snapshot.totals.searchCalls - stepSum.searchCalls,
      costUsd: snapshot.totals.costUsd - stepSum.costUsd,
    },
    totals: snapshot.totals,
    events: [],
    lastEventId: snapshot.lastEventId,
  };
}

export function runReducer(state: RunState | null, action: RunAction): RunState | null {
  if (action.type === "snapshot") return initRunState(action.snapshot);
  if (!state) return state;

  const event = action.event;
  // The stream starts from the first event so the timeline is complete. Events up to the snapshot's
  // cursor are already reflected in the rows, so they only join the timeline.
  const newest = state.events.at(-1)?.id ?? 0;
  if (event.id <= newest) return state;
  if (event.id <= state.lastEventId) return { ...state, events: [...state.events, event] };

  const next = applyEvent({ ...state, steps: { ...state.steps } }, event);
  next.events = [...state.events, event];
  next.lastEventId = event.id;
  next.totals = addTotals(next.planning, sumSteps(next.steps));
  return next;
}

function applyEvent(state: RunState, event: RunEvent): RunState {
  const patch = (id: string, fields: Partial<Step>) => {
    const current = state.steps[id] ?? blankStep(state.run.id, id, state.run.graphVersion);
    state.steps[id] = { ...current, ...fields };
  };

  switch (event.type) {
    case "run.planned": {
      const { graph, usage } = event.payload;
      state.run = { ...state.run, status: "running", graph, graphVersion: 1 };
      state.planning = addTotals(state.planning, usageTotals(usage));
      for (const id of graph.order) if (!state.steps[id]) patch(id, {});
      return state;
    }

    case "run.replanned": {
      const { graph, graphVersion, supersede, added, usage } = event.payload;
      state.run = { ...state.run, graph, graphVersion, replans: state.run.replans + 1 };
      state.planning = addTotals(state.planning, usageTotals(usage));
      for (const id of supersede) patch(id, { status: "superseded" });
      for (const id of added) state.steps[id] = blankStep(state.run.id, id, graphVersion);
      return state;
    }

    case "run.lease_taken":
      state.run = { ...state.run, leaseOwner: event.payload.workerId };
      for (const id of event.payload.resetSteps) patch(id, { status: "pending" });
      return state;

    case "run.retried":
      state.run = { ...state.run, status: state.run.graph ? "running" : "planning", error: null };
      for (const step of Object.values(state.steps)) {
        if (step.status === "failed" || step.status === "skipped") patch(step.stepId, { status: "pending", error: null, finishedAt: null, attempt: 0 });
      }
      return state;

    case "step.started": {
      const p = event.payload;
      patch(p.stepId, { status: "running", attempt: p.attempt, startedAt: p.startedAt, resolvedPrompt: p.prompt ?? null, error: null, finishedAt: null });
      return state;
    }

    case "step.retrying":
      patch(event.payload.stepId, { error: event.payload.error });
      return state;

    case "step.succeeded": {
      const p = event.payload;
      patch(p.stepId, {
        status: "succeeded",
        output: p.output,
        sources: p.sources ?? [],
        cached: p.cached,
        error: null,
        finishedAt: p.finishedAt,
        ...usageTotals(p.usage),
      });
      return state;
    }

    case "step.failed": {
      const p = event.payload;
      patch(p.stepId, { status: "failed", error: p.error, finishedAt: p.finishedAt, ...usageTotals(p.usage) });
      return state;
    }

    case "step.skipped":
      patch(event.payload.stepId, { status: "skipped", error: event.payload.reason });
      return state;

    case "run.succeeded":
    case "run.failed":
    case "run.cancelled":
      state.run = {
        ...state.run,
        status: event.type.slice(4) as Run["status"],
        error: event.payload.error ?? null,
        updatedAt: event.createdAt,
      };
      return state;

    default:
      return state;
  }
}

function blankStep(runId: string, stepId: string, graphVersion: number): Step {
  return {
    runId,
    stepId,
    graphVersion,
    status: "pending",
    attempt: 0,
    resolvedPrompt: null,
    output: null,
    sources: [],
    error: null,
    inputTokens: 0,
    outputTokens: 0,
    searchCalls: 0,
    costUsd: 0,
    cached: false,
    startedAt: null,
    finishedAt: null,
  };
}

function sumSteps(steps: Record<string, Step>): Totals {
  return Object.values(steps).reduce<Totals>(
    (t, s) => ({
      inputTokens: t.inputTokens + s.inputTokens,
      outputTokens: t.outputTokens + s.outputTokens,
      searchCalls: t.searchCalls + s.searchCalls,
      costUsd: t.costUsd + s.costUsd,
    }),
    ZERO,
  );
}

function addTotals(a: Totals, b: Totals): Totals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    searchCalls: a.searchCalls + b.searchCalls,
    costUsd: a.costUsd + b.costUsd,
  };
}

function usageTotals(usage: Partial<Totals> | undefined): Totals {
  return { ...ZERO, ...usage };
}

/** Steps in the current graph, in topological order. */
export function currentSteps(state: RunState): Step[] {
  return (state.run.graph?.order ?? []).map((id) => state.steps[id]).filter((s): s is Step => !!s);
}

/** Steps replaced by a re-plan, oldest first. */
export function supersededSteps(state: RunState): Step[] {
  return Object.values(state.steps).filter((s) => s.status === "superseded");
}
