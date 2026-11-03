import Link from "next/link";
import { EngineDiagram } from "@/components/engine-diagram";
import { LaunchDemoButton } from "@/components/launch-demo-button";
import { TemplateGallery } from "@/components/template-gallery";
import { TopBar } from "@/components/top-bar";

export default function Home() {
  return (
    <main className="shell site-shell">
      <TopBar />
      <section className="hero">
        <div className="hero-copy">
          <p className="project-note">
            <span className="lamp" data-state="succeeded" />
            An orchestration engine, built from scratch
          </p>
          <h1>
            Give every agent
            <br />a place in the plan.
          </h1>
          <p className="hero-description">
            Turn a goal into connected steps. Run independent work in parallel.
            Keep every result, even when a worker stops.
          </p>
          <div className="hero-actions">
            <LaunchDemoButton />
            <Link className="text-link" href="/playground">
              Build your own workflow
            </Link>
          </div>
          <p className="hero-footnote">
            No key needed for the demo. Bring your own key for real model runs.
          </p>
        </div>
        <EngineDiagram />
      </section>
      <div className="capability-strip">
        <span>Dependency-aware scheduling</span>
        <span>Postgres checkpoints</span>
        <span>Worker crash recovery</span>
        <span>Per-step traces</span>
      </div>
      <section className="site-section">
        <div className="section-heading">
          <div>
            <h2>A workflow you can actually follow.</h2>
            <p>
              See the inputs, decisions and failures behind the final answer.
            </p>
          </div>
          <Link className="text-link" href="/architecture">
            Inside the engine
          </Link>
        </div>
        <div className="feature-columns">
          <article>
            <span className="feature-icon" aria-hidden="true">
              ⑂
            </span>
            <h3>One goal. A real graph.</h3>
            <p>
              A planner proposes the work. The engine validates dependencies and
              starts each step as soon as its inputs are ready.
            </p>
          </article>
          <article>
            <span className="feature-icon" aria-hidden="true">
              ↻
            </span>
            <h3>Failures have a next step.</h3>
            <p>
              Retry temporary errors, repair a failed branch, or resume from the
              last saved result after a worker disappears.
            </p>
          </article>
          <article>
            <span className="feature-icon" aria-hidden="true">
              ◎
            </span>
            <h3>Nothing hidden in the answer.</h3>
            <p>
              Inspect resolved prompts, attempts, sources, tokens and estimated
              costs. Export the report and execution trace.
            </p>
          </article>
        </div>
      </section>
      <section className="site-section" id="templates">
        <div className="section-heading">
          <div>
            <h2>Start with a working pattern.</h2>
            <p>
              Six editable workflows, from your first parallel run to a
              failure-recovery experiment.
            </p>
          </div>
          <Link className="text-link" href="/playground">
            Open playground
          </Link>
        </div>
        <TemplateGallery />
      </section>
      <section className="agent-section">
        <div>
          <h2>
            The engine coordinates.
            <br />
            The agents do the work.
          </h2>
          <p>
            Pi, Claude Code and Codex each bring their own model and tool loop.
            Relay provides the dependencies, checkpoints and failure policy
            around them.
          </p>
          <Link className="text-link" href="/architecture#agents">
            Explore the local adapters
          </Link>
        </div>
        <div className="agent-list">
          {[
            [
              "Pi",
              "JSON event stream",
              "Read-only analysis through Pi’s local CLI.",
            ],
            [
              "Claude Code",
              "Print JSON",
              "Programmatic agent results and reported usage.",
            ],
            [
              "Codex",
              "Exec JSONL",
              "Ephemeral, read-only runs with structured events.",
            ],
          ].map(([name, mode, detail]) => (
            <article key={name}>
              <div>
                <h3>{name}</h3>
                <span>{mode}</span>
              </div>
              <p>{detail}</p>
            </article>
          ))}
          <p className="hint">
            Local adapters run on your machine. The hosted playground uses model
            APIs.
          </p>
        </div>
      </section>
      <section className="closing-section">
        <div>
          <h2>Your workflow. Your provider.</h2>
          <p>
            Connect OpenAI, Anthropic, Gemini, Groq, Cerebras or OpenRouter.
            Keys are encrypted, and your browser workspace stays private.
          </p>
        </div>
        <Link className="button" href="/connections">
          Connect a provider
        </Link>
      </section>
      <footer className="site-footer">
        <span>Relay, built by Pallab Das</span>
        <div>
          <Link href="/architecture">How it works</Link>
          <a href="https://github.com/PDGamerSG/Workflow-Orchestration-Engine">
            Source & documentation
          </a>
        </div>
      </footer>
    </main>
  );
}
