import { describe, expect, test } from "bun:test";
import { eventStepId } from "./events";
import type { RunEvent } from "./types";

function ev(type: string, payload: Record<string, unknown>): RunEvent {
  return { id: 1, runId: "run_1", type, payload, createdAt: 0 } as RunEvent;
}

describe("eventStepId", () => {
  test("finds the step an event is about", () => {
    expect(eventStepId(ev("step.started", { stepId: "a", attempt: 1 }))).toBe("a");
    expect(eventStepId(ev("step.failed", { stepId: "b", error: "boom" }))).toBe("b");
    expect(eventStepId(ev("step.skipped", { stepId: "c", reason: "upstream failed" }))).toBe("c");
  });

  test("points a re-plan at the step it replaced", () => {
    expect(eventStepId(ev("run.replanned", { failedStepId: "b", added: ["b_r2"] }))).toBe("b");
  });

  test("has no step for run-wide events", () => {
    expect(eventStepId(ev("run.created", { goal: "g" }))).toBeNull();
    expect(eventStepId(ev("run.succeeded", {}))).toBeNull();
  });
});
