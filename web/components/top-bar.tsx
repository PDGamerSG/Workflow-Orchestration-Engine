"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, API_URL } from "@/lib/api";
import { ThemeToggle } from "./theme-toggle";

export function TopBar() {
  const pathname = usePathname();
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
        <svg
          width="25"
          height="25"
          viewBox="0 0 25 25"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 5h7v15M5 12h14M12 5h7"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle
            cx="5"
            cy="5"
            r="3"
            fill="var(--panel)"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle
            cx="5"
            cy="12"
            r="3"
            fill="var(--panel)"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="19" cy="12" r="3" fill="var(--go)" />
          <circle
            cx="12"
            cy="20"
            r="3"
            fill="var(--panel)"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
        Relay
      </Link>
      <nav className="main-nav" aria-label="Main navigation">
        {[
          ["/playground", "Playground"],
          ["/architecture", "Architecture"],
          ["/connections", "Connections"],
        ].map(([href, title]) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
          >
            {title}
          </Link>
        ))}
        <a
          className="nav-source"
          href="https://github.com/PDGamerSG/Workflow-Orchestration-Engine"
          target="_blank"
          rel="noreferrer"
        >
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </nav>
      <div className="flex items-center gap-4">
        <span
          className="inline-flex items-center gap-2 text-sm"
          style={{ color: "var(--ink-2)" }}
          title={API_URL}
        >
          <span
            className="lamp"
            data-state={
              online === null ? "pending" : online ? "succeeded" : "failed"
            }
            aria-hidden="true"
          />
          <span className="hidden lg:inline">
            {online === null
              ? "Connecting"
              : online
                ? "Engine online"
                : "Engine offline"}
          </span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
