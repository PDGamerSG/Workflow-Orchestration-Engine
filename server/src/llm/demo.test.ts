import { afterEach, describe, expect, test } from "bun:test";
import { Engine } from "../engine/engine";
import { Store } from "../engine/store";
import { GENERAL_PLAN_INTRO } from "../planner/profiles";
import { Planner } from "../planner/planner";
import { createDemoProvider, sampleFromSchema } from "./demo";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("demo provider", () => {
  for (const profile of ["research", "general"] as const) {
    test(`runs a ${profile} goal end to end`, async () => {
      const store = new Store(":memory:");
      const provider = createDemoProvider({ minDelayMs: 1, jitterMs: 5 });
      const engine = new Engine({
        store,
        provider,
        planner: new Planner(provider, { searchEnabled: true }),
        pricing: { inputPerM: 1, outputPerM: 1, searchPerK: 1 },
        rpm: 60_000,
      });
      cleanup = async () => {
        await engine.stop();
        store.close();
      };

      const { runId } = engine.createRun({ goal: "Should a small team pick SQLite or Postgres?", profile });
      await engine.whenSettled(runId);

      const run = store.getRun(runId)!;
      expect(run.status).toBe("succeeded");
      expect(run.graph!.steps.some((s) => s.final)).toBe(true);
    });
  }

  test("fails step calls at the failure rate but never planner calls", async () => {
    const provider = createDemoProvider({ minDelayMs: 0, jitterMs: 1, failureRate: 1 });
    const signal = new AbortController().signal;

    const plan = await provider.generate({ prompt: `${GENERAL_PLAN_INTRO}

Goal: pick a database`, signal });
    expect(JSON.parse(plan.text).steps.length).toBeGreaterThan(0);

    await expect(provider.generate({ prompt: "Summarise the options", signal })).rejects.toThrow("overloaded");
  });

  test("never fails when the failure rate is zero", async () => {
    const provider = createDemoProvider({ minDelayMs: 0, jitterMs: 1 });
    const signal = new AbortController().signal;
    for (let i = 0; i < 20; i++) {
      expect((await provider.generate({ prompt: "Summarise the options", signal })).text).toContain("Demo answer");
    }
  });

  test("sampleFromSchema satisfies nested schemas", () => {
    expect(
      sampleFromSchema({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, minItems: 3 },
          score: { type: "integer", minimum: 5 },
          level: { enum: ["low", "high"] },
        },
      }),
    ).toEqual({ tags: ["sample", "sample", "sample"], score: 5, level: "low" });
  });
});
