# Changelog

All notable changes to Eavesy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/) for the macOS app.

## [Unreleased]

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
