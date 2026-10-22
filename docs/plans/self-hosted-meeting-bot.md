# Eavesy's own meeting bot

Status: **replaces Recall.ai** for Google Meet and Teams. Zoom is next, through
Zoom's Linux Meeting SDK behind the same `Session` trait. This started as a
spike asking whether running our own notetaker on Cloudflare Containers beats
paying Recall.ai ($0.50/h recording + $0.15/h transcription); the owner chose
to own it outright, for control and to keep it proprietary.

## What was built

```
web / processing Worker ──MEETING_BOTS (service binding, RPC)──▶ BotControl
                                                                   │
                                     MeetingBot Durable Object (1 per bot)
                                       alarm at join time, watchdog
                                                                   │
                                     Container: Xvfb + Chromium + eavesy-bot (Rust)
                                                                   │
        D1 / R2 / queue ◀── outbound handler for http://eavesy.internal/bots/<id>/…
                             (segments: 16 kHz WAV ≈1/min; events: status, speakers)
```

- **`workers/meeting-bot/bot/`**: the bot, in Rust (tokio). One small static
  binary drives Chromium over a minimal CDP client (no Node, Playwright or
  Puppeteer).
  - `platform/js/capture.js` is injected before the meeting app loads. It
    wraps `RTCPeerConnection`, routes every remote audio track into a 16 kHz
    `AudioWorklet` (ScriptProcessor as fallback), and hands PCM blocks to
    Rust through a CDP binding. Video elements are hidden.
  - `platform/` is the `Session` trait with Meet and Teams adapters. Once a
    second it reads the page's phase (pre-join, lobby, in call, ended,
    denied, sign-in wall), fills in "Eavesy Notetaker", turns mic and camera
    off, presses Join, and reads who is speaking. Zoom will implement the same
    trait with the Meeting SDK, not a browser.
  - `rules.rs` decides when to leave: call ended, removed, not admitted,
    15 minutes in the lobby, 15 minutes with nobody else, 60 seconds alone
    after others left, 4 hours. Pure and unit-tested.
  - `audio.rs` cuts segments the Mac app's way: at the first quiet block
    after 60 s, 90 s at most, on the wall clock with dropped-track gaps
    padded as silence so offsets match the speaker timeline.
  - `ingest.rs` uploads segments and events on separate ordered queues with
    retries, and sends `done` only after the last segment has landed.
    SIGTERM (how Cloudflare stops a container) means leave and deliver.
  - Once in the call it posts a chat message saying it is transcribing.
- **`workers/meeting-bot/src/index.ts`**: `BotControl` (the RPC entrypoint
  the other Workers bind to) and the `MeetingBot` Container Durable Object.
  It schedules the start, claims it once in D1, starts the container, checks
  on the bot every two minutes and when the container stops, and takes the
  bot's reports through the Container outbound handler, which only accepts
  the bot id of the container making the request. No webhooks, no tokens,
  no reconcile cron.
- **Web app**: `meeting_bots.provider = 'eavesy'`. Segments become
  `meeting_segments` (track `mixed`) and `transcribe-segment` jobs, so the
  transcript and rolling notes are live during the call. Collection waits
  for the last jobs, names transcript lines from the speaker timeline, and
  queues the summary. Recall's client, webhook route and reconcile cron are
  gone; `provider_webhook_events` stays as a table.

Rust fits the driver well. It holds steady at a few MB of RAM, starts
instantly, and has no GC pauses while it shuffles audio. It also lets the
image skip a Node runtime. It doesn't change the economics, though:
Chromium is more than 95% of the container's CPU and memory, in any
language.

## Verified

- **Capture path, end to end.** A local simulator page plays speech over a
  real `RTCPeerConnection`. The bot joined it, detected the in-call state,
  and delivered segments in order: 60 s + 60 s + 19 s, 1.92 MB/min. It also
  delivered the speaker timeline and then `done`. The captured audio's
  envelope correlates **1.00** with the source speech, so the hook and the
  PCM path are lossless.
