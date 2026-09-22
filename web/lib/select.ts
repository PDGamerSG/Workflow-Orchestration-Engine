import type { RunState } from "./run-reducer";
import { currentSteps } from "./run-reducer";
import type { Graph, Step } from "./types";

/** The step a run's final answer comes from: the one marked final, else the last in topological order. */
export function finalStepId(graph: Graph | null): string | null {
  if (!graph) return null;
  return graph.steps.find((s) => s.final)?.id ?? graph.order.at(-1) ?? null;
}

/**
 * The step to show when the person has not picked one. While a run works that is what is
 * running, so the panel follows the run; afterwards it is the failure to read or the result.
 */
export function autoSelectStep(state: RunState): string | null {
  const steps = currentSteps(state);
  if (steps.length === 0) return null;

  const running = steps.filter((s) => s.status === "running");
  if (running.length > 0) return earliest(running).stepId;

  const failed = steps.find((s) => s.status === "failed");
  if (failed) return failed.stepId;

  const final = finalStepId(state.run.graph);
  if (final && state.steps[final]?.status === "succeeded") return final;

  const succeeded = steps.filter((s) => s.status === "succeeded");
  if (succeeded.length > 0) return succeeded.at(-1)!.stepId;

  return steps[0]!.stepId;
}

function earliest(steps: Step[]): Step {
  return steps.reduce((a, b) => ((a.startedAt ?? Infinity) <= (b.startedAt ?? Infinity) ? a : b));
}

/**
 * Every source the run's steps cited, deduplicated by URL in topological order. The step that
 * writes a report usually has no sources of its own: they belong to the researchers upstream.
 */
export function runSources(state: RunState): { title: string; url: string; steps: string[] }[] {
  const byUrl = new Map<string, { title: string; url: string; steps: string[] }>();
  for (const step of currentSteps(state)) {
    for (const source of step.sources) {
      const found = byUrl.get(source.url);
      if (found) found.steps.push(step.stepId);
      else byUrl.set(source.url, { title: source.title, url: source.url, steps: [step.stepId] });
    }
  }
  return [...byUrl.values()];
}
