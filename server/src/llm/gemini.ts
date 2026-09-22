import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import type { Source } from "../engine/types";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from "./provider";

/**
 * Gemini through @google/genai. The SDK's own retries stay off (no retryOptions),
 * so the engine is the only layer that decides when to try again.
 */
export class GeminiProvider implements LlmProvider {
  readonly model: string;
  private readonly ai: GoogleGenAI;

  constructor(opts: { apiKey: string; model: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: req.prompt,
        config: {
          abortSignal: req.signal,
          tools: req.tools?.includes("search") ? [{ googleSearch: {} }] : undefined,
          responseMimeType: req.jsonSchema ? "application/json" : undefined,
          responseJsonSchema: req.jsonSchema,
        },
      });
      return mapResponse(response);
    } catch (err) {
      throw mapError(err);
    }
  }
}

type ResponseLike = Pick<GenerateContentResponse, "candidates" | "usageMetadata"> & { text?: string };

/** True for the http and https URLs that are safe to render as a link. */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function mapResponse(response: ResponseLike): LlmResult {
  const grounding = response.candidates?.[0]?.groundingMetadata;

  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const chunk of grounding?.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    // A citation ends up as a link in the dashboard, so only web URLs are kept.
    if (!url || seen.has(url) || !isWebUrl(url)) continue;
    seen.add(url);
    sources.push({ title: chunk.web?.title || url, url });
  }

  const usage = response.usageMetadata;
  return {
    text: response.text ?? "",
    sources,
    usage: {
      inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      // Gemini bills grounding per request that ran at least one search.
      searchCalls: grounding?.webSearchQueries?.length ? 1 : 0,
    },
  };
}

/** Turns SDK errors into LlmError. Abort and timeout errors pass through so the engine can classify them. */
export function mapError(err: unknown): Error {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return err;

  if (err instanceof ApiError) {
    const delay = err.message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    return new LlmError(readMessage(err.message), {
      status: err.status,
      retryAfterMs: delay ? Math.round(Number(delay[1]) * 1_000) : undefined,
      cause: err,
    });
  }

  return new LlmError(err instanceof Error ? err.message : String(err), { cause: err });
}

/** The SDK puts the raw JSON error body in `message`. Pull out the human-readable part when it is there. */
function readMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON: use the message as is.
  }
  return raw;
}
