import { afterEach, describe, expect, test } from "bun:test";
import { FakeProvider, type FakeHandler } from "../llm/fake";
import { LlmError } from "../llm/provider";
import { eventTypes, stepMap, testDb } from "../test/helpers";
import { Planner } from "../planner/planner";
import { Engine, type EngineOptions } from "./engine";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import type { Db } from "./db";
import { Store } from "./store";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const pricing = { inputPerM: 0, outputPerM: 0, searchPerK: 0 };
const echo: FakeHandler = (req) => ({ text: `${req.prompt.match(/^step (\w+)/)?.[1]}-out` });

/** An engine with its own store. Engines made from the same `db` share it like separate processes. */
async function makeEngine(db: Db, provider: FakeProvider, opts: Partial<EngineOptions> = {}) {
  const store = await Store.open(db);
  const engine = new Engine({
    store,
    provider,
    pricing,
    rpm: 60_000,
    leaseTtlMs: 300,
    heartbeatMs: 50,
    sweepMs: 60_000,
    ...opts,
  });
  cleanup.push(async () => {
    await engine.stop({ graceful: false });
  });
  return { engine, store };
}

const chain = {
  steps: [
    { id: "a", prompt: "step a" },
    { id: "b", prompt: "step b {{a.output}}" },
    { id: "c", prompt: "step c {{b.output}}" },
  ],
};

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("Engine", () => {
  test("runs a submitted graph to completion", async () => {
    const { engine, store } = await makeEngine(await testDb(), new FakeProvider(echo));
    engine.start();
    const { runId } = await engine.createRun({ graph: chain, concurrency: 2 });

    await engine.whenSettled(runId);

    expect(await store.getRun(runId)).toMatchObject({ status: "succeeded", concurrency: 2, leaseOwner: null });
    expect((await stepMap(store, runId)).c!.output).toBe("c-out");
    expect((await eventTypes(store, runId))[0]).toBe("run.created");
  });

  test("rejects an invalid graph with every issue", async () => {
    const { engine } = await makeEngine(await testDb(), new FakeProvider(echo));
    try {
      await engine.createRun({ graph: { steps: [{ id: "a", prompt: "{{b.output}}" }, { id: "a", prompt: "x" }] } });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues).toEqual(['duplicate step id "a"', 'step "a" references unknown step "b"']);
    }
    await expect(engine.createRun({ concurrency: 3 })).rejects.toThrow(ValidationError);
    await expect(engine.createRun({ graph: chain, concurrency: 99 })).rejects.toThrow(ValidationError);
  });

  test("another engine resumes a crashed run without re-running finished steps", async () => {
    const db = await testDb();
    const slowB = new FakeProvider(echo, { delayMs: (req) => (req.prompt.startsWith("step b") ? 10_000 : 1) });
    const a = await makeEngine(db, slowB, { workerId: "worker-a" });
    a.engine.start();
    const { runId } = await a.engine.createRun({ graph: chain });
    await waitFor(async () => (await stepMap(a.store, runId)).b?.status === "running");

    // Simulate a crash: stop without releasing the lease or resetting running steps.
    await a.engine.stop({ graceful: false });
    expect((await a.store.getRun(runId))!.leaseOwner).toBe("worker-a");

    const provider = new FakeProvider(echo);
    const b = await makeEngine(db, provider, { workerId: "worker-b" });
    await b.engine.sweep();
    expect(provider.calls).toHaveLength(0); // lease still live

    await Bun.sleep(350);
    await b.engine.sweep();
    await b.engine.whenSettled(runId);

    expect((await b.store.getRun(runId))!.status).toBe("succeeded");
    expect(provider.calls.map((c) => c.prompt)).toEqual(["step b a-out", "step c b-out"]);
    const taken = (await b.store.eventsAfter(runId, 0)).find((e) => e.type === "run.lease_taken")!;
    expect(taken.payload).toEqual({ workerId: "worker-b", previousOwner: "worker-a", resetSteps: ["b"] });
    // Step b keeps its attempt history across the crash.
    expect((await stepMap(b.store, runId)).b!.attempt).toBe(2);
  });

  test("a graceful stop hands the run over immediately", async () => {
    const db = await testDb();
    const a = await makeEngine(db, new FakeProvider(echo, { delayMs: (req) => (req.prompt.startsWith("step b") ? 10_000 : 1) }), {
      workerId: "worker-a",
      leaseTtlMs: 60_000,
    });
    a.engine.start();
    const { runId } = await a.engine.createRun({ graph: chain });
    await waitFor(async () => (await stepMap(a.store, runId)).b?.status === "running");

    await a.engine.stop();
    expect(await a.store.getRun(runId)).toMatchObject({ status: "running", leaseOwner: null });
    expect((await stepMap(a.store, runId)).b!.status).toBe("pending");

    const b = await makeEngine(db, new FakeProvider(echo), { workerId: "worker-b", leaseTtlMs: 60_000 });
    await b.engine.sweep();
    await b.engine.whenSettled(runId);
    expect((await b.store.getRun(runId))!.status).toBe("succeeded");
  });

  test("cancel aborts in-flight calls and skips unfinished steps", async () => {
    let aborted = false;
    const provider = new FakeProvider(async (req) => {
      await new Promise((_, reject) => req.signal.addEventListener("abort", () => ((aborted = true), reject(req.signal.reason))));
      return { text: "never" };
    });
    const { engine, store } = await makeEngine(await testDb(), provider);
    engine.start();
    const { runId } = await engine.createRun({ graph: chain });
    await waitFor(() => provider.calls.length === 1);

    await engine.cancel(runId);
    await engine.whenSettled(runId);

    expect(aborted).toBe(true);
    expect((await store.getRun(runId))!.status).toBe("cancelled");
    expect(Object.values(await stepMap(store, runId)).map((s) => [s.status, s.error])).toEqual([
      ["skipped", "cancelled"],
      ["skipped", "cancelled"],
      ["skipped", "cancelled"],
    ]);
    expect(await eventTypes(store, runId)).toContain("run.cancelled");
    await expect(engine.cancel(runId)).rejects.toThrow(ConflictError);
    await expect(engine.cancel("run_missing")).rejects.toThrow(NotFoundError);
  });

  test("a cancel written by another engine stops the owner", async () => {
    const db = await testDb();
    const provider = new FakeProvider(echo, { delayMs: 400 });
    const owner = await makeEngine(db, provider, { workerId: "owner" });
    owner.engine.start();
    const { runId } = await owner.engine.createRun({ graph: chain });
    await waitFor(() => provider.calls.length === 1);

    const other = await makeEngine(db, new FakeProvider(echo), { workerId: "other" });
    await other.engine.cancel(runId);

    await owner.engine.whenSettled(runId);
    expect((await owner.store.getRun(runId))!.status).toBe("cancelled");
    expect((await stepMap(owner.store, runId)).a!.status).toBe("skipped");
    expect(provider.calls).toHaveLength(1);
  });

  test("retry re-runs only failed and skipped steps", async () => {
    let failA = true;
    const provider = new FakeProvider((req, call) => {
      if (req.prompt.startsWith("step b") && failA) return new LlmError("bad", { status: 400 });
      return echo(req, call);
    });
    const { engine, store } = await makeEngine(await testDb(), provider);
    engine.start();
    const { runId } = await engine.createRun({ graph: chain });
    await engine.whenSettled(runId);
    expect((await store.getRun(runId))!.status).toBe("failed");
    expect((await stepMap(store, runId)).c!.status).toBe("skipped");

    failA = false;
    await engine.retry(runId);
    await engine.whenSettled(runId);

    expect(await store.getRun(runId)).toMatchObject({ status: "succeeded", error: null });
    expect(provider.callsMatching("step a")).toHaveLength(1);
    expect((await stepMap(store, runId)).b!.attempt).toBe(1);
    await expect(engine.retry(runId)).rejects.toThrow(ConflictError);
  });

  test("stops its scheduler when the heartbeat finds the lease gone", async () => {
    const db = await testDb();
    const provider = new FakeProvider(echo, { delayMs: 300 });
    const { engine, store } = await makeEngine(db, provider, { workerId: "w1", leaseTtlMs: 60_000 });
    engine.start();
    const { runId } = await engine.createRun({ graph: chain });
    await waitFor(() => provider.calls.length === 1);

    await db.query("UPDATE runs SET lease_owner = 'intruder' WHERE id = $1", [runId]);
    await engine.whenSettled(runId);

    expect((await stepMap(store, runId)).a!.status).toBe("running");
    expect(provider.calls).toHaveLength(1);
    expect((await store.getRun(runId))!.leaseOwner).toBe("intruder");
  });

  test("plans a goal run, then executes the planned graph", async () => {
    const plan = { steps: [{ id: "outline", prompt: "step outline for {{goal}}" }, { id: "draft", prompt: "step draft {{outline.output}}", final: true }] };
    const provider = new FakeProvider((req, call) => (req.jsonSchema ? { text: JSON.stringify(plan) } : echo(req, call)));
    const { engine, store } = await makeEngine(await testDb(), provider, { planner: new Planner(provider, { searchEnabled: false }) });
    engine.start();

    const { runId } = await engine.createRun({ goal: "write a launch post", profile: "general" });
    expect((await store.getRun(runId))!.status).toBe("planning");
    await engine.whenSettled(runId);

    const run = (await store.getRun(runId))!;
    expect(run).toMatchObject({ status: "succeeded", goal: "write a launch post", profile: "general", graphVersion: 1 });
    expect(provider.callsMatching("step outline")[0]!.prompt).toBe("step outline for write a launch post");
    expect((await stepMap(store, runId)).draft!.output).toBe("draft-out");
    expect((await eventTypes(store, runId)).slice(0, 2)).toEqual(["run.created", "run.planned"]);
    // Planning tokens count toward the run total.
    const stepTokens = (await store.getSteps(runId)).reduce((n, s) => n + s.inputTokens, 0);
    expect((await store.totals(runId)).inputTokens).toBeGreaterThan(stepTokens);
  });

  test("re-plans a failed branch and finishes the run", async () => {
    const plan = { steps: [{ id: "fragile", prompt: "step fragile" }, { id: "report", prompt: "step report {{fragile.output}}", final: true }] };
    const fix = { steps: [{ id: "sturdy", prompt: "step sturdy" }] };
    const provider = new FakeProvider((req, call) => {
      if (req.jsonSchema) return { text: JSON.stringify(req.prompt.includes("failed after all its retries") ? fix : plan) };
      if (req.prompt.startsWith("step fragile")) return new LlmError("model refused", { status: 400 });
      return echo(req, call);
    });
    const { engine, store } = await makeEngine(await testDb(), provider, { planner: new Planner(provider, { searchEnabled: false }) });
    engine.start();

    const { runId } = await engine.createRun({ goal: "a goal that needs a repair" });
    await engine.whenSettled(runId);

    const run = (await store.getRun(runId))!;
    expect(run).toMatchObject({ status: "succeeded", replans: 1, graphVersion: 2 });
    const steps = await stepMap(store, runId);
    expect(steps.fragile!.status).toBe("superseded");
    expect(steps.report!.status).toBe("superseded");
    expect(steps.sturdy!.status).toBe("succeeded");
    expect(steps.report_r2).toMatchObject({ status: "succeeded", resolvedPrompt: "step report sturdy-out" });
    const replanned = (await store.eventsAfter(runId, 0)).find((e) => e.type === "run.replanned")!;
    expect(replanned.payload).toMatchObject({ failedStepId: "fragile", graphVersion: 2, supersede: ["fragile", "report"], added: ["sturdy", "report_r2"] });
  });

  test("fails the run once re-plans run out", async () => {
    const plan = { steps: [{ id: "fragile", prompt: "step fragile" }] };
    const provider = new FakeProvider((req) => (req.jsonSchema ? { text: JSON.stringify(plan) } : new LlmError("no", { status: 400 })));
    const { engine, store } = await makeEngine(await testDb(), provider, { planner: new Planner(provider, { searchEnabled: false }) });
    engine.start();

    const { runId } = await engine.createRun({ goal: "never works", maxReplans: 0 });
    await engine.whenSettled(runId);
    expect(await store.getRun(runId)).toMatchObject({ status: "failed", replans: 0 });
  });

  test("marks the run failed when planning never produces a valid graph", async () => {
    const provider = new FakeProvider(() => ({ text: "not json" }));
    const { engine, store } = await makeEngine(await testDb(), provider, { planner: new Planner(provider, { searchEnabled: false }) });
    engine.start();

    const { runId } = await engine.createRun({ goal: "unplannable" });
    await engine.whenSettled(runId);

    expect(await store.getRun(runId)).toMatchObject({ status: "failed", error: "planning failed: no valid plan after 3 attempts", graph: null });
    const failed = (await store.eventsAfter(runId, 0)).find((e) => e.type === "run.failed")!;
    expect(failed.payload).toMatchObject({ issues: ["the reply was not valid JSON"] });
    expect((await store.totals(runId)).inputTokens).toBeGreaterThan(0);
  });

  test("goal runs need a planner", async () => {
    const { engine } = await makeEngine(await testDb(), new FakeProvider(echo));
    await expect(engine.createRun({ goal: "write a report" })).rejects.toThrow("planning is not configured");
  });
});
