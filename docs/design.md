# Relay design

Relay is a durable workflow engine for LLM agents. You give it a goal. A planner model turns the goal into a graph of steps, the engine runs independent steps in parallel, and every result lands in SQLite. If the process dies, another process picks the run up and continues from the last finished step. A Next.js dashboard draws the graph and updates it live.

## Problem

A useful agent pipeline makes 10 to 50 model calls. Somewhere in the middle one of them hits a rate limit, times out, or the server restarts. A naive runner loses the whole run and starts over, which costs time and money. It also gives no answer to "which step is running, which failed, and what did each step cost?"

Single-agent loops (ReAct style) have a second problem. They do one thing at a time, so a task with five independent research questions takes five times longer than it needs to.

## Goals

1. Run a DAG of LLM steps with the maximum safe parallelism.
2. Never re-run a step that already succeeded, even across crashes and restarts.
3. Build the DAG from a natural-language goal and repair failed branches by re-planning.
4. Produce cited research reports using Gemini with Google Search grounding.
5. Show runs live: graph, per-step status, outputs, sources, tokens, and cost.

## Non-goals

- Human approval or pause-for-input steps.
- Arbitrary code or HTTP steps. Every step is a model call.
- Multi-tenant auth. The dashboard runs locally.
- Distributed execution across machines. Several engine processes can share one SQLite file on one machine.

## Architecture

```mermaid
flowchart LR
  subgraph web [web: Next.js]
    UI[Run list and run view]
  end
  subgraph server [server: Bun + Express]
    API[REST + SSE]
    PL[Planner]
    SCH[Scheduler]
    LSE[Lease manager]
    RL[Rate limiter]
    CACHE[Step cache]
    LLM[LlmProvider]
  end
  DB[(SQLite, WAL)]
  G[Gemini API]

  UI -- fetch --> API
  UI -- EventSource --> API
  API --> PL --> LLM
  API --> SCH
  SCH --> RL --> LLM --> G
  SCH --> CACHE --> DB
  SCH --> DB
  LSE --> DB
  API -- tail events --> DB
```

The repo has two Bun workspaces.

- `server/` owns all state. It is the only thing that talks to SQLite and Gemini.
- `web/` is a Next.js App Router app. It holds no state of its own and reads everything from the server over HTTP.

The split matters for runs that take minutes. A Next.js dev reload restarts the web process, and the engine keeps running.

### Server layout

```
server/src/
  index.ts              wiring: config, store, provider, engine, HTTP server, shutdown
  config.ts             env parsing with zod
  api/app.ts            express app, routes, error middleware
  api/sse.ts            event stream with Last-Event-ID replay
  engine/types.ts       StepDef, Graph, RunStatus, StepStatus, Event types
  engine/graph.ts       validation, dependency inference, cycle detection, topo order
  engine/template.ts    {{id.output}}, {{id.output.path}}, {{id.sources}} resolution
  engine/store.ts       SQLite schema, migrations, queries
  engine/scheduler.ts   runs one graph to completion
  engine/engine.ts      owns schedulers, leases, sweeper, cancel, retry, replan hook
  engine/retry.ts       backoff with jitter, retryable error classification
  engine/rate-limiter.ts  token bucket shared by every run in the process
  engine/cache.ts       content-addressed step output cache
  engine/events.ts      in-process event bus used to wake SSE streams
  llm/provider.ts       LlmProvider interface and LlmError
  llm/gemini.ts         Gemini implementation
  llm/fake.ts           scripted provider for tests and benchmarks
  llm/pricing.ts        price table and cost function
  llm/demo.ts           keyless provider for running the stack without an API key
  planner/planner.ts    goal to graph and branch repair, with a validation feedback loop
  planner/profiles.ts   prompts, response schemas, and the research graph shape
server/scripts/         benchmark and crash recovery demo
```

## Workflow definition

```ts
type StepDef = {
  id: string;                 // /^[a-z][a-z0-9_]{0,39}$/
  prompt: string;             // may contain templates
  dependsOn?: string[];       // merged with ids referenced in the prompt
  tools?: ("search")[];       // Gemini Google Search grounding
  output?: { type: "text" } | { type: "json"; schema: JsonSchema };
  retries?: number;           // 0..5, default 2
  timeoutMs?: number;         // 1_000..300_000, default 90_000
  cache?: boolean;            // default false
  final?: boolean;            // marks the report step for the UI
};

type Graph = { steps: StepDef[] };
```

