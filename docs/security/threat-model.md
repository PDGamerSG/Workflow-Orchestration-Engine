# Security boundaries

Relay's public deployment is a portfolio playground. It accepts provider secrets and stores prompts/results, so its data boundaries must remain explicit.

## Assets and controls

| Asset or boundary | Implemented control | Remaining limit |
| --- | --- | --- |
| Workspace access | Random 256-bit HttpOnly cookie; every run/connection operation checks owner; no-store responses. | The cookie is a bearer capability, without account recovery, identity verification or cross-device access. |
| Cross-site changes | Same-origin write checks and SameSite cookie. | This is not an account authentication or API client identity system. |
| Provider keys | AES-256-GCM, random nonce, owner/connection authenticated context; key excluded from list, event and export responses. | The deployment operator can decrypt keys with database and secret access. |
| Provider endpoint | Fixed endpoint catalog, validated provider/model/configuration. | Providers receive prompts; their own retention policies apply. |
| Provider errors | Sanitized public errors avoid persisting SDK request diagnostics. | Operators must still keep infrastructure logs restricted. |
| Tenant results and cache | Owner filters and workspace/connection cache namespaces. | Database administrators can read unencrypted prompts and results. |
| Resource consumption | Graph/input/concurrency limits, 3 active/100 saved runs per workspace, configured RPM and budgets. | New cookies can create new workspaces. No global anti-abuse, CAPTCHA or billing controls. |
| Hosted tool execution | Local agent adapters are not reachable from the public API. | Local operators remain responsible for CLI permissions and workspace isolation. |

Sources: [`session.ts`](../../server/src/platform/session.ts), [`api.ts`](../../server/src/platform/api.ts), [`crypto.ts`](../../server/src/platform/crypto.ts), [`connections.ts`](../../server/src/platform/connections.ts), [`providers.ts`](../../server/src/platform/providers.ts), [`store.ts`](../../server/src/engine/store.ts), [`scheduler.ts`](../../server/src/engine/scheduler.ts).

## Credential lifecycle

A connection is validated with a small call before storage. Only its public configuration is returned. Runtime resolution decrypts it after a worker claims a run; persisted run metadata contains a connection id, not the key. Deletion is blocked while active runs use the connection. The browser never stores the key in localStorage or a cookie; React form memory contains it while being entered.

TLS protects transit. Stored keys are encrypted; prompts, outputs, sources, usage and workspace ids are not application-encrypted. Exports can contain those contents. Do not submit sensitive customer data without adding the operational and legal controls your environment requires.

## Local agents and recovery

Process execution uses argument arrays, stdin, bounded output and abort handling. Read tool restrictions are defense in depth, not a universal sandbox. Durable recovery can repeat a step whose external call finished but whose checkpoint did not commit. Provider charges can repeat; future side-effecting tool steps need external idempotency keys and an explicit approval policy.

## Verification and dependencies

Isolation, encryption tampering/AAD, invalid validation, recovery runtime identity, cache isolation and concurrent run limits have automated tests. The release audit patches production advisories; the [verification report](../testing/verification.md) identifies the remaining development-only finding. These checks do not constitute an independent penetration test.

Contact the repository owner privately for credential exposure. Revoke affected provider keys before sharing diagnostic artifacts. No public issue should include keys, cookies, connection ciphertext or database URLs.
