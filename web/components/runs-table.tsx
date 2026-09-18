"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatAge, formatCost } from "@/lib/format";
import type { RunSummary, StepStatus } from "@/lib/types";
import { useNow } from "@/lib/use-run";
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

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: 19, fontWeight: 800, marginBottom: 12 }}>Runs</h2>

      {error && runs === null && <p className="error-box">{error}</p>}
      {runs?.length === 0 && <p className="hint">No runs yet. Describe a goal above to start the first one.</p>}

      {runs && runs.length > 0 && (
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="w-full" style={{ borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-3)" }}>
                <th style={th}>Status</th>
                <th style={th}>Run</th>
                <th style={th}>Steps</th>
                <th style={{ ...th, textAlign: "right" }}>Cost</th>
                <th style={{ ...th, textAlign: "right" }}>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const total = Object.entries(run.stepCounts).reduce((n, [status, count]) => (status === "superseded" ? n : n + count), 0);
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
                    <td style={{ ...td, textAlign: "right", color: "var(--ink-2)", whiteSpace: "nowrap" }}>{formatAge(run.createdAt, now)}</td>
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
  const label = BAR_ORDER.filter((b) => counts[b.status]).map((b) => `${counts[b.status]} ${b.status}`).join(", ");
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
