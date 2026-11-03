# Relay release design

## Outcome

Relay is a portfolio-ready, independently implemented orchestration engine with a public playground. A visitor can understand the scheduler, run a clearly labelled simulation without credentials, connect their own model provider, inspect every step, and export the result. Local developers can put Pi, Claude Code, and Codex behind the same provider interface.

## Architecture

Keep the existing Bun workspaces, Next.js application, Postgres store, graph validation, dependency templates, lease fencing, retries, budgets, and re-planning. Extend these boundaries instead of replacing the tested engine with an agent framework.

The engine resolves a runtime once per leased run. That runtime supplies the provider, planner, pricing, rate limiter, and cache namespace. Persist a nonsecret execution identity and connection reference with the run so takeover selects the original provider. Keep credentials in a separate encrypted connections table. Never return ciphertext or keys through run snapshots, events, or connection listings.

The public API assigns a 256-bit random, HttpOnly, SameSite workspace cookie. Queries and mutations check the owner on the server, including event polling. Missing and foreign run ids return the same 404. Requests that change state reject cross-origin browser submissions. This is a browser capability workspace, not an account system: clearing the cookie loses access and there is no cross-device recovery.

## Provider connections

Support OpenAI, Anthropic, Gemini, Groq, Cerebras, and OpenRouter. Use fixed provider endpoints to avoid server-side request forgery. Accept a provider, model, connection name, API key, rate limit, and optional input/output token prices. Validate with a small real model request before saving. Encrypt keys with AES-256-GCM, random nonces, and owner/connection associated data. Require a stable `RELAY_SECRET` in production; store an owner-readable local development key outside Git. Deleting a connection is blocked while it has active runs. Historic run identity remains after deletion; retry requires the original connection.

The default public connection is always the scripted demo. Public visitors cannot select server environment credentials. Per-connection limiters and owner-scoped caches prevent accidental quota and result sharing. Budgets include planning costs and stop new launches, while in-flight calls may exceed the budget.

## Local agents

Implement subprocess adapters for Pi JSON mode, Claude Code print JSON, and Codex exec JSONL. Launch argument arrays with `shell: false`; pass the prompt on stdin; constrain output size; propagate cancellation and timeouts; parse final responses and reported token usage. Keep the adapter opt-in, local, and read-only by default. No hosted endpoint launches local commands. Document that process flags do not turn Pi into an OS sandbox and that side-effecting agent tools need external isolation and idempotency.

Provide a local DAG example whose independent analysis branches use all three adapters and whose synthesis uses a selected adapter. Adapter protocol tests use executable fixtures; authenticated live calls are reported separately.

## Website

Keep Relay's signal-box visual language: pale blue-green surfaces, graphite type, state lamps, Overpass and Overpass Mono. Give the landing page a readable statement of the product and a diagram that explains dependency scheduling. Add a playground, six runnable templates, connection settings, and an architecture page with source links and the distinction between agent loops and cross-agent orchestration.

The playground supports goal planning and graph JSON, template selection, validation errors, concurrency, replans, token/dollar budgets, and connection selection. Include a deterministic transient-failure demo. The existing live graph, timeline, retries, cancellation, search, filters, step deep links, and Markdown export remain available. Add graph/trace JSON export and show the actual provider/model and whether a run is simulated.

## Acceptance criteria

- A fresh checkout starts in demo mode with no secrets and a local PGlite database.
- Two browser workspaces cannot read, list, cancel, retry, delete, or poll each other's runs or connections.
- Encrypted credentials survive process recreation; authentication failures never save a connection; listings never reveal keys.
- Different runs select different providers and recover using their persisted connection; caches stay within the connection/workspace.
- Each local adapter parses its real documented protocol and handles failure and cancellation without a shell.
- All six templates validate and complete in demo mode; the retry example emits a retry event and completes.
- Unit/integration tests, typechecks, lint, production build, real Postgres tests, benchmark, crash demo, and browser-level workflows pass.
- The README follows Readme Pro Max, links verified screenshots and the public site, and includes architecture, operations, security, testing, and interview material.
- Publish the verified source revision to the existing Relay Vercel project; connect an available Namecheap subdomain without altering other sites.

## Explicit limits

This release is a capability-based portfolio application, not a billing platform or durable managed job service. Vercel continuation requires requests after a function expires. Execution is at least once. API prices are user-supplied estimates. Simulated output is not research evidence. Hosted workflows do not execute arbitrary tools or local CLIs.
