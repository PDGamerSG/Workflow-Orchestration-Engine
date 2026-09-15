import { createHash } from "node:crypto";
import type { ToolName } from "./types";

/** Identical model, prompt, tools and schema give the same key. */
export function cacheKey(model: string, prompt: string, tools: ToolName[], schema: Record<string, unknown> | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify([model, prompt, [...tools].sort(), schema ?? null]))
    .digest("hex");
}
