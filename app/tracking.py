"""Track an object in a video (SAM 3.1) and turn its motion into a path for Animate objects.

The method of PxTicks' h3-motion ("Following an object"), rebuilt for this studio:

1. workflows.build_track: the clicked or named object is segmented on the first frame (SAM3_Detect) and followed
   through the clip (SAM3_VideoTrack, SAM3_TrackToMask). The frames are scaled down first (tracking doesn't need
   full size) and at most MAX_SECONDS are tracked, from the chosen start.
2. measure(): each frame's mask gives the object's area, centre (centre of mass) and box.
3. clean(): frames whose area or position jumps from their neighbours are dropped as misdetections, gaps are filled
   (held at the ends), and the result is smoothed with a local quadratic fit.
4. keys(): the smooth path is simplified into a few keys (Ramer-Douglas-Peucker), which Animate objects plays back
   through the same curve it uses for keys made by hand.

Positions are shares of the frame's width and height; size is relative to the object's size on the first frame.
"""
from __future__ import annotations

import json
import math
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from PIL import Image

from . import config, media

MAX_SECONDS = 15.0
TRACK_SHORT_SIDE = 512  # frames are tracked at this size (short side)
MEASURE_W = 256  # masks are measured at this width
TRACKS_FILE = config.DATA_DIR / "tracks.json"


def plan(ref: str, start: float) -> dict[str, Any]:
    """What to track: the clip's fps and size, the tracking size, the first frame and how many frames."""
    info = media.probe(ref)
    fps = float(info.get("fps") or 24.0)
    dur = float(info.get("duration") or 0)
    w, h = int(info.get("width") or 0), int(info.get("height") or 0)
    if not (w and h and dur):
        raise media.MediaError("Can't read that video's size or length")
    k = min(1.0, TRACK_SHORT_SIDE / min(w, h))
    tw, th = max(16, round(w * k / 2) * 2), max(16, round(h * k / 2) * 2)
    start = max(0.0, min(float(start), max(0.0, dur - 0.5)))
    first = int(round(start * fps))
    total = int(math.floor(dur * fps))
    count = max(2, min(total - first, int(MAX_SECONDS * fps)))
    return {"fps": fps, "width": w, "height": h, "tw": tw, "th": th, "k": tw / w, "start": first / fps, "first": first,
            "count": count, "duration": dur}


