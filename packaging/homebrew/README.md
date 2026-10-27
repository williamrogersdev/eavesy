# homebrew-eavesy

Homebrew tap for the [Eavesy](https://eavesy.com) Mac app (Apple silicon,
macOS 13 Ventura or later).

```bash
brew install --cask williamrogersdev/eavesy/eavesy
```

Eavesy updates itself in place (Tauri updater), so `brew upgrade` skips it
unless you pass `--greedy`. To remove the app and its local state:

```bash
brew uninstall --zap --cask eavesy
```

`--zap` leaves your recordings in `~/Eavesy` and the device token in your login
Keychain. Remove the token with:

```bash
security delete-generic-password -s com.eavesy.desktop.device-token.v2
```

## Maintaining

This directory is the source of truth for the tap; it lives in the main repo at
`packaging/homebrew/` and is copied to
[williamrogersdev/homebrew-eavesy](https://github.com/williamrogersdev/homebrew-eavesy).

After `desktop/scripts/release-macos.sh --publish` uploads a new versioned DMG:

```bash
packaging/homebrew/bump-cask.sh            # reads the version from tauri.conf.json
brew audit --cask --strict --online williamrogersdev/eavesy/eavesy
```

Then copy `Casks/eavesy.rb` to the tap repo and push.
