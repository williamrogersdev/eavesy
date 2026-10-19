# Observability

Eavesy reports errors to Sentry from five surfaces: the web Worker, the
processing Worker, the MCP Worker, the browser, and the Mac app. Each is off
unless its DSN is configured. Reports are meant to be actionable (what failed,
where, in which release) without carrying anything a user wrote or said.

## What is sent and what is not

| Kept | Removed or never collected |
| --- | --- |
| Error message and exception value, after scrubbing | Audio, transcripts, notes, summaries, prompts |
| Stack trace (function, file, line) | Stack-frame local variables |
| Route / URL path and HTTP method | Query strings and URL fragments |
| Release, environment, `service` tag | Request and response bodies |
| Breadcrumbs (fetch/navigation URLs, status codes, warning/error console lines, app log lines on the Mac) | Headers, cookies, `Authorization`, DOM click/input breadcrumbs (they carry `title`/`aria-label` text such as meeting titles), info-level console output |
| Opaque user id (`user_…`) on reports that name one | Emails, IP addresses, usernames |
| Job kind, meeting id, attempt count | Any context key that looks like content or a credential (`text`, `transcript`, `summary`, `notes`, `body`, `title`, `token`, `key`, `secret`, `email`, …) |

Free text (messages, exception values, breadcrumb messages, tags) is passed
through pattern scrubbing that replaces:

- `Bearer …`, `Basic …` credentials, JWTs (`eyJ….….…`);
- Anthropic (`sk-ant-…`), OpenRouter (`sk-or-…`), OpenAI-style (`sk-…`) and
  Stripe (`sk_live_…`, `whsec_…`) keys;
- Eavesy device tokens (`eavesy_device_…`), MCP tokens (`nt_…`) and anonymous
  tokens (`anon_…`);
- email addresses and IPv4 addresses;
- long hex or mixed base64url runs (hashes, signatures, opaque secrets);
- query strings inside embedded URLs.

The MCP Worker accepts its token as the URL path, so it also replaces every
path with `/[redacted]`, including the root span's `url.full`/`url.path`
attributes on the trace context. The SDK streams spans as their own envelope
items, which skip `beforeSend`/`beforeSendTransaction`, so spans are scrubbed
in `beforeSendSpan`; user agents and client addresses are dropped from span
attributes.

Transcript text and model output have no recognisable shape, so scrubbing
cannot catch them if code puts them in an error message. Throw errors that
describe the failure, not the data: report a length or status code, never a
slice of the body (`summary was not valid JSON (len=812)`, `Search failed
(500)`). As a backstop, messages from known content-bearing sites are cut
after their description (`CONTENT_BEARING_MESSAGES` in `scrub.ts`).

## Where the code lives

- `web/src/lib/observability/scrub.ts` — the shared scrubber and the
  `dataCollection` policy, used by the Workers and the browser. Tested in
  `scrub.test.ts` with realistic payloads and, end to end with the real
  Cloudflare SDK inside workerd, in `web/test/workers/observability.test.ts`
  and `observability-mcp.test.ts` (every trace sampled; asserts the MCP token
  appears in no envelope item).
- `web/src/server/observability.ts` — Worker `sentryOptions` and `reportError`.
- `web/src/lib/observability/browser.ts` — browser init. The SDK
  (`@sentry/browser`) is loaded lazily, only when `VITE_SENTRY_DSN` was set at
  build time; without it the bundle contains no Sentry code. Router error
  boundaries report through `reportClientError`. No session replay, no DOM
  breadcrumbs.
- `desktop/src-tauri/src/telemetry.rs` — Mac app Sentry init, the Rust
  scrubber, and the app log. Recording folders are named after meeting
  titles, which can contain spaces, colons and quotes, so any path under the
  configured recordings root becomes `<recordings>/…` and any other path under
  `/Users`, `/Volumes` or `/private` becomes `~/…`, `/Volumes/…` or
  `/private/…`, through the end of the line. A trailing OS error ("Permission
  denied (os error 13)") is kept. Only the app's own folders, whose names are
  generated, keep their path (`<app>/captures/<id>/segments/3.m4a`). Names
  that macOS quotes in “curly quotes” are replaced too. Log sites in the file
  watcher log the file role, not the folder.

## Configuration

| Surface | Setting | Where |
| --- | --- | --- |
| Web, processing, MCP Workers | `SENTRY_DSN` | Worker secret (`wrangler secret put SENTRY_DSN`) |
| Workers release | `SENTRY_RELEASE` | Set to the git SHA by the deploy workflow (`--var`) |
| Browser | `VITE_SENTRY_DSN` | GitHub Actions variable, written to `web/.env.production` at build |
| Browser release | `VITE_SENTRY_RELEASE` | Git SHA, set by the deploy workflow |
| Mac app | `SENTRY_DSN` | Optional compile-time environment variable for local builds |

`desktop/scripts/build-macos-release.sh` can build without `SENTRY_DSN`.
The release workflow does not require a Sentry secret. When the DSN is unset,
Sentry reporting is disabled; local app logs and diagnostics remain available.

Tracing is sampled at 5% on the Workers and in the browser (same-origin API
calls only get trace headers). The Mac app sends no traces.

## Mac app logs and diagnostics

The app writes a daily-rotating log to
`~/Library/Logs/com.eavesy.desktop/eavesy.YYYY-MM-DD.log`, keeping seven
files; debug builds also log to stderr. The capture engine keeps writing its
own `capture.log` under the app data folder.

**Copy Diagnostics** in the menu bar menu puts a support bundle on the
clipboard: app version, macOS version and architecture, the last 200 app log
lines (spanning yesterday's file, so a bundle copied after midnight is not
empty) and the last 100 `capture.log` lines, each scrubbed with the same rules
as Sentry events. Nothing is uploaded; the user decides where to paste it.

## Latency metric

The processing Worker stamps `meetings.first_transcript_at` the first time a
meeting stores transcript text and logs one structured line:

```json
{"event":"first_transcript_latency","meetingId":"…","source":"desktop","latencyMs":41230,"sinceSegmentMs":3120,"segmentIdx":0}
```

`latencyMs` runs from recording start; `sinceSegmentMs` from the segment
upload that produced the first line (streamed recordings). The daily rollup
adds `first_transcript_samples`, `first_transcript_ms_total` and
`first_transcript_ms_max` for streamed recordings, and `/api/ops/metrics`
returns the sample count, max and `average_first_transcript_ms`. Uploaded
files are excluded from the rollup because their first line only exists after
the whole recording.
