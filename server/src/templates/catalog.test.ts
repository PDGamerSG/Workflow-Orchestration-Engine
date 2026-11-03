import { expect, test } from "bun:test";
import { Engine } from "../engine/engine";
import { validateGraph } from "../engine/graph";
import { createDemoProvider } from "../llm/demo";
import { testStore } from "../test/helpers";
import { TEMPLATES } from "./catalog";

test("every published template validates and produces a final result", async () => {
  expect(TEMPLATES.length).toBeGreaterThanOrEqual(6);
  const store = await testStore();
  const provider = createDemoProvider({ minDelayMs: 0, jitterMs: 0 });
  const engine = new Engine({
    store,
    provider,
    pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 },
    rpm: 60_000,
  });
  try {
    for (const template of TEMPLATES) {
      const checked = validateGraph(template.graph);
      expect(checked.ok).toBe(true);
      const { runId } = await engine.createRun({ graph: template.graph });
      await engine.whenSettled(runId);
      expect((await store.getRun(runId))?.status).toBe("succeeded");
      const final = template.graph.steps.find((s) => s.final)!;
      expect(
        (await store.getSteps(runId)).find((s) => s.stepId === final.id)?.output
          ?.length,
      ).toBeGreaterThan(0);
    }
  } finally {
    await engine.stop();
  }
});
