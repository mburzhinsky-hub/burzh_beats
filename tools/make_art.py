#!/usr/bin/env python3
"""Render every picture of BURZH beats: the planet's surface, the station tiles, icons and lock-screen art.

    python3 tools/make_art.py            # everything
    python3 tools/make_art.py --fast     # skip the (slow, ~1 min) planet surface if it already exists

Outputs (all inside docs/):
    planet/surface.jpg        2048x1024 height map the app wraps around its WebGL planet
    planet/fallback.png       the lit planet as a still picture (phones without WebGL)
    planet/tile-<id>.jpg      320x320 black-and-white texture of each station (the station tiles)
    art/<id>.png              1024x1024 lock screen / StandBy / Now Playing artwork
    apple-touch-icon.png      180x180 iPhone home screen icon
    icon-192.png / icon-512.png / icon-maskable-512.png / favicon-32.png

Needs numpy, scipy and Pillow. Everything is seeded, so a run always draws the same pictures.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import planetgen as pg

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
BG = (10, 10, 10)


def to_img(a: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def vignette(n: int, strength=0.55) -> np.ndarray:
    y, x = np.mgrid[0:n, 0:n] / (n - 1) * 2 - 1
    return 1 - strength * np.clip(np.sqrt(x * x + y * y) / 1.41, 0, 1) ** 2


def grain(n: int, seed: int, amount=0.035) -> np.ndarray:
    return np.random.default_rng(seed).normal(0, amount, (n, n))


# ------------------------------------------------------------------ station textures (tiles)

def tex_rain(n: int) -> np.ndarray:
    """Future Garage: night rain, streaks at three depths."""
    rng = np.random.default_rng(11)
    ss = 3
    N = n * ss
    img = Image.new("L", (N, N), 0)
    from PIL import ImageDraw
    layers = []
    for depth, count, blur, bright in ((0, 140, 5, 60), (1, 110, 2, 120), (2, 60, 0.6, 230)):
        lay = Image.new("L", (N, N), 0)
        d = ImageDraw.Draw(lay)
        for _ in range(count):
            x = rng.uniform(-0.1, 1.1) * N
            y = rng.uniform(-0.2, 1.0) * N
            length = rng.uniform(0.06, 0.28) * N * (0.6 + depth * 0.3)
            b = int(bright * rng.uniform(0.35, 1))
            d.line([(x, y), (x - length * 0.16, y + length)], fill=b, width=max(1, int(ss * (0.6 + depth * 0.5))))
        layers.append(lay.filter(ImageFilter.GaussianBlur(blur * ss)))
    acc = np.zeros((N, N))
    for lay in layers:
        acc = np.maximum(acc, np.asarray(lay, dtype=np.float64) / 255)
    small = np.asarray(Image.fromarray((acc * 255).astype(np.uint8)).resize((n, n), Image.LANCZOS), dtype=np.float64) / 255
    y = np.linspace(0, 1, n)[:, None]
    base = 0.05 + 0.08 * (1 - y) + 0.0 * small
    # a soft street light at the top right
    yy, xx = np.mgrid[0:n, 0:n] / n
    lamp = np.exp(-(((xx - 0.82) ** 2) + ((yy - 0.12) ** 2)) / 0.03) * 0.22
    return base + lamp + small * (0.75 + lamp * 2)


def tex_dune(n: int) -> np.ndarray:
    """Lo-Fi: a slow wave of sand, fine ripples, warm grain."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    crest = 0.62 - 0.22 * np.sin(xx * 2.6 + 0.4) - 0.08 * np.sin(xx * 6.1 + 1.3)
    above = yy < crest
    dist = crest - yy
    ripples = 0.5 + 0.5 * np.sin((yy - 0.3 * np.sin(xx * 3)) * 140 + np.sin(xx * 9) * 2)
    lit = np.where(above, np.exp(-dist * 7) * (0.55 + 0.35 * ripples), 0)
    face = np.where(~above, 0.05 + 0.18 * np.exp(-(yy - crest) * 5) * (0.6 + 0.4 * ripples), 0)
    edge = np.exp(-((yy - crest) * n / 1.6) ** 2) * 0.9
    return lit * 0.85 + face + edge + 0.04


