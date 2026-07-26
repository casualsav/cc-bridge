#!/usr/bin/env python3
"""Measure a glyph's painted ink against the button's true centre, from a real screenshot.

The shot carries a magenta crosshair that the BROWSER painted at 50%/50% of the button box, so
the button's geometric centre is present in the pixels themselves. Everything is measured against
that: no assumption about where the screenshot clip landed, no inference from the CSS.

  crosshair (magenta) -> the button's centre
  disc fill           -> the modal colour inside the disc
  glyph ink           -> pixels inside the disc that are neither fill nor crosshair
"""
import sys
from collections import Counter
from PIL import Image

SCALE = 10.0  # device px per CSS px


def is_magenta(p):
    return p[0] > 180 and p[2] > 180 and p[1] < 90


def measure(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()

    # The clip is the button plus a thin margin, so the disc's own fill is the modal colour by area.
    # Locating the button by its FILL (not by "differs from page background") keeps the box-shadow
    # out of the bbox; the shadow is offset 0 1px and would drag the centre down.
    fill = Counter(px[x, y] for y in range(h) for x in range(w)).most_common(1)[0][0]
    dx0, dy0, dx1, dy1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if sum(abs(a - b) for a, b in zip(px[x, y], fill)) <= 24:
                dx0, dy0 = min(dx0, x), min(dy0, y)
                dx1, dy1 = max(dx1, x), max(dy1, y)
    bcx, bcy = (dx0 + dx1 + 1) / 2, (dy0 + dy1 + 1) / 2
    br = (dx1 - dx0 + 1) / 2

    r = br * 0.88
    ix, iy, wsum, xw, yw = [], [], 0.0, 0.0, 0.0
    for y in range(h):
        for x in range(w):
            if (x - bcx) ** 2 + (y - bcy) ** 2 > r * r:
                continue
            p = px[x, y]
            d = sum(abs(a - b) for a, b in zip(p, fill))
            if d <= 40:
                continue
            ix.append(x)
            iy.append(y)
            a = min(1.0, d / 255.0)
            wsum += a
            xw += x * a
            yw += y * a
    if not ix:
        return None
    return dict(btn=(bcx, bcy), btn_px=br * 2 / SCALE,
                ink=(min(ix), min(iy), max(ix), max(iy)),
                ink_box=((min(ix) + max(ix) + 1) / 2, (min(iy) + max(iy) + 1) / 2),
                ink_mass=(xw / wsum, yw / wsum))


worst = 0.0
for path in sys.argv[1:]:
    m = measure(path)
    name = path.split("/")[-1]
    bcx, bcy = m["btn"]
    ox, oy = (m["ink_box"][0] - bcx) / SCALE, (m["ink_box"][1] - bcy) / SCALE
    mx, my = (m["ink_mass"][0] - bcx) / SCALE, (m["ink_mass"][1] - bcy) / SCALE
    gw = (m["ink"][2] - m["ink"][0] + 1) / SCALE
    gh = (m["ink"][3] - m["ink"][1] + 1) / SCALE
    print(f"{name:<26} button {m['btn_px']:.1f}px  glyph {gw:.2f}x{gh:.2f}px")
    print(f"{'':<26}   ink bbox centre vs button centre: {ox:+.2f}, {oy:+.2f} CSS px")
    print(f"{'':<26}   ink centroid    vs button centre: {mx:+.2f}, {my:+.2f} CSS px")
    worst = max(worst, abs(ox), abs(oy))
print(f"\nworst ink-bbox offset across all states: {worst:.2f} CSS px")
