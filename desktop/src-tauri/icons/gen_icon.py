#!/usr/bin/env python3
import math
import struct
import zlib

N = 1024
RADIUS = 224
DOT_R = 176
BG = (17, 17, 19, 255)
DOT = (255, 59, 48, 255)

cx = cy = N / 2.0


def inside_rounded(x, y):
    rx = min(x, N - 1 - x)
    ry = min(y, N - 1 - y)
    if rx >= RADIUS or ry >= RADIUS:
        return True
    dx = RADIUS - rx
    dy = RADIUS - ry
    return dx * dx + dy * dy <= RADIUS * RADIUS


def aa_circle(x, y, r):
    d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
    if d <= r - 1:
        return 1.0
    if d >= r + 1:
        return 0.0
    return (r + 1 - d) / 2.0


rows = bytearray()
for y in range(N):
    rows.append(0)
    for x in range(N):
        if not inside_rounded(x, y):
            rows += bytes((0, 0, 0, 0))
            continue
        a = aa_circle(x, y, DOT_R)
        if a <= 0:
            rows += bytes(BG)
        else:
            r = int(BG[0] * (1 - a) + DOT[0] * a)
            g = int(BG[1] * (1 - a) + DOT[1] * a)
            b = int(BG[2] * (1 - a) + DOT[2] * a)
            rows += bytes((r, g, b, 255))


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
png += chunk(b"IEND", b"")

with open("icon-source.png", "wb") as f:
    f.write(png)
print("wrote icon-source.png")
