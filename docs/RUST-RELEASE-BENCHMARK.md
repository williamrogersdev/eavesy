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

The runner explicitly selects both sets of flags against the current source,
uses an isolated target directory, reports successful build times and sizes,
and removes its temporary artifacts. It does not start the app, sign a binary,
create a release, or publish a DMG. Test the selected optimized profile with
`cargo test --release --locked` from desktop/src-tauri.
