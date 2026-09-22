import { describe, expect, test } from "bun:test";
import { ApiError } from "@google/genai";
import { isWebUrl, mapError, mapResponse } from "./gemini";
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

  test("drops citations that are not web links", () => {
    const result = mapResponse({
      text: "answer",
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { title: "Real source", uri: "https://example.com/a" } },
              { web: { title: "Script", uri: "javascript:alert(1)" } },
              { web: { title: "Inline", uri: "data:text/html,<script>alert(1)</script>" } },
              { web: { title: "Nonsense", uri: "not a url" } },
            ],
          },
        },
      ],
    });

    expect(result.sources).toEqual([{ title: "Real source", url: "https://example.com/a" }]);
  });

  test("handles a response with no grounding or usage", () => {
    expect(mapResponse({ text: undefined, candidates: [] })).toEqual({
      text: "",
      sources: [],
      usage: { inputTokens: 0, outputTokens: 0, searchCalls: 0 },
    });
  });
});

describe("isWebUrl", () => {
  test("accepts http and https only", () => {
    expect(isWebUrl("https://example.com")).toBe(true);
    expect(isWebUrl("http://example.com/path?q=1")).toBe(true);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("JavaScript:alert(1)")).toBe(false);
    expect(isWebUrl("data:text/html,x")).toBe(false);
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(isWebUrl("")).toBe(false);
    expect(isWebUrl("//example.com")).toBe(false);
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
