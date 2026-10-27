#!/usr/bin/env bash
# Silent end-to-end fixture check: real speech engines -> production Rust
# caption assembly -> native Cocoa paste into an isolated text view.
# No microphone, speakers, user clipboard, foreground changes or key events.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ $# -gt 1 ]]; then echo "Usage: APPLE_SIGNING_IDENTITY='Developer ID Application: …' $0 [canonical-fixture.aiff]" >&2; exit 2; fi
: "${APPLE_SIGNING_IDENTITY:?Use the same Developer ID as the installed Eavesy app}"
OUTPUT="${EAVESY_QA_OUTPUT:-$(mktemp -d /private/tmp/eavesy-caption-qa.XXXXXX)}"
APP="$OUTPUT/EavesySpeechQA.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
cleanup() {
  "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
  "$LSREGISTER" -f /Applications/Eavesy.app >/dev/null 2>&1 || true
}
trap cleanup EXIT
if [[ $# -eq 1 ]]; then
  INPUT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  INPUT="$OUTPUT/fixture.aiff"
  say -v Samantha -r 140 -f "$ROOT/desktop/bench/caption-fixture.txt" -o "$INPUT"
fi
mkdir -p "$APP/Contents/MacOS"
python3 - "$APP/Contents/Info.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as out:
    plistlib.dump({'CFBundleIdentifier':'com.eavesy.desktop', 'CFBundleName':'Eavesy Speech QA',
        'CFBundleExecutable':'caption-fixture', 'CFBundlePackageType':'APPL', 'LSUIElement':True,
        'NSSpeechRecognitionUsageDescription':'Verify transcription using a local synthetic fixture.'}, out)
PY
swiftc -parse-as-library -O "$ROOT/desktop/bench/caption-fixture.swift" \
  "$ROOT/desktop/swift-audio/Sources/SwiftAudio/Captions.swift" \
  "$ROOT/desktop/swift-audio/Sources/SwiftAudio/CaptionEngines.swift" \
  -o "$APP/Contents/MacOS/caption-fixture"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$APP"
swiftc "$ROOT/desktop/bench/native-paste-check.swift" -o "$OUTPUT/native-paste-check"
afconvert -f WAVE -d LEF32@48000 "$INPUT" "$OUTPUT/input.wav"
for engine in analyzer legacy; do
  open -g -n -W --stdout "$OUTPUT/$engine.log" --stderr "$OUTPUT/$engine-error.log" \
    "$APP" --args "$engine" "$OUTPUT/input.wav" "$OUTPUT/$engine.jsonl"
  [[ -s "$OUTPUT/$engine.jsonl" ]] || { cat "$OUTPUT/$engine-error.log" >&2; exit 1; }
  (cd "$ROOT/desktop/src-tauri" && \
    EAVESY_CAPTION_FIXTURE="$OUTPUT/$engine.jsonl" EAVESY_CAPTION_PASTE_OUTPUT="$OUTPUT/$engine-paste.txt" \
    cargo test --lib captions::tests::real_speech_fixture_preserves_the_whole_message_for_paste -- --ignored --exact)
  "$OUTPUT/native-paste-check" "$OUTPUT/$engine-paste.txt"
done
printf 'Evidence saved in %s\n' "$OUTPUT"
