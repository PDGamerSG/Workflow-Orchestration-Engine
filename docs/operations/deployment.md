# Deployment and operations

## New installation

1. Import the GitHub repository into Vercel with root directory `web` and Node.js 24.
2. Install the Bun workspace with `bun install --frozen-lockfile`; build with `bun run build` from `web`.
3. Connect Neon Postgres and configure its pooled `DATABASE_URL`.
4. Set a private, stable `RELAY_SECRET` of at least 32 characters in every environment that uses that database.
5. Leave `LLM_PROVIDER=demo` or omit it. Visitor keys are added through the site, not deployment variables.
6. Deploy, check `/api/health`, then complete a demo and test a separate workspace's access.

Do not run independent production and preview secrets against the same credential database. Prefer separate databases for untrusted previews. The tables and additive columns are initialized idempotently on startup; there is no destructive migration script in this release.

Sources: [`next.config.ts`](../../web/next.config.ts), [`relay.ts`](../../server/src/relay.ts), [`db.ts`](../../server/src/engine/db.ts), [`store.ts`](../../server/src/engine/store.ts), [`secret.ts`](../../server/src/platform/secret.ts).

## Execution lifecycle

The route uses Next.js `after()` to keep owned runs active and declares `maxDuration=300`. A killed function loses its lease after the configured TTL. The next API request sweeps eligible runs, reacquires their saved connection and repeats interrupted steps. The hosted app has no unattended-completion guarantee. For that requirement, run a persistent engine process with `Engine.start()` or add a separately operated wakeup service.

Monitor failed runs, lease takeovers, provider HTTP failures, database availability and actual provider charges. Per-connection RPM is process-local. The UI's USD values are estimates; unknown failed-call usage and search costs can differ from invoices. There is no built-in billing or alerting integration.

## Backup and secrets

Back up Postgres and the encryption secret separately with restricted access. Prompt/output rows and workspace bearer identifiers are sensitive. A database backup without the original encryption secret cannot restore provider credentials. A leaked database plus the secret exposes them; revoke affected keys at their providers. Cookie loss has no built-in recovery flow.

Removing a saved key deletes its live row; provider revocation is a separate action. Database backup retention can retain ciphertext. Deleting a run removes its steps/events but is not a guarantee that all database backups or opt-in cache entries disappear.

## Rollback

Use Vercel's production rollback to a known compatible deployment. Preserve the database and encryption secret. This release adds ownership/runtime columns and encrypted connections; older releases lack workspace checks and must not be restored as a public replacement without restricting access first. For future schema changes, prefer additive compatibility and tested backfills.

## Custom hostname

Attach the hostname to the explicit Vercel project, then use the project-specific CNAME Vercel recommends. Save one Namecheap CNAME with Automatic TTL and preserve mail and unrelated records. Verify authoritative DNS, public DNS, TLS, the production page assets and an API workflow. HTTPS validation is mandatory. Workspaces are host-scoped, so switching from a Vercel alias to the custom domain creates a different browser workspace.

The current release hostname and immutable deployment evidence are recorded in the [verification report](../testing/verification.md).
