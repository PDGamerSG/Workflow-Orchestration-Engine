/**
 * Shows crash recovery with two real engine processes sharing one SQLite file.
 *
 * 1. Worker A starts and runs a 6-step chain on the demo provider.
 * 2. After three steps finish, A is killed with no chance to clean up.
 * 3. Worker B starts, waits for A's lease to expire, takes the run over and finishes it.
 * 4. The script checks that no finished step ran twice.
 *
 * Run with `bun run demo:crash` from the server folder. It needs no API key.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dbPath = join(tmpdir(), `relay-crash-demo-${Date.now()}.db`);
const leaseTtlMs = 4_000;
const entry = join(import.meta.dir, "..", "src", "index.ts");

/**
 * Kills the worker listening on `port` with no chance to clean up.
 * It asks the worker for its own pid because bun's spawn on Windows returns a launcher pid,
 * and killing that leaves the runtime process alive.
 */
async function hardKill(port: number): Promise<void> {
  const { pid } = (await (await fetch(`http://localhost:${port}/health`)).json()) as { pid: number };
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/F"]);
  else process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 50; attempt++) {
    const alive = await fetch(`http://localhost:${port}/health`).then(
      () => true,
      () => false,
    );
    if (!alive) return;
    await Bun.sleep(100);
  }
  throw new Error(`worker on port ${port} is still answering after the kill`);
}

function startWorker(name: string, port: number): Subprocess {
  const proc = Bun.spawn(["bun", entry], {
    env: { ...process.env, LLM_PROVIDER: "demo", PORT: String(port), DATABASE_PATH: dbPath, LEASE_TTL_MS: String(leaseTtlMs) },
    stdout: "ignore",
    stderr: "inherit",
  });
  console.log(`[demo] started worker ${name} (pid ${proc.pid}) on port ${port}`);
  return proc;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

type Snapshot = { run: { status: string; leaseOwner: string | null }; steps: { stepId: string; status: string; attempt: number }[] };
const getRun = async (port: number, runId: string) => (await fetch(`http://localhost:${port}/runs/${runId}`)).json() as Promise<Snapshot>;

const chain = Array.from({ length: 6 }, (_, i) => ({
  id: `step_${i + 1}`,
  prompt: i === 0 ? "Write an opening line." : `Continue from: {{step_${i}.output}}`,
}));

startWorker("A", 4101);
await waitFor("worker A", async () => ((await fetch("http://localhost:4101/health")).ok ? true : null));

const { runId } = (await (
  await fetch("http://localhost:4101/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ graph: { steps: chain }, concurrency: 1 }),
  })
).json()) as { runId: string };
console.log(`[demo] submitted ${runId} with ${chain.length} steps in a chain`);

// Kill A mid-step, so the takeover has an unfinished step to restart.
const beforeCrash = await waitFor("three finished steps and one in flight", async () => {
  const snap = await getRun(4101, runId);
  const finished = snap.steps.filter((s) => s.status === "succeeded").length;
  return finished >= 3 && snap.steps.some((s) => s.status === "running") ? snap : null;
});
await hardKill(4101);
const finishedBeforeCrash = beforeCrash.steps.filter((s) => s.status === "succeeded").map((s) => s.stepId);
console.log(`[demo] killed worker A after ${finishedBeforeCrash.join(", ")} finished`);

startWorker("B", 4102);
await waitFor("worker B", async () => ((await fetch("http://localhost:4102/health")).ok ? true : null));
console.log(`[demo] worker B waits for A's ${leaseTtlMs / 1_000} s lease to expire, then takes over`);

const tookOverAt = Date.now();
const final = await waitFor("the run to finish on worker B", async () => {
  const snap = await getRun(4102, runId);
  return snap.run.status === "succeeded" || snap.run.status === "failed" ? snap : null;
});
console.log(`[demo] run ${final.run.status} ${((Date.now() - tookOverAt) / 1_000).toFixed(1)} s after worker B started`);

// Every step.succeeded event, per step, from the shared database.
const events = await new Promise<{ type: string; payload: Record<string, unknown> }[]>((resolve) => {
  const collected: { type: string; payload: Record<string, unknown> }[] = [];
  const controller = new AbortController();
  fetch(`http://localhost:4102/runs/${runId}/events`, { signal: controller.signal }).then(async (res) => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const frame of buffer.split("\n\n").slice(0, -1)) {
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) collected.push(JSON.parse(data.slice(6)));
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      if (collected.some((e) => e.type === "run.succeeded" || e.type === "run.failed")) {
        controller.abort();
        resolve(collected);
        return;
      }
    }
    resolve(collected);
  });
});

const successes = new Map<string, number>();
for (const e of events.filter((e) => e.type === "step.succeeded")) {
  const id = e.payload.stepId as string;
  successes.set(id, (successes.get(id) ?? 0) + 1);
}
const takeover = events.find((e) => e.type === "run.lease_taken");
const repeated = [...successes].filter(([, n]) => n > 1);

console.log("");
console.log(`finished before the crash: ${finishedBeforeCrash.join(", ")}`);
console.log(`restarted by worker B:      ${(takeover?.payload.resetSteps as string[] | undefined)?.join(", ") || "(none in flight)"}`);
console.log(`steps finished twice:       ${repeated.length ? repeated.map(([id]) => id).join(", ") : "none"}`);
console.log(`final attempts per step:    ${final.steps.map((s) => `${s.stepId}=${s.attempt}`).join(" ")}`);

await hardKill(4102);
// Windows releases the file a moment after the process exits.
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    break;
  } catch {
    await Bun.sleep(200);
  }
}

if (final.run.status !== "succeeded" || repeated.length || !takeover) {
  console.error("[demo] recovery check failed");
  process.exit(1);
}
console.log("[demo] recovery check passed");
