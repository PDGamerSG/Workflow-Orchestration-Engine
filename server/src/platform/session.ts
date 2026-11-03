import { randomBytes } from "node:crypto";

export function workspaceSession(req: Request): { ownerId: string; cookie: string | null } {
  const token = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("relay_workspace="))?.slice("relay_workspace=".length);
  if (token && /^[a-f0-9]{64}$/.test(token)) return { ownerId: token, cookie: null };
  const ownerId = randomBytes(32).toString("hex");
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return { ownerId, cookie: `relay_workspace=${ownerId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` };
}

export function isSameOriginWrite(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return false;
  return req.headers.get("sec-fetch-site") !== "cross-site";
}
