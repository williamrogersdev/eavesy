#!/usr/bin/env bash
# Test the real Eavesy.app inside a throwaway macOS VM (Tart), so nothing
# touches your own screen, mic, clipboard or keyboard. See
# docs/TESTING-ENVIRONMENTS.md.
#
#   vm-test.sh setup          one time: build the eavesy-base image (~32 GB)
#   vm-test.sh build          build a debug Eavesy.app on the host
#   vm-test.sh up [--granted] fresh VM from eavesy-base, install + launch the app.
#                             Real first run by default: click through macOS's
#                             own prompts. --granted pre-grants them instead.
#   vm-test.sh smoke          build if needed, up, check it runs, screenshot, logs, down
#   vm-test.sh shot [name]    screenshot the VM; prints the PNG path
#   vm-test.sh click X Y      click at screen points (from a shot; 1024x768)
#   vm-test.sh type TEXT      type into the focused app
#   vm-test.sh key KEYS...    cliclick key actions, e.g. kd:cmd t:v ku:cmd
#   vm-test.sh say TEXT       speak into the VM's virtual mic (BlackHole)
#   vm-test.sh exec CMD...    run a shell command in the VM
#   vm-test.sh logs           copy the app's logs out; prints the folder
#   vm-test.sh view           open a window on the VM (Screen Sharing)
#   vm-test.sh down           stop and delete the run VM
#
# Env: EAVESY_VM_IMAGE (default ghcr.io/cirruslabs/macos-tahoe-base:latest),
# EAVESY_VM_CPU (4), EAVESY_VM_MEMORY (8192 MB), EAVESY_APP (an Eavesy.app to
# install instead of the debug build), EAVESY_API_BASE (server for the debug
# build; loopback only, so point it at a tunnel or leave the default).
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${EAVESY_VM_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-base:latest}"
BASE=eavesy-base
RUN=eavesy-run
OUT="$DESKTOP/src-tauri/target/vm"
SHARE_IN_GUEST="/Volumes/My Shared Files/eavesy"
DEBUG_APP="$DESKTOP/src-tauri/target/debug/bundle/macos/Eavesy.app"
BUNDLE_ID=com.eavesy.desktop

die() { echo "vm-test: $*" >&2; exit 1; }
command -v tart >/dev/null || die "Tart isn't installed. See docs/TESTING-ENVIRONMENTS.md."

exists() { tart list --quiet 2>/dev/null | grep -qx "$1"; }
running() { tart list 2>/dev/null | awk -v n="$1" '$2==n {print $NF}' | grep -qx running; }
g() { tart exec "$RUN" "$@"; }
gsh() { tart exec "$RUN" /bin/zsh -lc "$1"; }

# Boots $1 headless. No audio pass-through: the VM never hears your mic or
# plays through your speakers; BlackHole is its microphone instead.
boot() {
  local vm="$1"; shift
  mkdir -p "$OUT"
  tart run "$vm" --no-graphics --no-audio --no-clipboard "$@" >"$OUT/$vm.console.log" 2>&1 &
  for _ in $(seq 100); do
    tart exec "$vm" true 2>/dev/null && return 0
    sleep 3
  done
  die "$vm didn't come up; see $OUT/$vm.console.log"
}

stop() { running "$1" && tart stop "$1" >/dev/null 2>&1 || true; }

# For `up --granted`: grants the permissions a person would click through on
# first launch, for the given TCC clients. Runs only inside the disposable guest (SIP is off in
# Cirrus Labs images); never on the host.
grant() {
  local vm="$1"; shift
  tart exec "$vm" /bin/zsh -lc "$(cat <<'SH'
set -e
now=$(date +%s)
sys="/Library/Application Support/com.apple.TCC/TCC.db"
usr="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
row() { # db service client client_type [indirect]
  local q="INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier,flags,last_modified) VALUES ('$2','$3',$4,2,4,1,'${5:-UNUSED}',0,$now);"
  if [[ "$1" == sys ]]; then sudo sqlite3 "$sys" "$q"; else sqlite3 "$usr" "$q"; fi
}
for spec in "$@"; do
  client="${spec%%|*}"; type="${spec#*|}"
  for s in kTCCServiceScreenCapture kTCCServiceAccessibility kTCCServicePostEvent kTCCServiceListenEvent; do row sys "$s" "$client" "$type"; done
  for s in kTCCServiceMicrophone kTCCServiceSpeechRecognition; do row usr "$s" "$client" "$type"; done
  row usr kTCCServiceAppleEvents "$client" "$type" com.apple.systemevents
done
sudo killall tccd 2>/dev/null || true
killall tccd 2>/dev/null || true
SH
)" grant "$@"
}

