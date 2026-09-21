import { Suspense } from "react";
import { RunView } from "@/components/run-view";
import { TopBar } from "@/components/top-bar";

export default async function RunPage(props: PageProps<"/runs/[id]">) {
  const { id } = await props.params;
  return (
    <main className="shell">
      <TopBar />
      {/* RunView reads ?step= to open a shared link on the right step. */}
      <Suspense fallback={<p className="hint">Loading run.</p>}>
        <RunView runId={id} />
      </Suspense>
    </main>
  );
}
