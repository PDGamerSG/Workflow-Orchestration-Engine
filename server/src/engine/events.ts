import { EventEmitter } from "node:events";
import type { EventRow, Store } from "./store";
import type { Clock } from "./types";

/** Wakes SSE streams in this process as soon as an event is written. SQLite stays the source of truth. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: EventRow): void {
    this.emitter.emit(event.runId, event);
  }

  subscribe(runId: string, listener: (event: EventRow) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}

export type PendingEvent = [type: string, payload: unknown];

/**
 * Runs `mutate` and appends `events` in one transaction, then publishes the events.
 * If `mutate` returns false the transaction rolls back, nothing is published, and the result is null.
 */
export function commit(
  deps: { store: Store; bus: EventBus; clock: Clock },
  runId: string,
  mutate: () => boolean,
  events: PendingEvent[],
): EventRow[] | null {
  const { store, bus, clock } = deps;
  const rolledBack = Symbol("rolled back");
  let rows: EventRow[];
  try {
    rows = store.tx(() => {
      if (!mutate()) throw rolledBack;
      const now = clock.now();
      return events.map(([type, payload]) => ({
        id: store.appendEvent(runId, type, payload, now),
        runId,
        type,
        payload,
        createdAt: now,
      }));
    });
  } catch (err) {
    if (err === rolledBack) return null;
    throw err;
  }
  for (const row of rows) bus.publish(row);
  return rows;
}
