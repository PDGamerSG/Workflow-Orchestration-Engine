# Troubleshooting

| Symptom | Check and action |
| --- | --- |
| Engine offline / API 503 | Inspect server logs. Production needs reachable `DATABASE_URL` and stable `RELAY_SECRET` with at least 32 characters. Do not paste secrets into issue reports. |
| Missing API-key startup error | Use `LLM_PROVIDER=demo` for local website setup. Real visitor execution is configured in Connections. A legacy root `.env` may select a deployment provider. |
| Runs or connections disappeared | Check browser, hostname and cookie lifetime. Private windows have separate workspaces. Lost/expired workspace cookies cannot be recovered. |
| Key validation fails | Check exact provider, model id, API access and quota. Subscription access does not necessarily include API credits. Nothing is saved after failure. |
| Dollar budget rejected | Configure input/output token prices on a new saved connection, or use a token budget. |
| 429 errors | Reduce saved-connection RPM/concurrency. Several hosted instances can exceed a provider-wide quota despite per-process buckets. |
| Structured output keeps retrying | Confirm the selected model supports JSON schemas. Inspect the output contract and provider text. Unsupported schema keywords may require a simpler schema. |
| Research has no sources | Only enabled Gemini grounding supplies live search here. Other providers use model knowledge. The demo has scripted content and is not a live search. |
| Run pauses after a long idle period | Open the dashboard or make an API request to trigger a sweep after lease expiry. Serverless functions do not wake themselves. |
| Cannot remove a key or run | Cancel active runs first. Only terminal runs can be deleted; a key used by active runs is protected. |
| Retry fails after key removal | The original connection id is no longer available. Create a new connection and start a new run; previous results stay readable. |
| Decryption failure after redeploy | Restore the original encryption secret. Rotation without re-encryption cannot decode old credentials. |
| PGlite is locked or a dev process fails | Stop the other process using that directory. Each process needs its own local PGlite directory, or use shared Postgres. Back up before deleting data. |
| Next dev fails after dependency update | Restart the dev process so it loads one consistent Next.js version. |
| Agent executable not found | Install the requested CLI and verify it is on the process PATH. Use the single-agent smoke command before the full example. |
| Local agent exits or times out | Verify authentication and model availability outside Relay. Adapters suppress diagnostic output that could contain secrets. See the agent's own authenticated console/logging tools. |

Relevant source: [`route.ts`](../web/app/api/%5B...path%5D/route.ts), [`secret.ts`](../server/src/platform/secret.ts), [`connections.ts`](../server/src/platform/connections.ts), [`runtime.ts`](../server/src/platform/runtime.ts), [`agents`](../server/src/agents/).
