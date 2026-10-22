# Testing without taking over your Mac

Two ways to test, neither of which needs your screen, mic, clipboard or
keyboard. Agents should use these instead of computer use on your own
desktop.

| What you're checking | Use |
| --- | --- |
| Web, workers, Rust, Swift, HUD/launcher UI | `scripts/test-local.sh` (headless, on the host) |
| The installed Mac app: first run, permissions, menu bar, windows, paste | `desktop/scripts/vm-test.sh` (a throwaway macOS VM) |

## Headless checks: `scripts/test-local.sh`

Runs what CI runs, plus optional browser checks in headless Chromium. Each
step prints `ok` or the last 40 lines of its output.

```bash
scripts/test-local.sh              # web + workers + desktop (Rust, Swift)
scripts/test-local.sh web          # web + workers only
scripts/test-local.sh desktop      # prebuild, swift test, cargo test, clippy
scripts/test-local.sh ux hud       # Playwright UX tests, HUD preview check
scripts/test-local.sh all
```

Notes for this machine's toolchain:

- `swift test` needs Xcode, not just the Command Line Tools (XCTest ships with
  Xcode). The script uses `/Applications/Xcode.app` automatically. If it says
  you haven't agreed to the Xcode license, run `sudo xcodebuild -license` once.
- On the macOS 27 SDK, `aws-lc-sys` fails to link. The script falls back to a
  26.x Command Line Tools SDK when one is installed.

## The real app in a VM: `desktop/scripts/vm-test.sh`

[Tart](https://tart.run) runs a macOS VM on Apple's Virtualization framework.
The VM runs headless. You never see it unless you ask to, and it has its own
screen, keyboard, clipboard and audio:

- `--no-audio`: the VM can't hear your microphone or play through your
  speakers.
- `--no-clipboard`: the VM's copy and paste stays inside the VM.
- Its mic and speaker are [BlackHole](https://existential.audio/blackhole/), a
  virtual loopback, so `vm-test.sh say "…"` is what the app hears.

### Install once

The Homebrew tap for Tart is currently broken. Install the notarized release
directly:

```bash
gh release download --repo cirruslabs/tart --pattern 'tart.tar.gz' --dir /tmp/tart
tar -xzf /tmp/tart/tart.tar.gz -C ~/Applications
ln -sf ~/Applications/tart.app/Contents/MacOS/tart ~/.local/bin/tart
desktop/scripts/vm-test.sh setup     # pulls ~32 GB once, builds eavesy-base
```

`setup` clones Cirrus Labs' `macos-tahoe-base` image, gives it 4 CPUs, 8 GB of
memory and a 1024×768 screen, and installs `cliclick` (input), BlackHole and
`switchaudio-osx`. Each run then makes an instant copy-on-write clone of
`eavesy-base`, so every test starts from a clean first run. Tart's license is
free for personal use.

### Use

```bash
desktop/scripts/vm-test.sh smoke          # build if needed, launch, check, screenshot, logs, tear down
desktop/scripts/vm-test.sh build          # debug Eavesy.app on the host (~1 min warm)
desktop/scripts/vm-test.sh up             # fresh VM with the app installed and launched
desktop/scripts/vm-test.sh shot onboarding    # → desktop/src-tauri/target/vm/shots/onboarding.png
desktop/scripts/vm-test.sh click 651 321  # screen points, same as the screenshot's pixels
desktop/scripts/vm-test.sh type "hello"
desktop/scripts/vm-test.sh key kd:cmd t:v ku:cmd
desktop/scripts/vm-test.sh say "Testing one two three"
desktop/scripts/vm-test.sh exec pgrep -lx eavesy
desktop/scripts/vm-test.sh logs           # → desktop/src-tauri/target/vm/logs
desktop/scripts/vm-test.sh view           # opens a Screen Sharing window if you want to watch (admin/admin)
desktop/scripts/vm-test.sh down
```

An agent's loop is `up` → `shot` → read the PNG → `click`/`type` → `shot` …
→ `logs` → `down`. Everything lands under `desktop/src-tauri/target/vm/`,
which is gitignored.

By default the app meets macOS exactly as a new user's Mac would. The
onboarding asks for each permission, and you click **Allow** on macOS's own
prompts inside the VM, so the real first-run path gets tested. `up --granted`
pre-grants microphone, screen recording, speech recognition, accessibility
and System Events automation in the guest instead. Use it when a test isn't
about onboarding. It writes the guest's TCC database, which only works because
SIP is off in Cirrus Labs images. It never touches the host.

`EAVESY_APP=/path/to/Eavesy.app` installs a different build, such as a
notarized release candidate, instead of the debug one.

### What a VM can't cover

- **On-device speech.** The VM reports the speech model as unsupported, so
  live words and instant dictation paste fall back or stay off. Use
  `desktop/bench/check-caption-paste.sh` on the host for that path. It's
  silent too.
- **Your real hardware.** It doesn't cover Bluetooth headsets, the Fn key on a
  real keyboard, multiple displays, or sleep/wake on a laptop lid.
- **Pairing with a local server.** The debug build accepts plain `http` only
  for loopback. From inside the VM, the host is `192.168.64.1`, not loopback,
  so pair against eavesy.com or a tunnel.
