import type { Source, ToolName, Usage } from "../engine/types";

export type LlmRequest = {
  prompt: string;
  tools?: ToolName[];
  /** When set, the model must answer with JSON that matches this schema. */
  jsonSchema?: Record<string, unknown>;
  signal: AbortSignal;
};

export type LlmResult = {
  text: string;
  sources: Source[];
  usage: Usage;
};

export interface LlmProvider {
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResult>;
}

/** A provider failure. `status` is the HTTP status when the API returned one. */
export class LlmError extends Error {
  override name = "LlmError";
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
