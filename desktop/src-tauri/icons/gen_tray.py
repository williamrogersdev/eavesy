#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy"]
# ///
"""Menu bar glyphs (desktop/DESIGN.md §3): the mascot's fedora and two eyes
peeking under the brim. Never a microphone.

    uv run gen_tray.py .

- tray.png / tray@2x.png: black on transparent, used as a macOS template image
  so the menu bar tints it for light and dark.
- tray-recording.png / @2x: not a template. Same glyph in a mid-tone that reads
  on light and dark menu bars, with the coral recording light at its lower right.
"""
import sys

from mascot_raster import Canvas, paint_mini_glyph

# Glyph bounds in viewBox units: brim spans x 2..62, crown top y 8.5, eyes end ~48.8.
GLYPH_W, GLYPH_TOP, GLYPH_BOTTOM = 60.0, 8.5, 49.0
MID = (0x8A, 0x80, 0x78)


def render(size, recording=False):
    s = size * 0.94 / GLYPH_W
    ox = size / 2 - 32 * s
    oy = size / 2 - (GLYPH_TOP + GLYPH_BOTTOM) / 2 * s
    cv = Canvas(size, s, ox, oy)
    color = MID if recording else (0, 0, 0)
    paint_mini_glyph(cv, color, color, recording=recording)
    return cv.png()


out = sys.argv[1] if len(sys.argv) > 1 else '.'
for name, size, rec in (
    ('tray.png', 44, False),
    ('tray@2x.png', 88, False),
    ('tray-recording.png', 44, True),
    ('tray-recording@2x.png', 88, True),
):
    open(f'{out}/{name}', 'wb').write(render(size, rec))
    print('wrote', name)
