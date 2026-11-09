# Plan: make Eavesy feel finished

Status: proposal (2026-11-09). Research and plan only; no code has changed.

## Short answer

Eavesy feels janky mostly because **dictation does not end the same way twice**.
Since live typing shipped (0.9.6), close to half of all dictations finish with
the rough draft left in the field and the polished words only on the clipboard,
under a message that says there was no text box. The wait after you stop
talking also swings between about one second and eight. Everything else in
this plan is real but smaller: fixed waits, windows that hide or move, screens
that pop in, and three slightly different design systems.

The fix is not a redesign. It is a period of finishing: measure the daily path,
make dictation reliable and predictable, then remove the small inconsistencies
and stop new ones from landing.

## Where the evidence comes from

- The Mac app's own logs on the owner's machine, 2026-11-04 to 11-09
  (5,117 lines, 333 dictations). Counts only; nothing dictated was read.
- Three read-only code audits (launcher UI, native windows, web app). The
  claims this plan leans on were re-checked against the source.
- Git history: 322 commits since 2026-10-13.

Limits: this is one machine and six days, and it may include debug builds.
Eavesy's PostHog project was not reachable from the research session, so
nothing here is confirmed across other users. Line numbers are as of commit
`c8e8d9f5`.

## Likely causes, in order of impact

### 1. Dictation ends in the wrong place about half the time

| Outcome (333 dictations) | Count | Share |
| --- | --- | --- |
| `pasted` | 99 | 30% |
| `pasted_unverified` | 85 | 26% |
| `no_text_box` (copied instead) | 149 | 45% |

By day the copied share was 4% on 11-04, before live typing was in use, and
between 33% and 71% on each day after. In 118 of the 149 copied cases the
focused element was a text area, so there *was* a text box.

What happens: live typing puts the draft in the field. On stop, the app tries
to swap the draft for the polished text. When that swap fails, the code sets
the outcome to `CopiedNoTextBox`
(`desktop/src-tauri/src/dictation.rs:368`), the draft stays, the polished text
goes to the clipboard, and the pill says "Copied — press ⌘V to paste". Pressing
⌘V then adds a second copy after the draft.

Logged reasons the swap failed or live typing gave up:

| Reason | Count |
| --- | --- |
| Typed words were changed while typing | 69 |
| Field has a newline where a letter was expected | 47 |
| Caret moved | 26 |
| Field no longer has the keyboard | 21 |
| App didn't take the typed words | 17 |
| Typed words couldn't be read back | 13 |
| Field has a different letter than expected | 12 |

