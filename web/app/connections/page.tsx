import type { Metadata } from "next";
import { ConnectionManager } from "@/components/connection-manager";
import { TopBar } from "@/components/top-bar";

export const metadata: Metadata = { title: "Connections | Relay" };
export default function ConnectionsPage() {
  return (
    <main className="shell" style={{ maxWidth: 1000 }}>
      <TopBar />
      <div className="page-heading">
        <div>
          <h1>Connect your model provider</h1>
          <p>Use your own API key and choose the model for each workflow.</p>
        </div>
      </div>
      <ConnectionManager />
    </main>
  );
}
