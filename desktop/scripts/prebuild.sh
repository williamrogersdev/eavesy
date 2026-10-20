#!/usr/bin/env bash
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ Building launcher UI → frontend-shell"
cd "$DESKTOP/launcher-ui"
bun install
bun run build

echo "▸ Building SwiftAudio capture engine"
cd "$DESKTOP/swift-audio"
# SpeechAnalyzer (live words, instant dictation paste) only compiles with
# Swift 6.2+; an older toolchain silently leaves it out.
SWIFT_VERSION="$(swift --version 2>&1 | sed -nE 's/.*Swift version ([0-9]+\.[0-9]+).*/\1/p' | head -1)"
if [[ "${EAVESY_ALLOW_OLD_SWIFT:-0}" != "1" && -z "$SWIFT_VERSION" ]]; then
  echo "Could not read the Swift version from \`swift --version\`." >&2
  exit 1
fi
if [[ "${EAVESY_ALLOW_OLD_SWIFT:-0}" != "1" ]] && ! printf '%s\n6.2\n' "$SWIFT_VERSION" | sort -V -C -r; then
  echo "Swift $SWIFT_VERSION is older than 6.2, so SpeechAnalyzer would be left out. Use Xcode 26 (or set EAVESY_ALLOW_OLD_SWIFT=1)." >&2
  exit 1
fi
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
