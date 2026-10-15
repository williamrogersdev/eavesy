# Architecture

This document describes how Eavesy is built and deployed.

## Services

```text
macOS capture ──device token──► web session API ──► R2 audio
       │                              │
       │                              └──► Cloudflare Queue
       │                                      │
       │                               processing Worker
       │                              Whisper + summaries
       │                                      │
       └──poll result◄──────────── D1 ◄────────┘
              │                    │
              └──local files       ├──► web dashboard/search
                                   └──► hosted MCP + Vectorize
```

- `web/` is a TanStack Start application deployed as the `eavesy` Worker. It
  owns Clerk browser auth, device pairing, session ingestion, the dashboard,
  short browser recording, and authenticated search.
- `workers/processing/` consumes segment and finalization jobs. It transcribes
  with Workers AI Whisper, updates rolling notes, creates the final Anthropic
  summary, embeds the meeting, and performs scheduled cleanup.
- `workers/mcp/` is a stateless Streamable HTTP MCP server. Read-only tokens are
  created and revoked in Settings; every lookup is scoped to the token's user.
- `desktop/` is a Tauri 2 macOS app with an offline launcher UI, Rust state and
  sync, SQLite durability, macOS Keychain device credentials, and a Swift
  ScreenCaptureKit/AVAudioEngine capture sidecar.

## Long-form recording lifecycle

1. The launcher asks for optional meeting context and starts the Swift sidecar.
2. Swift captures microphone and system audio into one continuous archive and
   rolling AAC/M4A segments. It targets one minute (the `segment_sec` desktop
   setting, 30 seconds at least), closing at the first quiet moment after
   that and no later than half as long again.
3. Every sealed segment has an atomic JSON manifest. Rust records it in SQLite
   before scheduling an upload, so app termination or network loss is
   recoverable.
4. Rust idempotently creates the cloud session using a client session ID,
   uploads each segment (multipart at exact 8 MiB boundaries when necessary),
   and records its capture offset so sleep/wake gaps are retained.
5. The web Worker stores bytes in R2, writes session/segment state in D1, and
   enqueues processing.
6. The processing Worker transcribes each segment. Each time the transcribed
   audio crosses another four minutes it refreshes rolling notes without
   diarization and includes the supplied context blurb. Rolling notes are
   streamed from Claude Haiku 5.5 at low effort; the final summary uses the
   summary model. Both bill the user's own Anthropic key when they have one.
7. Stop seals the final segment, waits for durable uploads, and finalizes the
   cloud session. Final processing waits for the last segments (checking every
   10 seconds at first), then creates the title, summary, and embedding.
8. Rust polls the session result, then atomically writes `transcript.md` and
   `summary.md`. The full `audio.m4a` archive already resides in the same local
   recording folder.

While a meeting is live, the web meeting view streams transcript changes from
`GET /api/meetings/:id/transcript` (server-sent events, resumed by cursor) and
falls back to polling when the stream can't open. Each change is a set of
time ranges plus every line now in them, so lines removed as echo disappear
too. The cursor is the latest `meeting_segments.transcribed_at` the client
has seen.

The archive remains in R2 as the durable cloud audio copy. D1 state replaces
the old per-meeting Durable Object design.

## Authentication

Browser requests use Clerk. Desktop long-form requests use a random device
token obtained through browser-assisted pairing:

1. The desktop requests a short one-time code.
2. It opens the signed-in confirmation page and polls the pairing status.
3. After confirmation, the server returns the device token once.
4. The desktop stores it in macOS Keychain; D1 stores only its hash.

Anyone can start a code for any device ID, so the confirmation page warns when
the request came from a different network than the approving browser. A Mac
already signed in to another account moves only once that account's credential
is revoked or idle for 14 days. Signing out in the app revokes it on the server
(`DELETE /api/devices/me`).

Session routes derive the user from that token and do not accept a caller-
supplied user ID. Legacy one-shot desktop transcription still has a separate
shared-token compatibility route; it is not used for long-form recording.

## Search and MCP

Completed meetings are embedded with Workers AI using 1024 dimensions and
stored in `eavesy-embeddings`. Searches combine D1 text matches with Vectorize
semantic matches, with `userId` metadata filtering. The MCP server exposes the
same user-scoped meeting/search data through protocol initialization, ping,
`tools/list`, and `tools/call`. Clients send the token in the URL path or as
`Authorization: Bearer`; the Worker's invocation logs are off so URLs carrying
tokens are not retained.

## Failure behavior

- Local audio and manifests are written before the network is trusted.
- Segment/session identifiers make retries idempotent.
- SQLite uses bounded exponential retry timing for pending uploads.
- Multipart state is persisted in D1 and abandoned uploads are cleaned later.
- Finalization requeues while segment transcription is still pending.
- Sleep/wake seals and restarts capture rather than pretending the gap contains
  audio.
- Results are written through temporary files and atomic renames.

## Observability

Every surface (web, processing and MCP Workers, browser, Mac app) can report
errors to Sentry. Reports keep the error message, stack, route, method and
release; a shared scrubber removes bodies, headers, cookies, query strings,
emails, IPs, API keys and tokens, and the Mac app replaces recording and
home-directory paths (folder names are meeting titles). Audio, transcripts, notes and summaries are never sent. The Mac app
also keeps a rotating local log and offers a scrubbed **Copy Diagnostics**
bundle. See [OBSERVABILITY.md](OBSERVABILITY.md) for the exact rules.

## Deliberate launch boundaries

- Long-form recording is macOS-only; the web live-streaming path was removed.
- The browser recorder remains a short, one-shot experience.
- No speaker diarization is promised.
- Local Whisper is not part of this launch; cloud transcription is Workers AI.
- Mobile capture is deferred.
