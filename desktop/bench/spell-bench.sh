#!/usr/bin/env bash
# Runs spell-bench.swift over saved clips with the production Speller.
#   APPLE_SIGNING_IDENTITY='Developer ID Application: …' \
#     desktop/bench/spell-bench.sh vocabulary.txt clips.txt out.jsonl
# vocabulary.txt: one word or phrase per line, as the app sends the sidecar
# (the app's name first). clips.txt: one audio file path per line.
# The bench is signed as the Eavesy app so it uses that app's speech
# permission; it never asks for one, and records, plays and pastes nothing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ $# -ne 3 ]]; then echo "Usage: APPLE_SIGNING_IDENTITY='…' $0 vocabulary.txt clips.txt out.jsonl" >&2; exit 2; fi
: "${APPLE_SIGNING_IDENTITY:?Use the same Developer ID as the installed Eavesy app}"
abs() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
VOCAB="$(abs "$1")"; CLIPS="$(abs "$2")"; OUT="$(abs "$3")"
WORK="$(mktemp -d /private/tmp/eavesy-spell-bench.XXXXXX)"
APP="$WORK/EavesySpellBench.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
cleanup() {
  "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
  "$LSREGISTER" -f /Applications/Eavesy.app >/dev/null 2>&1 || true
}
trap cleanup EXIT
mkdir -p "$APP/Contents/MacOS"
python3 - "$APP/Contents/Info.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as out:
    plistlib.dump({'CFBundleIdentifier':'com.eavesy.desktop', 'CFBundleName':'Eavesy Spell Bench',
        'CFBundleExecutable':'spell-bench', 'CFBundlePackageType':'APPL', 'LSUIElement':True,
        'NSSpeechRecognitionUsageDescription':'Check how saved clips are transcribed, on this Mac.'}, out)
PY
SRC="$ROOT/desktop/swift-audio/Sources/SwiftAudio"
swiftc -parse-as-library -O "$ROOT/desktop/bench/spell-bench.swift" "$SRC/Speller.swift" "$SRC/EnglishWords.swift" "$SRC/LiveDraft.swift" \
  -o "$APP/Contents/MacOS/spell-bench"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$APP"
open -g -n -W --stderr "$WORK/error.log" "$APP" --args "$VOCAB" "$CLIPS" "$OUT"
[[ -s "$OUT" ]] || { cat "$WORK/error.log" >&2; exit 1; }
echo "Wrote $(wc -l <"$OUT" | tr -d ' ') clips to $OUT"
