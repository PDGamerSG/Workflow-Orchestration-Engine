/**
 * Measures scheduling on simulated model latency, with no API key and no network.
 *
 * 1. Concurrency sweep: a 12-step research-shaped graph at 1, 2, 4 and 8 steps at once.
 * 2. Scheduler comparison: the same mixed-latency graph run level by level (how the first
 *    prototype worked) and with Relay's scheduler, which starts each step as soon as its inputs are ready.
 *
 * Writes docs/benchmark.md. Run with `bun run bench` from the server folder.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { Store } from "../src/engine/store";
import type { StepDef } from "../src/engine/types";
import { FakeProvider } from "../src/llm/fake";

/** Deterministic latency per step id, so every configuration sees the same workload. */
function latencyFor(id: string, table: Record<string, number>): number {
  return table[id] ?? 1_000;
}

async function runGraph(steps: StepDef[], latency: Record<string, number>, concurrency: number): Promise<number> {
  const store = new Store(":memory:");
  const provider = new FakeProvider((req) => ({ text: `done: ${req.prompt.slice(0, 20)}` }), {
    delayMs: (req) => latencyFor(req.prompt.split(" ")[0]!, latency),
  });
  const engine = new Engine({ store, provider, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, rpm: 1_000_000 });
  const started = performance.now();
  const { runId } = engine.createRun({ graph: { steps }, concurrency });
  await engine.whenSettled(runId);
  const elapsed = performance.now() - started;
  const status = store.getRun(runId)!.status;
  await engine.stop();
  store.close();
  if (status !== "succeeded") throw new Error(`benchmark run ended ${status}`);
  return elapsed;
}

/** The first prototype's algorithm: run every ready step, wait for all of them, repeat. */
async function runLevelByLevel(steps: StepDef[], latency: Record<string, number>): Promise<number> {
  const started = performance.now();
  const done = new Set<string>();
  while (done.size < steps.length) {
    const level = steps.filter((s) => !done.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d)));
    await Promise.all(level.map((s) => Bun.sleep(latencyFor(s.id, latency))));
    for (const s of level) done.add(s.id);
  }
  return performance.now() - started;
}

const seconds = (ms: number) => `${(ms / 1_000).toFixed(2)} s`;

// 1. Research-shaped graph: 10 researchers, a fact check that reads all of them, and a writer.
const researchers = Array.from({ length: 10 }, (_, i) => `research_${i + 1}`);
const researchGraph: StepDef[] = [
  ...researchers.map((id) => ({ id, prompt: `${id} investigate one sub-question` })),
  { id: "verify", prompt: "verify check the findings", dependsOn: researchers },
  { id: "write", prompt: "write the report", dependsOn: ["verify"], final: true },
];
const researchLatency: Record<string, number> = {
  ...Object.fromEntries(researchers.map((id, i) => [id, 600 + ((i * 137) % 500)])),
  verify: 900,
  write: 1_200,
};
const sequentialEstimate = Object.values(researchLatency).reduce((a, b) => a + b, 0);

console.log("Concurrency sweep on a 12-step research graph");
const sweep: { concurrency: number; ms: number }[] = [];
for (const concurrency of [1, 2, 4, 8]) {
  const ms = await runGraph(researchGraph, researchLatency, concurrency);
  sweep.push({ concurrency, ms });
  console.log(`  ${concurrency} at once: ${seconds(ms)}`);
}

// 2. Two independent branches with very different speeds.
const mixedGraph: StepDef[] = [
  { id: "slow_fetch", prompt: "slow_fetch one long call" },
  { id: "slow_summary", prompt: "slow_summary of the fetch", dependsOn: ["slow_fetch"] },
  { id: "quick_1", prompt: "quick_1 short call" },
  { id: "quick_2", prompt: "quick_2 short call", dependsOn: ["quick_1"] },
  { id: "quick_3", prompt: "quick_3 short call", dependsOn: ["quick_2"] },
  { id: "quick_4", prompt: "quick_4 short call", dependsOn: ["quick_3"] },
  { id: "merge", prompt: "merge both branches", dependsOn: ["slow_summary", "quick_4"], final: true },
];
const mixedLatency: Record<string, number> = {
  slow_fetch: 3_000,
  slow_summary: 400,
  quick_1: 400,
  quick_2: 400,
  quick_3: 400,
  quick_4: 400,
  merge: 400,
};

console.log("Level by level vs Relay's scheduler on a mixed-latency graph");
const levelMs = await runLevelByLevel(mixedGraph, mixedLatency);
const relayMs = await runGraph(mixedGraph, mixedLatency, 8);
console.log(`  level by level: ${seconds(levelMs)}`);
console.log(`  relay: ${seconds(relayMs)}`);

const report = `# Benchmark

Simulated model latency, no network. Regenerate with \`bun run bench\` in \`server/\`. Each step's latency is fixed per step id, so every configuration runs the same workload. Timings include engine overhead: SQLite writes, events and scheduling.

## Concurrency sweep

A 12-step research graph: 10 independent researchers (600 to 1,100 ms each), a fact check that reads all of them (900 ms), and a writer (1,200 ms). Running every call one after another takes ${seconds(sequentialEstimate)} of model time.

| Steps at once | Wall time | Speedup |
|---|---|---|
${sweep.map((r) => `| ${r.concurrency} | ${seconds(r.ms)} | ${(sweep[0]!.ms / r.ms).toFixed(1)}x |`).join("\n")}

The floor is the longest dependency chain: the slowest researcher, then the fact check, then the writer.

## Level by level against Relay's scheduler

Two independent branches: a slow fetch (3,000 ms) followed by a summary (400 ms), and four quick steps (400 ms each) in a chain. A final step merges both.

| Scheduler | Wall time |
|---|---|
| Level by level (the first prototype) | ${seconds(levelMs)} |
| Relay | ${seconds(relayMs)} |

Level by level waits for every step in a level before starting the next level, so the quick chain stalls behind the slow fetch. Relay starts a step the moment its own inputs finish, so the run takes as long as its longest path.
`;

const out = join(import.meta.dir, "..", "..", "docs", "benchmark.md");
writeFileSync(out, report);
console.log(`wrote ${out}`);
