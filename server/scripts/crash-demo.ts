/**
 * Shows crash recovery with two engines sharing one database, the way two serverless
 * function instances share Neon.
 *
 * 1. Worker A runs a 6-step chain on the demo provider.
 * 2. After three steps finish, A stops with no chance to clean up, as a function does when it
 *    hits its time limit: its lease stays in place and its in-flight step stays "running".
 * 3. Worker B sweeps, waits for A's lease to expire, takes the run over and finishes it.
 * 4. The script checks that no finished step ran twice.
 *
 * Run with `bun run demo:crash` from the server folder. It needs no API key and no database.
 */
import { openPglite } from "../src/engine/db";
import { Engine } from "../src/engine/engine";
import { Store } from "../src/engine/store";
import { createDemoProvider } from "../src/llm/demo";

const leaseTtlMs = 4_000;
const db = await openPglite();

async function startWorker(name: string): Promise<{ engine: Engine; store: Store }> {
  const store = await Store.open(db);
  const engine = new Engine({
    store,
    provider: createDemoProvider(),
    pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 },
    rpm: 60_000,
    workerId: `worker-${name}`,
    leaseTtlMs,
    heartbeatMs: Math.floor(leaseTtlMs / 3),
  });
  console.log(`[demo] started worker ${name}`);
  return { engine, store };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

const chain = Array.from({ length: 6 }, (_, i) => ({
  id: `step_${i + 1}`,
  prompt: i === 0 ? "Write an opening line." : `Continue from: {{step_${i}.output}}`,
}));

const a = await startWorker("A");
const { runId } = await a.engine.createRun({ graph: { steps: chain }, concurrency: 1 });
console.log(`[demo] submitted ${runId} with ${chain.length} steps in a chain`);

// Stop A mid-step, so the takeover has an unfinished step to restart.
const finishedBeforeCrash = await waitFor("three finished steps and one in flight", async () => {
  const steps = await a.store.getSteps(runId);
  const finished = steps.filter((s) => s.status === "succeeded").map((s) => s.stepId);
  return finished.length >= 3 && steps.some((s) => s.status === "running") ? finished : null;
});
await a.engine.stop({ graceful: false });
console.log(`[demo] worker A died after ${finishedBeforeCrash.join(", ")} finished`);

const b = await startWorker("B");
console.log(`[demo] worker B waits for A's ${leaseTtlMs / 1_000} s lease to expire, then takes over`);
const tookOverAt = Date.now();
const final = await waitFor("the run to finish on worker B", async () => {
  await b.engine.sweep();
  const run = await b.store.getRun(runId);
  return run && (run.status === "succeeded" || run.status === "failed") ? run : null;
});
console.log(`[demo] run ${final.status} ${((Date.now() - tookOverAt) / 1_000).toFixed(1)} s after worker B started`);

const events = await b.store.eventsAfter(runId, 0, 10_000);
const successes = new Map<string, number>();
for (const e of events.filter((e) => e.type === "step.succeeded")) {
  const id = (e.payload as { stepId: string }).stepId;
  successes.set(id, (successes.get(id) ?? 0) + 1);
}
const takeover = events.find((e) => e.type === "run.lease_taken")?.payload as { resetSteps: string[] } | undefined;
const repeated = [...successes].filter(([, n]) => n > 1);
const steps = await b.store.getSteps(runId);

console.log("");
console.log(`finished before the crash: ${finishedBeforeCrash.join(", ")}`);
console.log(`restarted by worker B:      ${takeover?.resetSteps.join(", ") || "(none in flight)"}`);
console.log(`steps finished twice:       ${repeated.length ? repeated.map(([id]) => id).join(", ") : "none"}`);
console.log(`final attempts per step:    ${steps.map((s) => `${s.stepId}=${s.attempt}`).join(" ")}`);

await b.engine.stop();
await db.close();

if (final.status !== "succeeded" || repeated.length || !takeover) {
  console.error("[demo] recovery check failed");
  process.exit(1);
}
console.log("[demo] recovery check passed");