Live typing was also switched off up front for 61 dictations (no app found 33,
field can't be read back 28), and "focused app unreadable; using the frontmost
app" was logged 497 times.

This is the largest cause because it hits the main action, it is intermittent,
and the message gives the wrong reason, so it is hard to notice what went
wrong.

### 2. The wait after you stop is unpredictable

- Stop to delivered: median 1.4 s, 90th percentile 5.0 s, worst 8.0 s. 36% took
  over 2 s and 18% took over 4 s.
- Nearly all of it is the polish request, which delivery waits for
  (`dictation.rs:298`). Its timeout is 4 to 8 s
  (`desktop/src-tauri/src/transcribe.rs:65`). 23 polishes failed or came back
  empty and fell back to the words as heard, after the full wait.
- Fixed waits sit on top: 800 ms spelling grace
  (`desktop/swift-audio/Sources/SwiftAudio/CaptionEngines.swift:569`), 120 ms
  plus up to 400 ms before ⌘V (`desktop/src-tauri/src/commands.rs:56`), up to
  400 ms focus settle (`hud.rs:605`), 80 ms after hiding the launcher
  (`dictation.rs:185`).

A steady 1.5 s feels fine. One second, then five, then two does not.

### 3. The first live words arrive late and unevenly

First caption after the key press: median 1.1 s, 90th percentile 4.0 s, worst
36 s; 47% took over 2 s. The microphone itself starts fast (median 164 ms), so
the delay is in the speech engine, not the audio start.

### 4. Windows hide, snap and move

- The pill is hidden whenever the launcher is open (`hud.rs:489`,
  `panel.rs:267`), so dictating with the launcher open shows no pill.
- The launcher closes on any loss of focus unless pinned (`panel.rs:241`).
- The pill paints a default look, then switches to the saved look once settings
  load (`desktop/launcher-ui/src/hud.tsx:74`, `:315`).
- The pill changes size with no animation (`hud.rs:739`); the launcher is moved
  every 150 ms for up to 90 s while a system prompt is showing
  (`make_room.rs:72`).
- A stop that takes longer than 60 s drops the pill with no message
  (`hud.rs:138`).

### 5. Screens pop in instead of arriving

- Launcher history is blank while loading and is fetched again on every open,
  with no cache (`web/src/components/launcher/capture-history.tsx:828`).
- No `/app` route has a loader or a pending screen (`web/src/router.tsx`). Data
  is fetched after mount (`web/src/lib/api/shared-resource.ts:56`), so pages
  show "Loading…" text and then fill in.
- The account name, download card and share button appear late
  (`web/src/components/shell/app-shell.tsx:311`, `:478`).
- Renaming a meeting shows the old title until the refetch lands
  (`web/src/components/meeting/editable-title.tsx:21`).
- The meeting page refetches everything on every window focus
  (`web/src/lib/api/use-meeting.ts:81`). The library's processing status is
  never refreshed.
- Only new rows animate in the launcher; removals and view swaps cut.

### 6. Three design systems that almost match

- The launcher has tokens and primitives (`desktop/DESIGN.md`). The pill has
  its own palette: 86 literal colours, 88 literal font sizes and 76 literal
  radii in `desktop/launcher-ui/src/styles.css`, plus a leftover fallback
  palette at `:10-45`. The dark tokens in code differ from `DESIGN.md`
  (`tokens.css:98`, `:104`).
- The web app has two button systems (`appButton` 78 uses, `Button` 124 uses,
  137 raw `<button>`), 324 one-off Tailwind values, eight text sizes, three
  toast systems, three focus styles and one native `confirm`.
- Motion tokens are used only in launcher CSS. Elsewhere durations are
  one-offs (mascot 260/80/400 ms, Tailwind 150/200 ms). Reduced motion covers
  only some animations.
- Names drift: "recording" and "capture" are both used about 200 times;
  "Transcribing…" and "Writing it down…"; "Retry", "Try again" and "Retry
  save"; "Library", "Recent", "Meetings" and "Home" for the same place; a
  window titled "Eavesy Sessions".

Each of these is small. Together they read as "not quite one product".

### 7. Failures are quiet

- About 60 empty `.catch(() => {})` in the desktop front end, and many
  log-only failures in sync (`desktop/src-tauri/src/sync.rs`). A permanent
  upload failure sends no notification (`sync.rs:605`).
- The launcher has one toast slot, so a second message replaces the first.
- When offline, the cloud pull retries every 30 s with no backoff
  (`sync.rs:103`): 1,489 warnings in six hours on 11-05.

### 8. The daily path is always the newest code

In under four weeks: 122 features, 90 fixes (58 on desktop) and 11 desktop
releases. Live typing shipped in 0.9.6 and has been patched in most releases
since. Nothing gates a release on how dictation actually ended the day before,
so regressions on the main path are found by using the app.

## Targets

These are the numbers to move. All can be read from logs or telemetry that
already exist.

| Measure | Now | Target |
| --- | --- | --- |
| Dictations into a text field that end with the polished text in the field | about 55% | 97% |
| "Copied" notices when a text field has focus | 118 in 6 days | near 0 |
| Stop to delivered, median / 90th percentile | 1.4 s / 5.0 s | under 1.0 s / under 2.0 s |
| First live caption, median / 90th percentile | 1.1 s / 4.0 s | under 0.7 s / under 1.5 s |
| Warning lines per day in the app log | about 250 (1,489 on a bad day) | under 50 |

## The plan

### Phase 0: a scorecard (first, about a day)

1. Add `desktop/scripts/dictation-scorecard.sh`: reads the app logs and prints
   the table above for any date range. It counts log lines only.
2. Add the swap failure reason to the existing `dictation_copied` event in
   `telemetry.rs`, so the same numbers exist for other users.
3. Get the Eavesy PostHog project connected so the numbers can be checked
   beyond one machine.

### Phase 1: dictation ends properly

1. **Tell the truth.** Add a separate outcome for "draft left, polished text
   copied" with its own notice, instead of reusing `CopiedNoTextBox`.
2. **Never leave both.** If the swap fails while the same field still has
   focus, fall back in order: select the typed range and paste over it; if the
   range can't be found, leave the draft as the final text and do not put a
   second version on the clipboard with a "press ⌘V" prompt.
3. **Fix the top failure reasons.** Take them in order of count. The newline
   case (47) and the "words were changed" case (69) are the first two. For
   each: reproduce in the VM, add a case to the headless check, fix.
4. **Fields that can't be read back** (28 plus 13): decide before typing, per
   app, whether live typing can be trusted there, and remember the answer, so
   those apps get a clean paste every time instead of a draft that can't be
   replaced.
5. **Make the wait predictable.** Give polish a short budget (about 1.5 s).
   If it has not answered, deliver the words as heard, then swap in the
   polished text when it arrives if the field is unchanged. The rewrite path
   at `dictation.rs:429` already does this kind of late swap.
6. **Remove fixed waits.** Replace the sleeps listed under cause 2 with waits
   on the real condition (the target app is frontmost, the engine has
   finalised). Keep a short upper limit on each.
7. **First caption.** Add timing marks between key press, engine ready and
   first partial; find where the 2 to 4 s cases spend the time; keep the engine
   warm between dictations if that is the gap.

### Phase 2: windows behave

1. Show the pill state inside the launcher, or keep the pill visible, when
   dictating with the launcher open.
2. Load the saved pill look before the first paint (pass it with the show
   event) so it never repaints.
3. Animate pill size changes with the existing motion tokens.
4. Replace the 150 ms launcher re-positioning loop with one move when the
   prompt appears and one when it goes.
5. Show a message when a stop times out instead of dropping the pill.

### Phase 3: screens arrive, not pop

1. Launcher history: keep the last list in memory, show it at once, refresh
   behind it. Add row skeletons for the first load.
2. Web: add route loaders for the library and meeting pages, and a default
   pending component in `router.tsx`. Replace "Loading…" text with skeletons
   that match the final layout.
3. Reserve space for the account name, download card and share button.
4. Optimistic rename, with rollback on error.
5. Refetch on focus only when the data is stale, and update in place.
6. Refresh the library while anything is processing.
7. Animate row removal and view swaps in the launcher with the motion tokens.

### Phase 4: one design system

1. Move the pill onto the `--ev-*` tokens and delete the fallback palette.
   Make the dark tokens and `DESIGN.md` agree.
2. One button, one toast (a queue, not a slot), one dialog, one focus ring
   across launcher and web app. Remove `appButton` and the native `confirm`.
3. Collapse web text sizes to the `--ev-t-*` scale.
4. All durations and easings from the motion tokens. One reduced-motion rule
   that covers everything.
5. Write a one-page glossary (capture or recording, one word for retry, one
   name for the library) and apply it.
6. Add lint checks that fail CI on literal colours, sizes, radii and durations
   outside the token files, so the drift does not come back.

### Phase 5: failures are visible and quiet

1. Go through the empty catches: each one either shows a message, logs with a
   reason, or is deleted.
2. Notify once when an upload fails for good, with a retry action.
3. Back off the cloud pull when offline (30 s, 1 min, 2 min, up to 10 min) and
   log once per outage.

### Phase 6: keep it finished

1. Run the scorecard before each desktop release. A release that makes the
   dictation numbers worse does not ship.
2. Grow the VM dictation suite (`desktop/scripts/vm-test.sh`) to cover the
   field types behind the failure reasons: plain text area, web editor,
   terminal, chat box with Return-to-send.
3. Until the Phase 1 targets hold for a week, no new features on the dictation
   path.

## Order and size

| Phase | Size | Why here |
| --- | --- | --- |
| 0 Scorecard | about 1 day | Everything after is judged by it |
| 1 Dictation | 1 to 2 weeks | Most of the felt problem |
| 2 Windows | 2 to 3 days | Same surface, small changes |
| 5 Failures | 2 to 3 days | Cheap, removes noise |
| 3 Loading | about 1 week | Web and launcher polish |
| 4 Design system | 1 to 2 weeks, can run alongside | Large but mechanical |
| 6 Release gate | ongoing | Starts once Phase 0 exists |

## How each phase is checked

Nothing here needs the owner's desktop to be driven.

- Phases 0, 1, 5: the scorecard over real logs, before and after; unit tests
  for outcome mapping and backoff; the VM suite for each failure reason.
- Phase 2: `desktop/bench/check-hud-preview.mjs` and the VM.
- Phase 3: `web/test/ux` Playwright specs, extended to assert no layout shift
  on the library and meeting pages.
- Phase 4: the new lint checks, plus axe on the app pages (today it runs only
  on public routes).

## Open questions

- Is the high copied rate the same for other users? Needs PostHog.
- Why is the first caption sometimes 4 s or more? Needs the timing marks in
  Phase 1 step 7.
- How many of the "words were changed" cases are the user editing on purpose,
  where leaving the draft is correct?
