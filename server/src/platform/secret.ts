import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

export function applicationSecret(env: Record<string, string | undefined>, dataDir: string): string {
  if (env.RELAY_SECRET) {
    if (env.RELAY_SECRET.length < 32) throw new Error("RELAY_SECRET must contain at least 32 characters");
    return env.RELAY_SECRET;
  }
  if (env.VERCEL || env.NODE_ENV === "production") throw new Error("RELAY_SECRET is required in production to encrypt provider keys");
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "relay-secret");
  try { writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  return readFileSync(path, "utf8").trim();
}
