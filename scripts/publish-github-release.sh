#!/usr/bin/env bash
# Tag desktop-vX.Y.Z and publish a GitHub Release with the notarized DMG.
#
# Run after desktop/scripts/release-macos.sh --publish has notarized the DMG
# and uploaded it to eavesy.com. The GitHub Release is a mirror for people who
# find the project on GitHub; eavesy.com stays the canonical download and the
# source the Homebrew cask and the in-app updater use.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$REPO_ROOT/desktop/src-tauri/tauri.conf.json"
GH_REPO="${GH_REPO:-williamrogersdev/eavesy}"
DRAFT=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: scripts/publish-github-release.sh [--draft] [--dry-run]

Creates the annotated tag desktop-vX.Y.Z (version from tauri.conf.json) on the
current HEAD, pushes it, and creates a GitHub Release with the DMG and its
SHA-256 attached.

  --draft     create the release as a draft
  --dry-run   run every check, print what would happen, change nothing

Environment:
  EAVESY_DMG  DMG path (defaults to the arm64 bundle for the current version)
  GH_REPO     owner/repo (defaults to williamrogersdev/eavesy)
USAGE
}

while (($#)); do
  case "$1" in
    --draft) DRAFT=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TAURI_CONF" | head -1)"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not read a release version from $TAURI_CONF (got '$VERSION')." >&2
  exit 1
fi
TAG="desktop-v$VERSION"
DMG_NAME="Eavesy_${VERSION}_aarch64.dmg"
DMG="${EAVESY_DMG:-$REPO_ROOT/desktop/src-tauri/target/release/bundle/dmg/$DMG_NAME}"

command -v gh >/dev/null || { echo "Install the GitHub CLI: brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

if [[ ! -f "$DMG" ]]; then
  echo "DMG not found: $DMG" >&2
  echo "Build and notarize it first: desktop/scripts/build-macos-release.sh && desktop/scripts/release-macos.sh --publish" >&2
  exit 1
fi

echo "▸ Checking the DMG is notarized and stapled"
xcrun stapler validate "$DMG" >/dev/null || {
  echo "$DMG has no valid notarization ticket. Run desktop/scripts/release-macos.sh first." >&2
  exit 1
}

LOCAL_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
echo "▸ Checking eavesy.com serves the same bytes"
PUBLIC_URL="https://eavesy.com/api/downloads/mac/$DMG_NAME"
PUBLIC_SHA="$(curl --fail --silent --show-error --location "$PUBLIC_URL" | shasum -a 256 | awk '{print $1}')" || {
  echo "Could not download $PUBLIC_URL. Run desktop/scripts/release-macos.sh --publish first." >&2
  exit 1
}
if [[ "$LOCAL_SHA" != "$PUBLIC_SHA" ]]; then
  echo "Local DMG ($LOCAL_SHA) differs from $PUBLIC_URL ($PUBLIC_SHA)." >&2
  exit 1
fi

cd "$REPO_ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or discard changes before tagging." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists locally." >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists on origin." >&2
  exit 1
fi
if gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
  echo "A GitHub Release for $TAG already exists." >&2
  exit 1
fi

COMMIT="$(git rev-parse HEAD)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-gh-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
printf '%s  %s\n' "$LOCAL_SHA" "$DMG_NAME" > "$WORK/$DMG_NAME.sha256"
cat > "$WORK/notes.md" <<NOTES
## Install

\`\`\`bash
brew install --cask williamrogersdev/eavesy/eavesy
\`\`\`

Or download **$DMG_NAME** below (Apple silicon, macOS 13 Ventura or later),
open it, and drag Eavesy into Applications. Existing installs update
themselves from inside the app.

SHA-256: \`$LOCAL_SHA\`
NOTES

release_flags=(--repo "$GH_REPO" --title "Eavesy $VERSION for Mac" --notes-file "$WORK/notes.md" --verify-tag)
if [[ "$DRAFT" == true ]]; then
  release_flags+=(--draft)
fi

echo "▸ Release plan"
echo "    tag:     $TAG → $COMMIT"
echo "    repo:    $GH_REPO"
echo "    assets:  $DMG_NAME, $DMG_NAME.sha256"
echo "    draft:   $DRAFT"
if [[ "$DRY_RUN" == true ]]; then
  echo "▸ Dry run: nothing was tagged, pushed, or published"
  exit 0
fi

echo "▸ Tagging and pushing $TAG"
git tag -a "$TAG" -m "Eavesy desktop $VERSION" "$COMMIT"
git push origin "refs/tags/$TAG"

echo "▸ Creating GitHub Release"
gh release create "$TAG" "$DMG#$DMG_NAME" "$WORK/$DMG_NAME.sha256" "${release_flags[@]}"
gh release view "$TAG" --repo "$GH_REPO" --json url --jq .url
