import { describe, expect, test } from "bun:test";
import { ManualClock } from "./clock";
import { TokenBucket } from "./rate-limiter";

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("TokenBucket", () => {
  test("allows a burst up to capacity, then waits for refill", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1, clock });
    await bucket.acquire();
    await bucket.acquire();

    let third = false;
    bucket.acquire().then(() => (third = true));
    await settle();
    expect(third).toBe(false);

    await clock.advance(999);
    expect(third).toBe(false);
    await clock.advance(1);
    expect(third).toBe(true);
  });

  test("never stores more than capacity", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 10, clock });
    await clock.advance(60_000);
    await bucket.acquire();
    let second = false;
    bucket.acquire().then(() => (second = true));
    await settle();
    expect(second).toBe(false);
    await clock.advance(100);
    expect(second).toBe(true);
  });

  test("serves waiters in FIFO order", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, clock });
    await bucket.acquire();

    const order: number[] = [];
    const waits = [1, 2, 3].map((n) => bucket.acquire().then(() => order.push(n)));
    await clock.advance(1_000);
    await clock.advance(1_000);
    await clock.advance(1_000);
    await Promise.all(waits);
    expect(order).toEqual([1, 2, 3]);
  });

  test("an aborted waiter rejects and gives its turn to the next one", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, clock });
    await bucket.acquire();

    const controller = new AbortController();
    const first = bucket.acquire(controller.signal);
    let second = false;
    bucket.acquire().then(() => (second = true));

    controller.abort(new Error("cancelled"));
    await expect(first).rejects.toThrow("cancelled");

    await clock.advance(1_000);
    expect(second).toBe(true);
  });

  test("rejects at once when the signal is already aborted", async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, clock: new ManualClock() });
    await expect(bucket.acquire(AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
  });
});

describe("ManualClock", () => {
  test("resolves sleepers in time order as time advances", async () => {
    const clock = new ManualClock(100);
    const woke: string[] = [];
    clock.sleep(300).then(() => woke.push("300"));
    clock.sleep(100).then(() => woke.push("100"));
    await clock.advance(150);
    expect(woke).toEqual(["100"]);
    expect(clock.now()).toBe(250);
    await clock.advance(200);
    expect(woke).toEqual(["100", "300"]);
  });

  test("sleep rejects when its signal aborts", async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(1_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(sleeping).rejects.toThrow("stop");
  });
});
