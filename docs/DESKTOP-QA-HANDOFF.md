# Desktop dictation and preview QA handoff — 2026-10-20

Repository: https://github.com/williamrogersdev/eavesy. Start from the latest
`main` after the PR containing this document has merged. Read `AGENTS.md`,
`web/AGENTS.md`, `desktop/DESIGN.md`, and `docs/RELEASING.md`.

## User's objective

Make dictation pleasant and dependable: readable wrapped live words, the same
layout in the floating HUD and launcher, full-message paste rather than just
the trailing phrase, fast stopping/pasting, and an unobtrusive result preview.
The result should collapse to the resting pill after about 15 seconds. Users
can edit the preview; corrections must update the saved transcript and survive
collapse/reload. Refresh the installed app icon rather than retaining the old
house icon.

The user is moving testing to a dedicated second Mac so the next agent can
exercise the actual foreground recording/paste flow without interrupting their
work. Preserve that machine's user data and credentials. Do not assume that
permission to test also authorizes sending messages to other people.

## Changes implemented

- HUD: wrapped, scrollable transcript in a consistent 400 × 142 frame; four
  complete 20px lines, simpler result header and controls. Recording/transcribing
  remain readable instead of squeezing words into the toolbar. Launcher live
  captions use a separate wrapped region.
- Result preview: editable textarea; 350ms autosave and immediate flush on blur
  or close, serialized writes, visible retry on failure. The 15-second collapse
  timer pauses during editing/saving and on save failure. Copy uses edited text.
- Persistence: `save_preview_transcript` writes `transcript.md` atomically,
  updates `recordings.json`, uses the existing file-edit outbox, and emits the
  history update. Existing local-edit protection stops later generated results
  from overwriting corrections. Initial HUD state reads the saved transcript.
- Full-message assembly: retain separate pending phrases per track/time range;
  finals replace their own phrase, and output is chronological. Reject a
  tail-only fast-paste result when the beginning of the clip is missing and use
  the full-clip fallback. Matching frontend assembly preserves disjoint phrases.
- Legacy Apple recognizer: retain draining recognition windows until final
  callbacks settle. Fixed an event/snapshot subscription race in live history.
- HUD Talk starts microphone dictation (including automatic paste), instead of
  a generic capture. Native state transitions are serialized; frame changes
  avoid overlapping animations that could clip the rendered result.
- Kept the existing 1800ms text-polish timeout after review. A shorter 450ms
  experiment was installed locally but was not backed by real service latency
  measurements. Measure polish success rate before reducing this timeout.
- Startup refreshes the runtime and Finder icon from the bundled asset.

## Evidence already obtained

- Rust: 266 passing before final review (additional overlap/lead-in regressions
  added during review; use final CI totals), two intentionally ignored tests; the speech fixture is an
  opt-in integration test. The persistence regression reads the physical registry
  and transcript file, checks the queued edit, and applies later device/cloud
  results. It includes empty corrections.
- Swift: 59 tests passed earlier in this change set; both Apple speech engines
  built. Web build/type checks and transcript unit tests passed during development.
  Consult this PR's final checks for the complete merge validation.
- `desktop/bench/check-hud-preview.mjs`: nine headless UI scenarios passed.
  Covers collapse timing, editing/deleting all text, late results, corrected Copy,
  reload persistence, failed save/retry, a new recording, and slow saves. Its
  Tauri bridge is mocked: this is not proof of installed WebKit-to-native IPC.
- `desktop/bench/check-caption-paste.sh`: real production Apple speech engines
  consumed a synthetic 51-second / 141-word fixture. Production Rust assembled
  all sentences; an isolated native Cocoa text view received the exact full
  string. The newer recognizer made one normalized word substitution; legacy
  recognition made none on this one synthetic sample. This is not a general
  accuracy benchmark or proof of the foreground Cmd-V path.
- A signed local 0.5.3 build was installed and relaunched on the original Mac.
  It is a local update, not a new published release. Signing verification and
  source/installed binary hash comparison passed. No public version bump was
  performed for these changes. That installed build predates final PR review
  hardening; build current main on the dedicated Mac.

## Next: installed-app tests on the dedicated Mac

1. Build/install from current main following the release docs. Verify the running
   executable/version and bundled assets. Configure microphone, speech recognition,
   Accessibility, and Input Monitoring as needed; use that Mac's own credentials.
2. Test real Fn and HUD Talk recordings into a disposable native text document.
   Use multi-sentence speech with distinguishable first, middle and last phrases;
   include pauses, >60-second recordings crossing recognizer windows, rapid
   stop/start, and switching between launcher and HUD while recording.
3. Read back the actual destination text. Confirm every phrase, order, and absence
   of duplicates. Measure stop-to-paste latency. Check target changes/focus loss
   and fallback behavior. Never use a real message recipient as the paste target.
4. Edit an installed HUD preview, including multiline and empty edits. Confirm
   history and `transcript.md`, wait for collapse, reload/restart, and allow cloud
   refinement/sync to finish. Check corrections persist locally and remotely.
   Check Copy and close-during-save, permission/write failures, and retry.
5. Inspect native rendering at different display scales/positions: full lines,
   scrolling, no random disappearance during state transitions, stable launcher
   layout, and collapse after 15 seconds of inactivity. Specifically test a
   caption arriving before the HUD state identifies its session: the HUD filters
   caption events by current session, so verify snapshot reconciliation recovers
   those early words (review F10 in this PR). Evaluate visual quality
   against `desktop/DESIGN.md` with actual screenshots.
6. Check Finder, Dock, and menu-bar icon refresh after upgrade/relaunch. Confirm
   the upgrade preserves shortcuts, permissions, settings and existing recordings.
7. Fix remaining issues, add meaningful regressions, merge via green CI. If a
   public desktop release is wanted, follow `docs/RELEASING.md`; do not reuse the
   old 0.5.3 tag or silently treat the local build as an updater release.

## Reproducible background harnesses

Install web and launcher dependencies with Bun and install Playwright Chromium.
Start `bun run dev --host 127.0.0.1` in `desktop/launcher-ui`, then from repository
root run `node desktop/bench/check-hud-preview.mjs`.

On macOS, run the speech/Cocoa fixture with a valid local signing identity:

```sh
APPLE_SIGNING_IDENTITY='Developer ID Application: YOUR IDENTITY' \
  bash desktop/bench/check-caption-paste.sh
```

The fixture synthesizes an audio file without playing it. It uses a temporary
signed app with the Eavesy bundle identifier to access the authorized recognizer;
run it with the actual app idle. It writes to a unique pasteboard, not the user's
clipboard. Its optional file argument must contain the canonical fixture speech:
the Rust assertions and 50,814ms duration are tailored to that fixture.

Original-machine evidence (not portable to the new Mac):
`/private/tmp/eavesy-installed-qa.json`,
`/private/tmp/eavesy-persistent-preview-verification.json`, and
`/private/tmp/eavesy-preview-persistence-test.log`.
The installed app is `/Applications/Eavesy.app`; rollback is
`/private/tmp/eavesy-before-persistent-preview-htisdpid/Eavesy.app`.
Implementation worktree was `/private/tmp/eavesy-desktop-0-5-3`; the original
`~/Developer/eavesy` checkout has unrelated user changes and was left alone.
