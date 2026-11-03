"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { TEMPLATES } from "@/lib/templates";
import type { CreateRunRequest, Profile, PublicConnection } from "@/lib/types";

export function NewRunForm() {
  const params = useSearchParams();
  return (
    <RunForm
      key={params.toString()}
      templateId={params.get("template")}
      initialGoal={params.get("goal")}
      initialProfile={params.get("profile")}
      initialConnection={params.get("connection")}
    />
  );
}

function RunForm({
  templateId,
  initialGoal,
  initialProfile,
  initialConnection,
}: {
  templateId: string | null;
  initialGoal: string | null;
  initialProfile: string | null;
  initialConnection: string | null;
}) {
  const router = useRouter();
  const selectedTemplate = TEMPLATES.find((item) => item.id === templateId);
  const [mode, setMode] = useState<"goal" | "graph">(
    selectedTemplate ? "graph" : "goal",
  );
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [profile, setProfile] = useState<Profile>(
    initialProfile === "general" ? "general" : "research",
  );
  const [graph, setGraph] = useState(
    JSON.stringify((selectedTemplate ?? TEMPLATES[0]).graph, null, 2),
  );
  const [concurrency, setConcurrency] = useState(4);
  const [maxReplans, setMaxReplans] = useState(2);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [budgetTokens, setBudgetTokens] = useState("");
  const [connectionId, setConnectionId] = useState(initialConnection ?? "");
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [scenario, setScenario] = useState<"success" | "retry">(
    selectedTemplate?.scenario ?? "success",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{
    message: string;
    issues: string[];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    api.connections().then(
      (saved) => {
        if (alive) {
          setConnections(saved);
          setLoading(false);
          if (
            initialConnection &&
            !saved.some((item) => item.id === initialConnection)
          ) {
            setConnectionId("");
            setError({
              message:
                "That connection is not available in this browser. Choose a connection or use the demo.",
              issues: [],
            });
          }
        }
      },
      (error: Error) => {
        if (alive) {
          setError({ message: error.message, issues: [] });
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [initialConnection]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const budget =
      budgetUsd.trim() || budgetTokens.trim()
        ? {
            ...(budgetUsd.trim() ? { usd: Number(budgetUsd) } : {}),
            ...(budgetTokens.trim() ? { tokens: Number(budgetTokens) } : {}),
          }
        : undefined;
    const common = {
      concurrency,
      budget,
      connectionId: connectionId || null,
      demoScenario: scenario,
    };
    let body: CreateRunRequest;
    if (mode === "goal")
      body = { ...common, goal: goal.trim(), profile, maxReplans };
    else {
      try {
        body = { ...common, graph: JSON.parse(graph) };
      } catch {
        setError({
          message:
            "The graph is not valid JSON. Check its brackets, quotes and commas.",
          issues: [],
        });
        return;
      }
    }
    setSubmitting(true);
    try {
      router.push(`/runs/${await api.createRun(body)}`);
    } catch (error) {
      const problem = error instanceof ApiError ? error : null;
      setError({
        message: problem?.message ?? "Could not start the run.",
        issues: problem?.issues ?? [],
      });
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel run-form">
      <div className="form-heading">
        <div>
          <h2>{selectedTemplate?.title ?? "Create a workflow"}</h2>
          <p>
            {selectedTemplate?.takeaway ??
              "Choose what to run and how the engine should execute it."}
          </p>
        </div>
        <div
          className="segmented"
          role="group"
          aria-label="How to define the run"
        >
          {(["goal", "graph"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={mode === item}
              data-selected={mode === item || undefined}
              onClick={() => setMode(item)}
            >
              {item === "goal" ? "Describe a goal" : "Graph JSON"}
            </button>
          ))}
        </div>
      </div>
      <div className="execution-picker">
        <div className="execution-select">
          <label className="field-label" htmlFor="connection">
            Run with
          </label>
          <select
            id="connection"
            className="input"
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            disabled={loading}
          >
            <option value="">Demo simulation · no API key</option>
            {connections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.model}
              </option>
            ))}
          </select>
        </div>
        <Link className="text-link" href="/connections">
          {connections.length ? "Manage connections" : "Connect your API key"}
        </Link>
      </div>
      {!connectionId && (
        <div className="demo-note">
          <span className="lamp" data-state="pending" />
          <p>
            <strong>Simulation mode.</strong> Replies are scripted. The
            scheduler, checkpoints, retries and live events use the real engine.
          </p>
        </div>
      )}
      {mode === "goal" ? (
        <>
          <label className="field-label" htmlFor="goal">
            What would you like to work on?
          </label>
          <textarea
            id="goal"
            disabled={loading}
            className="textarea goal-input"
            rows={3}
            required
            minLength={3}
            maxLength={4000}
            placeholder="Compare SQLite and Postgres for a two-person SaaS startup. Include operating costs, failure modes and a recommendation."
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                event.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="example-goals">
            <span className="hint">Try a goal</span>
            {[
              "Explain how Pi, Claude Code and Codex differ as agent runtimes.",
              "Design a reliable workflow for reviewing a pull request.",
            ].map((example) => (
              <button
                key={example}
                type="button"
                className="chip"
                onClick={() => setGoal(example)}
              >
                {example}
              </button>
            ))}
          </div>
          <fieldset className="profile-picker">
            <legend className="field-label">Planning style</legend>
            {[
              {
                id: "research",
                title: "Research & review",
                detail: "Parallel analysis, a fact check and a final report.",
              },
              {
                id: "general",
                title: "Flexible plan",
                detail: "The planner designs a graph around your goal.",
              },
            ].map((item) => (
              <label
                key={item.id}
                data-selected={profile === item.id || undefined}
              >
                <input
                  type="radio"
                  name="profile"
                  value={item.id}
                  checked={profile === item.id}
                  onChange={() => setProfile(item.id as Profile)}
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="graph">
            Workflow graph
          </label>
          <textarea
            id="graph"
            disabled={loading}
            className="textarea mono graph-input"
            rows={15}
            spellCheck={false}
            required
            value={graph}
            onChange={(event) => setGraph(event.target.value)}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            Reference a saved output with <code>{"{{step_id.output}}"}</code>,
            or a JSON field with <code>{"{{step_id.output.field}}"}</code>.
            References add dependencies automatically.
          </p>
        </>
      )}
      <details className="advanced-settings">
        <summary>Execution settings & budgets</summary>
        <div className="settings-grid">
          <NumberField
            id="concurrency"
            label="Parallel steps"
            value={concurrency}
            min={1}
            max={16}
            onChange={setConcurrency}
          />
          {mode === "goal" && (
            <NumberField
              id="replans"
              label="Replans allowed"
              value={maxReplans}
              min={0}
              max={5}
              onChange={setMaxReplans}
            />
          )}
          <div>
            <label className="field-label" htmlFor="budget-tokens">
              Token budget
            </label>
            <input
              id="budget-tokens"
              className="input"
              type="number"
              min="1"
              step="1"
              placeholder="No limit"
              value={budgetTokens}
              onChange={(event) => setBudgetTokens(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="budget">
              USD budget
            </label>
            <input
              id="budget"
              className="input"
              type="number"
              min="0.001"
              step="0.001"
              placeholder="No limit"
              value={budgetUsd}
              onChange={(event) => setBudgetUsd(event.target.value)}
            />
          </div>
        </div>
        <p className="hint">
          Budgets stop new steps. Calls already in flight may exceed the limit.
          Dollar budgets require token prices on the connection.
        </p>
        {!connectionId && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={scenario === "retry"}
              onChange={(event) =>
                setScenario(event.target.checked ? "retry" : "success")
              }
            />
            Simulate one temporary API failure to demonstrate retries
          </label>
        )}
      </details>
      {error && (
        <div className="error-box" role="alert">
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
      <div className="form-submit">
        <p className="hint">
          {connectionId
            ? "Uses your provider’s API quota."
            : "Free simulation. No provider charges."}
          <span className="hidden sm:inline">
            {" "}
            Saved in this browser workspace.
          </span>
        </p>
        <button
          type="submit"
          className="button"
          disabled={submitting || loading}
        >
          {submitting
            ? "Starting…"
            : connectionId
              ? "Start model run"
              : "Start demo run"}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </form>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="number"
        min={min}
        max={max}
        value={value}
        required
        onChange={(event) =>
          onChange(
            Math.min(max, Math.max(min, Number(event.target.value) || min)),
          )
        }
      />
    </div>
  );
}
