import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGraph } from "./graph";
import { Store } from "./store";
import type { NormalizedGraph } from "./types";

function graph(input: unknown): NormalizedGraph {
  const result = validateGraph(input);
  if (!result.ok) throw new Error(result.issues.join("; "));
  return result.graph;
}

const chain = graph({
  steps: [
    { id: "a", prompt: "one" },
    { id: "b", prompt: "{{a.output}}" },
    { id: "c", prompt: "{{b.output}}" },
  ],
});

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(() => store.close());

function newRun(id = "run_1", status: "planning" | "running" = "running") {
  store.createRun({
    id,
    goal: "g",
    profile: "general",
    status,
    concurrency: 4,
    maxReplans: 2,
    budgetTokens: null,
    budgetUsd: null,
    now: 1_000,
  });
}

describe("runs and steps", () => {
  test("creates a run and installs its graph as pending steps", () => {
    newRun();
    expect(store.installGraph("run_1", chain, 1, [], 2_000)).toBe(true);

    const run = store.getRun("run_1")!;
    expect(run.status).toBe("running");
    expect(run.graphVersion).toBe(1);
    expect(run.graph?.order).toEqual(["a", "b", "c"]);
    expect(run.updatedAt).toBe(2_000);

    const steps = store.getSteps("run_1");
    expect(steps.map((s) => [s.stepId, s.status, s.graphVersion])).toEqual([
      ["a", "pending", 1],
      ["b", "pending", 1],
      ["c", "pending", 1],
    ]);
    expect(store.getRun("missing")).toBeNull();
  });

  test("a second graph version supersedes old steps and keeps existing rows", () => {
    newRun();
    store.installGraph("run_1", chain, 1, [], 2_000);
    store.updateStep("run_1", "a", { status: "succeeded", output: "A" });

    const v2 = graph({
      steps: [
        { id: "a", prompt: "one" },
        { id: "b2", prompt: "{{a.output}}" },
      ],
    });
    store.installGraph("run_1", v2, 2, ["b", "c"], 3_000);

    const byId = Object.fromEntries(store.getSteps("run_1").map((s) => [s.stepId, s]));
    expect(byId.a!.status).toBe("succeeded");
    expect(byId.a!.output).toBe("A");
    expect(byId.a!.graphVersion).toBe(1);
    expect(byId.b!.status).toBe("superseded");
    expect(byId.c!.status).toBe("superseded");
    expect(byId.b2!.status).toBe("pending");
    expect(byId.b2!.graphVersion).toBe(2);
  });

  test("updateStep writes every patch field", () => {
    newRun();
    store.installGraph("run_1", chain, 1, [], 2_000);
    store.updateStep("run_1", "a", {
      status: "succeeded",
      attempt: 2,
      resolvedPrompt: "one",
      output: "out",
      sources: [{ title: "T", url: "https://t" }],
      error: null,
      cached: true,
      startedAt: 10,
      finishedAt: 20,
    });
    const a = store.getSteps("run_1")[0]!;
    expect(a).toMatchObject({
      status: "succeeded",
      attempt: 2,
      resolvedPrompt: "one",
      output: "out",
      sources: [{ title: "T", url: "https://t" }],
      error: null,
      cached: true,
      startedAt: 10,
      finishedAt: 20,
    });
  });

  test("resetSteps moves steps between statuses and clears errors", () => {
    newRun();
    store.installGraph("run_1", chain, 1, [], 2_000);
    store.updateStep("run_1", "a", { status: "failed", error: "boom", attempt: 3, finishedAt: 5 });
    store.updateStep("run_1", "b", { status: "skipped", error: "upstream failed" });
    expect(store.resetSteps("run_1", ["failed", "skipped"], "pending")).toBe(2);
    const [a, b] = store.getSteps("run_1");
    expect(a).toMatchObject({ status: "pending", error: null, attempt: 3, finishedAt: null });
    expect(b).toMatchObject({ status: "pending", error: null });
  });

  test("totals sum step usage and planning usage", () => {
    newRun();
    store.installGraph("run_1", chain, 1, [], 2_000);
    store.addStepUsage("run_1", "a", { inputTokens: 10, outputTokens: 5, searchCalls: 1 }, 0.5);
    store.addStepUsage("run_1", "a", { inputTokens: 10, outputTokens: 5, searchCalls: 0 }, 0.25);
    store.addStepUsage("run_1", "b", { inputTokens: 1, outputTokens: 1, searchCalls: 0 }, 0.01);
    store.addPlanningUsage("run_1", { inputTokens: 100, outputTokens: 50, searchCalls: 0 }, 1);
    expect(store.totals("run_1")).toEqual({ inputTokens: 121, outputTokens: 61, searchCalls: 1, costUsd: 1.76 });
    expect(store.getSteps("run_1")[0]!.costUsd).toBeCloseTo(0.75);
  });

  test("listRuns returns newest first with step counts and totals", () => {
    newRun("run_old");
    store.createRun({
      id: "run_new",
      goal: null,
      profile: null,
      status: "running",
      concurrency: 2,
      maxReplans: 0,
      budgetTokens: 100,
      budgetUsd: 1,
      now: 5_000,
    });
    store.installGraph("run_new", chain, 1, [], 5_000);
    store.updateStep("run_new", "a", { status: "succeeded" });

    const runs = store.listRuns(10);
    expect(runs.map((r) => r.id)).toEqual(["run_new", "run_old"]);
    expect(runs[0]!.stepCounts).toMatchObject({ succeeded: 1, pending: 2, failed: 0 });
    expect(runs[0]!.budgetTokens).toBe(100);
    expect(runs[0]!.totals.costUsd).toBe(0);
  });

  test("setRunStatus and incrementReplans", () => {
    newRun();
    expect(store.setRunStatus("run_1", "failed", "bad", 9_000)).toBe(true);
    expect(store.getRun("run_1")).toMatchObject({ status: "failed", error: "bad", updatedAt: 9_000 });
    expect(store.incrementReplans("run_1")).toBe(true);
    expect(store.getRun("run_1")!.replans).toBe(1);
  });
});

