import { describe, expect, test } from "bun:test";
import { validateGraph } from "../engine/graph";
import { FakeProvider } from "../llm/fake";
import type { StepRow } from "../engine/store";
import { makeGraph } from "../test/helpers";
import { Planner, PlanningError } from "./planner";

const usage = { inputTokens: 10, outputTokens: 5, searchCalls: 0 };

function scripted(replies: unknown[]) {
  return new FakeProvider(() => {
    const next = replies.shift();
    if (next === undefined) throw new Error("no scripted reply left");
    return { text: typeof next === "string" ? next : JSON.stringify(next), usage };
  });
}

const signal = new AbortController().signal;

describe("Planner.plan (general)", () => {
  test("feeds validation issues back until the plan is valid", async () => {
    const provider = scripted([
      { steps: [{ id: "a", prompt: "{{b.output}}" }, { id: "b", prompt: "{{a.output}}" }] },
      {
        steps: [
          { id: "outline", prompt: "Outline: {{goal}}" },
          { id: "draft", prompt: "Draft from {{outline.output}}", final: true },
        ],
      },
    ]);
    const result = await new Planner(provider, { searchEnabled: true }).plan("write a blog post", "general", signal);

    expect(result.attempts).toBe(2);
    expect(result.graph.order).toEqual(["outline", "draft"]);
    expect(result.graph.steps.find((s) => s.id === "draft")!.final).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, searchCalls: 0 });
    expect(provider.calls[0]!.jsonSchema).toBeDefined();
    expect(provider.calls[0]!.prompt).toContain("write a blog post");
    expect(provider.calls[1]!.prompt).toContain("cycle: ");
  });

  test("parses an output schema given as a JSON string and marks a final step when none is marked", async () => {
    const provider = scripted([
      {
        steps: [
          { id: "list", prompt: "List ideas", outputJsonSchema: '{"type":"object","properties":{"ideas":{"type":"array","items":{"type":"string"}}}}' },
          { id: "pick", prompt: "Pick one of {{list.output.ideas}}", dependsOn: ["list"] },
        ],
      },
    ]);
    const { graph } = await new Planner(provider, { searchEnabled: true }).plan("pick a project", "general", signal);
    expect(graph.steps[0]!.output).toEqual({
      type: "json",
      schema: { type: "object", properties: { ideas: { type: "array", items: { type: "string" } } } },
    });
    expect(graph.steps.map((s) => s.final)).toEqual([false, true]);
  });

  test("reports unparseable replies and bad schema strings as issues", async () => {
    const provider = scripted([
      "not json at all",
      { steps: [{ id: "a", prompt: "x", outputJsonSchema: "{broken" }] },
      { steps: [{ id: "a", prompt: "x" }] },
    ]);
    const result = await new Planner(provider, { searchEnabled: true }).plan("anything", "general", signal);
    expect(result.attempts).toBe(3);
    expect(provider.calls[1]!.prompt).toContain("reply was not valid JSON");
    expect(provider.calls[2]!.prompt).toContain('step "a" has an outputJsonSchema that is not valid JSON');
  });

  test("gives up after three invalid plans", async () => {
    const bad = { steps: [{ id: "a", prompt: "{{a.output}}" }] };
    const provider = scripted([bad, bad, bad]);
    const planning = new Planner(provider, { searchEnabled: true }).plan("anything", "general", signal);
    await expect(planning).rejects.toBeInstanceOf(PlanningError);
    const err = (await planning.catch((e) => e)) as PlanningError;
    expect(err.issues).toEqual(['step "a" references itself']);
    expect(err.usage.inputTokens).toBe(30);
  });
});

