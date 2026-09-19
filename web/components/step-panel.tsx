"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatCost, formatDuration, formatTokens, tryPrettyJson } from "@/lib/format";
import type { Step, StepDef } from "@/lib/types";
import { Status } from "./lamp";

export function StepPanel({ def, step, now }: { def: StepDef | undefined; step: Step | undefined; now: number }) {
  if (!step) {
    return <p className="hint" style={{ padding: 20 }}>Select a step in the graph to see its prompt, output and cost.</p>;
  }

  const elapsed = step.startedAt ? (step.finishedAt ?? now) - step.startedAt : null;
  const json = step.output ? tryPrettyJson(step.output) : null;

  return (
    <div style={{ padding: 20 }}>
      <h2 className="mono break-all" style={{ fontSize: 16, fontWeight: 700 }}>
        {step.stepId}
      </h2>
      <div style={{ marginTop: 6 }}>
        <Status state={step.status} />
      </div>

      <dl className="grid grid-cols-3 gap-x-3 gap-y-3" style={{ marginTop: 16, fontSize: 13 }}>
        <Stat label="Attempts" value={String(step.attempt)} />
        <Stat label="Time" value={elapsed === null ? "Not started" : formatDuration(elapsed)} />
        <Stat label="Cost" value={step.cached ? "Cached" : formatCost(step.costUsd)} />
        <Stat label="Input tokens" value={formatTokens(step.inputTokens)} />
        <Stat label="Output tokens" value={formatTokens(step.outputTokens)} />
        <Stat label="Searches" value={String(step.searchCalls)} />
      </dl>

      {def && def.dependsOn.length > 0 && (
        <p className="hint" style={{ marginTop: 14 }}>
          Uses{" "}
          {def.dependsOn.map((d, i) => (
            <span key={d}>
              {i > 0 && ", "}
              <code className="mono">{d}</code>
            </span>
          ))}
        </p>
      )}

      {step.error && (
        <div className={step.status === "failed" ? "error-box" : "hint"} style={{ marginTop: 16, borderLeft: step.status === "failed" ? undefined : "3px solid var(--caution)", paddingLeft: 10 }}>
          {step.status === "running" ? "Last attempt failed, retrying: " : ""}
          {step.error}
        </div>
      )}

      <Section title="Output">
        {step.output === null ? (
          <p className="hint">{step.status === "running" ? "Waiting for the model." : "No output."}</p>
        ) : json ? (
          <pre className="code-block">{json}</pre>
        ) : (
          <div className="markdown" style={{ fontSize: 14 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.output}</ReactMarkdown>
          </div>
        )}
      </Section>

      {step.sources.length > 0 && (
        <Section title={`Sources (${step.sources.length})`}>
          <ol style={{ listStyle: "decimal", paddingLeft: 20, fontSize: 13 }}>
            {step.sources.map((s) => (
              <li key={s.url} style={{ marginBottom: 4 }}>
                <a href={s.url} target="_blank" rel="noreferrer" style={{ textUnderlineOffset: 2 }}>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </Section>
      )}

      <details style={{ marginTop: 20 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 14 }}>Prompt</summary>
        <pre className="code-block" style={{ marginTop: 8 }}>
          {step.resolvedPrompt ?? def?.prompt ?? ""}
        </pre>
        {step.resolvedPrompt === null && def && <p className="hint">Template before the step runs. References fill in when it starts.</p>}
      </details>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt style={{ color: "var(--ink-3)" }}>{label}</dt>
      <dd style={{ fontWeight: 700, fontSize: 15 }}>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h3 style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{title}</h3>
      {children}
    </section>
  );
}
