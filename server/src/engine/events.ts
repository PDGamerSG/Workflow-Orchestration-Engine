import { EventEmitter } from "node:events";
import type { EventRow } from "./store";

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
