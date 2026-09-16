import { Suspense } from "react";
import { NewRunForm } from "@/components/new-run-form";
import { RunsTable } from "@/components/runs-table";
import { TopBar } from "@/components/top-bar";

export default function Home() {
  return (
    <main className="shell" style={{ maxWidth: 1040 }}>
      <TopBar />
      {/* The form reads ?goal= from a "Run again" link, which needs a boundary around it. */}
      <Suspense fallback={<div className="panel" style={{ height: 320 }} />}>
        <NewRunForm />
      </Suspense>
      <RunsTable />
    </main>
  );
}
