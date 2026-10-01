import { beforeEach, describe, expect, test } from "bun:test";
import { testStore } from "../test/helpers";
import { validateGraph } from "./graph";
import type { Store } from "./store";
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

beforeEach(async () => {
  store = await testStore();
});

async function newRun(id = "run_1", status: "planning" | "running" = "running") {
  await store.createRun({
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
  test("creates a run and installs its graph as pending steps", async () => {
    await newRun();
    expect(await store.installGraph("run_1", chain, 1, [], 2_000)).toBe(true);

    const run = (await store.getRun("run_1"))!;
    expect(run.status).toBe("running");
    expect(run.graphVersion).toBe(1);
    expect(run.graph?.order).toEqual(["a", "b", "c"]);
    expect(run.updatedAt).toBe(2_000);

    const steps = await store.getSteps("run_1");
    expect(steps.map((s) => [s.stepId, s.status, s.graphVersion])).toEqual([
      ["a", "pending", 1],
      ["b", "pending", 1],
      ["c", "pending", 1],
    ]);
    expect(await store.getRun("missing")).toBeNull();
  });

  test("a second graph version supersedes old steps and keeps existing rows", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    await store.updateStep("run_1", "a", { status: "succeeded", output: "A" });

    const v2 = graph({
      steps: [
        { id: "a", prompt: "one" },
        { id: "b2", prompt: "{{a.output}}" },
      ],
    });
    await store.installGraph("run_1", v2, 2, ["b", "c"], 3_000);

    const byId = Object.fromEntries((await store.getSteps("run_1")).map((s) => [s.stepId, s]));
    expect(byId.a!.status).toBe("succeeded");
    expect(byId.a!.output).toBe("A");
    expect(byId.a!.graphVersion).toBe(1);
    expect(byId.b!.status).toBe("superseded");
    expect(byId.c!.status).toBe("superseded");
    expect(byId.b2!.status).toBe("pending");
    expect(byId.b2!.graphVersion).toBe(2);
  });

  test("updateStep writes every patch field", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    await store.updateStep("run_1", "a", {
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
    const a = (await store.getSteps("run_1"))[0]!;
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

  test("resetSteps moves steps between statuses and clears errors", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    await store.updateStep("run_1", "a", { status: "failed", error: "boom", attempt: 3, finishedAt: 5 });
    await store.updateStep("run_1", "b", { status: "skipped", error: "upstream failed" });
    expect(await store.resetSteps("run_1", ["failed", "skipped"], "pending")).toBe(2);
    const [a, b] = await store.getSteps("run_1");
    expect(a).toMatchObject({ status: "pending", error: null, attempt: 3, finishedAt: null });
    expect(b).toMatchObject({ status: "pending", error: null });
  });

  test("totals sum step usage and planning usage", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    await store.addStepUsage("run_1", "a", { inputTokens: 10, outputTokens: 5, searchCalls: 1 }, 0.5);
    await store.addStepUsage("run_1", "a", { inputTokens: 10, outputTokens: 5, searchCalls: 0 }, 0.25);
    await store.addStepUsage("run_1", "b", { inputTokens: 1, outputTokens: 1, searchCalls: 0 }, 0.01);
    await store.addPlanningUsage("run_1", { inputTokens: 100, outputTokens: 50, searchCalls: 0 }, 1);
    expect(await store.totals("run_1")).toEqual({ inputTokens: 121, outputTokens: 61, searchCalls: 1, costUsd: 1.76 });
    expect((await store.getSteps("run_1"))[0]!.costUsd).toBeCloseTo(0.75);
  });

  test("listRuns returns newest first with step counts and totals", async () => {
    await newRun("run_old");
    await store.createRun({
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
    await store.installGraph("run_new", chain, 1, [], 5_000);
    await store.updateStep("run_new", "a", { status: "succeeded" });

    const runs = await store.listRuns(10);
    expect(runs.map((r) => r.id)).toEqual(["run_new", "run_old"]);
    expect(runs[0]!.stepCounts).toMatchObject({ succeeded: 1, pending: 2, failed: 0 });
    expect(runs[0]!.budgetTokens).toBe(100);
    expect(runs[0]!.totals.costUsd).toBe(0);
  });

  test("setRunStatus and incrementReplans", async () => {
    await newRun();
    expect(await store.setRunStatus("run_1", "failed", "bad", 9_000)).toBe(true);
    expect(await store.getRun("run_1")).toMatchObject({ status: "failed", error: "bad", updatedAt: 9_000 });
    expect(await store.incrementReplans("run_1")).toBe(true);
    expect((await store.getRun("run_1"))!.replans).toBe(1);
  });
});

describe("leases", () => {
  test("a claim is exclusive until it expires", async () => {
    await newRun();
    expect(await store.claimRun("run_1", "w1", 1_000, 30_000)).toBe(true);
    expect(await store.claimRun("run_1", "w2", 20_000, 30_000)).toBe(false);
    expect(await store.claimRun("run_1", "w2", 31_001, 30_000)).toBe(true);
    expect(await store.getRun("run_1")).toMatchObject({ leaseOwner: "w2", leaseExpiresAt: 61_001 });
  });

  test("only planning and running runs can be claimed", async () => {
    await newRun();
    await store.setRunStatus("run_1", "succeeded", null, 2_000);
    expect(await store.claimRun("run_1", "w1", 3_000, 30_000)).toBe(false);
  });

  test("heartbeat extends only the owner's lease", async () => {
    await newRun();
    await store.claimRun("run_1", "w1", 1_000, 30_000);
    expect(await store.heartbeat("run_1", "w1", 10_000, 30_000)).toBe(true);
    expect((await store.getRun("run_1"))!.leaseExpiresAt).toBe(40_000);
    expect(await store.heartbeat("run_1", "w2", 10_000, 30_000)).toBe(false);
  });

  test("release clears the lease for the owner only", async () => {
    await newRun();
    await store.claimRun("run_1", "w1", 1_000, 30_000);
    await store.releaseRun("run_1", "w2");
    expect((await store.getRun("run_1"))!.leaseOwner).toBe("w1");
    await store.releaseRun("run_1", "w1");
    expect(await store.getRun("run_1")).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  test("fenced writes fail for a worker that does not hold the lease", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    await store.claimRun("run_1", "w1", 1_000, 30_000);

    expect(await store.updateStep("run_1", "a", { status: "running" }, "w1")).toBe(true);
    expect(await store.updateStep("run_1", "a", { status: "succeeded" }, "w2")).toBe(false);
    expect(await store.addStepUsage("run_1", "a", { inputTokens: 1, outputTokens: 1, searchCalls: 0 }, 1, "w2")).toBe(false);
    expect(await store.setRunStatus("run_1", "failed", null, 3_000, "w2")).toBe(false);
    expect(await store.resetSteps("run_1", ["running"], "pending", "w2")).toBe(0);
    expect(await store.installGraph("run_1", chain, 2, [], 3_000, "w2")).toBe(false);
    expect((await store.getSteps("run_1"))[0]!.status).toBe("running");
    expect((await store.getRun("run_1"))!.status).toBe("running");
  });

  test("fenced writes fail once the run is no longer active, even for the lease owner", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    await store.claimRun("run_1", "w1", 1_000, 30_000);
    await store.setRunStatus("run_1", "cancelled", null, 3_000);

    expect(await store.updateStep("run_1", "a", { status: "succeeded" }, "w1")).toBe(false);
    expect(await store.setRunStatus("run_1", "succeeded", null, 4_000, "w1")).toBe(false);
    expect((await store.getRun("run_1"))!.status).toBe("cancelled");
  });

  test("resetSteps can restart attempt counts", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    await store.updateStep("run_1", "a", { status: "failed", attempt: 3 });
    await store.resetSteps("run_1", ["failed"], "pending", undefined, true);
    expect((await store.getSteps("run_1"))[0]).toMatchObject({ status: "pending", attempt: 0 });
  });

  test("claimableRuns lists unleased and expired active runs", async () => {
    await newRun("run_a");
    await newRun("run_b", "planning");
    await newRun("run_c");
    await store.setRunStatus("run_c", "cancelled", null, 1_000);
    await store.claimRun("run_a", "w1", 1_000, 30_000);

    expect(await store.claimableRuns(2_000)).toEqual(["run_b"]);
    expect((await store.claimableRuns(40_000)).sort()).toEqual(["run_a", "run_b"]);
  });
});

describe("snapshot", () => {
  test("returns rows with the id of the last event for the run", async () => {
    await newRun();
    await store.installGraph("run_1", chain, 1, [], 2_000);
    expect((await store.snapshot("run_1"))!.lastEventId).toBe(0);
    await store.appendEvent("run_1", "run.created", {}, 1);
    const last = await store.appendEvent("run_1", "step.started", { stepId: "a" }, 2);
    await store.appendEvent("run_other", "run.created", {}, 3);

    const snap = (await store.snapshot("run_1"))!;
    expect(snap.lastEventId).toBe(last);
    expect(snap.run.id).toBe("run_1");
    expect(snap.steps).toHaveLength(3);
    expect(snap.totals.costUsd).toBe(0);
    expect(await store.snapshot("missing")).toBeNull();
  });
});

describe("events and cache", () => {
  test("events come back in id order after a cursor", async () => {
    await newRun();
    const first = await store.appendEvent("run_1", "run.started", { n: 1 }, 1);
    const second = await store.appendEvent("run_1", "step.started", { stepId: "a" }, 2);
    await store.appendEvent("run_other", "run.started", {}, 3);
    const third = await store.appendEvent("run_1", "step.succeeded", { stepId: "a" }, 4);

    expect((await store.eventsAfter("run_1", 0)).map((e) => e.id)).toEqual([first, second, third]);
    expect(await store.eventsAfter("run_1", first)).toEqual([
      { id: second, runId: "run_1", type: "step.started", payload: { stepId: "a" }, createdAt: 2 },
      { id: third, runId: "run_1", type: "step.succeeded", payload: { stepId: "a" }, createdAt: 4 },
    ]);
    expect(await store.eventsAfter("run_1", 0, 1)).toHaveLength(1);
  });

  test("cache stores output and sources by key", async () => {
    expect(await store.cacheGet("k")).toBeNull();
    await store.cachePut("k", "out", [{ title: "T", url: "https://t" }], 1);
    await store.cachePut("k", "newer", [], 2);
    expect(await store.cacheGet("k")).toEqual({ output: "newer", sources: [] });
  });

  test("tx rolls back every write when the callback throws", async () => {
    await newRun();
    await expect(
      store.tx(async () => {
        await store.setRunStatus("run_1", "failed", "x", 5);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await store.getRun("run_1"))!.status).toBe("running");
  });

  test("nested tx calls join the outer transaction", async () => {
    await newRun();
    await expect(
      store.tx(async () => {
        await store.installGraph("run_1", chain, 1, [], 2_000);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await store.getSteps("run_1")).toHaveLength(0);
  });

  test("writes to one run wait for a transaction that holds its lock", async () => {
    await newRun();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = store.tx(
      async () => {
        order.push("first locked");
        await held;
        await store.setRunStatus("run_1", "failed", "first", 5);
        order.push("first wrote");
      },
      { lockRun: "run_1" },
    );
    const second = store.tx(
      async () => {
        order.push("second locked");
        await store.setRunStatus("run_1", "succeeded", null, 6);
      },
      { lockRun: "run_1" },
    );
    await Bun.sleep(20);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first locked", "first wrote", "second locked"]);
    expect((await store.getRun("run_1"))!.status).toBe("succeeded");
  });
});
