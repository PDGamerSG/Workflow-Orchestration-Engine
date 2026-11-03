import { retryAfterMs } from "./openai-compatible";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from "./provider";

/** OpenAI Responses API. Tool execution remains the local agent adapter's responsibility. */
export class OpenAiProvider implements LlmProvider {
  readonly model: string;
  constructor(private readonly options: { apiKey: string; model: string; fetchImpl?: typeof fetch }) { this.model = options.model; }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const response = await (this.options.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        input: req.jsonSchema ? `${req.prompt}\n\nReturn only valid JSON matching this schema:\n${JSON.stringify(req.jsonSchema)}` : req.prompt,
        store: false,
        max_output_tokens: 8192,
      }),
      signal: req.signal,
    });
    const body = await response.json().catch(() => null) as { status?: string; output?: { type?: string; content?: { type?: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number } } | null;
    if (!response.ok) throw new LlmError(`OpenAI request failed (HTTP ${response.status}). Check credentials, model access and quota.`, { status: response.status, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) });
    const text = body?.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("\n") ?? "";
    if (!text || body?.status === "failed" || body?.status === "incomplete") throw new LlmError("OpenAI did not complete the response", { status: 502 });
    return { text, sources: [], usage: { inputTokens: body?.usage?.input_tokens ?? 0, outputTokens: body?.usage?.output_tokens ?? 0, searchCalls: 0 } };
  }
}
