# Eavesy operations

This runbook covers failure alerts, privacy-safe launch metrics, and recovery.
It intentionally contains no secret values and every read query is aggregate.

## Error reporting

Errors from the web, processing and MCP Workers, the browser and the macOS app
go to PostHog error tracking once `POSTHOG_KEY` (and, for the Mac app,
`DESKTOP_POSTHOG_KEY`) is set, as described in [DEPLOY.md](DEPLOY.md) and
[../desktop/BUILD.md](../desktop/BUILD.md). Each event has a `service`
property (`web`, `processing`, `mcp`, `browser`, `desktop`). Events keep the
scrubbed error message, route and release; bodies, headers, cookies, query
strings, emails, IPs, tokens, transcript/audio content and local home paths
are removed before sending (details in [OBSERVABILITY.md](OBSERVABILITY.md)).
Until a key is set, tail the web, processing, and MCP Workers; inspect the
desktop `capture.log`; and check the private metrics endpoint for failed,
stuck, or DLQ work. For a desktop problem, ask the user for **Copy
Diagnostics** from the menu bar menu: it copies a scrubbed log tail. Configure
notifications for:

- new or regressed production errors at `error` or `fatal` severity;
- `Processing job exhausted automatic retries` immediately;
- desktop capture, transcription, sync, or updater failures;
- an alert that has not delivered a test event to the intended on-call inbox.

The processing DLQ consumer persists a generic user-visible failure on the
meeting before acknowledging the message. Uploaded audio remains in R2. If D1
is unavailable, the DLQ message is retried instead of being acknowledged:
up to ten more times, five minutes apart (`max_retries` and `retry_delay` on
the DLQ consumer in `workers/processing/wrangler.toml`). The DLQ has no queue
behind it, so a D1 outage longer than about 50 minutes drops the message
without recording the failure. The meeting then stays in its last status, and
the hourly sweeps finish or fail it from there.

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
timestamps are visible rather than treated as zero. First-transcript latency
(`average_first_transcript_ms`, `first_transcript_ms_max`,
`first_transcript_samples`) runs from recording start to the first stored
transcript line for streamed recordings; each sample is also logged by the
processing Worker as a `first_transcript_latency` JSON line. A wrong or missing token
returns `401`; an unconfigured endpoint returns `503`.

`estimated_platform_ai_cost_microusd` is an estimate, not an invoice. It uses a
pricing snapshot dated 2026-07-17: Workers AI Whisper at $0.00051/minute and
Claude Sonnet 4.6 at $3/M estimated input tokens plus $15/M estimated output
tokens, with four characters per token. Anthropic BYO and OpenRouter summaries
are excluded; Workers AI transcription is always platform-billed. Rolling
notes run on Claude Haiku 5.5 but are counted at Sonnet prices, so the estimate
is conservative; Cloudflare and Anthropic billing remain the source of truth.

Suggested launch thresholds:

- page immediately when any meeting reaches the DLQ;
- investigate any `meetings_failed > 0` or `meetings_stuck > 0` during beta;
- compare daily platform cost against completed meetings and provider billing;
- investigate a fall in first transcripts relative to first recordings;
- investigate a fall in first brief use relative to first transcripts;
- compare seven-day first returns with first recordings, allowing for the
  conversion window;
- alert on a material increase in `average_processing_ms` or
  `processing_ms_max`;
- investigate a rise in `average_first_transcript_ms`: live notes are late.

## Rate limits and quotas

Every limit is a fixed-window counter in the D1 `rate_limits` table
(`web/src/server/rate-limit-store.ts`). One `INSERT … ON CONFLICT DO UPDATE …
WHERE count < limit RETURNING count` statement admits and counts each request,
so concurrent requests cannot over-admit. The old KV counter could, because it
read, then wrote. The hourly cron deletes expired windows.

D1 was chosen over a Durable Object because every Worker that needs a limit
(web, MCP) is already bound to it, the limit stays atomic without a new class,
binding, or Wrangler migration, self-hosters get it for free, and the worker
tests exercise it against real D1. The cost is one D1 write per limited request.
If that write volume ever competes with app traffic, move
`consumeRateLimit` onto a Durable Object keyed by the limit key; callers don't
change.

When the counter can't be reached, each limit either fails **open** (allows the
request) or **closed** (returns 429). Failures are logged as
`rate limit store unavailable`.

