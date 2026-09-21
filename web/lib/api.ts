import type { CreateRunRequest, RunSnapshot, RunSummary } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(`The engine at ${API_URL} is not reachable. Start it with "bun run dev".`, 0, "unreachable");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body?.error ?? {};
    throw new ApiError(error.message ?? `Request failed with status ${res.status}`, res.status, error.code ?? "unknown", error.issues);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; workerId: string }>("/health"),
  listRuns: () => request<{ runs: RunSummary[] }>("/runs?limit=50").then((r) => r.runs),
  getRun: (id: string) => request<RunSnapshot>(`/runs/${encodeURIComponent(id)}`),
  createRun: (body: CreateRunRequest) =>
    request<{ runId: string }>("/runs", { method: "POST", body: JSON.stringify(body) }).then((r) => r.runId),
  cancelRun: (id: string) => request<{ ok: true }>(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  retryRun: (id: string) => request<{ ok: true }>(`/runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  deleteRun: (id: string) => request<{ ok: true }>(`/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  eventsUrl: (id: string, after: number) => `${API_URL}/runs/${encodeURIComponent(id)}/events?after=${after}`,
};
