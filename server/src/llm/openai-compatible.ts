import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from "./provider";

export type OpenAiCompatibleName = "groq" | "cerebras" | "openrouter";

/**
 * Hosted APIs that speak the OpenAI chat completions format and have a free tier.
 * `rpm` is the free-tier request limit for the default model, so the engine's limiter
 * stays under it instead of collecting 429s.
 */
export const OPENAI_COMPATIBLE: Record<OpenAiCompatibleName, { baseUrl: string; keyEnv: string; model: string; rpm: number }> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", model: "openai/gpt-oss-120b", rpm: 30 },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", model: "gpt-oss-120b", rpm: 30 },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", model: "nvidia/nemotron-3-super-120b-a12b:free", rpm: 20 },
};

type ChatCompletion = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string; metadata?: { raw?: string } };
};

/**
 * A chat completions client over fetch. These APIs have no search tool, so a request
 * for one is ignored; the planner only asks for search when it is enabled.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: req.prompt }],
          response_format: req.jsonSchema
            ? { type: "json_schema", json_schema: { name: "response", schema: req.jsonSchema, strict: false } }
            : undefined,
        }),
        signal: req.signal,
      });
    } catch (err) {
      // Abort and timeout errors pass through so the engine can classify them.
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
      throw new LlmError(err instanceof Error ? err.message : String(err), { cause: err });
    }

    const body = (await res.json().catch(() => null)) as ChatCompletion | null;
    if (!res.ok) {
      throw new LlmError(readMessage(body) ?? `HTTP ${res.status}`, { status: res.status, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) });
    }
    return mapCompletion(body);
  }
}

export function mapCompletion(body: ChatCompletion | null): LlmResult {
  const choice = body?.choices?.[0];
  // OpenRouter reports an upstream failure as a 200 with an error and no choices.
  if (!choice) {
    const code = Number(body?.error?.code);
    throw new LlmError(readMessage(body) ?? "the response had no choices", { status: Number.isInteger(code) && code >= 400 ? code : 502 });
  }
  return {
    text: choice.message?.content ?? "",
    sources: [],
    usage: {
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
      searchCalls: 0,
    },
  };
}

/** OpenRouter puts the upstream provider's own message in `metadata.raw`. */
function readMessage(body: ChatCompletion | null): string | undefined {
  const message = body?.error?.message;
  const raw = body?.error?.metadata?.raw;
  if (message && raw && !message.includes(raw)) return `${message}: ${raw}`;
  return message ?? raw;
}

/** Reads a Retry-After header given in seconds. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}
