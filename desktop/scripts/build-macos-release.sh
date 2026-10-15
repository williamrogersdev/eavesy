#!/usr/bin/env bash
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_TIMEOUT_SECONDS="${EAVESY_BUILD_TIMEOUT_SECONDS:-1200}"
TAURI_CONF="$DESKTOP/src-tauri/tauri.conf.json"
VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TAURI_CONF" | head -1)"
if [[ -z "$VERSION" ]]; then
  echo "Could not read the release version from $TAURI_CONF." >&2
  exit 1
fi
case "$(uname -m)" in
  arm64|aarch64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

BUNDLE_MACOS="$DESKTOP/src-tauri/target/release/bundle/macos"
BUNDLE_DMG="$DESKTOP/src-tauri/target/release/bundle/dmg"
DMG_NAME="Eavesy_${VERSION}_${ARCH}.dmg"
DMG="$BUNDLE_DMG/$DMG_NAME"
APP="$BUNDLE_MACOS/Eavesy.app"
UPDATE="$BUNDLE_MACOS/Eavesy.app.tar.gz"
RELEASE_BINARY="$DESKTOP/src-tauri/target/release/eavesy"
INCOMPLETE_MARKER="$DESKTOP/src-tauri/target/release/bundle/.eavesy-candidate-incomplete"
TIMEOUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-build-timeout.XXXXXX")"
TIMEOUT_MARKER="$TIMEOUT_DIR/timed-out"
BUILD_MARKER="$TIMEOUT_DIR/build-started"
DMG_STAGING=""
CANDIDATE_COMPLETE=false
BUILD_LOCK="$DESKTOP/src-tauri/target/.eavesy-release-build.lock"
BUILD_LOCK_OWNED=false
ACTIVE_BUILD_PID=""
ACTIVE_WATCHDOG_PID=""
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

