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

## Live captions

With the **Live captions** setting on (the default), the sidecar also runs the
on-device recognizer (same engines as dictation, below) on the mic and system
tracks while a meeting or voice note records (`--captions all`):

- **Permission:** Speech Recognition is asked for at first launch (with the
  mic) and when captions are turned on, never by a recording. Without it,
  recordings behave as before, minus the captions.
- **Display:** Rust forwards every caption as the `recording:caption` Tauri
  event. The HUD shows the newest words of each track on its own labelled line
  ("You", "Others"), and the launcher shows the last few lines.
- **Storage:** caption finals are stored in the local `live_lines` table as
  provisional lines. A writer thread does this behind a bounded queue that
  drops on overflow, so the sidecar's stdout reader never waits on the
  database.
- **Replacement:** every 5 s, Rust asks `/api/sessions/:id/transcript?since=`
  for the cloud's transcript changes: time ranges, with every cloud line in
  them. Locally it removes cloud lines that overlap a range and provisional
  lines whose midpoint falls inside one, then stores the cloud's lines. A
  caption therefore stays until the cloud has covered that moment, and the
  cloud transcript is still the record.
- **Expiry:** provisional lines more than 5 minutes (of recording time) behind
  the newest cloud range were never replaced, so they are dropped.
- **Cleanup:** the table is cleared when the recording completes or fails. A
  deleted meeting (`meeting_not_found`) stops the polling for that recording.

## Caption language

Live captions and dictation caption in the account's transcription language,
which Rust caches from `/api/devices/me` and passes as `--language`:

- **A fixed language** captions in that language, in the user's own regional
  variant when the system speaks it, else the variant for their region, else
  the language's most common one. If no recognizer on the Mac speaks it,
  captions stay in the system language.
- **`auto`** starts in the system language and follows what is spoken. Rust
  sends the sidecar `{"language":"es"}` on stdin when the language most of the
  newest cloud lines were heard in (`transcript_segments.language`) changes.
  The sidecar also runs `NLLanguageRecognizer` over recent caption finals and
  switches only on strong evidence, since a recognizer in the wrong language
  mostly writes its own. Every track moves together; the old engine settles
  its last finals while the new one takes the audio from then on. A language
  no recognizer speaks, or whose engine fails to start, is not tried again.

## Dictation

Dictation (the dictation hotkey, the launcher's Dictate button and the "Start
dictation" command) records and uploads like any voice note, so it appears in
web history and search, and crash recovery covers it. It also runs on-device
Apple Speech on the mic with `--captions mic`, in the caption language below.

- **Engines:** SpeechAnalyzer on macOS 26 when the language model is installed
  (otherwise it starts the download and uses the fallback), and
  SFSpeechRecognizer with `requiresOnDeviceRecognition` on older systems.
  Neither runs without Speech Recognition permission.
- **Events:** `caption`, `captions_status` and, at stop, `captions_done` go out
  on stdout beside the usual events. A recognizer failure only turns captions
  off and never stops capture. Audio held while the recognizer starts is capped
  at about 10 s, and anything dropped is counted.
- **Paste on stop:** the sidecar waits up to 3 s for the last finals, then Rust
  pastes the on-device text (the last partial if no final arrived) into the app
  that had focus. If captions were unavailable, failed, dropped audio or timed
  out, or heard nothing, Rust sends the clip to cloud Whisper
  (`/api/transcribe`) and pastes that instead.
- **The record:** the cloud transcript of the upload is the dictation's record
  either way. If both pastes fail, it is pasted once ready.

## Live transcription latency

For each recording, the Mac measures two latencies from the moment the capture
engine reports `ready`:

- **Time to first live caption:** the first on-device caption, partial or
  final. The target is about 2 s or less after the first words.
- **Time to first cloud line:** the first transcript line back from
  `/api/sessions/:id/transcript`. This is bounded by the segment length (60 s),
  plus upload, Whisper and the 5 s poll.

Both are stored in the local `live_metrics` table, kept for 30 days. Each one
is written to the app log the first time it happens (`first live caption after
N ms`, `first cloud line after N ms`). One summary line, `live transcription
latency`, is logged when the recording completes. The app log is part of
**Copy diagnostics**, so a user's report carries the numbers. Audio and text
are never logged. A recording without captions (no permission, an unsupported
language, older macOS) has no first-caption value, and that is the signal that
it fell back.

How it fits together:

1. Audio flows. The on-device recognizer shows words in the HUD within about
   a second.
2. Caption finals are saved as provisional lines.
3. Each 60 s segment uploads, and the processing Worker transcribes it with
   Whisper.
4. The Mac's next poll replaces that time range with cloud lines.
5. On stop, the cloud transcript becomes `transcript.md`, the record.

Dictation stops after step 1 and pastes the on-device text, using Whisper only
when there is none.

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
errors and content-free product events to PostHog. Reports keep the error message, stack, route, method and
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
