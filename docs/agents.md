# Pi, Claude Code and Codex

An agent loop chooses tools, acts, observes and continues. An orchestrator coordinates multiple units of work, deciding when they may start and what survives failure. Relay implements that coordination; these adapters reuse each CLI's existing agent loop as one local step.

## Adapter contract

`AgentProvider` implements the same `LlmProvider.generate()` contract as the HTTP providers. It launches an executable with an argument array and no shell, writes the prompt through stdin, bounds combined output, propagates abort/timeout, then translates the final text and measured tokens. The scheduler can validate JSON output and save the result like any other step.

| Agent | Invocation and mapping | Local prerequisites |
| --- | --- | --- |
| Pi | `pi --print --mode json`; assistant `message_end` events supply text and cumulative per-message usage. | Pi CLI, selected provider/model and its authentication. |
| Claude Code | `claude --bare --print --output-format json`; result JSON supplies text, structured output and usage. | Claude Code CLI and API credentials compatible with bare mode. |
| Codex | `codex exec --json --ephemeral --sandbox read-only`; completed agent items and turn usage supply the result. | Codex CLI and working API/account authentication. |

The source contains the complete resource restrictions. Pi uses read tools and disables extension/skill/context discovery. Claude Code limits tools to Read/Glob/Grep and uses an empty MCP configuration. Codex uses read-only mode and ignores user rules/configuration. Installed CLI versions can change flags. These controls reduce available actions; Pi/Claude tool allowlists are not OS-level isolation. Never run untrusted prompts against a sensitive workspace.

Sources: [`provider.ts`](../server/src/agents/provider.ts), [`process.ts`](../server/src/agents/process.ts), [`protocol.ts`](../server/src/agents/protocol.ts). Primary documentation and the retrieval log are in [research](research/agent-systems.md).

## Run locally

Install the official CLIs and authenticate through their documented setup. Keep credentials in their supported local stores/environment, outside this repository. Test a single boundary before a complete graph:

```bash
bun run demo:agents --agent=pi
bun run demo:agents --agent=claude-code
bun run demo:agents --agent=codex
bun run demo:agents
```

Optional environment variables: `RELAY_AGENT_CWD`, `RELAY_PI_MODEL`, `RELAY_PI_PROVIDER`, `RELAY_CLAUDE_MODEL` and `RELAY_CODEX_MODEL`. The script defaults its working directory to this repository. `RELAY_PI_PROVIDER` is passed when a Pi model is also specified.

The complete example in [`examples/agents.graph.json`](../examples/agents.graph.json) starts Pi, Claude Code and Codex analyses concurrently. The synthesis step uses their saved outputs and runs through Codex. Its routing provider chooses an agent from `req.stepId`; the core scheduler remains unaware of agent-specific protocols.

## What is proved

Executable fixtures test all three parsers, literal Unicode/shell characters, failure despite exit zero, nonzero exit, excessive output and cancellation. These prove the subprocess boundary, not successful paid inference. Live attempts in this release environment could not finish: Codex rejected available authentication with HTTP 401, Pi reported failure, and Claude Code bare mode had no API credentials. No authenticated multi-agent result is claimed.

The public website does not host these executables, accept a command, expose local sessions or convert subscription logins into API keys. Local adapter execution is available through the library and example, with explicit operator-owned credentials and workspace.
