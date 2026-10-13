# Icons

Real artwork, generated from `icon-source.png` by `gen_icon.py`. Regenerate the
app icon set with `bunx tauri icon icon-source.png`.

`tray.png` / `tray@2x.png` are separate and **not** part of that generated set:
they are a monochrome glyph used as a macOS *template* image, so the menu bar
tints them for light/dark. The full-colour app icon cannot be used here — as a
template it renders as a solid white square. `src/tray.rs` embeds `tray.png` at
compile time via `tauri::include_image!`, which requires the `image-png` Cargo
feature.

The tray glyph is the app icon's rounded square and record dot, drawn by
`gen_tray.py` (`python3 gen_tray.py .` from this folder). It is deliberately
not a microphone: other dictation apps already put one in the menu bar.
