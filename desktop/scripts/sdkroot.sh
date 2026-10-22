# shellcheck shell=bash
# Sourced by scripts/test-local.sh and desktop/scripts/vm-test.sh.
# The macOS 27 SDK's libSystem stub breaks aws-lc-sys linking (see
# desktop/BUILD.md); a 26.x Command Line Tools SDK works. Only applies when
# SDKROOT isn't already chosen.
eavesy_pick_sdkroot() {
  [[ -z "${SDKROOT:-}" && "$(xcrun --show-sdk-version 2>/dev/null)" == 27* ]] || return 0
  local old
  old="$(find /Library/Developer/CommandLineTools/SDKs -maxdepth 1 -name 'MacOSX26*.sdk' 2>/dev/null | sort -V | tail -1)"
  [[ -n "$old" ]] || return 0
  export SDKROOT="$old"
  echo "  using SDKROOT=$old"
}
