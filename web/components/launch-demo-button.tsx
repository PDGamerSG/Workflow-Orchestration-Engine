"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { TEMPLATES } from "@/lib/templates";

export function LaunchDemoButton({
  templateId = "engine-tour",
  label = "Run the demo",
}: {
  templateId?: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function launch() {
    setBusy(true);
    setError(null);
    const template =
      TEMPLATES.find((item) => item.id === templateId) ?? TEMPLATES[0];
    try {
      const id = await api.createRun({
        graph: template.graph,
        concurrency: 4,
        demoScenario: template.scenario ?? "success",
      });
      router.push(`/runs/${id}`);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not start the demo.",
      );
      setBusy(false);
    }
  }
  return (
    <div>
      <button className="button" onClick={launch} disabled={busy}>
        {busy ? "Starting demo…" : label}
        <span aria-hidden="true">↗</span>
      </button>
      {error && (
        <p
          className="error-box"
          role="alert"
          style={{ marginTop: 12, maxWidth: 440 }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
