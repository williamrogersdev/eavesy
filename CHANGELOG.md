# Changelog

All notable changes to Eavesy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/) for the macOS app.

## [Unreleased]

### Added

- Contribution front doors: a Code of Conduct (Contributor Covenant 2.1), issue
  forms for bugs and feature requests, a pull request template, CODEOWNERS, and
  a public roadmap in [ROADMAP.md](ROADMAP.md).

### Changed

- Merges to `main` deploy to production from GitHub Actions.

### Fixed

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
