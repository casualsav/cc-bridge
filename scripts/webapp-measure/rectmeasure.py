#!/usr/bin/env python3
"""Ink bbox vs box centre for a RECTANGULAR button screenshotted exactly to its own rect.

The clip is the button, the button is a solid fill edge to edge, so every pixel that is not the
fill is glyph. No disc detection, no mask — the shape the disc-based measurer could not handle.
"""
import sys
from collections import Counter
from PIL import Image
SCALE = 10.0
for path in sys.argv[1:]:
    im = Image.open(path).convert("RGB"); w,h = im.size; px = im.load()
    fill = Counter(px[x,y] for y in range(h) for x in range(w)).most_common(1)[0][0]
    ink = [(x,y) for y in range(h) for x in range(w)
           if sum(abs(a-b) for a,b in zip(px[x,y],fill)) > 40]
    if not ink:
        print(f"{path.split('/')[-1]:<22} NO INK"); continue
    xs=[p[0] for p in ink]; ys=[p[1] for p in ink]
    cx,cy = w/2, h/2
    bx,by = (min(xs)+max(xs)+1)/2, (min(ys)+max(ys)+1)/2
    print(f"{path.split('/')[-1]:<22} box {w/SCALE:.0f}x{h/SCALE:.0f}px  "
          f"glyph {(max(xs)-min(xs)+1)/SCALE:.2f}x{(max(ys)-min(ys)+1)/SCALE:.2f}px")
    print(f"{'':<22}   ink bbox centre vs box centre: {(bx-cx)/SCALE:+.2f}, {(by-cy)/SCALE:+.2f} CSS px")
