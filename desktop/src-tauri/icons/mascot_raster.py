"""Signed-distance rasterizer for the Eavesy mascot (desktop/DESIGN.md §3).

Geometry mirrors web/src/components/launcher/ui/mascot.tsx and mascot.svg
(viewBox units, idle pose). Used by gen_icon.py and gen_tray.py; needs numpy.
"""

import struct
import zlib

import numpy as np

BODY = [  # cubic segments of the body path, viewBox units
    ((32, 15), (46.5, 15), (54, 27), (54, 40)),
    ((54, 40), (54, 51.5), (45, 58.5), (32, 58.5)),
    ((32, 58.5), (19, 58.5), (10, 51.5), (10, 40)),
    ((10, 40), (10, 27), (17.5, 15), (32, 15)),
]

INK = (0x2A, 0x22, 0x33)
HONEY = (0xF6, 0xB9, 0x3B)
SHADE = (0xE3, 0x9E, 0x1E)
ROOF = (0x4B, 0x3A, 0x78)
CHEEK = (0xF5, 0x9B, 0xA0)
HIGHLIGHT = (0xFF, 0xF8, 0xEE)
REC = (0xFF, 0x3B, 0x30)
PLASTER = (0xF3, 0xEC, 0xE3)


def body_polygon(steps=48):
    pts = []
    for p0, p1, p2, p3 in BODY:
        for i in range(steps):
            t = i / steps
            mt = 1 - t
            x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
            y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
            pts.append((x, y))
    return pts


def quad(p0, c, p1, steps=24):
    return [
        ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
         (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1])
        for t in (i / steps for i in range(steps + 1))
    ]


class Canvas:
    """RGBA float canvas. `to_px` maps viewBox units to pixels: px = ox + u * s."""

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


def paint_full_mascot(cv, clip=None):
    """Full-detail idle mascot (no ground shadow: the icon crops the body)."""
    body = cv.d_polygon(body_polygon())
    cv.paint(body, HONEY, clip=clip)
    body_cov = cv.coverage(body)
    band = cv.d_polyline([(8, 33.5), (32, 13.5), (56, 33.5)], 2.5)
    cv.paint(band, SHADE, 0.45, clip=body_cov if clip is None else body_cov * clip)
    for cx in (17.6, 46.4):
        cv.paint(cv.d_ellipse(cx, 44.6, 3.6, 2.2), CHEEK, 0.7, clip=clip)
    for cx in (24, 40):
        cv.paint(cv.d_ellipse(cx, 37.5, 3.2, 4.2), INK, clip=clip)
    for cx in (25.2, 41.2):
        cv.paint(cv.d_circle(cx, 35.8, 1.15), HIGHLIGHT, clip=clip)
    cv.paint(cv.d_polyline(quad((29.2, 45.4), (32, 48.2), (34.8, 45.4)), 0.9), INK, clip=clip)
    cv.paint(cv.d_round_rect(43, 9.5, 5.2, 10, 1.4), ROOF, clip=clip)
    roof = np.minimum(cv.d_segment((32, 9), (5, 31), 4), cv.d_segment((32, 9), (59, 31), 4))
    cv.paint(roof, ROOF, clip=clip)


def paint_mini_glyph(cv, roof_color, eye_color, recording=False):
    """Tray detail: roof chevron + two eye dots (mascot.tsx `mini`)."""
    roof = np.minimum(cv.d_segment((32, 9), (5, 31), 4.5), cv.d_segment((32, 9), (59, 31), 4.5))
    cv.paint(roof, roof_color)
    for cx in (24, 40):
        cv.paint(cv.d_ellipse(cx, 37.5, 3.2 * 1.35, 4.2 * 1.35), eye_color)
    if recording:
        # Porch light: a red dot on the roof peak, cut out of the roof so it reads at 18pt.
        cv.erase(cv.coverage(cv.d_circle(32, 9, 9.5)))
        cv.paint(cv.d_circle(32, 9, 7.5), REC)
