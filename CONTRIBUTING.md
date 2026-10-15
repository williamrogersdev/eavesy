# Contributing to Eavesy

Thanks for helping. Issues and pull requests are welcome; for anything larger
than a small fix, open an issue first so we can agree on the approach.

## License of contributions

Eavesy is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution you agree that it is licensed under the same terms
(inbound = outbound), and that you have the right to submit it. Please sign off
your commits (`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/). Every
commit in a pull request needs a `Signed-off-by` line.

## Getting set up

You do not need a Cloudflare or Clerk account to develop or to get green CI.
Pull request CI uses no secrets.

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the services
fit together. Repository layout:

| Path | What it is | Needs |
|---|---|---|
| `web/` | TanStack Start app + APIs on Cloudflare Workers | Bun |
| `workers/processing/` | Queue consumer: transcription, summaries, cron | Bun |
| `workers/mcp/` | Read-only hosted MCP server | Bun |
| `desktop/launcher-ui/` | Launcher UI bundled in the Mac app | Bun |
| `desktop/src-tauri/` | Rust app core (Tauri) | Rust stable, Xcode CLT |
| `desktop/swift-audio/` | macOS audio/screen capture sidecar | Swift (Xcode) |

### Web app, local dev mode

```bash
cd web
bun install --frozen-lockfile
bunx wrangler d1 migrations apply eavesy --local
EAVESY_LOCAL_TEST=1 bun run dev
```

Then, in the browser console on http://localhost:3000:
`document.cookie = 'eavesy_local_test=1; path=/'` and open `/app`. Local mode
uses simulated D1/R2/KV, a seeded user, and no Clerk. Workers AI and Vectorize
are unavailable, so transcription, summaries and semantic search don't run.
Details are in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#local-development-mode-no-accounts).
To run against real Cloudflare resources, follow the same guide to deploy your
own instance.

### Workers

```bash
cd workers/processing && bun install --frozen-lockfile
cd ../mcp && bun install --frozen-lockfile
```

Their logic is covered by the web package's worker tests (below). `wrangler dev`
for the processing Worker needs a Cloudflare login because of the AI binding.

### Mac app

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
desktop/scripts/prebuild.sh      # builds launcher UI + Swift sidecar
cd desktop/src-tauri && cargo test --locked
```

See [desktop/BUILD.md](desktop/BUILD.md) for running and signing builds. To
point a debug build at another server set `EAVESY_API_BASE`, for example
`EAVESY_API_BASE=http://localhost:3000`.

## Running the tests

CI runs exactly these (see `.github/workflows/ci.yml`):

```bash
# web + workers
cd web
bun run build
bunx tsc --noEmit
bunx eslint .
bun test src                     # unit tests
bun run test:workers             # Miniflare-based worker tests, no credentials
bun bench/score.ts --check       # two-track transcription bench
(cd ../workers/processing && bunx tsc --noEmit && bunx wrangler deploy --dry-run --outdir /tmp/p)
(cd ../workers/mcp && bunx tsc --noEmit && bunx wrangler deploy --dry-run --outdir /tmp/m)

# desktop
cd desktop/src-tauri && cargo test --locked
cd desktop/swift-audio && swift test
```

Browser UX tests (Playwright, optional locally): `cd web && bun run test:ux`.

## Pull requests and review

- Open an issue first for larger changes; small fixes can go straight to a PR.
  Use the issue forms in `.github/ISSUE_TEMPLATE` when filing bugs and feature
  requests. Maintainers triage with labels such as `bug`, `enhancement` and
  `good first issue`.
- Keep PRs focused, with tests for behavior changes and docs updated.
- Commits are signed off (`git commit -s`).
- CI must be green and one maintainer must approve before merge.
- **Every merge to `main` deploys to production** (hosted eavesy.com). Please
  think about migrations and rollbacks: schema changes must be additive.
  Maintainers do the merging.
- Never commit secrets, account IDs or `.env` files. Wrangler configs use
  placeholder IDs; `scripts/render-wrangler.mjs` fills them at deploy time. If
  you run it locally, `bun run cf:restore` before committing.

## Security

Please don't report vulnerabilities in a public issue. See
[SECURITY.md](SECURITY.md) for how to report them privately.
