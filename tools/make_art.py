#!/usr/bin/env python3
"""Render BURZH beats app icons and per-station artwork.

Everything is drawn procedurally in the dot-matrix style of the app, so the
images can be regenerated after adding a station or changing an accent colour:

    python3 tools/make_art.py

Outputs (all inside docs/):
    apple-touch-icon.png      180x180  iPhone home screen (opaque, iOS rounds it)
    icon-192.png / icon-512.png        PWA icons
    icon-maskable-512.png              Android adaptive icon (safe-zone padded)
    favicon-32.png                     browser tab
    art/<station-id>.png      1024x1024 lock screen / StandBy / Now Playing artwork
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
FONT_DOTO = DOCS / "fonts" / "doto.woff2"
FONT_MONO = DOCS / "fonts" / "plex-mono-latin-400.woff2"

BG = (5, 6, 6)
FG = (241, 241, 236)
MUTED = (139, 140, 134)
RED = (255, 59, 48)
SS = 4  # supersampling factor for smooth dots


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def font(path: Path, size: int, weight: int | None = None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(path), size)
    if weight is not None:
        try:
            f.set_variation_by_axes([weight])
        except Exception:
            pass
    return f


def canvas(size: int, lift=(26, 28, 27)) -> Image.Image:
    """Dark background with a soft light source at the top, like the app."""
    s = size * SS
    img = Image.new("RGB", (s, s), BG)
    glow = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(glow)
    r = int(s * 0.62)
    cx, cy = int(s * 0.52), int(s * 0.1)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.18))
    img.paste(Image.new("RGB", (s, s), lift), (0, 0), glow.point(lambda v: int(v * 0.55)))
    return img


def dot(d: ImageDraw.ImageDraw, x: float, y: float, r: float, color):
    d.ellipse((x - r, y - r, x + r, y + r), fill=color)


def glow_dot(img: Image.Image, x: float, y: float, r: float, color, strength=0.55):
    layer = Image.new("L", img.size, 0)
    ImageDraw.Draw(layer).ellipse((x - r * 2.0, y - r * 2.0, x + r * 2.0, y + r * 2.0), fill=int(255 * strength))
    layer = layer.filter(ImageFilter.GaussianBlur(r * 1.1))
    img.paste(Image.new("RGB", img.size, color), (0, 0), layer)
    dot(ImageDraw.Draw(img), x, y, r, color)


def background_grid(img: Image.Image, step: float, r: float, alpha=0.07):
    s = img.size[0]
    color = mix(BG, FG, alpha)
    d = ImageDraw.Draw(img)
    n = int(s / step)
    off = (s - (n - 1) * step) / 2
    for i in range(n):
        for j in range(n):
            dot(d, off + i * step, off + j * step, r, color)


# --------------------------------------------------------------------------
# App icon: dot-matrix "B" followed by the red beat dot
# --------------------------------------------------------------------------
B_MATRIX = [
    "11110",
    "10001",
    "10001",
    "11110",
    "10001",
    "10001",
    "11110",
]


def render_icon(size: int, scale: float = 1.0, grid=True) -> Image.Image:
    img = canvas(size)
    s = img.size[0]
    if grid:
        background_grid(img, s / 16, s * 0.0026)
    step = s * 0.09 * scale
    r = step * 0.4
    cols, rows = 6, 7  # five columns of the letter + the beat dot
    w = (cols - 1) * step
    h = (rows - 1) * step
    x0 = (s - w) / 2
    y0 = (s - h) / 2
    # Beat dot first, so its glow sits under the letter instead of tinting it.
    glow_dot(img, x0 + 5 * step, y0 + 6 * step, r * 1.08, RED, strength=0.4)
    d = ImageDraw.Draw(img)
    for row, line in enumerate(B_MATRIX):
        for col, bit in enumerate(line):
            if bit == "1":
                dot(d, x0 + col * step, y0 + row * step, r, FG)
    return img.resize((size, size), Image.LANCZOS)


# --------------------------------------------------------------------------
# Station artwork glyphs (drawn on a 1024 * SS canvas)
# --------------------------------------------------------------------------

def glyph_grid(img, accent, cx, cy, radius):
    """Halftone sphere lit from the top left."""
    d = ImageDraw.Draw(img)
    step = radius / 10.5
    lx, ly, lz = -0.55, -0.62, 0.56
    n = math.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / n, ly / n, lz / n
    k = int(radius / step) + 1
    for i in range(-k, k + 1):
        for j in range(-k, k + 1):
            x, y = i * step, j * step
            dist = math.hypot(x, y)
            if dist > radius:
                continue
            nx, ny = x / radius, y / radius
            nz = math.sqrt(max(0.0, 1 - nx * nx - ny * ny))
            light = max(0.0, nx * lx + ny * ly + nz * lz)
            rr = step * (0.08 + 0.38 * light ** 1.2)
            color = mix(accent, FG, light ** 3)
            dot(d, cx + x, cy + y, rr, mix(BG, color, 0.35 + 0.65 * light))


def glyph_wave(img, accent, cx, cy, radius):
    """Stacked dotted waves, like tape wobble."""
    d = ImageDraw.Draw(img)
    lines = 7
    span = radius * 2.15
    step = span / 46
    for li in range(lines):
        t = li / (lines - 1)
        base = cy + (t - 0.5) * radius * 1.45
        amp = radius * (0.06 + 0.2 * math.sin(math.pi * t))
        phase = li * 0.9
        centre = li == lines // 2
        for k in range(47):
            x = cx - span / 2 + k * step
            u = k / 46
            env = math.sin(math.pi * u)
            y = base + amp * env * math.sin(u * math.pi * 4 + phase)
            rr = step * (0.2 + 0.16 * env) * (1.25 if centre else 1)
            color = accent if centre else mix(BG, FG, 0.25 + 0.5 * env * (1 - abs(t - 0.5)))
            dot(d, x, y, rr, color)


def glyph_rings(img, accent, cx, cy, radius):
    """Two overlapping dotted circles with a lit lens between them."""
    d = ImageDraw.Draw(img)
    r = radius * 0.72
    c1 = (cx - r * 0.5, cy)
    c2 = (cx + r * 0.5, cy)
    step = r / 9
    k = int(radius / step) + 2
    for i in range(-k * 2, k * 2 + 1):
        for j in range(-k, k + 1):
            x, y = cx + i * step / 1.0, cy + j * step
            in1 = math.hypot(x - c1[0], y - c1[1]) <= r
            in2 = math.hypot(x - c2[0], y - c2[1]) <= r
            if in1 and in2:
                dot(d, x, y, step * 0.3, accent)
            elif in1 or in2:
                dot(d, x, y, step * 0.11, mix(BG, FG, 0.28))
    for c in (c1, c2):
        for a in range(0, 360, 4):
            rad = math.radians(a)
            dot(d, c[0] + r * math.cos(rad), c[1] + r * math.sin(rad), step * 0.2, FG)


def glyph_tri(img, accent, cx, cy, radius):
    """Dotted triangle rising to a glowing apex."""
    d = ImageDraw.Draw(img)
    side = radius * 2.0
    h = side * math.sqrt(3) / 2
    top = (cx, cy - h * 0.6)
    left = (cx - side / 2, cy + h * 0.4)
    right = (cx + side / 2, cy + h * 0.4)
    rows = 15
    for row in range(rows + 1):
        t = row / rows
        y = top[1] + (left[1] - top[1]) * t
        half = side / 2 * t
        count = row + 1
        for k in range(count):
            x = cx if count == 1 else cx - half + 2 * half * k / (count - 1)
            edge = k == 0 or k == count - 1 or row == rows
            heat = 1 - t
            if edge:
                dot(d, x, y, radius * 0.022, FG)
            else:
                dot(d, x, y, radius * (0.008 + 0.03 * heat), mix(BG, accent, 0.25 + 0.75 * heat))
    glow_dot(img, top[0], top[1] - radius * 0.02, radius * 0.045, accent, 0.7)


GLYPHS = {"grid": glyph_grid, "wave": glyph_wave, "rings": glyph_rings, "tri": glyph_tri}


def fit_font(text: str, path: Path, max_width: int, start: int, weight=None) -> ImageFont.FreeTypeFont:
    size = start
    while size > 10:
        f = font(path, size, weight)
        if f.getlength(text) <= max_width:
            return f
        size -= 4
    return font(path, size, weight)


def render_station(st: dict, size: int = 1024) -> Image.Image:
    accent = hex_rgb(st.get("accent", "#ff3b30"))
    img = canvas(size)
    s = img.size[0]
    background_grid(img, s / 32, s * 0.0011, alpha=0.06)
    d = ImageDraw.Draw(img)
    m = s * 0.07

    # header
    d.text((m, m), "BURZH beats", font=font(FONT_DOTO, int(s * 0.042), 700), fill=FG, anchor="lt")
    live = font(FONT_MONO, int(s * 0.024))
    d.text((s - m, m + s * 0.006), "LIVE", font=live, fill=FG, anchor="rt")
    lw = live.getlength("LIVE")
    glow_dot(img, s - m - lw - s * 0.02, m + s * 0.019, s * 0.008, accent)
    d = ImageDraw.Draw(img)
    d.line((m, m + s * 0.07, s - m, m + s * 0.07), fill=mix(BG, FG, 0.18), width=max(1, SS))

    # glyph
    GLYPHS.get(st.get("glyph", "grid"), glyph_grid)(img, accent, s / 2, s * 0.47, s * 0.27)
    d = ImageDraw.Draw(img)

    # footer
    name = st["name"].upper()
    nf = fit_font(name, FONT_DOTO, int(s - 2 * m), int(s * 0.115), 700)
    d.text((m, s - m - s * 0.075), name, font=nf, fill=FG, anchor="ls")
    tag = " / ".join(st.get("tagline", []))
    small = font(FONT_MONO, int(s * 0.022))
    d.text((m, s - m), tag, font=small, fill=MUTED, anchor="ls")
    d.text((s - m, s - m), "BURZH RADIO", font=small, fill=MUTED, anchor="rs")
    return img.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path, "PNG", optimize=True)
    # Never ship a PNG that cannot be decoded (the old icons were corrupt).
    with Image.open(path) as check:
        check.load()
    print(f"{path.relative_to(ROOT)}  {img.size[0]}x{img.size[1]}  {path.stat().st_size // 1024} KB")


def main():
    save(render_icon(180), DOCS / "apple-touch-icon.png")
    save(render_icon(192), DOCS / "icon-192.png")
    save(render_icon(512), DOCS / "icon-512.png")
    save(render_icon(512, scale=0.8), DOCS / "icon-maskable-512.png")
    save(render_icon(32, scale=1.25, grid=False), DOCS / "favicon-32.png")

    data = json.loads((DOCS / "stations.json").read_text(encoding="utf-8"))
    for st in data["stations"]:
        save(render_station(st), DOCS / "art" / f"{st['id']}.png")


if __name__ == "__main__":
    main()
