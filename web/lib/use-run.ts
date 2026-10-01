"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "./api";
import { runReducer } from "./run-reducer";

export type Connection = "connecting" | "live" | "reconnecting";

const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 10_000;

/**
 * Loads a run snapshot, then polls for the run's events from the start. The reducer applies only
 * events after the snapshot's cursor and keeps earlier ones for the timeline. Each poll asks for
 * events after the last one received, so none is lost or applied twice. Polling is fast while the
 * run is going and slow once it has finished; `refresh` asks again at once, after an action.
 */
export function useRun(runId: string) {
  const [state, dispatch] = useReducer(runReducer, null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let active = true;

    const poll = async () => {
      clearTimeout(timer);
      try {
        const events = await api.events(runId, cursor);
        if (cancelled) return;
        for (const event of events) {
          dispatch({ type: "event", event });
          cursor = event.id;
          if (FINISHED.has(event.type)) active = false;
          else if (event.type === "run.retried") active = true;
        }
        setConnection("live");
        // A full page means more events are waiting.
        timer = setTimeout(poll, events.length >= 500 ? 0 : active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      } catch {
        if (cancelled) return;
        setConnection("reconnecting");
        timer = setTimeout(poll, 2_000);
      }
    };
    poke.current = () => void poll();

    api
      .getRun(runId)
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({ type: "snapshot", snapshot });
        active = snapshot.run.status === "planning" || snapshot.run.status === "running";
        void poll();
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      poke.current = () => {};
    };
  }, [runId]);

  const refresh = useCallback(() => poke.current(), []);
  return { state, error, connection, refresh };
}

const FINISHED = new Set(["run.succeeded", "run.failed", "run.cancelled"]);

/** The current time, refreshed every `intervalMs` while `active` is true. */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
