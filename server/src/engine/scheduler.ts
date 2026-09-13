import { Ajv, type ValidateFunction } from "ajv";
import type { LlmProvider } from "../llm/provider";
import { costUsd, type Pricing } from "../llm/pricing";
import { cacheKey } from "./cache";
import { commit, type EventBus, type PendingEvent } from "./events";
import { descendants } from "./graph";
import type { TokenBucket } from "./rate-limiter";
import { backoffMs, classifyError, OutputValidationError } from "./retry";
import type { RunRow, StepPatch, StepRow, Store } from "./store";
import { renderTemplate, type TemplateContext } from "./template";
import type { Clock, NormalizedGraph, NormalizedStep, RunStatus, Usage } from "./types";

export type SchedulerDeps = {
  store: Store;
  provider: LlmProvider;
  limiter: TokenBucket;
  clock: Clock;
  bus: EventBus;
  workerId: string;
  pricing: Pricing;
  random?: () => number;
};

/**
 * Called after a step fails for good. Returns true when it installed a new graph version,
 * in which case the scheduler reloads the graph and carries on.
 */
export type FailureHook = (stepId: string, error: string, signal: AbortSignal) => Promise<boolean>;

/**
 * `lost`: another worker took the lease, nothing more was written.
 * `aborted`: the caller's signal fired. In-flight steps stay `running` for the caller to clean up.
 */
export type SchedulerResult = Extract<RunStatus, "succeeded" | "failed"> | "lost" | "aborted";

class LeaseLost extends Error {
  override name = "LeaseLost";
}

const ajv = new Ajv({ allErrors: true, strict: false });

/** Runs one run's graph until every step settles. One scheduler per run, owned by the lease holder. */
export class RunScheduler {
  private readonly runId: string;
  private readonly deps: SchedulerDeps;
  private readonly onStepFailed?: FailureHook;
  private readonly controller = new AbortController();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly validators = new Map<string, ValidateFunction>();

  private runRow!: RunRow;
  private graph!: NormalizedGraph;
  private steps = new Map<string, StepRow>();
  private budgetExceeded = false;
  private lost = false;
  private hookChain: Promise<unknown> = Promise.resolve();

  constructor(runId: string, deps: SchedulerDeps, opts: { onStepFailed?: FailureHook } = {}) {
    this.runId = runId;
    this.deps = deps;
    this.onStepFailed = opts.onStepFailed;
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  async run(signal: AbortSignal): Promise<SchedulerResult> {
    const stop = () => this.controller.abort(signal.reason);
    if (signal.aborted) return "aborted";
    signal.addEventListener("abort", stop, { once: true });

    try {
      this.reload();
      for (;;) {
        if (this.signal.aborted) break;
        this.checkBudget();
        this.launchReady();
        if (this.inFlight.size === 0) break;
        await Promise.race(this.inFlight.values());
      }
      if (!this.signal.aborted) {
        await this.hookChain;
        return this.finish();
      }
    } catch (err) {
      if (!(err instanceof LeaseLost)) throw err;
    } finally {
      signal.removeEventListener("abort", stop);
    }

    // Let in-flight attempts observe the abort before handing control back.
    await Promise.allSettled(this.inFlight.values());
    return this.lost ? "lost" : "aborted";
  }

  private reload() {
    const run = this.deps.store.getRun(this.runId);
    if (!run?.graph) throw new Error(`run ${this.runId} has no graph`);
    this.runRow = run;
    this.graph = run.graph;
    this.steps = new Map(this.deps.store.getSteps(this.runId).map((s) => [s.stepId, s]));
  }

  private def(id: string): NormalizedStep {
    return this.graph.steps.find((s) => s.id === id)!;
  }

  private launchReady() {
    if (this.budgetExceeded) return;
    for (const id of this.graph.order) {
      if (this.inFlight.size >= this.runRow.concurrency) return;
      const row = this.steps.get(id);
      if (row?.status !== "pending" || this.inFlight.has(id)) continue;
      if (!this.def(id).dependsOn.every((dep) => this.steps.get(dep)?.status === "succeeded")) continue;

      // Mark the step running in memory before execute starts. A cache hit finishes synchronously,
      // and its result must not be overwritten here afterwards.
      this.steps.set(id, { ...row, status: "running" });
      const task = this.execute(id).finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, task.catch((err) => this.onTaskError(err)));
    }
  }

  private onTaskError(err: unknown) {
    if (err instanceof LeaseLost || this.signal.aborted) return;
    // A bug inside execute. Stop the run rather than leave it half-scheduled.
    this.controller.abort(err);
    throw err;
  }

