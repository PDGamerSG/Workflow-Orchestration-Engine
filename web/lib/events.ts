import type { RunEvent } from "./types";

export function eventStepId(event: RunEvent): string | null {
  const payload = event.payload as { stepId?: unknown; failedStepId?: unknown };
  if (typeof payload.stepId === "string") return payload.stepId;
  if (typeof payload.failedStepId === "string") return payload.failedStepId;
  return null;
}
