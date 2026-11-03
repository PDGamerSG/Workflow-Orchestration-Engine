# Configuration

Copy `.env.example` to `.env` at the repository root. `web/next.config.ts` loads that file without replacing already-set environment variables. Configure production variables in the hosting provider, never in source control.

## Website settings

| Variable | Default or requirement | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Optional locally; required on Vercel | Postgres URL. Use Neon's pooled connection for serverless functions. |
| `RELAY_SECRET` | At least 32 characters; required in production | Encrypts saved keys. Keep stable and private across deployments. |
| `PGLITE_DIR` | `data/pglite` relative to the web process | Local storage without Postgres; normally `web/data/pglite`. |
| `LEASE_TTL_MS` | `30000`, minimum `1000` | Delay before another worker can take over a dead worker's run. |
| `DEMO_FAILURE_RATE` | `0` | Optional random transient step failures in the scripted provider. Planner calls do not randomly fail. |

Local development generates an owner-readable `relay-secret` file inside the data directory if no secret is configured. Back it up with the database. `NODE_ENV=production` requires an explicit secret. For a new deployment, generate a secret with `openssl rand -hex 32` and put it directly in private environment settings. Overwriting an existing secret without re-encrypting credentials makes saved keys unreadable.

Sources: [`secret.ts`](../server/src/platform/secret.ts), [`config.ts`](../server/src/config.ts), [`next.config.ts`](../web/next.config.ts).

## Visitor connections

Use `/connections`, choose a provider, enter its exact model id and key, and validate. Validation makes one small, potentially billed call. Failed validation saves nothing. Public configuration and AES-256-GCM ciphertext are stored separately.

| Provider | Suggested model | Protocol | Search |
| --- | --- | --- | --- |
| OpenAI | `gpt-4.1-mini` | Responses API | No |
| Anthropic | `claude-sonnet-4-6` | Messages API | No |
| Gemini | `gemini-2.5-flash` | Google GenAI | Optional Google Search grounding |
| Groq | `openai/gpt-oss-120b` | Chat Completions | No |
| Cerebras | `gpt-oss-120b` | Chat Completions | No |
| OpenRouter | `nvidia/nemotron-3-super-120b-a12b:free` | Chat Completions | No |

Model availability, quotas and prices can change. Suggested models are editable. Some models reject strict JSON schemas; select a compatible model for planning and JSON steps. Grounding needs separate quota and may incur charges.

RPM limits are shared by a saved connection within a process; serverless instances do not share one global bucket. Input/output USD per million tokens enable dollar estimates. Search prices and provider discounts are not included in saved-connection prices. Use a token budget when prices are unknown.

Sources: [`providers.ts`](../server/src/platform/providers.ts), [`connections.ts`](../server/src/platform/connections.ts), [`runtime.ts`](../server/src/platform/runtime.ts).

## Library compatibility

Direct library consumers can still use `LLM_PROVIDER` (`demo`, `gemini`, `groq`, `cerebras`, `openrouter`), `LLM_MODEL`, `LLM_RPM`, `SEARCH_ENABLED`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, and `PRICE_INPUT_PER_M`, `PRICE_OUTPUT_PER_M`, `PRICE_SEARCH_PER_K`. `GEMINI_MODEL` and `GEMINI_RPM` remain accepted.

The website factory defaults to `demo`; direct `loadConfig()` retains its historical Gemini default. Legacy Gemini defaults are `gemini-3.5-flash`, 60 RPM and the prices in `llm/pricing.ts`. These are compatibility defaults, not a promise of current availability or billing accuracy. Browser connections use the separate catalog above. Visitor requests never fall back to deployment API keys. Local agent settings are in the [agent guide](agents.md).