- **Server side.** Unit tests (`service.test.ts`) drive schedule → claim →
  events → segments → `done` → collect. They cover duplicate segments, a
  start claimed exactly once, cancellation before the start, speaker
  attribution, the watchdog keeping what arrived from a lost bot, and old
  Recall rows.
- **In the container.** The same simulator run inside the real image
  (Debian bookworm, Chromium 155, Xvfb; native arm64 under colima) gave:
  - **~0.09 vCPU** on average once in the call (5–14% of one core, about
    65% for the first few seconds of startup);
  - **~210 MiB** cgroup memory;
  - **4.8 MB** RSS for the Rust driver itself.

  `docker stop` (SIGTERM, which Cloudflare also sends) makes the bot leave,
  deliver its last partial segment, then send `done` and exit 0. The first
  container run found that the bot only handled SIGINT and was killed with
  its tail unsent; that's fixed.
- **Against a real Google Meet call: not yet.** It needs someone to create
  a Meet, paste the link, and admit the bot. See "Demo" below.

## Cost per call-hour

Cloudflare Containers bill provisioned memory and disk while the container
runs, and CPU only while it's actually used. Rates are at list price, after
the Workers Paid included amounts.

| | standard-1 (½ vCPU, 4 GiB, 8 GB) |
|---|---|
| Memory: 4 GiB × 3600 s × $0.0000025 | $0.036 |
| Disk: 8 GB × 3600 s × $0.00000007 | $0.002 |
| CPU: 0.09 vCPU measured (audio only) … 0.5 vCPU ceiling × 3600 s × $0.00002 | $0.006 … $0.036 |
| Egress: ~115 MB/h of WAV × $0.025/GB | $0.003 |
| Worker, DO and R2 requests (~130/h) | < $0.001 |
| **Container total** | **$0.047 … $0.077** |
| Whisper large-v3-turbo, $0.0005/audio-min | $0.030 |
| **All-in per call-hour** | **$0.08 … $0.11** |
| Recall.ai today | $0.65 |

- The low end is measured: audio only, against the simulator. A real Meet
  with video tiles makes Chromium decode several video streams, so CPU will
  sit nearer the ½-vCPU ceiling. That's the first number the real-call demo
  has to pin down. If one call needs more than ½ vCPU, standard-1 throttles
  it, and the next size up (standard-2, 1 vCPU, 6 GiB) costs about $0.11/h
  for the container.
- Memory is billed as provisioned, not used. The bot needs ~210 MiB, but
  `basic` (1 GiB) is too small once video tiles render. Custom instance types
  need at least 1 vCPU and 3 GiB, so they aren't cheaper here. Switching the
  bot to the apps' "audio only / don't receive video" setting would let it
  fit `basic`, at about $0.01/h memory plus about $0.02/h CPU. That wasn't
  built.
- Workers Paid includes 25 GiB-h of memory and 375 vCPU-minutes a month,
  about 6 standard-1 call-hours, so the first few hours are free.
- Recall's $0.65/h buys a transcript with real per-participant diarization.
  Ours costs **6–8× less**, but names come from scraping the page (see
  below).
- At 1,000 call-hours a month the difference is about **$550/month**. At 100
  hours it's about $55, which won't cover even an hour of upkeep.

## Reliability problems found

These are the real cost of owning the bot. Only #1 was actually hit in
testing, on the simulator. The others come from how Meet and Teams are known
to behave toward guests. The code handles each case and reports it with a
sub-code, but none has been seen on a real call yet.

1. **DOM selectors.** Both apps ship obfuscated class names that change
   every few weeks, so the bot never matches on classes. It matches on
   button aria-labels and visible English text (the browser runs with
   `--lang=en-US`), tested separately. The first run failed exactly here:
   Meet's icon buttons put a glyph name (`call_end`) in their text next to
   the "Leave call" label, so a combined match missed it. Any copy change
   ("Ask to join" → "Request to join") silently breaks joining. The bot
   fails loudly (`join_failed` after 2 minutes, with URL and title
   logged), but a human still has to fix the regex.
