#!/usr/bin/env python3
"""Check the DEPLOYED site the way a phone would use it.

    python3 tools/live_check.py https://<user>.github.io/<repo>/

For every mix in docs/stations.json it requests the real URL with Range headers
(what Safari does for <audio>) and verifies: 206 + Content-Range with the right
total size, audio content type, sane Accept-Ranges and CORS headers, and that the
bytes at the start, middle and end are actually served. Exits non-zero on any
problem, so a broken release shows up red in CI instead of on the listener's phone.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
ORIGIN = "https://example-origin.invalid"


def fetch(url, rng=None, tries=6, origin=True):
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "burzh-live-check/1")
        if rng:
            req.add_header("Range", "bytes=%d-%d" % rng)
        if origin:
            req.add_header("Origin", ORIGIN)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read(2_000_000)
                return r.status, {k.lower(): v for k, v in r.headers.items()}, body
        except urllib.error.HTTPError as e:
            last = (e.code, {k.lower(): v for k, v in e.headers.items()}, b"")
            if e.code in (404, 502, 503) and attempt < tries - 1:
                time.sleep(10)  # CDN may still be propagating a fresh deploy
                continue
            return last
        except Exception as e:  # network hiccup
            last = (0, {"error": str(e)}, b"")
            time.sleep(5)
    return last


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    base = sys.argv[1].rstrip("/") + "/"
    problems = []
    data = json.loads((DOCS / "stations.json").read_text(encoding="utf-8"))
    media_base = data.get("mediaBase", "./media/").rstrip("/") + "/"
    media_base = media_base[2:] if media_base.startswith("./") else media_base

    status, headers, body = fetch(base + "stations.json", origin=False)
    live = json.loads(body) if status == 200 else {}
    print("stations.json:", status)
    if status != 200:
        problems.append("stations.json -> %s" % status)
    elif live != data:
        problems.append("stations.json on the site differs from the repository")

    for st in data["stations"]:
        for item in st.get("items", []):
            local = DOCS / "media" / item["file"] if (DOCS / "media").exists() else None
            if not local or not local.exists():
                continue  # audio hosted elsewhere
            size = local.stat().st_size
            url = base + media_base + item["file"]
            tag = "%s/%s" % (st["id"], Path(item["file"]).name)
            checks = [("start", (0, 1)), ("middle", (size // 2, size // 2 + 1023)), ("end", (size - 1024, size - 1))]
            for label, (a, b) in checks:
                status, h, body = fetch(url, (a, b))
                want = b - a + 1
                cr = h.get("content-range", "")
                ok = status == 206 and cr == "bytes %d-%d/%d" % (a, b, size) and len(body) == want
                print("  %-26s %-6s -> %s %s len=%d type=%s acao=%s ranges=%s" % (
                    tag, label, status, cr, len(body), h.get("content-type"), h.get("access-control-allow-origin"), h.get("accept-ranges")))
                if not ok:
                    problems.append("%s %s: got %s %s (%d bytes), expected 206 bytes %d-%d/%d" % (tag, label, status, cr, len(body), a, b, size))
            status, h, _ = fetch(url, (0, 1))
            ctype = (h.get("content-type") or "")
            if not (ctype.startswith("audio/") or ctype in ("video/mp4", "application/octet-stream")):
                problems.append("%s: unexpected content-type %r" % (tag, ctype))
            if h.get("access-control-allow-origin") not in ("*", ORIGIN):
                problems.append("%s: no CORS header (the sound engine needs it)" % tag)
            if h.get("accept-ranges") != "bytes":
                problems.append("%s: Accept-Ranges is %r" % (tag, h.get("accept-ranges")))

    if problems:
        print("\nPROBLEMS:")
        for p in problems:
            print(" -", p)
        sys.exit(1)
    print("\nLive site OK")


if __name__ == "__main__":
    main()
