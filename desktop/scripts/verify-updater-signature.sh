#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <Eavesy.app.tar.gz> <Eavesy.app.tar.gz.sig>" >&2
  exit 2
fi

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
SIGNATURE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"

if [[ ! -s "$ARCHIVE" || ! -s "$SIGNATURE" ]]; then
  echo "Updater archive or signature is missing or empty." >&2
  exit 1
fi

CARGO_BIN="$(command -v cargo || true)"
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  echo "cargo was not found; install Rust or source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi

cd "$DESKTOP/src-tauri"
# The example builds the app crate, whose build script requires the Swift
# sidecar and the bundled frontend to exist. The publish job only has the
# notarized artifacts, so empty placeholders stand in for them; nothing built
# here is shipped.
CLEANUP=()
cleanup() { if (( ${#CLEANUP[@]} )); then rm -rf "${CLEANUP[@]}"; fi; }
trap cleanup EXIT
SIDECAR="binaries/SwiftAudio-$(rustc -vV | sed -n 's/^host: //p')"
if [[ ! -e "$SIDECAR" ]]; then
  mkdir -p binaries
  : > "$SIDECAR"
  CLEANUP+=("$DESKTOP/src-tauri/$SIDECAR")
fi
if [[ ! -e frontend-shell ]]; then
  mkdir -p frontend-shell
  : > frontend-shell/index.html
  CLEANUP+=("$DESKTOP/src-tauri/frontend-shell")
fi
"$CARGO_BIN" run --quiet --locked --example verify_updater_signature -- \
  "$ARCHIVE" "$SIGNATURE" "$DESKTOP/src-tauri/tauri.conf.json"
