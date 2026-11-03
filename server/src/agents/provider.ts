import type { LlmProvider, LlmRequest, LlmResult } from "../llm/provider";
import { runProcess } from "./process";
import { parseAgentOutput, type AgentName } from "./protocol";

export type AgentOptions = { agent: AgentName; cwd: string; model?: string; provider?: string; executable?: string; timeoutMs?: number; maxOutputBytes?: number };

/** Local-only agent boundary. Never instantiate from an untrusted hosted request. */
export class AgentProvider implements LlmProvider {
  readonly model: string;
  constructor(private readonly options: AgentOptions) { this.model = `${options.agent}/${options.model ?? "configured-default"}`; }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const { agent, cwd, model, provider } = this.options;
    const args = agent === "codex"
      ? ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-C", cwd, ...(model ? ["--model", model] : []), "-"]
      : agent === "claude-code"
        ? ["--bare", "--print", "--output-format", "json", "--no-session-persistence", "--disable-slash-commands", "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...(model ? ["--model", model] : []), ...(req.jsonSchema ? ["--json-schema", JSON.stringify(req.jsonSchema)] : [])]
        : ["--print", "--mode", "json", "--no-session", "--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", ...(model ? ["--model", model] : []), ...(provider && model ? ["--provider", provider] : [])];
    const prompt = req.jsonSchema && agent !== "claude-code" ? `${req.prompt}\n\nReturn only valid JSON matching this schema, without Markdown fences:\n${JSON.stringify(req.jsonSchema)}` : req.prompt;
    const output = await runProcess({ executable: this.options.executable ?? (agent === "claude-code" ? "claude" : agent), args, cwd, input: prompt, signal: AbortSignal.any([req.signal, AbortSignal.timeout(this.options.timeoutMs ?? 90_000)]), maxOutputBytes: this.options.maxOutputBytes ?? 8_000_000 });
    return parseAgentOutput(agent, output, !!req.jsonSchema);
  }
}
