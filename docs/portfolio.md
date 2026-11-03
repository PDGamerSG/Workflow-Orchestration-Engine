# Portfolio presentation

## Opening statement

“I built Relay, a durable orchestration engine that turns goals into validated dependency graphs. It starts independent model calls in parallel, checkpoints results in Postgres, and coordinates recovery with expiring leases and fenced writes. The web playground lets visitors bring their own keys and inspect every step. Local adapters let the same engine coordinate Pi, Claude Code and Codex.”

Use first person for your work, explain the tradeoffs, and distinguish measured behavior from unverified integrations. The engine is the main engineering contribution. External models and coding agents provide inference/tool loops; they do not supply Relay's scheduler or persistence.

## Five-minute demonstration

| Time | Action | Point to explain |
| --- | --- | --- |
| 0:00–0:45 | Open the homepage and click through the scheduler diagram. | DAG dependencies and readiness rather than a fixed sequential chain. |
| 0:45–2:00 | Run the engine tour; select parallel nodes, resolved prompts and final output. | Template-derived dependencies, checkpoints and an inspectable execution trace. Explain that demo text is scripted. |
| 2:00–3:00 | Run the retry lab and open Timeline. | One transient failure retries without discarding successful work; cancellation and budgets are separate policies. |
| 3:00–4:00 | Run `bun run demo:crash` locally. | Two worker identities, lease expiry, fenced writes, retained checkpoints and at-least-once semantics. |
| 4:00–5:00 | Show Connections, agent example and architecture sources. | Encrypted BYOK isolation; API adapters versus local subprocess agents; discuss credential-dependent live verification honestly. |

## Questions to prepare for

**Why Postgres rather than a queue?** Transactions, row locks and leases provide one shared coordination system for this deployment. A queue is a useful future choice for global admission control and unattended workers; it does not remove the need for checkpoints and idempotency.

**What if two workers run the same step?** Only one current lease owner can commit. If a call outlives ownership, the old result is rejected. The external call may still have incurred a charge. Side effects require an idempotency key outside this database.

**Why polling?** Stored events provide resumable cursors while short polling requests suit serverless execution. SSE would keep a connection/function active. Polling adds latency and read volume, which are measurable tradeoffs.

**How is replanning safe?** The model proposes replacements. Code checks references, preserves output contracts, renames ids, rewires descendants and validates the final graph. The model does not directly mutate the database.

**How do you measure improvement?** Fixed simulated latency isolates scheduling effects. Concurrency 4 took 4.48 s versus 10.40 s sequentially in the recorded workload. Real APIs introduce rate limits, variance and cost; those require a separate controlled evaluation.

**What would production need next?** Account authentication/recovery, global abuse and admission controls, durable unattended workers, per-provider billing reconciliation, encrypted-data retention policy, and operational alerts. Prioritize those from real usage instead of presenting them as completed.

## Engineering evidence

Show the [test report](testing/verification.md), [architecture](ARCHITECTURE.md), [benchmark](benchmark.md) and [primary-source comparison](research/agent-systems.md). For deeper code, use `engine/store.ts` for transactions/fences, `engine/scheduler.ts` for ready-step scheduling, `planner/planner.ts` for graph rewrites, and `platform/` for the BYOK boundary.