  private checkBudget() {
    if (this.budgetExceeded) return;
    const { budgetTokens, budgetUsd } = this.runRow;
    if (budgetTokens === null && budgetUsd === null) return;

    const totals = this.deps.store.totals(this.runId);
    const overTokens = budgetTokens !== null && totals.inputTokens + totals.outputTokens >= budgetTokens;
    const overUsd = budgetUsd !== null && totals.costUsd >= budgetUsd;
    if (!overTokens && !overUsd) return;

    this.budgetExceeded = true;
    const pending = [...this.steps.values()].filter((s) => s.status === "pending").map((s) => s.stepId);
    this.write(
      () => pending.every((id) => this.patchStep(id, { status: "skipped", error: "budget exceeded" })),
      [
        ["run.budget_exceeded", { totals, budgetTokens, budgetUsd }],
        ...pending.map((stepId) => ["step.skipped", { stepId, reason: "budget exceeded" }] as PendingEvent),
      ],
    );
  }

  private async execute(id: string): Promise<void> {
    const def = this.def(id);
    let attempt = this.steps.get(id)!.attempt;
    let rejection: string | null = null;

    for (;;) {
      if (this.signal.aborted) return;
      attempt++;

      let prompt: string;
      try {
        prompt = renderTemplate(def.prompt, this.templateContext());
      } catch (err) {
        this.writeStarted(id, attempt, null);
        return this.fail(id, attempt, classifyError(err, false).reason);
      }
      if (rejection) {
        prompt += `\n\nYour previous answer was rejected: ${rejection}. Reply again with JSON that matches the schema.`;
      }
      this.writeStarted(id, attempt, prompt);

      const schema = def.output.type === "json" ? def.output.schema : undefined;
      const key = def.cache ? cacheKey(this.deps.provider.model, prompt, def.tools, schema) : null;
      const hit = key ? this.deps.store.cacheGet(key) : null;
      if (hit) return this.succeed(id, attempt, hit.output, hit.sources, true);

      try {
        const result = await this.callProvider(def, prompt, schema);
        this.recordUsage(id, result.usage);
        if (schema) this.validateJson(def, result.text);
        if (key) this.deps.store.cachePut(key, result.text, result.sources, this.deps.clock.now());
        return this.succeed(id, attempt, result.text, result.sources, false);
      } catch (err) {
        if (err instanceof LeaseLost || this.signal.aborted) return;

        const classified = classifyError(err, false);
        rejection = err instanceof OutputValidationError ? err.message : null;
        if (!classified.retryable || attempt > def.retries) return this.fail(id, attempt, classified.reason);

        const delayMs = classified.retryAfterMs ?? backoffMs(attempt, this.deps.random);
        this.write(
          () => this.patchStep(id, { error: classified.reason }),
          [["step.retrying", { stepId: id, attempt, error: classified.reason, delayMs }]],
        );
        try {
          await this.deps.clock.sleep(delayMs, this.signal);
        } catch {
          return;
        }
      }
    }
  }

  private async callProvider(def: NormalizedStep, prompt: string, schema: Record<string, unknown> | undefined) {
    await this.deps.limiter.acquire(this.signal);

    // The timeout runs on the injected clock so tests can drive it.
    const attempt = new AbortController();
    const onStop = () => attempt.abort(this.signal.reason);
    this.signal.addEventListener("abort", onStop, { once: true });
    const timer = new AbortController();
    this.deps.clock.sleep(def.timeoutMs, timer.signal).then(
      () => attempt.abort(new DOMException("timed out", "TimeoutError")),
      () => {},
    );

    try {
      return await this.deps.provider.generate({
        prompt,
        tools: def.tools.length ? def.tools : undefined,
        jsonSchema: schema,
        signal: attempt.signal,
      });
    } catch (err) {
      // A provider may throw its own abort error. Report the reason the attempt was aborted.
      if (attempt.signal.aborted && !this.signal.aborted) throw attempt.signal.reason;
      throw err;
    } finally {
      timer.abort();
      this.signal.removeEventListener("abort", onStop);
    }
  }