| Limit | Window | Default | Fails | Why |
|---|---|---|---|---|
| Segment uploads (per user) | day | 600 | open | Live recording audio; the desktop app retries anyway |
| Session create / part / finalize (per user) | minute | 30 / 120 / 30 | open | Same: refusing ingest during an outage drops recordings |
| Transcribe, process (per IP + global day budget) | minute / day | 20 & 5000, 10 & 2000 | closed | AI spend |
| Transcribe, process, dictation, capture, chat, regenerate, search (per user) | day | 300, 100, 500, 300, 300, 60, 1000 | closed | AI spend |
| Account export (per user) | day | 10 | closed | Large downloads |
| Meeting zip export (per user) | minute / day | 10 / 200 | closed | Large downloads |
| Device pairing claim / code check (per user) | minute | 10 / 30 | closed | Stops pairing codes from being guessed |
| Pairing start / status (per IP) | minute | 10 / 60 | closed | Same |
| Contact form (per IP) | 10 minutes | 5 | closed | Spam |
| MCP requests (per token) | minute | 120 | open | Read-only and authenticated; D1 down means MCP is down anyway |

Override a default without a deploy by setting a Worker variable:
`QUOTA_<SCOPE>_PER_DAY` (for example `QUOTA_MEETING_EXPORT_PER_DAY`),
`RL_<SCOPE>_PER_WINDOW` (for example `RL_SESSION_CREATE_PER_WINDOW`),
`RL_TRANSCRIBE_PER_MIN`, or `BUDGET_TRANSCRIBE_PER_DAY`.

### Global spend budget alerts

The transcribe and process day budgets are shared by every user. They are the
owner's cap on AI spend, and once one runs out, **every** caller of that route
gets a 429 until midnight UTC. The counter is exact, so the cap really bites.
As it fills, the Worker logs one structured warning per threshold per day:

```json
{"message":"spend budget threshold reached","scope":"transcribe","percent":80,"used":4000,"limit":5000}
```

`percent` is 50, 80, or 100. Alert on `percent >= 80`. At that point, decide
whether to raise `BUDGET_<SCOPE>_PER_DAY` for the rest of the day.

The hourly cron deletes expired windows 10,000 at a time until a pass deletes
fewer, capped at 100 passes per run.

## MCP tokens

Connections created in **Settings → AI assistants (MCP)** issue a token that
goes in the `Authorization` header and expires after 90 days **without use**.
Each use slides the expiry to 90 days out, with at most one write per token per
day. Settings shows the current expiry date.

```json
{
  "mcpServers": {
    "eavesy": {
      "type": "http",
      "url": "https://mcp.eavesy.com",
      "headers": { "Authorization": "Bearer nt_…" }
    }
  }
}
```

Earlier tokens were embedded in the URL (`https://mcp.eavesy.com/<token>`),
which leaks them into client configs, proxy logs, and shell history. Some MCP
clients can only be given a URL, so the migration path keeps them working:

- Migration `0019` gives every existing token an expiry 90 days after it
  runs. Because expiry slides, a token that keeps being used never expires.
  Tokens minted by code that predates the column expire 90 days after
  creation unless used.
- URL-path tokens keep working until the MCP Worker variable
  `MCP_ALLOW_PATH_TOKENS` is set to `false`. Each use is logged as
  `mcp token sent in URL path` with the token id (never the token), records
  `mcp_tokens.path_auth_used_at`, and gets a `Deprecation: true` response
  header. Settings marks those connections as needing replacement.
- With the flag off, a URL-path token gets `401` with
  `"token must be sent in the Authorization header"`. A token past its expiry
  gets `401` with `"token expired"`. Both responses tell the user to create a
  new connection.

Before turning the flag off, check who still uses URL-path tokens, and make
sure the clients they use can send headers (or that OAuth exists):

```sql
SELECT count(*) FROM mcp_tokens
 WHERE revoked_at IS NULL AND path_auth_used_at > (strftime('%s','now') - 7 * 86400) * 1000;
```

## Recovery

1. Identify the failed job from Worker logs and aggregate failed/stuck metrics
   (or the content-free PostHog error, once PostHog is set up).
2. Confirm the recording object still exists before changing D1 state.
3. Fix and deploy the processing consumer first.
4. Re-enqueue only the affected job using the correct message kind; handlers
   are idempotent, but retain the meeting ID and original R2 object.
5. Verify the meeting becomes `complete`, the `meeting.complete` event exists,
   and the next rollup removes it from failed/stuck counts.

Do not delete a failed meeting or its R2 object as a recovery shortcut.

## Release automation

Mac releases run from the `macOS release` GitHub workflow: push a
`desktop-vX.Y.Z` tag to build, sign, notarize and draft a GitHub Release, then
approve the gated `publish` job to push to R2 and the updater manifest. A
manual run builds a notarized candidate and publishes nothing. The secrets
(`macos-signing` and `macos-release` environments) and the release steps are
in [RELEASING.md](RELEASING.md). As of 2026-10-15 none of those secrets has
been uploaded, so the workflow has never run.
