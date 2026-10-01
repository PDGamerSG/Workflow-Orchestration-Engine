import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "../engine/engine";
import type { Store } from "../engine/store";
import { FakeProvider } from "../llm/fake";
import { testStore } from "../test/helpers";
import { createApi } from "./handler";

let store: Store;
let engine: Engine;
let api: (req: Request) => Promise<Response>;

beforeEach(async () => {
  store = await testStore();
  const provider = new FakeProvider((req) => ({ text: `${req.prompt.match(/^step (\w+)/)?.[1]}-out` }), {
    delayMs: (req) => (req.prompt.includes("slow") ? 150 : 1),
  });
  engine = new Engine({ store, provider, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, rpm: 60_000 });
  api = createApi({ engine, store, basePath: "/api" });
});

afterEach(() => engine.stop({ graceful: false }));

const graph = {
  steps: [
    { id: "a", prompt: "step a" },
    { id: "b", prompt: "step b {{a.output}}" },
  ],
};

function call(method: string, path: string, body?: unknown, raw?: string) {
  return api(
    new Request(`http://relay.test/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
  );
}

async function createRun(body: unknown): Promise<string> {
  const res = await call("POST", "/runs", body);
  return ((await res.json()) as { runId: string }).runId;
}

describe("HTTP API", () => {
  test("creates a run and reports its steps and totals", async () => {
    const res = await call("POST", "/runs", { graph, concurrency: 2 });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    await engine.whenSettled(runId);

    const detail = await call("GET", `/runs/${runId}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as any;
    expect(body.run).toMatchObject({ id: runId, status: "succeeded", concurrency: 2 });
    expect(body.run.graph.order).toEqual(["a", "b"]);
    expect(body.steps.map((s: any) => [s.stepId, s.status, s.output])).toEqual([
      ["a", "succeeded", "a-out"],
      ["b", "succeeded", "b-out"],
    ]);
    expect(body.totals).toEqual({ inputTokens: 18, outputTokens: 10, searchCalls: 0, costUsd: 0 });
    expect(body.lastEventId).toBe((await store.eventsAfter(runId, 0)).at(-1)!.id);

    const list = (await (await call("GET", "/runs")).json()) as any;
    expect(list.runs[0]).toMatchObject({ id: runId, stepCounts: { succeeded: 2 } });
    expect(list.runs[0].graph).toBeUndefined();
  });

  test("returns validation issues for a bad graph", async () => {
    const res = await call("POST", "/runs", { graph: { steps: [{ id: "a", prompt: "{{a.output}}" }] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_graph", message: "invalid graph", issues: ['step "a" references itself'] },
    });
  });

  test("rejects malformed JSON, oversized bodies and bad request fields", async () => {
    const bad = await call("POST", "/runs", undefined, "{not json");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("invalid_json");

    const big = await call("POST", "/runs", { goal: "x".repeat(1_100_000) });
    expect(big.status).toBe(413);

    const fields = await call("POST", "/runs", { graph, concurrency: 0 });
    expect(fields.status).toBe(400);
    expect(((await fields.json()) as any).error).toMatchObject({ code: "invalid_request", issues: [expect.stringContaining("concurrency")] });
  });

  test("uses 404 and 409 for missing runs and invalid transitions", async () => {
    const missing = await call("GET", "/runs/run_nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("not_found");
    expect((await call("POST", "/runs/run_nope/retry")).status).toBe(404);
    expect((await call("GET", "/runs/run_nope/events")).status).toBe(404);
    expect((await call("GET", "/nothing-here")).status).toBe(404);

    const runId = await createRun({ graph });
    await engine.whenSettled(runId);
    const cancel = await call("POST", `/runs/${runId}/cancel`);
    expect(cancel.status).toBe(409);
    expect(((await cancel.json()) as any).error.code).toBe("conflict");
    expect((await call("POST", `/runs/${runId}/retry`)).status).toBe(409);
  });

  test("cancels a running run", async () => {
    const runId = await createRun({ graph: { steps: [{ id: "a", prompt: "step a slow" }] } });
    expect((await call("POST", `/runs/${runId}/cancel`)).status).toBe(202);
    await engine.whenSettled(runId);
    expect((await store.getRun(runId))!.status).toBe("cancelled");
  });

  test("deletes a finished run and everything it wrote", async () => {
    const runId = await createRun({ graph });
    await engine.whenSettled(runId);

    expect((await call("DELETE", `/runs/${runId}`)).status).toBe(200);
    expect(await store.getRun(runId)).toBeNull();
    expect(await store.getSteps(runId)).toEqual([]);
    expect(await store.eventsAfter(runId, 0)).toEqual([]);
    expect((await call("GET", `/runs/${runId}`)).status).toBe(404);
    expect((await call("DELETE", `/runs/${runId}`)).status).toBe(404);
  });

  test("refuses to delete a run that is still going", async () => {
    const runId = await createRun({ graph: { steps: [{ id: "a", prompt: "step a slow" }] } });

    const del = await call("DELETE", `/runs/${runId}`);
    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error.message).toContain("cancel it before deleting");

    expect((await call("POST", `/runs/${runId}/cancel`)).status).toBe(202);
    await engine.whenSettled(runId);
    expect((await call("DELETE", `/runs/${runId}`)).status).toBe(200);
  });

  test("pages through stored events after a cursor", async () => {
    const runId = await createRun({ graph });
    await engine.whenSettled(runId);
    const stored = await store.eventsAfter(runId, 0);

    const all = (await (await call("GET", `/runs/${runId}/events`)).json()) as { events: { id: number; type: string; payload: unknown }[] };
    expect(all.events.map((e) => e.type)).toEqual(["run.created", "step.started", "step.succeeded", "step.started", "step.succeeded", "run.succeeded"]);
    expect(all.events.at(-1)!.payload).toHaveProperty("totals");

    const cursor = stored[2]!.id;
    const rest = (await (await call("GET", `/runs/${runId}/events?after=${cursor}`)).json()) as { events: { id: number }[] };
    expect(rest.events.map((e) => e.id)).toEqual(stored.slice(3).map((e) => e.id));
  });

  test("answers a health check", async () => {
    const res = await call("GET", "/health");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, workerId: engine.workerId });
  });
});
