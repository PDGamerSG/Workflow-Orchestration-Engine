import type { Source } from "./types";

export class TemplateError extends Error {
  override name = "TemplateError";
}

export type TemplateContext = {
  goal: string | null;
  steps: Map<string, { output: string; sources: Source[] }>;
};

// {{id}}, {{id.output}}, {{id.output.a.b[0]}}, {{id.sources}}
const REF = /\{\{\s*([a-z][a-z0-9_]*)(?:\.(output|sources)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*))?\s*\}\}/g;

export const GOAL_REF = "goal";

/** Step ids referenced by a prompt, in first-seen order, without `goal`. */
export function extractRefs(prompt: string): string[] {
  const ids = new Set<string>();
  for (const match of prompt.matchAll(REF)) {
    if (match[1] !== GOAL_REF) ids.add(match[1]!);
  }
  return [...ids];
}

/** Rewrites step ids inside template references, leaving the rest of each reference as it was. */
export function renameRefs(prompt: string, renames: Map<string, string>): string {
  return prompt.replace(REF, (whole, id: string) => {
    const next = renames.get(id);
    return next ? whole.replace(id, next) : whole;
  });
}

export function renderTemplate(prompt: string, ctx: TemplateContext): string {
  return prompt.replace(REF, (_whole, id: string, field: string | undefined, path: string | undefined) => {
    if (id === GOAL_REF && !field) return ctx.goal ?? "";

    const step = ctx.steps.get(id);
    if (!step) throw new TemplateError(`step "${id}" has no saved output`);

    if (field === "sources") return formatSources(step.sources);
    if (!path) return step.output;
    return stringify(readPath(id, step.output, path));
  });
}

export function formatSources(sources: Source[]): string {
  if (sources.length === 0) return "(no sources)";
  return sources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join("\n");
}

function readPath(id: string, output: string, path: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new TemplateError(`output of step "${id}" is not JSON, so "${path}" cannot be read`);
  }

  for (const [, key, index] of path.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    const container = value as Record<string, unknown> | unknown[] | null;
    const next =
      key !== undefined
        ? container && typeof container === "object" && !Array.isArray(container)
          ? container[key]
          : undefined
        : Array.isArray(container)
          ? container[Number(index)]
          : undefined;
    if (next === undefined) throw new TemplateError(`output of step "${id}" has no value at "${path}"`);
    value = next;
  }
  return value;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
