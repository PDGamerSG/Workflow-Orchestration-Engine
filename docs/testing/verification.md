# Release verification

Verification date: 2026-11-04. Commands run against the release branch; no paid model success is inferred from simulated responses.

| Check | Observed result |
| --- | --- |
| Server tests, PGlite | 148 passed, 0 failed. |
| Server tests, PostgreSQL 17 | 148 passed, 0 failed. |
| Web library tests | 37 passed, 0 failed. |
| Type checking and lint | Passed for both workspaces / web lint. |
| Production Next.js build | Passed. |
| Chromium end-to-end | 5 passed: demo/export, retry, validation/cancel/delete, workspace isolation, responsive labelled controls. |
| Crash demo | Completed steps 1–3 retained; interrupted step 4 attempted twice; no completed step repeated; successor completed. |
| Benchmark | Simulated 12-step workload: 10.40 s at concurrency 1, 4.48 s at 4, 3.61 s at 8. Mixed graph: Relay 3.83 s vs level-by-level 4.61 s. |
| Production dependency audit | No vulnerabilities reported after patches. |
| All dependencies, high/critical gate | Passed. One moderate development-only minimatch advisory remains. |

Next.js was patched to 16.4.5, Zod to 4.6.7, and compatible transitive updates applied for fast-uri, source-map-js and sharp. Zod is overridden consistently because a deployment tooling dependency pinned an older vulnerable copy. `minimatch` has an upstream moderate glob-amplification advisory below 11.0.1 in ESLint's development tree. Forcing v11 into the v3 consumers would change its API; it is not included in the application runtime. CI gates production advisories and high/critical findings across all dependencies.

## External services

No working model API key was available. Connection validation and per-provider execution have controlled transport fixtures, encrypted persistence and recovery tests, but authenticated live OpenAI/Anthropic/Gemini/Groq/Cerebras/OpenRouter runs remain unverified.

Live local CLI attempts did not complete authenticated inference: Codex rejected available authentication with HTTP 401; Pi returned a failed run; Claude Code bare mode lacked API credentials. All three adapters pass executable process/protocol fixtures. Their availability with a real account is an explicit release limitation.

## Documentation checks

The upstream Readme Pro Max checker requires a `Team ...` credit line. The owner explicitly requested an individual project credit by Pallab Das, so that format rule is deliberately not followed. The upstream checker reports 16/17 passing, with that individual-credit exception as its only failure. All local documentation links resolve. The README diagram and four architecture diagrams render successfully with Mermaid CLI. Screenshots contain only scripted content and no keys.

## Public release

Deployment, DNS, HTTPS and public smoke-test evidence is added here after publishing the verified source.
