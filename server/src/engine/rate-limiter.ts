import type { Clock } from "./types";

type Waiter = { resolve: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; onAbort?: () => void };

/**
 * A token bucket shared by every run in the process. Waiters are served in arrival order,
 * and one background loop sleeps until the next token is due.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly clock: Clock;
  private tokens: number;
  private lastRefill: number;
  private queue: Waiter[] = [];
  private pumping = false;

  constructor(opts: { capacity: number; refillPerSec: number; clock: Clock }) {
    if (opts.capacity < 1 || opts.refillPerSec <= 0) throw new Error("capacity must be >= 1 and refill > 0");
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.clock = opts.clock;
    this.tokens = opts.capacity;
    this.lastRefill = opts.clock.now();
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.queue = this.queue.filter((w) => w !== waiter);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }

  private refill() {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSec);
    this.lastRefill = now;
  }

  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.queue.length) {
          this.refill();
          if (this.tokens >= 1) {
            this.tokens -= 1;
            const waiter = this.queue.shift()!;
            if (waiter.onAbort) waiter.signal!.removeEventListener("abort", waiter.onAbort);
            waiter.resolve();
            continue;
          }
          await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000));
        }
      } finally {
        this.pumping = false;
      }
    })();
  }
}
