import { describe, expect, test } from "bun:test";
import type { RunState } from "./run-reducer";
import { autoSelectStep, finalStepId, runSources } from "./select";
import type { Graph, Run, Step, Totals } from "./types";

const graph: Graph = {
  order: ["a", "b", "c"],
  steps: [
    { id: "a", prompt: "A", dependsOn: [], tools: [], output: { type: "text" }, retries: 2, timeoutMs: 90_000, cache: false, final: false },
    { id: "b", prompt: "B", dependsOn: [], tools: [], output: { type: "text" }, retries: 2, timeoutMs: 90_000, cache: false, final: false },
    { id: "c", prompt: "C", dependsOn: ["a", "b"], tools: [], output: { type: "text" }, retries: 2, timeoutMs: 90_000, cache: false, final: true },
  ],
};

const ZERO: Totals = { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 };

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

function state(steps: Step[], runOverrides: Partial<Run> = {}): RunState {
  return {
    run: {
      id: "run_1",
      goal: "goal",
      profile: "general",
      graph,
      graphVersion: 1,
      status: "running",
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
      ...runOverrides,
    },
    steps: Object.fromEntries(steps.map((s) => [s.stepId, s])),
    planning: ZERO,
    totals: ZERO,
    events: [],
    lastEventId: 0,
  };
}

describe("finalStepId", () => {
  test("prefers the step marked final and falls back to the last in order", () => {
    expect(finalStepId(graph)).toBe("c");
    expect(finalStepId({ ...graph, steps: graph.steps.map((s) => ({ ...s, final: false })) })).toBe("c");
    expect(finalStepId(null)).toBeNull();
  });
});

describe("autoSelectStep", () => {
  test("has nothing to show before the run is planned", () => {
    expect(autoSelectStep(state([], { graph: null }))).toBeNull();
  });

  test("follows the step that started first while several run", () => {
    const picked = autoSelectStep(state([step("a", { status: "running", startedAt: 200 }), step("b", { status: "running", startedAt: 100 }), step("c")]));
    expect(picked).toBe("b");
  });

  test("shows the failure once a step fails", () => {
    const picked = autoSelectStep(state([step("a", { status: "succeeded" }), step("b", { status: "failed" }), step("c", { status: "skipped" })]));
    expect(picked).toBe("b");
  });

  test("shows the final step once it has an answer", () => {
    const picked = autoSelectStep(
      state([step("a", { status: "succeeded" }), step("b", { status: "succeeded" }), step("c", { status: "succeeded", output: "answer" })], { status: "succeeded" }),
    );
    expect(picked).toBe("c");
  });

  test("shows the newest finished step while the final one waits", () => {
    const picked = autoSelectStep(state([step("a", { status: "succeeded" }), step("b", { status: "succeeded" }), step("c")]));
    expect(picked).toBe("b");
  });

  test("falls back to the first step when nothing has started", () => {
    expect(autoSelectStep(state([step("a"), step("b"), step("c")]))).toBe("a");
  });
});

describe("runSources", () => {
  test("collects sources across steps, keeping one entry per URL", () => {
    const shared = { title: "Shared", url: "https://example.com/shared" };
    const collected = runSources(
      state([
        step("a", { status: "succeeded", sources: [shared, { title: "Only A", url: "https://example.com/a" }] }),
        step("b", { status: "succeeded", sources: [shared] }),
        step("c", { status: "succeeded", sources: [] }),
      ]),
    );

    expect(collected).toEqual([
      { title: "Shared", url: "https://example.com/shared", steps: ["a", "b"] },
      { title: "Only A", url: "https://example.com/a", steps: ["a"] },
    ]);
  });

  test("is empty for a run that did not search", () => {
    expect(runSources(state([step("a", { status: "succeeded" })]))).toEqual([]);
  });
});
