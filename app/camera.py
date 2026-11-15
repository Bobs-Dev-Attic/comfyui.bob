"""Virtual camera moves on the timeline's Camera track.

The picture is treated as a flat card in 3D (ideas from Reshoot 4D by itsmetamike, AGPL-3.0:
ideas only, no code). A pinhole camera looks at the card from a distance equal to the frame's
longer side; a move is pan / tilt / roll (the camera turning), truck / pedestal / dolly (the
camera travelling), orbit (circling the card) and zoom (focal length), keyframed over the clip,
with optional handheld shake.

Each frame, the card's four corners are projected through the camera and ffmpeg's `perspective`
filter maps the picture onto them. That is exact for a flat picture: there is no parallax inside
it, and areas the move uncovers come out transparent (filled black or with a blurred copy). The
AI reshoot (jobs engine "reshoot") uses the same warp to make guide frames plus masks of the
uncovered areas, fills them with FLUX Klein and has MiniMax H3 regenerate the shot.
"""
from __future__ import annotations

import math
from typing import Any

PARAMS = ("pan", "tilt", "roll", "zoom", "dolly", "truck", "pedestal", "orbit")
NEUTRAL = {"pan": 0.0, "tilt": 0.0, "roll": 0.0, "zoom": 1.0, "dolly": 0.0, "truck": 0.0, "pedestal": 0.0, "orbit": 0.0}


def _ease(u: float, e: str) -> float:
    return 0.0 if e == "hold" else u if e == "linear" else u * u * (3 - 2 * u)


def params_at(move: Any, s: float, local: float) -> dict[str, float]:
    """Camera parameters at source time s (local = seconds since the clip's start, for shake)."""
    keys = sorted(move.keys, key=lambda k: k.t)
    p: dict[str, float] = {}
    for name in PARAMS:
        base = float(getattr(move, name))
        if not keys:
            p[name] = base
            continue
        pts = [(k.t, float(getattr(k, name) if getattr(k, name) is not None else base), k.ease) for k in keys]
        if s <= pts[0][0]:
            p[name] = pts[0][1]
        elif s >= pts[-1][0]:
            p[name] = pts[-1][1]
        else:
            for (t0, v0, e), (t1, v1, _) in zip(pts, pts[1:]):
                if s < t1:
                    p[name] = v0 + (v1 - v0) * _ease((s - t0) / max(1e-9, t1 - t0), e)
                    break
    sh = float(move.shake or 0)
    if sh > 0:  # handheld: a few incommensurate sines, the same in the preview
        t = local
        p["pan"] += sh * 1.2 * (math.sin(t * 1.9) + 0.5 * math.sin(t * 4.3 + 1))
        p["tilt"] += sh * 0.9 * (math.sin(t * 2.3 + 2) + 0.5 * math.sin(t * 5.1))
        p["roll"] += sh * 0.6 * math.sin(t * 1.3 + 0.5)
    return p


def _rot(p: dict[str, float]) -> list[list[float]]:
    def ry(a: float) -> list[list[float]]:
        c, s = math.cos(a), math.sin(a)
        return [[c, 0, s], [0, 1, 0], [-s, 0, c]]

    def rx(a: float) -> list[list[float]]:
        c, s = math.cos(a), math.sin(a)
        return [[1, 0, 0], [0, c, -s], [0, s, c]]

    def rz(a: float) -> list[list[float]]:
        c, s = math.cos(a), math.sin(a)
        return [[c, -s, 0], [s, c, 0], [0, 0, 1]]

    def mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

    d = math.radians
    return mul(mul(mul(ry(d(p["orbit"])), ry(d(p["pan"]))), rx(d(p["tilt"]))), rz(d(p["roll"])))


def corners(p: dict[str, float], W: float, H: float, pad: float = 0.0) -> list[tuple[float, float]]:
    """Where the card's corners (top-left, top-right, bottom-left, bottom-right, grown by `pad`
    pixels) land in a W×H frame. Mirrors cameraCorners() in static/timeline.js."""
    D = max(W, H)
    F = D * float(p["zoom"])
    R = _rot(p)
    pos0 = (p["truck"] * W, -p["pedestal"] * H, -D * (1 - p["dolly"]))
    o = math.radians(p["orbit"])
    pos = (math.cos(o) * pos0[0] + math.sin(o) * pos0[2], pos0[1], -math.sin(o) * pos0[0] + math.cos(o) * pos0[2])
    out = []
    for X, Y in ((-W / 2 - pad, -H / 2 - pad), (W / 2 + pad, -H / 2 - pad), (-W / 2 - pad, H / 2 + pad), (W / 2 + pad, H / 2 + pad)):
        v = (X - pos[0], Y - pos[1], 0 - pos[2])
        xc = [R[0][i] * v[0] + R[1][i] * v[1] + R[2][i] * v[2] for i in range(3)]  # Rᵀ·v
        z = max(xc[2], D * 0.05)
        out.append((F * xc[0] / z + W / 2, F * xc[1] / z + H / 2))
    return out


