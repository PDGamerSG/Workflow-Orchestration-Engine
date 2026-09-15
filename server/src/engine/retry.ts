import { LlmError } from "../llm/provider";
import { TemplateError } from "./template";

/** The model answered, but the answer was not valid JSON for the step's schema. */
export class OutputValidationError extends Error {
  override name = "OutputValidationError";
}

export type Classified = { retryable: boolean; retryAfterMs?: number; reason: string };

/**
 * Decides whether a failed attempt is worth repeating.
 * `signalAborted` is true when the run itself was cancelled, which is never retried.
 */
export function classifyError(err: unknown, signalAborted: boolean): Classified {
  if (signalAborted) return { retryable: false, reason: "cancelled" };

  if (err instanceof TemplateError) return { retryable: false, reason: err.message };
  if (err instanceof OutputValidationError) return { retryable: true, reason: `invalid output: ${err.message}` };

  if (err instanceof LlmError) {
    const reason = err.status ? `HTTP ${err.status}: ${err.message}` : err.message;
    if (err.status === 429) return { retryable: true, retryAfterMs: err.retryAfterMs, reason };
    if (err.status !== undefined && err.status >= 400 && err.status < 500) return { retryable: false, reason };
    return { retryable: true, reason };
  }

  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return { retryable: true, reason: "timed out" };
  }

  // Network failures and anything unexpected get another attempt. The retry limit bounds the cost.
  return { retryable: true, reason: err instanceof Error ? err.message : String(err) };
}

/** Exponential backoff from one second, capped at 30 seconds, with 0.5x to 1.5x jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + random()));
}
