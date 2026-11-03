# HTTP API

The application mounts these JSON endpoints at `/api`, with `Cache-Control: no-store`. Run and connection operations are scoped to a private browser workspace. Deployment API keys are not used for visitor execution.

## Session

Call `GET /api/session` first and preserve `Set-Cookie`. The browser serializes initialization. The random cookie is HttpOnly, SameSite=Lax, Path=/, Max-Age=2592000 and Secure over HTTPS. It is a bearer capability, not an account.

Writes reject a mismatched `Origin` or `Sec-Fetch-Site: cross-site`. CLI clients can preserve a cookie jar and send the origin explicitly. Do not log or commit the jar.

```bash
curl -c /tmp/relay-cookies -b /tmp/relay-cookies https://relay-workflows-rust.vercel.app/api/session
curl -c /tmp/relay-cookies -b /tmp/relay-cookies \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://relay-workflows-rust.vercel.app' \
  --data '{"graph":{"steps":[{"id":"first","prompt":"Explain checkpoints."},{"id":"summary","prompt":"Summarize: {{first.output}}","final":true}]}}' \
  https://relay-workflows-rust.vercel.app/api/runs
```

## Routes

| Method and path | Request or response |
| --- | --- |
| `GET /session` | Initialize workspace; `{ok, workspace}`. |
| `GET /health` | `{ok, workerId}` after engine initialization. |
| `GET /providers` | `{providers}` catalog. |
| `GET /connections` | `{connections}` without credentials. |
| `POST /connections` | Validate/save `{name, provider, model, apiKey, rpm?, inputPerM?, outputPerM?, searchEnabled?}`; 201 `{connection}`. |
| `DELETE /connections/:id` | Remove owned, inactive credential; `{ok}`. |
| `POST /runs` | Goal or graph; 201 `{runId}`. |
| `GET /runs?limit=50` | `{runs}` newest first, limit 1–200. |
| `GET /runs/:id` | `{run, steps, totals, lastEventId}`. |
| `GET /runs/:id/events?after=0` | `{events}`, up to 500, oldest first after cursor. |
| `POST /runs/:id/cancel` | 202 `{ok}`. |
| `POST /runs/:id/retry` | Restart eligible failed work; 202 `{ok}`. |
| `DELETE /runs/:id` | Delete terminal run, steps and events; `{ok}`. |

Other-workspace reads and writes return 404. The library's bare `createApi` is internal; hosting must use `createPlatformApi` for ownership checks.

## Run request

Provide one of `goal` and `graph`. Goal runs accept `profile: "general" | "research"` and `maxReplans`. Common fields: `concurrency`, `budget: {tokens?, usd?}`, optional `connectionId`, `demoScenario: "success" | "retry"`. Null/absent connection means simulation. Custom endpoints and inline keys are not run configuration.

```json
{
  "goal": "Compare a queue with database leases for durable model calls",
  "profile": "general",
  "concurrency": 3,
  "maxReplans": 2,
  "budget": { "tokens": 20000 },
  "connectionId": null
}
```

Graphs contain 1–50 steps, each with `id` and `prompt`. Optional fields: `dependsOn`, `tools: ["search"]`, `output`, `retries` (0–5, default 2), `timeoutMs` (1000–300000, default 90000), `cache` and `final`. Text is default output; JSON uses `{ "type": "json", "schema": { ... } }`, validated with Ajv after inference.

## Errors and events

Errors follow `{ "error": { "code": "invalid_graph", "message": "invalid graph", "issues": ["..."] } }`. Status codes: 400 validation, 403 origin, 404 missing/other workspace, 409 transition/limit, 413 oversized body, 500 internal and 503 startup configuration.

Events include `run.created`, `run.planned`, `step.started`, `step.retrying`, `step.succeeded`, `step.failed`, `step.skipped`, `run.replanned`, `run.replan_failed`, `run.budget_exceeded`, `run.lease_taken`, `run.retried`, `run.succeeded`, `run.failed` and `run.cancelled`. Resume after the last received id. Snapshots include a cursor to avoid reapplying already-incorporated events. This is polling, not SSE.

Sources: [`platform/api.ts`](../../server/src/platform/api.ts), [`handler.ts`](../../server/src/api/handler.ts), [`graph.ts`](../../server/src/engine/graph.ts), [`engine.ts`](../../server/src/engine/engine.ts), [`providers.ts`](../../server/src/platform/providers.ts).
