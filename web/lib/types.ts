// Mirrors the server's JSON shapes. The dashboard talks to the engine only over HTTP.

export type RunStatus = "planning" | "running" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "superseded";
export type Profile = "general" | "research";

export type Source = { title: string; url: string };
export type Totals = { inputTokens: number; outputTokens: number; searchCalls: number; costUsd: number };

export type OutputSpec = { type: "text" } | { type: "json"; schema: Record<string, unknown> };

export type StepDef = {
  id: string;
  prompt: string;
  dependsOn: string[];
  tools: "search"[];
  output: OutputSpec;
  retries: number;
  timeoutMs: number;
  cache: boolean;
  final: boolean;
};

export type Graph = { steps: StepDef[]; order: string[] };

export type Run = {
  id: string;
  goal: string | null;
  profile: Profile | null;
  graph: Graph | null;
  graphVersion: number;
  status: RunStatus;
  error: string | null;
  concurrency: number;
  maxReplans: number;
  replans: number;
  budgetTokens: number | null;
  budgetUsd: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type Step = {
  runId: string;
  stepId: string;
  graphVersion: number;
  status: StepStatus;
  attempt: number;
  resolvedPrompt: string | null;
  output: string | null;
  sources: Source[];
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  costUsd: number;
  cached: boolean;
  startedAt: number | null;
  finishedAt: number | null;
};

export type RunSummary = Omit<Run, "graph"> & {
  stepCounts: Record<StepStatus, number>;
  totals: Totals;
};

export type RunSnapshot = { run: Run; steps: Step[]; totals: Totals; lastEventId: number };

type RunEnd = { error?: string | null; totals?: Totals; issues?: string[] };

/** Payload of each event type the engine writes. */
export type EventPayloads = {
  "run.created": { graph: Graph | null; goal: string | null; profile: Profile | null };
  "run.planned": { graph: Graph; attempts: number; usage: Totals };
  "run.replanned": { failedStepId: string; graphVersion: number; graph: Graph; supersede: string[]; added: string[]; usage: Totals };
  "run.replan_failed": { stepId: string; error: string };
  "run.lease_taken": { workerId: string; previousOwner: string | null; resetSteps: string[] };
  "run.retried": Record<string, never>;
  "run.budget_exceeded": { totals: Totals; budgetTokens: number | null; budgetUsd: number | null };
  "run.succeeded": RunEnd;
  "run.failed": RunEnd;
  "run.cancelled": RunEnd;
  "step.started": { stepId: string; attempt: number; startedAt: number; prompt?: string | null };
  "step.retrying": { stepId: string; attempt: number; error: string; delayMs: number };
  "step.succeeded": { stepId: string; attempt: number; output: string; sources?: Source[]; cached: boolean; finishedAt: number; usage: Totals };
  "step.failed": { stepId: string; attempt: number; error: string; finishedAt: number; usage: Totals };
  "step.skipped": { stepId: string; reason: string };
};

export type RunEvent = {
  [K in keyof EventPayloads]: { id: number; runId: string; type: K; payload: EventPayloads[K]; createdAt: number };
}[keyof EventPayloads];

export type CreateRunRequest =
  | { goal: string; profile: Profile; concurrency?: number; maxReplans?: number; budget?: { tokens?: number; usd?: number } }
  | { graph: unknown; concurrency?: number; budget?: { tokens?: number; usd?: number } };
