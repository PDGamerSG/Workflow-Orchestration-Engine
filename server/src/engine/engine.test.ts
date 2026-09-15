import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, type FakeHandler } from "../llm/fake";
import { LlmError } from "../llm/provider";
import { eventTypes, stepMap } from "../test/helpers";
import { Engine, type EngineOptions } from "./engine";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { Store } from "./store";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempDbPath() {
  const path = join(tmpdir(), `relay-engine-${crypto.randomUUID()}.db`);
  cleanup.push(() => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  });
  return path;
}

const pricing = { inputPerM: 0, outputPerM: 0, searchPerK: 0 };
const echo: FakeHandler = (req) => ({ text: `${req.prompt.match(/^step (\w+)/)?.[1]}-out` });

function makeEngine(path: string, provider: FakeProvider, opts: Partial<EngineOptions> = {}) {
  const store = new Store(path);
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
    store.close();
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

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("Engine", () => {
  test("runs a submitted graph to completion", async () => {
    const { engine, store } = makeEngine(tempDbPath(), new FakeProvider(echo));
    engine.start();
    const { runId } = engine.createRun({ graph: chain, concurrency: 2 });

    await engine.whenSettled(runId);

    expect(store.getRun(runId)).toMatchObject({ status: "succeeded", concurrency: 2, leaseOwner: null });
    expect(stepMap(store, runId).c!.output).toBe("c-out");
    expect(eventTypes(store, runId)[0]).toBe("run.created");
  });

  test("rejects an invalid graph with every issue", () => {
    const { engine } = makeEngine(tempDbPath(), new FakeProvider(echo));
    try {
      engine.createRun({ graph: { steps: [{ id: "a", prompt: "{{b.output}}" }, { id: "a", prompt: "x" }] } });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues).toEqual(['duplicate step id "a"', 'step "a" references unknown step "b"']);
    }
    expect(() => engine.createRun({ concurrency: 3 })).toThrow(ValidationError);
    expect(() => engine.createRun({ graph: chain, concurrency: 99 })).toThrow(ValidationError);
  });

  test("another engine resumes a crashed run without re-running finished steps", async () => {
    const path = tempDbPath();
    const slowB = new FakeProvider(echo, { delayMs: (req) => (req.prompt.startsWith("step b") ? 10_000 : 1) });
    const a = makeEngine(path, slowB, { workerId: "worker-a" });
    a.engine.start();
    const { runId } = a.engine.createRun({ graph: chain });
    await waitFor(() => stepMap(a.store, runId).b?.status === "running");

    // Simulate a crash: stop without releasing the lease or resetting running steps.
    await a.engine.stop({ graceful: false });
    expect(a.store.getRun(runId)!.leaseOwner).toBe("worker-a");

    const provider = new FakeProvider(echo);
    const b = makeEngine(path, provider, { workerId: "worker-b" });
    b.engine.sweep();
    expect(provider.calls).toHaveLength(0); // lease still live

    await Bun.sleep(350);
    b.engine.sweep();
    await b.engine.whenSettled(runId);

    expect(b.store.getRun(runId)!.status).toBe("succeeded");
    expect(provider.calls.map((c) => c.prompt)).toEqual(["step b a-out", "step c b-out"]);
    const taken = b.store.eventsAfter(runId, 0).find((e) => e.type === "run.lease_taken")!;
    expect(taken.payload).toEqual({ workerId: "worker-b", previousOwner: "worker-a", resetSteps: ["b"] });
    // Step b keeps its attempt history across the crash.
    expect(stepMap(b.store, runId).b!.attempt).toBe(2);
  });

  test("a graceful stop hands the run over immediately", async () => {
    const path = tempDbPath();
    const a = makeEngine(path, new FakeProvider(echo, { delayMs: (req) => (req.prompt.startsWith("step b") ? 10_000 : 1) }), {
      workerId: "worker-a",
      leaseTtlMs: 60_000,
    });
    a.engine.start();
    const { runId } = a.engine.createRun({ graph: chain });
    await waitFor(() => stepMap(a.store, runId).b?.status === "running");

    await a.engine.stop();
    expect(a.store.getRun(runId)).toMatchObject({ status: "running", leaseOwner: null });
    expect(stepMap(a.store, runId).b!.status).toBe("pending");

    const b = makeEngine(path, new FakeProvider(echo), { workerId: "worker-b", leaseTtlMs: 60_000 });
    b.engine.sweep();
    await b.engine.whenSettled(runId);
    expect(b.store.getRun(runId)!.status).toBe("succeeded");
  });

  test("cancel aborts in-flight calls and skips unfinished steps", async () => {
    let aborted = false;
    const provider = new FakeProvider(async (req) => {
      await new Promise((_, reject) => req.signal.addEventListener("abort", () => ((aborted = true), reject(req.signal.reason))));
      return { text: "never" };
    });
    const { engine, store } = makeEngine(tempDbPath(), provider);
    engine.start();
    const { runId } = engine.createRun({ graph: chain });
    await waitFor(() => provider.calls.length === 1);

    engine.cancel(runId);
    await engine.whenSettled(runId);

    expect(aborted).toBe(true);
    expect(store.getRun(runId)!.status).toBe("cancelled");
    expect(Object.values(stepMap(store, runId)).map((s) => [s.status, s.error])).toEqual([
      ["skipped", "cancelled"],
      ["skipped", "cancelled"],
      ["skipped", "cancelled"],
    ]);
    expect(eventTypes(store, runId)).toContain("run.cancelled");
    expect(() => engine.cancel(runId)).toThrow(ConflictError);
    expect(() => engine.cancel("run_missing")).toThrow(NotFoundError);
  });

  test("a cancel written by another engine stops the owner", async () => {
    const path = tempDbPath();
    const provider = new FakeProvider(echo, { delayMs: 400 });
    const owner = makeEngine(path, provider, { workerId: "owner" });
    owner.engine.start();
    const { runId } = owner.engine.createRun({ graph: chain });
    await waitFor(() => provider.calls.length === 1);

    const other = makeEngine(path, new FakeProvider(echo), { workerId: "other" });
    other.engine.cancel(runId);

    await owner.engine.whenSettled(runId);
    expect(owner.store.getRun(runId)!.status).toBe("cancelled");
    expect(stepMap(owner.store, runId).a!.status).toBe("skipped");
    expect(provider.calls).toHaveLength(1);
  });

  test("retry re-runs only failed and skipped steps", async () => {
    let failA = true;
    const provider = new FakeProvider((req, call) => {
      if (req.prompt.startsWith("step b") && failA) return new LlmError("bad", { status: 400 });
      return echo(req, call);
    });
    const { engine, store } = makeEngine(tempDbPath(), provider);
    engine.start();
    const { runId } = engine.createRun({ graph: chain });
    await engine.whenSettled(runId);
    expect(store.getRun(runId)!.status).toBe("failed");
    expect(stepMap(store, runId).c!.status).toBe("skipped");

    failA = false;
    engine.retry(runId);
    await engine.whenSettled(runId);

    expect(store.getRun(runId)).toMatchObject({ status: "succeeded", error: null });
    expect(provider.callsMatching("step a")).toHaveLength(1);
    expect(stepMap(store, runId).b!.attempt).toBe(1);
    expect(() => engine.retry(runId)).toThrow(ConflictError);
  });

  test("stops its scheduler when the heartbeat finds the lease gone", async () => {
    const path = tempDbPath();
    const provider = new FakeProvider(echo, { delayMs: 300 });
    const { engine, store } = makeEngine(path, provider, { workerId: "w1", leaseTtlMs: 60_000 });
    engine.start();
    const { runId } = engine.createRun({ graph: chain });
    await waitFor(() => provider.calls.length === 1);

    store.db.run("UPDATE runs SET lease_owner = 'intruder' WHERE id = ?", [runId]);
    await engine.whenSettled(runId);

    expect(stepMap(store, runId).a!.status).toBe("running");
    expect(provider.calls).toHaveLength(1);
    expect(store.getRun(runId)!.leaseOwner).toBe("intruder");
  });

  test("goal runs need a planner", () => {
    const { engine } = makeEngine(tempDbPath(), new FakeProvider(echo));
    expect(() => engine.createRun({ goal: "write a report" })).toThrow("planning is not configured");
  });
});