# Stops macOS's recurring "bypass the private window picker" prompt for the
# given executables, inside the guest only.
approve_screen_capture() {
  local vm="$1"; shift
  tart exec "$vm" /usr/bin/python3 - "$@" <<'PY'
import datetime, os, plistlib, sys
p = os.path.expanduser("~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist")
os.makedirs(os.path.dirname(p), exist_ok=True)
d = plistlib.load(open(p, "rb")) if os.path.exists(p) else {}
far = datetime.datetime(2100, 1, 1)
for exe in sys.argv[1:]:
    d.setdefault(exe, {}).update(kScreenCaptureApprovalLastAlerted=far, kScreenCaptureApprovalLastUsed=far,
                                 kScreenCapturePrivacyHintDate=far, kScreenCaptureAlertableUsageCount=0)
plistlib.dump(d, open(p, "wb"))
PY
  tart exec "$vm" killall replayd 2>/dev/null || true
}

cmd_setup() {
  exists "$BASE" && { echo "$BASE already exists (tart delete $BASE to rebuild)."; return; }
  echo "▸ Pulling $IMAGE (first time ~32 GB)"
  tart clone "$IMAGE" "$BASE"
  tart set "$BASE" --cpu "${EAVESY_VM_CPU:-4}" --memory "${EAVESY_VM_MEMORY:-8192}" --display 1024x768
  boot "$BASE"
  # The image already lets its guest agent screenshot and send input.
  echo "▸ Installing cliclick (input) and BlackHole (virtual mic)"
  tart exec "$BASE" /bin/zsh -lc 'brew install cliclick switchaudio-osx && brew install --cask blackhole-2ch'
  # BlackHole is both mic and speaker, so `say` is what the app hears.
  tart exec "$BASE" /bin/zsh -lc 'sudo killall coreaudiod; sleep 3; for t in input output system; do SwitchAudioSource -t $t -s "BlackHole 2ch"; done'
  # Quiet desktop: no Terminal window restored over the app.
  tart exec "$BASE" /bin/zsh -lc 'osascript -e "quit app \"Terminal\"" 2>/dev/null; defaults write com.apple.Terminal NSQuitAlwaysKeepsWindows -bool false' || true
  stop "$BASE"
  echo "▸ $BASE ready. Each run clones it, so every test starts clean."
}

cmd_build() {
  # The macOS 27 SDK breaks aws-lc-sys linking; see desktop/BUILD.md.
  if [[ -z "${SDKROOT:-}" && "$(xcrun --show-sdk-version 2>/dev/null)" == 27* ]]; then
    local old; old="$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX26*.sdk 2>/dev/null | sort -V | tail -1)"
    [[ -n "$old" ]] && export SDKROOT="$old"
  fi
  [[ -x "$DESKTOP/src-tauri/binaries/SwiftAudio-$(rustc -vV | awk '/^host:/{print $2}')" && -d "$DESKTOP/src-tauri/frontend-shell" ]] \
    || "$DESKTOP/scripts/prebuild.sh"
  # No updater key locally, so no updater archive.
  (cd "$DESKTOP/src-tauri" && bunx @tauri-apps/cli build --debug --bundles app \
    --config '{"bundle":{"createUpdaterArtifacts":false}}')
  echo "$DEBUG_APP"
}

