"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import type { CreateRunRequest, Profile } from "@/lib/types";

const EXAMPLE_GRAPH = JSON.stringify(
  {
    steps: [
      { id: "pros", prompt: "List the strongest arguments for remote-first engineering teams." },
      { id: "cons", prompt: "List the strongest arguments against remote-first engineering teams." },
      {
        id: "verdict",
        prompt: "Weigh these and give a recommendation for a 20-person startup.\n\nFor:\n{{pros.output}}\n\nAgainst:\n{{cons.output}}",
        final: true,
      },
    ],
  },
  null,
  2,
);

const PROFILES: { value: Profile; title: string; detail: string }[] = [
  { value: "research", title: "Research report", detail: "Parallel researchers, a fact check, and a cited report." },
  { value: "general", title: "Planned workflow", detail: "The planner designs the steps for any goal." },
];

export function NewRunForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"goal" | "graph">("goal");
  const [goal, setGoal] = useState("");
  const [profile, setProfile] = useState<Profile>("research");
  const [graph, setGraph] = useState(EXAMPLE_GRAPH);
  const [concurrency, setConcurrency] = useState(4);
  const [maxReplans, setMaxReplans] = useState(2);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; issues: string[] } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const budget = budgetUsd.trim() ? { usd: Number(budgetUsd) } : undefined;
    let body: CreateRunRequest;
    if (mode === "goal") {
      body = { goal: goal.trim(), profile, concurrency, maxReplans, budget };
    } else {
      try {
        body = { graph: JSON.parse(graph), concurrency, budget };
      } catch {
        setError({ message: "The graph is not valid JSON.", issues: [] });
        return;
      }
    }

    setSubmitting(true);
    try {
      const runId = await api.createRun(body);
      router.push(`/runs/${runId}`);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      setError({ message: apiError?.message ?? "Could not start the run.", issues: apiError?.issues ?? [] });
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel" style={{ padding: 24 }}>
      <div className="flex flex-wrap items-baseline justify-between gap-3" style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.01em", lineHeight: 1.2 }}>Start a run</h1>
        <div role="tablist" aria-label="How to define the run" className="inline-flex gap-1" style={{ background: "var(--panel-sunk)", padding: 3, borderRadius: "var(--radius-s)" }}>
          {(["goal", "graph"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              style={{
                padding: "4px 12px",
                borderRadius: "var(--radius-s)",
                fontSize: 14,
                fontWeight: mode === m ? 700 : 400,
                background: mode === m ? "var(--panel)" : "transparent",
                color: mode === m ? "var(--ink)" : "var(--ink-2)",
              }}
            >
              {m === "goal" ? "Describe a goal" : "Write the graph"}
            </button>
          ))}
        </div>
      </div>

      {mode === "goal" ? (
        <>
          <label className="field-label" htmlFor="goal">
            Goal
          </label>
          <textarea
            id="goal"
            className="textarea"
            rows={3}
            required
            minLength={3}
            placeholder="Should a two-person SaaS startup use SQLite or Postgres as its primary database?"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            style={{ fontSize: 17 }}
          />

          <fieldset style={{ marginTop: 18 }}>
            <legend className="field-label">Workflow</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {PROFILES.map((p) => (
                <label
                  key={p.value}
                  className="flex cursor-pointer gap-3"
                  style={{
                    padding: "10px 12px",
                    border: `1px solid ${profile === p.value ? "var(--ink)" : "var(--rule)"}`,
                    borderRadius: "var(--radius-s)",
                    background: profile === p.value ? "var(--bg)" : "transparent",
                  }}
                >
                  <input type="radio" name="profile" value={p.value} checked={profile === p.value} onChange={() => setProfile(p.value)} style={{ marginTop: 5, accentColor: "var(--ink)" }} />
                  <span>
                    <span style={{ fontWeight: 700 }}>{p.title}</span>
                    <span className="hint block">{p.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="graph">
            Graph JSON
          </label>
          <textarea id="graph" className="textarea mono" rows={14} spellCheck={false} value={graph} onChange={(e) => setGraph(e.target.value)} style={{ fontSize: 13 }} />
          <p className="hint" style={{ marginTop: 6 }}>
            Reference another step with <code className="mono">{"{{step_id.output}}"}</code>. The engine adds the dependency for you.
          </p>
        </>
      )}

      <div className="flex flex-wrap items-end gap-4" style={{ marginTop: 18 }}>
        <NumberField id="concurrency" label="Steps at once" value={concurrency} min={1} max={16} onChange={setConcurrency} />
        {mode === "goal" && <NumberField id="replans" label="Re-plans allowed" value={maxReplans} min={0} max={5} onChange={setMaxReplans} />}
        <div>
          <label className="field-label" htmlFor="budget">
            Budget in USD
          </label>
          <input id="budget" className="input" type="number" min="0.01" step="0.01" placeholder="No limit" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} style={{ width: 130 }} />
        </div>
        <button type="submit" className="button" disabled={submitting} style={{ marginLeft: "auto" }}>
          {submitting ? "Starting" : "Start run"}
        </button>
      </div>

      {error && (
        <div className="error-box" role="alert" style={{ marginTop: 16 }}>
          <p style={{ fontWeight: 700 }}>{error.message}</p>
          {error.issues.length > 0 && (
            <ul style={{ marginTop: 4, paddingLeft: 18, listStyle: "disc" }}>
              {error.issues.map((issue) => (
                <li key={issue} className="mono" style={{ fontSize: 13 }}>
                  {issue}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

function NumberField(props: { id: string; label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div>
      <label className="field-label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="input"
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Math.min(props.max, Math.max(props.min, Number(e.target.value) || props.min)))}
        style={{ width: 96 }}
      />
    </div>
  );
}
