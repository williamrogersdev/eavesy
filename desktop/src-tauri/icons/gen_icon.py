#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy"]
# ///
"""App icon (desktop/DESIGN.md §3): plaster squircle with the mascot at 78%,
sitting low so the bottom edge crops its body, peeking up.

    uv run gen_icon.py            # writes icon-source.png (1024²)
    bunx @tauri-apps/cli icon icon-source.png -o /tmp/eavesy-icons
    # then copy 32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.icns here
"""
import numpy as np

from mascot_raster import PLASTER, Canvas, paint_full_mascot

N = 1024
INSET = 100  # macOS icon grid: 824² squircle centred on a 1024² canvas
SIDE = N - 2 * INSET
RADIUS = 185
# Reference layout (preview.html): a 96px tile holds the 92px mascot svg
# (viewBox -4 -8 72 72) centred, 14px below the bottom edge.
K = SIDE / 96
S = K * 92 / 72
OX = INSET + K * (2 + 4 * 92 / 72)
OY = INSET + K * (18 + 8 * 92 / 72)

cv = Canvas(N, S, OX, OY)
to_u = lambda px: (px - OX) / S
to_v = lambda py: (py - OY) / S
tile = cv.d_round_rect(to_u(INSET), to_v(INSET), SIDE / S, SIDE / S, RADIUS / S)

# Soft plum-tinted drop shadow under the tile.
shadow = cv.d_round_rect(to_u(INSET), to_v(INSET + 12), SIDE / S, SIDE / S, RADIUS / S)
shadow_cov = np.clip(0.5 - shadow * S / 28, 0, 1) * 0.28
cv.rgb += np.array((42, 34, 51), np.float32)[None, None, :] / 255 * shadow_cov[..., None]
cv.a += shadow_cov

cv.paint(tile, PLASTER)
paint_full_mascot(cv, clip=cv.coverage(tile))
# Hairline so the plaster tile holds its edge on light backgrounds.
edge = np.abs(tile) - 1.0 / S
cv.paint(edge, (42, 34, 51), 0.1)

open('icon-source.png', 'wb').write(cv.png())
print('wrote icon-source.png')
