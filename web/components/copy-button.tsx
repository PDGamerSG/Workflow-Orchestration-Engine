"use client";

import { useEffect, useRef, useState } from "react";

/** Copies `text` to the clipboard and says so for a moment. Falls back to a hidden textarea. */
export function CopyButton({ text, label = "Copy", small }: { text: string; label?: string; small?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function copy() {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = legacyCopy(text);
    }
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1_600);
  }

  return (
    <button type="button" className="button" data-variant="quiet" data-size={small ? "small" : undefined} onClick={copy} aria-live="polite">
      {state === "copied" ? "Copied" : state === "failed" ? "Press Ctrl+C" : label}
    </button>
  );
}

/** Saves `text` as a file the browser downloads. */
export function DownloadButton({ text, filename, label = "Download", small }: { text: string; filename: string; label?: string; small?: boolean }) {
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    // Revoking straight away can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <button type="button" className="button" data-variant="quiet" data-size={small ? "small" : undefined} onClick={download}>
      {label}
    </button>
  );
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
