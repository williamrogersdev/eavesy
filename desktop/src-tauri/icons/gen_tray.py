import math, struct, sys, zlib

def sd_round_rect(x, y, cx, cy, half, r):
    qx, qy = abs(x - cx) - (half - r), abs(y - cy) - (half - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

def render(size):
    u = size / 44.0
    c, half, r = size / 2, 17 * u, 9.5 * u
    stroke, dot = 3.4 * u, 7.2 * u
    ss = 4
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            hit = 0
            for sy in range(ss):
                for sx in range(ss):
                    x, y = px + (sx + .5) / ss, py + (sy + .5) / ss
                    ring = abs(sd_round_rect(x, y, c, c, half - stroke / 2, r - stroke / 2)) <= stroke / 2
                    if ring or math.hypot(x - c, y - c) <= dot:
                        hit += 1
            row += bytes([0, 0, 0, round(255 * hit / ss ** 2)])
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')

out = sys.argv[1]
open(f'{out}/tray.png', 'wb').write(render(44))
open(f'{out}/tray@2x.png', 'wb').write(render(88))