### Templates

A template is resolved when its step starts, from the saved outputs of finished steps.

| Template | Value |
|---|---|
| `{{a.output}}` | Output text of step `a`. For a JSON step, the pretty-printed JSON. |
| `{{a.output.items[0].name}}` | A value inside a JSON output. Objects render as JSON, strings render raw. |
| `{{a.sources}}` | Numbered list of search sources from step `a`: `[1] Title - https://...` |
| `{{goal}}` | The run's goal, or an empty string for hand-written graphs. |

A path that does not exist in the JSON output fails the step with a `TemplateError` and no retry, because retrying cannot fix it.

### Validation

`validateGraph(graph)` returns either a normalized graph or a list of issues. The API returns 400 with every issue, and the planner feeds the same list back to the model. Checks, in order:

1. The shape matches the zod schema, and the graph has 1 to 50 steps.
2. Step ids are unique.
3. Every id in `dependsOn` and every template reference exists. A step may not reference itself.
4. Template references are added to `dependsOn`.
5. There are no cycles. Kahn's algorithm removes nodes with in-degree zero. If nodes remain, a DFS over them finds one cycle and reports it as `cycle: a -> b -> c -> a`.
6. A JSON output schema is an object the provider accepts (`type` present, no empty `properties`).

## Data model

SQLite through `bun:sqlite`, with `journal_mode=WAL` and `busy_timeout=5000` so several processes can share the file.

```sql
runs (
  id TEXT PRIMARY KEY,
  goal TEXT,
  profile TEXT,                 -- 'general' | 'research' | NULL for hand-written graphs
  graph_json TEXT,              -- current graph, NULL while planning
  graph_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,         -- planning | running | succeeded | failed | cancelled
  error TEXT,
  concurrency INTEGER NOT NULL,
  max_replans INTEGER NOT NULL,
  replans INTEGER NOT NULL DEFAULT 0,
  budget_tokens INTEGER,
  budget_usd REAL,
  planning_input_tokens INTEGER NOT NULL DEFAULT 0,   -- planner and replanner calls
  planning_output_tokens INTEGER NOT NULL DEFAULT 0,
  planning_cost_usd REAL NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,     -- epoch ms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  graph_version INTEGER NOT NULL,
  status TEXT NOT NULL,         -- pending | running | succeeded | failed | skipped | superseded
  attempt INTEGER NOT NULL DEFAULT 0,
  resolved_prompt TEXT,
  output TEXT,
  sources_json TEXT,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  search_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (run_id, step_id)
)

events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)

step_cache (
  key TEXT PRIMARY KEY,         -- sha256 of model, resolved prompt, tools, output schema
  output TEXT NOT NULL,
  sources_json TEXT,
  created_at INTEGER NOT NULL
)
```

Token counts and cost live only on `steps`. Run totals come from `SUM` over the run's steps, so the two can never disagree. Tokens from failed attempts are added to the step as they happen, because failed calls still cost money.

Every state change and its event are written in one transaction. The event id is the SSE event id.

### Event types

`run.created`, `run.planned`, `step.started`, `step.retrying`, `step.succeeded`, `step.failed`, `step.skipped`, `run.replanned`, `run.replan_failed`, `run.budget_exceeded`, `run.lease_taken`, `run.retried`, `run.succeeded`, `run.failed`, `run.cancelled`.

## Engine

### Run lifecycle

```mermaid
stateDiagram-v2
  [*] --> planning: POST /runs with goal
  [*] --> running: POST /runs with graph
  planning --> running: planner returns a valid graph
  planning --> failed: planner fails 3 times
  running --> succeeded: every live step succeeded
  running --> failed: a step failed and no replan is left, or budget exceeded
  running --> cancelled: POST /runs/:id/cancel
  failed --> running: POST /runs/:id/retry
```

### Scheduling

The scheduler for one run keeps an in-memory view of the step table, loaded from SQLite when it starts.

1. A step is ready when it is `pending` and every dependency is `succeeded`.
2. While fewer than `concurrency` steps are in flight and the ready set is not empty, it takes the ready step that comes first in topological order and launches it.
3. When any step settles, it writes the result, then re-computes the ready set. The scheduler never waits for a whole level, so a slow step does not block unrelated branches.
4. When nothing is in flight and nothing is ready, the run is finished. It succeeds if every step with a live status (anything but `superseded`) succeeded.

