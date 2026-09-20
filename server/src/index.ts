import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createApp } from "./api/app";
import { loadConfig } from "./config";
import { Engine } from "./engine/engine";
import { Store } from "./engine/store";
import { createDemoProvider } from "./llm/demo";
import { GeminiProvider } from "./llm/gemini";
import type { LlmProvider } from "./llm/provider";
import { Planner } from "./planner/planner";

const config = loadConfig(process.env);

// Absolute path: bun on Windows throws EEXIST from a recursive mkdir of an existing relative path with "..".
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });
const store = new Store(databasePath);

const provider: LlmProvider =
  config.provider === "gemini"
    ? new GeminiProvider({ apiKey: config.googleApiKey!, model: config.model })
    : createDemoProvider();

const planner = new Planner(provider, { searchEnabled: config.searchEnabled });
const engine = new Engine({
  store,
  provider,
  planner,
  pricing: config.pricing,
  rpm: config.rpm,
  leaseTtlMs: config.leaseTtlMs,
  // Renew three times per lease period so one slow heartbeat never loses the run.
  heartbeatMs: Math.floor(config.leaseTtlMs / 3),
  sweepMs: Math.min(5_000, Math.floor(config.leaseTtlMs / 2)),
});
const app = createApp({ engine, store, webOrigin: config.webOrigin });

engine.start();
const server = app.listen(config.port, () => {
  console.log(`[relay] worker ${engine.workerId} on http://localhost:${config.port} (provider: ${provider.model}, search: ${config.searchEnabled ? "on" : "off"}, db: ${databasePath})`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] ${signal}: handing runs back and shutting down`);
  server.close();
  server.closeAllConnections(); // SSE streams would otherwise keep the server open
  await engine.stop({ graceful: true });
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
