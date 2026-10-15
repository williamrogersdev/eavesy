# Eavesy

> A local, AI-first assistant. Drop things in, paste clean Markdown into any AI agent.

Eavesy turns what you drop into it into clean, structured Markdown context that
is quick to copy into Claude, Cursor, ChatGPT, or any agent, or to reach over
MCP. It is local-first: your captures live on your disk as Markdown and JSON.

What ships today:

- **Mac app** (`desktop/`): from the launcher, press ⌘V to save text or an image
  from your clipboard, take a screenshot (these stay on your Mac), or dictate
  and record (these upload for transcription once you sign in) your screen,
  system audio, and microphone. Everything is mirrored to
  `~/Eavesy/Recordings` as Markdown, JSON, and media files.
- **Web app** (`web/`): dashboard, browser recorder, search, summaries and
  transcripts you can copy or export as Markdown, and settings, including
  connecting your own OpenRouter account.
- **Hosted MCP server** (`workers/mcp`): read-only tools to search recordings
  and dictations and fetch summaries, transcripts, and action items.

Meeting recording is one capability, not the whole product. Not shipped yet:
forwarding messages and orders from other apps, live captions, and the
cross-device "drops" work. See the [roadmap](ROADMAP.md).

Eavesy is free to use. Everyone gets the same daily limits; see
[Fair-use limits](web/src/content/docs/fair-use-limits.mdx) for the numbers and
how to change them when self-hosting.

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
    ├── DEPLOY.md        # Cloudflare deploy runbook
    └── OPERATIONS.md    # Alerts, metrics and recovery
```

## Local development

Prerequisites: Bun, Rust stable, Xcode Command Line Tools, and Wrangler logged
into the intended Cloudflare account.

```bash
bun install
cd web && bun install
cp .env.example .env.local
bun dev
```

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

Eavesy is licensed under the [Apache License 2.0](LICENSE). Versions released
before the switch to Apache-2.0 remain available under their original
[FSL-1.1-ALv2](https://fsl.software/) terms.

Contributions are accepted under the same license; see
[CONTRIBUTING.md](CONTRIBUTING.md).
