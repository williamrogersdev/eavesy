# Roadmap

This is where Eavesy is headed, in rough order. It changes as we learn, so
treat dates as absent on purpose. Work in progress and upcoming items live on
the [project board](https://github.com/williamrogersdev/eavesy/projects). If
something here matters to you, say so on an issue or in
[Discussions](https://github.com/williamrogersdev/eavesy/discussions).

Eavesy's core is an AI-first local assistant: drop in messages, text,
instructions, and screenshots, and get context that's quick to paste into an AI
agent. Meeting recording is one of the inputs, and it's an important one, but
it isn't the whole product.

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

### 4. Open the doors

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

Ideas that aren't on this list yet belong in
[Discussions](https://github.com/williamrogersdev/eavesy/discussions/categories/ideas).
