import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LlmProvider } from "../llm/provider";
import { costUsd, type Pricing } from "../llm/pricing";
import { PlanningError, type Planner } from "../planner/planner";
import { realClock } from "./clock";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { commit, type PendingEvent } from "./events";
import { validateGraph } from "./graph";
import { newRunId } from "./ids";
import { TokenBucket } from "./rate-limiter";
import { RunScheduler, type FailureHook, type SchedulerDeps } from "./scheduler";
import type { Store } from "./store";
import { TERMINAL_RUN_STATUSES, type Clock } from "./types";

export type EngineOptions = {
  store: Store;
  provider: LlmProvider;
  pricing: Pricing;
  /** Requests per minute allowed to the provider, shared by every run in this process. */
  rpm: number;
  clock?: Clock;
  workerId?: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  sweepMs?: number;
  random?: () => number;
  /** Needed for goal runs and for re-planning failed branches. */
  planner?: Planner;
};

export const CreateRunSchema = z
  .object({
    graph: z.unknown().optional(),
    goal: z.string().trim().min(3).max(4_000).optional(),
    profile: z.enum(["general", "research"]).default("general"),
    concurrency: z.number().int().min(1).max(16).default(4),
    maxReplans: z.number().int().min(0).max(5).default(2),
    budget: z
      .object({
        tokens: z.number().int().positive().optional(),
        usd: z.number().positive().optional(),
      })
      .optional(),
  })
  .refine((v) => (v.graph === undefined) !== (v.goal === undefined), { message: "provide exactly one of graph or goal" });

export type CreateRunInput = z.input<typeof CreateRunSchema>;

/** Why a run's scheduler was aborted. */
class Shutdown {
  constructor(readonly graceful: boolean) {}
}
class Cancelled {}
class LeaseGone {}

type ActiveRun = { controller: AbortController; done: Promise<void> };

/**
 * Owns every run this process holds a lease on. Several engines can share one database:
 * each claims runs through leases, renews them with heartbeats, and sweeps up runs whose owner died.
 */
export class Engine {
  readonly workerId: string;

