#!/usr/bin/env python3
"""Render the launch screens ("splash") of the iPhone home-screen app.

While the app opens, iOS shows a startup image instead of a white page. Without one, every
launch starts with a white flash. This draws one image per iPhone screen size, in both orientations
and both system appearances (the same dark screen for both: the app has one dark design), and writes
the <link> tags into docs/index.html:

    python3 tools/make_splash.py

Outputs: docs/splash/<p|l>-<width>x<height>-<dark|light>.png and the block between the
"splash:start" and "splash:end" comments in docs/index.html.

iOS reads these images when the app is added to the Home Screen: after a change, remove the icon
and add it again. (It can only follow the system appearance, not the theme chosen inside the app.)
"""
from __future__ import annotations

import re
from pathlib import Path

from PIL import Image

from make_art import BG, DOCS

PLANET = DOCS / "planet" / "fallback.png"     # drawn by tools/make_art.py

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


def render(width: int, height: int, scheme: str) -> Image.Image:
    """The dark screen of the app with its planet in the middle (both appearances: the app has one dark design)."""
    img = Image.new("RGB", (width, height), BG)
    size = int(min(width, height) * 0.32)
    planet = Image.open(PLANET).convert("RGBA").resize((size, size), Image.LANCZOS)
    img.paste(planet, ((width - size) // 2, int(height * 0.47 - size / 2)), planet)
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
                img = render(iw, ih, scheme).quantize(colors=40, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
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
