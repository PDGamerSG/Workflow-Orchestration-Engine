import { describe, expect, test } from "bun:test";
import { extractRefs, renderTemplate, TemplateError, type TemplateContext } from "./template";

function ctx(steps: Record<string, { output: string; sources?: { title: string; url: string }[] }>, goal: string | null = null): TemplateContext {
  return {
    goal,
    steps: new Map(Object.entries(steps).map(([id, s]) => [id, { output: s.output, sources: s.sources ?? [] }])),
  };
}

describe("renderTemplate", () => {
  test("inserts step output", () => {
    expect(renderTemplate("A said: {{a.output}}.", ctx({ a: { output: "hello" } }))).toBe("A said: hello.");
    expect(renderTemplate("{{ a.output }}", ctx({ a: { output: "spaced" } }))).toBe("spaced");
  });

  test("reads paths inside JSON output", () => {
    const c = ctx({ a: { output: JSON.stringify({ items: [{ name: "x" }, { name: "y", n: 2 }] }) } });
    expect(renderTemplate("{{a.output.items[1].name}}", c)).toBe("y");
    expect(renderTemplate("{{a.output.items[1].n}}", c)).toBe("2");
    expect(renderTemplate("{{a.output.items[0]}}", c)).toBe('{\n  "name": "x"\n}');
  });

  test("throws TemplateError for a missing path or non-JSON output", () => {
    const c = ctx({ a: { output: '{"items":[]}' }, t: { output: "plain text" } });
    expect(() => renderTemplate("{{a.output.items[3].name}}", c)).toThrow(TemplateError);
    expect(() => renderTemplate("{{t.output.field}}", c)).toThrow(/not JSON/);
  });

  test("throws TemplateError when a referenced step has no saved output", () => {
    expect(() => renderTemplate("{{a.output}}", ctx({}))).toThrow(TemplateError);
  });

  test("renders numbered sources", () => {
    const c = ctx({
      a: { output: "x", sources: [{ title: "T1", url: "https://one" }, { title: "T2", url: "https://two" }] },
      b: { output: "y" },
    });
    expect(renderTemplate("{{a.sources}}", c)).toBe("[1] T1 - https://one\n[2] T2 - https://two");
    expect(renderTemplate("{{b.sources}}", c)).toBe("(no sources)");
  });

  test("renders the goal", () => {
    expect(renderTemplate("Goal: {{goal}}", ctx({}, "ship it"))).toBe("Goal: ship it");
    expect(renderTemplate("Goal: {{goal}}", ctx({}))).toBe("Goal: ");
  });

  test("leaves unrelated braces alone", () => {
    expect(renderTemplate('JSON like {"a": 1} and {{not a ref}}', ctx({}))).toBe('JSON like {"a": 1} and {{not a ref}}');
  });
});

describe("extractRefs", () => {
  test("returns unique step ids and skips goal", () => {
    expect(extractRefs("{{a.output}} {{b.sources}} {{a.output.x}} {{goal}}")).toEqual(["a", "b"]);
  });

  test("treats a bare id as a reference", () => {
    expect(extractRefs("{{ a }}")).toEqual(["a"]);
  });
});
