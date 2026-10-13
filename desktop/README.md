# Eavesy Desktop

The macOS long-form recorder is a Tauri 2 launcher backed by a Rust core and a
Swift capture sidecar.

## Responsibilities

- `launcher-ui/`: offline Vite UI bundled into the application.
- `swift-audio/`: ScreenCaptureKit + AVAudioEngine capture, rolling AAC/M4A
  segments, full-session archive, sleep/wake recovery, atomic manifests.
- `src-tauri/src/audio.rs`: sidecar lifecycle and event bridge.
- `src-tauri/src/sqlite.rs`: local sessions, segments, retries, and recovery.
- `src-tauri/src/sync.rs`: device pairing, idempotent cloud sessions, uploads,
  multipart transfer, finalization, result polling, and Markdown output.
- `src-tauri/src/settings.rs`: local preferences and Keychain-backed device
  credential access.

Completed recordings live under `~/Eavesy/Recordings/<meeting>/` with
`audio.m4a`, `transcript.md`, and `summary.md`. Pending segment manifests allow
the app to recover after a crash before or during upload.

## Development checks

```bash
cd swift-audio
swift build -c release

cd ../src-tauri
cargo check

cd ..
./scripts/prebuild.sh
cd src-tauri
bunx @tauri-apps/cli build --debug --no-bundle
```

Run the packaged app—not the sidecar directly—to verify microphone and screen
recording, because macOS grants capture permissions to the app bundle. Pair it
from the launcher, record for at least ten minutes, interrupt the network once,
and confirm all three completed files plus the cloud meeting.

For signed distribution, see [BUILD.md](BUILD.md).
