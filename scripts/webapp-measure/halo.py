#!/usr/bin/env python3
"""Is the chat title still legible now that it has no capsule under it?

Reads the band shots batch5.mjs writes and answers one question per line of the title: what is the
contrast between the glyph ink and the ground IMMEDIATELY around it, at the worst point along the
line. Worst point, not average -- a title is unreadable if one word is lost, and an average over a
line whose left half sits on flat page colour hides exactly that.

    python3 halo.py <outdir>            # e.g. batch5

VALIDATING THE INSTRUMENT, which is this harness's first rule. Every run measures the `*-flat`
shots first, where the lines sit over nothing but the page. There the answer is known from the CSS
alone -- it is the contrast the type was designed at -- so a probe that cannot reproduce it is a
probe whose numbers over a bubble mean nothing. Those lines print as CONTROL and the run refuses to
grade anything if they drift.

TWO THINGS THIS PROBE LEARNED THE HARD WAY, both of which produced confident wrong numbers first:

  1. INK IS THE KNOWN TEXT COLOUR, never "the biggest excursion in the crop". A halo IS an extreme
     excursion -- it is the ground's colour crowded around the glyph -- so an excursion-based probe
     measures halo-against-bubble on exactly the frames where the halo is working, and reports the
     fix as a regression. It did: the cwd line came back WORSE with the halo on than off.
  2. MEASURE THE TEXT'S BOX, not the element's. #dsub is a block spanning the whole title while its
     text is short and centred, so most of its element box is empty background, and empty background
     carrying nothing but the halo's outer bleed reported a 1.4:1 "worst case" on flat page colour.
     batch5.mjs writes a Range box over the glyph run for this reason.
"""
import json
import re
import sys
from pathlib import Path
from PIL import Image

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "batch5")
AA = 4.5           # WCAG AA for text at these sizes
SEGMENTS = 8       # word-scale slices along the line
# Summed per-channel RGB distance within which a pixel counts as this line's ink. Generous on
# purpose: at 11px and DPR 2 almost every pixel of a glyph is antialiased, and a tight threshold
# finds no ink at all rather than finding the wrong ink. It is still far below the distance from
# either the blue bubble (174 in dark, 228 in light) or the halo (484) to the cwd's own colour, so
# nothing but glyph can fall inside it.
INK_NEAR = 120
RING = (2, 5)      # the surround: pixels this far from ink, in px, and not ink themselves