### Executing a step

1. Resolve templates. Write `status=running`, `attempt+1`, and `resolved_prompt`, and emit `step.started`.
2. If `cache` is on, look up the cache key. On a hit, save the output with `cached=1`, zero cost, and finish.
3. Wait for a rate limiter token. Waiting time does not count against the timeout.
4. Call the provider with a signal that aborts on run abort or when `timeoutMs` passes. The timeout runs on the injected clock, so tests drive it without sleeping.
5. On success with `output.type = "json"`, parse the text and validate it against the schema with Ajv. A parse or schema failure counts as a retryable error, and the next attempt's prompt gets the validation error appended.
6. Save output, sources, and usage, and emit `step.succeeded`.

### Retries

`classify(error)` returns `retryable` or `fatal`.

- Retryable: timeouts, network errors, HTTP 429, HTTP 5xx, and JSON output that fails to parse or validate.
- Fatal: HTTP 400, 401, and 403, template errors, and aborts caused by cancel.

A retryable error with attempts left waits `min(30s, 1s * 2^(attempt-1)) * random(0.5..1.5)`, emits `step.retrying`, and tries again. A 429 with a `retry-after` value waits that long instead. Otherwise the step becomes `failed`.

### Failure and re-planning

When a step fails for good:

1. If the run has a goal and `replans < max_replans` (default 2), the engine calls the replanner. It sends the goal, the failed step's prompt and error, and the output of every succeeded step truncated to 2,000 characters.
2. The model writes 1 to 3 replacement steps. They may reference only succeeded steps or each other. The last one stands in for the failed step and inherits its output contract (text, or the same JSON schema).
3. Code does the graph surgery, not the model. The failed step and its unfinished descendants become `superseded`. Each descendant is recreated under a new id (`report` becomes `report_r2`) with its template references renamed, so `{{failed.output.x}}` becomes `{{replacement.output.x}}`. Ids that collide with existing rows get the next free `_rN` suffix.
4. The merged graph goes through `validateGraph`. Issues go back to the model, up to 3 attempts. On success the engine installs it as the next `graph_version`, emits `run.replanned`, and the scheduler reloads and continues.
5. If there are no re-plans left, or re-planning fails, every descendant of the failed step becomes `skipped`. Independent branches keep running, and the run ends `failed`.

Failure hooks run one at a time, so two branches failing together cannot replan over each other.

### Budgets

A run may set `budget_tokens`, `budget_usd`, or both. Before each launch the scheduler reads the run totals. If a limit is reached, it stops launching, marks pending steps `skipped` with reason `budget`, lets in-flight steps finish, and ends the run `failed` with `budget exceeded`. In-flight steps can push the total past the limit by their own usage, and the README states that.

### Rate limiting

A token bucket with capacity `GEMINI_RPM / 6` that refills at `GEMINI_RPM / 60` tokens per second. Every run in the process shares it. `acquire(signal)` resolves in FIFO order and rejects if the signal aborts while waiting.

### Step cache

The key is `sha256(JSON.stringify([model, resolvedPrompt, tools, outputSchema]))`. It is opt-in per step, because search results change over time. Hits are saved like normal results with `cached=1` so the UI can show them.

### Leases, crash recovery, and multiple processes

Each engine process gets a `workerId` (a random UUID) at start.

- **Claim.** `UPDATE runs SET lease_owner=?, lease_expires_at=now+30s WHERE id=? AND status IN ('planning','running') AND (lease_owner IS NULL OR lease_expires_at < now)`. The process drives the run only if the update changed one row. A run claimed while `planning` is planned again from the start.
- **Heartbeat.** Every 10 seconds the owner extends the lease with `WHERE id=? AND lease_owner=?`. If that changes zero rows, another process took the run. The owner aborts its scheduler and drops its in-flight results without writing them.
- **Sweeper.** Every 5 seconds, and once at startup, each process looks for `running` runs with no live lease and claims them. A claimed run resets its `running` steps to `pending`, keeping their attempt counts, and emits `run.lease_taken`.
- **Fencing.** Every owner write includes `AND EXISTS (SELECT 1 FROM runs WHERE id=? AND lease_owner=? AND status IN ('planning','running'))`. A stale owner that wakes up after losing its lease cannot overwrite the new owner's work. Because the fence also checks status, a cancel written by any process blocks the owner's writes at once, and the owner's next heartbeat aborts its in-flight calls.
- **Graceful shutdown.** On SIGINT or SIGTERM the process stops claiming, aborts in-flight calls, resets its running steps to `pending`, clears its leases, and exits. Another process, or the next start, resumes right away without waiting 30 seconds.

