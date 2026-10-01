import { after } from "next/server";
import { getRelay } from "@/lib/server/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Vercel Hobby limit. A run that outlives it is picked up by a later request once its lease expires.
export const maxDuration = 300;

const SWEEP_EVERY_MS = 5_000;
let lastSweep = 0;

/**
 * Every API request goes through the engine's handler. A request also sweeps for runs whose
 * lease has expired, which is how a run left behind by a function that hit its time limit
 * gets picked up, and keeps the function alive with after() while this instance drives runs.
 */
async function handle(req: Request): Promise<Response> {
  let relay;
  try {
    relay = await getRelay();
  } catch (err) {
    console.error("[relay] could not start", err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: { code: "not_configured", message } }, { status: 500 });
  }
  const { engine, api } = relay;

  if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
    lastSweep = Date.now();
    await engine.sweep();
  }
  const res = await api(req);
  after(() => engine.idle());
  return res;
}

export { handle as GET, handle as POST, handle as DELETE };
