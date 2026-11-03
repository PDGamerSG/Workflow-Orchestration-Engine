import Link from "next/link";
import type { Metadata } from "next";
import { TopBar } from "@/components/top-bar";
import { EngineDiagram } from "@/components/engine-diagram";
import { LaunchDemoButton } from "@/components/launch-demo-button";

export const metadata: Metadata = { title: "Inside the engine | Relay" };
const source =
  "https://github.com/PDGamerSG/Workflow-Orchestration-Engine/tree/master/";

export default function ArchitecturePage() {
  return (
    <main className="shell" style={{ maxWidth: 1120 }}>
      <TopBar />
      <div className="architecture-intro">
        <p className="project-note">Architecture & engineering decisions</p>
        <h1>From a goal to a durable graph.</h1>
        <p>
          Relay implements scheduling, persistence and failure recovery itself.
          Model APIs and coding agents sit behind a small provider interface.
        </p>
      </div>
      <div className="architecture-layout">
        <nav className="contents-nav" aria-label="On this page">
          <a href="#lifecycle">Run lifecycle</a>
          <a href="#durability">Crash recovery</a>
          <a href="#agents">Pi, Claude Code & Codex</a>
          <a href="#security">Keys & workspaces</a>
          <a href="#tradeoffs">Tradeoffs</a>
        </nav>
        <div className="architecture-content">
          <section id="lifecycle">
            <h2>Start only the work that is ready.</h2>
            <p>
              A goal goes through a planner, then the same validation as a
              hand-written graph. Unknown references, duplicate ids and cycles
              are rejected. The scheduler resolves saved outputs into prompts
              and launches ready steps up to the concurrency limit.
            </p>
            <EngineDiagram />
            <p>
              As soon as a step settles, the engine checks readiness again. A
              slow branch does not hold back a different branch whose inputs are
              already available.
            </p>
            <a
              className="text-link"
              href={`${source}server/src/engine/scheduler.ts`}
            >
              Read the scheduler
            </a>
          </section>
          <section id="durability">
            <h2>A checkpoint survives the worker.</h2>
            <div className="lifecycle-flow">
              <div>
                <strong>Claim</strong>
                <span>One worker acquires an expiring lease.</span>
              </div>
              <div>
                <strong>Commit</strong>
                <span>State and its event save in one transaction.</span>
              </div>
              <div>
                <strong>Resume</strong>
                <span>A new worker reuses completed outputs.</span>
              </div>
            </div>
            <p>
              Heartbeats renew the lease. If a worker disappears, a later
              request can take over after expiry. Fenced writes stop the old
              worker from saving results once it loses ownership. An interrupted
              call can run again; a saved successful step is preserved.
            </p>
            <pre className="code-block">bun run demo:crash</pre>
            <p className="hint">
              This reproducible demo runs two engines on one database and kills
              the first mid-step.
            </p>
          </section>
          <section id="agents">
            <h2>An agent loop is one piece of the workflow.</h2>
            <p>
              Pi, Claude Code and Codex manage conversations and tools. Relay
              coordinates independent invocations, routes dependencies and
              persists their results. It does not claim to reproduce their
              internal implementations.
            </p>
            <div className="comparison-scroll">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>Integration</th>
                    <th>Input / output</th>
                    <th>What Relay handles</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>Pi</th>
                    <td>Stdin prompt, JSON events</td>
                    <td>Final assistant message and per-message usage</td>
                  </tr>
                  <tr>
                    <th>Claude Code</th>
                    <td>Print mode, JSON result</td>
                    <td>Result, structured output, errors and usage</td>
                  </tr>
                  <tr>
                    <th>Codex</th>
                    <td>Exec mode, JSONL events</td>
                    <td>Completed agent message and turn usage</td>
                  </tr>
                  <tr>
                    <th>Model APIs</th>
                    <td>HTTPS request, provider response</td>
                    <td>Prompt, validated output, retries and cost estimate</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              The local example fans out to all three agents, then joins their
              analyses. Each subprocess uses argument arrays, bounded output,
              cancellation, and read-only tools or a read-only sandbox. No
              website request launches a command on the server.
            </p>
            <pre className="code-block">bun run demo:agents</pre>
            <p>
              Install and authenticate the CLIs first. Claude Code’s bare mode
              requires an API key. Pi’s tool allowlist is not an
              operating-system sandbox.
            </p>
            <div className="source-links">
              <a href="https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md">
                Pi JSON protocol ↗
              </a>
              <a href="https://code.claude.com/docs/en/headless">
                Claude Code programmatic usage ↗
              </a>
              <a href="https://developers.openai.com/codex/noninteractive/">
                Codex exec protocol ↗
              </a>
            </div>
          </section>
          <section id="security">
            <h2>Your keys belong to your workspace.</h2>
            <p>
              A random HttpOnly cookie identifies this browser workspace. Every
              run, event and connection request checks its owner on the server.
              Keys are validated with the selected provider and encrypted with
              AES-256-GCM before being saved. They are never included in run
              exports or connection listings.
            </p>
            <p>
              Browser storage does not hold your keys. Clearing the workspace
              cookie loses access; this release has no account recovery or
              cross-device sign-in. Remove connections when you finish using a
              shared machine.
            </p>
            <Link className="button" data-variant="quiet" href="/connections">
              Manage connections
            </Link>
          </section>
          <section id="tradeoffs">
            <h2>The boundaries are part of the design.</h2>
            <ul className="tradeoff-list">
              <li>
                <strong>At-least-once execution.</strong> A worker can die after
                an upstream call but before saving its response. Side-effecting
                tools require idempotency and external isolation.
              </li>
              <li>
                <strong>Request-driven continuation.</strong> On Vercel, long
                runs resume when another request arrives after the lease
                expires. Unattended jobs need a separate persistent worker.
              </li>
              <li>
                <strong>Estimated budgets.</strong> Token usage comes from
                providers. Dollar estimates use your configured prices;
                in-flight calls can exceed a budget.
              </li>
              <li>
                <strong>Visible simulations.</strong> Demo responses are
                scripted. They demonstrate the real scheduler and persistence
                without claiming model quality or current research.
              </li>
            </ul>
            <LaunchDemoButton
              templateId="retry-lab"
              label="Try the recovery demo"
            />
          </section>
        </div>
      </div>
      <footer className="site-footer">
        <span>Designed and built by Pallab Das</span>
        <a href={`${source}docs/research/agent-systems.md`}>
          Research notes & source evidence
        </a>
      </footer>
    </main>
  );
}