def lum(px):
    def ch(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * ch(px[0]) + 0.7152 * ch(px[1]) + 0.0722 * ch(px[2])


def ratio(a, b):
    a, b = max(a, b), min(a, b)
    return (a + 0.05) / (b + 0.05)


def parse_rgb(s):
    """`rgb(146, 157, 170)` OR `color(srgb 0.573 0.616 0.667)`.

    The second form is not a curiosity: --hint-raised is a color-mix(), and Chromium reports a
    color-mix result in the color() syntax with 0-1 channels. Read as 0-255 it rounds to (1, 1, 1)
    and no pixel in the shot is within any threshold of it, which is how the cwd line came back as
    "no ink found" rather than as a wrong number.
    """
    n = [float(x) for x in re.findall(r"[\d.]+", s)[:3]]
    if s.strip().startswith("color(") or all(v <= 1.0 for v in n):
        n = [v * 255 for v in n]
    return tuple(int(round(v)) for v in n)


def line_contrast(img, rect, ink_rgb, dpr):
    """Worst-slice and median-slice ink-vs-surround contrast along one line of the title.

    SLICES, not columns: a single column at a glyph's edge is legitimately low-contrast on ANY
    ground -- that is what antialiasing is -- so a per-column worst case reports the same number
    over flat page colour as over a bright bubble, which is a probe that cannot tell them apart. A
    slice is about a word wide.

    The SURROUND is a ring 2-5px out from the ink, which is the honest ground whether or not there
    is a halo: with one, the ring is halo composited over whatever is passing, which is exactly what
    the eye has to separate the glyph from; without one, it is the bubble.
    """
    x0, y0 = int(rect["x"] * dpr) - 2, int(rect["y"] * dpr) - 2
    x1, y1 = int((rect["x"] + rect["width"]) * dpr) + 2, int((rect["y"] + rect["height"]) * dpr) + 2
    crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    w, h = crop.size
    px = crop.load()
    near = [[sum(abs(px[x, y][c] - ink_rgb[c]) for c in range(3)) for y in range(h)] for x in range(w)]
    ink = [[near[x][y] <= INK_NEAR for y in range(h)] for x in range(w)]
    out = []
    step = max(1, w // SEGMENTS)
    for sx in range(0, w, step):
        xs = range(sx, min(sx + step, w))
        core = [(x, y) for x in xs for y in range(h) if ink[x][y]]
        # A slice with no glyph in it is a gap between words, not a legibility failure.
        if len(core) < 12:
            continue
        ring = set()
        for x, y in core:
            for dx in range(-RING[1], RING[1] + 1):
                for dy in range(-RING[1], RING[1] + 1):
                    if max(abs(dx), abs(dy)) < RING[0]:
                        continue
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not ink[nx][ny]:
                        ring.add((nx, ny))
        if len(ring) < 12:
            continue
        ink_l = sorted(lum(px[x, y]) for x, y in core)
        ring_l = sorted(lum(px[x, y]) for x, y in ring)
        out.append(ratio(ink_l[len(ink_l) // 2], ring_l[len(ring_l) // 2]))
    if not out:
        return None, None
    out.sort()
    return out[0], out[len(out) // 2]


meta = json.loads((OUT / "rects.json").read_text())
rects, inks, dpr = meta["rects"], meta["inks"], meta["dpr"]

bad = 0
for theme in ("dark", "light"):
    print(f"\n{theme}")
    for line in ("name", "sub"):
        ink_rgb = parse_rgb(inks[theme][line])
        got = {}
        for label, path in (("flat (CONTROL)", OUT / f"5-{theme}-flat.png"),
                            ("over a bubble", OUT / f"5-{theme}-bubble.png"),
                            # Named for what it kills TODAY: the ramp. It killed the halo until the
                            # halo went (v0.4.160) and that made it identical to the row above it —
                            # a row that always agrees. The file name is left alone so old outdirs
                            # still read.
                            ("pill fill off", OUT / f"5-{theme}-bubble-nohalo.png")):
            if not path.exists():
                print(f"  {line:5s} {label:16s}  (no shot)")
                continue
            worst, med = line_contrast(Image.open(path), rects[line], ink_rgb, dpr)
            got[label] = worst
            if worst is None:
                print(f"  {line:5s} {label:16s}  no ink found — check INK_NEAR")
                bad += 1
                continue
            # "scrim off" is a FIXTURE control, not an AA row, and the difference took a wrong grade
            # to find: the first version required it to fall under AA, which the light theme's name
            # never does — black type on a blue bubble is 6.34:1 with no help at all. That is a fact
            # about the colours, not a broken frame. What must be true for the frame to mean anything
            # is that killing the ramp MOVES the number, i.e. something bright really is behind that
            # line. Graded below.
            tag = ("" if label == "flat (CONTROL)"
                   else f"  (floor removed — flat is {got.get('flat (CONTROL)', 0):.2f})" if label == "pill fill off"
                   else "  <- under AA" if worst < AA else "  ok")
            print(f"  {line:5s} {label:16s}  worst {worst:5.2f}:1   median {med:5.2f}:1{tag}")
        if got.get("flat (CONTROL)") is None or got["flat (CONTROL)"] < AA:
            # Two things produce this, and they are worth telling apart before believing either:
            # the probe is broken, or the page's own design contrast really is under AA on flat
            # ground. Running this against the pre-change page hits the second — the capsule's fill
            # put the cwd at 3.57:1 in the light theme, i.e. the capsule was never carrying that
            # line as well as it looked like it was.
            print("       !! the CONTROL is under AA on FLAT page colour — either the probe is wrong,")
            print("          or this page's own design contrast is. Check which before reading on.")
            bad += 1
        elif got.get("over a bubble") is not None and got["over a bubble"] < AA:
            bad += 1
        elif got.get("pill fill off") is not None and got["pill fill off"] > got["flat (CONTROL)"] * 0.9:
            # Whatever is carrying the line's contrast — the halo once, the near-solid ramp after it,
            # the restored pill's fill since 2026-07-30 — batch5.mjs removes THAT for this frame. Kill
            # the floor and the number must MOVE: if it stays at its flat-ground value, nothing bright
            # was behind that line and every "ok" above it is vacuous. This is the check that catches a
            # fixture scrolled to the wrong place, which no amount of AA grading can.
            print("       !! removing the title's contrast floor barely moved this line — nothing bright")
            print("          is behind it, so the numbers above measure flat page colour. Check the scroll.")
            bad += 1

print("\n" + ("FAILED — a title line is under AA over a bubble" if bad else "every title line clears AA over a bubble, in both themes"))
sys.exit(1 if bad else 0)
