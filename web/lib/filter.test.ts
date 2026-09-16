import { describe, expect, test } from "bun:test";
import { countByFilter, filterRuns } from "./filter";
import type { RunStatus, RunSummary } from "./types";

function summary(id: string, status: RunStatus, goal: string | null): RunSummary {
  return {
    id,
    goal,
    profile: "research",
    graphVersion: 1,
    status,
    error: null,
    concurrency: 4,
    maxReplans: 2,
    replans: 0,
    budgetTokens: null,
    budgetUsd: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    stepCounts: { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, superseded: 0 },
    totals: { inputTokens: 0, outputTokens: 0, searchCalls: 0, costUsd: 0 },
  };
}

const runs = [
  summary("run_a", "running", "Compare SQLite and Postgres"),
  summary("run_b", "succeeded", "Write a launch plan"),
  summary("run_c", "failed", "Compare vector databases"),
  summary("run_d", "cancelled", null),
  summary("run_e", "planning", "Compare pricing models"),
];

describe("filterRuns", () => {
  test("keeps everything when no filter and no search are set", () => {
    expect(filterRuns(runs, "all", "")).toHaveLength(5);
  });

  test("treats planning and running as active", () => {
    expect(filterRuns(runs, "active", "").map((r) => r.id)).toEqual(["run_a", "run_e"]);
  });

  test("searches the goal and the id, ignoring case", () => {
    expect(filterRuns(runs, "all", "compare").map((r) => r.id)).toEqual(["run_a", "run_c", "run_e"]);
    expect(filterRuns(runs, "all", "RUN_D").map((r) => r.id)).toEqual(["run_d"]);
    expect(filterRuns(runs, "all", "  launch ").map((r) => r.id)).toEqual(["run_b"]);
  });

  test("applies the status filter and the search together", () => {
    expect(filterRuns(runs, "active", "compare").map((r) => r.id)).toEqual(["run_a", "run_e"]);
    expect(filterRuns(runs, "failed", "postgres")).toEqual([]);
  });

  test("matches a run with no goal only by id", () => {
    expect(filterRuns(runs, "all", "plan").map((r) => r.id)).toEqual(["run_b"]);
  });
});

describe("countByFilter", () => {
  test("counts the runs each chip would show", () => {
    expect(countByFilter(runs)).toEqual({ all: 5, active: 2, succeeded: 1, failed: 1, cancelled: 1 });
  });
});
