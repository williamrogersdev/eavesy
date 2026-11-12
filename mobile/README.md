# Eavesy for iPhone

Open it and capture: a voice note, a typed note, a picture or a screenshot.
Everything is written to the phone first and then synced to your account, so
it shows up on your Mac and at eavesy.com, and what you saved there shows up
here.

| Path | What it is |
|---|---|
| `EavesyKit/` | Swift package: API client, offline outbox, sync engine. No UIKit, so `swift test` runs on a Mac. |
| `Eavesy/` | The SwiftUI app: capture pad, library, recorder, shortcuts. |
| `EavesyShare/` | Share extension ("Save to Eavesy" in the share sheet). |
| `Config/` | Info.plists and entitlements. |
| `Eavesy.xcodeproj` | The project. Both source folders are synchronized, so new files need no project edit. |

## How it works

- **Sign-in** is the Mac app's browser pairing (`docs/ARCHITECTURE.md` →
  Authentication) with `platform: "ios"`. The device token lives in the
  Keychain. Signed out, captures stay on the phone and go up after sign-in.
- **Outbox.** Each capture is a folder under Application Support/Outbox with
  an `item.json` and its files, written atomically before any upload.
  `SyncEngine` sends them oldest first; every step is idempotent (the item's
  UUID is the server's `clientSessionId` / `x-client-capture-id`). Network
  errors back off from 2 s to 5 minutes; a 4xx other than 408/425/429 marks
  the item failed and keeps it on the phone.
- **Recording.** `Recorder` writes mono AAC segments of about a minute (cut at
  the first quiet moment after 60 s, 90 s at most) and uploads sealed
  segments while it is still recording, through `/api/sessions` exactly as
  the Mac does, then finalizes with `?archive=none`. It keeps recording with
  the screen locked (`UIBackgroundModes: audio`).
- **Notes and images** go to `/api/devices/captures`.
- **Library.** `/api/sessions?all=1` and `/api/devices/captures?all=1`, merged
  with the outbox, cached for offline, refreshed on launch, on pull, and when
  the live socket (`/api/devices/live`) says another device saved something.
- **Screenshots.** iOS doesn't let an app capture other apps' screens. The
  Screenshot button opens your recent screenshots to pick from, and the share
  extension takes one straight from the screenshot preview. Shared items wait
  in the app group's inbox until the app next opens.
- **Fast ways in.** Home Screen quick actions, App Intents (Action button,
  Control Center, Shortcuts, Siri), and `eavesy://note|photo|screenshot`
  links. A link never starts a recording: any page or app can open one.

## Build and run

```bash
cd mobile/EavesyKit && swift test
```

```bash
xcodebuild -project mobile/Eavesy.xcodeproj -scheme Eavesy -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Or open `mobile/Eavesy.xcodeproj` in Xcode (16 or later) and run. For a real
iPhone, pick your team under Signing & Capabilities for both targets; the App
Group `group.com.eavesy.mobile` must exist in that team.

Against a local server (`EAVESY_LOCAL_TEST=1 bun run dev -- --port 4173` in
`web/`), launch a debug build with `-apiBase http://localhost:4173`. Local
mode has no Clerk for the in-app browser to sign in with, so pair with curl
(`/api/devices/pair/start`, approve with the `eavesy_local_test=1` cookie,
`/api/devices/pair/status`) and pass the token as `-deviceToken <token>`.
Both arguments are read by debug builds only.

## Not built yet

- App Store / TestFlight release (signing team, CI archive).
- The share extension uploading by itself, without opening the app.
- Editing or deleting synced items, audio playback, search, the Drop inbox.
- Live captions while recording; Android.
