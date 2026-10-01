import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  test("fills defaults", () => {
    expect(loadConfig({ GOOGLE_API_KEY: "k" })).toEqual({
      provider: "gemini",
      apiKey: "k",
      baseUrl: undefined,
      model: "gemini-3.5-flash",
      rpm: 60,
      searchEnabled: true,
      demoFailureRate: 0,
      leaseTtlMs: 30_000,
      databasePath: "data/relay.db",
      port: 4000,
      webOrigin: "http://localhost:3000",
      pricing: { inputPerM: 1.5, outputPerM: 9, searchPerK: 14 },
    });
  });

  test("parses overrides and treats empty values as unset", () => {
    const config = loadConfig({ LLM_PROVIDER: "demo", PORT: "5050", GEMINI_RPM: "", PRICE_OUTPUT_PER_M: "2.5", SEARCH_ENABLED: "false", LEASE_TTL_MS: "4000" });
    expect(config).toMatchObject({ provider: "demo", port: 5050, rpm: 60, searchEnabled: false, leaseTtlMs: 4_000, pricing: { outputPerM: 2.5 } });
  });

  test("requires an API key for gemini", () => {
    expect(() => loadConfig({})).toThrow(/GOOGLE_API_KEY: required/);
    expect(() => loadConfig({ GOOGLE_API_KEY: "k", PORT: "abc" })).toThrow(/PORT/);
  });

  test("fills free-tier defaults for an OpenAI-compatible provider", () => {
    expect(loadConfig({ LLM_PROVIDER: "groq", GROQ_API_KEY: "gk" })).toMatchObject({
      provider: "groq",
      apiKey: "gk",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-120b",
      rpm: 30,
      searchEnabled: false,
      pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 },
    });
  });

  test("lets LLM_MODEL and LLM_RPM override the provider defaults", () => {
    const config = loadConfig({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "ok", LLM_MODEL: "openrouter/free", LLM_RPM: "10" });
    expect(config).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", rpm: 10 });
  });

  test("requires the key of the chosen provider", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "cerebras", GROQ_API_KEY: "gk" })).toThrow(/CEREBRAS_API_KEY: required/);
    expect(loadConfig({ LLM_PROVIDER: "demo" }).apiKey).toBeUndefined();
  });
});
