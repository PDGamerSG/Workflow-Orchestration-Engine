import type { Request, Response } from "express";
import type { EventBus } from "../engine/events";
import type { Store } from "../engine/store";

const PAGE = 500;

/**
 * Streams a run's events as Server-Sent Events. It replays stored events after the client's
 * cursor, then tails the events table. The bus wakes the stream for events written by this
 * process, and a slow poll catches events written by other processes.
 */
export function streamRunEvents(
  req: Request,
  res: Response,
  deps: { store: Store; bus: EventBus; pollMs?: number; pingMs?: number },
): void {
  const runId = String(req.params.id);
  let cursor = Number(req.header("last-event-id") ?? req.query.after ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  let closed = false;
  const flush = () => {
    if (closed) return;
    for (;;) {
      const rows = deps.store.eventsAfter(runId, cursor, PAGE);
      for (const row of rows) {
        res.write(`id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`);
        cursor = row.id;
      }
      if (rows.length < PAGE) return;
    }
  };

  flush();
  const unsubscribe = deps.bus.subscribe(runId, flush);
  const poll = setInterval(flush, deps.pollMs ?? 1_000);
  const ping = setInterval(() => res.write(": ping\n\n"), deps.pingMs ?? 15_000);

  req.on("close", () => {
    closed = true;
    unsubscribe();
    clearInterval(poll);
    clearInterval(ping);
  });
}
