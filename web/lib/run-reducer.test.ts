import { describe, expect, test } from "bun:test";
import { currentSteps, runReducer, type RunState } from "./run-reducer";
import type { Graph, Run, RunEvent, RunSnapshot, Step } from "./types";

const graph: Graph = {
  order: ["a", "b"],
  steps: [
    { id: "a", prompt: "A", dependsOn: [], tools: [], output: { type: "text" }, retries: 2, timeoutMs: 90_000, cache: false, final: false },
    { id: "b", prompt: "B {{a.output}}", dependsOn: ["a"], tools: [], output: { type: "text" }, retries: 2, timeoutMs: 90_000, cache: false, final: true },
  ],
};

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    goal: "goal",
    profile: "general",
    graph: null,
    graphVersion: 0,
    status: "planning",
    error: null,
    concurrency: 4,
    maxReplans: 2,
    replans: 0,
    budgetTokens: null,
    budgetUsd: null,
    leaseOwner: "w1",
    leaseExpiresAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function step(id: string, overrides: Partial<Step> = {}): Step {
  return {
    runId: "run_1",
    stepId: id,
    graphVersion: 1,
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
    ...overrides,
  };
}

let nextId = 10;
function ev(type: string, payload: Record<string, unknown>): RunEvent {
  return { id: nextId++, runId: "run_1", type, payload, createdAt: nextId * 100 } as RunEvent;
}

function reduce(state: RunState, ...events: RunEvent[]): RunState {
  return events.reduce<RunState>((s, e) => runReducer(s, { type: "event", event: e })!, state);
}

function load(snapshot: RunSnapshot): RunState {
  return runReducer(null, { type: "snapshot", snapshot })!;
}

describe("runReducer", () => {
  test("follows a planned run through to success and keeps planning cost in the total", () => {
    const state = load({
      run: run(),
      steps: [],
      totals: { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 },
      lastEventId: 9,
    });

    const done = reduce(
      state,
      ev("run.planned", { graph, attempts: 1, usage: { inputTokens: 100, outputTokens: 50, searchCalls: 0, costUsd: 0.5 } }),
      ev("step.started", { stepId: "a", attempt: 1, startedAt: 1_000, prompt: "A" }),
      ev("step.succeeded", {
        stepId: "a",
        attempt: 1,
        output: "a-out",
        sources: [{ title: "T", url: "https://t" }],
        cached: false,
        finishedAt: 2_000,
        usage: { inputTokens: 10, outputTokens: 5, searchCalls: 1, costUsd: 0.25 },
      }),
      ev("step.started", { stepId: "b", attempt: 1, startedAt: 2_000, prompt: "B a-out" }),
      ev("step.succeeded", { stepId: "b", attempt: 1, output: "b-out", cached: true, finishedAt: 2_500, usage: { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 } }),
      ev("run.succeeded", { error: null }),
    );

    expect(done.run.status).toBe("succeeded");
    expect(currentSteps(done).map((s) => [s.stepId, s.status])).toEqual([
      ["a", "succeeded"],
      ["b", "succeeded"],
    ]);
    expect(done.steps.a).toMatchObject({ output: "a-out", resolvedPrompt: "A", sources: [{ title: "T", url: "https://t" }] });
    expect(done.steps.b!.cached).toBe(true);
    expect(done.totals).toEqual({ inputTokens: 110, outputTokens: 55, searchCalls: 1, costUsd: 0.75 });
    expect(done.events).toHaveLength(6);
  });

  test("adds events the snapshot already includes to the timeline without applying them", () => {
    const state = load({
      run: run({ status: "running", graph, graphVersion: 1 }),
      steps: [step("a", { status: "succeeded", output: "done" }), step("b")],
      totals: { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 },
      lastEventId: 50,
    });
    const old: RunEvent = { id: 40, runId: "run_1", type: "step.started", payload: { stepId: "a", attempt: 1, startedAt: 0 }, createdAt: 0 };
    const after = runReducer(state, { type: "event", event: old })!;
    expect(after.steps.a!.status).toBe("succeeded");
    expect(after.events.map((e) => e.id)).toEqual([40]);
    // A repeat after a reconnect changes nothing.
    expect(runReducer(after, { type: "event", event: old })).toBe(after);
  });

  test("applies a re-plan: old steps superseded, new steps pending", () => {
    const state = load({
      run: run({ status: "running", graph, graphVersion: 1 }),
      steps: [step("a", { status: "succeeded" }), step("b", { status: "failed", error: "bad" })],
      totals: { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 },
      lastEventId: 0,
    });
    const v2: Graph = { order: ["a", "b_alt"], steps: [graph.steps[0]!, { ...graph.steps[1]!, id: "b_alt" }] };
    const next = reduce(state, ev("run.replanned", { failedStepId: "b", graphVersion: 2, graph: v2, supersede: ["b"], added: ["b_alt"], usage: { inputTokens: 5, outputTokens: 5, searchCalls: 0, costUsd: 0.1 } }));

    expect(next.run).toMatchObject({ graphVersion: 2, replans: 1 });
    expect(next.steps.b!.status).toBe("superseded");
    expect(next.steps.b_alt).toMatchObject({ status: "pending", graphVersion: 2 });
    expect(currentSteps(next).map((s) => s.stepId)).toEqual(["a", "b_alt"]);
    expect(next.totals.costUsd).toBeCloseTo(0.1);
  });

  test("handles retries, skips, takeovers and a manual retry", () => {
    const state = load({
      run: run({ status: "running", graph, graphVersion: 1 }),
      steps: [step("a", { status: "running", attempt: 1 }), step("b")],
      totals: { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 },
      lastEventId: 0,
    });
    const failed = reduce(
      state,
      ev("step.retrying", { stepId: "a", attempt: 1, error: "HTTP 503", delayMs: 1_000 }),
      ev("step.failed", { stepId: "a", attempt: 3, error: "HTTP 503", finishedAt: 9, usage: { inputTokens: 1, outputTokens: 1, searchCalls: 0, costUsd: 0 } }),
      ev("step.skipped", { stepId: "b", reason: 'upstream step "a" failed' }),
      ev("run.failed", { error: 'step "a" failed: HTTP 503' }),
    );
    expect(failed.run).toMatchObject({ status: "failed", error: 'step "a" failed: HTTP 503' });
    expect(failed.steps.b).toMatchObject({ status: "skipped", error: 'upstream step "a" failed' });

    const retried = reduce(failed, ev("run.retried", {}));
    expect(retried.run).toMatchObject({ status: "running", error: null });
    expect([retried.steps.a!.status, retried.steps.b!.status]).toEqual(["pending", "pending"]);

    const taken = reduce(retried, ev("step.started", { stepId: "a", attempt: 1, startedAt: 1 }), ev("run.lease_taken", { workerId: "w2", previousOwner: "w1", resetSteps: ["a"] }));
    expect(taken.run.leaseOwner).toBe("w2");
    expect(taken.steps.a!.status).toBe("pending");
  });
});
