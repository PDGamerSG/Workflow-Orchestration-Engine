import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeProvider, type FakeHandler } from "../llm/fake";
import { LlmError } from "../llm/provider";
import { drive, eventTypes, makeGraph, setupRun, stepMap } from "../test/helpers";
import { ManualClock, realClock } from "./clock";
import { EventBus } from "./events";
import { TokenBucket } from "./rate-limiter";
import { RunScheduler, type FailureHook, type SchedulerDeps } from "./scheduler";
import { Store } from "./store";
import type { Clock } from "./types";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

const pricing = { inputPerM: 1_000_000, outputPerM: 1_000_000, searchPerK: 0 }; // $1 per token keeps sums readable

function deps(provider: FakeProvider, clock: Clock = realClock, extra: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    store,
    provider,
    clock,
    limiter: new TokenBucket({ capacity: 1_000, refillPerSec: 1_000, clock }),
    bus: new EventBus(),
    workerId: "w1",
    pricing,
    random: () => 0,
    ...extra,
  };
}

/** Replies `<id>-out` where the prompt starts with "step <id>". */
const echo: FakeHandler = (req) => ({ text: `${req.prompt.match(/^step (\w+)/)?.[1]}-out` });

describe("RunScheduler", () => {
  test("passes dependency output into the dependent prompt", async () => {
    const graph = makeGraph({
      steps: [
        { id: "a", prompt: "step a" },
        { id: "b", prompt: "step b uses {{a.output}}" },
      ],
    });
    const runId = setupRun(store, graph);
    const provider = new FakeProvider(echo);

    const result = await new RunScheduler(runId, deps(provider)).run(new AbortController().signal);

    expect(result).toBe("succeeded");
    expect(provider.calls[1]!.prompt).toBe("step b uses a-out");
    const steps = stepMap(store, runId);
    expect(steps.b).toMatchObject({ status: "succeeded", output: "b-out", attempt: 1, resolvedPrompt: "step b uses a-out" });
    expect(store.getRun(runId)!.status).toBe("succeeded");
    expect(eventTypes(store, runId)).toEqual([
      "step.started",
      "step.succeeded",
      "step.started",
      "step.succeeded",
      "run.succeeded",
    ]);
  });

  test("never runs more steps at once than the run's concurrency", async () => {
    const graph = makeGraph({ steps: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, prompt: `step s${i}` })) });
    const runId = setupRun(store, graph, { concurrency: 2 });
    const provider = new FakeProvider(echo, { delayMs: 15 });

    expect(await new RunScheduler(runId, deps(provider)).run(new AbortController().signal)).toBe("succeeded");
    expect(provider.calls).toHaveLength(6);
    expect(provider.maxActive).toBe(2);
  });

  test("a slow step does not hold back an unrelated branch", async () => {
    const graph = makeGraph({
      steps: [
        { id: "slow", prompt: "step slow" },
        { id: "fast", prompt: "step fast" },
        { id: "after_fast", prompt: "step after_fast {{fast.output}}" },
      ],
    });
    const runId = setupRun(store, graph);
    const finished: string[] = [];
    const provider = new FakeProvider(
      (req, call) => {
        const reply = echo(req, call) as { text: string };
        finished.push(reply.text);
        return reply;
      },
      { delayMs: (req) => (req.prompt.includes("slow") ? 200 : 5) },
    );

    expect(await new RunScheduler(runId, deps(provider)).run(new AbortController().signal)).toBe("succeeded");
    expect(finished).toEqual(["fast-out", "after_fast-out", "slow-out"]);
  });

  test("retries a retryable error with backoff and records every attempt", async () => {
    const clock = new ManualClock();
    const runId = setupRun(store, makeGraph({ steps: [{ id: "a", prompt: "step a" }] }));
    const provider = new FakeProvider((req, call) => (call === 0 ? new LlmError("unavailable", { status: 503 }) : echo(req, call)), { clock });

    const result = await drive(new RunScheduler(runId, deps(provider, clock)).run(new AbortController().signal), clock);

    expect(result).toBe("succeeded");
    expect(provider.calls).toHaveLength(2);
    expect(stepMap(store, runId).a).toMatchObject({ status: "succeeded", attempt: 2, error: null });
    const retrying = store.eventsAfter(runId, 0).find((e) => e.type === "step.retrying")!;
    expect(retrying.payload).toMatchObject({ stepId: "a", attempt: 1, error: "HTTP 503: unavailable", delayMs: 500 });
  });

  test("uses retry-after from a rate limit response", async () => {
    const clock = new ManualClock();
    const runId = setupRun(store, makeGraph({ steps: [{ id: "a", prompt: "step a" }] }));
    const provider = new FakeProvider((req, call) =>
      call === 0 ? new LlmError("quota", { status: 429, retryAfterMs: 12_000 }) : echo(req, call),
    );

    const running = new RunScheduler(runId, deps(provider, clock)).run(new AbortController().signal);
    await clock.advance(11_000);
    expect(provider.calls).toHaveLength(1);
    expect(await drive(running, clock)).toBe("succeeded");
  });

  test("a failed step skips its descendants and leaves other branches running", async () => {
    const graph = makeGraph({
      steps: [
        { id: "a", prompt: "step a" },
        { id: "b", prompt: "step b {{a.output}}" },
        { id: "c", prompt: "step c {{b.output}}" },
        { id: "d", prompt: "step d" },
      ],
    });
    const runId = setupRun(store, graph);
    const provider = new FakeProvider((req, call) =>
      req.prompt === "step a" ? new LlmError("bad request", { status: 400 }) : echo(req, call),
    );

    expect(await new RunScheduler(runId, deps(provider)).run(new AbortController().signal)).toBe("failed");

    const steps = stepMap(store, runId);
    expect(steps.a).toMatchObject({ status: "failed", error: "HTTP 400: bad request", attempt: 1 });
    expect(steps.b).toMatchObject({ status: "skipped", error: 'upstream step "a" failed' });
    expect(steps.c!.status).toBe("skipped");
    expect(steps.d!.status).toBe("succeeded");
    expect(store.getRun(runId)).toMatchObject({ status: "failed", error: 'step "a" failed: HTTP 400: bad request' });
  });

  test("gives up after the step's retry limit", async () => {
    const clock = new ManualClock();
    const runId = setupRun(store, makeGraph({ steps: [{ id: "a", prompt: "step a", retries: 2 }] }));
    const provider = new FakeProvider(() => new LlmError("down", { status: 500 }));

    expect(await drive(new RunScheduler(runId, deps(provider, clock)).run(new AbortController().signal), clock)).toBe("failed");
    expect(provider.calls).toHaveLength(3);
    expect(stepMap(store, runId).a).toMatchObject({ status: "failed", attempt: 3 });
  });

  test("times out a slow attempt", async () => {
    const clock = new ManualClock();
    const runId = setupRun(store, makeGraph({ steps: [{ id: "a", prompt: "step a", retries: 0, timeoutMs: 1_000 }] }));
    const provider = new FakeProvider(echo, { delayMs: 5_000, clock });

    expect(await drive(new RunScheduler(runId, deps(provider, clock)).run(new AbortController().signal), clock)).toBe("failed");
    expect(stepMap(store, runId).a).toMatchObject({ status: "failed", error: "timed out" });
  });

  test("re-prompts when JSON output does not match the schema", async () => {
    const clock = new ManualClock();
    const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    const runId = setupRun(
      store,
      makeGraph({
        steps: [
          { id: "a", prompt: "step a", output: { type: "json", schema } },
          { id: "b", prompt: "step b got {{a.output.n}}" },
        ],
      }),
    );
    const replies = ["not json", '{"n":"seven"}', '{"n":7}'];
    const provider = new FakeProvider((req, call) =>
      req.prompt.startsWith("step a") ? { text: replies.shift()! } : echo(req, call),
    );

    expect(await drive(new RunScheduler(runId, deps(provider, clock)).run(new AbortController().signal), clock)).toBe("succeeded");

    const aCalls = provider.callsMatching("step a");
    expect(aCalls).toHaveLength(3);
    expect(aCalls[0]!.jsonSchema).toEqual(schema);
    expect(aCalls[1]!.prompt).toContain("was rejected: not valid JSON");
    expect(aCalls[2]!.prompt).toContain("/n must be number");
    expect(provider.callsMatching("step b")[0]!.prompt).toBe("step b got 7");
    // Tokens from the rejected attempts still count.
    expect(stepMap(store, runId).a!.outputTokens).toBe("not json".length + '{"n":"seven"}'.length + '{"n":7}'.length);
  });

  test("a template error fails the step without retrying", async () => {
    const runId = setupRun(
      store,
      makeGraph({
        steps: [
          { id: "a", prompt: "step a" },
          { id: "b", prompt: "step b {{a.output.missing}}" },
        ],
      }),
    );
    const provider = new FakeProvider(echo);

    expect(await new RunScheduler(runId, deps(provider)).run(new AbortController().signal)).toBe("failed");
    expect(provider.calls).toHaveLength(1);
    expect(stepMap(store, runId).b!.error).toContain("not JSON");
  });

  test("abort stops launching and writes no results", async () => {
    const clock = new ManualClock();
    const graph = makeGraph({
      steps: [
        { id: "a", prompt: "step a" },
        { id: "b", prompt: "step b" },
        { id: "c", prompt: "step c {{a.output}}" },
      ],
    });
    const runId = setupRun(store, graph);
    const provider = new FakeProvider(echo, { delayMs: 1_000, clock });
    const controller = new AbortController();

    const running = new RunScheduler(runId, deps(provider, clock)).run(controller.signal);
    await clock.advance(500);
    controller.abort(new Error("stop"));

    expect(await running).toBe("aborted");
    const steps = stepMap(store, runId);
    expect(steps.a!.status).toBe("running");
    expect(steps.b!.status).toBe("running");
    expect(steps.c!.status).toBe("pending");
    expect(store.getRun(runId)!.status).toBe("running");
  });

  test("reuses cached output for an identical cacheable step", async () => {
    const graph = makeGraph({ steps: [{ id: "a", prompt: "step a", cache: true }] });
    const provider = new FakeProvider(echo);

    const first = setupRun(store, graph);
    await new RunScheduler(first, deps(provider)).run(new AbortController().signal);
    const second = setupRun(store, graph);
    expect(await new RunScheduler(second, deps(provider)).run(new AbortController().signal)).toBe("succeeded");

    expect(provider.calls).toHaveLength(1);
    expect(stepMap(store, second).a).toMatchObject({ status: "succeeded", output: "a-out", cached: true, costUsd: 0 });
    expect(stepMap(store, first).a!.cached).toBe(false);
  });

  test("stops launching steps once the token budget is spent", async () => {
    const graph = makeGraph({
      steps: [
        { id: "a", prompt: "step a" },
        { id: "b", prompt: "step b {{a.output}}" },
        { id: "c", prompt: "step c {{b.output}}" },
      ],
    });
    const runId = setupRun(store, graph, { budgetTokens: 10 });
    const provider = new FakeProvider(echo);

    expect(await new RunScheduler(runId, deps(provider)).run(new AbortController().signal)).toBe("failed");

    expect(provider.calls).toHaveLength(1);
    const steps = stepMap(store, runId);
    expect(steps.b).toMatchObject({ status: "skipped", error: "budget exceeded" });
    expect(store.getRun(runId)).toMatchObject({ status: "failed", error: "budget exceeded" });
    expect(eventTypes(store, runId)).toContain("run.budget_exceeded");
  });

  test("records cost from usage and pricing", async () => {
    const runId = setupRun(store, makeGraph({ steps: [{ id: "a", prompt: "step a" }] }));
    const provider = new FakeProvider(() => ({ text: "x", usage: { inputTokens: 3, outputTokens: 2, searchCalls: 0 } }));
    await new RunScheduler(runId, deps(provider)).run(new AbortController().signal);
    expect(stepMap(store, runId).a).toMatchObject({ inputTokens: 3, outputTokens: 2, costUsd: 5 });
    const done = store.eventsAfter(runId, 0).find((e) => e.type === "run.succeeded")!;
    expect(done.payload).toMatchObject({ totals: { inputTokens: 3, outputTokens: 2, costUsd: 5 } });
  });

  test("returns lost and stops writing when another worker takes the lease", async () => {
    const clock = new ManualClock();
    const runId = setupRun(store, makeGraph({ steps: [{ id: "a", prompt: "step a" }, { id: "b", prompt: "step b {{a.output}}" }] }));
    const provider = new FakeProvider(echo, { delayMs: 1_000, clock });

    const running = new RunScheduler(runId, deps(provider, clock)).run(new AbortController().signal);
    await clock.advance(100);
    store.releaseRun(runId, "w1");
    store.claimRun(runId, "w2", clock.now(), 30_000);

    expect(await drive(running, clock)).toBe("lost");
    expect(stepMap(store, runId).a!.status).toBe("running");
    expect(provider.calls).toHaveLength(1);
  });

  test("resumes a run that already has succeeded steps without calling them again", async () => {
    const graph = makeGraph({ steps: [{ id: "a", prompt: "step a" }, { id: "b", prompt: "step b {{a.output}}" }] });
    const runId = setupRun(store, graph);
    store.updateStep(runId, "a", { status: "succeeded", output: "saved", attempt: 1 });
    const provider = new FakeProvider(echo);

    expect(await new RunScheduler(runId, deps(provider)).run(new AbortController().signal)).toBe("succeeded");
    expect(provider.calls.map((c) => c.prompt)).toEqual(["step b saved"]);
  });

  test("continues with the new graph when the failure hook replaces the branch", async () => {
    const graph = makeGraph({ steps: [{ id: "a", prompt: "step a" }, { id: "b", prompt: "step b {{a.output}}" }] });
    const runId = setupRun(store, graph);
    const provider = new FakeProvider((req, call) => (req.prompt.startsWith("step b ") ? new LlmError("no", { status: 400 }) : echo(req, call)));

    const hook: FailureHook = async (stepId) => {
      expect(stepId).toBe("b");
      const next = makeGraph({ steps: [{ id: "a", prompt: "step a" }, { id: "b2", prompt: "step b2 {{a.output}}" }] });
      store.installGraph(runId, next, 2, ["b"], 0, "w1");
      return true;
    };

    expect(await new RunScheduler(runId, deps(provider), { onStepFailed: hook }).run(new AbortController().signal)).toBe("succeeded");
    const steps = stepMap(store, runId);
    expect(steps.b!.status).toBe("superseded");
    expect(steps.b2).toMatchObject({ status: "succeeded", output: "b2-out" });
  });

  test("waits for the shared rate limiter before each call", async () => {
    const clock = new ManualClock();
    const runId = setupRun(store, makeGraph({ steps: ["a", "b", "c"].map((id) => ({ id, prompt: `step ${id}` })) }));
    const provider = new FakeProvider(echo);
    const limiter = new TokenBucket({ capacity: 1, refillPerSec: 1, clock });

    const running = new RunScheduler(runId, deps(provider, clock, { limiter })).run(new AbortController().signal);
    await clock.advance(0);
    expect(provider.calls).toHaveLength(1);
    await clock.advance(1_000);
    expect(provider.calls).toHaveLength(2);
    expect(await drive(running, clock)).toBe("succeeded");
  });
});
