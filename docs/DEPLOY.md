# Deploying Eavesy

Eavesy runs three Cloudflare Workers against shared D1, R2, Queue, Vectorize,
and Workers AI resources. Commands are run from the repository root unless noted.

## Account and authentication

The account is selected with `CLOUDFLARE_ACCOUNT_ID` (the Wrangler configs
no longer pin one) and D1/KV IDs and domains come from `EAVESY_*` variables
rendered into the configs by `scripts/render-wrangler.mjs`. See
[SELF_HOSTING.md](SELF_HOSTING.md) for the full variable list. Production uses
the same mechanism via repository variables. If your account hosts other
projects, account-scoped permissions are not restricted to Eavesy Workers alone.

Create a user API token named `eavesy-cloudflare` with account permissions:
Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit,
Workers Observability Edit, D1 Edit, Queues Edit, Vectorize Edit,
Workers AI Read, Account Settings Read, and Workers Tail Read. Include only
this account. Set Workers Routes Edit to the `eavesy.com` zone only.
The Workers template also includes User Details Read and Memberships Read.

Store the token using your own terminal (never paste it into chat):

```bash
security add-generic-password -a "$(id -un)" -s eavesy-cloudflare -w
```

The password prompt accepts the token without echoing it. The `scripts/cf`
wrapper reads that Keychain item, supplies the token and
`CLOUDFLARE_ACCOUNT_ID` to its child command, and fails if either is missing. It does not change
your saved Wrangler login or parent shell. Allow Keychain access when prompted.
On non-macOS CI runners, supply `CLOUDFLARE_API_TOKEN` through the CI secret
store and set `CLOUDFLARE_ACCOUNT_ID`. The wrapper rejects a missing account
and never falls back to OAuth.

Deploy scripts and remote migrations use the wrapper automatically. For
other authenticated commands, prefix Wrangler with `../scripts/cf` from
`web`, or `../../scripts/cf` from either Worker directory. For example:

```bash
cd web
../scripts/cf bunx wrangler d1 migrations list eavesy --remote
```

Requiring an explicit `CLOUDFLARE_ACCOUNT_ID` prevents accidental
default-account selection; it is not a security boundary against explicitly
overriding settings.

## Required resources

The committed Wrangler configs contain placeholder IDs; run
`bun run cf:render` (with `EAVESY_D1_DATABASE_ID`, `EAVESY_KV_CACHE_ID` and
optional domains exported) before deploying, and `bun run cf:restore` after.
To create the resources:

```bash
cd web
bunx wrangler d1 create eavesy
bunx wrangler r2 bucket create eavesy-audio
bunx wrangler kv namespace create CACHE
bunx wrangler queues create eavesy-processing
bunx wrangler queues create eavesy-processing-dlq
bunx wrangler vectorize create eavesy-embeddings --dimensions=1024 --metric=cosine
bunx wrangler vectorize create-metadata-index eavesy-embeddings \
  --property-name=userId --type=string
```

The `userId` Vectorize metadata index is a security and correctness
requirement: semantic results are filtered to the authenticated user.

Bindings by service:

| Service | Required bindings |
|---|---|
| `eavesy` | D1 `DB`, R2 `AUDIO_BUCKET`, KV `CACHE`, Queue producer, Vectorize, AI |
| `eavesy-processing` | D1, R2, Queue consumer/producer, Vectorize, AI |
| `eavesy-mcp` | D1, Vectorize, AI |

## Secrets

Web Worker:

```bash
cd web
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put CLERK_PUBLISHABLE_KEY
bunx wrangler secret put NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
bunx wrangler secret put ANTHROPIC_API_KEY
bunx wrangler secret put OPS_METRICS_TOKEN
```

Processing Worker:

```bash
cd workers/processing
bunx wrangler secret put ANTHROPIC_API_KEY
```

Notetaker bots (optional, both Workers): set `RECALL_API_KEY`,
`RECALL_WEBHOOK_SECRET` (the `whsec_…` verification secret) and, if the
account isn't in `us-west-2`, `RECALL_REGION`. In the Recall dashboard, point a
webhook at `https://<app host>/api/webhooks/recall` and subscribe it to the
`bot.*` status events. Without these the Notetaker page says it isn't set up.

```bash
cd web && bunx wrangler secret put RECALL_API_KEY && bunx wrangler secret put RECALL_WEBHOOK_SECRET
cd ../workers/processing && bunx wrangler secret put RECALL_API_KEY && bunx wrangler secret put RECALL_WEBHOOK_SECRET
```

Workers AI transcription and embeddings use the `AI` binding and do not need
an OpenAI or Deepgram secret. The hosted MCP worker has no provider secret; it
authenticates token hashes stored in D1. PostHog is optional for all three
Workers; without a key, error reporting is disabled without affecting request
or queue handling. `OPS_METRICS_TOKEN` protects the aggregate-only
operations endpoint and must be generated independently of user/device tokens.

