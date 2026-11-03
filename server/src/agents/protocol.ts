import { LlmError, type LlmResult } from "../llm/provider";

export type AgentName = "pi" | "claude-code" | "codex";
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue { return value && typeof value === "object" ? value as RecordValue : {}; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

/** Final message records are authoritative; delta and agent_end records must not double count. */
export function parseAgentOutput(agent: AgentName, output: string, structured = false): LlmResult {
  let records: RecordValue[];
  try { records = agent === "claude-code" ? [object(JSON.parse(output))] : output.split("\n").filter((line) => line.trim()).map((line) => object(JSON.parse(line))); }
  catch { throw new LlmError("Local agent returned an invalid JSON protocol. Check its CLI version.", { status: 502 }); }
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = false;
  for (const event of records) {
    if (agent === "claude-code" && event.type === "result") {
      failed ||= event.is_error === true;
      text = structured && event.structured_output !== undefined ? JSON.stringify(event.structured_output) : String(event.result ?? "");
      const usage = object(event.usage);
      inputTokens += number(usage.input_tokens) + number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens);
      outputTokens += number(usage.output_tokens);
    }
    if (agent === "codex") {
      if (event.type === "item.completed" && object(event.item).type === "agent_message") text = String(object(event.item).text ?? "");
      if (event.type === "turn.completed") {
        const usage = object(event.usage);
        inputTokens += number(usage.input_tokens);
        outputTokens += number(usage.output_tokens);
      }
      if (event.type === "turn.failed") failed = true;
    }
    if (agent === "pi" && event.type === "message_end") {
      const message = object(event.message);
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") failed = true;
      const content = Array.isArray(message.content) ? message.content : [];
      const response = content.filter((part) => object(part).type === "text").map((part) => String(object(part).text ?? "")).join("\n");
      if (response) text = response;
      const usage = object(message.usage);
      inputTokens += number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
      outputTokens += number(usage.output);
    }
  }
  if (failed) throw new LlmError("Local agent reported a failed run. Check credentials, model access and permissions.", { status: 400 });
  if (!text.trim()) throw new LlmError("Local agent returned no final response", { status: 502 });
  return { text, sources: [], usage: { inputTokens, outputTokens, searchCalls: 0 } };
}
