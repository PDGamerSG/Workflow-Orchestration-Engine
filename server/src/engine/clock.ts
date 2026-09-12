import type { Clock } from "./types";

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

type Sleeper = { due: number; seq: number; resolve: () => void };

/** A clock that only moves when a test calls `advance`. */
export class ManualClock implements Clock {
  private current: number;
  private sleepers: Sleeper[] = [];
  private seq = 0;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const sleeper: Sleeper = {
        due: this.current + Math.max(0, ms),
        seq: this.seq++,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.sleepers = this.sleepers.filter((s) => s !== sleeper);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.sleepers.push(sleeper);
    });
  }

  /** Moves time forward, waking sleepers in due order and letting their callbacks run. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await flush();
    for (;;) {
      const next = this.sleepers
        .filter((s) => s.due <= target)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) break;
      this.sleepers = this.sleepers.filter((s) => s !== next);
      this.current = next.due;
      next.resolve();
      await flush();
    }
    this.current = target;
    await flush();
  }

  get pendingSleepers(): number {
    return this.sleepers.length;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