2. **Speaker names are the most fragile part.** Neither app exposes a
   stable "is speaking" attribute. Meet's speaking ring is a CSS animation
   on an obfuscated element. Teams has `data-is-speaking` on some builds
   only. Meet also mixes remote audio into 3 virtual "loudest speaker"
   tracks, so audio tracks can't be mapped to people. Without a working
   speaking indicator, transcripts still arrive but with no names.
   Calibrating these selectors is the first thing the real-call demo has
   to do.
3. **Lobby.** Admission works when the host is in the call and clicks
   Admit. The bot waits up to 15 minutes and reports
   `bot_kicked_from_waiting_room` or `timeout_exceeded_waiting_room`.
   Organisations that block anonymous guests in Meet (Workspace setting
   "Only users in this org can join") or Teams (anonymous join disabled)
   can't be joined at all. That's a hard limit Recall shares.
4. **Google sign-in prompts.** A guest Chromium with no Google account sees
   "You can't join this video call" on meetings restricted to signed-in
   users, and on some unrestricted ones when Google's risk checks dislike
   the IP. Cloudflare egress IPs are shared datacentre ranges, which those
   checks treat worse than residential ones. The bot reports
   `sign_in_required`. The fix Recall uses is a pool of signed-in Google
   accounts per bot, which is a real operational burden: account creation,
   2FA, and bans. **It was deliberately not built.**
5. **Headless detection.** The meeting apps treat `--headless` Chromium as
   unsupported, so the image runs real Chromium under Xvfb. That costs about
   100 MB and is the honest way to look like a guest browser. No stealth
   patches were added, and the bot always joins under a visible
   "Eavesy Notetaker" name.
6. **Teams launcher.** Teams links open a "use the desktop app?" page. The
   bot adds `msLaunch=false&suppressPrompt=true` and clicks "Continue on
   this browser". Microsoft has changed this flow at least twice.
7. **Alone and ended detection** rely on text like "You're the only one
   here" and on the participant count on the People button. If either
   string changes, the bot stays until the 4-hour cap. That's a cost risk,
   bounded by `MAX_CALL`, and by the container's `sleepAfter` of 5 hours.

## Deploying

`deploy.yml` deploys `workers/meeting-bot` before the processing and web
Workers (they bind to it). Wrangler builds the image with Docker and pushes it
to the account's registry; the account needs Containers enabled. There are no
secrets: the bot's reports are authenticated by which container sends them.

## Running the bot against a real call

Only the host can admit the bot, so this needs a person. Run the image
locally against a mock ingest server (any HTTP server accepting
`PUT …/segments/<n>` and `POST …/events`):

```bash
cd workers/meeting-bot && docker build -t eavesy-bot:dev .
docker run --rm --shm-size=512m \
  -e MEETING_URL=https://meet.google.com/xxx-xxxx-xxx -e PLATFORM=meet \
  -e INGEST_URL=http://host.docker.internal:8790/bots/demo -e INGEST_TOKEN=demo \
  eavesy-bot:dev
# admit "Eavesy Notetaker", talk for 2-3 minutes, then leave the call
```

It logs time to "Ask to join", whether a sign-in wall appears, which
speaking selectors fire, and a heartbeat each minute; `docker stats` gives
CPU and memory with video tiles on.

## Decision and what's next

Own bot for Meet and Teams, Recall removed. The economics were close (break
even around 300–500 bot-hours a month, at a fix every few weeks per
platform); the owner chose control and keeping it proprietary. To keep the
maintenance cost down:

1. Calibrate the join and speaking selectors on real Meet and Teams calls,
   and measure CPU and memory with video tiles (the first real-call run).
2. A daily canary: a scheduled bot joins a standing test Meet and Teams
   call and alerts when it can't reach `in_call` or reads no speakers, so a
   UI change is caught before users hit it.
3. Switch the bot to the apps' audio-only receive mode and try the `basic`
   instance.
4. Zoom through the Linux Meeting SDK (C++ over FFI) as a third `Session`.
   It needs a Marketplace app and, since March 2026, the OBF-token rules for
   joining meetings outside the app's account.
