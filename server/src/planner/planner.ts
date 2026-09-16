import { z } from "zod";
import { descendants, validateGraph } from "../engine/graph";
import type { StepRow } from "../engine/store";
import { extractRefs, renameRefs } from "../engine/template";
import type { NormalizedGraph, Profile, StepDef, Usage } from "../engine/types";
import type { LlmProvider } from "../llm/provider";
import {
  buildResearchGraph,
  generalPlanPrompt,
  PLAN_RESPONSE_SCHEMA,
  replanPrompt,
  RESEARCH_PLAN_SCHEMA,
  researchPlanPrompt,
  retryAppendix,
  type SubQuestion,
} from "./profiles";

export class PlanningError extends Error {
  override name = "PlanningError";
  constructor(
    message: string,
    readonly issues: string[],
    readonly usage: Usage,
  ) {
    super(message);
  }
}

export type PlanResult = { graph: NormalizedGraph; usage: Usage; attempts: number };

export type ReplanInput = {
  goal: string;
  profile: Profile;
  graph: NormalizedGraph;
  graphVersion: number;
  steps: StepRow[];
  failedStepId: string;
  error: string;
};

export type ReplanResult = PlanResult & { supersede: string[]; added: string[] };

const StepReply = z.object({
  id: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()).optional(),
  useSearch: z.boolean().optional(),
  outputJsonSchema: z.string().optional(),
  final: z.boolean().optional(),
});
const StepsReply = z.object({ steps: z.array(StepReply).min(1).max(12) });
const ResearchReply = z.object({ subQuestions: z.array(z.object({ id: z.string(), question: z.string().min(1) })) });

type Attempt<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/**
 * Turns goals into graphs with the model. Every reply goes through the same validation as a
 * hand-written graph, and rejected replies go back to the model with the reasons, up to `maxAttempts`.
 */
export class Planner {
  private readonly provider: LlmProvider;
  private readonly searchEnabled: boolean;
  private readonly maxAttempts: number;

  constructor(provider: LlmProvider, opts: { searchEnabled: boolean; maxAttempts?: number }) {
    this.provider = provider;
    this.searchEnabled = opts.searchEnabled;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  plan(goal: string, profile: Profile, signal: AbortSignal): Promise<PlanResult> {
    if (profile === "research") {
      return this.loop(researchPlanPrompt(goal), RESEARCH_PLAN_SCHEMA, signal, (text) => this.acceptResearch(text));
    }
    return this.loop(generalPlanPrompt(goal, this.searchEnabled), PLAN_RESPONSE_SCHEMA, signal, (text) => this.acceptGeneral(text));
  }

  async replan(input: ReplanInput, signal: AbortSignal): Promise<ReplanResult> {
    const failed = input.graph.steps.find((s) => s.id === input.failedStepId);
    if (!failed) throw new Error(`step ${input.failedStepId} is not in the current graph`);

    const statuses = new Map(input.steps.map((s) => [s.stepId, s]));
    const finished = input.graph.order
      .map((id) => statuses.get(id))
      .filter((s): s is StepRow => s?.status === "succeeded" && s.output !== null)
      .map((s) => ({ id: s.stepId, output: s.output! }));

    const prompt = replanPrompt({ goal: input.goal, failed, error: input.error, finished, searchEnabled: this.searchEnabled });
    let merged: { supersede: string[]; added: string[] } | null = null;

    const result = await this.loop(prompt, PLAN_RESPONSE_SCHEMA, signal, (text) => {
      const parsed = this.parseSteps(text);
      if (!parsed.ok) return parsed;
      const attempt = mergeReplacement(input, parsed.value, new Set(finished.map((f) => f.id)));
      if (attempt.ok) merged = attempt.value.meta;
      return attempt.ok ? { ok: true, value: attempt.value.graph } : attempt;
    });
    return { ...result, ...merged! };
  }

  private async loop(
    basePrompt: string,
    schema: object,
    signal: AbortSignal,
    accept: (text: string) => Attempt<NormalizedGraph>,
  ): Promise<PlanResult> {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, searchCalls: 0 };
    let prompt = basePrompt;
    let issues: string[] = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const reply = await this.provider.generate({ prompt, jsonSchema: schema as Record<string, unknown>, signal });
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      usage.searchCalls += reply.usage.searchCalls;

      const accepted = accept(reply.text);
      if (accepted.ok) return { graph: accepted.value, usage, attempts: attempt };
      issues = accepted.issues;
      prompt = basePrompt + retryAppendix(reply.text, issues);
    }
    throw new PlanningError(`no valid plan after ${this.maxAttempts} attempts`, issues, usage);
  }

  private acceptGeneral(text: string): Attempt<NormalizedGraph> {
    const parsed = this.parseSteps(text);
    if (!parsed.ok) return parsed;
    const steps = parsed.value;
    if (!steps.some((s) => s.final)) {
      const lastSink = [...steps].reverse().find((s) => !steps.some((o) => o.dependsOn?.includes(s.id) || extractRefs(o.prompt).includes(s.id)));
      if (lastSink) lastSink.final = true;
    }
    return checked(steps);
  }

  private acceptResearch(text: string): Attempt<NormalizedGraph> {
    const json = parseJson(text);
    if (!json.ok) return json;
    const parsed = ResearchReply.safeParse(json.value);
    if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };

    const count = parsed.data.subQuestions.length;
    if (count < 3 || count > 6) return { ok: false, issues: [`the plan needs between 3 and 6 sub-questions, got ${count}`] };

    const taken = new Set<string>(["verify", "write", "goal"]);
    const subQuestions: SubQuestion[] = parsed.data.subQuestions.map((sq, i) => {
      const slug = sq.id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const base = `research_${slug || i + 1}`.slice(0, 36);
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
      taken.add(id);
      return { id, question: sq.question };
    });
    return checked(buildResearchGraph(subQuestions, this.searchEnabled));
  }

  /** Converts the model's step format into StepDefs. */
  private parseSteps(text: string): Attempt<StepDef[]> {
    const json = parseJson(text);
    if (!json.ok) return json;
    const parsed = StepsReply.safeParse(json.value);
    if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };

    const issues: string[] = [];
    const steps = parsed.data.steps.map((s): StepDef => {
      let output: StepDef["output"];
      if (s.outputJsonSchema?.trim()) {
        try {
          output = { type: "json", schema: JSON.parse(s.outputJsonSchema) };
        } catch {
          issues.push(`step "${s.id}" has an outputJsonSchema that is not valid JSON`);
        }
      }
      return {
        id: s.id,
        prompt: s.prompt,
        dependsOn: s.dependsOn,
        tools: s.useSearch && this.searchEnabled ? ["search"] : undefined,
        output,
        final: s.final,
      };
    });
    return issues.length ? { ok: false, issues } : { ok: true, value: steps };
  }
}

