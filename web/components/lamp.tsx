import type { RunStatus, StepStatus } from "@/lib/types";

const WORDS: Record<RunStatus | StepStatus, string> = {
  planning: "Planning",
  pending: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  superseded: "Replaced",
  cancelled: "Cancelled",
};

export function statusWord(state: RunStatus | StepStatus): string {
  return WORDS[state];
}

export function Lamp({ state, size }: { state: RunStatus | StepStatus; size?: "large" }) {
  return <span className="lamp" data-state={state} data-size={size} aria-hidden="true" />;
}

export function Status({ state, size }: { state: RunStatus | StepStatus; size?: "large" }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Lamp state={state} size={size} />
      <span>{statusWord(state)}</span>
    </span>
  );
}
