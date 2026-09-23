import { eventStepId } from "@/lib/events";
import { formatCost, formatDuration } from "@/lib/format";
import type { RunEvent } from "@/lib/types";

export function describeEvent(event: RunEvent): string {
  switch (event.type) {
    case "run.created": {
      const { goal, graph } = event.payload;
      return goal ? `Run created for goal: ${goal}` : `Run created with ${graph?.steps.length ?? 0} steps`;
    }
    case "run.planned": {
      const { graph, attempts } = event.payload;
      return `Planner produced ${graph.steps.length} steps${attempts > 1 ? ` after ${attempts} attempts` : ""}`;
    }
    case "step.started": {
      const { stepId, attempt } = event.payload;
      return `${stepId} started${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
    }
    case "step.retrying": {
      const { stepId, attempt, delayMs, error } = event.payload;
      return `${stepId} failed attempt ${attempt}, retrying in ${formatDuration(delayMs)}: ${error}`;
    }
    case "step.succeeded": {
      const { stepId, cached, usage } = event.payload;
      return `${stepId} finished${cached ? " from cache" : ` for ${formatCost(usage.costUsd)}`}`;
    }
    case "step.failed":
      return `${event.payload.stepId} failed: ${event.payload.error}`;
    case "step.skipped":
      return `${event.payload.stepId} skipped: ${event.payload.reason}`;
    case "run.replanned": {
      const { failedStepId, added, graphVersion } = event.payload;
      return `Replaced ${failedStepId} with ${added.join(", ")} (graph version ${graphVersion})`;
    }
    case "run.replan_failed":
      return `Could not re-plan ${event.payload.stepId}: ${event.payload.error}`;
    case "run.budget_exceeded":
      return "Budget reached, no more steps will start";
    case "run.lease_taken": {
      const { workerId, resetSteps } = event.payload;
      return `Worker ${workerId.slice(0, 8)} took over the run${resetSteps.length ? ` and restarted ${resetSteps.join(", ")}` : ""}`;
    }
    case "run.retried":
      return "Retry requested for failed and skipped steps";
    case "run.succeeded":
      return "Run finished";
    case "run.failed":
      return `Run failed: ${event.payload.error}`;
    case "run.cancelled":
      return "Run cancelled";
    default:
      return (event as { type: string }).type;
  }
}

export function Timeline({ events, startedAt, onSelectStep }: { events: RunEvent[]; startedAt: number; onSelectStep: (stepId: string) => void }) {
  if (events.length === 0) return <p className="hint">Events from this session appear here as the run progresses.</p>;
  return (
    <ol style={{ fontSize: 14 }}>
      {events.map((event) => {
        const stepId = eventStepId(event);
        const text = (
          <span className="break-words" data-type={event.type} style={{ color: event.type.endsWith("failed") ? "var(--stop)" : undefined }}>
            {describeEvent(event)}
          </span>
        );
        return (
          <li key={event.id} className="grid gap-4" style={{ gridTemplateColumns: "72px 1fr", padding: "6px 0", borderTop: "1px solid var(--rule)" }}>
            <span style={{ color: "var(--ink-3)", textAlign: "right" }}>+{formatDuration(event.createdAt - startedAt)}</span>
            {/* An event about a step opens that step, so the timeline leads back to the graph. */}
            {stepId ? (
              <button type="button" className="event-row" onClick={() => onSelectStep(stepId)} title={`Show ${stepId}`}>
                {text}
              </button>
            ) : (
              text
            )}
          </li>
        );
      })}
    </ol>
  );
}
