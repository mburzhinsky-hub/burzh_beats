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

Requires ffmpeg + ffprobe on PATH for "build". "validate" uses only the
Python standard library (it runs in CI).
"""
from __future__ import annotations

import argparse
import hashlib
import json
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
TARGET_LUFS = -14.0
TARGET_TP = -1.0
TARGET_LRA = 11.0


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def load() -> dict:
    return json.loads(STATIONS.read_text(encoding="utf-8"))


def save(data: dict) -> None:
    STATIONS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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

def loudnorm_encode(src: Path, dst: Path) -> None:
    measure = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-vn",
         "-af", f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True)
    stats = json.loads(measure.stderr[measure.stderr.rindex("{"):measure.stderr.rindex("}") + 1])
    filt = (f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}"
            f":measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
            f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}"
            f":offset={stats['target_offset']}:linear=true")
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.m4a")
    run(["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-vn", "-af", filt,
         "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "128k",
         "-map_metadata", "-1", "-movflags", "+faststart", str(tmp)])
    tmp.replace(dst)


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
            rel = f"{st['id']}/{slug(src.stem)}.m4a"
            dst = out / rel
            digest = file_hash(src)
            if cache.get(str(src.relative_to(library))) != digest or not dst.exists():
                print(f"encode {src.relative_to(ROOT) if src.is_relative_to(ROOT) else src} -> {rel}")
                loudnorm_encode(src, dst)
                cache[str(src.relative_to(library))] = digest
            else:
                print(f"ok     {rel}")
            info = probe(dst)
            meta = probe(src)
            item = {
                "file": rel,
                "title": meta["title"] or pretty_title(src.stem),
                "duration": round(info["duration"], 3),
                "cues": read_cues(src),
            }
            if meta["artist"]:
                item["artist"] = meta["artist"]
            built.append(item)

        new_files = {b["file"] for b in built}
        kept = [] if args.prune else [it for it in st.get("items", []) if it.get("file") not in new_files]
        st["items"] = kept + built
        print(f"{st['name']}: {len(st['items'])} mixes, {sum(i['duration'] for i in st['items']) / 3600:.1f} h on air")

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


def validate(_args: argparse.Namespace) -> None:
    errors: list[str] = []
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
        for it in st.get("items", []):
            if not (it.get("file") or it.get("url")):
                errors.append(f"{sid}: item without file/url")
                continue
            if not isinstance(it.get("duration"), (int, float)) or it["duration"] <= 0:
                errors.append(f"{sid}: {it.get('file')}: duration must be > 0 seconds")
            if local_media and it.get("file") and not (media_dir / it["file"]).exists():
                errors.append(f"{sid}: missing media file {media_base}{it['file']}")
            last = -1.0
            for c in it.get("cues", []):
                if c.get("at", -1) < last or not c.get("title"):
                    errors.append(f"{sid}: {it.get('file')}: cues must have titles and ascending times")
                    break
                last = c["at"]

    expected = {"apple-touch-icon.png": (180, 180), "icon-192.png": (192, 192), "icon-512.png": (512, 512),
                "icon-maskable-512.png": (512, 512), "favicon-32.png": (32, 32)}
    for name, size in expected.items():
        try:
            got = png_info(DOCS / name)
            if got != size:
                errors.append(f"{name}: expected {size[0]}x{size[1]}, got {got[0]}x{got[1]}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")

    if errors:
        print("\n".join("✗ " + e for e in errors))
        sys.exit(1)
    on_air = sum(1 for s in data["stations"] if s.get("items") or s.get("stream"))
    print(f"✓ {len(data['stations'])} stations ({on_air} on air), icons and artwork OK")


def list_cmd(_args: argparse.Namespace) -> None:
    data = load()
    for st in data["stations"]:
        items = st.get("items", [])
        hours = sum(i.get("duration", 0) for i in items) / 3600
        state = "stream" if st.get("stream") else (f"{len(items)} mixes · {hours:.1f} h" if items else "off air")
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
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