This gives at-least-once execution per step. A step killed in the middle of a model call runs again, which is acceptable for model calls because they have no side effects. A succeeded step never runs again.

## Planner

`POST /runs` with `{ goal, profile }` creates a run in `planning` and returns at once. Planning happens in the background.

1. Build the prompt for the run's profile.
2. Call the model with `responseMimeType: "application/json"` and a hand-written response schema. A step's output schema travels as a JSON string (`outputJsonSchema`), because Gemini's schema subset cannot describe "any JSON Schema".
3. Convert the reply to `StepDef`s and run `validateGraph`. On issues, send the model its previous reply and the issue list, up to 3 attempts in total.
4. On success, save the graph as version 1 together with the planning token usage, emit `run.planned`, and start scheduling. After 3 failed attempts the run ends `failed` with the last issues in the `run.failed` event.

### Profiles

**general.** The model writes 2 to 12 steps. The prompt tells it to keep independent work free of dependencies so it runs in parallel. If no step is marked `final`, the last step nothing depends on gets the mark.

**research.** The model only picks 3 to 6 sub-questions. Code builds the graph from them, so the shape is guaranteed:

1. One `research_<topic>` step per sub-question with search and JSON output `{ summary, findings[] }`.
2. One `verify` step that reads every research output, uses search, and returns JSON `{ confirmed[], disputed[{ claim, reason }] }`.
3. One `write` step marked `final` that reads the research outputs, their `{{research_x.sources}}`, and the fact check, and writes a markdown report with one numbered reference list.

`SEARCH_ENABLED=false` builds the same graph without search and tells the steps to answer from model knowledge without inventing citations. It exists for API keys that have no grounding quota.

## LLM provider

```ts
interface LlmProvider {
  readonly model: string;
  generate(req: {
    prompt: string;
    tools?: ("search")[];
    jsonSchema?: object;
    signal: AbortSignal;
  }): Promise<{
    text: string;
    sources: { title: string; url: string }[];
    usage: { inputTokens: number; outputTokens: number; searchCalls: number };
  }>;
}
```

`GeminiProvider` maps `usageMetadata.promptTokenCount` plus `toolUsePromptTokenCount` to input tokens, and `candidatesTokenCount` plus `thoughtsTokenCount` to output tokens. It reads `groundingMetadata.groundingChunks[].web` for sources and counts `webSearchQueries.length > 0` as one search call. Errors turn into `LlmError { status, retryAfterMs }`.

Default pricing for `gemini-3.5-flash` is $1.50 per 1M input tokens, $9.00 per 1M output tokens, and $14 per 1,000 search calls. `PRICE_INPUT_PER_M`, `PRICE_OUTPUT_PER_M`, and `PRICE_SEARCH_PER_K` override them.

`FakeProvider` takes a handler `(req, callIndex) => result | Error` and an optional delay. Tests and the benchmark use it, so neither needs an API key.

## HTTP API

Every error has the body `{ "error": { "code": string, "message": string, "issues"?: string[] } }`.

| Method and path | Body | Result |
|---|---|---|
| `POST /runs` | `{ graph }` or `{ goal, profile }`, plus optional `concurrency` (1-16, default 4), `maxReplans` (0-5), `budget: { tokens?, usd? }` | 201 `{ runId }`. 400 for an invalid graph, with issues. |
| `GET /runs` | | 200 `{ runs: RunSummary[] }`, newest first, limit 50 |
| `GET /runs/:id` | | 200 `{ run, steps, totals }`. 404 if missing. |
| `GET /runs/:id/events` | | `text/event-stream`. Replays events with id greater than `Last-Event-ID` or `?after=`, then streams live ones. Heartbeat comment every 15 seconds. |
| `POST /runs/:id/cancel` | | 202. 409 if the run is already finished. |
| `POST /runs/:id/retry` | | 202. Resets failed and skipped steps to `pending` and sets the run to `running`. 409 unless the run is `failed`. |
| `GET /health` | | 200 `{ ok, workerId, pid }` |

