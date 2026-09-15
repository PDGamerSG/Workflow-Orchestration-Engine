import { RunView } from "@/components/run-view";
import { TopBar } from "@/components/top-bar";

export default async function RunPage(props: PageProps<"/runs/[id]">) {
  const { id } = await props.params;
  return (
    <main className="shell">
      <TopBar />
      <RunView runId={id} />
    </main>
  );
}
