#!/usr/bin/env bash
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DESKTOP/.." && pwd)"
PROFILE="${NOTARY_PROFILE:-eavesy-notary}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
PUBLISH=false

TAURI_CONF="$DESKTOP/src-tauri/tauri.conf.json"
VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TAURI_CONF" | head -1)"
if [[ -z "$VERSION" ]]; then
  echo "Could not read version from $TAURI_CONF" >&2
  exit 1
fi
case "$(uname -m)" in
  arm64|aarch64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
DMG="${EAVESY_DMG:-$DESKTOP/src-tauri/target/release/bundle/dmg/Eavesy_${VERSION}_${ARCH}.dmg}"
INCOMPLETE_MARKER="$DESKTOP/src-tauri/target/release/bundle/.eavesy-candidate-incomplete"

usage() {
  cat <<'EOF'
Usage: desktop/scripts/release-macos.sh [--publish]

Notarizes and validates EAVESY_DMG. With --publish, uploads the notarized DMG
to R2 and verifies that the public download has identical bytes.

Environment:
  EAVESY_DMG       DMG path (defaults to the artifact matching tauri.conf.json's
                    version and this machine's architecture)
  NOTARY_PROFILE   notarytool Keychain profile (defaults to eavesy-notary)
  APPLE_SIGNING_IDENTITY
                    Developer ID Application identity used to sign the DMG
  APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
                    complete Apple ID credential set used only when the
                    Keychain profile is unavailable
  APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH
                    alternative complete App Store Connect API credential set
EOF
}

while (($#)); do
  case "$1" in
    --publish)
      PUBLISH=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -e "$INCOMPLETE_MARKER" ]]; then
  cat >&2 <<EOF
The previous release build did not complete. Refusing to validate an older or
partial candidate. Fix the build inputs and rerun:
  desktop/scripts/build-macos-release.sh
EOF
  exit 1
fi

if [[ ! -f "$DMG" ]]; then
  echo "DMG not found: $DMG" >&2
  exit 1
fi
DMG="$(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")"

if xcrun stapler validate "$DMG" >/dev/null 2>&1; then
  echo "▸ Existing notarization ticket is valid"
