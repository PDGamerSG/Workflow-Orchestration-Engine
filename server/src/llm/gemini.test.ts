import { describe, expect, test } from "bun:test";
import { ApiError } from "@google/genai";
import { mapError, mapResponse } from "./gemini";
import { LlmError } from "./provider";

describe("mapResponse", () => {
  test("reads text, deduplicated sources and usage", () => {
    const result = mapResponse({
      text: "Postgres scales writes better.",
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: ["postgres vs sqlite", "sqlite write concurrency"],
            groundingChunks: [
              { web: { title: "SQLite docs", uri: "https://sqlite.org/wal.html" } },
              { web: { title: "SQLite docs again", uri: "https://sqlite.org/wal.html" } },
              { web: { uri: "https://postgresql.org/docs" } },
              { retrievedContext: {} },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        toolUsePromptTokenCount: 40,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 12,
      },
    });

    expect(result).toEqual({
      text: "Postgres scales writes better.",
      sources: [
        { title: "SQLite docs", url: "https://sqlite.org/wal.html" },
        { title: "https://postgresql.org/docs", url: "https://postgresql.org/docs" },
      ],
      usage: { inputTokens: 140, outputTokens: 42, searchCalls: 1 },
    });
  });

  test("handles a response with no grounding or usage", () => {
    expect(mapResponse({ text: undefined, candidates: [] })).toEqual({
      text: "",
      sources: [],
      usage: { inputTokens: 0, outputTokens: 0, searchCalls: 0 },
    });
  });
});

describe("mapError", () => {
  test("keeps the HTTP status and reads the retry delay from a 429", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }],
      },
    });
    const mapped = mapError(new ApiError({ message: body, status: 429 }));
    expect(mapped).toBeInstanceOf(LlmError);
    expect(mapped).toMatchObject({ status: 429, retryAfterMs: 37_000, message: "Resource has been exhausted" });
  });

  test("reads fractional retry delays", () => {
    expect((mapError(new ApiError({ message: '{"retryDelay": "1.5s"}', status: 429 })) as LlmError).retryAfterMs).toBe(1_500);
  });

  test("keeps plain API errors and wraps unknown failures without a status", () => {
    expect(mapError(new ApiError({ message: "API key not valid", status: 400 }))).toMatchObject({
      status: 400,
      message: "API key not valid",
    });
    const network = mapError(new TypeError("fetch failed")) as LlmError;
    expect(network.status).toBeUndefined();
    expect(network.message).toBe("fetch failed");
  });

  test("passes abort and timeout errors through unchanged", () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(mapError(timeout)).toBe(timeout);
  });
});
