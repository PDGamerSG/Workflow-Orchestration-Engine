# Test plan

## Automated gates

| Layer | Command | Meaningful coverage |
| --- | --- | --- |
| Unit/integration | `bun run test` | Graph validation, templates, planner rewrites, scheduler, retry, budgets, cache, two-worker recovery, workspace isolation, encryption and provider protocols. |
| Real database | `TEST_DATABASE_URL=postgres://... bun run --filter '@relay/server' test` | Same store/engine/platform behavior under PostgreSQL transactions and locks. Use a disposable database. |
| Types | `bun run typecheck` | Both workspaces and generated Next.js route types. |
| Lint | `bun run lint` | React/Next.js and web code quality rules. |
| Release build | `bun run build` | Production compilation and static/dynamic routes. |
| Browser | `cd web && bun run test:e2e` | Demo completion/export, transient retry, graph errors, cancel/delete, cross-context isolation and mobile layout. |
| Dependency audit | `bun audit --production` and `bun audit --audit-level=high` | All production advisories and high/critical development advisories. Full audit has a documented moderate development finding. |

Install browser binaries once with `cd web && bunx playwright install chromium`. CI installs system dependencies as well and retains failure traces/screenshots. Set `PLAYWRIGHT_BASE_URL` to test a running deployment instead of starting a local development process. Browser tests create isolated, cookie-scoped demo runs.

## Reliability demonstrations

`bun run demo:crash` runs two engines against one database, stops one mid-step without cleanup, and verifies completed steps do not repeat. `bun run bench` records fixed simulated-latency results in `docs/benchmark.md`. These are reproducible mechanism demonstrations, not production load or model-quality evaluations.

## External smoke tests

To verify paid inference, add a real connection, complete a goal run and a JSON-output template, inspect measured usage, restart a worker and recover the same provider, then remove the credential after cancelling active work. This requires a working key, quota and exact model support. Do not substitute fixture tests for this claim.

For local agents, run each `bun run demo:agents --agent=...` then the complete graph. Verify actual CLI authentication separately. The committed executable fixtures test stdin, protocol mapping, exit handling, cancellation and output limits without credentials.

Sources: [CI](../../.github/workflows/ci.yml), [Playwright configuration](../../web/playwright.config.ts), [browser cases](../../web/e2e/workflows.spec.ts), [platform tests](../../server/src/platform/platform.test.ts), [recovery tests](../../server/src/platform/recovery.test.ts), [agent tests](../../server/src/agents/provider.test.ts).