### Errors and analytics (optional, strongly recommended)

All three Workers and the browser send errors and product events to PostHog
when the GitHub Actions variable `POSTHOG_KEY` holds a PostHog project API key
(`phc_…`, public by design), and do nothing extra when it isn't set. The
deploy workflow passes it to the Workers as a var and writes it into
`web/.env.production` as `VITE_POSTHOG_KEY`; leave it unset to ship no
PostHog code to browsers. Queue jobs that fail permanently and anything that
lands in the dead-letter queue are reported explicitly. Reports keep the
scrubbed error message, route, method and release; headers, cookies, bodies,
query strings, emails and tokens are never sent, and the MCP Worker also
drops the URL path. The deploy workflow passes the commit SHA as `RELEASE`.
See [OBSERVABILITY.md](OBSERVABILITY.md).

```bash
gh variable set POSTHOG_KEY --env production --body phc_…
```

The desktop app reads `EAVESY_POSTHOG_KEY` at **compile time**; in CI it
comes from the `DESKTOP_POSTHOG_KEY` variable. A build without it sends
nothing. Authentication uses the paired-device credential in Keychain.

## Database migrations

Generate migrations only when the Drizzle schema changed. Always apply and
inspect locally before production:

```bash
bun run db:generate
bun run db:apply
bun run db:apply:remote

cd web
bunx wrangler d1 migrations list eavesy --remote
```

Migration application is idempotent; the final list must show no pending
migrations.

## Validate before deploy

```bash
scripts/release-gate.sh
```

The gate uses local Miniflare resources and Wrangler dry-runs. It does not
deploy, call paid AI providers, or modify production data.

## Automatic deploys

`.github/workflows/deploy.yml` deploys production on every push to `main`.
It re-runs the web checks on the merged code, applies D1 migrations, deploys
processing → MCP → web, and smoke-tests the live domains. If the smoke test
fails it rolls the web Worker back; the processing and MCP Workers and
migrations are left as they are.

The job is skipped until `VITE_CLERK_PUBLISHABLE_KEY` is set; once it is, the
job fails loudly if any other variable is missing. One-time setup:

```bash
gh api -X PUT repos/williamrogersdev/eavesy/environments/production \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/williamrogersdev/eavesy/environments/production/deployment-branch-policies \
  -f name=main
gh secret set CLOUDFLARE_API_TOKEN --env production --repo williamrogersdev/eavesy
gh variable set VITE_CLERK_PUBLISHABLE_KEY --repo williamrogersdev/eavesy
gh variable set CLOUDFLARE_ACCOUNT_ID --repo williamrogersdev/eavesy
gh variable set EAVESY_D1_DATABASE_ID --repo williamrogersdev/eavesy
gh variable set EAVESY_KV_CACHE_ID --repo williamrogersdev/eavesy
gh variable set EAVESY_APP_DOMAIN --body eavesy.com --repo williamrogersdev/eavesy
gh variable set EAVESY_WWW_DOMAIN --body www.eavesy.com --repo williamrogersdev/eavesy
gh variable set EAVESY_MCP_DOMAIN --body mcp.eavesy.com --repo williamrogersdev/eavesy
```

The token is the Cloudflare API token described above; it lives in the
`production` environment, which only `main` can deploy from. The Clerk key
is public build-time config. `VITE_MAC_DMG_URL` is an optional variable for
the download page.

Use this workflow or Cloudflare Workers Builds, not both: Workers Builds
deploys only the web Worker, ahead of migrations and the processing Worker.

To redeploy `main` without a new commit:
`gh workflow run deploy.yml --ref main`. The manual steps below still work
for a deploy from your Mac.

## Deploy

```bash
bun run cf:render
bun run deploy:processing
bun run deploy:mcp
bun run deploy
bun run cf:restore
```

Order matters operationally: deploy the processing consumer before the web
producer. The app and MCP Worker use custom domains from their Wrangler configs:

- `eavesy.com` and `www.eavesy.com` → `eavesy`
- `mcp.eavesy.com` → `eavesy-mcp`

## Verify

```bash
curl -I https://eavesy.com
curl -I https://www.eavesy.com
curl -i https://mcp.eavesy.com
curl -I https://eavesy.com/download/mac
```

Then sign in, pair the Mac app, and record a short test meeting end to end.
Operational checks and alert configuration are in
[OPERATIONS.md](OPERATIONS.md).
For live debugging:

```bash
cd web && bunx wrangler tail eavesy --format pretty
cd workers/processing && bunx wrangler tail eavesy-processing --format pretty
cd workers/mcp && bunx wrangler tail eavesy-mcp --format pretty
```

## Rollback

Use the deployment ID shown by Wrangler or the Cloudflare dashboard:

```bash
cd web
bunx wrangler deployments list
bunx wrangler rollback <deployment-id> --message "rollback after failed smoke test"
```

Rollback application code only after considering whether a newly applied D1
migration remains compatible. Current session migrations are additive.
