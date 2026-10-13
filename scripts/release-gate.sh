#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-release-gate.XXXXXX")"
cleanup() {
  rm -rf "$DRY_RUN_ROOT"
}
trap cleanup EXIT

echo "▸ Web lint, types, tests, and production build"
cd "$REPO/web"
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:ux

echo "▸ Processing Worker types and deploy dry-run"
cd "$REPO/workers/processing"
bunx tsc --noEmit
bunx wrangler deploy --dry-run --outdir "$DRY_RUN_ROOT/processing"

echo "▸ MCP Worker types and deploy dry-run"
cd "$REPO/workers/mcp"
bunx tsc --noEmit
bunx wrangler deploy --dry-run --outdir "$DRY_RUN_ROOT/mcp"

echo "▸ Launcher UI and Swift capture sidecar"
cd "$REPO/desktop"
./scripts/prebuild.sh

echo "▸ Rust dependency lock, compile, and tests"
cd "$REPO/desktop/src-tauri"
CARGO_BIN="$(command -v cargo || true)"
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  echo "cargo was not found; install Rust or source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi
"$CARGO_BIN" check --locked --all-targets
"$CARGO_BIN" test --locked

echo "▸ Tauri debug application build (no bundle, no publication)"
cd "$REPO/desktop/src-tauri"
bunx @tauri-apps/cli build --debug --no-bundle

echo "▸ Patch hygiene"
cd "$REPO"
git diff --check

echo "▸ Release gate passed; no production changes were made"
