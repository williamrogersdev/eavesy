#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "This desktop benchmark requires macOS." >&2
  exit 1
fi
TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
if [[ ! -f "$ROOT/desktop/src-tauri/binaries/SwiftAudio-$TRIPLE" || ! -f "$ROOT/desktop/src-tauri/frontend-shell/index.html" || ! -f "$ROOT/desktop/src-tauri/frontend-shell/hud.html" ]]; then
  echo "Run desktop/scripts/prebuild.sh before benchmarking release profiles." >&2
  exit 1
fi
OUT="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-release-bench.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
cd "$ROOT/desktop/src-tauri"
for variant in baseline tuned; do
  unset CARGO_PROFILE_RELEASE_LTO CARGO_PROFILE_RELEASE_CODEGEN_UNITS CARGO_PROFILE_RELEASE_STRIP
  if [[ "$variant" == baseline ]]; then
    export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_STRIP=none
  fi
  echo "Building $variant release profile"
  profile_started_at=$SECONDS
  CARGO_TARGET_DIR="$OUT/target" /usr/bin/time -p cargo build --release --locked
  cp "$OUT/target/release/eavesy" "$OUT/$variant"
  echo "$variant bytes: $(stat -f '%z' "$OUT/$variant"); elapsed: $((SECONDS - profile_started_at))s"
done
python3 - "$OUT/baseline" "$OUT/tuned" <<'PY'
from pathlib import Path
import sys
baseline, tuned = (Path(p).stat().st_size for p in sys.argv[1:])
print(f'Binary reduction: {(1 - tuned / baseline) * 100:.2f}%')
PY
