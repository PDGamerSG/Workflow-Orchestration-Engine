import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  test("fills defaults", () => {
    expect(loadConfig({ GOOGLE_API_KEY: "k" })).toEqual({
      provider: "gemini",
      googleApiKey: "k",
      model: "gemini-3.5-flash",
      rpm: 60,
      searchEnabled: true,
      databasePath: "data/relay.db",
      port: 4000,
      webOrigin: "http://localhost:3000",
      pricing: { inputPerM: 1.5, outputPerM: 9, searchPerK: 14 },
    });
  });

  test("parses overrides and treats empty values as unset", () => {
    const config = loadConfig({ LLM_PROVIDER: "demo", PORT: "5050", GEMINI_RPM: "", PRICE_OUTPUT_PER_M: "2.5", SEARCH_ENABLED: "false" });
    expect(config).toMatchObject({ provider: "demo", port: 5050, rpm: 60, searchEnabled: false, pricing: { outputPerM: 2.5 } });
  });

  test("requires an API key for gemini", () => {
    expect(() => loadConfig({})).toThrow(/GOOGLE_API_KEY is required/);
    expect(() => loadConfig({ GOOGLE_API_KEY: "k", PORT: "abc" })).toThrow(/PORT/);
  });
});
