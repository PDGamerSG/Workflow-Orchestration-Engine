import type { Engine } from "../engine/engine";
import { ConflictError, NotFoundError, ValidationError } from "../engine/errors";
import type { Store } from "../engine/store";

export type ApiDeps = {
  engine: Engine;
  store: Store;
  /** Path prefix the routes are mounted under, such as "/api". */
  basePath?: string;
};

const MAX_BODY_BYTES = 1_000_000;
const EVENT_PAGE = 500;

/**
 * The HTTP API as a fetch-style handler, so it runs in a Next.js route, a serverless
 * function or a test without a server. Events are read in pages after a cursor: the
 * dashboard polls for them instead of holding a stream open.
 */
export function createApi({ engine, store, basePath = "" }: ApiDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const url = new URL(req.url);
      const path = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname;
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      const route = `${req.method} /${parts.map((p, i) => (i === 1 && parts[0] === "runs" ? ":id" : p)).join("/")}`;
      const id = parts[1] ?? "";

      switch (route) {
        case "GET /health":
          return json(200, { ok: true, workerId: engine.workerId });

        case "POST /runs":
          return json(201, await engine.createRun((await readJson(req)) ?? {}));

        case "GET /runs": {
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
          return json(200, { runs: await store.listRuns(limit) });
        }

        case "GET /runs/:id": {
          const snapshot = await store.snapshot(id);
          if (!snapshot) throw new NotFoundError(`run ${id} not found`);
          return json(200, snapshot);
        }

        case "GET /runs/:id/events": {
          if (!(await store.getRun(id))) throw new NotFoundError(`run ${id} not found`);
          let after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) after = 0;
          return json(200, { events: await store.eventsAfter(id, after, EVENT_PAGE) });
        }

        case "POST /runs/:id/cancel":
          await engine.cancel(id);
          return json(202, { ok: true });

        case "POST /runs/:id/retry":
          await engine.retry(id);
          return json(202, { ok: true });

        case "DELETE /runs/:id":
          await engine.delete(id);
          return json(200, { ok: true });

        default:
          throw new NotFoundError(`no route for ${req.method} ${path}`);
      }
    } catch (err) {
      const { status, body } = toHttpError(err);
      if (status >= 500) console.error("[relay] request failed", err);
      return json(status, { error: body });
    }
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

class BadBody extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new BadBody(413, "too_large", "request body is larger than 1mb");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadBody(400, "invalid_json", "request body is not valid JSON");
  }
}

type ErrorBody = { code: string; message: string; issues?: string[] };

function toHttpError(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ValidationError) {
    const code = err.message === "invalid graph" ? "invalid_graph" : "invalid_request";
    return { status: 400, body: { code, message: err.message, issues: err.issues } };
  }
  if (err instanceof NotFoundError) return { status: 404, body: { code: "not_found", message: err.message } };
  if (err instanceof ConflictError) return { status: 409, body: { code: "conflict", message: err.message } };
  if (err instanceof BadBody) return { status: err.status, body: { code: err.code, message: err.message } };
  return { status: 500, body: { code: "internal", message: "internal server error" } };
}
