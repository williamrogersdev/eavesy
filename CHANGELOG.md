# Changelog

All notable changes to Eavesy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/) for the macOS app.

## [Unreleased]

## [0.9.3] - 2026-10-28 - desktop

### Added

- Mac app: spell dictionary words with a second on-device recognizer ([#290](https://github.com/williamrogersdev/eavesy/pull/290))

## [0.9.2] - 2026-10-27 - desktop

### Fixed

- Mac app: spell dictionary words on the Mac when polishing can't answer ([#288](https://github.com/williamrogersdev/eavesy/pull/288))
- Mac app: learn fixes made in any text field, not just some ([#287](https://github.com/williamrogersdev/eavesy/pull/287))

## [0.9.1] - 2026-10-27 - desktop

### Added

- Mac app: keep the dictation drawer open longer, and translate from it ([#281](https://github.com/williamrogersdev/eavesy/pull/281))
- Mac app: add Eavesy to Claude Code and sign in from Settings ([#278](https://github.com/williamrogersdev/eavesy/pull/278))
- Mac app: Connections as an apps list, with one-click Google Calendar ([#279](https://github.com/williamrogersdev/eavesy/pull/279))

### Fixed

- Mac app: dictations lose their "like"s and misheard words again ([#282](https://github.com/williamrogersdev/eavesy/pull/282))

## [0.9.0] - 2026-10-26 - desktop

### Added

- Mac app: security checkup with security_status and security_fix ([#272](https://github.com/williamrogersdev/eavesy/pull/272))
- Mac app: drop the JIT and unsigned-memory entitlements ([#269](https://github.com/williamrogersdev/eavesy/pull/269))
- Mac app: cancel a recording without saving it ([#265](https://github.com/williamrogersdev/eavesy/pull/265))
- Mac app: phase 0 hardening — trusted capture engine, private socket folder, pinned update key, cargo audit ([#264](https://github.com/williamrogersdev/eavesy/pull/264))
- Mac app: calmer This Mac with one clean-up action, and a way in from the menus ([#260](https://github.com/williamrogersdev/eavesy/pull/260))
- Mac app: calmer Settings design and a way back to Eavesy ([#263](https://github.com/williamrogersdev/eavesy/pull/263))
- Mac app: Connections page and search in Settings ([#258](https://github.com/williamrogersdev/eavesy/pull/258))

### Fixed

- Mac app: security_fix says "already set", not "already on" ([#275](https://github.com/williamrogersdev/eavesy/pull/275))
- Mac app: a setting that couldn't be read isn't reported as already on ([#274](https://github.com/williamrogersdev/eavesy/pull/274))
- Mac app: turning off automatic login always asks and always clears the password ([#273](https://github.com/williamrogersdev/eavesy/pull/273))
- Mac app: refuse the capture engine when Eavesy can't read its own signature ([#266](https://github.com/williamrogersdev/eavesy/pull/266))

## [0.8.0] - 2026-10-26 - desktop

### Added

- Mac app: fn+key shortcuts, warn when another app holds a shortcut, move Talk to Eavesy off ⌥Space ([#254](https://github.com/williamrogersdev/eavesy/pull/254))
- Mac app: turn This Mac's worktrees into a fast manager ([#251](https://github.com/williamrogersdev/eavesy/pull/251))

### Fixed

- Mac app: keep talking to Eavesy after its first answer ([#252](https://github.com/williamrogersdev/eavesy/pull/252))
- Mac app: paste into the frontmost app when its focus can't be read ([#250](https://github.com/williamrogersdev/eavesy/pull/250))
- Mac app: give gh's PR list longer to arrive after a clean exit ([#255](https://github.com/williamrogersdev/eavesy/pull/255))
- Mac app: worktree sizes survive a filter change, and gh can't hang the PR lookup ([#253](https://github.com/williamrogersdev/eavesy/pull/253))
- Mac app: plainer Projects and Prompts copy, and drop Settings' brown palette ([#249](https://github.com/williamrogersdev/eavesy/pull/249))

## [0.7.1] - 2026-10-25 - desktop

### Added

- Mac app: centre the panel's title, move the project chip, and make search an icon ([#247](https://github.com/williamrogersdev/eavesy/pull/247))

## [0.7.0] - 2026-10-25 - desktop

### Fixed

- Web: pausing or ending the Workers AI credit pilot no longer takes semantic search, translation and transcript repair down with it; only imports and library answers run on the pilot's credits, and a meeting that could not be indexed is now reported instead of silently missing from search ([#213](https://github.com/williamrogersdev/eavesy/pull/213))
- Web: regenerating a brief now names each speaker and uses the project's context, the way the first brief does, and a regenerated meeting is re-indexed for search; a failed meeting you regenerate no longer stays missing from search and the library ([#214](https://github.com/williamrogersdev/eavesy/pull/214))
- Web: editing a transcript line or renaming a speaker now updates search within a few minutes, and a meeting whose lines were all deleted is no longer found by its old words ([#216](https://github.com/williamrogersdev/eavesy/pull/216))
- Notetaker: a bot from the retired Recall.ai service no longer sits "in progress" forever and counts toward your active-bot limit, and a meeting whose bot lost part of the audio now says its transcript has gaps ([#217](https://github.com/williamrogersdev/eavesy/pull/217))
- Mac app sync: an interrupted screenshot upload no longer uses up part of the daily sync allowance ([#218](https://github.com/williamrogersdev/eavesy/pull/218))
- MCP: library answers and searches from an AI client now count toward the same daily limits as the web app ([#218](https://github.com/williamrogersdev/eavesy/pull/218))
- Mac app: the "signed out" notice no longer replaces a dictation you are reading or editing; it shows as a system notification instead ([#219](https://github.com/williamrogersdev/eavesy/pull/219))
- Web: an import abandoned mid-upload is stopped after a day and can be resumed by selecting the file again, and a cancelled import's audio is deleted after a week ([#220](https://github.com/williamrogersdev/eavesy/pull/220))

## [0.6.7] - 2026-10-23 - desktop

### Fixed

- Mac app: a dictation you dismissed no longer pops back open stamped "Pasted" when its cloud transcript arrives; only a dictation still writing its words down moves on, and one with nothing to paste into says "Saved. The words are in History" ([#205](https://github.com/williamrogersdev/eavesy/pull/205))
- Mac app: an error during a recording no longer replaces the control. Stop, Copy, the tone row and the timer stay, the error shows in the status line, and a failed recording collapses on its own like a finished one ([#205](https://github.com/williamrogersdev/eavesy/pull/205))
- Mac app: settings can no longer be lost, or the Mac signed out, by two writes to the settings file racing; a damaged file is kept aside instead of being replaced ([#205](https://github.com/williamrogersdev/eavesy/pull/205))
- Mac app: the panel stops re-drawing every row once a second during a recording, the empty-state mascot no longer flashes before the first page loads, and a denied Screen Recording or Microphone permission shows a banner with an "Open settings" button instead of swapping the whole panel ([#205](https://github.com/williamrogersdev/eavesy/pull/205))
- Mac app: the control stays where you parked it between recordings, the keyboard goes back to the app you were in after editing in the drawer, a slow paste no longer lands minutes later in whatever field has focus, and Copy no longer gets undone by the clipboard restore ([#205](https://github.com/williamrogersdev/eavesy/pull/205))
- Mac app: pressing Stop twice no longer drops the control back to idle while the first stop is still delivering its words, and the "Recording not fully saved" notice says what to do instead of showing engine output ([#206](https://github.com/williamrogersdev/eavesy/pull/206))
- Mac app: sync keeps going when one note edit keeps failing, screenshot uploads no longer hold up everything else, and a damaged sync-state file no longer breaks sync or deletes ([#205](https://github.com/williamrogersdev/eavesy/pull/205))

## [0.6.6] - 2026-10-23 - desktop

### Changed

- Mac app: a finished dictation opens with its words again, editable, with Copy and the tone row, instead of only a "Pasted" stamp. Settings → Recording appearance → "Show the words when it's done" turns it off ([#201](https://github.com/williamrogersdev/eavesy/pull/201))
- Mac app: live words while recording are now off by default, so the control is just the small bar; anyone who already picked a line count keeps it. When on, they are in a quieter ink ([#201](https://github.com/williamrogersdev/eavesy/pull/201))

### Fixed

- Mac app: dictation pastes at your cursor again in Claude, ChatGPT, Slack, Chrome and other web-based apps, instead of falling back to "Copied ⌘V to paste". It pastes whenever the app you started in is still in front ([#202](https://github.com/williamrogersdev/eavesy/pull/202))

## [0.6.5] - 2026-10-22 - desktop

### Added

- Saved prompts: keep the requests you type over and over in Settings → Prompts, paste one from the panel's search with Return, or run it in Claude Code as `/mcp__eavesy__<name>` ([#199](https://github.com/williamrogersdev/eavesy/pull/199))

### Changed

- Web: a Notetaker docs page, and the docs and site now say "no bot" applies to recording from your Mac. Up to 200 notetakers can be in calls at once across all accounts, and a start that finds no room is retried for up to about four minutes before it fails ([#196](https://github.com/williamrogersdev/eavesy/pull/196))

## [0.6.4] - 2026-10-22 - desktop

### Added

- Mac app: screenshots and pasted images now sync between your Macs. A picture taken on one Mac shows up in the others' history, labelled with the device it came from; deleting it on one Mac keeps it deleted there ([#192](https://github.com/williamrogersdev/eavesy/pull/192))
- Mac app: change a dictation's tone (Professional, Friendly, Concise or For agents) right from the dictation drawer ([#193](https://github.com/williamrogersdev/eavesy/pull/193))
- Mac app: rewrite any capture's tone from the history ([#194](https://github.com/williamrogersdev/eavesy/pull/194))

### Changed

- Mac app: a finished dictation ends quietly on the pill with a "Pasted · N words" stamp instead of the result card ([#191](https://github.com/williamrogersdev/eavesy/pull/191))
- Mac app: a calmer capture history: the words are the row, filters live in a Show pop-up inside search, and screenshot thumbnails keep their own shape ([#194](https://github.com/williamrogersdev/eavesy/pull/194))
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
