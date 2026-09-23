import { realClock } from "../engine/clock";
import type { Clock } from "../engine/types";
import type { LlmProvider, LlmRequest, LlmResult } from "./provider";

type Reply = Partial<LlmResult> | Error;
export type FakeHandler = (req: LlmRequest, call: number) => Reply | Promise<Reply>;

/**
 * A scripted provider for tests and benchmarks. Usage defaults to one token per character
 * so budgets behave predictably.
 */
export class FakeProvider implements LlmProvider {
  readonly model: string;
  readonly calls: LlmRequest[] = [];
  active = 0;
  maxActive = 0;

  private readonly handler: FakeHandler;
  private readonly delayMs: number | ((req: LlmRequest) => number);
  private readonly clock: Clock;

  constructor(handler: FakeHandler, opts: { delayMs?: number | ((req: LlmRequest) => number); clock?: Clock; model?: string } = {}) {
    this.handler = handler;
    this.delayMs = opts.delayMs ?? 0;
    this.clock = opts.clock ?? realClock;
    this.model = opts.model ?? "fake-model";
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const call = this.calls.length;
    this.calls.push(req);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const delay = typeof this.delayMs === "function" ? this.delayMs(req) : this.delayMs;
      if (delay > 0) await this.clock.sleep(delay, req.signal);
      req.signal.throwIfAborted();

      const reply = await this.handler(req, call);
      if (reply instanceof Error) throw reply;

      const text = reply.text ?? "";
      return {
        text,
        sources: reply.sources ?? [],
        usage: reply.usage ?? {
          inputTokens: req.prompt.length,
          outputTokens: text.length,
          searchCalls: req.tools?.includes("search") ? 1 : 0,
        },
      };
    } finally {
      this.active--;
    }
  }

  callsMatching(needle: string): LlmRequest[] {
    return this.calls.filter((c) => c.prompt.includes(needle));
  }
}
