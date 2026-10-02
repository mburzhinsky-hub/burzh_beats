#!/usr/bin/env python3
"""Render the launch screens ("splash") of the iPhone home-screen app.

While the app opens, iOS shows a startup image instead of a white page. Without one, every
launch starts with a white flash, even in the Black theme. This draws one image per iPhone
screen size, in both orientations and both system appearances (dark: the Black theme, light:
the White paper theme), and writes the <link> tags into docs/index.html:

    python3 tools/make_splash.py

Outputs: docs/splash/<p|l>-<width>x<height>-<dark|light>.png and the block between the
"splash:start" and "splash:end" comments in docs/index.html.

iOS reads these images when the app is added to the Home Screen: after a change, remove the icon
and add it again. (It can only follow the system appearance, not the theme chosen inside the app.)
"""
from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

from make_art import B_MATRIX, BG, DOCS, FG, RED, hex_rgb, mix

PAPER = hex_rgb("#F1F1EE")
INK = hex_rgb("#111111")
RED_PAPER = hex_rgb("#CC2F26")
SS = 3

# (CSS width, CSS height, pixel ratio) of the iPhones that can run the app, portrait.
DEVICES = [
    (375, 667, 2),    # SE (2nd, 3rd gen), 8
    (414, 736, 3),    # 8 Plus
    (375, 812, 3),    # X, XS, 11 Pro, 12 mini, 13 mini
    (414, 896, 2),    # XR, 11
    (414, 896, 3),    # XS Max, 11 Pro Max
    (390, 844, 3),    # 12, 12 Pro, 13, 13 Pro, 14
    (428, 926, 3),    # 12 Pro Max, 13 Pro Max, 14 Plus
    (393, 852, 3),    # 14 Pro, 15, 15 Pro, 16
    (430, 932, 3),    # 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
    (402, 874, 3),    # 16 Pro, 17, 17 Pro
    (420, 912, 3),    # Air
    (440, 956, 3),    # 16 Pro Max, 17 Pro Max
]


def mark(scheme: str, step: float) -> Image.Image:
    """The app icon's dot-matrix B and the beat dot, on a transparent patch."""
    pad = step * 2.2
    cols, rows = 6, 7
    w, h = (cols - 1) * step + 2 * pad, (rows - 1) * step + 2 * pad
    big = Image.new("RGBA", (int(w * SS), int(h * SS)), (0, 0, 0, 0))
    r = step * 0.4 * SS
    dark = scheme == "dark"
    ink, accent = (FG, RED) if dark else (INK, RED_PAPER)
    ox, oy = pad * SS, pad * SS
    st = step * SS
    bx, by = ox + 5 * st, oy + 6 * st
    if dark:   # soft glow under the beat dot, like the icon
        glow = Image.new("L", big.size, 0)
        ImageDraw.Draw(glow).ellipse((bx - r * 2.2, by - r * 2.2, bx + r * 2.2, by + r * 2.2), fill=105)
        glow = glow.filter(ImageFilter.GaussianBlur(r * 1.1))
        big.paste(Image.new("RGBA", big.size, accent + (255,)), (0, 0), glow)
    d = ImageDraw.Draw(big)
    d.ellipse((bx - r * 1.08, by - r * 1.08, bx + r * 1.08, by + r * 1.08), fill=accent + (255,))
    for row, line in enumerate(B_MATRIX):
        for col, bit in enumerate(line):
            if bit == "1":
                x, y = ox + col * st, oy + row * st
                d.ellipse((x - r, y - r, x + r, y + r), fill=ink + (255,))
    return big.resize((int(w), int(h)), Image.LANCZOS)


def render(width: int, height: int, scheme: str) -> Image.Image:
    img = Image.new("RGB", (width, height), BG if scheme == "dark" else PAPER)
    m = mark(scheme, min(width, height) * 0.05)
    img.paste(m, ((width - m.width) // 2, int(height * 0.46 - m.height / 2)), m)
    return img


def tag(w: int, h: int, dpr: int, orient: str, scheme: str, name: str) -> str:
    media = (f"(device-width: {w}px) and (device-height: {h}px) and (-webkit-device-pixel-ratio: {dpr}) "
             f"and (orientation: {orient}) and (prefers-color-scheme: {scheme})")
    return f'<link rel="apple-touch-startup-image" media="{media}" href="./splash/{name}">'


def main() -> None:
    out = DOCS / "splash"
    out.mkdir(exist_ok=True)
    for old in out.glob("*.png"):
        old.unlink()
    tags, total = [], 0
    for w, h, dpr in DEVICES:
        pw, ph = w * dpr, h * dpr
        # iOS keeps device-width/height at the portrait values in landscape; only the image is turned.
        for orient, (iw, ih) in (("portrait", (pw, ph)), ("landscape", (ph, pw))):
            for scheme in ("dark", "light"):
                name = f"{orient[0]}-{iw}x{ih}-{scheme}.png"
                # A flat colour with one small mark: a palette keeps each file to a few KB.
                img = render(iw, ih, scheme).quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
                img.save(out / name, "PNG", optimize=True)
                with Image.open(out / name) as check:
                    check.load()
                total += (out / name).stat().st_size
                tags.append(tag(w, h, dpr, orient, scheme, name))
    block = "<!-- splash:start (written by tools/make_splash.py) -->\n" + "\n".join(tags) + "\n<!-- splash:end -->"
    page = DOCS / "index.html"
    html = page.read_text(encoding="utf-8")
    if "<!-- splash:start" in html:
        html = re.sub(r"<!-- splash:start.*?<!-- splash:end -->", lambda _m: block, html, flags=re.S)
    else:
        anchor = '<link rel="icon" type="image/png" sizes="32x32"'
        assert anchor in html, "cannot find where to put the splash links"
        html = html.replace(anchor, block + "\n" + anchor, 1)
    page.write_text(html, encoding="utf-8")
    print(f"{len(tags)} launch images, {total // 1024} KB in docs/splash/, links written to docs/index.html")


if __name__ == "__main__":
    main()
