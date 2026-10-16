#!/usr/bin/env bash
# Point Casks/eavesy.rb at a published versioned DMG and refresh its sha256.
# Usage: packaging/homebrew/bump-cask.sh [VERSION]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CASK="$HERE/Casks/eavesy.rb"
VERSION="${1:-$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO/desktop/src-tauri/tauri.conf.json" | head -1)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version: $VERSION" >&2
  exit 1
fi

URL="https://eavesy.com/api/downloads/mac/Eavesy_${VERSION}_aarch64.dmg"
echo "▸ Hashing $URL"
SHA="$(curl --fail --silent --show-error --location "$URL" | shasum -a 256 | awk '{print $1}')"

sed -i '' \
  -e "s/^  version \".*\"/  version \"$VERSION\"/" \
  -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" \
  "$CASK"
echo "▸ $CASK → $VERSION ($SHA)"
