import type {
  CreateRunRequest,
  PublicConnection,
  ProviderInfo,
  RunEvent,
  RunSnapshot,
  RunSummary,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "/api").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

let sessionReady: Promise<void> | undefined;
function ensureSession(): Promise<void> {
  sessionReady ??= fetch(API_URL + "/session", {
    cache: "no-store",
    credentials: "same-origin",
  })
    .then((response) => {
      if (!response.ok)
        throw new ApiError(
          "The workspace could not connect. Try again in a moment.",
          response.status,
          "session_unavailable",
        );
    })
    .catch((error) => {
      sessionReady = undefined;
      throw error;
    });
  return sessionReady;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    await ensureSession();
    res = await fetch(API_URL + path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(
      'The engine is not reachable. Check your connection, or start it with "bun run dev".',
      0,
      "unreachable",
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body?.error ?? {};
    throw new ApiError(
      error.message ?? `Request failed with status ${res.status}`,
      res.status,
      error.code ?? "unknown",
      error.issues,
    );
  }
  return body as T;
}

export const api = {
  providers: () =>
    request<{ providers: ProviderInfo[] }>("/providers").then(
      (r) => r.providers,
    ),
  connections: () =>
    request<{ connections: PublicConnection[] }>("/connections").then(
      (r) => r.connections,
    ),
  addConnection: (
    body: Omit<PublicConnection, "id" | "createdAt"> & { apiKey: string },
  ) =>
    request<{ connection: PublicConnection }>("/connections", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.connection),
  deleteConnection: (id: string) =>
    request<{ ok: true }>(`/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  health: () => request<{ ok: boolean; workerId: string }>("/health"),
  listRuns: () =>
    request<{ runs: RunSummary[] }>("/runs?limit=50").then((r) => r.runs),
  getRun: (id: string) =>
    request<RunSnapshot>(`/runs/${encodeURIComponent(id)}`),
  createRun: (body: CreateRunRequest) =>
    request<{ runId: string }>("/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.runId),
  cancelRun: (id: string) =>
    request<{ ok: true }>(`/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  retryRun: (id: string) =>
    request<{ ok: true }>(`/runs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    }),
  deleteRun: (id: string) =>
    request<{ ok: true }>(`/runs/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  events: (id: string, after: number) =>
    request<{ events: RunEvent[] }>(
      `/runs/${encodeURIComponent(id)}/events?after=${after}`,
    ).then((r) => r.events),
};
