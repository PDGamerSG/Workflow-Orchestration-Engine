# Benchmark

Simulated model latency, no network. Regenerate with `bun run bench` in `server/`. Each step's latency is fixed per step id, so every configuration runs the same workload. Timings include engine overhead: SQLite writes, events and scheduling.

## Concurrency sweep

A 12-step research graph: 10 independent researchers (600 to 1,100 ms each), a fact check that reads all of them (900 ms), and a writer (1,200 ms). Running every call one after another takes 10.27 s of model time.

| Steps at once | Wall time | Speedup |
|---|---|---|
| 1 | 10.40 s | 1.0x |
| 2 | 6.60 s | 1.6x |
| 4 | 4.49 s | 2.3x |
| 8 | 3.64 s | 2.9x |

The floor is the longest dependency chain: the slowest researcher, then the fact check, then the writer.

## Level by level against Relay's scheduler

Two independent branches: a slow fetch (3,000 ms) followed by a summary (400 ms), and four quick steps (400 ms each) in a chain. A final step merges both.

| Scheduler | Wall time |
|---|---|
| Level by level (the first prototype) | 4.65 s |
| Relay | 3.83 s |

Level by level waits for every step in a level before starting the next level, so the quick chain stalls behind the slow fetch. Relay starts a step the moment its own inputs finish, so the run takes as long as its longest path.
