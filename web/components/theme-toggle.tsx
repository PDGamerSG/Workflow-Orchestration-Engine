"use client";

import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const ORDER: Theme[] = ["system", "light", "dark"];
const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const KEY = "relay-theme";

/**
 * The theme lives on <html data-theme>, which the stylesheet reads and the inline script in the
 * layout sets before the first paint. React subscribes to it rather than owning it, so a reload
 * never flashes the other theme.
 */
let listeners: (() => void)[] = [];

function subscribe(notify: () => void): () => void {
  listeners = [...listeners, notify];
  return () => {
    listeners = listeners.filter((l) => l !== notify);
  };
}

function readTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return "system";
}

function applyTheme(next: Theme): void {
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private mode can refuse storage. The choice still applies to this page.
  }
  for (const notify of listeners) notify();
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);

  return (
    <div role="radiogroup" aria-label="Colour theme" className="segmented">
      {ORDER.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => applyTheme(value)}
          title={`${LABEL[value]} theme`}
          data-selected={theme === value ? "" : undefined}
        >
          {LABEL[value]}
        </button>
      ))}
    </div>
  );
}
