# Eavesy

> Drop anything in, get clean Markdown context out for Claude, Cursor, ChatGPT, or any AI agent.

## Install

**Mac app** (Apple silicon, macOS 13 Ventura or later):

```bash
brew install --cask williamrogersdev/eavesy/eavesy
```

Or [download the DMG](https://eavesy.com/api/downloads/mac/latest), open it,
and drag Eavesy into Applications. The app updates itself.

**Web app**: [eavesy.com](https://eavesy.com) works in any browser, no install.

**Connect your agent**: create an MCP connection in the web app's
**Settings**, then paste the config it shows into your agent:

```json
{
  "mcpServers": {
    "eavesy": {
      "type": "http",
      "url": "https://mcp.eavesy.com",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

See [Installing the Mac app](https://eavesy.com/docs/installing-the-mac-app)
and [Connect an agent over MCP](https://eavesy.com/docs/connect-mcp) for
permissions and the available tools.

## What it is

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

## Develop

### Production architecture

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

### Repository

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

### Local development

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

cd workers/processing && bun run typecheck && bunx wrangler deploy --dry-run
cd ../mcp && bun run typecheck && bunx wrangler deploy --dry-run
cd ../../desktop/src-tauri && cargo check
```

Type checks use pinned `tsrs` in web, both Workers, and the Worker test suite.
`bun run typecheck:tsc` provides the TypeScript fallback; `bun run typecheck:bench`
compares both compilers across all four configurations. See
[benchmark results](docs/TYPECHECK-BENCHMARK.md).

For the macOS launcher and capture sidecar:

```bash
cd desktop
./scripts/prebuild.sh
cd src-tauri
bunx @tauri-apps/cli build --debug --no-bundle
```

### Deploy

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

### Release the Mac app

```bash
desktop/scripts/build-macos-release.sh
desktop/scripts/release-macos.sh --publish   # notarize, upload to eavesy.com
scripts/publish-github-release.sh            # tag desktop-vX.Y.Z + GitHub Release
packaging/homebrew/bump-cask.sh              # then copy the cask to the tap repo
```

The Homebrew tap's source lives in [packaging/homebrew/](packaging/homebrew/).

## Acknowledgements

- The macOS launcher panel uses
  [tauri-nspanel](https://github.com/ahkohd/tauri-nspanel) (Apache-2.0).

## License

Eavesy is licensed under the [Apache License 2.0](LICENSE). Versions released
before the switch to Apache-2.0 remain available under their original
[FSL-1.1-ALv2](https://fsl.software/) terms.

Contributions are accepted under the same license; see
[CONTRIBUTING.md](CONTRIBUTING.md).
