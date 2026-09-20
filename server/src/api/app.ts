import express, { type NextFunction, type Request, type Response } from "express";
import type { Engine } from "../engine/engine";
import { ConflictError, NotFoundError, ValidationError } from "../engine/errors";
import type { Store } from "../engine/store";
import { streamRunEvents } from "./sse";

export type AppDeps = {
  engine: Engine;
  store: Store;
  webOrigin: string;
  ssePollMs?: number;
};

export function createApp({ engine, store, webOrigin, ssePollMs }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", webOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, workerId: engine.workerId, pid: process.pid });
  });

  app.post("/runs", (req, res) => {
    res.status(201).json(engine.createRun(req.body ?? {}));
  });

  app.get("/runs", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json({ runs: store.listRuns(limit) });
  });

  app.get("/runs/:id", (req, res) => {
    const snapshot = store.snapshot(req.params.id);
    if (!snapshot) throw new NotFoundError(`run ${req.params.id} not found`);
    res.json(snapshot);
  });

  app.get("/runs/:id/events", (req, res) => {
    if (!store.getRun(req.params.id)) throw new NotFoundError(`run ${req.params.id} not found`);
    streamRunEvents(req, res, { store, bus: engine.bus, pollMs: ssePollMs });
  });

  app.post("/runs/:id/cancel", (req, res) => {
    engine.cancel(req.params.id);
    res.status(202).json({ ok: true });
  });

  app.post("/runs/:id/retry", (req, res) => {
    engine.retry(req.params.id);
    res.status(202).json({ ok: true });
  });

  app.use((req, _res) => {
    throw new NotFoundError(`no route for ${req.method} ${req.path}`);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = toHttpError(err);
    if (status >= 500) console.error("[relay] request failed", err);
    res.status(status).json({ error: body });
  });

  return app;
}

type ErrorBody = { code: string; message: string; issues?: string[] };

function toHttpError(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ValidationError) {
    const code = err.message === "invalid graph" ? "invalid_graph" : "invalid_request";
    return { status: 400, body: { code, message: err.message, issues: err.issues } };
  }
  if (err instanceof NotFoundError) return { status: 404, body: { code: "not_found", message: err.message } };
  if (err instanceof ConflictError) return { status: 409, body: { code: "conflict", message: err.message } };

  // body-parser marks malformed JSON with type "entity.parse.failed".
  const parseError = err as { type?: string; status?: number };
  if (parseError?.type === "entity.parse.failed") {
    return { status: 400, body: { code: "invalid_json", message: "request body is not valid JSON" } };
  }
  if (parseError?.type === "entity.too.large") {
    return { status: 413, body: { code: "too_large", message: "request body is larger than 1mb" } };
  }
  return { status: 500, body: { code: "internal", message: "internal server error" } };
}
