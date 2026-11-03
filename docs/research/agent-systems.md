# Agent systems and Relay's design

Research date: 2026-11-04. This is a bounded primary-source engineering review, not an exhaustive survey. Product documentation can change independently of this repository.

## What an orchestrator coordinates

An agent loop repeatedly asks a model for an action, executes tools, returns observations, and continues until a stopping condition. A workflow orchestrator coordinates several such units: dependency readiness, concurrency, persistent state, ownership, failure policy, and evidence. Relay implements the latter from scratch; its adapters can use an existing agent loop as one step.

| System | Primary evidence and location | Mechanism observed | Application in Relay | Limit |
| --- | --- | --- | --- | --- |
| Pi | [CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md), output/resource options; [JSON events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), message events | One-shot JSONL, authoritative assistant `message_end`, usage, tool events; SDK and bidirectional RPC also exist | Local JSON adapter maps final text and cumulative per-message usage into `LlmResult` | An adapter is not Pi's SDK or an OS sandbox. CLI flags depend on installed version. |
| Claude Code | [Programmatic execution](https://code.claude.com/docs/en/headless), structured output and bare mode | Print mode returns JSON results, usage and structured output; the Agent SDK exposes the same tools/context loop | Local print-JSON adapter with read tools restricted, no session persistence, and bare mode | API-backed bare mode requires API credentials. Account subscription behavior differs. |
| Codex | [Non-interactive mode](https://developers.openai.com/codex/noninteractive/), JSON output and permissions | `codex exec --json` emits completed agent items and turn usage, supports ephemeral execution and sandbox presets | Local exec adapter uses read-only mode, stdin, JSONL and token accounting | Read-only filesystem permissions are not an idempotency guarantee for every external tool. |
| Codex SDK | [SDK](https://developers.openai.com/codex/sdk/), TypeScript library | Thread creation, continuation, resumption and streaming over the local runtime | Evidence for an optional richer integration; this release uses the documented CLI boundary | Relay run ids are not Codex thread ids; Relay resumes its own DAG checkpoints. |
| Readme Pro Max | [Playbook](https://github.com/PDGamerSG/Readme-pro-max/blob/HEAD/PLAYBOOK.md) | Fact-based top block, live URL, screenshots, Mermaid, operational docs, README checker and About settings | Repository documentation and verification structure | Team/member/license facts must be recorded, not invented. |

These observations are source facts. The choice of a provider interface around agent invocations is a design proposal implemented in this release. No claim is made that Relay reproduces the internal code of these projects.

## Priorities selected from the review

1. **Inspectability:** expose dependency graph, prompt resolution, attempts, outputs, tokens, costs, and chronological events. A recruiter can follow a complete run.
2. **Correct ownership:** durable leases and fenced writes provide a concrete distributed-systems problem and reproducible crash demonstration.
3. **Provider boundaries:** select a provider per run; separate API adapters from local coding-agent processes. Hosted model calls and local tools have different trust and execution requirements.
4. **Credential ownership:** visitors provide their own credentials; workspace checks and authenticated encryption prevent the original deployment-wide sharing problem.
5. **Reproducibility:** scripted simulations, provider protocol fixtures, Postgres integration tests, a crash demo, and simulated-latency benchmarks separate proven mechanisms from claims that need real credentials.

Managed queues, cross-device accounts, billing, arbitrary hosted code execution, MCP tool hosting, and unattended long-running jobs would each introduce separate operational systems. They are documented extensions, not represented as shipped capabilities.

## Search and retrieval log

| Query or direct retrieval | Source | Result |
| --- | --- | --- |
| `readme pro max` | GitHub repository search through `gh` | Located `PDGamerSG/Readme-pro-max`; read SKILL.md and PLAYBOOK.md through GitHub's contents API. |
| Codex orchestration / SDK / noninteractive | `developers.openai.com/codex/sdk/`, `/noninteractive/` | Fetched both complete official pages; read thread lifecycle, JSONL, permissions and usage passages. |
| Pi CLI / JSON / RPC | `badlogic/pi-mono` raw RPC reference, then canonical `earendil-works/pi` CLI/JSON docs | Retrieved protocol and resource flags. Historical repository redirects refer to the canonical project. |
| Claude Code headless | `code.claude.com/docs/en/headless.md` | Retrieved print mode, structured output, bare mode and authentication requirements. |
| Readme Pro Max main/master raw files | GitHub raw URLs | Guessed branch URLs returned 404; used repository contents API and cloned the actual default branch instead. |

## Evidence rules

Benchmark numbers measure simulated provider latency, not model quality or production throughput. Fixture tests prove adapter process/protocol behavior, not the availability of a paid model. Demo responses are scripted and must stay visibly labelled. Tests and deployment evidence in `docs/testing/` identify which external services were actually exercised.
