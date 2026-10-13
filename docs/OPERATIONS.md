# Eavesy operations

This runbook covers failure alerts, privacy-safe launch metrics, and recovery.
It intentionally contains no secret values and every read query is aggregate.

## Error reporting (optional for the initial beta)

The initial beta deliberately runs without Sentry. During each acceptance and
beta session, tail the web, processing, and MCP Workers; inspect the desktop
`capture.log`; and check the private metrics endpoint for failed, stuck, or DLQ
work. Do not run the beta unattended while automated alerts are disabled.

Sentry remains available later. If enabled, create separate projects for the
web/Workers runtime and macOS app as described in [DEPLOY.md](DEPLOY.md) and
[../desktop/BUILD.md](../desktop/BUILD.md). The integration removes request
data, user identity, breadcrumbs, exception text, transcript/audio content, and
local home paths before sending an event. Tracing is disabled. Configure
notifications for:

- new or regressed production errors at `error` or `fatal` severity;
- `Processing job exhausted automatic retries` immediately;
- desktop capture, transcription, sync, or updater failures;
- an alert that has not delivered a test event to the intended on-call inbox.

The processing DLQ consumer persists a generic user-visible failure on the
meeting before acknowledging the message. Uploaded audio remains in R2. If D1
is unavailable, the DLQ message is retried instead of being acknowledged.

## Daily funnel, outcomes, and spend

The hourly processing cron recomputes the current and previous UTC day in
`product_metrics_daily`. It stores counts and integer cost estimates only—no
user IDs, IPs, file names, transcript excerpts, or recording content.

Query up to 90 days through the private endpoint:

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $OPS_METRICS_TOKEN" \
  "https://eavesy.com/api/ops/metrics?days=30"
```

The response covers sign-up, onboarding, device pairing (the install proxy),
first recording, first completed transcript, first copied/exported brief, first
return recording within seven days, completed meetings whose brief was
copied/exported, meeting outcomes, processing latency, work stuck in processing
for more than 30 minutes, audio duration, and estimated platform AI cost.
Brief-use conversion only counts copies/exports that happened after that meeting
emitted `meeting.complete`. Processing latency runs from `meetings.ended_at` to
the first `meeting.complete` event and includes a sample count so missing legacy
timestamps are visible rather than treated as zero. A wrong or missing token
returns `401`; an unconfigured endpoint returns `503`.

`estimated_platform_ai_cost_microusd` is an estimate, not an invoice. It uses a
pricing snapshot dated 2026-07-17: Workers AI Whisper at $0.00051/minute and
Claude Sonnet 4.6 at $3/M estimated input tokens plus $15/M estimated output
tokens, with four characters per token. Anthropic BYO and OpenRouter summaries
are excluded; Workers AI transcription is always platform-billed. Rolling
summary calls make the estimate conservative, so Cloudflare and Anthropic
billing remain the source of truth.

Suggested launch thresholds:

- page immediately when any meeting reaches the DLQ;
- investigate any `meetings_failed > 0` or `meetings_stuck > 0` during beta;
- compare daily platform cost against completed meetings and provider billing;
- investigate a fall in first transcripts relative to first recordings;
- investigate a fall in first brief use relative to first transcripts;
- compare seven-day first returns with first recordings, allowing for the
  conversion window;
- alert on a material increase in `average_processing_ms` or
  `processing_ms_max`.

## Recovery

1. Identify the failed job from Worker logs and aggregate failed/stuck metrics
   (or the content-free Sentry issue if Sentry is enabled).
2. Confirm the recording object still exists before changing D1 state.
3. Fix and deploy the processing consumer first.
4. Re-enqueue only the affected job using the correct message kind; handlers
   are idempotent, but retain the meeting ID and original R2 object.
5. Verify the meeting becomes `complete`, the `meeting.complete` event exists,
   and the next rollup removes it from failed/stuck counts.

Do not delete a failed meeting or its R2 object as a recovery shortcut.

## Release candidate automation

The manually triggered `macOS release candidate` GitHub workflow builds,
signs, notarizes, validates, and uploads CI artifacts for acceptance testing.
It never deploys Workers or publishes to R2. Configure the protected
`macos-release` GitHub environment with:

- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`;
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`;
- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

`DESKTOP_SENTRY_DSN` may be added later but is not required. The
`macos-release` environment exists as of 2026-07-17, but none of the required
secrets has been uploaded. The local Developer ID Application identity and
updater private key are present and the current-source app and embedded Swift
capture helper both pass strict Developer ID signature verification. The
noninteractive path also produced and verified a Developer ID-signed DMG and a
matching signed updater. That disposable build deliberately omitted real
production tokens and Apple notarization credentials, so it is engineering
evidence only—not an installable beta candidate. No current DMG has been
published.

Publishing remains a separate, explicit `release-macos.sh --publish` action
after the installed-DMG acceptance test. The build requests only Tauri's app
bundle (which also emits the configured updater), then creates the DMG
noninteractively, removing Finder automation from the release path. Both build
and publish cryptographically verify the updater archive against the public key
compiled into Eavesy. The candidate workflow notarizes the exact final DMG;
local workstations use the Keychain profile, while CI can use its scoped Apple
or App Store Connect secrets. The publish script verifies before its first
remote write and writes the updater manifest last.
