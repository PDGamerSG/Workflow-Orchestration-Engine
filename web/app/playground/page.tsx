import { Suspense } from "react";
import { NewRunForm } from "@/components/new-run-form";
import { RunsTable } from "@/components/runs-table";
import { TopBar } from "@/components/top-bar";
import { TemplateGallery } from "@/components/template-gallery";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Playground | Relay" };
export default function Playground() {
  return (
    <main className="shell" style={{ maxWidth: 1120 }}>
      <TopBar />
      <div className="page-heading">
        <div>
          <h1>Workflow playground</h1>
          <p>
            Plan a goal or edit a graph. Watch the engine work, step by step.
          </p>
        </div>
        <span className="workspace-badge">
          <span className="lamp" data-state="succeeded" />
          Private browser workspace
        </span>
      </div>
      <Suspense
        fallback={
          <div className="panel loading-panel">Loading workflow editor…</div>
        }
      >
        <NewRunForm />
      </Suspense>
      <RunsTable />
      <section className="site-section">
        <div className="section-heading">
          <div>
            <h2>Try another pattern</h2>
            <p>Each template is a complete graph you can inspect and edit.</p>
          </div>
        </div>
        <TemplateGallery />
      </section>
    </main>
  );
}
