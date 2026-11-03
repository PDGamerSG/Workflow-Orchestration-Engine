import { z } from "zod";
import { AnthropicProvider } from "../llm/anthropic";
import { GeminiProvider } from "../llm/gemini";
import { OpenAiProvider } from "../llm/openai";
import { OPENAI_COMPATIBLE, OpenAiCompatibleProvider } from "../llm/openai-compatible";
import { LlmError, type LlmProvider } from "../llm/provider";

export const PROVIDER_CATALOG = [
  { id: "openai", name: "OpenAI", model: "gpt-4.1-mini", keyUrl: "https://platform.openai.com/api-keys", search: false, rpm: 60 },
  { id: "anthropic", name: "Anthropic", model: "claude-sonnet-4-6", keyUrl: "https://platform.claude.com/settings/keys", search: false, rpm: 30 },
  { id: "gemini", name: "Google Gemini", model: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey", search: true, rpm: 5 },
  { id: "groq", name: "Groq", model: OPENAI_COMPATIBLE.groq.model, keyUrl: "https://console.groq.com/keys", search: false, rpm: 30 },
  { id: "cerebras", name: "Cerebras", model: OPENAI_COMPATIBLE.cerebras.model, keyUrl: "https://cloud.cerebras.ai", search: false, rpm: 30 },
  { id: "openrouter", name: "OpenRouter", model: OPENAI_COMPATIBLE.openrouter.model, keyUrl: "https://openrouter.ai/keys", search: false, rpm: 20 },
] as const;

export const ConnectionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  provider: z.enum(["openai", "anthropic", "gemini", "groq", "cerebras", "openrouter"]),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().trim().min(1).max(4096),
  rpm: z.number().int().min(1).max(60_000).default(30),
  inputPerM: z.number().min(0).max(10_000).default(0),
  outputPerM: z.number().min(0).max(10_000).default(0),
  searchEnabled: z.boolean().default(false),
});
export type ConnectionConfig = z.output<typeof ConnectionSchema>;
export type ProviderFactory = (config: ConnectionConfig) => LlmProvider;

export const providerFromConnection: ProviderFactory = (config) => {
  const provider = config.provider === "openai" ? new OpenAiProvider(config)
    : config.provider === "anthropic" ? new AnthropicProvider(config)
    : config.provider === "gemini" ? new GeminiProvider(config)
    : new OpenAiCompatibleProvider({ ...config, baseUrl: OPENAI_COMPATIBLE[config.provider].baseUrl });
  return {
    model: provider.model,
    async generate(req) {
      try { return await provider.generate(req); }
      catch (error) {
        if (req.signal.aborted) throw error;
        // Provider SDK exceptions can embed request URLs or headers. Never persist them.
        throw new LlmError(`${config.provider} request failed${error instanceof LlmError && error.status ? ` (HTTP ${error.status})` : ""}. Check model access, API key and quota.`, { status: error instanceof LlmError ? error.status : undefined, retryAfterMs: error instanceof LlmError ? error.retryAfterMs : undefined });
      }
    },
  };
};
