import type { NormalizedStep, StepDef } from "../engine/types";

/** The step format the model writes. `outputJsonSchema` is a string because Gemini schemas cannot describe "any JSON Schema". */
export const PLAN_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique lowercase snake_case id, at most 40 characters." },
          prompt: { type: "string", description: "The full instructions for this step." },
          dependsOn: { type: "array", items: { type: "string" } },
          useSearch: { type: "boolean" },
          outputJsonSchema: { type: "string", description: "Optional JSON Schema, as a JSON string, when the step must return JSON." },
          final: { type: "boolean" },
        },
        required: ["id", "prompt"],
      },
    },
  },
  required: ["steps"],
} as const;

export const RESEARCH_PLAN_SCHEMA = {
  type: "object",
  properties: {
    subQuestions: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short snake_case topic name." },
          question: { type: "string" },
        },
        required: ["id", "question"],
      },
    },
  },
  required: ["subQuestions"],
} as const;

// Each planner prompt starts with one of these, which lets the demo provider recognize it.
export const GENERAL_PLAN_INTRO = "You are the planner for Relay";
export const RESEARCH_PLAN_INTRO = "You are the planner for a research workflow";
export const REPLAN_INTRO = "You repair a failed step in a running workflow";

const STEP_RULES = (searchEnabled: boolean) => `Rules for steps:
- Each step is one prompt to a language model. Write the prompt in full, as instructions a model can follow without seeing this message.
- A step uses another step's result by writing {{step_id.output}} in its prompt, which also makes it depend on that step. {{goal}} inserts the goal.
- If a step must return JSON, set outputJsonSchema to a JSON Schema written as a string. Later steps can then read fields with {{step_id.output.field}}.
- Add a dependency only when a step needs the other step's result. Work that does not depend on other work runs in parallel, so keep it independent.
- ${searchEnabled ? "Set useSearch to true for steps that need current facts from the web." : "Web search is not available. Do not set useSearch."}
- Mark the step that produces the final deliverable with final: true.
- Ids are lowercase snake_case, unique, and at most 40 characters. "goal" is reserved.`;

export function generalPlanPrompt(goal: string, searchEnabled: boolean): string {
  return `${GENERAL_PLAN_INTRO}, a workflow engine that runs language model steps as a dependency graph. Steps that do not depend on each other run at the same time.

Goal:
${goal}

Design a plan of 2 to 12 steps that reaches this goal.

${STEP_RULES(searchEnabled)}

Reply with JSON only.`;
}

export function researchPlanPrompt(goal: string): string {
  return `${RESEARCH_PLAN_INTRO}. Researchers work on sub-questions in parallel, a fact checker reviews their findings, and a writer turns everything into a cited report.

Research question:
${goal}

Split the question into 3 to 6 sub-questions that can be researched independently. Together they should cover what a careful analyst needs to answer the question, without overlapping. Give each one a short snake_case id that names its topic.

Reply with JSON only.`;
}

export function retryAppendix(previous: string, issues: string[]): string {
  return `

Your previous reply was:
${previous.slice(0, 6_000)}

It was rejected for these reasons:
${issues.map((i) => `- ${i}`).join("\n")}

Reply again with a corrected answer.`;
}

const RESEARCH_OUTPUT = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "findings"],
};

const VERIFY_OUTPUT = {
  type: "object",
  properties: {
    confirmed: { type: "array", items: { type: "string" } },
    disputed: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: { type: "string" }, reason: { type: "string" } },
        required: ["claim", "reason"],
      },
    },
  },
  required: ["confirmed", "disputed"],
};

export type SubQuestion = { id: string; question: string };

/** The fixed research shape: parallel researchers, one fact check, one cited report. */
export function buildResearchGraph(subQuestions: SubQuestion[], searchEnabled: boolean): StepDef[] {
  const tools = searchEnabled ? (["search"] as const) : ([] as const);

  const research: StepDef[] = subQuestions.map((sq) => ({
    id: sq.id,
    tools: [...tools],
    retries: 2,
    output: { type: "json", schema: RESEARCH_OUTPUT },
    prompt: `You are one researcher on a team answering this question:
{{goal}}

Your part: ${sq.question}

${
  searchEnabled
    ? "Search the web for current, specific information. Prefer primary sources and recent data."
    : "Answer from your own knowledge. Say when something may be out of date."
}

Return JSON with:
- summary: 2 to 4 sentences that answer your part.
- findings: specific claims someone could check, with numbers, dates, or names where possible.`,
  }));

  const notes = (withSources: boolean) =>
    subQuestions
      .map(
        (sq) =>
          `### ${sq.question}\n{{${sq.id}.output}}` + (withSources ? `\nSources:\n{{${sq.id}.sources}}` : ""),
      )
      .join("\n\n");

  const verify: StepDef = {
    id: "verify",
    tools: [...tools],
    retries: 2,
    output: { type: "json", schema: VERIFY_OUTPUT },
    prompt: `You are the fact checker for a research team. The question was:
{{goal}}

Findings from each researcher:

${notes(false)}

${searchEnabled ? "Use web search to check the claims that matter most and the ones that look doubtful." : "Check the claims against what you know."}

Return JSON. List claims you could confirm under confirmed. List a claim under disputed, with a reason, when sources contradict it, researchers contradict each other, or nothing supports it.`,
  };

  const write: StepDef = {
    id: "write",
    final: true,
    retries: 2,
    timeoutMs: 180_000,
    prompt: `Write a research report that answers:
{{goal}}

Research notes, with the sources each researcher used:

${notes(searchEnabled)}

Fact check:
{{verify.output}}

Requirements:
- Open with a direct answer in 2 or 3 sentences, then give sections for the main considerations.
${
  searchEnabled
    ? '- Cite sources inline as [n] and end with a "References" list of numbered titles and URLs. Number sources once across all researchers, so each URL has one number.'
    : "- There are no web sources. Do not invent citations or URLs."
}
- Do not state disputed claims as fact. Mention them only with their caveat.
- Use markdown and be concrete: numbers, names, and tradeoffs.`,
  };

  return [...research, verify, write];
}

export function replanPrompt(input: {
  goal: string;
  failed: NormalizedStep;
  error: string;
  finished: { id: string; output: string }[];
  searchEnabled: boolean;
}): string {
  const { failed } = input;
  const finished = input.finished.length
    ? input.finished.map((s) => `### ${s.id}\n${s.output.slice(0, 2_000)}`).join("\n\n")
    : "(none)";
  const jsonNote =
    failed.output.type === "json"
      ? `\nIts output had to be JSON matching this schema, and your last step must return the same shape:\n${JSON.stringify(failed.output.schema)}\n`
      : "";

  return `${REPLAN_INTRO}.

Goal of the run:
${input.goal}

The step "${failed.id}" failed after all its retries.
Its prompt was:
${failed.prompt}

Error: ${input.error}
${jsonNote}
Finished steps you can use, by id:

${finished}

Write 1 to 3 steps that produce the same result in a different way. For example, narrow the scope, split the work, rephrase the task${input.searchEnabled ? ", or drop web search if the error looks related to the search tool" : ""}. The output of your last step replaces the output of "${failed.id}" for every step that used it. Your steps may only reference the finished steps above or each other.

${STEP_RULES(input.searchEnabled)}

Reply with JSON only.`;
}
