import { expect, test } from "bun:test";
import { Engine } from "../engine/engine";
import { Store } from "../engine/store";
import { FakeProvider } from "../llm/fake";
import { testDb, until } from "../test/helpers";
import { Connections } from "./connections";
import { RuntimeRegistry } from "./runtime";

test("a new registry decrypts persisted credentials and recovers the original provider", async () => {
  const db = await testDb();
  const store = await Store.open(db);
  const secret = "recovery-key-".repeat(5);
  const connections = await Connections.open(db, secret, (config) => new FakeProvider(() => ({ text: config.apiKey }), { model: config.model, delayMs: 10_000 }));
  await db.exec("TRUNCATE connections");
  // Validation uses a quick provider, then the original worker hangs mid-step.
  const validation = await Connections.open(db, secret, (config) => new FakeProvider(() => ({ text: "connected" }), { model: config.model }));
  const saved = await validation.create("owner", { provider: "openai", model: "saved-model", apiKey: "credential-survives-restart", name: "Persistent", rpm: 60_000 });
  const demo = new FakeProvider(() => ({ text: "WRONG PROVIDER" }));
  const registryA = new RuntimeRegistry({ store, connections, demo });
  const a = new Engine({ store, provider: demo, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, rpm: 60_000, resolveRuntime: registryA.resolve });
  let b: Engine | undefined;
  try {
    const { runId } = await a.createRun({ graph: { steps: [{ id: "one", prompt: "Use saved provider" }] } }, { ownerId: "owner", connectionId: saved.id });
    await until(async () => (await store.getSteps(runId))[0]?.status === "running");
    await expect(connections.delete(saved.id, "owner")).rejects.toThrow("Cancel active runs");
    await a.stop();
    const reopened = await Connections.open(db, secret, (config) => new FakeProvider(() => ({ text: `${config.model}:${config.apiKey}` }), { model: config.model }));
    const registryB = new RuntimeRegistry({ store, connections: reopened, demo });
    b = new Engine({ store, provider: demo, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, rpm: 60_000, resolveRuntime: registryB.resolve });
    await b.sweep();
    await b.whenSettled(runId);
    expect((await store.getRun(runId))?.status).toBe("succeeded");
    expect((await store.getSteps(runId))[0]?.output).toBe("saved-model:credential-survives-restart");
    expect((await store.eventsAfter(runId, 0)).some((e) => e.type === "run.lease_taken")).toBe(true);
  } finally { await a.stop(); await b?.stop(); }
});

test("identical cacheable prompts do not share results between workspaces", async () => {
  const store = await Store.open(await testDb());
  const provider = new FakeProvider((req) => ({ text: `private-result-${req.prompt}` }));
  let namespace = "alice";
  const engine = new Engine({ store, provider, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, rpm: 60_000, resolveRuntime: async () => ({ provider, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, cacheNamespace: namespace }) });
  try {
    const graph = { steps: [{ id: "one", prompt: "same", cache: true }] };
    const first = await engine.createRun({ graph }); await engine.whenSettled(first.runId);
    namespace = "bob";
    const second = await engine.createRun({ graph }); await engine.whenSettled(second.runId);
    expect((await store.getSteps(second.runId))[0]?.cached).toBe(false);
    const third = await engine.createRun({ graph }); await engine.whenSettled(third.runId);
    expect((await store.getSteps(third.runId))[0]?.cached).toBe(true);
    expect(provider.calls).toHaveLength(2);
  } finally { await engine.stop(); }
});
