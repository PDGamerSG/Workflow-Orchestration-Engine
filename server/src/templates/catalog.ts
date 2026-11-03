import type { Graph } from "../engine/types";

export type WorkflowTemplate = {
  id: string;
  title: string;
  category: string;
  description: string;
  takeaway: string;
  graph: Graph;
  scenario?: "retry";
};

/** Portable workflow definitions: these contain no provider credentials or host-specific tools. */
export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: "engine-tour",
    title: "How Relay orchestrates",
    category: "Start here",
    description: "Watch three independent analyses meet at one synthesis step.",
    takeaway: "Dependency readiness and parallel execution",
    graph: {
      steps: [
        {
          id: "scheduling",
          prompt:
            "Explain how a DAG scheduler launches independent steps as soon as their dependencies finish. Give a concrete example.",
        },
        {
          id: "durability",
          prompt:
            "Explain how Postgres checkpoints, expiring worker leases and fenced writes let Relay recover after a process crash.",
        },
        {
          id: "agent_loops",
          prompt:
            "Explain the difference between a model/tool loop in Pi, Claude Code or Codex and Relay's orchestration across several such steps.",
        },
        {
          id: "synthesis",
          prompt:
            "Write a concise technical walkthrough of Relay using these analyses.\n\nScheduling:\n{{scheduling.output}}\n\nDurability:\n{{durability.output}}\n\nAgents:\n{{agent_loops.output}}",
          final: true,
        },
      ],
    },
  },
  {
    id: "research",
    title: "Research a technical decision",
    category: "Research",
    description:
      "Investigate options and risks in parallel, review the evidence, then write a recommendation.",
    takeaway: "Parallel research, review and synthesis",
    graph: {
      steps: [
        {
          id: "requirements",
          prompt:
            "List the requirements for a two-person SaaS startup choosing SQLite or Postgres. Distinguish known constraints from assumptions.",
        },
        {
          id: "sqlite",
          prompt:
            "Evaluate SQLite for a two-person SaaS startup. Discuss deployment, concurrency, backups, costs and limitations. Do not invent source URLs.",
        },
        {
          id: "postgres",
          prompt:
            "Evaluate Postgres for a two-person SaaS startup. Discuss deployment, concurrency, backups, costs and limitations. Do not invent source URLs.",
        },
        {
          id: "review",
          prompt:
            "Review these evaluations for unsupported claims and missing tradeoffs.\n{{sqlite.output}}\n{{postgres.output}}",
        },
        {
          id: "recommendation",
          prompt:
            "Recommend a database for this team. State assumptions and a trigger for revisiting the decision.\nRequirements: {{requirements.output}}\nSQLite: {{sqlite.output}}\nPostgres: {{postgres.output}}\nReview: {{review.output}}",
          final: true,
        },
      ],
    },
  },
  {
    id: "architecture",
    title: "Design an agent platform",
    category: "Engineering",
    description:
      "Compare infrastructure and failure policies before writing an architecture decision.",
    takeaway: "Fan-out analysis with a decision record",
    graph: {
      steps: [
        {
          id: "storage",
          prompt:
            "Compare a Postgres job table with Redis plus a queue for a small durable agent workflow engine. Describe the operational costs.",
        },
        {
          id: "execution",
          prompt:
            "Compare request-driven serverless workers with long-lived workers for LLM workflows. Discuss timeouts and wakeup guarantees.",
        },
        {
          id: "failure_policy",
          prompt:
            "Propose a retry, timeout, cancellation and idempotency policy for an agent orchestration engine.",
        },
        {
          id: "decision",
          prompt:
            "Write an architecture decision record with context, decision, alternatives and consequences.\nStorage: {{storage.output}}\nExecution: {{execution.output}}\nFailure policy: {{failure_policy.output}}",
          final: true,
        },
      ],
    },
  },
  {
    id: "structured",
    title: "Turn JSON into a brief",
    category: "Structured data",
    description:
      "Validate a typed extraction and reference individual fields in the next prompt.",
    takeaway: "JSON Schema validation and field templates",
    graph: {
      steps: [
        {
          id: "extract",
          prompt:
            "Extract requirements from: Build a workflow dashboard for developers. It must show retries and costs. The main risk is lost work after a crash.",
          output: {
            type: "json",
            schema: {
              type: "object",
              properties: {
                audience: { type: "string" },
                capabilities: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 2,
                },
                risk: { type: "string" },
              },
              required: ["audience", "capabilities", "risk"],
              additionalProperties: false,
            },
          },
        },
        {
          id: "brief",
          prompt:
            "Write a short product brief for {{extract.output.audience}}. Include this priority: {{extract.output.capabilities[0]}}. Explain how to address: {{extract.output.risk}}.",
          final: true,
        },
      ],
    },
  },
  {
    id: "launch",
    title: "Plan a developer launch",
    category: "Planning",
    description:
      "Develop the audience, quality gate and launch message as independent workstreams.",
    takeaway: "Independent branches and a shared final artifact",
    graph: {
      steps: [
        {
          id: "audience",
          prompt:
            "Define three target user groups for an open source LLM workflow orchestration engine and the first task each would try.",
        },
        {
          id: "quality",
          prompt:
            "Define a release checklist for an LLM workflow orchestration engine with API keys, checkpoints and a public playground.",
        },
        {
          id: "message",
          prompt:
            "Draft a concise launch message for a durable workflow engine. Avoid unsupported performance or reliability claims.",
        },
        {
          id: "launch_plan",
          prompt:
            "Create a one-week launch plan using these inputs. Include measurable acceptance criteria.\nAudience: {{audience.output}}\nQuality: {{quality.output}}\nMessage: {{message.output}}",
          final: true,
        },
      ],
    },
  },
  {
    id: "retry-lab",
    title: "Recover from an API failure",
    category: "Reliability lab",
    description:
      "Inject one simulated overload. Watch the failed attempt retry while the other branch continues.",
    takeaway: "Retries, backoff and branch independence",
    scenario: "retry",
    graph: {
      steps: [
        {
          id: "resilient_branch",
          prompt:
            "Explain how a transient HTTP 503 should be retried with bounded exponential backoff and jitter.",
          retries: 2,
        },
        {
          id: "independent_branch",
          prompt:
            "Explain why one branch's transient failure should not stop unrelated ready steps.",
        },
        {
          id: "recovered",
          prompt:
            "Summarize how this workflow recovered and describe at-least-once execution.\n{{resilient_branch.output}}\n{{independent_branch.output}}",
          final: true,
        },
      ],
    },
  },
];
