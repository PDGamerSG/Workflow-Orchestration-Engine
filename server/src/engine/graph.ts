import { z } from "zod";
import { extractRefs, GOAL_REF } from "./template";
import type { NormalizedGraph, NormalizedStep } from "./types";

export const MAX_STEPS = 50;

const StepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "must be lowercase snake_case, 1-40 chars, starting with a letter"),
  prompt: z.string().min(1).max(20_000),
  dependsOn: z.array(z.string()).max(MAX_STEPS).optional(),
  tools: z.array(z.literal("search")).max(1).optional(),
  output: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("text") }),
      z.object({ type: z.literal("json"), schema: z.record(z.string(), z.unknown()) }),
    ])
    .optional(),
  retries: z.number().int().min(0).max(5).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  cache: z.boolean().optional(),
  final: z.boolean().optional(),
});

export const GraphSchema = z.object({
  steps: z
    .array(StepSchema)
    .min(1, "a graph needs at least 1 step")
    .max(MAX_STEPS, `a graph can have at most ${MAX_STEPS} steps`),
});

export type GraphValidation = { ok: true; graph: NormalizedGraph } | { ok: false; issues: string[] };

export function validateGraph(input: unknown): GraphValidation {
  const parsed = GraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
    };
  }

  const issues: string[] = [];
  const ids = new Set<string>();
  for (const step of parsed.data.steps) {
    if (step.id === GOAL_REF) issues.push(`"${GOAL_REF}" is a reserved step id`);
    if (ids.has(step.id)) issues.push(`duplicate step id "${step.id}"`);
    ids.add(step.id);
  }

  const steps: NormalizedStep[] = parsed.data.steps.map((step) => {
    const deps = new Set<string>();
    for (const dep of step.dependsOn ?? []) {
      if (dep === step.id) issues.push(`step "${step.id}" references itself`);
      else if (!ids.has(dep)) issues.push(`step "${step.id}" depends on unknown step "${dep}"`);
      else deps.add(dep);
    }
    for (const ref of extractRefs(step.prompt)) {
      if (ref === step.id) issues.push(`step "${step.id}" references itself`);
      else if (!ids.has(ref)) issues.push(`step "${step.id}" references unknown step "${ref}"`);
      else deps.add(ref);
    }

    const output = step.output ?? { type: "text" as const };
    if (output.type === "json") issues.push(...checkSchema(step.id, output.schema));

    return {
      id: step.id,
      prompt: step.prompt,
      dependsOn: [...deps],
      tools: step.tools ?? [],
      output,
      retries: step.retries ?? 2,
      timeoutMs: step.timeoutMs ?? 90_000,
      cache: step.cache ?? false,
      final: step.final ?? false,
    };
  });

  if (issues.length) return { ok: false, issues: [...new Set(issues)] };

  const sorted = topoSort(steps);
  if (!sorted.ok) return { ok: false, issues: [`cycle: ${sorted.cycle.join(" -> ")}`] };

  return { ok: true, graph: { steps, order: sorted.order } };
}

/** Kahn's algorithm. Ties keep declaration order so the result is stable. */
function topoSort(steps: NormalizedStep[]): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const inDegree = new Map(steps.map((s) => [s.id, s.dependsOn.length]));
  const children = childMap(steps);
  const queue = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  const order: string[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const left = inDegree.get(child)! - 1;
      inDegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }

  if (order.length === steps.length) return { ok: true, order };

  const remaining = new Set(steps.map((s) => s.id).filter((id) => !order.includes(id)));
  return { ok: false, cycle: findCycle(steps, remaining) };
}

/** DFS over nodes Kahn's algorithm could not remove. Every such node sits on or behind a cycle. */
function findCycle(steps: NormalizedStep[], remaining: Set<string>): string[] {
  const deps = new Map(steps.map((s) => [s.id, s.dependsOn.filter((d) => remaining.has(d))]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (state.get(dep) === "visiting") {
        // The stack runs from dependents to dependencies. Reverse it so arrows read "a -> b" as "b uses a".
        const loop = stack.slice(stack.indexOf(dep)).reverse();
        return [...loop, loop[0]!];
      }
      if (!state.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of remaining) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return [...remaining];
}

function checkSchema(stepId: string, schema: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && Object.keys(obj.properties).length === 0) {
      issues.push(`step "${stepId}" output schema has an object with no properties`);
    }
    for (const value of Object.values(obj)) walk(value);
  };
  if (!("type" in schema)) issues.push(`step "${stepId}" output schema needs a "type"`);
  walk(schema);
  return issues;
}

function childMap(steps: NormalizedStep[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.dependsOn) children.set(dep, [...(children.get(dep) ?? []), step.id]);
  }
  return children;
}

export function descendants(graph: NormalizedGraph, id: string): Set<string> {
  const children = childMap(graph.steps);
  const found = new Set<string>();
  const queue = [...(children.get(id) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (found.has(next)) continue;
    found.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}
