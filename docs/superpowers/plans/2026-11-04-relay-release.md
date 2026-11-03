# Relay release implementation plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task in the current session. Checkboxes record verified deliverables.

**Goal:** Ship a working public orchestration playground and an evidence-backed engineering portfolio project.

**Architecture:** Extend the existing engine with per-run runtime resolution and workspace-scoped API access. Store encrypted provider connections separately from public run metadata. Keep local coding-agent adapters outside hosted routes.

**Tech stack:** TypeScript, Bun, Next.js 16, React 19, Postgres/PGlite, React Flow, AES-256-GCM, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-relay-release-design.md`

## Global constraints

- Preserve existing lease fencing, graph validation, recovery, and retry behavior.
- Never persist plaintext API keys or return them to the browser.
- Default public runs use the labelled demo; hosted routes never launch commands.
- Keep commits focused and use the repository author's configured identity without attribution trailers.
- Verify actual behavior and record external-service limitations accurately.

## Task 1: Research and define the release

**Files:** release design, this plan, `docs/research/agent-systems.md`.

- [x] Inspect current engine, dashboard, tests, configuration, repository state, and hosting access.
- [x] Fetch primary documentation for Codex exec/SDK, Claude Code headless, Pi CLI/JSON/RPC, and Readme Pro Max.
- [x] Define acceptance criteria and preserve existing architectural boundaries.
- [x] Commit the design, plan, and source comparison.

## Task 2: Private BYOK execution

**Files:** `server/src/platform/{connections,crypto,runtime,api,session}.ts`, matching tests, `server/src/llm/{anthropic,openai}.ts`, `server/src/engine/{store,engine,scheduler}.ts`, `server/src/api/handler.ts`, `server/src/relay.ts`, Next API route.

**Interfaces:** `ConnectionStore.open(db, secret)`, `createPlatformApi({engine,store,connections,basePath})`, `resolveRuntime(runId): Promise<RunRuntime>`, `Engine.createRun(input, context?)`.

- [x] Write failing integration tests for tenant isolation, encrypted connection persistence, invalid credentials, runtime choice, and credential removal.
- [x] Run `bun test server/src/platform` and observe the missing behavior.
- [x] Implement authenticated encryption, connection validation over allowlisted APIs, scoped HTTP access, and persisted provider identity.
- [x] Resolve the provider/planner/limiter/cache namespace for each leased run and retain existing defaults for library consumers.
- [x] Run platform tests, existing engine tests, and server typecheck; commit the independently verified feature.

## Task 3: Local coding-agent integrations

**Files:** `server/src/agents/{process,provider,protocol}.ts`, executable test fixture, adapter tests, `server/scripts/agents-demo.ts`, `examples/agents.graph.json`.

**Interfaces:** `AgentProvider({agent,cwd,model?,executable?}): LlmProvider` consumes the existing generate request and returns text, sources, and usage.

- [x] Write failing tests covering final-message extraction, multi-turn usage, nonzero/error results, cancellation, output limits, and literal prompts.
- [x] Implement shell-free process launch and Pi/Claude Code/Codex protocol parsers using documented flags.
- [x] Run adapter fixtures through real child processes; run the three-branch example with available authenticated CLIs and state skipped providers precisely.
- [x] Commit adapters and the reproducible example.

## Task 4: Showcase and playground

**Files:** `web/app/{page,playground/page,connections/page,architecture/page}.tsx`, focused components, `web/lib/{templates,api,types}.ts`, shared CSS.

- [x] Add template validation/execution tests and workspace-session tests before behavior changes.
- [x] Build the landing page, scheduler explanation, source-backed architecture reference, template library, and connection management.
- [x] Add provider selection and budget controls, demo labelling, deterministic retry, JSON exports, and private-workspace copy.
- [x] Run tests, lint, typecheck, and build; review mobile, keyboard, errors, and complete browser workflows.
- [x] Commit the website as a working deliverable.

## Task 5: Verification and portfolio documentation

**Files:** README, documentation index, architecture/configuration/troubleshooting/user guide/API/security/testing/deployment/interview documents, screenshots, CI.

- [x] Run all tests against PGlite and Postgres, benchmark and crash-recovery demo.
- [x] Run automated browser flows for demo, template JSON, retry, cancellation, exports, isolation, and responsive layout.
- [x] Follow Readme Pro Max, preserve useful original documentation, and run its checker plus Mermaid rendering (individual-credit format exception documented).
- [x] Update CI to include new checks and commit documentation and verification evidence.

## Task 6: Publish and connect the URL

- [x] Inspect the existing Relay Vercel project and reuse its database/access where correctly scoped.
- [ ] Set the encryption secret privately; deploy the verified branch revision; verify production API and UI.
- [ ] Attach the available `relay.pallabdas.me` hostname using the Namecheap skill; preserve existing DNS records.
- [ ] Verify TLS and production asset identity within the shared propagation deadline.
- [ ] Update README/live metadata and GitHub About; push commits and open a linked pull request with exact test evidence.
