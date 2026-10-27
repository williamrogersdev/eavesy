#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy"]
# ///
"""App icon (desktop/DESIGN.md §3): cream squircle with the Little Snoop at
78%, coral lens raised.

    uv run gen_icon.py            # writes icon-source.png (1024²)
    bunx @tauri-apps/cli icon icon-source.png -o /tmp/eavesy-icons
    # then copy 32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.icns here
"""
import numpy as np

from mascot_raster import PAPER, Canvas, paint_full_mascot

N = 1024
INSET = 100  # macOS icon grid: 824² squircle centred on a 1024² canvas
SIDE = N - 2 * INSET
RADIUS = 185
# The figure spans x 2..62, y 7..63 in viewBox units; centre it at 78% width.
S = SIDE * 0.78 / 60
OX = N / 2 - 32 * S
OY = N / 2 - 35 * S

cv = Canvas(N, S, OX, OY)
to_u = lambda px: (px - OX) / S
to_v = lambda py: (py - OY) / S
tile = cv.d_round_rect(to_u(INSET), to_v(INSET), SIDE / S, SIDE / S, RADIUS / S)

# Soft charcoal drop shadow under the tile.
shadow = cv.d_round_rect(to_u(INSET), to_v(INSET + 12), SIDE / S, SIDE / S, RADIUS / S)
shadow_cov = np.clip(0.5 - shadow * S / 28, 0, 1) * 0.28
cv.rgb += np.array((33, 28, 26), np.float32)[None, None, :] / 255 * shadow_cov[..., None]
cv.a += shadow_cov

cv.paint(tile, PAPER)
paint_full_mascot(cv, clip=cv.coverage(tile))
# Hairline so the cream tile holds its edge on light backgrounds.
edge = np.abs(tile) - 1.0 / S
cv.paint(edge, (33, 28, 26), 0.1)

open('icon-source.png', 'wb').write(cv.png())
print('wrote icon-source.png')