The SSE handler tails the `events` table by id. The local event bus wakes it immediately for events written by the same process. A 1 second poll catches events written by other processes.

CORS allows `WEB_ORIGIN` (default `http://localhost:3000`).

## Dashboard

Next.js App Router with Tailwind, `@xyflow/react` for the graph, `@dagrejs/dagre` for left-to-right layout, and `react-markdown` for reports.

- **`/`** shows the run list with status, goal, step counts, cost, and age. Two forms start runs: a goal box with a profile picker and budget fields, and a JSON graph editor that shows validation issues returned by the API.
- **`/runs/[id]`** has four parts.
  - A header with status, elapsed time, tokens, cost, graph version, and Cancel and Retry buttons.
  - The graph. Node color follows status, edges into running steps animate, cached steps get a badge, and superseded steps render faded. A replan re-fetches the run and runs the layout again.
  - A side panel for the selected step: resolved prompt, output (markdown or JSON), sources as links, attempts, error, tokens, and cost.
  - Tabs for the final report and the event timeline.

Live updates use one `EventSource` per page. A reducer applies each event to the run state. `EventSource` reconnects on its own and sends `Last-Event-ID`, so no events go missing.

## Testing

`bun test` in `server/`, with no network access and no API key.

- `graph.test.ts` covers valid graphs, duplicate ids, unknown dependencies, self references, dependency inference from templates, cycle reports, and topological order.
- `template.test.ts` covers text, JSON paths, sources, missing paths, and `{{goal}}`.
- `retry.test.ts` covers classification, backoff bounds, and `retry-after`.
- `rate-limiter.test.ts` covers burst, refill, FIFO order, and abort while waiting, using a fake clock.
- `scheduler.test.ts` uses `FakeProvider` and an in-memory database. It covers outputs reaching dependents, the observed maximum concurrency, a slow step not blocking an unrelated branch, retry then success, failure skipping descendants only, JSON output validation and re-prompting, cancel, cache hits, and budget stops.
- `engine.test.ts` uses a temp database file shared by two `Engine` instances. It covers resume after one engine stops without cleanup (succeeded steps are not called again), lease takeover, fencing rejecting a stale writer, graceful shutdown handoff, and retry of a failed run.
- `planner.test.ts` covers an invalid plan followed by a valid one, giving up after 3 attempts, research shape enforcement, and a replan that merges into the graph.
- `api.test.ts` starts the app on a random port. It covers every route, error bodies, and SSE replay with `Last-Event-ID`.

`web/` must pass `tsc --noEmit` and `next build`. The run reducer has its own unit tests.

## Benchmark and demos

`bun run bench` runs a 12-step research-shaped graph on `FakeProvider` with fixed per-step latency, at 1, 2, 4 and 8 steps at once, and compares Relay's scheduler with the level-by-level approach on a mixed-latency graph. It writes `docs/benchmark.md`.

`bun run demo:crash` starts two engine processes on one database, kills the first mid-step, and checks that the second finishes the run without repeating a finished step.

## Configuration

| Variable | Default |
|---|---|
| `GOOGLE_API_KEY` | required unless `LLM_PROVIDER=demo` |
| `LLM_PROVIDER` | `gemini`, or `demo` for scripted replies with no key |
| `GEMINI_MODEL` | `gemini-3.5-flash` |
| `GEMINI_RPM` | `60`. Set `5` on the Gemini free tier. |
| `SEARCH_ENABLED` | `true` |
| `LEASE_TTL_MS` | `30000`. The heartbeat is a third of it, the sweep at most 5 s. |
| `PRICE_INPUT_PER_M`, `PRICE_OUTPUT_PER_M`, `PRICE_SEARCH_PER_K` | Gemini 3.5 Flash list prices |
| `DATABASE_PATH` | `data/relay.db` |
| `PORT` | `4000` |
| `WEB_ORIGIN` | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` |

## Build order

1. Workspace restructure. Move the current code to `server/`, add scripts.
2. Graph validation and templates.
3. SQLite store.
4. Provider interface, fake provider, retry, rate limiter.
5. Scheduler.
6. Engine with leases, sweeper, shutdown, cancel, retry.
7. HTTP API and SSE.
8. Gemini provider, pricing, JSON output, step cache, budgets.
9. Planner, research profile, replanner.
10. Next.js dashboard.
11. Benchmark, README, and demo script.
