import { TokenBucket } from "../engine/rate-limiter";
import { realClock } from "../engine/clock";
import type { RunRuntime } from "../engine/engine";
import type { Store } from "../engine/store";
import { createDemoProvider } from "../llm/demo";
import { LlmError, type LlmProvider } from "../llm/provider";
import { Planner } from "../planner/planner";
import type { Connections } from "./connections";

/** Only safe public identities are persisted on runs; keys are decrypted at lease acquisition. */
export class RuntimeRegistry {
  private readonly limiters = new Map<string, TokenBucket>();
  constructor(
    private readonly options: {
      store: Store;
      connections: Connections;
      demo?: LlmProvider;
      demoDelayMs?: number;
    },
  ) {}

  resolve = async (runId: string): Promise<RunRuntime> => {
    const context = await this.options.store.getRunContext(runId);
    if (context?.connectionId && context.ownerId) {
      const { provider, config } = await this.options.connections.runtimeFor(
        context.connectionId,
        context.ownerId,
      );
      let limiter = this.limiters.get(context.connectionId);
      if (!limiter) {
        limiter = new TokenBucket({
          capacity: Math.max(1, Math.floor(config.rpm / 6)),
          refillPerSec: config.rpm / 60,
          clock: realClock,
        });
        this.limiters.set(context.connectionId, limiter);
      }
      const plannerProvider: LlmProvider = {
        model: provider.model,
        generate: async (req) => {
          const signal = AbortSignal.any([
            req.signal,
            AbortSignal.timeout(90_000),
          ]);
          await limiter.acquire(signal);
          return provider.generate({ ...req, signal });
        },
      };
      return {
        provider,
        planner: new Planner(plannerProvider, {
          searchEnabled: config.provider === "gemini" && config.searchEnabled,
        }),
        pricing: {
          inputPerM: config.inputPerM,
          outputPerM: config.outputPerM,
          searchPerK: 0,
        },
        limiter,
        cacheNamespace: `${context.ownerId}:${context.connectionId}`,
      };
    }
    const demo =
      this.options.demo ??
      createDemoProvider({ minDelayMs: this.options.demoDelayMs ?? 650 });
    let failedOnce = false;
    const provider: LlmProvider =
      context?.execution?.scenario === "retry"
        ? {
            model: demo.model,
            generate: (req) => {
              if (!failedOnce && !req.jsonSchema) {
                failedOnce = true;
                return Promise.reject(
                  new LlmError(
                    "Simulated transient overload. Relay will retry this step.",
                    { status: 503, retryAfterMs: 700 },
                  ),
                );
              }
              return demo.generate(req);
            },
          }
        : demo;
    return {
      provider,
      planner: new Planner(provider, { searchEnabled: false }),
      pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 },
      cacheNamespace: `${context?.ownerId ?? runId}:demo`,
    };
  };
}
