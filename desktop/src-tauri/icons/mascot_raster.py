"""Signed-distance rasterizer for the Eavesy mascot (desktop/DESIGN.md §3).

Geometry mirrors web/src/components/launcher/ui/mascot.tsx and mascot.svg
(viewBox units, idle pose). Used by gen_icon.py and gen_tray.py; needs numpy.
"""

import struct
import zlib

import numpy as np

COAT = (0x2B, 0x25, 0x23)
BAND = (0x4A, 0x40, 0x3C)
EYE = (0xFB, 0xF7, 0xF0)
REC = (0xFF, 0x5A, 0x3C)
PAPER = (0xFB, 0xF7, 0xF0)


def cubic(p0, p1, p2, p3, steps=32):
    out = []
    for i in range(steps):
        t = i / steps
        mt = 1 - t
        out.append((mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0],
                    mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]))
    return out


def crown_polygon():
    """The fedora crown, CROWN in mascot.tsx."""
    return (cubic((13.5, 27), (13.8, 16.5), (19.5, 8.5), (26.5, 8.5))
            + quad((26.5, 8.5), (32, 11.5), (37.5, 8.5))[:-1]
            + cubic((37.5, 8.5), (44.5, 8.5), (50.2, 16.5), (50.5, 27)))


def quad(p0, c, p1, steps=24):
    return [
        ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
         (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1])
        for t in (i / steps for i in range(steps + 1))
    ]


class Canvas:
    """RGBA float canvas. `self.u` / `self.v` are each pixel's position in viewBox units (px = ox + u * s)."""

    def __init__(self, size, s, ox, oy):
        self.size = size
        self.s = s
        self.ox = ox
        self.oy = oy
        ys, xs = np.mgrid[0:size, 0:size].astype(np.float32) + 0.5
        # pixel centres in viewBox units
        self.u = (xs - ox) / s
        self.v = (ys - oy) / s
        self.rgb = np.zeros((size, size, 3), np.float32)
        self.a = np.zeros((size, size), np.float32)

    # --- signed distances, in viewBox units (negative inside) ---
    def d_segment(self, a, b, r):
        px, py = self.u - a[0], self.v - a[1]
        bx, by = b[0] - a[0], b[1] - a[1]
        h = np.clip((px * bx + py * by) / (bx * bx + by * by), 0, 1)
        return np.hypot(px - bx * h, py - by * h) - r

    def d_polyline(self, pts, r):
        d = None
        for a, b in zip(pts, pts[1:]):
            seg = self.d_segment(a, b, r)
            d = seg if d is None else np.minimum(d, seg)
        return d

    def d_polygon(self, pts):
        d = np.full(self.u.shape, np.inf, np.float32)
        inside = np.zeros(self.u.shape, bool)
        n = len(pts)
        for i in range(n):
            a, b = pts[i], pts[(i + 1) % n]
            d = np.minimum(d, self.d_segment(a, b, 0))
            cond = (self.v >= a[1]) != (self.v >= b[1])
            with np.errstate(divide='ignore', invalid='ignore'):
                xcross = a[0] + (self.v - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            inside ^= cond & (self.u < xcross)
        return np.where(inside, -d, d)

    def d_ellipse(self, cx, cy, rx, ry):
        k = np.hypot((self.u - cx) / rx, (self.v - cy) / ry)
        return (k - 1) * min(rx, ry)

    def d_circle(self, cx, cy, r):
        return np.hypot(self.u - cx, self.v - cy) - r

    def d_round_rect(self, x, y, w, h, r):
        cx, cy = x + w / 2, y + h / 2
        qx = np.abs(self.u - cx) - (w / 2 - r)
        qy = np.abs(self.v - cy) - (h / 2 - r)
        return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r

    # --- painting ---
    def coverage(self, d):
        """Anti-aliased coverage from a distance field in viewBox units."""
        return np.clip(0.5 - d * self.s, 0, 1)

    def paint(self, d, color, opacity=1.0, clip=None):
        cov = self.coverage(d) * opacity
        if clip is not None:
            cov = cov * clip
        c = np.array(color, np.float32) / 255
        self.rgb = self.rgb * (1 - cov[..., None]) + c * cov[..., None]
        self.a = self.a + cov * (1 - self.a)

    def erase(self, cov):
        self.rgb = self.rgb * (1 - cov[..., None])
        self.a = self.a * (1 - cov)

    def png(self):
        a = np.clip(self.a, 0, 1)
        # self.rgb holds premultiplied-ish "over black" colour; un-premultiply.
        with np.errstate(divide='ignore', invalid='ignore'):
            rgb = np.where(a[..., None] > 0, self.rgb / a[..., None], 0)
        out = np.dstack([np.clip(rgb, 0, 1), a])
        return encode_png((out * 255 + 0.5).astype(np.uint8))


def encode_png(pixels):
    h, w, _ = pixels.shape
    raw = b''.join(b'\x00' + pixels[y].tobytes() for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def paint_hat(cv, color, band=None, brim_ry=5.0, clip=None):
    hat = np.minimum(cv.d_ellipse(32, 27, 30, brim_ry), cv.d_polygon(crown_polygon()))
    cv.paint(hat, color, clip=clip)
    if band is not None:
        crown_cov = cv.coverage(cv.d_polygon(crown_polygon()))
        strip = cv.d_round_rect(10, 20, 44, 4.6, 0.01)
        cv.paint(strip, band, clip=crown_cov if clip is None else crown_cov * clip)


def paint_full_mascot(cv, clip=None, lens=True):
    """Full-detail idle mascot (no ground shadow: the icon crops the body)."""
    cv.paint(cv.d_ellipse(32, 41, 21, 17), COAT, clip=clip)
    for cx in (25, 39):
        cv.paint(cv.d_ellipse(cx, 42, 3.8, 5.4), EYE, clip=clip)
    paint_hat(cv, COAT, band=BAND, clip=clip)
    if lens:
        cv.paint(cv.d_segment((53, 56), (59, 63), 1.7), BAND, clip=clip)
        cv.paint(cv.d_circle(49.5, 51.5, 7.6), COAT, clip=clip)
        cv.paint(cv.d_circle(49.5, 51.5, 5), REC, clip=clip)
        cv.paint(cv.d_circle(47.8, 49.8, 1.3), (255, 255, 255), 0.7, clip=clip)


def paint_mini_glyph(cv, hat_color, eye_color, recording=False):
    """Tray detail: fedora + two eyes peeking under the brim (mascot.tsx `mono`)."""
    paint_hat(cv, hat_color, brim_ry=5.6)
    for cx in (25, 39):
        cv.paint(cv.d_ellipse(cx, 42, 3.8 * 1.25, 5.4 * 1.25), eye_color)
    if recording:
        # The coral light, cut out of the glyph so it reads at 18pt.
        cv.erase(cv.coverage(cv.d_circle(51, 50, 9)))
        cv.paint(cv.d_circle(51, 50, 7), REC)
