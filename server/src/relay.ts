import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApi } from "./api/handler";
import { loadConfig, type Config } from "./config";
import { openPglite, openPostgres, type Db } from "./engine/db";
import { Engine } from "./engine/engine";
import { Store } from "./engine/store";
import { createDemoProvider } from "./llm/demo";
import { GeminiProvider } from "./llm/gemini";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible";
import type { LlmProvider } from "./llm/provider";
import { Planner } from "./planner/planner";

export type Relay = {
  config: Config;
  db: Db;
  store: Store;
  engine: Engine;
  api: (req: Request) => Promise<Response>;
};

export function createProvider(config: Config): LlmProvider {
  switch (config.provider) {
    case "gemini":
      return new GeminiProvider({ apiKey: config.apiKey!, model: config.model });
    case "demo":
      return createDemoProvider({ failureRate: config.demoFailureRate });
    default:
      return new OpenAiCompatibleProvider({ baseUrl: config.baseUrl!, apiKey: config.apiKey!, model: config.model });
  }
}

/**
 * Builds the store, engine and HTTP API from the environment. The engine does not sweep on a
 * timer: the host calls `engine.sweep()` from its requests, which suits serverless functions
 * that only run while a request is open. `onPool` receives the node-postgres pool when there is one.
 */
export async function createRelay(
  env: Record<string, string | undefined>,
  opts: { basePath?: string; onPool?: (pool: import("pg").Pool) => void } = {},
): Promise<Relay> {
  const config = loadConfig(env);
  let db: Db;
  if (config.databaseUrl) {
    const postgres = await openPostgres(config.databaseUrl);
    opts.onPool?.(postgres.pool);
    db = postgres;
  } else {
    const dir = resolve(config.pgliteDir);
    mkdirSync(dir, { recursive: true });
    db = await openPglite(dir);
  }
  const store = await Store.open(db);
  const provider = createProvider(config);
  const engine = new Engine({
    store,
    provider,
    planner: new Planner(provider, { searchEnabled: config.searchEnabled }),
    pricing: config.pricing,
    rpm: config.rpm,
    leaseTtlMs: config.leaseTtlMs,
    // Renew three times per lease period so one slow heartbeat never loses the run.
    heartbeatMs: Math.floor(config.leaseTtlMs / 3),
  });
  console.log(
    `[relay] worker ${engine.workerId} (provider: ${config.provider}/${provider.model}, search: ${config.searchEnabled ? "on" : "off"}, db: ${config.databaseUrl ? "postgres" : "pglite"})`,
  );
  return { config, db, store, engine, api: createApi({ engine, store, basePath: opts.basePath }) };
}