cmd_up() {
  exists "$BASE" || die "no $BASE image yet; run: $0 setup"
  local app="${EAVESY_APP:-$DEBUG_APP}"
  [[ -d "$app" ]] || die "no app at $app; run: $0 build"
  cmd_down >/dev/null
  rm -rf "$OUT/share" && mkdir -p "$OUT/share"
  ditto "$app" "$OUT/share/Eavesy.app"
  tart clone "$BASE" "$RUN"
  boot "$RUN" --dir "eavesy:$OUT/share"
  echo "▸ Installing Eavesy into /Applications"
  gsh "ditto '$SHARE_IN_GUEST/Eavesy.app' /Applications/Eavesy.app && xattr -cr /Applications/Eavesy.app"
  if [[ "${1:-}" == --granted ]]; then
    echo "▸ Pre-granting mic, screen, speech and accessibility (guest only)"
    grant "$RUN" "$BUNDLE_ID|0"
    approve_screen_capture "$RUN" /Applications/Eavesy.app/Contents/MacOS/eavesy \
      /Applications/Eavesy.app/Contents/MacOS/SwiftAudio
  fi
  echo "▸ Launching"
  local env=()
  [[ -n "${EAVESY_API_BASE:-}" ]] && env=(--env "EAVESY_API_BASE=$EAVESY_API_BASE")
  g open ${env[@]+"${env[@]}"} -a /Applications/Eavesy.app
  echo "▸ $RUN is up. Try: $0 shot"
}

cmd_shot() {
  running "$RUN" || die "$RUN isn't running; run: $0 up"
  mkdir -p "$OUT/shots"
  local file="$OUT/shots/${1:-$(date +%H%M%S)}.png"
  g /bin/sh -c 'f=$(mktemp -t shot).png; screencapture -x "$f" && cat "$f"; rm -f "$f"' >"$file"
  echo "$file"
}

cmd_logs() {
  local dest="$OUT/logs"
  rm -rf "$dest" && mkdir -p "$dest"
  g /bin/sh -c "cd ~/Library/Logs && tar cf - $BUNDLE_ID 2>/dev/null; true" | tar xf - -C "$dest" 2>/dev/null || true
  g /bin/sh -c "log show --last 10m --style compact --predicate 'process CONTAINS[c] \"eavesy\" OR process == \"SwiftAudio\"' 2>/dev/null" >"$dest/unified.log" || true
  g /bin/sh -c "ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i eavesy" >"$dest/crashes.txt" || true
  echo "$dest"
}

cmd_smoke() {
  [[ -n "${EAVESY_APP:-}" || -d "$DEBUG_APP" ]] || cmd_build
  cmd_up
  sleep 15
  local ok=0
  g pgrep -x eavesy >/dev/null && ok=1
  cmd_shot smoke
  cmd_logs
  if [[ -s "$OUT/logs/crashes.txt" ]]; then ok=0; echo "crash reports:"; cat "$OUT/logs/crashes.txt"; fi
  [[ "${EAVESY_VM_KEEP:-0}" == 1 ]] || cmd_down
  [[ $ok == 1 ]] || die "Eavesy isn't running after launch; see $OUT/logs"
  echo "▸ smoke ok"
}

cmd_down() {
  stop "$RUN"
  exists "$RUN" && tart delete "$RUN"
  return 0
}

cmd_view() {
  running "$RUN" || die "$RUN isn't running"
  # Cirrus Labs images log in as admin/admin.
  open "vnc://admin@$(tart ip "$RUN")"
}

sub="${1:-}"; shift || true
case "$sub" in
  setup|build|up|smoke|shot|logs|down|view) "cmd_$sub" "$@" ;;
  click) [[ $# -eq 2 ]] || die "usage: click X Y"; g /opt/homebrew/bin/cliclick "c:$1,$2" ;;
  type) g /opt/homebrew/bin/cliclick "t:$*" ;;
  key) g /opt/homebrew/bin/cliclick "$@" ;;
  say) g say "$*" ;;
  exec) g "$@" ;;
  *) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; [[ -z "$sub" ]] || exit 2 ;;
esac
