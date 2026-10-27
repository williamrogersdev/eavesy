#!/usr/bin/env bash
# Run the repo's checks headless: no windows, no focus changes, no mic, no
# clipboard. Safe to run while you use the Mac. For the installed desktop app,
# use desktop/scripts/vm-test.sh instead (docs/TESTING-ENVIRONMENTS.md).
#
#   scripts/test-local.sh            web + workers + desktop (what CI runs)
#   scripts/test-local.sh web        just web + workers
#   scripts/test-local.sh desktop    just Rust + Swift
#   scripts/test-local.sh ux hud     opt-in browser checks (headless Chromium)
#   scripts/test-local.sh all        everything above
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

AREAS=("$@")
[[ ${#AREAS[@]} -eq 0 ]] && AREAS=(web desktop)
[[ " ${AREAS[*]} " == *" all "* ]] && AREAS=(web desktop ux hud)

FAILED=()
step() {
  local name="$1"; shift
  printf '\n▸ %s\n' "$name"
  local start=$SECONDS
  if "$@" >"$TMP/step.log" 2>&1; then
    printf '  ok (%ss)\n' $((SECONDS - start))
  else
    tail -40 "$TMP/step.log" | sed 's/^/  │ /'
    printf '  FAILED (%ss)\n' $((SECONDS - start))
    FAILED+=("$name")
  fi
}
in_dir() { (cd "$ROOT/$1" && shift && "$@"); }

run_web() {
  for d in web workers/processing workers/mcp workers/meeting-bot; do
    step "install $d" in_dir "$d" bun install --frozen-lockfile
  done
  step "migration numbering" "$ROOT/scripts/check-migrations.sh"
  # build generates src/routeTree.gen.ts, which typecheck needs. The Clerk key
  # is CI's well-formed placeholder unless you export a real one.
  step "web build" in_dir web env \
    VITE_CLERK_PUBLISHABLE_KEY="${VITE_CLERK_PUBLISHABLE_KEY:-pk_test_cGxhY2Vob2xkZXIuY2xlcmsuYWNjb3VudHMuZGV2JA}" \
    VITE_APP_URL="${VITE_APP_URL:-https://eavesy.com}" \
    bun run build
  step "web typecheck" in_dir web bun run typecheck
  step "web lint" in_dir web bun run lint
  step "web unit tests" in_dir web bun test src
  step "worker tests (Miniflare)" in_dir web bun run test:workers
  step "two-track bench" in_dir web bun bench/score.ts --check
  step "processing worker" in_dir workers/processing sh -c "bun run typecheck && bunx wrangler deploy --dry-run --outdir '$TMP/p'"
  step "mcp worker" in_dir workers/mcp sh -c "bun run typecheck && bunx wrangler deploy --dry-run --outdir '$TMP/m'"
  step "meeting bot" in_dir workers/meeting-bot sh -c 'bun run typecheck && bun run test:bot && bun run lint:bot'
}

run_desktop() {
  # The macOS 27 SDK's libSystem stub breaks aws-lc-sys linking; a 26.x SDK
  # works. Only applies when SDKROOT isn't already chosen.
  if [[ -z "${SDKROOT:-}" && "$(xcrun --show-sdk-version 2>/dev/null)" == 27* ]]; then
    local old
    old="$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX26*.sdk 2>/dev/null | sort -V | tail -1)"
    [[ -n "$old" ]] && export SDKROOT="$old" && echo "  using SDKROOT=$old"
  fi
  step "prebuild (launcher UI + Swift sidecar)" "$ROOT/desktop/scripts/prebuild.sh"
  # XCTest ships with Xcode, not the Command Line Tools.
  local xcode=()
  if [[ -z "${DEVELOPER_DIR:-}" && "$(xcode-select -p 2>/dev/null)" == /Library/Developer/CommandLineTools* && -d /Applications/Xcode.app ]]; then
    xcode=(env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer)
  fi
  step "swift tests" in_dir desktop/swift-audio ${xcode[@]+"${xcode[@]}"} swift test
  step "rust tests" in_dir desktop/src-tauri cargo test --locked
  step "clippy" in_dir desktop/src-tauri cargo clippy --locked -- -D warnings
}

run_ux() {
  # Playwright starts (or reuses) the local test server on :4173 itself.
  step "web UX (Playwright)" in_dir web bun run test:ux
}

run_hud() {
  step "launcher UI install" in_dir desktop/launcher-ui bun install
  local port=1420 pid
  (cd "$ROOT/desktop/launcher-ui" && exec bunx vite --host 127.0.0.1 --port "$port" --strictPort) >"$TMP/vite.log" 2>&1 &
  pid=$!
  for _ in $(seq 60); do curl -sf "http://127.0.0.1:$port/hud.html" >/dev/null && break; sleep 0.5; done
  step "HUD preview (headless Chromium)" env EAVESY_HUD_URL="http://127.0.0.1:$port/hud.html" node "$ROOT/desktop/bench/check-hud-preview.mjs"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
}

for area in "${AREAS[@]}"; do
  case "$area" in
    web|desktop|ux|hud) "run_$area" ;;
    *) echo "Unknown area: $area (web, desktop, ux, hud, all)" >&2; exit 2 ;;
  esac
done

echo
if [[ ${#FAILED[@]} -gt 0 ]]; then
  printf 'FAILED: %s\n' "${FAILED[@]}"
  exit 1
fi
echo "All checks passed."