describe("Planner.plan (research)", () => {
  const subQuestions = {
    subQuestions: [
      { id: "Write Throughput", question: "How do write loads compare?" },
      { id: "operations", question: "What does each cost to operate?" },
      { id: "operations", question: "How do backups work?" },
    ],
  };

  test("builds research, verify and write steps from the sub-questions", async () => {
    const provider = scripted([subQuestions]);
    const { graph } = await new Planner(provider, { searchEnabled: true }).plan("SQLite or Postgres for a SaaS?", "research", signal);

    expect(validateGraph(graph).ok).toBe(true);
    const ids = graph.steps.map((s) => s.id);
    expect(ids).toEqual(["research_write_throughput", "research_operations", "research_operations_2", "verify", "write"]);

    const research = graph.steps.filter((s) => s.id.startsWith("research_"));
    for (const step of research) {
      expect(step.tools).toEqual(["search"]);
      expect(step.output.type).toBe("json");
      expect(step.dependsOn).toEqual([]);
    }
    expect(research[0]!.prompt).toContain("How do write loads compare?");

    const verify = graph.steps.find((s) => s.id === "verify")!;
    expect(verify.dependsOn.sort()).toEqual(research.map((s) => s.id).sort());
    const write = graph.steps.find((s) => s.id === "write")!;
    expect(write.final).toBe(true);
    expect(write.dependsOn).toContain("verify");
    expect(write.prompt).toContain("{{research_operations.sources}}");
  });

  test("leaves out search when it is disabled", async () => {
    const { graph } = await new Planner(scripted([subQuestions]), { searchEnabled: false }).plan("goal here", "research", signal);
    expect(graph.steps.every((s) => s.tools.length === 0)).toBe(true);
    expect(graph.steps[0]!.prompt).toContain("own knowledge");
  });

  test("asks again when there are too few sub-questions", async () => {
    const provider = scripted([{ subQuestions: [{ id: "only", question: "one?" }] }, subQuestions]);
    const result = await new Planner(provider, { searchEnabled: true }).plan("goal here", "research", signal);
    expect(result.attempts).toBe(2);
    expect(provider.calls[1]!.prompt).toContain("between 3 and 6 sub-questions");
  });
});

describe("Planner.replan", () => {
  const graph = makeGraph({
    steps: [
      { id: "a", prompt: "step a" },
      { id: "b", prompt: "step b uses {{a.output}}", output: { type: "json", schema: { type: "object", properties: { x: { type: "string" } } } } },
      { id: "c", prompt: "step c uses {{b.output.x}} and {{a.output}}", final: true },
      { id: "d", prompt: "independent" },
    ],
  });

  function rows(statuses: Record<string, StepRow["status"]>, outputs: Record<string, string> = {}): StepRow[] {
    return graph.steps.map((s, i) => ({
      runId: "r",
      stepId: s.id,
      graphVersion: 1,
      status: statuses[s.id] ?? "pending",
      attempt: 1,
      resolvedPrompt: null,
      output: outputs[s.id] ?? null,
      sources: [],
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      searchCalls: 0,
      costUsd: 0,
      cached: false,
      startedAt: i,
      finishedAt: null,
    }));
  }

  const input = {
    goal: "the goal",
    profile: "general" as const,
    graph,
    graphVersion: 1,
    steps: rows({ a: "succeeded", b: "failed", d: "running" }, { a: "A says hi" }),
    failedStepId: "b",
    error: "HTTP 400: bad",
  };

  test("swaps the failed step for replacements and rewires its downstream steps", async () => {
    const provider = scripted([
      { steps: [{ id: "b_prep", prompt: "prep from {{a.output}}" }, { id: "b_alt", prompt: "finish using {{b_prep.output}}" }] },
    ]);
    const result = await new Planner(provider, { searchEnabled: true }).replan(input, signal);

    expect(provider.calls[0]!.prompt).toContain("HTTP 400: bad");
    expect(provider.calls[0]!.prompt).toContain("A says hi");
    expect(result.supersede.sort()).toEqual(["b", "c"]);
    expect(result.added).toEqual(["b_prep", "b_alt", "c_r2"]);

    const byId = Object.fromEntries(result.graph.steps.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(["a", "b_alt", "b_prep", "c_r2", "d"]);
    expect(byId.b_alt!.output).toEqual(graph.steps[1]!.output);
    expect(byId.c_r2!.prompt).toBe("step c uses {{b_alt.output.x}} and {{a.output}}");
    expect(byId.c_r2!.final).toBe(true);
    expect(byId.c_r2!.dependsOn.sort()).toEqual(["a", "b_alt"]);
    expect(validateGraph(result.graph).ok).toBe(true);
  });

  test("renames replacement ids that collide with existing steps", async () => {
    const provider = scripted([{ steps: [{ id: "c", prompt: "retry via {{a.output}}" }] }]);
    const result = await new Planner(provider, { searchEnabled: true }).replan(input, signal);
    expect(result.added).toEqual(["c_r2", "c_r3"]);
    const byId = Object.fromEntries(result.graph.steps.map((s) => [s.id, s]));
    expect(byId.c_r3!.prompt).toBe("step c uses {{c_r2.output.x}} and {{a.output}}");
  });

  test("rejects replacements that use steps that are not finished", async () => {
    const provider = scripted([
      { steps: [{ id: "alt", prompt: "use {{d.output}}" }] },
      { steps: [{ id: "alt", prompt: "use {{a.output}}" }] },
    ]);
    const result = await new Planner(provider, { searchEnabled: true }).replan(input, signal);
    expect(provider.calls[1]!.prompt).toContain('replacement step "alt" references "d", which has not succeeded');
    expect(result.added[0]).toBe("alt");
  });
});
