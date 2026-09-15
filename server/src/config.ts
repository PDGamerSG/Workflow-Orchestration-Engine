import { z } from "zod";
import { GEMINI_FLASH_PRICING, type Pricing } from "./llm/pricing";

const EnvSchema = z
  .object({
    LLM_PROVIDER: z.enum(["gemini", "demo"]).default("gemini"),
    GOOGLE_API_KEY: z.string().trim().optional(),
    GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
    GEMINI_RPM: z.coerce.number().int().positive().default(60),
    SEARCH_ENABLED: z.enum(["true", "false"]).default("true"),
    DATABASE_PATH: z.string().default("data/relay.db"),
    PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
    WEB_ORIGIN: z.string().default("http://localhost:3000"),
    PRICE_INPUT_PER_M: z.coerce.number().nonnegative().default(GEMINI_FLASH_PRICING.inputPerM),
    PRICE_OUTPUT_PER_M: z.coerce.number().nonnegative().default(GEMINI_FLASH_PRICING.outputPerM),
    PRICE_SEARCH_PER_K: z.coerce.number().nonnegative().default(GEMINI_FLASH_PRICING.searchPerK),
  })
  .refine((env) => env.LLM_PROVIDER !== "gemini" || !!env.GOOGLE_API_KEY, {
    message: "GOOGLE_API_KEY is required when LLM_PROVIDER=gemini (set LLM_PROVIDER=demo to run without a key)",
  });

export type Config = {
  provider: "gemini" | "demo";
  googleApiKey: string | undefined;
  model: string;
  rpm: number;
  searchEnabled: boolean;
  databasePath: string;
  port: number;
  webOrigin: string;
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
  return {
    provider: e.LLM_PROVIDER,
    googleApiKey: e.GOOGLE_API_KEY,
    model: e.GEMINI_MODEL,
    rpm: e.GEMINI_RPM,
    searchEnabled: e.SEARCH_ENABLED === "true",
    databasePath: e.DATABASE_PATH,
    port: e.PORT,
    webOrigin: e.WEB_ORIGIN,
    pricing: { inputPerM: e.PRICE_INPUT_PER_M, outputPerM: e.PRICE_OUTPUT_PER_M, searchPerK: e.PRICE_SEARCH_PER_K },
  };
}