else
  echo "▸ Verifying disk image before applying its final signature"
  hdiutil verify "$DMG"
  if [[ -z "$IDENTITY" ]]; then
    echo "Set APPLE_SIGNING_IDENTITY to your Developer ID Application identity." >&2
    exit 1
  fi
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
  codesign --verify --verbose=2 "$DMG"

  echo "▸ Validating Apple notarization credentials"
  notary_auth=()
  if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    notary_auth=(--keychain-profile "$PROFILE")
  elif [[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
    if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
      echo "Set APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID together." >&2
      exit 1
    fi
    echo "▸ Using Apple ID credentials from the CI environment"
    notary_auth=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  elif [[ -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
    if [[ -z "${APPLE_API_ISSUER:-}" || -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_PATH:-}" ]]; then
      echo "Set APPLE_API_ISSUER, APPLE_API_KEY, and APPLE_API_KEY_PATH together." >&2
      exit 1
    fi
    if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
      echo "APPLE_API_KEY_PATH does not point to a file: $APPLE_API_KEY_PATH" >&2
      exit 1
    fi
    echo "▸ Using App Store Connect API credentials from the CI environment"
    notary_auth=(--issuer "$APPLE_API_ISSUER" --key-id "$APPLE_API_KEY" --key "$APPLE_API_KEY_PATH")
  else
    cat >&2 <<EOF
No usable notarytool Keychain profile named "$PROFILE" was found.

Create it once with:
  xcrun notarytool store-credentials "$PROFILE" \\
    --apple-id "YOUR_APPLE_ID" \\
    --team-id "YOUR_TEAM_ID" \\
    --password "YOUR_APP_SPECIFIC_PASSWORD"
EOF
    exit 1
  fi
  xcrun notarytool history "${notary_auth[@]}" >/dev/null

  echo "▸ Submitting DMG to Apple notarization"
  xcrun notarytool submit "$DMG" \
    "${notary_auth[@]}" \
    --wait

  echo "▸ Stapling notarization ticket"
  xcrun stapler staple "$DMG"
fi

echo "▸ Validating staple and Gatekeeper acceptance"
xcrun stapler validate "$DMG"
codesign --verify --verbose=2 "$DMG"

MOUNT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-release.XXXXXX")"
MOUNTED=false
cleanup() {
  if [[ "$MOUNTED" == true ]]; then
    hdiutil detach "$MOUNT_ROOT" -quiet || true
  fi
  rmdir "$MOUNT_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_ROOT" -quiet
MOUNTED=true
APP="$MOUNT_ROOT/Eavesy.app"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vvv -t install "$APP"
hdiutil detach "$MOUNT_ROOT" -quiet
MOUNTED=false
rmdir "$MOUNT_ROOT"

LOCAL_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
echo "▸ Local SHA-256: $LOCAL_SHA"

if [[ "$PUBLISH" != true ]]; then
  echo "▸ Validation complete; rerun with --publish to release the DMG"
  exit 0
fi

BUNDLE="$DESKTOP/src-tauri/target/release/bundle/macos"
UPDATE_TARBALL="$BUNDLE/Eavesy.app.tar.gz"
UPDATE_SIG="$UPDATE_TARBALL.sig"

if [[ ! -s "$UPDATE_TARBALL" || ! -s "$UPDATE_SIG" ]]; then
  cat >&2 <<EOF
Updater artifacts are missing or empty:
  $UPDATE_TARBALL
  $UPDATE_SIG

They are produced by \`tauri build\` when bundle.createUpdaterArtifacts is set
AND a signing key is available. Export the key and rebuild:

  export TAURI_SIGNING_PRIVATE_KEY="\$HOME/.tauri/eavesy-updater.key"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

No release files have been uploaded.
EOF
  exit 1
fi

echo "▸ Verifying updater signature before the first remote write"
"$DESKTOP/scripts/verify-updater-signature.sh" "$UPDATE_TARBALL" "$UPDATE_SIG"

echo "▸ Publishing notarized DMG to R2"
cd "$REPO/web"
VERSIONED_DMG_NAME="Eavesy_${VERSION}_${ARCH}.dmg"
VERSIONED_DMG_URL="https://eavesy.com/api/downloads/mac/$VERSIONED_DMG_NAME"
# Versioned DMGs are immutable: the Homebrew cask pins their sha256. Refuse to
# overwrite one that already exists with different bytes.
EXISTING_SHA="$(curl --fail --silent --location "$VERSIONED_DMG_URL" | shasum -a 256 | awk '{print $1}' || true)"
EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
if [[ -n "$EXISTING_SHA" && "$EXISTING_SHA" != "$EMPTY_SHA" && "$EXISTING_SHA" != "$LOCAL_SHA" ]]; then
  echo "$VERSIONED_DMG_NAME is already published with different bytes ($EXISTING_SHA)." >&2
  echo "Bump the version in $TAURI_CONF instead of replacing a released DMG." >&2
  exit 1
fi
bunx wrangler r2 object put \
  "eavesy-audio/downloads/mac/$VERSIONED_DMG_NAME" \
  --file "$DMG" \
  --content-type application/x-apple-diskimage \
  --remote
bunx wrangler r2 object put \
  eavesy-audio/downloads/mac/eavesy-latest.dmg \
  --file "$DMG" \
  --content-type application/x-apple-diskimage \
  --remote

DOWNLOADED_DMG="$(mktemp "${TMPDIR:-/tmp}/eavesy-download.XXXXXX")"
trap 'rm -f "$DOWNLOADED_DMG"; cleanup' EXIT
echo "▸ Verifying public download bytes"
curl --fail --silent --show-error --location \
  https://eavesy.com/api/downloads/mac/latest \
  --output "$DOWNLOADED_DMG"
REMOTE_SHA="$(shasum -a 256 "$DOWNLOADED_DMG" | awk '{print $1}')"
rm -f "$DOWNLOADED_DMG"

if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "Published DMG hash mismatch: local=$LOCAL_SHA remote=$REMOTE_SHA" >&2
  exit 1
fi
VERSIONED_REMOTE_SHA="$(curl --fail --silent --show-error --location "$VERSIONED_DMG_URL" | shasum -a 256 | awk '{print $1}')"
if [[ "$LOCAL_SHA" != "$VERSIONED_REMOTE_SHA" ]]; then
  echo "Versioned DMG hash mismatch: local=$LOCAL_SHA remote=$VERSIONED_REMOTE_SHA" >&2
  exit 1
fi

echo "▸ Publishing updater artifacts to R2"
bunx wrangler r2 object put \
  "eavesy-audio/downloads/mac/Eavesy_${VERSION}_${ARCH}.app.tar.gz" \
  --file "$UPDATE_TARBALL" \
  --content-type application/gzip \
  --remote

MANIFEST="$(mktemp "${TMPDIR:-/tmp}/eavesy-manifest.XXXXXX")"
cat > "$MANIFEST" <<EOF
{
  "version": "$VERSION",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-$ARCH": {
      "url": "https://eavesy.com/api/downloads/mac/update/Eavesy_${VERSION}_${ARCH}.app.tar.gz",
      "signature": "$(cat "$UPDATE_SIG")"
    }
  }
}
EOF

echo "▸ Publishing update manifest to R2"
bunx wrangler r2 object put \
  eavesy-audio/downloads/mac/latest.json \
  --file "$MANIFEST" \
  --content-type application/json \
  --remote
rm -f "$MANIFEST"

echo "▸ Verifying the updater endpoint offers $VERSION to an older client"
OFFERED="$(curl --fail --silent --show-error \
  "https://eavesy.com/api/updates/darwin/$ARCH/0.0.0" | grep -o '"version":"[^"]*"' || true)"
if [[ -z "$OFFERED" ]]; then
  echo "Updater endpoint did not offer an update — clients cannot self-update." >&2
  exit 1
fi
echo "▸ Updater endpoint reports: $OFFERED"

echo "▸ Published DMG verified: $REMOTE_SHA"
echo "▸ Next: scripts/publish-github-release.sh, then bump packaging/homebrew/Casks/eavesy.rb to $VERSION"
