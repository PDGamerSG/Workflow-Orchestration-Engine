import { NewRunForm } from "@/components/new-run-form";
import { RunsTable } from "@/components/runs-table";
import { TopBar } from "@/components/top-bar";

export default function Home() {
  return (
    <main className="shell" style={{ maxWidth: 1040 }}>
      <TopBar />
      <NewRunForm />
      <RunsTable />
    </main>
  );
}