def tex_silk(n: int) -> np.ndarray:
    """Deep House: ribbons of light, silky strands crossing in the dark."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    acc = np.zeros((n, n))
    rng = np.random.default_rng(5)
    for k in range(3):
        a, b, c, d = rng.uniform(0.08, 0.2), rng.uniform(2, 4), rng.uniform(0, 6), rng.uniform(0.25, 0.75)
        slope = rng.uniform(-0.6, 0.6)
        for s in range(14):
            off = (s - 7) * 0.006
            yc = d + slope * (xx - 0.5) + a * np.sin(b * xx + c + s * 0.05) + off
            w = 0.0025 + 0.001 * (s % 3)
            inten = 0.35 + 0.65 * np.exp(-((s - 7) / 4) ** 2)
            acc += np.exp(-((yy - yc) / w) ** 2) * inten * (0.4 + 0.6 * np.sin(xx * 3 + k) ** 2)
    glow = np.asarray(to_img(np.clip(acc * 0.4, 0, 1)).filter(ImageFilter.GaussianBlur(n / 40)), dtype=np.float64) / 255
    return 0.03 + np.clip(acc * 0.5, 0, 1) * 0.85 + glow * 0.6


def tex_grooves(n: int) -> np.ndarray:
    """Trance: the grooves of a record catching a band of light."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    cx, cy = -0.35, 1.45
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    ang = np.arctan2(yy - cy, xx - cx)
    grooves = 0.55 + 0.45 * np.sin(r * 520)
    band = np.exp(-((ang + 0.82 + 0.25 * (r - 1.2)) / 0.13) ** 2)
    band2 = np.exp(-((ang + 1.12) / 0.06) ** 2) * 0.5
    return 0.035 + grooves * (0.05 + 0.85 * band + 0.6 * band2) * (0.5 + 0.5 * np.clip((r - 0.8) * 2, 0, 1))


TEXTURES = {"future-garage": tex_rain, "lofi": tex_dune, "deep-house": tex_silk, "trance": tex_grooves}


def tile(station_id: str, n: int = 320) -> Image.Image:
    fn = TEXTURES.get(station_id, tex_grooves)
    a = fn(n) * vignette(n, 0.35) + grain(n, hash(station_id) % 1000, 0.02)
    return to_img(np.clip(a, 0, 1) ** 1.05).convert("L")


# ------------------------------------------------------------------ planet pictures

def planet_rgba(height: np.ndarray, size: int, spin: float, tilt=0.12) -> Image.Image:
    rgb = pg.render(height, size, spin=spin, tilt=tilt, background=(0, 0, 0), planet=0.74)
    lum = rgb.max(axis=2).astype(np.float64) / 255
    c = (size - 1) / 2
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / (size * 0.74 / 2)
    disc = np.clip((1 - d) * size * 0.37, 0, 1)                    # the planet itself is opaque
    alpha = np.maximum(disc, np.clip(lum * 3.2, 0, 1))
    out = np.dstack([rgb, (alpha * 255).astype(np.uint8)])
    return Image.fromarray(out, "RGBA")


def on_dark(height: np.ndarray, size: int, spin: float, planet: float) -> Image.Image:
    rgb = pg.render(height, size, spin=spin, tilt=0.12, background=BG, planet=planet)
    return Image.fromarray(rgb)


def save(img: Image.Image, path: Path, **kw):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, **kw)
    print(f"{path.relative_to(ROOT)}  {img.size[0]}x{img.size[1]}  {path.stat().st_size // 1024} KB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", help="reuse docs/planet/surface.jpg if it exists")
    args = ap.parse_args()
    surf = DOCS / "planet" / "surface.jpg"
    if args.fast and surf.exists():
        height = np.asarray(Image.open(surf).convert("L"), dtype=np.float64) / 255
    else:
        height = pg.surface(2048)
        save(to_img(height).convert("L"), surf, quality=88, optimize=True, progressive=True)
    small = np.asarray(Image.fromarray((height * 255).astype(np.uint8)).resize((1024, 512), Image.LANCZOS), dtype=np.float64) / 255

    save(planet_rgba(small, 640, spin=0.6), DOCS / "planet" / "fallback.png", optimize=True)

    stations = json.loads((DOCS / "stations.json").read_text(encoding="utf-8"))["stations"]
    for st in stations:
        save(tile(st["id"]), DOCS / "planet" / f"tile-{st['id']}.jpg", quality=86, optimize=True, progressive=True)
        face = float((st.get("look") or {}).get("face", 0))
        save(on_dark(height, 1024, spin=0.6 + face * 2 * math.pi, planet=0.66), DOCS / "art" / f"{st['id']}.png", optimize=True)

    icon = on_dark(small, 1024, spin=0.6, planet=0.8)
    for name, size in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512), ("favicon-32.png", 32)):
        save(icon.resize((size, size), Image.LANCZOS), DOCS / name, optimize=True)
    mask = on_dark(small, 1024, spin=0.6, planet=0.58)            # Android crops to a circle: keep it inside
    save(mask.resize((512, 512), Image.LANCZOS), DOCS / "icon-maskable-512.png", optimize=True)


if __name__ == "__main__":
    main()
