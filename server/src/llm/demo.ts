import {
  GENERAL_PLAN_INTRO,
  REPLAN_INTRO,
  RESEARCH_PLAN_INTRO,
} from "../planner/profiles";
import { FakeProvider } from "./fake";
import { LlmError, type LlmRequest } from "./provider";

/**
 * A keyless provider for trying the dashboard. Replies take `minDelayMs` to `minDelayMs + 1000` ms.
 * Planner prompts get a working plan, other JSON requests get a value shaped like their schema,
 * and search requests return example sources.
 *
 * `failureRate` makes that share of step calls fail like an overloaded API, which is how the
 * retry, re-plan and skip paths can be watched without a key. Planner calls never fail, or
 * there would be no graph to repair.
 */
export function createDemoProvider(
  opts: { minDelayMs?: number; jitterMs?: number; failureRate?: number } = {},
): FakeProvider {
  const min = opts.minDelayMs ?? 400;
  const jitter = opts.jitterMs ?? 1_000;
  const failureRate = opts.failureRate ?? 0;
  return new FakeProvider(
    (req) => {
      if (
        failureRate > 0 &&
        !isPlannerPrompt(req) &&
        Math.random() < failureRate
      ) {
        return new LlmError("demo provider is pretending to be overloaded", {
          status: 503,
        });
      }
      return {
        text: reply(req),
        sources: req.tools?.includes("search")
          ? [
              { title: "Example source one", url: "https://example.com/one" },
              { title: "Example source two", url: "https://example.org/two" },
            ]
          : [],
      };
    },
    { delayMs: () => min + Math.floor(Math.random() * jitter), model: "demo" },
  );
}

function isPlannerPrompt(req: LlmRequest): boolean {
  return [RESEARCH_PLAN_INTRO, GENERAL_PLAN_INTRO, REPLAN_INTRO].some((intro) =>
    req.prompt.startsWith(intro),
  );
}

function reply(req: LlmRequest): string {
  if (req.prompt.startsWith(RESEARCH_PLAN_INTRO)) {
    return JSON.stringify({
      subQuestions: [
        {
          id: "background",
          question: "What is the background and current state of the topic?",
        },
        {
          id: "options",
          question: "What are the main options and how do they compare?",
        },
        { id: "risks", question: "What risks and open questions remain?" },
      ],
    });
  }
  if (req.prompt.startsWith(GENERAL_PLAN_INTRO)) {
    return JSON.stringify({
      steps: [
        {
          id: "understand",
          prompt:
            "Restate the goal and list what a good result needs: {{goal}}",
        },
        { id: "ideas", prompt: "List three different approaches to: {{goal}}" },
        { id: "risks", prompt: "List the main risks for: {{goal}}" },
        {
          id: "result",
          prompt:
            "Combine {{understand.output}}, {{ideas.output}} and {{risks.output}} into a final answer.",
          final: true,
        },
      ],
    });
  }
  if (req.prompt.startsWith(REPLAN_INTRO)) {
    return JSON.stringify({
      steps: [
        {
          id: "alternative",
          prompt: "Produce the result of the failed step a simpler way.",
        },
      ],
    });
  }
  if (req.jsonSchema) return JSON.stringify(sampleFromSchema(req.jsonSchema));

  const topic = req.prompt
    .split("\n")
    .find((line) => line.trim())!
    .replace(/[#>*`]/g, "")
    .trim()
    .slice(0, 120);
  return demoAnswer(topic);
}

/** Scripted teaching material, visibly distinct from real research or generated answers. */
function demoAnswer(topic: string): string {
  const heading = "## Demo answer\n\n";
  if (/DAG scheduler|ready steps|dependency-ready/i.test(topic))
    return (
      heading +
      "### Start from dependency readiness\n\nA step is ready when every dependency has succeeded. Three independent analyses can run together; synthesis waits for all three saved outputs.\n\nRelay checks readiness whenever a step settles, so a slow branch does not delay an unrelated branch. The concurrency setting caps calls in flight.\n\n*Scripted explanation for the demo.*"
    );
  if (/Postgres checkpoints|lease|fenced writes/i.test(topic))
    return (
      heading +
      "### Save progress before moving on\n\nThe worker claims an expiring lease and renews it with heartbeats. Step state and its event commit together in Postgres. A stale worker cannot write after ownership changes.\n\nIf the worker stops, the next request can claim the expired lease and resume pending work. Finished steps keep their outputs; interrupted calls may repeat.\n\n*Scripted explanation for the demo.*"
    );
  if (/model\/tool loop|agent loop|Pi, Claude Code/i.test(topic))
    return (
      heading +
      "### Agent loops inside a workflow\n\nPi, Claude Code and Codex each manage a model conversation and tool loop. Relay coordinates separate invocations: dependencies, parallelism, retries, checkpoints and final synthesis.\n\nThe local adapters normalize final text and reported token usage. The hosted playground uses API providers and never launches local commands.\n\n*Scripted explanation for the demo.*"
    );
  if (
    /technical walkthrough of Relay|Summarize how this workflow recovered/i.test(
      topic,
    )
  )
    return (
      heading +
      "### One graph, persistent progress\n\n1. **Validate the plan.** Reject missing dependencies, duplicate ids and cycles.\n2. **Launch ready work.** Independent branches run together within the concurrency limit.\n3. **Save each result.** Outputs and events commit before downstream prompts use them.\n4. **Handle failures.** Temporary errors retry. A new worker can recover a run after lease expiry.\n5. **Join the evidence.** Synthesis reads the saved branch outputs. Every attempt remains visible in the timeline.\n\nExecution is at least once. An interrupted model call can repeat, so side-effecting tools need idempotency.\n\n*This is a scripted walkthrough. Connect a provider to generate a response to your own goal.*"
    );
  if (/503|transient|temporary/i.test(topic))
    return (
      heading +
      "### Retry a temporary failure\n\nA transient API error does not invalidate the workflow. Relay records the failed attempt, waits with bounded exponential backoff, then calls the provider again. Other ready branches continue.\n\nHTTP 400-class errors other than rate limits stop immediately. Cancellation stops launches and fences future writes.\n\n*Scripted explanation for the reliability lab.*"
    );
  if (/JSON|product brief/i.test(topic))
    return (
      heading +
      "### A brief built from structured inputs\n\nThe first step returns JSON checked against a schema. This step reads selected fields from that saved result through templates.\n\n- **Audience:** developers inspecting workflow execution.\n- **Priority:** show attempts, status and token usage beside each step.\n- **Risk:** preserve successful work across a worker restart.\n\n*Scripted brief for the structured-data demo.*"
    );
  return (
    heading +
    `### A completed step in the graph\n\nThis simulated step received:\n\n> ${topic}\n\nIts output is saved before dependent steps start. The inspector shows the resolved prompt, attempt count, execution time and simulated token usage.\n\nUse the graph to follow how independent work joins into a final result. Connect your own provider for an answer tailored to this prompt.\n\n*Scripted demonstration; no model API or live research was used.*`
  );
}

/** Builds a small value that satisfies common JSON Schema shapes. */
export function sampleFromSchema(schema: unknown): unknown {
  const s = (schema ?? {}) as Record<string, unknown>;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(props).map(([key, value]) => [
          key,
          sampleFromSchema(value),
        ]),
      );
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 2;
      return Array.from({ length: Math.max(min, 1) }, () =>
        sampleFromSchema(s.items),
      );
    }
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return "sample";
  }
}
