"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError } from "@/lib/api";
import { formatCost, formatDuration, formatTokens, tryPrettyJson } from "@/lib/format";
import { layoutGraph } from "@/lib/layout";
import { currentSteps, supersededSteps } from "@/lib/run-reducer";
import { autoSelectStep, finalStepId, runSources } from "@/lib/select";
import { useNow, useRun } from "@/lib/use-run";
import { ConfirmButton } from "./confirm-button";
import { CopyButton, DownloadButton } from "./copy-button";
import { Lamp, Status, statusWord } from "./lamp";
import { RunGraph } from "./run-graph";
import { StepPanel } from "./step-panel";
import { Timeline } from "./timeline";

export function RunView({ runId }: { runId: string }) {
  const router = useRouter();
  const { state, error, connection } = useRun(runId);
  // null means "follow the run": the panel shows whatever step matters right now.
  // A link can point at one step instead, so ?step= seeds the choice.
  const stepParam = useSearchParams().get("step");
  const [pinned, setPinned] = useState<string | null>(stepParam);
  const [tab, setTab] = useState<"report" | "timeline">("report");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = state?.run.status === "planning" || state?.run.status === "running";
  const now = useNow(!!active);

  const steps = useMemo(() => (state ? currentSteps(state) : []), [state]);
  const replaced = useMemo(() => (state ? supersededSteps(state) : []), [state]);
  // Layout depends only on the graph's shape, which changes only when a re-plan installs a new version.
  const graphShape = state?.run.graph ?? null;
  const layout = useMemo(() => (graphShape ? layoutGraph(graphShape) : null), [graphShape]);

  const followed = state ? autoSelectStep(state) : null;
  const selectedId = (pinned && state?.steps[pinned] ? pinned : followed) ?? null;

  // Picking a step writes it to the address bar, so the link points at what is being discussed.
  function pick(stepId: string | null) {
    setPinned(stepId);
    writeStepParam(stepId);
  }

  const done = steps.filter((s) => s.status === "succeeded").length;

  // A background tab shows how far the run has got.
  useEffect(() => {
    if (!state) return;
    const label = state.run.goal ?? state.run.id;
    document.title = active && steps.length > 0 ? `${done}/${steps.length} · ${label}` : `${statusWord(state.run.status)} · ${label}`;
    return () => {
      document.title = "Relay";
    };
  }, [state, active, done, steps.length]);

  if (error) {
    return (
      <div role="alert">
        <p className="error-box">{error}</p>
        <p style={{ marginTop: 12 }}>
          <Link href="/" className="button" data-variant="quiet">
            Back to all runs
          </Link>
        </p>
      </div>
    );
  }
  if (!state) return <p className="hint">Loading run.</p>;

  const { run } = state;
  const graph = run.graph;
  const finalId = finalStepId(graph);
  const finalDef = graph?.steps.find((s) => s.id === finalId);
  const finalStep = finalId ? state.steps[finalId] : undefined;
  const elapsed = (active ? now : run.updatedAt) - run.createdAt;
  // Size the diagram to the laid-out graph instead of leaving a tall empty panel.
  const panelHeight = layout ? Math.min(640, Math.max(300, layout.height + 90)) : 320;
  const report = finalStep?.output ?? null;
  const reportJson = report ? tryPrettyJson(report) : null;
  // A report cites what the researchers found, so the list belongs to the run, not one step.
  const sources = runSources(state);

  async function act(action: "cancel" | "retry" | "delete") {
    setBusy(true);
    setActionError(null);
    try {
      if (action === "cancel") await api.cancelRun(runId);
      else if (action === "retry") await api.retryRun(runId);
      else {
        await api.deleteRun(runId);
        router.push("/");
        return;
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div style={{ minWidth: 0, maxWidth: "80ch" }}>
          <Link href="/" className="hint" style={{ textDecoration: "none" }}>
            All runs
          </Link>
          <h1 style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.25, letterSpacing: "-0.01em", marginTop: 4 }}>
            {run.goal ?? `Graph of ${graph?.steps.length ?? 0} steps`}
          </h1>
          <p className="mono hint" style={{ marginTop: 2 }}>
            {run.id}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {active && (
            <button className="button" data-variant="danger" disabled={busy} onClick={() => act("cancel")}>
              Cancel run
            </button>
          )}
          {run.status === "failed" && (
            <button className="button" disabled={busy} onClick={() => act("retry")}>
              Retry failed steps
            </button>
          )}
          {run.goal && (
            <Link className="button" data-variant="quiet" href={`/?goal=${encodeURIComponent(run.goal)}&profile=${run.profile ?? "research"}`}>
              Run again
            </Link>
          )}
          {!active && <ConfirmButton label="Delete" confirmLabel="Delete for good" disabled={busy} onConfirm={() => act("delete")} />}
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-10 gap-y-3" style={{ marginTop: 20, paddingBottom: 16, borderBottom: "1px solid var(--rule)" }}>
        <HeaderStat label="Status" value={<Status state={run.status} size="large" />} />
        <HeaderStat label="Steps done" value={graph ? `${done} of ${steps.length}` : "Planning"} />
        <HeaderStat label="Elapsed" value={formatDuration(elapsed)} />
        <HeaderStat label="Tokens" value={formatTokens(state.totals.inputTokens + state.totals.outputTokens)} />
        <HeaderStat label="Cost" value={formatCost(state.totals.costUsd)} />
        {run.graphVersion > 1 && <HeaderStat label="Re-plans" value={String(run.replans)} />}
        {run.budgetUsd !== null && <HeaderStat label="Budget" value={formatCost(run.budgetUsd)} />}
        <HeaderStat
          label="Live updates"
          value={
            <span className="inline-flex items-center gap-2" style={{ fontWeight: 400 }}>
              <Lamp state={connection === "live" ? "succeeded" : connection === "reconnecting" ? "failed" : "pending"} />
              {connection === "live" ? "Connected" : connection === "reconnecting" ? "Reconnecting" : "Connecting"}
            </span>
          }
        />
      </dl>

      {run.error && (
        <p className="error-box" style={{ marginTop: 16 }}>
          {run.error}
        </p>
      )}
      {actionError && (
        <p className="error-box" role="alert" style={{ marginTop: 16 }}>
          {actionError}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]" style={{ marginTop: 20 }}>
        <div className="panel overflow-hidden" style={{ height: panelHeight }}>
          {graph ? (
            <RunGraph graph={graph} layout={layout!} graphVersion={run.graphVersion} steps={state.steps} selectedId={selectedId} onSelect={pick} now={now} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3" style={{ color: "var(--ink-2)" }}>
              <Lamp state={run.status === "planning" ? "planning" : run.status} size="large" />
              <p>{run.status === "planning" ? "The planner is designing the steps for this goal." : `Run ${statusWord(run.status).toLowerCase()} before a plan was ready.`}</p>
            </div>
          )}
        </div>
        <aside className="panel overflow-y-auto" style={{ maxHeight: Math.max(panelHeight, 480) }}>
          <StepPanel
            def={graph?.steps.find((s) => s.id === selectedId)}
            step={selectedId ? state.steps[selectedId] : undefined}
            now={now}
            following={!pinned && !!selectedId}
            onFollow={() => pick(null)}
          />
          {replaced.length > 0 && (
            <div style={{ padding: "0 20px 20px" }}>
              <h3 style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Replaced by re-planning</h3>
              <ul className="flex flex-wrap gap-2">
                {replaced.map((s) => (
                  <li key={s.stepId}>
                    <button
                      className="mono inline-flex items-center gap-2"
                      onClick={() => pick(s.stepId)}
                      style={{ fontSize: 13, padding: "2px 8px", border: "1px dashed var(--rule-strong)", borderRadius: "var(--radius-s)" }}
                    >
                      <Lamp state="superseded" />
                      {s.stepId}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="flex flex-wrap items-center justify-between gap-3" style={{ padding: "0 20px", borderBottom: "1px solid var(--rule)" }}>
          <div role="tablist" className="flex gap-6">
            {(["report", "timeline"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                style={{ padding: "12px 0", fontWeight: 700, fontSize: 14, color: tab === t ? "var(--ink)" : "var(--ink-3)", borderBottom: `2px solid ${tab === t ? "var(--ink)" : "transparent"}`, marginBottom: -1 }}
              >
                {t === "report" ? "Result" : `Timeline (${state.events.length})`}
              </button>
            ))}
          </div>
          {tab === "report" && report && (
            <div className="flex gap-2" style={{ paddingBottom: 6 }}>
              <CopyButton small text={report} label="Copy result" />
              <DownloadButton small text={reportMarkdown(run.goal, report, sources)} filename={`${run.id}.md`} label="Download .md" />
            </div>
          )}
        </div>
        <div style={{ padding: 20 }}>
          {tab === "timeline" ? (
            <Timeline events={state.events} startedAt={run.createdAt} onSelectStep={pick} />
          ) : report ? (
            <>
              {reportJson ? (
                <pre className="code-block">{reportJson}</pre>
              ) : (
                <article className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
                </article>
              )}
              {sources.length > 0 && (
                <section style={{ marginTop: 24, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
                  <h3 style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Sources this run used</h3>
                  <ol style={{ listStyle: "decimal", paddingLeft: 20, fontSize: 14 }}>
                    {sources.map((source) => (
                      <li key={source.url} style={{ marginBottom: 4 }}>
                        <a href={source.url} target="_blank" rel="noreferrer" style={{ textUnderlineOffset: 2 }}>
                          {source.title}
                        </a>{" "}
                        <span className="hint">{source.steps.join(", ")}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          ) : (
            <p className="hint">
              {finalDef ? (
                <>
                  The result appears here when <code className="mono">{finalDef.id}</code> finishes.
                </>
              ) : (
                "The result appears here once the run has a plan and its final step finishes."
              )}
            </p>
          )}
        </div>
      </section>
    </>
  );
}

/** Keeps ?step= in step with the panel without a navigation. */
function writeStepParam(stepId: string | null): void {
  const url = new URL(window.location.href);
  if (stepId) url.searchParams.set("step", stepId);
  else url.searchParams.delete("step");
  window.history.replaceState(null, "", url);
}

/** The report as a file: the goal as a heading, the answer, then the citations. */
function reportMarkdown(goal: string | null, output: string, sources: { title: string; url: string }[]): string {
  const head = goal ? `# ${goal}\n\n` : "";
  const cited = sources.length > 0 ? `\n\n## Sources\n\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}\n` : "";
  return `${head}${output.trim()}${cited}`;
}

function HeaderStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="hint">{label}</dt>
      <dd style={{ fontWeight: 700, fontSize: 17, marginTop: 2 }}>{value}</dd>
    </div>
  );
}
