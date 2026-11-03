import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from "./provider";
import { retryAfterMs } from "./openai-compatible";

/** Anthropic Messages API; independent from the local Claude Code adapter. */
export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.model = options.model;
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const response = await (this.options.fetchImpl ?? fetch)(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          messages: [
            {
              role: "user",
              content: req.jsonSchema
                ? `${req.prompt}\n\nReturn only JSON matching this schema, without code fences:\n${JSON.stringify(req.jsonSchema)}`
                : req.prompt,
            },
          ],
        }),
        signal: req.signal,
      },
    );
    const body = (await response.json().catch(() => null)) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    } | null;
    if (!response.ok)
      throw new LlmError(
        `Anthropic request failed (HTTP ${response.status}). Check credentials, model access and quota.`,
        {
          status: response.status,
          retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
        },
      );
    if (body?.stop_reason === "max_tokens")
      throw new LlmError(
        "Anthropic response did not complete within the output limit",
        { status: 502 },
      );
    const text = body?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (!text?.trim() || body?.stop_reason === "refusal")
      throw new LlmError("Anthropic returned no usable content", {
        status: 502,
      });
    return {
      text,
      sources: [],
      usage: {
        inputTokens: body?.usage?.input_tokens ?? 0,
        outputTokens: body?.usage?.output_tokens ?? 0,
        searchCalls: 0,
      },
    };
  }
}
