"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { countByFilter, filterRuns, RUN_FILTERS, type RunFilter } from "@/lib/filter";
import { formatAge, formatCost } from "@/lib/format";
import type { RunSummary, StepStatus } from "@/lib/types";
import { useNow } from "@/lib/use-run";
import { ConfirmButton } from "./confirm-button";
import { Status } from "./lamp";

const BAR_ORDER: { status: StepStatus; color: string }[] = [
  { status: "succeeded", color: "var(--go)" },
  { status: "running", color: "var(--caution)" },
  { status: "failed", color: "var(--stop)" },
  { status: "skipped", color: "var(--rule-strong)" },
  { status: "pending", color: "var(--rule)" },
];

export function RunsTable() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`: the poll below clears its own error every three seconds,
  // which would wipe a failed delete before it could be read.
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RunFilter>("all");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const now = useNow(true, 5_000);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.listRuns().then(
        (r) => {
          if (!alive) return;
          setRuns(r);
          setError(null);
        },
        (err: Error) => alive && setError(err.message),
      );
    load();
    const timer = setInterval(load, 3_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const counts = useMemo(() => countByFilter(runs ?? []), [runs]);
  const shown = useMemo(() => filterRuns(runs ?? [], filter, query), [runs, filter, query]);

  async function remove(run: RunSummary) {
    setDeleting(run.id);
    setActionError(null);
    // Drop the row at once; the poll above confirms it.
    setRuns((current) => current?.filter((r) => r.id !== run.id) ?? null);
    try {
      await api.deleteRun(run.id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete the run.");
      // The row is still there on the engine, so put the list back the way the engine has it.
      await api.listRuns().then(setRuns, () => {});
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section style={{ marginTop: 40 }}>
      <div className="flex flex-wrap items-center justify-between gap-3" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 19, fontWeight: 800 }}>Runs</h2>
        {runs && runs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter runs by status">
              {RUN_FILTERS.filter((f) => f.value === "all" || counts[f.value] > 0).map((f) => (
                <button key={f.value} type="button" className="chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                  {f.label} <small>{counts[f.value]}</small>
                </button>
              ))}
            </div>
            <input
              className="input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search goals"
              aria-label="Search runs"
              style={{ width: 200, height: 30, padding: "2px 10px", fontSize: 14 }}
            />
          </div>
        )}
      </div>

      {error && <p className="error-box">{error}</p>}
      {actionError && (
        <p className="error-box" role="alert" style={{ marginBottom: 12 }}>
          {actionError}
        </p>
      )}
      {runs?.length === 0 && <p className="hint">No runs yet. Describe a goal above to start the first one.</p>}
      {runs && runs.length > 0 && shown.length === 0 && (
        <p className="hint">
          No run matches this filter.{" "}
          <button
            type="button"
            onClick={() => {
              setFilter("all");
              setQuery("");
            }}
            style={{ textDecoration: "underline", textUnderlineOffset: 2 }}
          >
            Show all runs
          </button>
        </p>
      )}

      {shown.length > 0 && (
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="runs-table w-full" style={{ borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-3)" }}>
                <th style={th}>Status</th>
                <th style={th}>Run</th>
                <th style={th}>Steps</th>
                <th style={{ ...th, textAlign: "right" }}>Cost</th>
                <th style={{ ...th, textAlign: "right" }}>Started</th>
                <th style={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((run) => {
                const total = Object.entries(run.stepCounts).reduce((n, [status, count]) => (status === "superseded" ? n : n + count), 0);
                const active = run.status === "planning" || run.status === "running";
                return (
                  <tr key={run.id} style={{ borderTop: "1px solid var(--rule)" }}>
                    <td style={td}>
                      <Status state={run.status} />
                    </td>
                    <td style={{ ...td, maxWidth: 520 }}>
                      <Link href={`/runs/${run.id}`} className="block" style={{ fontWeight: 700, textDecoration: "none" }}>
                        <span className="line-clamp-1">{run.goal ?? "Hand-written graph"}</span>
                      </Link>
                      <span className="mono hint">{run.id}</span>
                    </td>
                    <td style={td}>
                      <StepBar counts={run.stepCounts} total={total} />
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{formatCost(run.totals.costUsd)}</td>
                    <td style={{ ...td, textAlign: "right", color: "var(--ink-2)", whiteSpace: "nowrap" }} title={new Date(run.createdAt).toLocaleString()}>
                      {formatAge(run.createdAt, now)}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {!active && (
                        <span className="row-actions">
                          <ConfirmButton
                            small
                            label="Delete"
                            confirmLabel="Delete for good"
                            disabled={deleting === run.id}
                            onConfirm={() => remove(run)}
                            ariaLabel={`Delete run ${run.id}`}
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StepBar({ counts, total }: { counts: Record<StepStatus, number>; total: number }) {
  if (total === 0) return <span className="hint">Not planned yet</span>;
  const label = BAR_ORDER.filter((b) => counts[b.status])
    .map((b) => `${counts[b.status]} ${b.status}`)
    .join(", ");
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <span className="flex overflow-hidden" style={{ width: 120, height: 8, borderRadius: 2, background: "var(--panel-sunk)" }} role="img" aria-label={label}>
        {BAR_ORDER.map((b) => (counts[b.status] ? <span key={b.status} style={{ width: `${(counts[b.status] / total) * 100}%`, background: b.color }} /> : null))}
      </span>
      <span style={{ color: "var(--ink-2)" }}>
        {counts.succeeded}/{total}
      </span>
    </span>
  );
}

const th = { padding: "10px 14px", fontWeight: 400 } as const;
const td = { padding: "10px 14px", verticalAlign: "top" } as const;
