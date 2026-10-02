#!/usr/bin/env python3
"""BURZH beats radio library tool.

Put your music into library/<station-id>/ and run:

    python3 tools/radio.py build

For every audio file this will:
  * normalise loudness to -14 LUFS (two-pass EBU R128), so all stations play
    at the same level — the web player cannot change volume on iPhone;
  * encode AAC 128 kbps .m4a with "faststart" (instant start, seeking, iOS
    background playback);
  * read an optional tracklist next to the file (same name, .txt or .cue) so
    the lock screen and StandBy show the real track inside a long mix;
  * update docs/stations.json with titles, durations and cues.

Other commands:
    python3 tools/radio.py validate   # check stations.json, media, icons, artwork
    python3 tools/radio.py list       # show stations and what is on them
    python3 tools/radio.py manifest   # refresh the app-icon shortcuts (long press) from stations.json

Requires ffmpeg + ffprobe on PATH for "build". "validate" uses only the
Python standard library (it runs in CI).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
import sys
import unicodedata
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
STATIONS = DOCS / "stations.json"
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".aif", ".aiff", ".ogg", ".opus"}
GLYPHS = {"grid", "wave", "rings", "tri"}

# A station's planet character ("look"). Same table as LIMITS in docs/planet.js (a browser check keeps them equal).
LOOK_LIMITS = {
    "spin": (0.2, 2.5), "rings": (1, 3), "spread": (0, 1.2), "tilt": (0.1, 0.9), "roll": (-1.4, 1.4),
    "grain": (0.7, 1.5), "land": (-0.06, 0.08), "halo": (0.5, 2), "pulse": (0, 2), "flutter": (0, 0.6),
    "rain": (0, 1), "comets": (1, 2),
}
BG_BLACK, BG_PAPER = "#050606", "#f1f1ee"      # the two app backgrounds (docs/index.html)
# GitHub refuses files over 100 MB. A mix whose encoded size would pass MAX_PART_BYTES is cut into equal parts at the
# quietest moment near each cut; the player keeps the parts of one mix together, in order (item "group").
MAX_PART_BYTES = 80_000_000
AAC_BYTES_PER_SECOND = 16_000 * 1.02            # 128 kbps plus container overhead


def luminance(hex_colour: str) -> float:
    def lin(c: int) -> float:
        v = c / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)
TARGET_LUFS = -14.0
TARGET_TP = -1.0
TARGET_LRA = 11.0


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def load() -> dict:
    return json.loads(STATIONS.read_text(encoding="utf-8"))


MANIFEST = DOCS / "manifest.webmanifest"


def shortcut_list(data: dict) -> list[dict]:
    """Long-press actions on the app icon (Android and desktop; iOS ignores them): one per station, stations with music first.
    Android shows four at most."""
    stations = sorted(data.get("stations", []), key=lambda st: 0 if st.get("items") else 1)[:4]
    return [{
        "name": st["name"],
        "short_name": st["name"],
        "description": "Tune to " + st["name"],
        "url": "./?station=" + st["id"],
        "icons": [{"src": "./icon-192.png", "sizes": "192x192", "type": "image/png"}],
    } for st in stations]


def sync_manifest(data: dict) -> bool:
    """Keep manifest.webmanifest's shortcuts in step with the stations. Returns True when the file changed."""
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    wanted = shortcut_list(data)
    if manifest.get("shortcuts") == wanted:
        return False
    manifest["shortcuts"] = wanted
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def save(data: dict) -> None:
    STATIONS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sync_manifest(data)


def slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return text or "mix"


