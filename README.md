# Eavesy

> Record. Transcribe. Summarize. Get the meeting out of your head.

Eavesy is a meeting recorder and dictation workspace. The web app provides the
dashboard, short browser recordings, search, settings, and account management.
The macOS app is the long-form recorder: it captures microphone and system
audio continuously, uploads recoverable segments, and mirrors completed audio,
transcript, and summary files to `~/Eavesy/Recordings`.

The current launch target is a free beta. Paid plans remain marked **Coming
soon** until Stripe is configured and explicitly enabled.

## Production architecture

| Concern | Implementation |
|---|---|
| Web app | TanStack Start + React 19 on Cloudflare Workers |
| Authentication | Clerk |
| Relational data | Cloudflare D1 + Drizzle |
| Audio | Cloudflare R2 |
| Segment processing | Cloudflare Queues |
| Transcription | Workers AI Whisper Large v3 Turbo |
| Summaries | Anthropic |
| Semantic search | Workers AI embeddings + Vectorize |
| Hosted MCP | Streamable HTTP Worker at `mcp.eavesy.com` |
| macOS app | Tauri 2 + Rust + Swift/ScreenCaptureKit |

Long recordings are divided into roughly four-minute AAC/M4A segments, with a
five-minute hard cap. Each segment is persisted locally before it is uploaded.
The processing worker transcribes segments asynchronously, periodically updates
rolling notes, and generates the final summary and embedding after recording
stops. D1 stores session state; no live-recording Durable Object is required.

## Repository

```text
eavesy/
├── web/                 # TanStack Start web app and authenticated APIs
├── workers/
│   ├── processing/      # Queue consumer, finalization, and cleanup cron
│   └── mcp/             # Token-scoped, read-only hosted MCP server
├── desktop/
│   ├── launcher-ui/     # Offline launcher UI bundled with Tauri
│   ├── src-tauri/       # Rust state, durable uploads, and filesystem mirror
│   └── swift-audio/     # macOS microphone + system-audio capture sidecar
└── docs/
    ├── ARCHITECTURE.md  # How the services fit together
    ├── SELF_HOSTING.md  # Run your own instance; local dev mode
    ├── DEPLOY.md        # Cloudflare deploy runbook
    └── OPERATIONS.md    # Alerts, metrics and recovery
```

## Local development

Prerequisites: Bun, Rust stable and Xcode Command Line Tools. No Cloudflare or
Clerk account is needed to run the web app locally:

```bash
cd web && bun install
bunx wrangler d1 migrations apply eavesy --local
EAVESY_LOCAL_TEST=1 bun run dev
```

See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for what the local mode stubs
and how to deploy your own instance on Cloudflare.

Useful checks from the repository root:

```bash
bun run build
bun run typecheck
bun run lint
bun run test

cd workers/processing && bunx tsc --noEmit && bunx wrangler deploy --dry-run
cd ../mcp && bunx tsc --noEmit && bunx wrangler deploy --dry-run
cd ../../desktop/src-tauri && cargo check
```

For the macOS launcher and capture sidecar:

```bash
cd desktop
./scripts/prebuild.sh
cd src-tauri
bunx @tauri-apps/cli build --debug --no-bundle
```

## Deploy

Apply D1 migrations before deploying code, then deploy the processing worker,
MCP worker, and web worker in that order:

```bash
bun run db:apply:remote
bun run deploy:processing
bun run deploy:mcp
bun run deploy
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for resource provisioning, secrets,
metadata indexes, smoke tests, rollback, and desktop publishing. Desktop
build and signing steps are in [desktop/BUILD.md](desktop/BUILD.md).

## Acknowledgements

- The macOS launcher panel uses
  [tauri-nspanel](https://github.com/ahkohd/tauri-nspanel) (Apache-2.0).

## License

Eavesy is [Fair Source](https://fair.io/) under the
[Functional Source License 1.1, Apache 2.0 Future License](LICENSE.md)
(`FSL-1.1-ALv2`). You may use, modify and self-host it for any purpose except
offering a competing commercial product or service. Each release becomes
available under Apache 2.0 two years after it is published.

Contributions are accepted under the same license; see
[CONTRIBUTING.md](CONTRIBUTING.md).
