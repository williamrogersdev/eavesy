# Building and distributing Eavesy for macOS

This produces a signed, hardened-runtime, notarized application and DMG for
distribution outside the Mac App Store.

## Prerequisites

- macOS 13 or later with Xcode Command Line Tools
- Bun and the stable Rust toolchain
- An Apple Developer membership
- A Developer ID Application certificate in the login keychain
- The Apple Team ID and an Apple app-specific password for notarization

`desktop/scripts/prebuild.sh` builds the offline launcher UI and the release
Swift capture sidecar. Tauri embeds and signs both. The web dashboard is not
embedded and does not need to be built for the desktop artifact.

## Validate an unsigned local build

```bash
cd desktop
./scripts/prebuild.sh
cd src-tauri
cargo check
bunx @tauri-apps/cli build --debug --no-bundle
```

Open the resulting app bundle for the real capture smoke test. macOS privacy
permission behavior cannot be proven by invoking the helper from a terminal.

## Signing and notarization

For a repeatable candidate build, use the manually triggered
`macOS release candidate` GitHub workflow. It verifies the web/Worker/Desktop
code, imports the protected Developer ID certificate, builds and notarizes, and
uploads the DMG plus updater artifacts for acceptance testing. It never
publishes to R2. Required GitHub environment secrets are listed in
[`docs/OPERATIONS.md`](../docs/OPERATIONS.md).

Export the signing identity in the shell running Tauri. Never commit it:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (AB12CD34EF)"
```

On a local release workstation, Apple notarization credentials do not need to
be present during the build. The wrapper produces a Developer ID-signed DMG,
and `release-macos.sh` submits it using the Keychain profile described below.
Direct Tauri builds may instead provide one complete supported credential set
for automatic app notarization: `APPLE_ID` + `APPLE_PASSWORD` +
`APPLE_TEAM_ID`, or `APPLE_API_ISSUER` + `APPLE_API_KEY` +
`APPLE_API_KEY_PATH`. Partial or mixed sets are rejected before compilation.
The final DMG still goes through `release-macos.sh`.

The app has **two** ingest paths, and both use the paired device credential:

- **Long-form recording** (`/api/sessions/*`) uses browser-assisted device
  pairing and a Keychain token.
- **Short recordings and dictation** (`/api/transcribe`) present that same
  revocable per-device token. The server also accepts an authenticated Clerk
  session for first-party web callers.

No shared API secret is compiled into the app. A Mac that has not been paired
still saves captured media locally, but transcription asks the user to pair
before making a network request.

`SENTRY_DSN` is required for `build-macos-release.sh`, which fails without it
(self-hosted builds can opt out with `EAVESY_ALLOW_NO_SENTRY=1`). It enables
panic and operational error reporting: events keep the failing operation and
error text, with recording, home, `/Volumes` and `/private` paths replaced
by placeholders (folder names are meeting titles) and tokens, keys, emails and
IPs removed. Audio, transcripts and notes are never attached. See
[../docs/OBSERVABILITY.md](../docs/OBSERVABILITY.md).

App logs rotate daily in `~/Library/Logs/com.eavesy.desktop` (seven files
kept); **Copy Diagnostics** in the menu bar menu copies a scrubbed tail of
that log and the capture engine's `capture.log`.

It also needs the **updater signing key**, or `tauri build` emits no updater
artifacts and `release-macos.sh --publish` refuses to publish (a build that
can't self-update is permanent for whoever installs it — there's no store to
recall it through):

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/eavesy-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

The matching public key is compiled in via `plugins.updater.pubkey` in
`tauri.conf.json`. **Keep the private key.** Lose it and no already-installed
copy will ever accept another update — they verify against the baked-in pubkey,
so a new keypair orphans every existing install. Regenerate only if it leaks
(`bunx tauri signer generate -w <path>`), and expect to tell users to
re-download by hand.

Build locally through the release wrapper. It validates required inputs,
limits Tauri's app/updater build to 20 minutes by default, confirms that its
outputs are fresh and correctly signed, and creates the DMG noninteractively.
It intentionally requests Tauri's `app` bundle only, which still produces the
configured updater archive but bypasses the unreliable Finder/AppleScript DMG
layout helper. The resulting DMG contains `Eavesy.app` and an Applications
shortcut. Override the build bound with `EAVESY_BUILD_TIMEOUT_SECONDS` when
compilation or automatic Tauri notarization is unusually slow:

```bash
desktop/scripts/build-macos-release.sh
```

Candidate creation is transactional: the wrapper removes old outputs when a
new build starts and deletes partial outputs after a failure or interruption.
It also sets an incomplete-build guard before validating environment variables,
so `release-macos.sh` cannot accidentally notarize an older artifact after even
an early setup error.

Before accepting the candidate, the wrapper also verifies the updater archive's
Minisign signature against the exact public key compiled into `tauri.conf.json`.
The publish script repeats this cryptographic check before its first remote
write. This prevents an unsigned, corrupted, or wrong-key updater from being
offered to installed copies.

Store the local notarization credential in the login Keychain once instead of
exposing the app-specific password to builds or scripts:

```bash
xcrun notarytool store-credentials "eavesy-notary" \
  --apple-id "you@example.com" \
  --team-id "AB12CD34EF" \
  --password "app-specific-password"
desktop/scripts/release-macos.sh
```

The release script verifies the disk image, submits and staples it when needed,
mounts it for a Gatekeeper check, and stops before publication. Rerun it with
`--publish` only after the installed-app acceptance test passes. Publication
uploads to R2 and verifies that the public download has the same SHA-256.

Artifacts are written below:

```text
desktop/src-tauri/target/release/bundle/macos/Eavesy.app
desktop/src-tauri/target/release/bundle/dmg/Eavesy_<version>_aarch64.dmg
```

The name changes for Intel or universal targets.

## Verify the artifact

```bash
APP="desktop/src-tauri/target/release/bundle/macos/Eavesy.app"
DMG="desktop/src-tauri/target/release/bundle/dmg/Eavesy_0.1.0_aarch64.dmg"

codesign --verify --deep --strict "$APP"
codesign -dvvv --entitlements - "$APP"
codesign --verify "$DMG"
xcrun stapler validate "$DMG"
```

Run `hdiutil verify` before the final DMG signature. On this APFS image format,
verification can invalidate the outer container signature; the release script
always reapplies and verifies that signature before sending the image to Apple.

After mounting the notarized DMG, run `spctl -a -vvv -t install` against the app
copied from it. Expected results are Gatekeeper `accepted`, a valid DMG staple,
hardened-runtime flags, and the permissions declared in `entitlements.plist`.

## Publish

```bash
desktop/scripts/release-macos.sh --publish
```

Verify `https://eavesy.com/download/mac` from a clean browser. Keep the exact
DMG used for the smoke test so the published bytes are the tested artifact.

## First-run acceptance test

1. Install from the DMG and launch Eavesy.
2. Grant Microphone and Screen Recording when macOS prompts.
3. Pair the device through the signed-in browser flow and restart the app.
4. Record for at least ten minutes to force multiple segments.
5. Briefly disable the network, then restore it and stop.
6. Confirm the cloud meeting and local `audio.m4a`, `transcript.md`, and
   `summary.md` files.
7. Put the Mac to sleep during a second recording and verify capture resumes
   without losing already sealed segments.
