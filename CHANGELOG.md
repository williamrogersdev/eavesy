# Changelog

All notable changes to Eavesy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/) for the macOS app.

## [Unreleased]

### Changed

- Web: the notetaker is now Eavesy's own bot instead of Recall.ai. It joins Google Meet and Teams calls, its transcript fills in live with each participant's name, and the brief lands in your library. Zoom isn't supported yet ([#185](https://github.com/williamrogersdev/eavesy/pull/185), [#186](https://github.com/williamrogersdev/eavesy/pull/186))

## [0.6.3] - 2026-10-22 - desktop

### Fixed

- Mac app: size the capture control before drawing a new phase ([#183](https://github.com/williamrogersdev/eavesy/pull/183))

## [0.6.2] - 2026-10-22 - desktop

### Added

- Mac app: live words show about a second sooner while you talk, with a "Faster live words" switch to turn it off ([#184](https://github.com/williamrogersdev/eavesy/pull/184))
- Web: send a notetaker to a Zoom, Google Meet or Teams call; its transcript, with each participant's name, and the brief land in your library (pilot, needs a Recall.ai key) ([#180](https://github.com/williamrogersdev/eavesy/pull/180))
- Web: opt-in email recaps of finished meetings (TL;DR, decisions, action items, transcript link and optional transcript attachment), sent through Resend with delivery tracking ([#182](https://github.com/williamrogersdev/eavesy/pull/182))

### Fixed

- Mac app: dictation pastes back where you were typing, without the long wait or duplicated text, and drops filler words like "um" and "uh" ([#179](https://github.com/williamrogersdev/eavesy/pull/179))
- Mac app: the "Copied" card no longer stays on screen forever ([#179](https://github.com/williamrogersdev/eavesy/pull/179))
- Mac app: the dictionary stops learning ordinary words, and a silent clip no longer pastes "Thank you" ([#181](https://github.com/williamrogersdev/eavesy/pull/181))

## [0.6.1] - 2026-10-21 - desktop

### Added

- Mac app: warmer Settings window with clearer dictionary, dictation and permissions ([#176](https://github.com/williamrogersdev/eavesy/pull/176))
- Mac app: confirm on the control which word the dictionary learned ([#175](https://github.com/williamrogersdev/eavesy/pull/175))

### Fixed

- Mac app: bring other devices' captures and edits into each Mac ([#174](https://github.com/williamrogersdev/eavesy/pull/174))
- Mac app: prettier result card that closes properly ([#173](https://github.com/williamrogersdev/eavesy/pull/173))

## [0.6.0] - 2026-10-21 - desktop

### Added

- Mac app: tag elements and areas while recording the screen ([#169](https://github.com/williamrogersdev/eavesy/pull/169))
- Mac app: inline translation and dedicated preferences ([#167](https://github.com/williamrogersdev/eavesy/pull/167))

### Fixed

- Mac app: never let a stuck live edit block Stop ([#170](https://github.com/williamrogersdev/eavesy/pull/170))
- Mac app: make transcript editing stable during and after dictation ([#168](https://github.com/williamrogersdev/eavesy/pull/168))

## [0.5.7] - 2026-10-21 - desktop

### Added

- Mac app: cleaner settings, recording preview lines and a see-through control ([#165](https://github.com/williamrogersdev/eavesy/pull/165))
- Mac app: per-project dictation tone and a tabbed settings screen ([#164](https://github.com/williamrogersdev/eavesy/pull/164))

## [0.5.6] - 2026-10-21 - desktop

### Added

- Mac app: dictation tones and formatting for AI agents ([#162](https://github.com/williamrogersdev/eavesy/pull/162))

## [0.5.5] - 2026-10-21 - desktop

### Added

- Mac app: make video walkthroughs usable by AI agents ([#151](https://github.com/williamrogersdev/eavesy/pull/151))

### Changed

- Mac app: streamline startup, search, and transcription ([#153](https://github.com/williamrogersdev/eavesy/pull/153))

### Fixed

- Mac app: finish processing jobs when recovery fails ([#159](https://github.com/williamrogersdev/eavesy/pull/159))
- Mac app: recover worker failures and verify benchmark sources ([#157](https://github.com/williamrogersdev/eavesy/pull/157))
- Mac app: finish walkthrough correction and writer error handling ([#154](https://github.com/williamrogersdev/eavesy/pull/154))
- Mac app: keep complete live lines and settle first-sentence revisions ([#150](https://github.com/williamrogersdev/eavesy/pull/150))

## [0.5.4] - 2026-10-20 - desktop

### Added

- Personal dictionary learns human corrections in transcripts and supported pasted text fields, with review and forget controls in Settings.
- Sentence-aware speech repair uses confirmed spellings and retains original meeting transcription alongside corrections.

## [0.5.3] - 2026-10-20 - desktop

### Added

- Mac app: languages, custom words and projects in Mac Settings; word lists that scale ([#136](https://github.com/williamrogersdev/eavesy/pull/136))

### Fixed

- Mac app: ship on-device speech, keep dictation results on screen, cleaner HUD ([#134](https://github.com/williamrogersdev/eavesy/pull/134))

## [0.5.2] - 2026-10-20 - desktop

### Fixed

- Mac app: updater signature check builds without the bundled frontend ([#128](https://github.com/williamrogersdev/eavesy/pull/128))

## [0.5.1] - 2026-10-20 - desktop

### Added

- Mac app: tidy dictated words before they are typed ([#124](https://github.com/williamrogersdev/eavesy/pull/124))
- Mac app: redesign the HUD as a fixed-size pill with stamped results ([#123](https://github.com/williamrogersdev/eavesy/pull/123))
- Mac app: rebrand to the Little Snoop with a Noir & Coral palette ([#122](https://github.com/williamrogersdev/eavesy/pull/122))

### Fixed

- Mac app: keep the HUD's saved frame at the resting pill and resize in Cocoa ([#125](https://github.com/williamrogersdev/eavesy/pull/125))
- Mac app: dictation pastes everything; live captions use Apple's new speech model ([#112](https://github.com/williamrogersdev/eavesy/pull/112))
- Mac app: updater signature check runs without the Swift sidecar ([#121](https://github.com/williamrogersdev/eavesy/pull/121))
- Mac app: HUD sheet opens below the bar and flashes a copyable preview ([#110](https://github.com/williamrogersdev/eavesy/pull/110))

## [0.5.0] - 2026-10-19 - desktop

### Added

- Mac app: stop macOS opening stray older copies of Eavesy ([#118](https://github.com/williamrogersdev/eavesy/pull/118))
- Mac app: report launches, updates and recording starts to PostHog ([#115](https://github.com/williamrogersdev/eavesy/pull/115))
- Mac app: add Capture, View, Window and Help menus ([#109](https://github.com/williamrogersdev/eavesy/pull/109))
- Mac app: live captions follow the spoken language ([#108](https://github.com/williamrogersdev/eavesy/pull/108))
- Mac app: projects and agent-ready transcripts ([#104](https://github.com/williamrogersdev/eavesy/pull/104))
- Mac app: custom vocabulary for transcription ([#97](https://github.com/williamrogersdev/eavesy/pull/97))
- Mac app: replace Sentry with PostHog analytics and error tracking ([#102](https://github.com/williamrogersdev/eavesy/pull/102))

### Fixed

- Mac app: caption language hints never wait, switches outlive a failed start ([#113](https://github.com/williamrogersdev/eavesy/pull/113))
- Mac app: move Eavesy into Applications instead of failing updates from the disk image ([#107](https://github.com/williamrogersdev/eavesy/pull/107))
- Mac app: harden caption language switching ([#111](https://github.com/williamrogersdev/eavesy/pull/111))
- Mac app: make Sentry optional for release builds ([#99](https://github.com/williamrogersdev/eavesy/pull/99))

## [0.4.0] - 2026-10-19 - desktop

### Added

- Mac app: a quiet sound when the mic goes live and when it stops (Settings →
  Sounds), and a strip under the recording bar that shows your words as they
  are heard. ([#94](https://github.com/williamrogersdev/eavesy/pull/94))
- Mac app: a "Bottom center" spot for the recording bar; low on the screen its
  transcript opens upward. ([#94](https://github.com/williamrogersdev/eavesy/pull/94))
- Mac app: a spoken-language setting (Settings → Transcription) with automatic
  detection. ([#95](https://github.com/williamrogersdev/eavesy/pull/95))
- Mac app: click a screenshot to see it full size.
  ([#93](https://github.com/williamrogersdev/eavesy/pull/93))
- Mac app: meetings recorded on your other Macs show up in History.
  ([#96](https://github.com/williamrogersdev/eavesy/pull/96))

### Changed

- Mac app: the recording bar says "Starting…" until the mic is really on, then
  turns red, and "Writing it down…" the moment you stop. While recording the
  panel's toolbar becomes the one live bar with Stop.
  ([#94](https://github.com/williamrogersdev/eavesy/pull/94))
- Mac app: dictation pastes into the app you were in even when it hides its
  text box from Accessibility (browsers, Slack, Notion, VS Code); the words
  also stay on the clipboard then. ([#94](https://github.com/williamrogersdev/eavesy/pull/94))
- Mac app: the setup's "Try it" step puts your dictation in its practice box.
  ([#94](https://github.com/williamrogersdev/eavesy/pull/94))
- Mac app: macOS screenshots are added to History by default, shown whole, at
  full Retina size. ([#93](https://github.com/williamrogersdev/eavesy/pull/93))

### Fixed

- Mac app: a tap while the mic is opening stops the recording instead of being
  lost. ([#94](https://github.com/williamrogersdev/eavesy/pull/94))
- Mac app: fewer invented words on silence, no repetition loops, and live
  captions on older macOS no longer cut words in half.
  ([#95](https://github.com/williamrogersdev/eavesy/pull/95))

## [0.3.0] - 2026-10-18 - desktop

### Added

- Mac app: a new look. Warm light and dark themes, a small mascot that shows
  when Eavesy is listening, a new app and menu bar icon, and a design system in
  [desktop/DESIGN.md](desktop/DESIGN.md).
  ([#76](https://github.com/williamrogersdev/eavesy/pull/76),
  [#77](https://github.com/williamrogersdev/eavesy/pull/77))
- Mac app: a redesigned panel. One row of Talk, Meeting, Screenshot and Video
  buttons; search, filters and day groups in History; an account menu; delete
  for captures; and a composer at the bottom for typed notes, pastes and
  dropped files. macOS screenshots can be added to History automatically.
  ([#77](https://github.com/williamrogersdev/eavesy/pull/77))
- Mac app: guided first-run setup that covers every permission (Microphone,
  Speech Recognition, Accessibility, Input Monitoring, Notifications, Screen
  Recording) and the shortcuts, and can be run again from Settings.
  ([#78](https://github.com/williamrogersdev/eavesy/pull/78),
  [#79](https://github.com/williamrogersdev/eavesy/pull/79),
  [#81](https://github.com/williamrogersdev/eavesy/pull/81))
- Mac app: a real app menu with About and Check for Updates…, also in the menu
  bar icon's menu. ([#73](https://github.com/williamrogersdev/eavesy/pull/73))
- Mac app: an Update button at the top right of the panel whenever a newer
  version is ready; one click installs it and relaunches. Eavesy checks every
  two hours.
- Mac app: a running transcript under the recording bar while you dictate.
  ([#74](https://github.com/williamrogersdev/eavesy/pull/74))

### Changed

- Mac app: dictation pastes at your cursor as soon as you stop, and runs only
  in the recording bar instead of switching the panel to a recording screen.
  Without Accessibility, the text is copied to the clipboard and Eavesy says so.
  ([#74](https://github.com/williamrogersdev/eavesy/pull/74))
- Mac app: shortcut settings can record, clear, reset and swap each shortcut,
  explain conflicts inline, and guide Fn/Globe setup.
  ([#80](https://github.com/williamrogersdev/eavesy/pull/80))
- Mac app: final transcripts arrive sooner, since the transcript no longer waits
  for the summary and the app checks for results more often after you stop.
  ([#72](https://github.com/williamrogersdev/eavesy/pull/72))
- Mac app: a recording has a transcript the moment you stop it. The on-device
  captions taken while recording fill History right away, and the cloud
  transcript replaces them when it is ready. Every recording (voice note,
  meeting, screen) now pastes its transcript as plain text into the text box
  your cursor is in when you stop.
  ([#63](https://github.com/williamrogersdev/eavesy/pull/63))

### Fixed

- Mac app: an empty cloud result no longer wipes the words heard on the Mac,
  which showed as "No speech detected", and quiet or short dictations are no
  longer dropped. ([#72](https://github.com/williamrogersdev/eavesy/pull/72))
- Mac app: the panel moves out of the way of macOS permission prompts so
  "Allow" can be clicked. ([#73](https://github.com/williamrogersdev/eavesy/pull/73))
- Mac app: dictation catches its first words. A spare capture engine is kept
  ready without the mic being live, so recording starts about 100 ms sooner
  after the shortcut. ([#86](https://github.com/williamrogersdev/eavesy/pull/86),
  [#87](https://github.com/williamrogersdev/eavesy/pull/87))

## [0.2.0] - 2026-10-15 - desktop

### Added

- Mac app: live captions in the HUD and launcher while you record, replaced by
  the cloud transcript as each segment is processed.
  ([#48](https://github.com/williamrogersdev/eavesy/pull/48))
- Mac app: dictation fast path using on-device Apple Speech.
  ([#46](https://github.com/williamrogersdev/eavesy/pull/46))
- Contribution front doors: a Code of Conduct (Contributor Covenant 2.1), issue
  forms for bugs and feature requests, a pull request template, CODEOWNERS, and
  a public roadmap in [ROADMAP.md](ROADMAP.md).

### Changed

- Mac app: one-minute recording segments, with rolling notes on a timer.
  ([#43](https://github.com/williamrogersdev/eavesy/pull/43))
- Mac app: live segments upload first, and sync wakes when new work arrives.
  ([#25](https://github.com/williamrogersdev/eavesy/pull/25))
- Merges to `main` deploy to production from GitHub Actions.
- Mac releases run from GitHub Actions: a `desktop-vX.Y.Z` tag builds, notarizes
  and drafts a GitHub Release, and an approved publish job updates R2, the
  updater and the Homebrew cask. See [docs/RELEASING.md](docs/RELEASING.md).

### Fixed

- Mac app: failed stops are recovered within the session, and sync pauses on a
  401 instead of retrying. ([#24](https://github.com/williamrogersdev/eavesy/pull/24))
- Mac app: the device token is kept off the command line, and the launcher has
  a Content Security Policy. ([#30](https://github.com/williamrogersdev/eavesy/pull/30))
- Mac app: recording continues when a single audio segment fails to finalize.
  Before, the failure stopped the recorder mid-meeting before `audio.m4a` was
  written. Failed stops now show in the HUD instead of leaving it frozen, and a
  stop that times out reports an error rather than a zero-length success.
  ([#4](https://github.com/williamrogersdev/eavesy/pull/4))
- Web: fewer duplicate API fetches and D1 round trips. API timing is measured
  so regressions show up in the perf tests.
  ([#1](https://github.com/williamrogersdev/eavesy/pull/1))

## [0.1.9] - desktop

Released before this changelog was started. See the
[GitHub releases](https://github.com/williamrogersdev/eavesy/releases) for
earlier notes.