def clips_of(tl: Any) -> list[Any]:
    cams = {t.id for t in tl.tracks if t.kind == "camera" and not t.hidden}
    return sorted((c for c in tl.clips if c.track in cams and c.kind == "camera" and c.cam and c.trim_out > c.trim_in),
                  key=lambda c: c.start)


def active(tl: Any) -> bool:
    return bool(clips_of(tl))


def _tree(segs: list[tuple[int, int, float, float]]) -> str:
    """Balanced if-tree over frame segments [(n0, n1, v0, v1)], linear inside each, on `in`."""
    if len(segs) == 1:
        n0, n1, v0, v1 = segs[0]
        if abs(v1 - v0) < 1e-4 or n1 <= n0:
            return f"{v0:.2f}"
        return f"({v0:.2f}+({v1 - v0:.3f})*(in-{n0})/{n1 - n0})"
    mid = len(segs) // 2
    return f"if(lt(in,{segs[mid][0]}),{_tree(segs[:mid])},{_tree(segs[mid:])})"


def perspective_filter(tl: Any, W: int, H: int, fps: float, step: int = 3) -> str:
    """A filter chain for the composited picture (frame n = timeline time n/fps) applying every
    camera clip, or "" when there's none. Uncovered areas end up transparent."""
    cams = clips_of(tl)
    if not cams:
        return ""
    pad = 2
    Wp, Hp = W + 2 * pad, H + 2 * pad
    ident = [(0.0, 0.0), (Wp, 0.0), (0.0, Hp), (Wp, Hp)]
    total = int(math.ceil(max(c.end for c in tl.clips) * fps)) + 2
    # corner positions at sample frames inside camera clips; identity elsewhere
    segs: list[list[tuple[int, int, float, float]]] = [[] for _ in range(8)]
    cursor = 0

    def flat(n0: int, n1: int) -> None:
        for k in range(8):
            v = ident[k // 2][k % 2]
            segs[k].append((n0, n1, v, v))

    for c in cams:
        a, b = int(round(c.start * fps)), int(round(c.end * fps))
        a = max(a, cursor)
        if b <= a:
            continue
        if a > cursor:
            flat(cursor, a)
        frames = list(range(a, b, step)) + [b]
        pts = []
        for n in frames:
            local = n / fps - c.start
            s = c.trim_in + local
            cs = corners(params_at(c.cam, s, local), W, H, pad)
            pts.append([(x + pad, y + pad) for x, y in cs])
        for (n0, c0), (n1, c1) in zip(zip(frames, pts), list(zip(frames, pts))[1:]):
            for k in range(8):
                segs[k].append((n0, n1, c0[k // 2][k % 2], c1[k // 2][k % 2]))
        cursor = b
    flat(cursor, max(total, cursor + 1))
    names = ["x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3"]
    opts = ":".join(f"{names[k]}='{_tree(segs[k])}'" for k in range(8))
    return (f"format=yuva420p,pad={Wp}:{Hp}:{pad}:{pad}:color=black@0,"
            f"perspective={opts}:sense=destination:eval=frame,crop={W}:{H}:{pad}:{pad}")


def fill_of(tl: Any) -> str:
    cams = clips_of(tl)
    return "blur" if any(getattr(c.cam, "fill", "black") == "blur" for c in cams) else "black"


def static_filter(move: Any, s: float, local: float, W: int, H: int) -> str:
    """One frame's warp (for guide frames): same as perspective_filter, constant corners."""
    pad = 2
    cs = corners(params_at(move, s, local), W, H, pad)
    names = ["x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3"]
    vals = [v + pad for xy in cs for v in xy]
    return (f"format=yuva420p,pad={W + 2 * pad}:{H + 2 * pad}:{pad}:{pad}:color=black@0,"
            f"perspective={':'.join(f'{n}={v:.2f}' for n, v in zip(names, vals))}:sense=destination,crop={W}:{H}:{pad}:{pad}")


def describe(move: Any, length: float, trim_in: float = 0.0) -> str:
    """Plain words for the move, for the generation prompt."""
    a = params_at(move, trim_in, 0.0)
    b = params_at(move, trim_in + length, length)
    parts = []
    d = {k: b[k] - a[k] for k in PARAMS}
    if abs(d["pan"]) > 3:
        parts.append(f"pans {'right' if d['pan'] > 0 else 'left'}")
    if abs(d["tilt"]) > 3:
        parts.append(f"tilts {'up' if d['tilt'] > 0 else 'down'}")
    if abs(d["roll"]) > 3:
        parts.append(f"rolls {'clockwise' if d['roll'] > 0 else 'counter-clockwise'}")
    if abs(d["orbit"]) > 3:
        parts.append(f"orbits {'right' if d['orbit'] > 0 else 'left'} around the subject")
    if abs(d["dolly"]) > 0.05:
        parts.append("pushes in" if d["dolly"] > 0 else "pulls back")
    if abs(d["zoom"]) > 0.05:
        parts.append("zooms in" if d["zoom"] > 0 else "zooms out")
    if abs(d["truck"]) > 0.05:
        parts.append(f"trucks {'right' if d['truck'] > 0 else 'left'}")
    if abs(d["pedestal"]) > 0.05:
        parts.append(f"cranes {'up' if d['pedestal'] > 0 else 'down'}")
    shake = " with a slight handheld shake" if (move.shake or 0) > 0.05 else ""
    if not parts:
        return "The camera holds steady" + shake + "." if not shake else "The camera is handheld."
    words = ", ".join(parts[:-1]) + (" and " if len(parts) > 1 else "") + parts[-1]
    return f"The camera smoothly {words}{shake}."


def prepare_reshoot(tl: Any, clip: Any, quality: str, guides: int) -> dict[str, Any]:
    """Make the guide frames of an AI reshoot: the finished picture under the camera clip
    (without the camera), warped to the camera at evenly spaced moments, flattened on black,
    plus masks (white = uncovered by the move). Saved under data/uploads/reshoot/<id>/."""
    import subprocess
    import uuid

    from . import config, media, render, workflows

    seconds = min(10.0, clip.end - clip.start)
    if seconds < 0.5:
        raise ValueError("The camera move is too short to reshoot (at least half a second)")
    W0, H0 = render.size_of(tl)
    mp = workflows.H3_QUALITY.get(quality, workflows.H3_QUALITY["draft"])
    W, H = workflows.dims_for((W0, H0), mp)
    folder = config.UPLOAD_DIR / "reshoot" / uuid.uuid4().hex[:12]
    folder.mkdir(parents=True, exist_ok=True)
    flat = folder / "flat.mp4"
    steps, _d, temps = render.commands(tl, str(flat), clip.start, clip.start + seconds, W, H,
                                       opts={"no_camera": True, "audio": False, "quality": "high", "speed": "fast"})
    try:
        render.run_steps(steps, timeout=600)
    finally:
        for t in temps:
            if t != str(flat):
                try:
                    import os
                    os.remove(t)
                except OSError:
                    pass
    exe = media.ffmpeg()
    fps = workflows.FPS
    out_g, out_m, frames = [], [], []
    for i in range(guides):
        local = min(seconds - 1 / fps, seconds * i / (guides - 1))
        s = clip.trim_in + local
        warp = static_filter(clip.cam, s, local, W, H)
        rgba = folder / f"w{i}.png"
        g = folder / f"guide{i}.png"
        m = folder / f"mask{i}.png"
        for cmd in (
            [exe, "-nostdin", "-v", "error", "-y", "-ss", f"{local:.4f}", "-i", str(flat), "-frames:v", "1", "-vf", f"{warp},format=rgba", str(rgba)],
            [exe, "-nostdin", "-v", "error", "-y", "-i", str(rgba), "-filter_complex",
             f"color=black:s={W}x{H}[bg];[0]format=rgba[f];[bg][f]overlay=format=auto,format=rgb24", "-frames:v", "1", str(g)],
            [exe, "-nostdin", "-v", "error", "-y", "-i", str(rgba), "-vf", "alphaextract,negate,format=gray", "-frames:v", "1", str(m)],
        ):
            r = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=media.NO_WINDOW, timeout=120)
            if r.returncode:
                raise RuntimeError(r.stderr.strip()[-400:] or "ffmpeg failed making a guide frame")
        rgba.unlink(missing_ok=True)
        rel = lambda p: p.relative_to(config.ROOT).as_posix()  # noqa: E731
        out_g.append(rel(g))
        out_m.append(rel(m))
        frames.append(int(round(local * fps)))
    return {"guides": out_g, "masks": out_m, "frames": frames, "seconds": round(seconds, 3), "width": W, "height": H,
            "flat": flat.relative_to(config.ROOT).as_posix()}
