#!/usr/bin/env python3
"""The BURZH beats planet: a cracked, rocky, black-and-white world.

Shared by tools/make_art.py (texture, icons, covers, launch screens). Everything is procedural and
seeded, so the same command always draws the same planet:

  * surface(width)  -> the equirectangular height map the app wraps around its WebGL sphere
                       (docs/planet/surface.jpg): plates, deep cracks, craters and grain;
  * render(...)     -> the lit sphere as an image, with the same light as docs/planet.js
                       (used for the icon, the lock-screen artwork and the launch screens).

Needs numpy, scipy and Pillow (only for regenerating the images; the app itself needs none of it).
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

# ---------------------------------------------------------------------------- noise


def _hash(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def value_noise(p: np.ndarray, seed: int) -> np.ndarray:
    """Smooth 3D value noise in [0, 1] for points p (N, 3)."""
    f = np.floor(p)
    t = p - f
    t = t * t * t * (t * (t * 6 - 15) + 10)
    i = f.astype(np.int64)
    out = 0.0
    for dx in (0, 1):
        wx = t[:, 0] if dx else 1 - t[:, 0]
        for dy in (0, 1):
            wy = t[:, 1] if dy else 1 - t[:, 1]
            for dz in (0, 1):
                wz = t[:, 2] if dz else 1 - t[:, 2]
                out = out + wx * wy * wz * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out


def fbm(p: np.ndarray, octaves: int, seed: int, lac=2.03, gain=0.5) -> np.ndarray:
    amp, total, norm = 1.0, 0.0, 0.0
    q = p.copy()
    for o in range(octaves):
        total = total + amp * value_noise(q, seed + o * 17)
        norm += amp
        amp *= gain
        q = q * lac + 3.17
    return total / norm


def ridged(p: np.ndarray, octaves: int, seed: int) -> np.ndarray:
    amp, total, norm = 1.0, 0.0, 0.0
    q = p.copy()
    for o in range(octaves):
        n = 1 - np.abs(value_noise(q, seed + o * 31) * 2 - 1)
        total = total + amp * n * n
        norm += amp
        amp *= 0.5
        q = q * 2.1 + 1.7
    return total / norm


def cells(points: np.ndarray, count: int, seed: int, jitter_warp: np.ndarray | None = None):
    """Distance to the nearest and second nearest of `count` random sites on the unit sphere."""
    rng = np.random.default_rng(seed)
    sites = rng.normal(size=(count, 3))
    sites /= np.linalg.norm(sites, axis=1, keepdims=True)
    q = points if jitter_warp is None else points + jitter_warp
    d, _ = cKDTree(sites).query(q, k=2, workers=-1)
    return d[:, 0], d[:, 1]


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------------------- surface


def sphere_points(width: int) -> np.ndarray:
    height = width // 2
    lon = (np.arange(width) + 0.5) / width * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(height) + 0.5) / height * np.pi
    lo, la = np.meshgrid(lon, lat)
    x = np.cos(la) * np.sin(lo)
    y = np.sin(la)
    z = np.cos(la) * np.cos(lo)
    return np.stack([x.ravel(), y.ravel(), z.ravel()], axis=1)


def surface(width: int = 2048, seed: int = 7) -> np.ndarray:
    """Height map (height = width / 2) in [0, 1]: raised plates split by deep cracks, craters, grain."""
    p = sphere_points(width)
    warp = (np.stack([fbm(p * 2.2, 4, seed + 1), fbm(p * 2.2 + 5.1, 4, seed + 2), fbm(p * 2.2 + 9.7, 4, seed + 3)], 1) - 0.5) * 0.16

    # continents: big soft relief
    base = fbm(p * 1.6 + warp * 2, 6, seed + 10)
    # plates: broken crust, each plate slightly tilted in height
    f1, f2 = cells(p, 90, seed + 20, warp * 1.8)
    edge = f2 - f1
    big_crack = (1 - smoothstep(0.0, 0.02, edge)) * smoothstep(0.35, 0.6, fbm(p * 4, 3, seed + 21))
    f1b, f2b = cells(p, 900, seed + 30, warp * 0.6)
    small_crack = (1 - smoothstep(0.0, 0.008, f2b - f1b)) * smoothstep(0.4, 0.65, fbm(p * 6, 3, seed + 31))
    # hairline fractures from ridged noise
    hair = smoothstep(0.82, 0.97, ridged(p * 9 + warp * 6, 4, seed + 40))
    # craters
    rng = np.random.default_rng(seed + 50)
    crater = np.zeros(len(p))
    centres = rng.normal(size=(70, 3))
    centres /= np.linalg.norm(centres, axis=1, keepdims=True)
    radii = rng.uniform(0.02, 0.11, size=70) ** 1.3 * 1.6
    tree = cKDTree(centres)
    near_d, near_i = tree.query(p, k=3, workers=-1)
    for k in range(3):
        r = radii[near_i[:, k]]
        x = near_d[:, k] / r
        bowl = np.where(x < 1, -(1 - x * x) * 0.9, 0)
        rim = np.exp(-((x - 1.0) ** 2) / 0.02) * 0.35
        crater += (bowl + rim) * np.clip(r * 6, 0.3, 1)
    grain = fbm(p * 38, 3, seed + 60)
    fine = fbm(p * 110, 2, seed + 70)

    rough = ridged(p * 3.2 + warp * 4, 6, seed + 90)
    bubbles = np.abs(fbm(p * 14 + warp * 8, 4, seed + 100) - 0.5)
    # "land": rough, cracked crust with sharp coasts; "sea": smooth dark basins (the face of the planet looks calm)
    land = smoothstep(0.40, 0.46, base + 0.08 * (fbm(p * 7 + warp * 5, 4, seed + 110) - 0.5))
    crust = (0.30 * rough + 0.12 * fbm(p * 5 + warp * 3, 5, seed + 80) - 0.16 * big_crack - 0.12 * small_crack
             - 0.12 * hair + 0.10 * grain - 0.12 * bubbles + 0.04 * fine)
    basin = 0.06 * fbm(p * 3 + warp, 4, seed + 120) + 0.02 * grain - 0.05 * hair
    h = 0.30 * land + land * crust + (1 - land) * basin + 0.06 * crater
    h = (h - np.percentile(h, 0.5)) / (np.percentile(h, 99.5) - np.percentile(h, 0.5))
    return np.clip(h, 0, 1).reshape(width // 2, width)


# ---------------------------------------------------------------------------- render


def shade_constants():
    """The light shared with docs/planet.js (keep the two in step)."""
    light = np.array([-0.55, 0.62, 0.42])
    return light / np.linalg.norm(light)


def render(height: np.ndarray, size: int, spin: float = 0.0, tilt: float = 0.32, glow: float = 1.0,
           planet: float = 0.74, background=(10, 10, 10)) -> np.ndarray:
    """RGB image (size x size, uint8) of the lit planet centred on a dark background."""
    H, W = height.shape
    R = size * planet / 2
    c = (size - 1) / 2
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float64)
    x = (xs - c) / R
    y = (c - ys) / R
    rr = x * x + y * y
    inside = rr <= 1
    z = np.sqrt(np.clip(1 - rr, 0, 1))
    # view space normal -> planet space (tilt around x, then spin around y)
    ct, st = np.cos(tilt), np.sin(tilt)
    px, py, pz = x, y * ct + z * st, -y * st + z * ct
    cs, sn = np.cos(spin), np.sin(spin)
    qx, qz = px * cs - pz * sn, px * sn + pz * cs
    lon = np.arctan2(qx, qz)
    lat = np.arcsin(np.clip(py, -1, 1))
    u = (lon / (2 * np.pi) + 0.5) * W
    v = (0.5 - lat / np.pi) * H

    def sample(uu, vv):
        u0 = np.floor(uu).astype(int) % W
        v0 = np.clip(np.floor(vv).astype(int), 0, H - 1)
        u1 = (u0 + 1) % W
        v1 = np.clip(v0 + 1, 0, H - 1)
        fu, fv = uu - np.floor(uu), vv - np.floor(vv)
        return ((height[v0, u0] * (1 - fu) + height[v0, u1] * fu) * (1 - fv)
                + (height[v1, u0] * (1 - fu) + height[v1, u1] * fu) * fv)

    h = sample(u, v)
    dhu = sample(u + 1, v) - sample(u - 1, v)
    dhv = sample(u, v + 1) - sample(u, v - 1)
    # bump the normal in screen space (good enough for a still image)
    k = 5.0 * W / 2048
    nx, ny, nz = x - dhu * k, y + dhv * k, z
    n = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9
    nx, ny, nz = nx / n, ny / n, nz / n
    L = shade_constants()
    diff = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
    hx, hy, hz = L[0], L[1], L[2] + 1.0                   # half vector (viewer at +z)
    hn = np.sqrt(hx * hx + hy * hy + hz * hz)
    spec = np.clip((nx * hx + ny * hy + nz * hz) / hn, 0, 1) ** 46
    albedo = 0.06 + 0.5 * h ** 1.4
    fres = (1 - z)
    side = np.clip(0.3 + 0.75 * (y * 0.75 - x * 0.35), 0.12, 1.15)
    rim = (fres ** 8 * 1.9 + fres ** 3 * 0.42) * side * glow
    edge_w = 0.55 + 0.45 * fres ** 1.2                      # light skims the surface near the limb
    col = (albedo * (0.03 + 1.45 * diff ** 1.5 * edge_w) + rim * (0.35 + 1.1 * h ** 1.3)
           + spec * (0.1 + 1.6 * h ** 2) * (0.3 + 0.7 * fres) * 0.9)
    col = np.where(inside, col, 0)
    # soft edge (anti-alias) and halo
    d = np.sqrt(rr)
    edge = np.clip((1 - d) * R, 0, 1)
    halo = np.exp(-np.clip(d - 1, 0, None) * 5.5) * np.clip(d - 0.98, 0, None) * 0 + np.where(d > 1, np.exp(-(d - 1) * 9) * 0.18 * glow, 0)
    img = np.clip(col * edge, 0, 1)
    bg = np.array(background, dtype=np.float64) / 255
    out = np.empty((size, size, 3))
    for ch in range(3):
        out[..., ch] = img + (1 - edge) * (bg[ch] + halo)
    return (np.clip(out, 0, 1) ** (1 / 1.1) * 255).astype(np.uint8)
