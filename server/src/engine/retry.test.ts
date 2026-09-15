import { describe, expect, test } from "bun:test";
import { LlmError } from "../llm/provider";
import { backoffMs, classifyError, OutputValidationError } from "./retry";
import { TemplateError } from "./template";

describe("classifyError", () => {
  test("rate limits retry and keep the server's delay", () => {
    expect(classifyError(new LlmError("slow down", { status: 429, retryAfterMs: 7_000 }), false)).toEqual({
      retryable: true,
      retryAfterMs: 7_000,
      reason: "HTTP 429: slow down",
    });
  });

  test("server errors and timeouts retry", () => {
    expect(classifyError(new LlmError("oops", { status: 503 }), false).retryable).toBe(true);
    expect(classifyError(new DOMException("timed out", "TimeoutError"), false)).toMatchObject({
      retryable: true,
      reason: "timed out",
    });
    expect(classifyError(new TypeError("fetch failed"), false).retryable).toBe(true);
  });

  test("invalid JSON output retries", () => {
    expect(classifyError(new OutputValidationError("missing field"), false)).toEqual({
      retryable: true,
      reason: "invalid output: missing field",
    });
  });

  test("client errors, template errors and cancellation are fatal", () => {
    expect(classifyError(new LlmError("bad request", { status: 400 }), false).retryable).toBe(false);
    expect(classifyError(new LlmError("no key", { status: 401 }), false).retryable).toBe(false);
    expect(classifyError(new TemplateError("no value"), false).retryable).toBe(false);
    expect(classifyError(new DOMException("timed out", "TimeoutError"), true)).toEqual({
      retryable: false,
      reason: "cancelled",
    });
  });
});

describe("backoffMs", () => {
  test("doubles from one second, caps at 30 seconds, and applies 0.5x to 1.5x jitter", () => {
    const low = () => 0;
    const high = () => 1;
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, low))).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect([1, 2, 6].map((n) => backoffMs(n, high))).toEqual([1_500, 3_000, 45_000]);
  });
});
