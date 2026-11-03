import { createApi, readJson, toHttpError } from "../api/handler";
import type { Engine } from "../engine/engine";
import { ConflictError, ValidationError } from "../engine/errors";
import type { Store } from "../engine/store";
import type { Connections } from "./connections";
import { PROVIDER_CATALOG } from "./providers";
import { isSameOriginWrite, workspaceSession } from "./session";

export function createPlatformApi(options: { engine: Engine; store: Store; connections: Connections; basePath?: string }) {
  const { engine, store, connections, basePath = "" } = options;
  return async (req: Request): Promise<Response> => {
    const session = workspaceSession(req);
    const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store", ...(session.cookie ? { "set-cookie": session.cookie } : {}) } });
    if (!isSameOriginWrite(req)) return json(403, { error: { code: "forbidden", message: "Open this page on the Relay site to make changes." } });
    try {
      const path = new URL(req.url).pathname.slice(basePath.length);
      if (req.method === "GET" && path === "/session") return json(200, { ok: true, workspace: "private-browser" });
      if (req.method === "GET" && path === "/providers") return json(200, { providers: PROVIDER_CATALOG });
      if (path === "/connections" && req.method === "GET") return json(200, { connections: await connections.list(session.ownerId) });
      if (path === "/connections" && req.method === "POST") return json(201, { connection: await connections.create(session.ownerId, await readJson(req)) });
      if (/^\/connections\/[^/]+$/.test(path) && req.method === "DELETE") {
        await connections.delete(decodeURIComponent(path.split("/")[2]!), session.ownerId);
        return json(200, { ok: true });
      }
      const api = createApi({
        engine, store, basePath, ownerId: session.ownerId,
        prepareRun: async (input) => {
          if (!input || typeof input !== "object") throw new ValidationError(["Provide a goal or graph."]);
          const request = input as { connectionId?: unknown; demoScenario?: unknown };
          if (await store.countActiveRuns(session.ownerId) >= 3) throw new ConflictError("This workspace already has 3 active runs. Wait or cancel one first.");
          if ((await store.listRuns(101, session.ownerId)).length >= 100) throw new ConflictError("Remove an old run before keeping more than 100 runs in this workspace.");
          if (request.connectionId !== undefined && request.connectionId !== null && typeof request.connectionId !== "string") throw new ValidationError(["connectionId must be a saved connection id."]);
          const connection = request.connectionId ? await connections.get(request.connectionId as string, session.ownerId) : null;
          if (request.demoScenario !== undefined && !["success", "retry"].includes(String(request.demoScenario))) throw new ValidationError(["Unknown demo scenario."]);
          return {
            ownerId: session.ownerId, connectionId: connection?.id ?? null,
            execution: connection ? { provider: connection.provider, model: connection.model, name: connection.name, simulated: false } : { provider: "demo", model: "scripted", name: "Demo simulation", simulated: true, scenario: request.demoScenario === "retry" ? "retry" : "success" },
          };
        },
      });
      const response = await api(req);
      if (session.cookie) response.headers.set("set-cookie", session.cookie);
      return response;
    } catch (err) {
      const { status, body } = toHttpError(err);
      return json(status, { error: body });
    }
  };
}
