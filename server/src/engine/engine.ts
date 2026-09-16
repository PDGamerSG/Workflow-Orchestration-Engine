import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LlmProvider } from "../llm/provider";
import { costUsd, type Pricing } from "../llm/pricing";
import { PlanningError, type Planner } from "../planner/planner";
import { realClock } from "./clock";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { commit, EventBus, type PendingEvent } from "./events";
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
  readonly bus = new EventBus();

  private readonly store: Store;
  private readonly clock: Clock;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly sweepMs: number;
  private readonly schedulerDeps: SchedulerDeps;
  private readonly planner?: Planner;
  private readonly active = new Map<string, ActiveRun>();
  private timers: ReturnType<typeof setInterval>[] = [];
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
      bus: this.bus,
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

  start(): void {
    this.stopping = false;
    this.sweep();
    this.timers = [
      setInterval(() => this.heartbeat(), this.heartbeatMs),
      setInterval(() => this.sweep(), this.sweepMs),
    ];
  }

  /**
   * A graceful stop resets this process's running steps to pending and releases its leases,
   * so another process resumes at once. `graceful: false` leaves everything as a crash would.
   */
  async stop(opts: { graceful?: boolean } = {}): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    const reason = new Shutdown(opts.graceful ?? true);
    const running = [...this.active.values()];
    for (const run of running) run.controller.abort(reason);
    await Promise.allSettled(running.map((r) => r.done));
  }

  createRun(input: CreateRunInput): { runId: string } {
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
      this.store.createRun({ ...common, goal: req.goal, profile: req.profile, status: "planning", maxReplans: req.maxReplans });
      this.emit(runId, [["run.created", { graph: null, goal: req.goal, profile: req.profile }]]);
    } else {
      const checked = validateGraph(req.graph);
      if (!checked.ok) throw new ValidationError(checked.issues, "invalid graph");
      this.store.tx(() => {
        this.store.createRun({ ...common, goal: null, profile: null, status: "running", maxReplans: 0 });
        this.store.installGraph(runId, checked.graph, 1, [], now);
      });
      this.emit(runId, [["run.created", { graph: checked.graph, goal: null, profile: null }]]);
    }

    if (this.store.claimRun(runId, this.workerId, now, this.leaseTtlMs)) this.launch(runId, null);
    return { runId };
  }

  /** Cancels a run no matter which process owns it. The owner's fenced writes start failing at once. */
  cancel(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);

    const unfinished = this.store.getSteps(runId).filter((s) => s.status === "pending" || s.status === "running");
    const done = commit(
      this.schedulerDeps,
      runId,
      () => {
        const current = this.store.getRun(runId)!;
        if (TERMINAL_RUN_STATUSES.includes(current.status)) return false;
        this.store.setRunStatus(runId, "cancelled", null, this.clock.now());
        for (const s of unfinished) this.store.updateStep(runId, s.stepId, { status: "skipped", error: "cancelled" });
        return true;
      },
      [
        ...unfinished.map((s): PendingEvent => ["step.skipped", { stepId: s.stepId, reason: "cancelled" }]),
        ["run.cancelled", { totals: this.store.totals(runId) }],
      ],
    );
    if (!done) throw new ConflictError(`run ${runId} already ${run.status}`);

    this.active.get(runId)?.controller.abort(new Cancelled());
  }

  /** Puts failed and skipped steps of a failed run back to pending and starts it again. */
  retry(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);

    const done = commit(
      this.schedulerDeps,
      runId,
      () => {
        const current = this.store.getRun(runId)!;
        if (current.status !== "failed") return false;
        this.store.resetSteps(runId, ["failed", "skipped"], "pending", undefined, true);
        // A run that failed while planning has no graph yet, so it goes back to planning.
        this.store.setRunStatus(runId, current.graph ? "running" : "planning", null, this.clock.now());
        return true;
      },
      [["run.retried", {}]],
    );
    if (!done) throw new ConflictError(`only failed runs can be retried, run ${runId} is ${run.status}`);

    if (this.store.claimRun(runId, this.workerId, this.clock.now(), this.leaseTtlMs)) this.launch(runId, null);
  }

  /** Removes a finished run and everything it wrote. An unfinished run has to be cancelled first. */
  delete(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new ConflictError(`run ${runId} is ${run.status}, cancel it before deleting`);
    }
    this.store.deleteRun(runId);
  }

  /** Resolves when this process is no longer driving the run. */
  whenSettled(runId: string): Promise<void> {
    return this.active.get(runId)?.done ?? Promise.resolve();
  }

  /** Claims runs that have no live lease. Runs once at start and then on an interval. */
  sweep(): void {
    if (this.stopping) return;
    const now = this.clock.now();
    for (const runId of this.store.claimableRuns(now)) {
      if (this.active.has(runId)) continue;
      const previousOwner = this.store.getRun(runId)?.leaseOwner ?? null;
      if (this.store.claimRun(runId, this.workerId, now, this.leaseTtlMs)) this.launch(runId, { previousOwner });
    }
  }

  private heartbeat(): void {
    const now = this.clock.now();
    for (const [runId, run] of this.active) {
      if (!this.store.heartbeat(runId, this.workerId, now, this.leaseTtlMs)) {
        run.controller.abort(new LeaseGone());
      } else if (this.store.getRun(runId)?.status === "cancelled") {
        run.controller.abort(new Cancelled());
      }
    }
  }

  private launch(runId: string, takeover: { previousOwner: string | null } | null): void {
    const controller = new AbortController();
    const done = this.drive(runId, controller.signal, takeover)
      .catch((err) => console.error(`[relay] run ${runId} crashed in worker ${this.workerId}`, err))
      .finally(() => {
        this.active.delete(runId);
        const reason = controller.signal.reason;
        const crashed = reason instanceof Shutdown && !reason.graceful;
        if (!crashed) this.store.releaseRun(runId, this.workerId);
      });
    this.active.set(runId, { controller, done });
  }

  private async drive(runId: string, signal: AbortSignal, takeover: { previousOwner: string | null } | null): Promise<void> {
    // Steps a dead owner left running go back to pending. Their attempt counts stay.
    const stale = this.store.getSteps(runId).filter((s) => s.status === "running").map((s) => s.stepId);
    const events: PendingEvent[] = takeover
      ? [["run.lease_taken", { workerId: this.workerId, previousOwner: takeover.previousOwner, resetSteps: stale }]]
      : [];
    const claimed = commit(
      this.schedulerDeps,
      runId,
      () => {
        this.store.resetSteps(runId, ["running"], "pending", this.workerId);
        return this.store.getRun(runId)?.leaseOwner === this.workerId;
      },
      events,
    );
    if (!claimed) return;

    if (this.store.getRun(runId)!.status === "planning" && !(await this.planRun(runId, signal))) return;

    const scheduler = new RunScheduler(runId, this.schedulerDeps, { onStepFailed: this.replanHook(runId) });
    const result = await scheduler.run(signal);

    const reason = signal.reason;
    if (result === "aborted" && reason instanceof Shutdown && reason.graceful) {
      this.store.resetSteps(runId, ["running"], "pending", this.workerId);
    }
  }

  /** Builds the graph for a goal run. Returns true when the run is ready to schedule. */
  private async planRun(runId: string, signal: AbortSignal): Promise<boolean> {
    const run = this.store.getRun(runId)!;
    if (!this.planner || !run.goal || !run.profile) {
      this.failPlanning(runId, "planning is not configured", [], null);
      return false;
    }

    try {
      const { graph, usage, attempts } = await this.planner.plan(run.goal, run.profile, signal);
      if (signal.aborted) return false;
      const cost = costUsd(usage, this.schedulerDeps.pricing);
      const now = this.clock.now();
      const done = commit(
        this.schedulerDeps,
        runId,
        () =>
          this.store.addPlanningUsage(runId, usage, cost, this.workerId) &&
          this.store.installGraph(runId, graph, 1, [], now, this.workerId) &&
          this.store.setRunStatus(runId, "running", null, now, this.workerId),
        [["run.planned", { graph, attempts, usage: { ...usage, costUsd: cost } }]],
      );
      return done !== null;
    } catch (err) {
      // Shutdown, cancel or a lost lease: whoever holds the run next plans it again.
      if (signal.aborted) return false;
      if (err instanceof PlanningError) this.failPlanning(runId, `planning failed: ${err.message}`, err.issues, err.usage);
      else this.failPlanning(runId, `planning failed: ${err instanceof Error ? err.message : String(err)}`, [], null);
      return false;
    }
  }

  private failPlanning(runId: string, error: string, issues: string[], usage: PlanningError["usage"] | null): void {
    commit(
      this.schedulerDeps,
      runId,
      () =>
        (!usage || this.store.addPlanningUsage(runId, usage, costUsd(usage, this.schedulerDeps.pricing), this.workerId)) &&
        this.store.setRunStatus(runId, "failed", error, this.clock.now(), this.workerId),
      [["run.failed", { error, issues, totals: this.store.totals(runId) }]],
    );
  }

  /** Replaces a failed branch through the planner while the run has re-plans left. */
  private replanHook(runId: string): FailureHook | undefined {
    const planner = this.planner;
    if (!planner) return undefined;

    return async (stepId, error, signal) => {
      const run = this.store.getRun(runId);
      if (!run?.goal || !run.profile || !run.graph || run.replans >= run.maxReplans) return false;

      try {
        const result = await planner.replan(
          {
            goal: run.goal,
            profile: run.profile,
            graph: run.graph,
            graphVersion: run.graphVersion,
            steps: this.store.getSteps(runId),
            failedStepId: stepId,
            error,
          },
          signal,
        );
        const version = run.graphVersion + 1;
        const cost = costUsd(result.usage, this.schedulerDeps.pricing);
        const done = commit(
          this.schedulerDeps,
          runId,
          () =>
            this.store.addPlanningUsage(runId, result.usage, cost, this.workerId) &&
            this.store.installGraph(runId, result.graph, version, result.supersede, this.clock.now(), this.workerId) &&
            this.store.incrementReplans(runId, this.workerId),
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
          this.store.addPlanningUsage(runId, err.usage, costUsd(err.usage, this.schedulerDeps.pricing), this.workerId);
        }
        this.emit(runId, [["run.replan_failed", { stepId, error: err instanceof Error ? err.message : String(err) }]]);
        return false;
      }
    };
  }

  private emit(runId: string, events: PendingEvent[]): void {
    commit(this.schedulerDeps, runId, () => true, events);
  }
}