remove_candidate_outputs() {
  rm -rf -- "$APP"
  rm -f -- "$DMG" "$UPDATE" "$UPDATE.sig" "$RELEASE_BINARY"
}
cleanup() {
  if [[ -n "$ACTIVE_BUILD_PID" ]]; then
    terminate_process_tree "$ACTIVE_BUILD_PID" TERM
    wait "$ACTIVE_BUILD_PID" 2>/dev/null || true
  fi
  if [[ -n "$ACTIVE_WATCHDOG_PID" ]]; then
    terminate_process_tree "$ACTIVE_WATCHDOG_PID" TERM
    wait "$ACTIVE_WATCHDOG_PID" 2>/dev/null || true
  fi
  if [[ -n "$DMG_STAGING" && -d "$DMG_STAGING" ]]; then
    rm -rf -- "$DMG_STAGING"
  fi
  if [[ "$BUILD_LOCK_OWNED" == true && "$CANDIDATE_COMPLETE" != true ]]; then
    remove_candidate_outputs
  fi
  rm -f "$TIMEOUT_MARKER" "$BUILD_MARKER"
  rmdir "$TIMEOUT_DIR" 2>/dev/null || true
  if [[ "$BUILD_LOCK_OWNED" == true ]]; then
    rm -f "$BUILD_LOCK/pid"
    rmdir "$BUILD_LOCK" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$(dirname "$BUILD_LOCK")"
if ! mkdir "$BUILD_LOCK" 2>/dev/null; then
  previous_pid="$(cat "$BUILD_LOCK/pid" 2>/dev/null || true)"
  if [[ "$previous_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$previous_pid" 2>/dev/null; then
    rm -f "$BUILD_LOCK/pid"
    rmdir "$BUILD_LOCK" 2>/dev/null || true
    mkdir "$BUILD_LOCK" 2>/dev/null || { echo "Another release build acquired the lock." >&2; exit 1; }
  else
    echo "A release build is already active (or its lock is incomplete)." >&2
    exit 1
  fi
fi
BUILD_LOCK_OWNED=true
printf '%s\n' "$$" > "$BUILD_LOCK/pid"

mkdir -p "$(dirname "$INCOMPLETE_MARKER")"
: > "$INCOMPLETE_MARKER"
remove_candidate_outputs

if [[ ! "$BUILD_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "EAVESY_BUILD_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 1
fi

required=(
  TAURI_SIGNING_PRIVATE_KEY
  APPLE_SIGNING_IDENTITY
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required release environment variable is missing: $name" >&2
    exit 1
  fi
done

apple_id_credentials=(APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
apple_api_credentials=(APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH)
count_present() {
  local count=0
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      count=$((count + 1))
    fi
  done
  printf '%s' "$count"
}

apple_id_count="$(count_present "${apple_id_credentials[@]}")"
apple_api_count="$(count_present "${apple_api_credentials[@]}")"
if [[ "$apple_id_count" -ne 0 && "$apple_id_count" -ne "${#apple_id_credentials[@]}" ]]; then
  echo "Set APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID together, or omit all three and notarize with release-macos.sh." >&2
  exit 1
fi
if [[ "$apple_api_count" -ne 0 && "$apple_api_count" -ne "${#apple_api_credentials[@]}" ]]; then
  echo "Set APPLE_API_ISSUER, APPLE_API_KEY, and APPLE_API_KEY_PATH together, or omit all three." >&2
  exit 1
fi
if [[ "$apple_id_count" -ne 0 && "$apple_api_count" -ne 0 ]]; then
  echo "Configure either Apple ID or App Store Connect API notarization credentials, not both." >&2
  exit 1
fi
if [[ "$apple_api_count" -ne 0 && ! -f "$APPLE_API_KEY_PATH" ]]; then
  echo "APPLE_API_KEY_PATH does not point to a file: $APPLE_API_KEY_PATH" >&2
  exit 1
fi

EXPECT_TAURI_NOTARIZATION=false
if [[ "$apple_id_count" -ne 0 || "$apple_api_count" -ne 0 ]]; then
  EXPECT_TAURI_NOTARIZATION=true
fi

if ! command -v cargo >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found; install Rust or source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi

cd "$DESKTOP/src-tauri"

terminate_process_tree() {
  local pid="$1"
  local signal="$2"
  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    terminate_process_tree "$child" "$signal"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill -"$signal" "$pid" 2>/dev/null || true
}

run_tauri_build() {
  rm -f "$TIMEOUT_MARKER"
  : > "$BUILD_MARKER"
  bunx @tauri-apps/cli build --bundles app &
  local build_pid=$!
  ACTIVE_BUILD_PID="$build_pid"

  (
    sleep "$BUILD_TIMEOUT_SECONDS"
    if kill -0 "$build_pid" 2>/dev/null; then
      : > "$TIMEOUT_MARKER"
      echo "Tauri app/updater build exceeded ${BUILD_TIMEOUT_SECONDS}s; terminating its process tree." >&2
      terminate_process_tree "$build_pid" TERM
      sleep 5
      terminate_process_tree "$build_pid" KILL
    fi
  ) &
  local watchdog_pid=$!
  ACTIVE_WATCHDOG_PID="$watchdog_pid"

  local status=0
  wait "$build_pid" || status=$?
  ACTIVE_BUILD_PID=""
  terminate_process_tree "$watchdog_pid" TERM
  wait "$watchdog_pid" 2>/dev/null || true
  ACTIVE_WATCHDOG_PID=""
  if [[ -f "$TIMEOUT_MARKER" ]]; then
    return 124
  fi
  return "$status"
}

# EAVESY_API_BASE is compiled into the app. A leftover dev value (e.g. a localhost
# URL) must never ship in a signed release.
if [[ -n "${EAVESY_API_BASE:-}" && ! "$EAVESY_API_BASE" =~ ^https://[^/[:space:]]+$ ]]; then
  echo "EAVESY_API_BASE is set to '$EAVESY_API_BASE'. Release builds need an https origin with no path, or leave it unset for https://eavesy.com." >&2
  exit 1
fi

if [[ -z "${SENTRY_DSN:-}" ]]; then
  if [[ "${EAVESY_ALLOW_NO_SENTRY:-}" == "1" ]]; then
    echo "⚠ SENTRY_DSN is not set and EAVESY_ALLOW_NO_SENTRY=1: this build will not report crashes or errors" >&2
  else
    echo "SENTRY_DSN is not set. Release builds must report crashes and errors (desktop/BUILD.md)." >&2
    echo "Self-hosted builds without Sentry can opt out with EAVESY_ALLOW_NO_SENTRY=1." >&2
    exit 1
  fi
fi
echo "▸ Tauri signed app and updater build"
build_status=0
run_tauri_build || build_status=$?
if [[ "$build_status" -ne 0 ]]; then
  if [[ "$build_status" -eq 124 ]]; then
    echo "Increase EAVESY_BUILD_TIMEOUT_SECONDS if compilation or Apple notarization legitimately needs longer." >&2
  fi
  exit "$build_status"
fi

if [[ ! -d "$APP" ]]; then
  echo "Required release application is missing: $APP" >&2
  exit 1
fi
for artifact in "$UPDATE" "$UPDATE.sig"; do
  if [[ ! -s "$artifact" ]]; then
    echo "Required release artifact is missing or empty: $artifact" >&2
    exit 1
  fi
done
if [[ ! "$UPDATE" -nt "$BUILD_MARKER" || ! "$UPDATE.sig" -nt "$BUILD_MARKER" ]]; then
  echo "Tauri did not produce fresh updater artifacts for this build." >&2
  exit 1
fi

echo "▸ Verifying the Developer ID application signature"
codesign --verify --deep --strict --verbose=2 "$APP"
if [[ "$EXPECT_TAURI_NOTARIZATION" == true ]]; then
  echo "▸ Verifying Tauri stapled the automatically notarized app"
  xcrun stapler validate "$APP"
fi

echo "▸ Verifying updater signature against the public key compiled into Eavesy"
"$DESKTOP/scripts/verify-updater-signature.sh" "$UPDATE" "$UPDATE.sig"

echo "▸ Creating the DMG without Finder automation"
DMG_STAGING="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-dmg-staging.XXXXXX")"
ditto "$APP" "$DMG_STAGING/Eavesy.app"
ln -s /Applications "$DMG_STAGING/Applications"
mkdir -p "$BUNDLE_DMG"
rm -f "$DMG"
if ! hdiutil create -volname Eavesy -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG"; then
  rm -f "$DMG"
  exit 1
fi
rm -rf -- "$DMG_STAGING"
DMG_STAGING=""

echo "▸ Verifying and signing the final disk image"
hdiutil verify "$DMG"
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
codesign --verify --verbose=2 "$DMG"

rm -f "$INCOMPLETE_MARKER"
CANDIDATE_COMPLETE=true
echo "▸ Built signed app, DMG, and updater artifacts; run release-macos.sh to notarize and validate the exact DMG"