function checked(steps: StepDef[]): Attempt<NormalizedGraph> {
  const result = validateGraph({ steps });
  return result.ok ? { ok: true, value: result.graph } : { ok: false, issues: result.issues };
}

function parseJson(text: string): Attempt<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, issues: ["the reply was not valid JSON"] };
  }
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
}

/** `base_r2`, `base_r3`, ... skipping ids already in use. */
function nextId(id: string, taken: Set<string>): string {
  const base = id.replace(/_r\d+$/, "");
  for (let n = 2; ; n++) {
    const suffix = `_r${n}`;
    const candidate = base.slice(0, 40 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Replaces the failed step with `replacement` and recreates its unfinished descendants under new ids,
 * with their references pointed at the replacement's last step.
 */
function mergeReplacement(
  input: ReplanInput,
  replacement: StepDef[],
  succeeded: Set<string>,
): Attempt<{ graph: NormalizedGraph; meta: { supersede: string[]; added: string[] } }> {
  const { graph, failedStepId } = input;
  const failed = graph.steps.find((s) => s.id === failedStepId)!;
  const downstream = [...descendants(graph, failedStepId)];
  const supersede = [failedStepId, ...downstream];

  const taken = new Set<string>([...input.steps.map((s) => s.stepId), ...graph.steps.map((s) => s.id), "goal"]);

  // Replacement ids: keep the model's names unless they collide with existing steps.
  const replacementIds = new Map<string, string>();
  for (const step of replacement) {
    const id = taken.has(step.id) || replacementIds.has(step.id) ? nextId(step.id, taken) : step.id;
    replacementIds.set(step.id, id);
    taken.add(id);
  }

  const issues: string[] = [];
  for (const step of replacement) {
    for (const ref of new Set([...(step.dependsOn ?? []), ...extractRefs(step.prompt)])) {
      if (!replacementIds.has(ref) && !succeeded.has(ref)) {
        issues.push(`replacement step "${step.id}" references "${ref}", which has not succeeded`);
      }
    }
  }
  if (issues.length) return { ok: false, issues };

  const lastId = replacementIds.get(replacement.at(-1)!.id)!;
  const renames = new Map<string, string>([[failedStepId, lastId]]);
  for (const id of downstream) {
    const next = nextId(id, taken);
    renames.set(id, next);
    taken.add(next);
  }

  const added: StepDef[] = replacement.map((step, i) => ({
    ...step,
    id: replacementIds.get(step.id)!,
    prompt: renameRefs(step.prompt, replacementIds),
    dependsOn: step.dependsOn?.map((d) => replacementIds.get(d) ?? d),
    // The last replacement stands in for the failed step, so it keeps that step's output contract.
    ...(i === replacement.length - 1 ? { output: failed.output, final: failed.final } : { final: false }),
  }));

  const recreated: StepDef[] = downstream.map((id) => {
    const step = graph.steps.find((s) => s.id === id)!;
    return {
      ...step,
      id: renames.get(id)!,
      prompt: renameRefs(step.prompt, renames),
      dependsOn: step.dependsOn.map((d) => renames.get(d) ?? d),
    };
  });

  const kept = graph.steps.filter((s) => !supersede.includes(s.id));
  const result = checked([...kept, ...added, ...recreated]);
  if (!result.ok) return result;
  return {
    ok: true,
    value: { graph: result.value, meta: { supersede, added: [...added, ...recreated].map((s) => s.id) } },
  };
}
