# Self-hosting Eavesy

Eavesy runs entirely on Cloudflare (three Workers plus D1, R2, KV, Queues,
Vectorize and Workers AI) with [Clerk](https://clerk.com) for sign-in. You can
run your own copy in your own Cloudflare account and point the Mac app at it.
`eavesy.com` is the maintainer's hosted instance of the same code.

Want to hack on Eavesy without any accounts? See
[Local development mode](#local-development-mode-no-accounts) below.

## What you need

- A Cloudflare account on the Workers Paid plan (Queues and Vectorize
  need it) and, optionally, a domain on Cloudflare.
- A Clerk application (the free tier is fine).
- An Anthropic API key (summaries and notes).
- [Bun](https://bun.sh), Node 20+, and this repository cloned.

## How configuration works

The committed Wrangler configs contain obviously fake placeholder IDs so the
repo runs locally with no account. Wrangler reads your account from
`CLOUDFLARE_ACCOUNT_ID`, but D1/KV IDs and route domains cannot come from
environment variables, so `scripts/render-wrangler.mjs` fills them in from env
just before a deploy:

| Variable | Required | Meaning |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | yes | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | yes | API token (see [DEPLOY.md](DEPLOY.md) for permissions) |
| `EAVESY_D1_DATABASE_ID` | yes | UUID of your D1 database |
| `EAVESY_KV_CACHE_ID` | yes | ID of your `CACHE` KV namespace |
| `EAVESY_APP_DOMAIN` | no | Custom domain for the web Worker, e.g. `eavesy.example.com`. Unset = `*.workers.dev` |
| `EAVESY_WWW_DOMAIN` | no | Extra custom domain for the web Worker |
| `EAVESY_MCP_DOMAIN` | no | Custom domain for the MCP Worker, e.g. `mcp.example.com` |

## 1. Create the Cloudflare resources

```bash
cd web
bunx wrangler login
bunx wrangler d1 create eavesy                       # note the database_id
bunx wrangler r2 bucket create eavesy-audio
bunx wrangler kv namespace create CACHE              # note the id
bunx wrangler queues create eavesy-processing
bunx wrangler queues create eavesy-processing-dlq
bunx wrangler vectorize create eavesy-embeddings --dimensions=1024 --metric=cosine
bunx wrangler vectorize create-metadata-index eavesy-embeddings \
  --property-name=userId --type=string
```

Workers AI needs no setup; it is an account-level binding. The `userId`
Vectorize metadata index is required: search results are filtered by it.

If you want different resource names, edit the `name`/`bucket_name`/`queue`
fields in the three Wrangler configs.

## 2. Configure your environment

Export the values in your shell (or set
them as repository variables for CI, see below):

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>
export CLOUDFLARE_API_TOKEN=<token>
export EAVESY_D1_DATABASE_ID=<d1 uuid>
export EAVESY_KV_CACHE_ID=<kv id>
export EAVESY_APP_DOMAIN=eavesy.example.com      # optional
export EAVESY_MCP_DOMAIN=mcp.example.com         # optional
```

Render the Wrangler configs. This edits three tracked files in place; run
`bun run cf:restore` afterwards so you do not commit your IDs:

```bash
bun install
bun run cf:render
```

## 3. Set up Clerk

1. Create a Clerk application and enable the sign-in methods you want.
2. Copy the publishable key (`pk_...`) and secret key (`sk_...`).
3. In the Clerk dashboard set the sign-in/sign-up URLs to `/sign-in` and
   `/sign-up` and the after-sign-in URL to `/app` on your domain.
4. Put the publishable key into `web/.env.production` as
   `VITE_CLERK_PUBLISHABLE_KEY`, and set `VITE_APP_URL=https://<your domain>`
   (copy the other `VITE_CLERK_*` lines from `web/.env.example`). These are
   baked into the build.

## 4. Secrets

Web Worker (`cd web`):

```bash
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put CLERK_PUBLISHABLE_KEY
bunx wrangler secret put NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
bunx wrangler secret put ANTHROPIC_API_KEY
bunx wrangler secret put OPS_METRICS_TOKEN     # random string, protects /api/ops/metrics
bunx wrangler secret put BYO_KEY_SECRET        # random 32+ chars; encrypts users' own provider keys
```

Processing Worker (`cd workers/processing`):

```bash
bunx wrangler secret put ANTHROPIC_API_KEY
```

The MCP Worker needs no secrets. `SENTRY_DSN` is optional on all three. Stripe
variables are only relevant if you enable paid plans.

Secrets must exist before first use; `wrangler secret put` requires the Worker
to exist, so if it complains run the deploy in step 5 first and then add them.

## 5. Migrate and deploy

```bash
bun run db:apply:remote
bun run deploy:processing
bun run deploy:mcp
bun run deploy
bun run cf:restore
```

Order matters: processing (queue consumer) before web (producer).
Verify with `curl -I https://<your domain>` and sign in.

### Deploying from GitHub Actions

`.github/workflows/deploy.yml` deploys `main` using repository **variables**
`CLOUDFLARE_ACCOUNT_ID`, `EAVESY_D1_DATABASE_ID`, `EAVESY_KV_CACHE_ID`,
`EAVESY_APP_DOMAIN`, optionally `EAVESY_WWW_DOMAIN`, `EAVESY_MCP_DOMAIN`,
`VITE_CLERK_PUBLISHABLE_KEY`, and the **secret** `CLOUDFLARE_API_TOKEN` (in the
`production` environment). Fork the repo, set those, and pushes to your `main`
deploy to your account. Pull request CI (`ci.yml`) needs none of them.

## 6. Point the Mac app at your server

Build the app yourself (see [desktop/BUILD.md](../desktop/BUILD.md)); the
released app talks to eavesy.com unless told otherwise. Server URL, in order of
precedence:

1. `EAVESY_API_BASE` environment variable (debug builds only).
2. `"api_base_url": "https://eavesy.example.com"` in the app's `settings.json`
   (`~/Library/Application Support/com.eavesy.desktop/settings.json`), in any
   build. Quit the app first. Must be `https` (or `http://localhost` for dev).
3. `EAVESY_API_BASE=https://eavesy.example.com` set when compiling.
4. `https://eavesy.com`.

Also set, when building your own bundle:
- `VITE_EAVESY_WEB_ORIGIN=https://eavesy.example.com` for `desktop/launcher-ui`
  (links the launcher opens in the browser).
- The auto-update endpoint in `desktop/src-tauri/tauri.conf.json`
  (`plugins.updater.endpoints`), plus your own updater signing key. If you do
  not publish updates, remove the updater endpoint.

Then use "Connect account" in the app to pair it with your instance.

## Local development mode (no accounts)

Needs no Cloudflare or Clerk credentials. `EAVESY_LOCAL_TEST=1` makes the web
app use local simulated bindings and a seeded fake user.

```bash
cd web
bun install --frozen-lockfile
bunx wrangler d1 migrations apply eavesy --local
EAVESY_LOCAL_TEST=1 bun run dev --port 3000
```

Open http://localhost:3000, then sign in as the seeded user by setting a cookie
in the browser console:

```js
document.cookie = 'eavesy_local_test=1; path=/';
```

Reload and go to `/app`. You are "Local Tester" with three sample meetings.

What it does:
- D1, R2 and KV are local Miniflare stores (persisted under `web/.wrangler`).
- Auth is bypassed for requests carrying the cookie above; Clerk is not
  contacted and no Clerk keys are needed.
- Workers AI and Vectorize bindings are removed, so anything depending on them
  (semantic search, transcription, summaries) does not work; sample data is
  pre-seeded instead.
- Only active under `vite dev`; production builds ignore the flag.

The processing and MCP Workers are exercised by the test suites
(`cd web && bun run test:workers`), which use in-process Miniflare and need no
credentials. Running them with `wrangler dev` needs a Cloudflare login because
of the AI binding.

The desktop app can point at it:
`EAVESY_API_BASE=http://localhost:3000 bunx @tauri-apps/cli dev` (debug builds).
Pairing needs a real signed-in user, so device features are limited here.
