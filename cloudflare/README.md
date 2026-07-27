# NativRead Cloudflare production stack

This directory is the production-oriented backend. The existing Next/Bun
server remains available for LAN development and rollback.

## Architecture

```text
iOS app
  -> Worker API (Apple session, validation, quotas)
     -> EU D1 (accounts, jobs, credits, entitlements)
     -> EU R2 (short-lived source/result EPUBs)
     -> Queue (backpressure, one serialized dispatcher)
        -> Workflow (durable job state, no paid-call replay)
           -> EU Container, one stable instance per job
              -> Google Gemini API
```

The Worker never unzips an EPUB. A 32 MiB compressed upload can legitimately
expand to 128 MiB, which is too close to the Worker memory ceiling. Inspection
and translation happen in the `basic` Container with 1 GiB memory. The
Container receives the EPUB as a stream and has no D1 or R2 credential; its
outbound network allowlist contains only the Gemini hostname.

## One-time provisioning

Requirements: a paid Cloudflare Workers plan with Containers enabled, Docker,
Wrangler authentication, and an App Store Services ID/bundle ID configured for
Sign in with Apple.

Current account state (2026-07-22): Wrangler is authenticated, the
`nativread-production` D1 database was created in the EU and migration
`0001_initial.sql`, `0002_terms_acceptances.sql`, and
`0003_ai_budget_reservations.sql` were applied remotely. The remaining R2,
Queue/DLQ, and Container resources require enabling the paid Workers/R2
products first.

```bash
bun install --frozen-lockfile
bunx wrangler login

bunx wrangler d1 create nativread-production --jurisdiction eu
bunx wrangler r2 bucket create nativread-artifacts --jurisdiction eu
bunx wrangler queues create nativread-translation --message-retention-period-secs 1209600
bunx wrangler queues create nativread-translation-dlq --message-retention-period-secs 1209600

bunx wrangler r2 bucket lifecycle add nativread-artifacts delete-expired-artifacts \
  --expire-days 30 --abort-multipart-days 1 --jurisdiction eu --force
```

The production D1 UUID is already configured in `wrangler.jsonc`. Do not reuse
a D1 database or R2 bucket created without the `eu` jurisdiction: jurisdiction
cannot be changed later.

Add Worker secrets interactively; do not place production values in a file or
shell history:

```bash
for secret in \
  APPLE_CLIENT_IDS APPLE_TEAM_ID APPLE_KEY_ID APPLE_PRIVATE_KEY \
  SESSION_SECRET GEMINI_API_KEY CONTAINER_INTERNAL_TOKEN
do
  bunx wrangler secret put "$secret" --config cloudflare/wrangler.jsonc
done
```

`SESSION_SECRET` and `CONTAINER_INTERNAL_TOKEN` must be independent random
values of at least 32 bytes. `APPLE_CLIENT_IDS` is comma-separated. Store the
Apple `.p8` contents as the private-key secret, including its PEM markers.

## Tenant and secret boundary

D1 uses SQLite semantics and does not provide PostgreSQL-style row-level
security. Authenticated request handlers therefore receive only a
`UserDataRepository`, which closes every user-owned query over the verified
`user_id`. They must not call `env.DB.prepare()` or `env.DB.batch()` directly.
Unscoped job-ID helpers are prefixed with `internal` and are reserved for Queue,
Workflow, and scheduled handlers that cannot run from a public HTTP route.

`cloudflare/test/tenant-isolation.test.ts` enforces this architecture and runs
two-account IDOR tests for reads, job state changes, result consumption,
credit/budget refunds, and account deletion. Keep those tests in the release
gate whenever a D1 query or public route changes.

Provider credentials never belong in the iOS target, Wrangler variables,
container image layers, repository files, or CI logs. Store Apple private keys,
the Gemini API key, the session signing secret, and the Container internal
token as Worker secrets. Use separate least-privilege Cloudflare API tokens for
deployment and D1 migrations, scope them to the production account/resources,
and rotate/revoke them independently.

The production config also enforces `GLOBAL_DAILY_AI_BUDGET_USD=5` and
`GLOBAL_MONTHLY_AI_BUDGET_USD=25` provider budgets. Each running job reserves
its `COST_CEILING_USD=3` worst-case amount atomically in D1; failures release
it and successful jobs settle to actual measured cost. Keep all three limits
conservative until production usage and Gemini invoices have been reconciled.
These application limits do not replace Cloudflare billing notifications or
account-level spend review.

## Verify and deploy

```bash
bun run cf:typecheck
bun run cf:migrate:local
bun run cf:dry-run
bunx wrangler d1 migrations apply nativread-production \
  --remote --config cloudflare/wrangler.jsonc
bun run cf:deploy
```

After deployment, verify `GET /health`, Apple login, one sample translation,
result consumption, retention cleanup, and account deletion against the
actual Worker URL. Only then put the verified HTTPS URL into
`NativReadDefaultTranslationBackendURL` in the iOS `project.yml`.

## Legal Pages

From the iOS repository, create and deploy the static legal project once:

```bash
bunx wrangler pages project create nativread-legal --production-branch main
bunx wrangler pages deploy docs/public --project-name nativread-legal --branch main
```

The project is live at `https://nativread.com/`. Its operator,
address, and contact placeholders remain a release gate even though the static
site is deployed.

The GitHub environment `cloudflare-pages` needs only
`CLOUDFLARE_ACCOUNT_ID` and a narrowly scoped `CLOUDFLARE_API_TOKEN` that can
deploy this Pages project. The workflow pins third-party actions by immutable
commit SHA.

## Release gates

- Keep `REQUIRE_TRANSLATION_ENTITLEMENTS=1`. The purchase endpoint intentionally
  returns `501` until App Store Server API signed-transaction verification is
  implemented.
- Set the Cloudflare account's log/analytics retention and access controls.
  EU storage/compute bindings do not by themselves force TLS termination or
  Worker execution into the EU; full edge-processing localization requires
  Cloudflare Regional Services/Data Localization Suite.
- Fill all legal-document operator/contact placeholders and obtain legal
  review before commercial launch.
- Never deploy with `ALLOW_DEV_AUTH=1` or a non-production `ENVIRONMENT`.
