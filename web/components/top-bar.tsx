"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, API_URL } from "@/lib/api";
import { ThemeToggle } from "./theme-toggle";

export function TopBar() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () =>
      api.health().then(
        () => alive && setOnline(true),
        () => alive && setOnline(false),
      );
    check();
    const timer = setInterval(check, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <header className="topbar">
      <Link href="/" className="wordmark">
        Relay <small className="hidden sm:inline">durable LLM workflows</small>
      </Link>
      <div className="flex items-center gap-4">
        <span className="inline-flex items-center gap-2 text-sm" style={{ color: "var(--ink-2)" }} title={API_URL}>
          <span className="lamp" data-state={online === null ? "pending" : online ? "succeeded" : "failed"} aria-hidden="true" />
          <span className="hidden sm:inline">{online === null ? "Checking engine" : online ? "Engine connected" : "Engine offline"}</span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
