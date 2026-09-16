import type { RunStatus, RunSummary } from "./types";

export type RunFilter = "all" | "active" | "succeeded" | "failed" | "cancelled";

export const RUN_FILTERS: { value: RunFilter; label: string; statuses: RunStatus[] }[] = [
  { value: "all", label: "All", statuses: [] },
  { value: "active", label: "Active", statuses: ["planning", "running"] },
  { value: "succeeded", label: "Done", statuses: ["succeeded"] },
  { value: "failed", label: "Failed", statuses: ["failed"] },
  { value: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

/** Runs matching a status filter and a case-insensitive search over the goal and the id. */
export function filterRuns(runs: RunSummary[], filter: RunFilter, query: string): RunSummary[] {
  const statuses = RUN_FILTERS.find((f) => f.value === filter)?.statuses ?? [];
  const needle = query.trim().toLowerCase();
  return runs.filter((run) => {
    if (statuses.length > 0 && !statuses.includes(run.status)) return false;
    if (!needle) return true;
    return `${run.goal ?? ""} ${run.id}`.toLowerCase().includes(needle);
  });
}

/** How many runs each filter would show, for the counts on the chips. */
export function countByFilter(runs: RunSummary[]): Record<RunFilter, number> {
  const counts = {} as Record<RunFilter, number>;
  for (const f of RUN_FILTERS) counts[f.value] = filterRuns(runs, f.value, "").length;
  return counts;
}