def need(tool: str) -> None:
    if not shutil.which(tool):
        sys.exit(f"error: {tool} not found. Install ffmpeg (brew install ffmpeg / apt install ffmpeg).")


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags=title,artist",
               "-of", "json", str(path)]).stdout
    fmt = json.loads(out).get("format", {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    return {"duration": float(fmt.get("duration", 0)), "title": tags.get("title"), "artist": tags.get("artist")}


def file_hash(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pretty_title(stem: str) -> str:
    stem = re.sub(r"[_]+", " ", stem).strip()
    return stem[:1].upper() + stem[1:] if stem else "Untitled mix"


# ---------------------------------------------------------------------------
# tracklists
# ---------------------------------------------------------------------------

TIME_RE = re.compile(r"^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—.]?\s+(.+?)\s*$")


def to_seconds(stamp: str) -> float:
    parts = [int(p) for p in stamp.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts
    return h * 3600 + m * 60 + s


def split_artist(text: str) -> tuple[str, str]:
    for sep in (" - ", " – ", " — "):
        if sep in text:
            artist, title = text.split(sep, 1)
            return artist.strip(), title.strip()
    return "", text.strip()


def parse_txt(path: Path) -> list[dict]:
    cues = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = TIME_RE.match(line)
        if not m:
            continue
        artist, title = split_artist(m.group(2))
        cues.append({"at": to_seconds(m.group(1)), "title": title, "artist": artist})
    return cues


def parse_cue(path: Path) -> list[dict]:
    cues, track = [], None
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if line.upper().startswith("TRACK"):
            track = {"title": "", "artist": "", "at": 0.0}
            cues.append(track)
        elif track is not None and line.upper().startswith("TITLE"):
            track["title"] = line[5:].strip().strip('"')
        elif track is not None and line.upper().startswith("PERFORMER"):
            track["artist"] = line[9:].strip().strip('"')
        elif track is not None and line.upper().startswith("INDEX 01"):
            m, s, f = (int(x) for x in line.split()[-1].split(":"))
            track["at"] = m * 60 + s + f / 75
    return [c for c in cues if c["title"]]


def read_cues(source: Path) -> list[dict]:
    for ext, parser in ((".cue", parse_cue), (".txt", parse_txt)):
        candidate = source.with_suffix(ext)
        if candidate.exists():
            cues = sorted(parser(candidate), key=lambda c: c["at"])
            return [{"at": round(c["at"], 2), "title": c["title"], "artist": c["artist"]} for c in cues]
    return []


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def loudnorm_filter(src: Path) -> str:
    """Two-pass EBU R128: measure the whole file, then return a constant-gain filter (the same gain for every part)."""
    measure = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-vn",
         "-af", f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True)
    stats = json.loads(measure.stderr[measure.stderr.rindex("{"):measure.stderr.rindex("}") + 1])
    return (f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}"
            f":measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
            f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}"
            f":offset={stats['target_offset']}:linear=true")


def encode_aac(src: Path, dst: Path, filt: str, start: float | None = None, length: float | None = None) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.m4a")
    cmd = ["ffmpeg", "-hide_banner", "-y"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(src)]
    if length:
        cmd += ["-t", f"{length:.3f}"]
    cmd += ["-vn", "-af", filt, "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "128k",
            "-map_metadata", "-1", "-movflags", "+faststart", str(tmp)]
    run(cmd)
    tmp.replace(dst)


def quiet_point(src: Path, target: float, window: float = 90.0) -> float:
    """The quietest 400 ms within +-window seconds of `target`: a breakdown, not the middle of a drop."""
    from array import array
    start = max(0.0, target - window)
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{2 * window:.3f}",
         "-i", str(src), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True, check=True).stdout
    samples = array("h")
    samples.frombytes(raw[:len(raw) // 2 * 2])
    frame, span = 400, 8                                   # 50 ms frames, 8 of them = 400 ms
    energy = [sum(v * v for v in samples[i:i + frame]) for i in range(0, len(samples) - frame + 1, frame)]
    if len(energy) <= span:
        return target
    sums = [sum(energy[:span])]
    for i in range(span, len(energy)):
        sums.append(sums[-1] + energy[i] - energy[i - span])
    best = min(range(len(sums)), key=sums.__getitem__)
    return start + (best + span / 2) * frame / 8000


def encode_source(src: Path, out: Path, sid: str) -> list[str]:
    """Encode one library file to docs/media; a very long one becomes several parts. Returns the files made, in order."""
    base = f"{sid}/{slug(src.stem)}"
    seconds = probe(src)["duration"]
    parts = max(1, math.ceil(seconds * AAC_BYTES_PER_SECOND / MAX_PART_BYTES))
    filt = loudnorm_filter(src)
    if parts == 1:
        encode_aac(src, out / f"{base}.m4a", filt)
        return [f"{base}.m4a"]
    cuts = [0.0]
    for k in range(1, parts):
        cuts.append(max(cuts[-1] + 60, quiet_point(src, seconds * k / parts)))
    cuts.append(seconds)
    files = []
    for k in range(parts):
        rel = f"{base}-part{k + 1}.m4a"
        print(f"  part {k + 1}/{parts}: {cuts[k] / 60:.1f}–{cuts[k + 1] / 60:.1f} min")
        encode_aac(src, out / rel, filt, start=cuts[k], length=None if k == parts - 1 else cuts[k + 1] - cuts[k])
        files.append(rel)
    return files


def cues_between(cues: list[dict], start: float, end: float) -> list[dict]:
    """The tracklist of one part: times counted from the start of the part; the track already playing at the cut comes first."""
    inside = [dict(c, at=round(c["at"] - start, 2)) for c in cues if start <= c["at"] < end]
    before = [c for c in cues if c["at"] < start]
    if before and (not inside or inside[0]["at"] > 0.5):
        inside.insert(0, dict(before[-1], at=0.0))
    return inside


def mix_count(items: list[dict]) -> int:
    """Mixes on a station: the parts of one cut mix (same group) count once."""
    return len({it.get("group") or it.get("file") or it.get("url") for it in items})


def build(args: argparse.Namespace) -> None:
    need("ffmpeg")
    need("ffprobe")
    library = Path(args.library).resolve()
    out = Path(args.out).resolve()
    data = load()
    if args.media_base:
        data["mediaBase"] = args.media_base
    by_id = {s["id"]: s for s in data["stations"]}
    cache_path = library / ".radio-cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    if not library.exists():
        library.mkdir(parents=True)
        for sid in by_id:
            (library / sid).mkdir(exist_ok=True)
        print(f"Created {library.relative_to(ROOT)}/<station>/ folders. Drop audio files there and run build again.")
        return

    for folder in sorted(p for p in library.iterdir() if p.is_dir()):
        st = by_id.get(folder.name)
        if not st:
            print(f"skip {folder.name}/: no station with this id in stations.json")
            continue
        sources = sorted(p for p in folder.iterdir() if p.suffix.lower() in AUDIO_EXT)
        if not sources:
            continue
        built = []
        for src in sources:
            key = str(src.relative_to(library))
            digest = file_hash(src)
            entry = cache.get(key)
            if isinstance(entry, str):                     # older cache: one file per source
                entry = {"hash": entry, "files": [f"{st['id']}/{slug(src.stem)}.m4a"]}
            if entry and entry.get("hash") == digest and all((out / f).exists() for f in entry["files"]):
                files = entry["files"]
                print(f"ok     {', '.join(files)}")
            else:
                print(f"encode {src.relative_to(ROOT) if src.is_relative_to(ROOT) else src}")
                files = encode_source(src, out, st["id"])
                cache[key] = {"hash": digest, "files": files}
            meta = probe(src)
            title = meta["title"] or pretty_title(src.stem)
            cues = read_cues(src)
            start = 0.0
            for k, rel in enumerate(files):
                length = round(probe(out / rel)["duration"], 3)
                item = {
                    "file": rel,
                    "title": title if len(files) == 1 else f"{title} · {k + 1}/{len(files)}",
                    "duration": length,
                    "cues": cues_between(cues, start, start + length) if len(files) > 1 else cues,
                }
                if len(files) > 1:
                    item["group"] = slug(src.stem)
                if meta["artist"]:
                    item["artist"] = meta["artist"]
                built.append(item)
                start += length

        new_files = {b["file"] for b in built}
        new_groups = {b["group"] for b in built if b.get("group")}
        kept = [] if args.prune else [it for it in st.get("items", [])
                                      if it.get("file") not in new_files and it.get("group") not in new_groups]
        st["items"] = kept + built
        print(f"{st['name']}: {mix_count(st['items'])} mixes, {sum(i['duration'] for i in st['items']) / 3600:.1f} h on air")

    cache_path.write_text(json.dumps(cache, indent=2))
    save(data)
    print("stations.json updated. Commit docs/ (or upload the media folder if you host audio elsewhere).")


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------

def png_info(path: Path) -> tuple[int, int]:
    """Decode a PNG fully with the standard library; raises on any corruption."""
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, size = 8, bytearray(), None
    while pos < len(raw):
        length = struct.unpack(">I", raw[pos:pos + 4])[0]
        ctype = raw[pos + 4:pos + 8]
        body = raw[pos + 8:pos + 8 + length]
        crc = struct.unpack(">I", raw[pos + 8 + length:pos + 12 + length])[0]
        if zlib.crc32(ctype + body) & 0xFFFFFFFF != crc:
            raise ValueError(f"bad CRC in {ctype.decode(errors='replace')} chunk")
        if ctype == b"IHDR":
            size = struct.unpack(">II", body[:8])
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
        pos += 12 + length
    if not size or not idat:
        raise ValueError("missing IHDR/IDAT")
    zlib.decompress(bytes(idat))
    return size


def mp4_info(path: Path) -> dict:
    """Read the structure of an .m4a with the standard library only (no ffprobe needed in CI)."""
    import struct
    size = path.stat().st_size
    top: list[str] = []
    moov = b""
    with open(path, "rb") as f:
        pos = 0
        while pos < size:
            f.seek(pos)
            head = f.read(8)
            if len(head) < 8:
                break
            sz, kind = struct.unpack(">I4s", head)
            hdr = 8
            if sz == 1:
                sz = struct.unpack(">Q", f.read(8))[0]
                hdr = 16
            elif sz == 0:
                sz = size - pos
            if sz < hdr:
                raise ValueError("corrupt MP4 atom")
            top.append(kind.decode("latin1"))
            if kind == b"moov":
                f.seek(pos + hdr)
                moov = f.read(min(sz - hdr, 16_000_000))
            pos += sz

    def children(buf: bytes, start: int, end: int):
        i = start
        while i + 8 <= end:
            sz, kind = struct.unpack(">I4s", buf[i:i + 8])
            if sz < 8:
                break
            yield kind, i + 8, min(i + sz, end)
            i += sz

    def find(buf, start, end, name):
        for kind, a, b in children(buf, start, end):
            if kind == name:
                return a, b
        return None

    info = {"size": size, "top": top, "tracks": [], "duration": None}
    m = find(moov, 0, len(moov), b"mvhd") if moov else None
    if m:
        ver = moov[m[0]]
        if ver == 1:
            scale, dur = struct.unpack(">IQ", moov[m[0] + 20:m[0] + 32])
        else:
            scale, dur = struct.unpack(">II", moov[m[0] + 12:m[0] + 20])
        info["duration"] = dur / scale if scale else None
    for kind, a, b in children(moov, 0, len(moov)):
        if kind != b"trak":
            continue
        track = {"handler": None, "format": None}
        mdia = find(moov, a, b, b"mdia")
        if mdia:
            hdlr = find(moov, mdia[0], mdia[1], b"hdlr")
            if hdlr:
                track["handler"] = moov[hdlr[0] + 8:hdlr[0] + 12].decode("latin1")
            minf = find(moov, mdia[0], mdia[1], b"minf")
            stbl = find(moov, minf[0], minf[1], b"stbl") if minf else None
            stsd = find(moov, stbl[0], stbl[1], b"stsd") if stbl else None
            if stsd:
                track["format"] = moov[stsd[0] + 12:stsd[0] + 16].decode("latin1")
        info["tracks"].append(track)
    return info


def check_audio_file(path: Path, expected_seconds: float | None) -> tuple[list[str], list[str]]:
    """Problems that would make a phone refuse or stall on a mix. Returns (errors, notes)."""
    errors: list[str] = []
    notes: list[str] = []
    try:
        info = mp4_info(path)
    except Exception as e:  # noqa: BLE001
        return [f"not a readable MP4/M4A ({e})"], notes
    top = info["top"]
    if "moov" not in top or "mdat" not in top:
        errors.append("missing moov/mdat atoms")
    elif top.index("moov") > top.index("mdat"):
        errors.append("not faststart (moov after mdat): phones must download the whole file before playing; re-encode with -movflags +faststart")
    if any(t["handler"] == "vide" for t in info["tracks"]):
        errors.append("contains a video/cover track; rebuild it with `tools/radio.py build` (it strips it)")
    if not any(t["handler"] == "soun" and t["format"] == "mp4a" for t in info["tracks"]):
        errors.append("no AAC (mp4a) audio track")
    if expected_seconds and info["duration"] and abs(info["duration"] - expected_seconds) > 1.5:
        errors.append(f"duration in stations.json is {expected_seconds:.1f}s but the file is {info['duration']:.1f}s")
    mb = info["size"] / 1_000_000
    if info["size"] >= 95_000_000:
        errors.append(f"{mb:.0f} MB is too close to GitHub's 100 MB file limit; split the mix or host audio elsewhere")
    elif info["size"] >= 50_000_000:
        notes.append(f"{mb:.0f} MB (GitHub warns above 50 MB; fine for Pages, but consider external hosting for lots of music)")
    return errors, notes


def validate(_args: argparse.Namespace) -> None:
    errors: list[str] = []
    notes: list[str] = []
    try:
        data = load()
    except Exception as e:  # noqa: BLE001
        sys.exit(f"stations.json: {e}")

    media_base = data.get("mediaBase", "./media/")
    local_media = not re.match(r"^https?://", media_base)
    media_dir = (DOCS / media_base).resolve() if local_media else None
    ids = set()
    for st in data.get("stations", []):
        sid = st.get("id", "?")
        if sid in ids:
            errors.append(f"{sid}: duplicate id")
        ids.add(sid)
        if not re.fullmatch(r"[a-z0-9-]+", sid):
            errors.append(f"{sid}: id must be lowercase letters, digits and dashes")
        if not st.get("name"):
            errors.append(f"{sid}: missing name")
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", st.get("accent", "")):
            errors.append(f"{sid}: accent must look like #ff3b30")
        elif contrast(st["accent"], BG_BLACK) < 4.5:
            errors.append(f"{sid}: accent {st['accent']} is too dark for the Black background (contrast {contrast(st['accent'], BG_BLACK):.1f}, needs 4.5)")
        paper = st.get("accentPaper")
        if paper is not None:
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(paper)):
                errors.append(f"{sid}: accentPaper must look like #cc2f26")
            elif contrast(paper, BG_PAPER) < 4.5:
                errors.append(f"{sid}: accentPaper {paper} is too light for the White background (contrast {contrast(paper, BG_PAPER):.1f}, needs 4.5)")
        elif re.fullmatch(r"#[0-9a-fA-F]{6}", st.get("accent", "")):
            notes.append(f"{sid}: no accentPaper; on White the accent is darkened automatically")
        look = st.get("look", {})
        if not isinstance(look, dict):
            errors.append(f"{sid}: look must be an object")
            look = {}
        for key, val in look.items():
            if key not in LOOK_LIMITS:
                errors.append(f"{sid}: look.{key} is not a known setting ({', '.join(sorted(LOOK_LIMITS))})")
            elif isinstance(val, bool) or not isinstance(val, (int, float)) or not LOOK_LIMITS[key][0] <= val <= LOOK_LIMITS[key][1]:
                errors.append(f"{sid}: look.{key} must be a number from {LOOK_LIMITS[key][0]} to {LOOK_LIMITS[key][1]}")
        if st.get("glyph") not in GLYPHS:
            errors.append(f"{sid}: glyph must be one of {sorted(GLYPHS)}")
        art = st.get("art")
        if art:
            try:
                w, h = png_info(DOCS / art)
                if (w, h) != (1024, 1024):
                    errors.append(f"{sid}: artwork should be 1024x1024, got {w}x{h}")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{sid}: artwork {art}: {e}")
        closed, prev_group = set(), None
        for it in st.get("items", []):
            group = it.get("group")
            if group is not None and (not isinstance(group, str) or not group):
                errors.append(f"{sid}: {it.get('file')}: group must be a non-empty text")
            elif group != prev_group:
                if group in closed:
                    errors.append(f"{sid}: {it.get('file')}: the parts of group '{group}' must be listed one after another")
                if prev_group:
                    closed.add(prev_group)
                prev_group = group
            if not (it.get("file") or it.get("url")):
                errors.append(f"{sid}: item without file/url")
                continue
            if not isinstance(it.get("duration"), (int, float)) or it["duration"] <= 0:
                errors.append(f"{sid}: {it.get('file')}: duration must be > 0 seconds")
            if local_media and it.get("file") and not (media_dir / it["file"]).exists():
                errors.append(f"{sid}: missing media file {media_base}{it['file']}")
            elif local_media and it.get("file"):
                file_errors, file_notes = check_audio_file(media_dir / it["file"], it.get("duration"))
                errors.extend(f"{sid}: {it['file']}: {e}" for e in file_errors)
                notes.extend(f"{sid}: {it['file']}: {n}" for n in file_notes)
            last = -1.0
            for c in it.get("cues", []):
                if c.get("at", -1) < last or not c.get("title"):
                    errors.append(f"{sid}: {it.get('file')}: cues must have titles and ascending times")
                    break
                last = c["at"]

    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if manifest.get("shortcuts") != shortcut_list(data):
            errors.append("manifest.webmanifest: shortcuts are out of date; run `python3 tools/radio.py manifest`")
    except Exception as e:  # noqa: BLE001
        errors.append(f"manifest.webmanifest: {e}")

    expected = {"apple-touch-icon.png": (180, 180), "icon-192.png": (192, 192), "icon-512.png": (512, 512),
                "icon-maskable-512.png": (512, 512), "favicon-32.png": (32, 32)}
    for name, size in expected.items():
        try:
            got = png_info(DOCS / name)
            if got != size:
                errors.append(f"{name}: expected {size[0]}x{size[1]}, got {got[0]}x{got[1]}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")

    if notes:
        print("\n".join("· " + n for n in notes))
    if errors:
        print("\n".join("✗ " + e for e in errors))
        sys.exit(1)
    on_air = sum(1 for s in data["stations"] if s.get("items") or s.get("stream"))
    print(f"✓ {len(data['stations'])} stations ({on_air} on air), icons and artwork OK")


def manifest_cmd(_args: argparse.Namespace) -> None:
    changed = sync_manifest(load())
    print("manifest.webmanifest: shortcuts " + ("updated" if changed else "already up to date"))


def list_cmd(_args: argparse.Namespace) -> None:
    data = load()
    for st in data["stations"]:
        items = st.get("items", [])
        hours = sum(i.get("duration", 0) for i in items) / 3600
        state = "stream" if st.get("stream") else (f"{mix_count(items)} mixes · {hours:.1f} h" if items else "off air")
        print(f"{st['id']:<16} {st['name']:<16} {state}")
        for it in items:
            cues = f" · {len(it.get('cues', []))} cues" if it.get("cues") else ""
            print(f"    {it.get('file') or it.get('url')}  {it['duration'] / 60:.0f} min{cues}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="encode library/ into the radio and update stations.json")
    b.add_argument("--library", default=str(ROOT / "library"))
    b.add_argument("--out", default=str(DOCS / "media"), help="where encoded .m4a files go (default docs/media)")
    b.add_argument("--media-base", help="public URL of the media folder if audio is hosted outside GitHub Pages")
    b.add_argument("--prune", action="store_true", help="drop mixes that are no longer in library/")
    b.set_defaults(func=build)
    sub.add_parser("validate", help="check stations.json, media files, icons and artwork").set_defaults(func=validate)
    sub.add_parser("list", help="show stations").set_defaults(func=list_cmd)
    sub.add_parser("manifest", help="refresh the app-icon shortcuts in manifest.webmanifest from stations.json").set_defaults(func=manifest_cmd)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
