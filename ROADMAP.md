# Roadmap

This is the order we expect to work in. It changes as we learn, so treat it as
direction rather than dates. If something here matters to you, say so on an
issue or in [Discussions](https://github.com/williamrogersdev/eavesy/discussions).

**Today**, Eavesy ships as a Mac app for recording and dictation, a web app
with a browser recorder, a hosted MCP server, and Markdown export of sessions.

**Where it's heading** is an AI-first local assistant: drop in messages, text,
instructions, and screenshots, and get context that's quick to paste into an AI
agent. Meeting recording is one of the inputs, and an important one, but not the
whole product. The phases below move toward that.

## Phases

### 1. Stop losing recordings (done)

Long recordings survive failures. Segments are persisted locally before upload,
a failed segment no longer stops the recorder, and failed stops are visible in
the HUD. See the Unreleased section of the [CHANGELOG](CHANGELOG.md).

### 2. See what breaks

Errors, slow requests, and failed uploads should be visible to us before a user
reports them. This covers error tracking, the observability dashboards in
[docs/OPERATIONS.md](docs/OPERATIONS.md), and making the Mac app's logs easy to
find and attach to an issue.

### 3. Clean house

Remove code and dependencies that no longer earn their place, tighten lint and
type checks, and keep the test suite fast. A smaller codebase is easier to
contribute to, so this comes before we open the doors wider.

### 4. Open the doors (in progress)

Outside contributors can find work, report problems, and get a review:
contribution guidelines, issue and pull request templates, CODEOWNERS, a
Code of Conduct, Discussions, labels, and a set of small starter issues marked
`good first issue`.

### 5. Live transcription

Show captions as you speak. The plan is on-device Apple Speech for live
captions, with the cloud Whisper pass replacing them once a segment is
processed, so the final transcript stays the one you keep.

### 6. Harden for scale

Load and abuse testing, rate limits and quotas that hold up under real traffic,
queue and processing backpressure, and documented recovery steps for each
service. The aim is that growth doesn't require heroics.

### 7. Keep your Mac safe

The Mac app gains a Security section: a checkup of your setup (FileVault,
firewall, updates, screen lock, sharing), who can use your camera, mic and
screen, alerts when something new starts at login or changes your network
settings, secrets left in plain text, and help when something looks wrong.
Everything runs locally, is event-driven so it doesn't slow the Mac or the
AI features down, and never changes a setting without your click. The plan
is in [docs/plans/device-security.md](docs/plans/device-security.md).

Ideas that aren't on this list yet belong in
[Discussions](https://github.com/williamrogersdev/eavesy/discussions/categories/ideas).
