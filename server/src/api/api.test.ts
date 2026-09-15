import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Engine } from "../engine/engine";
import { Store } from "../engine/store";
import { FakeProvider } from "../llm/fake";
import { createApp } from "./app";

let store: Store;
let engine: Engine;
let server: Server;
let base: string;
let provider: FakeProvider;

beforeEach(async () => {
  store = new Store(":memory:");
  provider = new FakeProvider((req) => ({ text: `${req.prompt.match(/^step (\w+)/)?.[1]}-out` }), {
    delayMs: (req) => (req.prompt.includes("slow") ? 150 : 1),
  });
  engine = new Engine({ store, provider, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, rpm: 60_000 });
  const app = createApp({ engine, store, webOrigin: "http://localhost:3000", ssePollMs: 50 });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await engine.stop({ graceful: false });
  store.close();
});

const graph = {
  steps: [
    { id: "a", prompt: "step a" },
    { id: "b", prompt: "step b {{a.output}}" },
  ],
};

function post(path: string, body?: unknown, raw?: string) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

type StreamedEvent = { id: number; type: string; payload: Record<string, unknown> };

/** Reads SSE frames until `until` returns true, then closes the connection. */
async function readEvents(path: string, until: (events: StreamedEvent[]) => boolean, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(base + path, { headers, signal: controller.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: StreamedEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + 3_000;

  while (!until(events)) {
    if (Date.now() > deadline) throw new Error(`timed out with ${events.length} events`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      const id = frame.split("\n").find((l) => l.startsWith("id: "));
      if (data) {
        const parsed = JSON.parse(data.slice(6));
        expect(Number(id!.slice(4))).toBe(parsed.id);
        events.push(parsed);
      }
    }
  }
  controller.abort();
  return events;
}

describe("HTTP API", () => {
  test("creates a run and reports its steps and totals", async () => {
    const res = await post("/runs", { graph, concurrency: 2 });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    await engine.whenSettled(runId);

    const detail = await fetch(`${base}/runs/${runId}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as any;
    expect(body.run).toMatchObject({ id: runId, status: "succeeded", concurrency: 2 });
    expect(body.run.graph.order).toEqual(["a", "b"]);
    expect(body.steps.map((s: any) => [s.stepId, s.status, s.output])).toEqual([
      ["a", "succeeded", "a-out"],
      ["b", "succeeded", "b-out"],
    ]);
    expect(body.totals).toEqual({ inputTokens: 18, outputTokens: 10, searchCalls: 0, costUsd: 0 });
    expect(body.lastEventId).toBe(store.eventsAfter(runId, 0).at(-1)!.id);

    const list = (await (await fetch(`${base}/runs`)).json()) as any;
    expect(list.runs[0]).toMatchObject({ id: runId, stepCounts: { succeeded: 2 } });
    expect(list.runs[0].graph).toBeUndefined();
  });

  test("returns validation issues for a bad graph", async () => {
    const res = await post("/runs", { graph: { steps: [{ id: "a", prompt: "{{a.output}}" }] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_graph", message: "invalid graph", issues: ['step "a" references itself'] },
    });
  });

  test("rejects malformed JSON and bad request fields", async () => {
    const bad = await post("/runs", undefined, "{not json");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("invalid_json");

    const fields = await post("/runs", { graph, concurrency: 0 });
    expect(fields.status).toBe(400);
    expect(((await fields.json()) as any).error).toMatchObject({ code: "invalid_request", issues: [expect.stringContaining("concurrency")] });
  });

  test("uses 404 and 409 for missing runs and invalid transitions", async () => {
    const missing = await fetch(`${base}/runs/run_nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("not_found");
    expect((await post("/runs/run_nope/retry")).status).toBe(404);
    expect((await fetch(`${base}/runs/run_nope/events`)).status).toBe(404);
    expect((await fetch(`${base}/nothing-here`)).status).toBe(404);

    const { runId } = (await (await post("/runs", { graph })).json()) as { runId: string };
    await engine.whenSettled(runId);
    const cancel = await post(`/runs/${runId}/cancel`);
    expect(cancel.status).toBe(409);
    expect(((await cancel.json()) as any).error.code).toBe("conflict");
    expect((await post(`/runs/${runId}/retry`)).status).toBe(409);
  });

  test("cancels a running run", async () => {
    const { runId } = (await (await post("/runs", { graph: { steps: [{ id: "a", prompt: "step a slow" }] } })).json()) as { runId: string };
    expect((await post(`/runs/${runId}/cancel`)).status).toBe(202);
    await engine.whenSettled(runId);
    expect(store.getRun(runId)!.status).toBe("cancelled");
  });

  test("replays stored events and resumes after Last-Event-ID", async () => {
    const { runId } = (await (await post("/runs", { graph })).json()) as { runId: string };
    await engine.whenSettled(runId);
    const stored = store.eventsAfter(runId, 0);

    const all = await readEvents(`/runs/${runId}/events`, (e) => e.length === stored.length);
    expect(all.map((e) => e.type)).toEqual(stored.map((e) => e.type));
    expect(all.at(-1)!.payload).toHaveProperty("totals");

    const cursor = stored[2]!.id;
    const rest = await readEvents(`/runs/${runId}/events`, (e) => e.length === stored.length - 3, { "Last-Event-ID": String(cursor) });
    expect(rest[0]!.id).toBe(stored[3]!.id);

    const viaQuery = await readEvents(`/runs/${runId}/events?after=${cursor}`, (e) => e.length === stored.length - 3);
    expect(viaQuery.map((e) => e.id)).toEqual(rest.map((e) => e.id));
  });

  test("streams events live while a run executes", async () => {
    const { runId } = (await (await post("/runs", { graph: { steps: [{ id: "a", prompt: "step a slow" }, { id: "b", prompt: "step b {{a.output}}" }] } })).json()) as {
      runId: string;
    };
    const events = await readEvents(`/runs/${runId}/events`, (e) => e.some((x) => x.type === "run.succeeded"));
    expect(events.map((e) => e.type)).toEqual([
      "run.created",
      "step.started",
      "step.succeeded",
      "step.started",
      "step.succeeded",
      "run.succeeded",
    ]);
  });

  test("allows the dashboard origin", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(await res.json()).toEqual({ ok: true, workerId: engine.workerId });

    const preflight = await fetch(`${base}/runs`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Last-Event-ID");
  });
});
