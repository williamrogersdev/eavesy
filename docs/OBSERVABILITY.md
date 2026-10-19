# Observability

Eavesy sends errors and a few product events to PostHog from five surfaces:
the web Worker, the processing Worker, the MCP Worker, the browser, and the
Mac app. Each is off unless a PostHog project key is configured. Error reports
are meant to be actionable (what failed, where, in which release) without
carrying anything a user wrote or said; product events say that something
happened (a Mac was paired, a capture was created), never what it contained.

## What is sent and what is not

| Kept | Removed or never collected |
| --- | --- |
| Exception type and value, after scrubbing | Audio, transcripts, notes, summaries, prompts |
| Stack trace (function, file, line) | Stack-frame variables and source context lines |
| Route / URL path and HTTP method | Query strings and URL fragments, page titles |
| Release, environment, `service` property | Request and response bodies |
| Pageviews and page leaves (path only) | Headers, cookies, `Authorization`, autocaptured clicks and inputs (they carry `title`/`aria-label` text such as meeting titles), session replay, console output |
| Opaque user id (`user_…`) on server events that name one; an anonymous install id on the Mac | Emails, IP addresses (discarded by the project setting), usernames, device names |
| Job kind, meeting id, attempt count; event kind, source, capture mode, duration | Any context key that looks like content or a credential (`text`, `transcript`, `summary`, `notes`, `body`, `title`, `token`, `key`, `secret`, `email`, …) |
| The Mac app's last 30 log lines, scrubbed, on each error report | |

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

The MCP Worker accepts its token as the URL path, so it replaces every path
with `/[redacted]` before reporting.

Transcript text and model output have no recognisable shape, so scrubbing
cannot catch them if code puts them in an error message. Throw errors that
describe the failure, not the data: report a length or status code, never a
slice of the body (`summary was not valid JSON (len=812)`, `Search failed
(500)`). As a backstop, messages from known content-bearing sites are cut
after their description (`CONTENT_BEARING_MESSAGES` in `scrub.ts`).

## Product events

| Event | Sent from | Properties |
| --- | --- | --- |
| `user_signed_up` | Web Worker, when a Clerk user first gets an Eavesy account | none |
| `mac_paired` | Web Worker (activity log) | `platform` |
| `capture_created` | Web Worker (activity log) | `kind`, `captureMode` |
| `dictation_created`, `meeting_started`, `onboarding_completed` | Web Worker (activity log) | `source` where known |
| `$pageview`, `$pageleave` | Browser | path, referrer origin and path |
| `dictation_started` | Mac app | none |
| `dictation_pasted`, `dictation_copied` | Mac app | `delivery` (`pasted`, `in_eavesy`, `no_accessibility`, `no_text_box`) |
| `recording_saved` | Mac app | `kind` (`audio`, `screen`, `dictation`), `duration_sec` |

Server events are keyed by the internal user id (`user_…`). Activity-log
events forward only the `kind`, `captureMode`, `source` and `platform`
metadata keys, and only short enum-like values. The browser creates no person
profiles; the Mac app uses a random install id stored in
`~/Library/Application Support/com.eavesy.desktop/analytics-id` and creates
no person profiles either.

## Where the code lives

- `web/src/lib/observability/scrub.ts` — the shared scrubber
  (`scrubText`, `scrubUrl`, `scrubValue`), the `$exception_list` builder for
  Workers, and `scrubAnalyticsEvent`, the browser's `before_send`. Tested in
  `scrub.test.ts` with realistic payloads and, end to end inside workerd, in
  `web/test/workers/observability.test.ts` (asserts the exact request that
  leaves the Worker, including that the MCP token never appears).
- `web/src/server/observability.ts` — the Workers' PostHog client: a plain
  `fetch` to the capture endpoint, deferred with `waitUntil`.
  `withErrorReporting` reports anything that escapes a fetch, queue or
  scheduled handler and rethrows; `reportError` and `captureMessage` report
  handled failures; `trackEvent` sends product events.
- `web/src/lib/observability/browser.ts` — browser init. `posthog-js` is
  loaded lazily, only when `VITE_POSTHOG_KEY` was set at build time; without
  it the bundle contains no PostHog code. It never loads remote scripts
  (`disable_external_dependency_loading`), autocapture, heatmaps, surveys and
  session replay are off, and exceptions are captured automatically. Router
  error boundaries report through `reportClientError`.
- `desktop/src-tauri/src/telemetry.rs` — the Mac app's PostHog sender (one
  background thread; a panic waits up to three seconds for its report to
  send), the Rust scrubber, and the app log. Recording folders are named
  after meeting titles, which can contain spaces, colons and quotes, so any
  path under the configured recordings root becomes `<recordings>/…` and any
  other path under `/Users`, `/Volumes` or `/private` becomes `~/…`,
  `/Volumes/…` or `/private/…`, through the end of the line. A trailing OS
  error ("Permission denied (os error 13)") is kept. Only the app's own
  folders, whose names are generated, keep their path
  (`<app>/captures/<id>/segments/3.m4a`). Names that macOS quotes in “curly
  quotes” are replaced too. Log sites in the file watcher log the file role,
  not the folder.

## Configuration

| Surface | Setting | Where |
| --- | --- | --- |
| Web, processing, MCP Workers | `POSTHOG_KEY` (`POSTHOG_HOST` optional) | GitHub Actions variable `POSTHOG_KEY`, passed by the deploy workflow as a Worker var (`--var`) |
| Workers release | `RELEASE` | Set to the git SHA by the deploy workflow (`--var`) |
| Browser | `VITE_POSTHOG_KEY` (`VITE_POSTHOG_HOST` optional) | Same `POSTHOG_KEY` variable, written to `web/.env.production` at build |
| Browser release | `VITE_RELEASE` | Git SHA, set by the deploy workflow |
| Mac app | `EAVESY_POSTHOG_KEY` (`EAVESY_POSTHOG_HOST` optional) | Compile time; `DESKTOP_POSTHOG_KEY` variable in the release workflow |

A PostHog project key (`phc_…`) is public by design: it can only send events,
not read them. The host defaults to `https://us.i.posthog.com`. In the
PostHog project, turn on **Discard client IP data** and leave session replay
off. `build-macos-release.sh` warns when `EAVESY_POSTHOG_KEY` is empty; such a
build sends nothing.

The Workers and the browser send no traces.

## Mac app logs and diagnostics

The app writes a daily-rotating log to
`~/Library/Logs/com.eavesy.desktop/eavesy.YYYY-MM-DD.log`, keeping seven
files; debug builds also log to stderr. The capture engine keeps writing its
own `capture.log` under the app data folder.

**Copy Diagnostics** in the menu bar menu puts a support bundle on the
clipboard: app version, macOS version and architecture, the last 200 app log
lines (spanning yesterday's file, so a bundle copied after midnight is not
empty) and the last 100 `capture.log` lines, each scrubbed with the same rules
as error reports. Nothing is uploaded; the user decides where to paste it.

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
