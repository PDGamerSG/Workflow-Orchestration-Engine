# User guide

## First run

1. Open the homepage and click **Run the demo**.
2. Follow the graph as independent branches execute and their join becomes ready.
3. Select a node to inspect its resolved prompt, output, attempts, tokens and sources.
4. Open **Timeline** to inspect the durable event sequence.
5. Export the report, graph or trace from the run header.

Demo replies and usage are scripted. Scheduling, validation, persistence, cancellation and event polling use the same engine as real runs. Demo text is a teaching artifact, not research evidence.

## Templates and custom workflows

The playground offers an engine tour, research brief, product decision, content pipeline, structured-output example and retry lab. A template fills the JSON editor for review and editing. **Describe a goal** asks the selected provider to plan. The research profile builds parallel researchers, verification and a report; the general profile lets the planner propose a graph.

`{{analysis.output}}` automatically adds a dependency. JSON fields support paths such as `{{facts.output.items[0].name}}`. Use `{{facts.sources}}` for saved links. Unknown ids, cycles and invalid JSON produce validation issues.

Set concurrency and optional token/dollar budgets. Dollar budgets require configured prices. In-flight calls can exceed a budget. The retry lab injects one transient demo failure to make retries reproducible.

## Real models

Add a provider in **Connections**. A key is an API credential, not a ChatGPT or Claude subscription login. Validation makes a small provider call and can incur a charge. Select the saved connection in the playground. The run inspector records the provider and model so real execution is distinguishable from simulation.

Keys are encrypted server-side and omitted from responses and exports. Prompts and outputs are stored. Send only data you are comfortable sharing with the deployment operator and chosen provider. See the [threat model](security/threat-model.md).

## Workspace access and cleanup

Runs and connections belong to the random HttpOnly cookie in this browser. Another browser or hostname has a separate workspace. Clearing, losing or expiring the 30-day cookie loses access. There is no account recovery.

Keep at most three active and 100 saved runs per workspace. Cancel active runs before deleting them. Retry a failed run to restart only failed/skipped work. Remove a connection after cancelling its active runs. Old results remain readable after removal, but another execution needs a new connection and run.

## Exports

The side panel follows the relevant step until selected manually. Selection is included in `?step=`; timeline entries also select their step. Markdown includes the final answer and saved citations. Graph JSON contains the current graph. Trace JSON contains the run snapshot and fetched timeline, including potentially sensitive prompts and results. Handle downloads accordingly.

Sources: [`NewRunForm`](../web/components/new-run-form.tsx), [`ConnectionManager`](../web/components/connection-manager.tsx), [`RunView`](../web/components/run-view.tsx), [`session.ts`](../server/src/platform/session.ts), [`catalog.ts`](../server/src/templates/catalog.ts).
