#!/usr/bin/env bash
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ Building launcher UI → frontend-shell"
cd "$DESKTOP/launcher-ui"
bun install
bun run build

echo "▸ Building SwiftAudio capture engine"
cd "$DESKTOP/swift-audio"
swift build -c release --jobs "${EAVESY_SWIFT_BUILD_JOBS:-2}"

RUSTC_BIN="$(command -v rustc || true)"
if [[ -z "$RUSTC_BIN" && -x "$HOME/.cargo/bin/rustc" ]]; then
  RUSTC_BIN="$HOME/.cargo/bin/rustc"
fi
if [[ -z "$RUSTC_BIN" ]]; then
  echo "rustc was not found; install Rust or source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi
TRIPLE="$("$RUSTC_BIN" -vV | awk '/^host:/{print $2}')"
DEST="$DESKTOP/src-tauri/binaries"
mkdir -p "$DEST"
cp -f "$DESKTOP/swift-audio/.build/release/SwiftAudio" "$DEST/SwiftAudio-$TRIPLE"
echo "▸ Staged sidecar: src-tauri/binaries/SwiftAudio-$TRIPLE"
