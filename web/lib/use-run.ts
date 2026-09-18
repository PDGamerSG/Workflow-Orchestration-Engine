"use client";

import { useEffect, useReducer, useState } from "react";
import { api } from "./api";
import { runReducer } from "./run-reducer";
import type { RunEvent } from "./types";

export type Connection = "connecting" | "live" | "reconnecting";

/**
 * Loads a run snapshot, then streams the run's events from the start. The reducer applies only
 * events after the snapshot's cursor and keeps earlier ones for the timeline. EventSource
 * reconnects on its own and sends Last-Event-ID, so no event is lost or applied twice.
 */
export function useRun(runId: string) {
  const [state, dispatch] = useReducer(runReducer, null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;

    api
      .getRun(runId)
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({ type: "snapshot", snapshot });
        source = new EventSource(api.eventsUrl(runId, 0));
        source.onopen = () => setConnection("live");
        source.onerror = () => setConnection("reconnecting");
        source.onmessage = (message) => dispatch({ type: "event", event: JSON.parse(message.data) as RunEvent });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [runId]);

  return { state, error, connection };
}

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