  private readonly store: Store;
  private readonly clock: Clock;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly sweepMs: number;
  private readonly schedulerDeps: SchedulerDeps;
  private readonly planner?: Planner;
  private readonly active = new Map<string, ActiveRun>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? realClock;
    this.workerId = opts.workerId ?? randomUUID();
    this.leaseTtlMs = opts.leaseTtlMs ?? 30_000;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.sweepMs = opts.sweepMs ?? 5_000;
    this.planner = opts.planner;
    this.schedulerDeps = {
      store: opts.store,
      provider: opts.provider,
      clock: this.clock,
      workerId: this.workerId,
      pricing: opts.pricing,
      random: opts.random,
      limiter: new TokenBucket({
        capacity: Math.max(1, Math.floor(opts.rpm / 6)),
        refillPerSec: opts.rpm / 60,
        clock: this.clock,
      }),
    };
  }

  /**
   * Sweeps for orphaned runs now and then on an interval. A serverless host skips this and
   * calls sweep() from its requests instead, since an idle instance runs no timers.
   */
  start(): void {
    this.stopping = false;
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepMs);
  }

  /**
   * A graceful stop resets this process's running steps to pending and releases its leases,
   * so another process resumes at once. `graceful: false` leaves everything as a crash would.
   */
  async stop(opts: { graceful?: boolean } = {}): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const reason = new Shutdown(opts.graceful ?? true);
    const running = [...this.active.values()];
    for (const run of running) run.controller.abort(reason);
    await Promise.allSettled(running.map((r) => r.done));
  }

  async createRun(input: CreateRunInput): Promise<{ runId: string }> {
    const parsed = CreateRunSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)));
    }
    const req = parsed.data;
    const now = this.clock.now();
    const runId = newRunId(now);
    const common = {
      id: runId,
      concurrency: req.concurrency,
      budgetTokens: req.budget?.tokens ?? null,
      budgetUsd: req.budget?.usd ?? null,
      now,
    };

    if (req.goal !== undefined) {
      if (!this.planner) throw new ValidationError(["planning is not configured"], "planning is not configured");
      await this.store.createRun({ ...common, goal: req.goal, profile: req.profile, status: "planning", maxReplans: req.maxReplans });
      await this.emit(runId, [["run.created", { graph: null, goal: req.goal, profile: req.profile }]]);
    } else {
      const checked = validateGraph(req.graph);
      if (!checked.ok) throw new ValidationError(checked.issues, "invalid graph");
      await this.store.tx(async () => {
        await this.store.createRun({ ...common, goal: null, profile: null, status: "running", maxReplans: 0 });
        await this.store.installGraph(runId, checked.graph, 1, [], now);
      });
      await this.emit(runId, [["run.created", { graph: checked.graph, goal: null, profile: null }]]);
    }

    if (await this.store.claimRun(runId, this.workerId, now, this.leaseTtlMs)) this.launch(runId, null);
    return { runId };
  }

  /** Cancels a run no matter which process owns it. The owner's fenced writes start failing at once. */
  async cancel(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);

    const unfinished = (await this.store.getSteps(runId)).filter((s) => s.status === "pending" || s.status === "running");
    const done = await commit(
      this.schedulerDeps,
      runId,
      async () => {
        const current = (await this.store.getRun(runId))!;
        if (TERMINAL_RUN_STATUSES.includes(current.status)) return false;
        await this.store.setRunStatus(runId, "cancelled", null, this.clock.now());
        for (const s of unfinished) await this.store.updateStep(runId, s.stepId, { status: "skipped", error: "cancelled" });
        return true;
      },
      [
        ...unfinished.map((s): PendingEvent => ["step.skipped", { stepId: s.stepId, reason: "cancelled" }]),
        ["run.cancelled", { totals: await this.store.totals(runId) }],
      ],
    );
    if (!done) throw new ConflictError(`run ${runId} already ${run.status}`);

    this.active.get(runId)?.controller.abort(new Cancelled());
  }

  /** Puts failed and skipped steps of a failed run back to pending and starts it again. */
  async retry(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);

    const done = await commit(
      this.schedulerDeps,
      runId,
      async () => {
        const current = (await this.store.getRun(runId))!;
        if (current.status !== "failed") return false;
        await this.store.resetSteps(runId, ["failed", "skipped"], "pending", undefined, true);
        // A run that failed while planning has no graph yet, so it goes back to planning.
        await this.store.setRunStatus(runId, current.graph ? "running" : "planning", null, this.clock.now());
        return true;
      },
      [["run.retried", {}]],
    );
    if (!done) throw new ConflictError(`only failed runs can be retried, run ${runId} is ${run.status}`);

    if (await this.store.claimRun(runId, this.workerId, this.clock.now(), this.leaseTtlMs)) this.launch(runId, null);
  }

  /** Removes a finished run and everything it wrote. An unfinished run has to be cancelled first. */
  async delete(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new ConflictError(`run ${runId} is ${run.status}, cancel it before deleting`);
    }
    await this.store.deleteRun(runId);
  }

  /** Resolves when this process is no longer driving the run. */
  whenSettled(runId: string): Promise<void> {
    return this.active.get(runId)?.done ?? Promise.resolve();
  }

  /** Resolves once this process drives no runs, including runs launched while waiting. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()].map((r) => r.done));
  }

  /** Claims runs that have no live lease and starts driving them. */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    try {
      const now = this.clock.now();
      for (const runId of await this.store.claimableRuns(now)) {
        if (this.active.has(runId)) continue;
        const previousOwner = (await this.store.getRun(runId))?.leaseOwner ?? null;
        if (await this.store.claimRun(runId, this.workerId, now, this.leaseTtlMs)) this.launch(runId, { previousOwner });
      }
    } catch (err) {
      console.error(`[relay] sweep failed in worker ${this.workerId}`, err);
    }
  }

  private async heartbeat(): Promise<void> {
    const now = this.clock.now();
    for (const [runId, run] of this.active) {
      try {
        if (!(await this.store.heartbeat(runId, this.workerId, now, this.leaseTtlMs))) {
          run.controller.abort(new LeaseGone());
        } else if ((await this.store.getRun(runId))?.status === "cancelled") {
          run.controller.abort(new Cancelled());
        }
      } catch (err) {
        // A missed heartbeat is not fatal: the lease outlives several of them.
        console.error(`[relay] heartbeat for ${runId} failed`, err);
      }
    }
  }

  /** Heartbeats run only while this process drives at least one run. */
  private launch(runId: string, takeover: { previousOwner: string | null } | null): void {
    const controller = new AbortController();
    const done = this.drive(runId, controller.signal, takeover)
      .catch((err) => console.error(`[relay] run ${runId} crashed in worker ${this.workerId}`, err))
      .then(async () => {
        const reason = controller.signal.reason;
        const crashed = reason instanceof Shutdown && !reason.graceful;
        if (!crashed) await this.store.releaseRun(runId, this.workerId).catch(() => {});
      })
      .finally(() => {
        this.active.delete(runId);
        if (this.active.size === 0 && this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      });
    this.active.set(runId, { controller, done });
    this.heartbeatTimer ??= setInterval(() => void this.heartbeat(), this.heartbeatMs);
  }

  private async drive(runId: string, signal: AbortSignal, takeover: { previousOwner: string | null } | null): Promise<void> {
    // Steps a dead owner left running go back to pending. Their attempt counts stay.
    const stale = (await this.store.getSteps(runId)).filter((s) => s.status === "running").map((s) => s.stepId);
    const events: PendingEvent[] = takeover
      ? [["run.lease_taken", { workerId: this.workerId, previousOwner: takeover.previousOwner, resetSteps: stale }]]
      : [];
    const claimed = await commit(
      this.schedulerDeps,
      runId,
      async () => {
        await this.store.resetSteps(runId, ["running"], "pending", this.workerId);
        return (await this.store.getRun(runId))?.leaseOwner === this.workerId;
      },
      events,
    );
    if (!claimed) return;

    if ((await this.store.getRun(runId))!.status === "planning" && !(await this.planRun(runId, signal))) return;

    const scheduler = new RunScheduler(runId, this.schedulerDeps, { onStepFailed: this.replanHook(runId) });
    const result = await scheduler.run(signal);

    const reason = signal.reason;
    if (result === "aborted" && reason instanceof Shutdown && reason.graceful) {
      await this.store.resetSteps(runId, ["running"], "pending", this.workerId);
    }
  }

  /** Builds the graph for a goal run. Returns true when the run is ready to schedule. */
  private async planRun(runId: string, signal: AbortSignal): Promise<boolean> {
    const run = (await this.store.getRun(runId))!;
    if (!this.planner || !run.goal || !run.profile) {
      await this.failPlanning(runId, "planning is not configured", [], null);
      return false;
    }

    try {
      const { graph, usage, attempts } = await this.planner.plan(run.goal, run.profile, signal);
      if (signal.aborted) return false;
      const cost = costUsd(usage, this.schedulerDeps.pricing);
      const now = this.clock.now();
      const done = await commit(
        this.schedulerDeps,
        runId,
        async () =>
          (await this.store.addPlanningUsage(runId, usage, cost, this.workerId)) &&
          (await this.store.installGraph(runId, graph, 1, [], now, this.workerId)) &&
          (await this.store.setRunStatus(runId, "running", null, now, this.workerId)),
        [["run.planned", { graph, attempts, usage: { ...usage, costUsd: cost } }]],
      );
      return done !== null;
    } catch (err) {
      // Shutdown, cancel or a lost lease: whoever holds the run next plans it again.
      if (signal.aborted) return false;
      if (err instanceof PlanningError) await this.failPlanning(runId, `planning failed: ${err.message}`, err.issues, err.usage);
      else await this.failPlanning(runId, `planning failed: ${err instanceof Error ? err.message : String(err)}`, [], null);
      return false;
    }
  }

  private async failPlanning(runId: string, error: string, issues: string[], usage: PlanningError["usage"] | null): Promise<void> {
    const totals = await this.store.totals(runId);
    await commit(
      this.schedulerDeps,
      runId,
      async () =>
        (!usage || (await this.store.addPlanningUsage(runId, usage, costUsd(usage, this.schedulerDeps.pricing), this.workerId))) &&
        (await this.store.setRunStatus(runId, "failed", error, this.clock.now(), this.workerId)),
      [["run.failed", { error, issues, totals }]],
    );
  }

  /** Replaces a failed branch through the planner while the run has re-plans left. */
  private replanHook(runId: string): FailureHook | undefined {
    const planner = this.planner;
    if (!planner) return undefined;

    return async (stepId, error, signal) => {
      const run = await this.store.getRun(runId);
      if (!run?.goal || !run.profile || !run.graph || run.replans >= run.maxReplans) return false;

      try {
        const result = await planner.replan(
          {
            goal: run.goal,
            profile: run.profile,
            graph: run.graph,
            graphVersion: run.graphVersion,
            steps: await this.store.getSteps(runId),
            failedStepId: stepId,
            error,
          },
          signal,
        );
        const version = run.graphVersion + 1;
        const cost = costUsd(result.usage, this.schedulerDeps.pricing);
        const done = await commit(
          this.schedulerDeps,
          runId,
          async () =>
            (await this.store.addPlanningUsage(runId, result.usage, cost, this.workerId)) &&
            (await this.store.installGraph(runId, result.graph, version, result.supersede, this.clock.now(), this.workerId)) &&
            (await this.store.incrementReplans(runId, this.workerId)),
          [
            [
              "run.replanned",
              {
                failedStepId: stepId,
                graphVersion: version,
                graph: result.graph,
                supersede: result.supersede,
                added: result.added,
                usage: { ...result.usage, costUsd: cost },
              },
            ],
          ],
        );
        return done !== null;
      } catch (err) {
        if (signal.aborted) return false;
        if (err instanceof PlanningError) {
          await this.store.addPlanningUsage(runId, err.usage, costUsd(err.usage, this.schedulerDeps.pricing), this.workerId);
        }
        await this.emit(runId, [["run.replan_failed", { stepId, error: err instanceof Error ? err.message : String(err) }]]);
        return false;
      }
    };
  }

  private async emit(runId: string, events: PendingEvent[]): Promise<void> {
    await commit(this.schedulerDeps, runId, async () => true, events);
  }
}
