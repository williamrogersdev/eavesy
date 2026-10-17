# Icons

All artwork is the Eavesy mascot (see `desktop/DESIGN.md` §3), rasterized by
`mascot_raster.py` from the same geometry as `mascot.svg` and
`web/src/components/launcher/ui/mascot.tsx`. The scripts need numpy; `uv`
fetches it for you.

## App icon

`gen_icon.py` draws `icon-source.png` (1024², plaster squircle on the macOS icon
grid, mascot at 78% peeking up from the bottom edge). Regenerate the set with:

```bash
uv run gen_icon.py
bunx @tauri-apps/cli@2 icon icon-source.png -o /tmp/eavesy-icons
cp /tmp/eavesy-icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.icns} .
```

## Menu bar

`gen_tray.py` (`uv run gen_tray.py .`) writes two glyphs, neither of them a
microphone:

- `tray.png` / `tray@2x.png`: the roof chevron and two eye dots, black on
  transparent. Used as a macOS *template* image so the menu bar tints it for
  light and dark. The full-colour app icon cannot be used here: as a template
  it renders as a solid square.
- `tray-recording.png` / `@2x`: shown while a capture is recording. Not a
  template, so the red porch light on the roof peak stays red; the chevron is
  a mid-tone that reads on light and dark menu bars.

`src/tray.rs` embeds both at compile time via `tauri::include_image!` (needs
the `image-png` Cargo feature) and swaps them from `hud::set_state`.
