"use client";

import { useState } from "react";

const STAGES = [
  {
    title: "Find ready work",
    detail:
      "Scheduling, durability and agent-loop analyses have no dependencies, so all three are ready to start.",
  },
  {
    title: "Run in parallel",
    detail:
      "Independent branches run together. Each completed result is saved before dependent work can use it.",
  },
  {
    title: "Join the results",
    detail:
      "Synthesis starts only after all three inputs succeed. Templates resolve from the saved outputs.",
  },
];

export function EngineDiagram() {
  const [stage, setStage] = useState(1);
  const state = stage === 0 ? "pending" : stage === 1 ? "running" : "succeeded";
  return (
    <div className="diagram-board">
      <div className="diagram-caption">
        <span className="inline-flex items-center gap-2">
          <span className="lamp" data-state={state} />
          Dependency scheduler
        </span>
        <span>Illustration</span>
      </div>
      <svg
        viewBox="0 0 620 340"
        role="img"
        aria-label="Three independent analysis steps feed one synthesis step"
      >
        <defs>
          <pattern
            id="graph-dots"
            width="22"
            height="22"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="1" fill="currentColor" opacity="0.13" />
          </pattern>
        </defs>
        <rect width="620" height="340" fill="url(#graph-dots)" />
        <g fill="none" stroke="var(--rule-strong)" strokeWidth="1.5">
          <path d="M240 73H307Q322 73 322 88V155Q322 170 340 170H380" />
          <path d="M240 170H380" />
          <path d="M240 267H307Q322 267 322 252V185Q322 170 340 170" />
        </g>
        {[
          ["scheduling", 44],
          ["durability", 141],
          ["agent_loops", 238],
        ].map(([name, y]) => (
          <g key={name} transform={`translate(38 ${y})`}>
            <rect
              width="202"
              height="58"
              rx="7"
              fill="var(--panel)"
              stroke={stage === 2 ? "var(--go)" : "var(--rule-strong)"}
            />
            <circle
              cx="20"
              cy="29"
              r="4"
              fill={
                stage === 2
                  ? "var(--go)"
                  : stage === 1
                    ? "var(--caution)"
                    : "var(--off)"
              }
            />
            <text
              x="35"
              y="34"
              fill="var(--ink)"
              fontSize="15"
              fontFamily="var(--font-mono), monospace"
            >
              {name}
            </text>
          </g>
        ))}
        <g transform="translate(380 141)">
          <rect
            width="202"
            height="58"
            rx="7"
            fill={stage === 2 ? "var(--go-soft)" : "var(--panel)"}
            stroke={stage === 2 ? "var(--go)" : "var(--rule-strong)"}
          />
          <circle
            cx="20"
            cy="29"
            r="4"
            fill={stage === 2 ? "var(--go)" : "var(--off)"}
          />
          <text
            x="35"
            y="34"
            fill="var(--ink)"
            fontSize="15"
            fontFamily="var(--font-mono), monospace"
          >
            synthesis
          </text>
        </g>
        <text x="382" y="224" fill="var(--ink-2)" fontSize="12">
          {stage === 2
            ? "All inputs saved. Ready to run."
            : "Waiting for 3 dependencies"}
        </text>
      </svg>
      <div
        className="diagram-controls"
        role="group"
        aria-label="Explore scheduling stages"
      >
        {STAGES.map((item, index) => (
          <button
            key={item.title}
            type="button"
            aria-pressed={stage === index}
            onClick={() => setStage(index)}
          >
            <span>{index + 1}</span>
            {item.title}
          </button>
        ))}
      </div>
      <p className="diagram-explanation" aria-live="polite">
        {STAGES[stage].detail}
      </p>
    </div>
  );
}
