import type { EventRow, Store } from "./store";
import type { Clock } from "./types";

export type PendingEvent = [type: string, payload: unknown];

/**
 * Runs `mutate` and appends `events` in one transaction that holds the run's row lock.
 * If `mutate` returns false the transaction rolls back and the result is null.
 */
export async function commit(
  deps: { store: Store; clock: Clock },
  runId: string,
  mutate: () => Promise<boolean>,
  events: PendingEvent[],
): Promise<EventRow[] | null> {
  const { store, clock } = deps;
  const rolledBack = Symbol("rolled back");
  try {
    return await store.tx(
      async () => {
        if (!(await mutate())) throw rolledBack;
        const now = clock.now();
        const rows: EventRow[] = [];
        for (const [type, payload] of events) {
          rows.push({ id: await store.appendEvent(runId, type, payload, now), runId, type, payload, createdAt: now });
        }
        return rows;
      },
      { lockRun: runId },
    );
  } catch (err) {
    if (err === rolledBack) return null;
    throw err;
  }
}

/** True when `fn` returns true for every item, checked one at a time and stopping at the first false. */
export async function everyInOrder<T>(items: T[], fn: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (!(await fn(item))) return false;
  return true;
}
