# Glossary

| Term | Meaning in Relay |
| --- | --- |
| DAG | Directed acyclic graph; nodes are steps and edges are required prior outputs. |
| Ready step | Pending step whose dependencies all succeeded. |
| Checkpoint | Committed step output, status and usage that a successor worker can reuse. |
| Lease | Time-limited database ownership held and renewed by one worker. |
| Fenced write | A write permitted only for the current owner of an active run. |
| At least once | Interrupted external work may repeat before its result is safely committed. |
| Replanning | Replacing a failed branch while preserving succeeded work and output contracts. |
| Provider | One inference/agent invocation behind the `LlmProvider` interface. |
| Workspace | Resources scoped to a random browser cookie; not an account. |
| BYOK | Bring your own API key; visitor-controlled provider credentials and quota. |
| Event cursor | Last seen monotonically increasing event id used for polling. |
| AAD | Authenticated associated data; ties encrypted credentials to their owner and connection. |
