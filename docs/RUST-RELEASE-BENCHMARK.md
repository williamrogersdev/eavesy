# Desktop Rust release profile

Measured October 20, 2026 on macOS arm64 with rustc 1.95.0, the same c336719
source and launcher/Swift sidecar artifacts, and locked Cargo dependencies.

| Profile | Executable size |
| --- | ---: |
| Existing Cargo release defaults | 24,753,984 bytes |
| Thin LTO, 1 codegen unit, strip debuginfo | 19,645,712 bytes |

The executable is 20.64% smaller (about 4.9 MiB). This is a binary-size result,
not a measured runtime/startup speedup. Debug information is stripped while
symbol names and normal panic unwinding remain. Development/test profiles do
not change. The release build still uses Cargo's normal optimization level.

The observed full builds took 1m02s and 2m11s respectively. Dependency caches
and background activity differed, so these are context, not a controlled build
speed comparison. Release linking costs more with LTO; interactive development
continues to use its existing profile. The selected defaults favor smaller
shipped desktop binaries. Both builds emitted the same existing legacy
Objective-C macro/deprecation warnings.

After `desktop/scripts/prebuild.sh`, reproduce on macOS with:

```sh
desktop/scripts/benchmark-release-profile.sh
```

The runner clears profile environment overrides and builds the committed tuned
profile directly; only the explicit baseline uses overrides. A fresh-target
reproduction produced 25,844,328 baseline bytes and the same 19,645,712 tuned
bytes (23.98% reduction), with labelled elapsed times of 57s and 129s. The
initial stock-profile measurement above is retained as its own observation;
use the fresh-target runner for future comparisons.

The runner validates macOS and the sidecar/HTML prebuild outputs,
uses an isolated target directory, reports successful build times and sizes,
and removes its temporary artifacts. It does not start the app, sign a binary,
create a release, or publish a DMG. Test the selected optimized profile with
`cargo test --release --locked` from desktop/src-tauri.

The current macOS release workflow allows 90 minutes for its build job. The
measured tuned build completed in roughly two minutes. No native crash-symbol
upload workflow exists in this repository; release debug info was already off,
and the tuned Mach-O retains rust_begin_unwind and rust_eh_personality symbols.
A signed release/publish run was not started for this tooling change.
