# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
[Report a vulnerability](https://github.com/williamrogersdev/eavesy/security/advisories/new).
Don't open a public issue or pull request for them.

Include what you found, how to reproduce it, and what an attacker could do
with it. You'll get an acknowledgement within a few days, and a fix or a plan
once it has been triaged. If you'd like to be credited in the advisory, say so.

## Scope

In scope:

- The web app and API (`web/`), the processing and MCP workers (`workers/`).
- The macOS app (`desktop/`), including device pairing and the update channel.
- The hosted service at eavesy.com.

Please don't run automated scanners against eavesy.com, access other users'
data, or degrade the service while testing. A local or self-hosted deployment
is the right place for anything intrusive.

## Supported versions

Fixes go into `main` and the latest macOS release. Older desktop builds pick
them up through the in-app updater.

## How the Mac app is locked down

Some of the Mac app's choices look loose from the outside. Each one is
deliberate.

- **Not sandboxed.** The "This Mac" clean-up reads other processes (their
  working folder, ports and parent) to find leftovers, which the App Sandbox
  forbids. Every read is limited to processes owned by the signed-in user.
  The app does use the hardened runtime and is notarized.
- **Entitlements** (`desktop/src-tauri/entitlements.plist`):
  - `device.audio-input` and screen capture: recording is the product.
  - `automation.apple-events`: pasting a transcript into the app you're
    using.
  - `network.client`: talking to eavesy.com and the updater.
  - `files.user-selected.read-write`: exports and imports you pick.
  - `cs.allow-jit` and `cs.allow-unsigned-executable-memory`: the web view's
    JavaScript engine. Apple's guidance is that WKWebView needs JIT on Apple
    silicon. Both are under test: the release workflow can build a signed
    candidate without them and launch it, and either one is dropped once a
    candidate runs without it.
- **Private API** (`macOSPrivateApi`): only for transparent windows (the
  recording HUD and assistant cards). Tauri needs it for window transparency
  on macOS.
- **Capture engine.** The app runs the `SwiftAudio` sidecar only if it is
  signed by the same Apple team as the app itself, so a replaced binary never
  runs.
- **Local agent socket.** It lives in a folder only you can open (mode 0700,
  owned by you; the app refuses to listen otherwise), and it only accepts
  connections from your own user.
- **Updates** are signed. The update key is pinned in `tauri.conf.json`, and
  a test fails if it changes, so changing it is always a deliberate commit.
- **Dependencies.** CI runs `cargo audit` on the app's Rust crates. Each
  ignored advisory, with why it can't reach the Mac app, is in
  `desktop/src-tauri/.cargo/audit.toml`.
