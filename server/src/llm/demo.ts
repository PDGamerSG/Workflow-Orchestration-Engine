import { FakeProvider } from "./fake";
import type { LlmRequest } from "./provider";

/**
 * A keyless provider for trying the dashboard. Replies take 0.4 to 1.4 seconds, JSON requests get
 * a value shaped like their schema, and search requests return example sources.
 */
export function createDemoProvider(): FakeProvider {
  return new FakeProvider(
    (req) => ({
      text: req.jsonSchema ? JSON.stringify(sampleFromSchema(req.jsonSchema)) : demoText(req),
      sources: req.tools?.includes("search")
        ? [
            { title: "Example source one", url: "https://example.com/one" },
            { title: "Example source two", url: "https://example.org/two" },
          ]
        : [],
    }),
    { delayMs: () => 400 + Math.floor(Math.random() * 1_000), model: "demo" },
  );
}

function demoText(req: LlmRequest): string {
  const topic = req.prompt.split("\n")[0]!.slice(0, 120);
  return `## Demo answer\n\nThis is placeholder output from the demo provider for:\n\n> ${topic}\n\n- Point one [1]\n- Point two [2]`;
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
