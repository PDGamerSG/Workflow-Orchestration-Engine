export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n / 1_000)}k`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

export function formatAge(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1_000));
  if (s < 60) return `${s} s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h ago`;
  return new Date(from).toLocaleDateString();
}

export function tryPrettyJson(text: string): string | null {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : null;
  } catch {
    return null;
  }
}