describe("leases", () => {
  test("a claim is exclusive until it expires", () => {
    newRun();
    expect(store.claimRun("run_1", "w1", 1_000, 30_000)).toBe(true);
    expect(store.claimRun("run_1", "w2", 20_000, 30_000)).toBe(false);
    expect(store.claimRun("run_1", "w2", 31_001, 30_000)).toBe(true);
    expect(store.getRun("run_1")).toMatchObject({ leaseOwner: "w2", leaseExpiresAt: 61_001 });
  });

  test("only planning and running runs can be claimed", () => {
    newRun();
    store.setRunStatus("run_1", "succeeded", null, 2_000);
    expect(store.claimRun("run_1", "w1", 3_000, 30_000)).toBe(false);
  });

  test("heartbeat extends only the owner's lease", () => {
    newRun();
    store.claimRun("run_1", "w1", 1_000, 30_000);
    expect(store.heartbeat("run_1", "w1", 10_000, 30_000)).toBe(true);
    expect(store.getRun("run_1")!.leaseExpiresAt).toBe(40_000);
    expect(store.heartbeat("run_1", "w2", 10_000, 30_000)).toBe(false);
  });

  test("release clears the lease for the owner only", () => {
    newRun();
    store.claimRun("run_1", "w1", 1_000, 30_000);
    store.releaseRun("run_1", "w2");
    expect(store.getRun("run_1")!.leaseOwner).toBe("w1");
    store.releaseRun("run_1", "w1");
    expect(store.getRun("run_1")).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  test("fenced writes fail for a worker that does not hold the lease", () => {
    newRun();
    store.installGraph("run_1", chain, 1, [], 2_000);
    store.claimRun("run_1", "w1", 1_000, 30_000);

    expect(store.updateStep("run_1", "a", { status: "running" }, "w1")).toBe(true);
    expect(store.updateStep("run_1", "a", { status: "succeeded" }, "w2")).toBe(false);
    expect(store.addStepUsage("run_1", "a", { inputTokens: 1, outputTokens: 1, searchCalls: 0 }, 1, "w2")).toBe(false);
    expect(store.setRunStatus("run_1", "failed", null, 3_000, "w2")).toBe(false);
    expect(store.resetSteps("run_1", ["running"], "pending", "w2")).toBe(0);
    expect(store.installGraph("run_1", chain, 2, [], 3_000, "w2")).toBe(false);
    expect(store.getSteps("run_1")[0]!.status).toBe("running");
    expect(store.getRun("run_1")!.status).toBe("running");
  });

  test("claimableRuns lists unleased and expired active runs", () => {
    newRun("run_a");
    newRun("run_b", "planning");
    newRun("run_c");
    store.setRunStatus("run_c", "cancelled", null, 1_000);
    store.claimRun("run_a", "w1", 1_000, 30_000);

    expect(store.claimableRuns(2_000)).toEqual(["run_b"]);
    expect(store.claimableRuns(40_000).sort()).toEqual(["run_a", "run_b"]);
  });
});

describe("events and cache", () => {
  test("events come back in id order after a cursor", () => {
    newRun();
    const first = store.appendEvent("run_1", "run.started", { n: 1 }, 1);
    const second = store.appendEvent("run_1", "step.started", { stepId: "a" }, 2);
    store.appendEvent("run_other", "run.started", {}, 3);
    const third = store.appendEvent("run_1", "step.succeeded", { stepId: "a" }, 4);

    expect(store.eventsAfter("run_1", 0).map((e) => e.id)).toEqual([first, second, third]);
    expect(store.eventsAfter("run_1", first)).toEqual([
      { id: second, runId: "run_1", type: "step.started", payload: { stepId: "a" }, createdAt: 2 },
      { id: third, runId: "run_1", type: "step.succeeded", payload: { stepId: "a" }, createdAt: 4 },
    ]);
    expect(store.eventsAfter("run_1", 0, 1)).toHaveLength(1);
  });

  test("cache stores output and sources by key", () => {
    expect(store.cacheGet("k")).toBeNull();
    store.cachePut("k", "out", [{ title: "T", url: "https://t" }], 1);
    store.cachePut("k", "newer", [], 2);
    expect(store.cacheGet("k")).toEqual({ output: "newer", sources: [] });
  });

  test("tx rolls back every write when the callback throws", () => {
    newRun();
    expect(() =>
      store.tx(() => {
        store.setRunStatus("run_1", "failed", "x", 5);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.getRun("run_1")!.status).toBe("running");
  });

  test("nested tx calls join the outer transaction", () => {
    newRun();
    expect(() =>
      store.tx(() => {
        store.installGraph("run_1", chain, 1, [], 2_000);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.getSteps("run_1")).toHaveLength(0);
  });

  test("a file database opens in WAL mode and is shared between handles", () => {
    const path = join(tmpdir(), `relay-store-${crypto.randomUUID()}.db`);
    const one = new Store(path);
    const two = new Store(path);
    try {
      expect((one.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      one.cachePut("shared", "yes", [], 1);
      expect(two.cacheGet("shared")?.output).toBe("yes");
    } finally {
      one.close();
      two.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
});
