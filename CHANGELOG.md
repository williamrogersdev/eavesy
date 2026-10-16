# Changelog

All notable changes to Eavesy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/) for the macOS app.

## [Unreleased]

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
