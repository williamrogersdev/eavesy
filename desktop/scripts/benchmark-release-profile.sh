#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/eavesy-release-bench.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
cd "$ROOT/desktop/src-tauri"
for variant in baseline tuned; do
  if [[ "$variant" == baseline ]]; then
    export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_STRIP=none
  else
    export CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 CARGO_PROFILE_RELEASE_STRIP=debuginfo
  fi
  CARGO_TARGET_DIR="$OUT/target" /usr/bin/time -p cargo build --release --locked
  cp "$OUT/target/release/eavesy" "$OUT/$variant"
  echo "$variant bytes: $(stat -f '%z' "$OUT/$variant")"
done
python3 - "$OUT/baseline" "$OUT/tuned" <<'PY'
from pathlib import Path
import sys
baseline, tuned = (Path(p).stat().st_size for p in sys.argv[1:])
print(f'Binary reduction: {(1 - tuned / baseline) * 100:.2f}%')
PY