  private validateJson(def: NormalizedStep, text: string) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new OutputValidationError("not valid JSON");
    }
    let validate = this.validators.get(def.id);
    if (!validate) {
      validate = ajv.compile((def.output as { schema: Record<string, unknown> }).schema);
      this.validators.set(def.id, validate);
    }
    if (!validate(value)) {
      const details = (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
      throw new OutputValidationError(details || "does not match the schema");
    }
  }

  private templateContext(): TemplateContext {
    const steps: TemplateContext["steps"] = new Map();
    for (const row of this.steps.values()) {
      if (row.status === "succeeded" && row.output !== null) steps.set(row.stepId, { output: row.output, sources: row.sources });
    }
    return { goal: this.runRow.goal, steps };
  }

  private writeStarted(id: string, attempt: number, prompt: string | null) {
    const now = this.deps.clock.now();
    this.write(
      () => this.patchStep(id, { status: "running", attempt, resolvedPrompt: prompt, error: null, startedAt: now, finishedAt: null }),
      [["step.started", { stepId: id, attempt, startedAt: now }]],
    );
  }

  private recordUsage(id: string, usage: Usage) {
    const cost = costUsd(usage, this.deps.pricing);
    this.write(() => {
      if (!this.deps.store.addStepUsage(this.runId, id, usage, cost, this.deps.workerId)) return false;
      const row = this.steps.get(id)!;
      this.steps.set(id, {
        ...row,
        inputTokens: row.inputTokens + usage.inputTokens,
        outputTokens: row.outputTokens + usage.outputTokens,
        searchCalls: row.searchCalls + usage.searchCalls,
        costUsd: row.costUsd + cost,
      });
      return true;
    }, []);
  }

  private succeed(id: string, attempt: number, output: string, sources: StepRow["sources"], cached: boolean) {
    if (this.signal.aborted) return;
    const now = this.deps.clock.now();
    this.write(
      () => this.patchStep(id, { status: "succeeded", output, sources, cached, error: null, finishedAt: now }),
      [["step.succeeded", { stepId: id, attempt, output, sources, cached, finishedAt: now, usage: this.usageOf(id) }]],
    );
  }

  private async fail(id: string, attempt: number, error: string) {
    const now = this.deps.clock.now();
    this.write(
      () => this.patchStep(id, { status: "failed", error, finishedAt: now }),
      [["step.failed", { stepId: id, attempt, error, finishedAt: now, usage: this.usageOf(id) }]],
    );

    // Hooks run one at a time. Two branches failing together must not replan over each other.
    const replaced = await (this.hookChain = this.hookChain.then(async () => {
      if (!this.onStepFailed || this.signal.aborted) return false;
      if (this.deps.store.getSteps(this.runId).find((s) => s.stepId === id)?.status !== "failed") return false;
      try {
        return await this.onStepFailed(id, error, this.signal);
      } catch (err) {
        console.error(`[relay] failure hook for ${this.runId}/${id} threw`, err);
        return false;
      }
    }));
    if (this.signal.aborted) return;

    if (replaced) {
      this.reload();
      return;
    }

    const skip = [...descendants(this.graph, id)].filter((d) => this.steps.get(d)?.status === "pending");
    const reason = `upstream step "${id}" failed`;
    this.write(
      () => skip.every((d) => this.patchStep(d, { status: "skipped", error: reason })),
      skip.map((stepId) => ["step.skipped", { stepId, reason }]),
    );
  }

  private finish(): SchedulerResult {
    // Anything still pending could never become ready. Close it out so the run has a clear end state.
    const stranded = [...this.steps.values()].filter((s) => s.status === "pending").map((s) => s.stepId);
    if (stranded.length) {
      this.write(
        () => stranded.every((id) => this.patchStep(id, { status: "skipped", error: "not reachable" })),
        stranded.map((stepId) => ["step.skipped", { stepId, reason: "not reachable" }]),
      );
    }

    const live = [...this.steps.values()].filter((s) => s.status !== "superseded");
    const failed = live.filter((s) => s.status === "failed");
    const status = live.every((s) => s.status === "succeeded") ? "succeeded" : "failed";
    const error =
      status === "succeeded"
        ? null
        : this.budgetExceeded
          ? "budget exceeded"
          : failed.map((s) => `step "${s.stepId}" failed: ${s.error}`).join("; ") || "run did not complete";

    const totals = this.deps.store.totals(this.runId);
    this.write(
      () => this.deps.store.setRunStatus(this.runId, status, error, this.deps.clock.now(), this.deps.workerId),
      [[`run.${status}`, { error, totals }]],
    );
    return status;
  }

  private usageOf(id: string) {
    const row = this.steps.get(id)!;
    return { inputTokens: row.inputTokens, outputTokens: row.outputTokens, searchCalls: row.searchCalls, costUsd: row.costUsd };
  }

  /** Writes to the store and mirrors the change in memory. False when the lease is gone. */
  private patchStep(id: string, patch: StepPatch): boolean {
    if (!this.deps.store.updateStep(this.runId, id, patch, this.deps.workerId)) return false;
    this.steps.set(id, { ...this.steps.get(id)!, ...patch });
    return true;
  }

  /**
   * Applies `mutate` and appends `events` in one transaction. If a fenced write fails,
   * the transaction rolls back and the scheduler stops with LeaseLost.
   */
  private write(mutate: () => boolean, events: PendingEvent[]): void {
    const before = new Map(this.steps);
    if (commit(this.deps, this.runId, mutate, events)) return;
    this.steps = before;
    this.lost = true;
    const err = new LeaseLost();
    this.controller.abort(err);
    throw err;
  }
}
