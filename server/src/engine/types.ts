export type ToolName = "search";

export type OutputSpec =
  | { type: "text" }
  | { type: "json"; schema: Record<string, unknown> };

export type StepDef = {
  id: string;
  prompt: string;
  dependsOn?: string[];
  tools?: ToolName[];
  output?: OutputSpec;
  retries?: number;
  timeoutMs?: number;
  cache?: boolean;
  final?: boolean;
};

export type Graph = { steps: StepDef[] };

export type NormalizedStep = {
  id: string;
  prompt: string;
  dependsOn: string[];
  tools: ToolName[];
  output: OutputSpec;
  retries: number;
  timeoutMs: number;
  cache: boolean;
  final: boolean;
};

/** A validated graph. `order` lists step ids in a valid topological order. */
export type NormalizedGraph = { steps: NormalizedStep[]; order: string[] };

export type RunStatus = "planning" | "running" | "succeeded" | "failed" | "cancelled";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "superseded";

export type Profile = "general" | "research";

export type Source = { title: string; url: string };

export type Usage = { inputTokens: number; outputTokens: number; searchCalls: number };

export interface Clock {
  now(): number;
  /** Resolves after `ms`. Rejects with the signal's reason if it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
