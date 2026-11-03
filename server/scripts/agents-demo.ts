import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentProvider } from "../src/agents/provider";
import type { AgentName } from "../src/agents/protocol";
import { openPglite } from "../src/engine/db";
import { Engine } from "../src/engine/engine";
import { Store } from "../src/engine/store";
import type { LlmProvider } from "../src/llm/provider";

const root = resolve(import.meta.dir, "../..");
const cwd = process.env.RELAY_AGENT_CWD ?? root;
const selected = process.argv.find((arg) => arg.startsWith("--agent="))?.slice(8) as AgentName | undefined;
if (selected && !["pi", "claude-code", "codex"].includes(selected)) throw new Error("Use --agent=pi, --agent=claude-code, or --agent=codex");
const agents = {
  pi: new AgentProvider({ agent: "pi", cwd, model: process.env.RELAY_PI_MODEL, provider: process.env.RELAY_PI_PROVIDER }),
  "claude-code": new AgentProvider({ agent: "claude-code", cwd, model: process.env.RELAY_CLAUDE_MODEL }),
  codex: new AgentProvider({ agent: "codex", cwd, model: process.env.RELAY_CODEX_MODEL }),
};
if (selected) {
  const result = await agents[selected].generate({ prompt: "In one sentence, explain why durable workflow steps need checkpoints. Use no tools.", signal: AbortSignal.timeout(60_000) });
  console.log(JSON.stringify({ agent: selected, ...result }, null, 2));
} else {
  const db = await openPglite();
  const store = await Store.open(db);
  const routes: Record<string, AgentName> = { pi_analysis: "pi", claude_analysis: "claude-code", codex_analysis: "codex", synthesis: "codex" };
  const provider: LlmProvider = { model: "pi+claude-code+codex", generate: (req) => agents[routes[req.stepId ?? ""] ?? "codex"].generate(req) };
  const engine = new Engine({ store, provider, pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 }, rpm: 60_000 });
  try {
    const graph: unknown = JSON.parse(await readFile(resolve(root, "examples/agents.graph.json"), "utf8"));
    const { runId } = await engine.createRun({ graph, concurrency: 3 });
    await engine.whenSettled(runId);
    const snapshot = (await store.snapshot(runId))!;
    console.log(JSON.stringify({ status: snapshot.run.status, agents: routes, steps: snapshot.steps.map((step) => ({ id: step.stepId, status: step.status, output: step.output, error: step.error, inputTokens: step.inputTokens, outputTokens: step.outputTokens })) }, null, 2));
    if (snapshot.run.status !== "succeeded") process.exitCode = 1;
  } finally { await engine.stop(); await db.close(); }
}
