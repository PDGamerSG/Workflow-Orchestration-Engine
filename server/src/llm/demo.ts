import { GENERAL_PLAN_INTRO, REPLAN_INTRO, RESEARCH_PLAN_INTRO } from "../planner/profiles";
import { FakeProvider } from "./fake";
import type { LlmRequest } from "./provider";

/**
 * A keyless provider for trying the dashboard. Replies take `minDelayMs` to `minDelayMs + 1000` ms.
 * Planner prompts get a working plan, other JSON requests get a value shaped like their schema,
 * and search requests return example sources.
 */
export function createDemoProvider(opts: { minDelayMs?: number; jitterMs?: number } = {}): FakeProvider {
  const min = opts.minDelayMs ?? 400;
  const jitter = opts.jitterMs ?? 1_000;
  return new FakeProvider(
    (req) => ({
      text: reply(req),
      sources: req.tools?.includes("search")
        ? [
            { title: "Example source one", url: "https://example.com/one" },
            { title: "Example source two", url: "https://example.org/two" },
          ]
        : [],
    }),
    { delayMs: () => min + Math.floor(Math.random() * jitter), model: "demo" },
  );
}

function reply(req: LlmRequest): string {
  if (req.prompt.startsWith(RESEARCH_PLAN_INTRO)) {
    return JSON.stringify({
      subQuestions: [
        { id: "background", question: "What is the background and current state of the topic?" },
        { id: "options", question: "What are the main options and how do they compare?" },
        { id: "risks", question: "What risks and open questions remain?" },
      ],
    });
  }
  if (req.prompt.startsWith(GENERAL_PLAN_INTRO)) {
    return JSON.stringify({
      steps: [
        { id: "understand", prompt: "Restate the goal and list what a good result needs: {{goal}}" },
        { id: "ideas", prompt: "List three different approaches to: {{goal}}" },
        { id: "risks", prompt: "List the main risks for: {{goal}}" },
        { id: "result", prompt: "Combine {{understand.output}}, {{ideas.output}} and {{risks.output}} into a final answer.", final: true },
      ],
    });
  }
  if (req.prompt.startsWith(REPLAN_INTRO)) {
    return JSON.stringify({ steps: [{ id: "alternative", prompt: "Produce the result of the failed step a simpler way." }] });
  }
  if (req.jsonSchema) return JSON.stringify(sampleFromSchema(req.jsonSchema));

  const topic = req.prompt.split("\n").find((line) => line.trim())!.slice(0, 120);
  return `## Demo answer\n\nPlaceholder output from the demo provider for:\n\n> ${topic}\n\n- First point [1]\n- Second point [2]`;
}

/** Builds a small value that satisfies common JSON Schema shapes. */
export function sampleFromSchema(schema: unknown): unknown {
  const s = (schema ?? {}) as Record<string, unknown>;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(props).map(([key, value]) => [key, sampleFromSchema(value)]));
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 2;
      return Array.from({ length: Math.max(min, 1) }, () => sampleFromSchema(s.items));
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
