#!/usr/bin/env bash
# Test the real Eavesy.app inside a throwaway macOS VM (Tart), so nothing
# touches your own screen, mic, clipboard or keyboard. Run with no arguments
# for usage; see docs/TESTING-ENVIRONMENTS.md.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${EAVESY_VM_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-base:latest}"
BASE=eavesy-base
RUN=eavesy-run
OUT="$DESKTOP/src-tauri/target/vm"
SHARE_IN_GUEST="/Volumes/My Shared Files/eavesy"
# shellcheck source=sdkroot.sh
source "$DESKTOP/scripts/sdkroot.sh"
DEBUG_APP="$DESKTOP/src-tauri/target/debug/bundle/macos/Eavesy.app"
BUNDLE_ID=com.eavesy.desktop

usage() {
  cat <<'EOF'
vm-test.sh setup          one time: build the eavesy-base image (~32 GB)
vm-test.sh build          build a debug Eavesy.app on the host
vm-test.sh up [--granted] fresh VM from eavesy-base, install + launch the app.
                          Real first run by default: click through macOS's
                          own prompts. --granted pre-grants them instead.
vm-test.sh smoke          build if needed, up, check it runs, screenshot, logs, down
vm-test.sh shot [name]    screenshot the VM; prints the PNG path
vm-test.sh click X Y      click at screen points (from a shot; 1024x768)
vm-test.sh type TEXT      type into the focused app
vm-test.sh key KEYS...    cliclick key actions, e.g. kd:cmd t:v ku:cmd
vm-test.sh say TEXT       speak into the VM's virtual mic (BlackHole)
vm-test.sh exec CMD...    run a shell command in the VM
vm-test.sh logs           copy the app's logs out; prints the folder
vm-test.sh view           open a window on the VM (Screen Sharing)
vm-test.sh down           stop and delete the run VM

Env: EAVESY_VM_IMAGE (default ghcr.io/cirruslabs/macos-tahoe-base:latest),
EAVESY_VM_CPU (4), EAVESY_VM_MEMORY (8192 MB), EAVESY_APP (an Eavesy.app to
install instead of the debug build), EAVESY_API_BASE (server for the debug
build; loopback only), EAVESY_VM_KEEP=1 (smoke leaves the VM running).
EOF
}

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
  stop "$vm"
  die "$vm didn't come up; see $OUT/$vm.console.log"
}

stop() { running "$1" && tart stop "$1" >/dev/null 2>&1 || true; }
# EXIT traps, given the exit status.
down_on_failure() { [[ $1 -eq 0 ]] || cmd_down; }
discard_base_on_failure() { [[ $1 -eq 0 ]] && return; stop "$BASE"; exists "$BASE" && tart delete "$BASE"; }

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
# given executables, inside the guest only. This is replayd's private,
# undocumented approvals file: a macOS update can change it, and then the
# prompt comes back (visible in the next `shot`).
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
  # A half-built base would be cloned by every later run; start over instead.
  trap 'discard_base_on_failure $?' EXIT
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
  eavesy_pick_sdkroot
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
  # Don't leave a half-set-up VM holding 8 GB if anything below fails.
  trap 'down_on_failure $?' EXIT
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
  local name="${1:-$(date +%H%M%S)}"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ && "$name" != .* ]] || die "shot name must be letters, digits, . _ or -"
  running "$RUN" || die "$RUN isn't running; run: $0 up"
  mkdir -p "$OUT/shots"
  local file="$OUT/shots/$name.png"
  g /bin/sh -c 'f=$(mktemp -t shot).png; screencapture -x "$f" && cat "$f"; rm -f "$f"' >"$file"
  echo "$file"
}

cmd_logs() {
  local dest="$OUT/logs" f
  rm -rf "$dest" && mkdir -p "$dest/$BUNDLE_ID"
  # One file at a time, by plain name, so nothing from the guest picks a host path.
  for f in $(g /bin/sh -c "ls ~/Library/Logs/$BUNDLE_ID 2>/dev/null"); do
    [[ "$f" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "skipping odd log name: $f" >&2; continue; }
    g cat "/Users/admin/Library/Logs/$BUNDLE_ID/$f" >"$dest/$BUNDLE_ID/$f" || echo "couldn't copy $f" >&2
  done
  g /bin/sh -c "log show --last 10m --style compact --predicate 'process CONTAINS[c] \"eavesy\" OR process == \"SwiftAudio\"'" >"$dest/unified.log" \
    || echo "couldn't read the unified log" >&2
  g /bin/sh -c "ls ~/Library/Logs/DiagnosticReports/ | grep -i eavesy || true" >"$dest/crashes.txt" \
    || echo "couldn't list crash reports" >&2
  echo "$dest"
}

cmd_smoke() {
  [[ -n "${EAVESY_APP:-}" || -d "$DEBUG_APP" ]] || cmd_build
  cmd_up
  if [[ "${EAVESY_VM_KEEP:-0}" == 1 ]]; then trap - EXIT; else trap cmd_down EXIT; fi
  local ok=0
  # Up within 60 s, then still up 10 s later (no crash right after launch).
  for _ in $(seq 30); do g pgrep -x eavesy >/dev/null && { ok=1; break; }; sleep 2; done
  if [[ $ok == 1 ]]; then sleep 10; g pgrep -x eavesy >/dev/null || ok=0; fi
  cmd_shot smoke
  cmd_logs
  if [[ -s "$OUT/logs/crashes.txt" ]]; then ok=0; echo "crash reports:"; cat "$OUT/logs/crashes.txt"; fi
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
  *) usage; [[ -z "$sub" ]] || exit 2 ;;
esac
