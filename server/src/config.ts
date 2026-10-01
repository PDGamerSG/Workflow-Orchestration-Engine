import { z } from "zod";
import { OPENAI_COMPATIBLE, type OpenAiCompatibleName } from "./llm/openai-compatible";
import { FREE_PRICING, GEMINI_FLASH_PRICING, type Pricing } from "./llm/pricing";

const PROVIDERS = ["gemini", "groq", "cerebras", "openrouter", "demo"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

const EnvSchema = z.object({
  LLM_PROVIDER: z.enum(PROVIDERS).default("gemini"),
  GOOGLE_API_KEY: z.string().trim().optional(),
  GROQ_API_KEY: z.string().trim().optional(),
  CEREBRAS_API_KEY: z.string().trim().optional(),
  OPENROUTER_API_KEY: z.string().trim().optional(),
  LLM_MODEL: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  LLM_RPM: z.coerce.number().int().positive().optional(),
  GEMINI_RPM: z.coerce.number().int().positive().default(60),
  SEARCH_ENABLED: z.enum(["true", "false"]).default("true"),
  DEMO_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  LEASE_TTL_MS: z.coerce.number().int().min(1_000).default(30_000),
  DATABASE_URL: z.string().trim().optional(),
  PGLITE_DIR: z.string().default("data/pglite"),
  VERCEL: z.string().optional(),
  PRICE_INPUT_PER_M: z.coerce.number().nonnegative().optional(),
  PRICE_OUTPUT_PER_M: z.coerce.number().nonnegative().optional(),
  PRICE_SEARCH_PER_K: z.coerce.number().nonnegative().optional(),
});

export type Config = {
  provider: ProviderName;
  apiKey: string | undefined;
  /** Chat completions base URL for the OpenAI-compatible providers. */
  baseUrl: string | undefined;
  model: string;
  rpm: number;
  searchEnabled: boolean;
  demoFailureRate: number;
  leaseTtlMs: number;
  /** A Postgres connection string, such as Neon's pooled one. Without it the app uses PGlite in `pgliteDir`. */
  databaseUrl: string | undefined;
  pgliteDir: string;
  pricing: Pricing;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  // Treat empty variables as unset so `FOO=` in a .env file falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error("invalid configuration:\n" + parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`).join("\n"));
  }
  const e = parsed.data;
  const provider = e.LLM_PROVIDER;
  const compatible = provider in OPENAI_COMPATIBLE ? OPENAI_COMPATIBLE[provider as OpenAiCompatibleName] : undefined;
  const keys: Record<ProviderName, { env: string; value: string | undefined } | null> = {
    gemini: { env: "GOOGLE_API_KEY", value: e.GOOGLE_API_KEY },
    groq: { env: "GROQ_API_KEY", value: e.GROQ_API_KEY },
    cerebras: { env: "CEREBRAS_API_KEY", value: e.CEREBRAS_API_KEY },
    openrouter: { env: "OPENROUTER_API_KEY", value: e.OPENROUTER_API_KEY },
    demo: null,
  };
  const key = keys[provider];
  if (key && !key.value) {
    throw new Error(`invalid configuration:\n  ${key.env}: required when LLM_PROVIDER=${provider} (set LLM_PROVIDER=demo to run without a key)`);
  }
  if (e.VERCEL && !e.DATABASE_URL) {
    throw new Error("invalid configuration:\n  DATABASE_URL: required on Vercel, whose file system is read-only (connect a Neon database)");
  }
  const basePricing = provider === "gemini" ? GEMINI_FLASH_PRICING : FREE_PRICING;
  return {
    provider,
    apiKey: key?.value,
    baseUrl: compatible?.baseUrl,
    model: e.LLM_MODEL ?? compatible?.model ?? e.GEMINI_MODEL,
    rpm: e.LLM_RPM ?? compatible?.rpm ?? e.GEMINI_RPM,
    // Only Gemini (and the demo provider that imitates it) has a search tool.
    searchEnabled: e.SEARCH_ENABLED === "true" && !compatible,
    demoFailureRate: e.DEMO_FAILURE_RATE,
    leaseTtlMs: e.LEASE_TTL_MS,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    pricing: {
      inputPerM: e.PRICE_INPUT_PER_M ?? basePricing.inputPerM,
      outputPerM: e.PRICE_OUTPUT_PER_M ?? basePricing.outputPerM,
      searchPerK: e.PRICE_SEARCH_PER_K ?? basePricing.searchPerK,
    },
  };
}
