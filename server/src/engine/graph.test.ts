import { describe, expect, test } from "bun:test";
import { descendants, validateGraph } from "./graph";

function ok(input: unknown) {
  const result = validateGraph(input);
  if (!result.ok) throw new Error("expected valid graph, got: " + result.issues.join("; "));
  return result.graph;
}

function issues(input: unknown) {
  const result = validateGraph(input);
  if (result.ok) throw new Error("expected issues, graph was valid");
  return result.issues;
}

const diamond = {
  steps: [
    { id: "d", prompt: "join {{b.output}} {{c.output}}" },
    { id: "b", prompt: "left", dependsOn: ["a"] },
    { id: "c", prompt: "right", dependsOn: ["a"] },
    { id: "a", prompt: "root" },
  ],
};

describe("validateGraph", () => {
  test("accepts a diamond and orders dependencies first", () => {
    const graph = ok(diamond);
    const pos = (id: string) => graph.order.indexOf(id);
    expect(graph.order).toHaveLength(4);
    expect(pos("a")).toBeLessThan(pos("b"));
    expect(pos("a")).toBeLessThan(pos("c"));
    expect(pos("b")).toBeLessThan(pos("d"));
    expect(pos("c")).toBeLessThan(pos("d"));
  });

  test("fills defaults", () => {
    const [step] = ok({ steps: [{ id: "a", prompt: "hi" }] }).steps;
    expect(step).toEqual({
      id: "a",
      prompt: "hi",
      dependsOn: [],
      tools: [],
      output: { type: "text" },
      retries: 2,
      timeoutMs: 90_000,
      cache: false,
      final: false,
    });
  });

  test("adds template references to dependsOn without duplicates", () => {
    const graph = ok(diamond);
    const d = graph.steps.find((s) => s.id === "d")!;
    expect(d.dependsOn.sort()).toEqual(["b", "c"]);

    const graph2 = ok({
      steps: [
        { id: "a", prompt: "x" },
        { id: "b", prompt: "{{a.output}} {{a.sources}}", dependsOn: ["a"] },
      ],
    });
    expect(graph2.steps[1]!.dependsOn).toEqual(["a"]);
  });

  test("reports duplicate ids", () => {
    expect(issues({ steps: [{ id: "a", prompt: "1" }, { id: "a", prompt: "2" }] })).toContain(
      'duplicate step id "a"',
    );
  });

  test("reports unknown dependencies and template references", () => {
    const found = issues({
      steps: [
        { id: "a", prompt: "x", dependsOn: ["x"] },
        { id: "b", prompt: "{{zz.output}}" },
      ],
    });
    expect(found).toContain('step "a" depends on unknown step "x"');
    expect(found).toContain('step "b" references unknown step "zz"');
  });

  test("reports self references", () => {
    expect(issues({ steps: [{ id: "a", prompt: "{{a.output}}" }] })).toContain('step "a" references itself');
    expect(issues({ steps: [{ id: "a", prompt: "x", dependsOn: ["a"] }] })).toContain('step "a" references itself');
  });

  test("reports a cycle with its path", () => {
    const found = issues({
      steps: [
        { id: "a", prompt: "{{c.output}}" },
        { id: "b", prompt: "{{a.output}}" },
        { id: "c", prompt: "{{b.output}}" },
        { id: "ok", prompt: "independent" },
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^cycle: /);
    const path = found[0]!.slice("cycle: ".length).split(" -> ");
    expect(path[0]).toBe(path[path.length - 1]);
    expect(new Set(path)).toEqual(new Set(["a", "b", "c"]));
  });

  test("rejects bad shapes", () => {
    expect(issues({ steps: [] })[0]).toMatch(/at least 1/);
    expect(issues({ steps: [{ id: "Bad-Id", prompt: "x" }] })[0]).toMatch(/steps\.0\.id/);
    expect(issues({ steps: [{ id: "goal", prompt: "x" }] })).toContain('"goal" is a reserved step id');
    expect(issues({ steps: [{ id: "a", prompt: "x", retries: 9 }] })[0]).toMatch(/retries/);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, prompt: "x" }));
    expect(issues({ steps: many })[0]).toMatch(/at most 50/);
    expect(issues(null)[0]).toMatch(/expected object/i);
  });

  test("rejects json output schemas the provider cannot take", () => {
    expect(issues({ steps: [{ id: "a", prompt: "x", output: { type: "json", schema: {} } }] })).toContain(
      'step "a" output schema needs a "type"',
    );
    expect(
      issues({
        steps: [{ id: "a", prompt: "x", output: { type: "json", schema: { type: "object", properties: {} } } }],
      }),
    ).toContain('step "a" output schema has an object with no properties');
  });
});

describe("descendants", () => {
  test("returns every step downstream of the given one", () => {
    const graph = ok(diamond);
    expect(descendants(graph, "a")).toEqual(new Set(["b", "c", "d"]));
    expect(descendants(graph, "b")).toEqual(new Set(["d"]));
    expect(descendants(graph, "d")).toEqual(new Set());
  });
});