def measure(mask_video: Path, aspect: float) -> list[dict[str, float] | None]:
    """Per frame: area (share of the frame), centre of mass and box (shares of width / height), or None if empty."""
    exe = media.ffmpeg()
    if not exe:
        raise media.MediaError("ffmpeg isn't installed")
    W = MEASURE_W
    H = max(2, round(W / aspect / 2) * 2)
    r = subprocess.run([exe, "-nostdin", "-v", "error", "-i", str(mask_video), "-vf", f"scale={W}:{H}:flags=area",
                        "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, timeout=600, creationflags=media.NO_WINDOW)
    if r.returncode:
        raise media.MediaError((r.stderr or b"").decode("utf-8", "replace")[-300:] or "Couldn't read the tracking masks")
    size = W * H
    out: list[dict[str, float] | None] = []
    for i in range(len(r.stdout) // size):
        im = Image.frombytes("L", (W, H), r.stdout[i * size:(i + 1) * size]).point(lambda v: 255 if v >= 128 else 0)
        box = im.getbbox()
        if not box:
            out.append(None)
            continue
        cols = list(im.resize((W, 1), Image.Resampling.BOX).getdata())
        rows = list(im.resize((1, H), Image.Resampling.BOX).getdata())
        sc, sr = sum(cols), sum(rows)
        if not sc:
            out.append(None)
            continue
        out.append({"area": im.histogram()[255] / size,
                    "x": (sum(i * v for i, v in enumerate(cols)) / sc + 0.5) / W,
                    "y": (sum(i * v for i, v in enumerate(rows)) / sr + 0.5) / H,
                    "x0": box[0] / W, "y0": box[1] / H, "x1": box[2] / W, "y1": box[3] / H})
    return out


def _median(vals: list[float]) -> float:
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def clean(raw: list[dict[str, float] | None], fps: float) -> list[dict[str, Any]]:
    """Drop jumps, fill gaps, smooth. Each frame: t, x, y (centre), s (size vs the first good frame), ok."""
    n = len(raw)
    ok = [r is not None for r in raw]
    # 1. misdetections: area far from the neighbourhood's median, or a position off the straight line through the
    #    neighbours (a least-squares fit, so steady fast motion isn't mistaken for a jump) by over ~1.5 object sizes
    win = max(2, int(round(fps / 4)))

    def line_at(js: list[int], vals: list[float], i: int) -> float:
        mj, mv = sum(js) / len(js), sum(vals) / len(vals)
        var = sum((j - mj) ** 2 for j in js)
        slope = sum((j - mj) * (v - mv) for j, v in zip(js, vals)) / var if var else 0.0
        return mv + slope * (i - mj)

    for i, r in enumerate(raw):
        if not r:
            continue
        js = [j for j in range(max(0, i - win), min(n, i + win + 1)) if j != i and raw[j]]
        if len(js) < 3:
            continue
        ma = _median([raw[j]["area"] for j in js])
        px, py = line_at(js, [raw[j]["x"] for j in js], i), line_at(js, [raw[j]["y"] for j in js], i)
        if ma > 0 and not (0.4 < r["area"] / ma < 2.5):
            ok[i] = False
        elif math.hypot(r["x"] - px, r["y"] - py) > 0.04 + 1.5 * math.sqrt(ma):
            ok[i] = False
    good = [i for i in range(n) if ok[i]]
    if not good:
        raise media.MediaError("The object was lost on every frame: click right on it, or try a clearer frame to start from")
    # 2. the size measure: square root of the area, against the first good frames
    side = [math.sqrt(raw[i]["area"]) if ok[i] else 0.0 for i in range(n)]
    base = _median([side[i] for i in good[:3]]) or 1.0
    xs = [raw[i]["x"] if ok[i] else math.nan for i in range(n)]
    ys = [raw[i]["y"] if ok[i] else math.nan for i in range(n)]
    ss = [side[i] / base if ok[i] else math.nan for i in range(n)]
    # 3. gaps: straight lines between good frames, held before the first and after the last
    for arr in (xs, ys, ss):
        for i in range(n):
            if not math.isnan(arr[i]):
                continue
            a = max((j for j in good if j < i), default=None)
            b = min((j for j in good if j > i), default=None)
            if a is None:
                arr[i] = arr[b]
            elif b is None:
                arr[i] = arr[a]
            else:
                arr[i] = arr[a] + (arr[b] - arr[a]) * (i - a) / (b - a)
    # 4. smooth: a local quadratic fit (Savitzky-Golay, 7 frames), the ends left as they are
    def sg(arr: list[float]) -> list[float]:
        c = (-2, 3, 6, 7, 6, 3, -2)
        return [sum(c[k] * arr[i + k - 3] for k in range(7)) / 21 if 3 <= i < n - 3 else arr[i] for i in range(n)]
    xs, ys, ss = sg(xs), sg(ys), sg(ss)
    return [{"t": round(i / fps, 4), "x": xs[i], "y": ys[i], "s": max(0.05, ss[i]), "ok": ok[i]} for i in range(n)]


def keys(path: list[dict[str, Any]], tol: float = 0.008) -> list[dict[str, float]]:
    """A few keys that follow the path within `tol` (share of the frame), moves relative to the first frame."""
    if not path:
        return []
    x0, y0 = path[0]["x"], path[0]["y"]
    pts = [(p["t"], p["x"] - x0, p["y"] - y0, p["s"]) for p in path]

    def err(i: int, a: int, b: int) -> float:
        ta, tb = pts[a][0], pts[b][0]
        u = (pts[i][0] - ta) / (tb - ta) if tb > ta else 0
        return max(abs(pts[i][d] - (pts[a][d] + (pts[b][d] - pts[a][d]) * u)) * (0.5 if d == 3 else 1) for d in (1, 2, 3))

    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        i, e = max(((i, err(i, a, b)) for i in range(a + 1, b)), key=lambda q: q[1])
        if e > tol:
            keep.add(i)
            stack += [(a, i), (i, b)]
    return [{"t": pts[i][0], "x": round(pts[i][1], 5), "y": round(pts[i][2], 5), "s": round(pts[i][3], 4)} for i in sorted(keep)]


# ------------------------------------------------------------------ saved paths (data/tracks.json)

def _load() -> list[dict[str, Any]]:
    try:
        return json.loads(TRACKS_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return []


def list_saved() -> list[dict[str, Any]]:
    return sorted(_load(), key=lambda t: -t.get("created", 0))


def save(entry: dict[str, Any]) -> dict[str, Any]:
    items = _load()
    entry = {**entry, "id": uuid.uuid4().hex[:10], "created": time.time()}
    items.append(entry)
    TRACKS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = TRACKS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=1), "utf-8")
    tmp.replace(TRACKS_FILE)
    return entry


def delete(track_id: str) -> bool:
    items = _load()
    keep = [t for t in items if t.get("id") != track_id]
    if len(keep) == len(items):
        return False
    tmp = TRACKS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(keep, indent=1), "utf-8")
    tmp.replace(TRACKS_FILE)
    return True
