"""Render a project's timeline to one MP4 with ffmpeg.

Picture: at every moment the uppermost visible video track with a clip wins;
gaps are black. Each piece is scaled and padded to the output size and joined
with the concat filter. Sound: every clip on an unmuted track that has audio
(video clips' own sound and audio-track clips) is trimmed, delayed to its
place and mixed. Stills on a video track are held for their length.

The result is added to the studio as a normal "video" item (engine "timeline")
with live progress, in the project it came from.
"""
from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import time
import uuid
from datetime import datetime
from typing import Any

from . import config, media
from .projectfile import Timeline

log = logging.getLogger("bob.render")
EPS = 1e-4


def _even(n: float) -> int:
    n = int(round(n))
    return n - (n % 2)


def plan(tl: Timeline, w0: float | None = None, w1: float | None = None) -> dict[str, Any]:
    """Work out the picture segments and the sound sources inside the window [w0, w1)."""
    order = {t.id: i for i, t in enumerate(tl.tracks)}  # lower index = higher track = on top
    tracks = {t.id: t for t in tl.tracks}
    clips = [c for c in tl.clips if c.track in tracks]
    end = max((c.end for c in clips), default=0.0)
    w0 = max(0.0, w0 or 0.0)
    w1 = min(end, w1) if w1 else end
    if w1 - w0 < 0.05:
        raise ValueError("The timeline (or the In/Out range) is empty")

    vclips = [c for c in clips if tracks[c.track].kind == "video" and not tracks[c.track].hidden and c.kind in ("video", "image")]
    cuts = sorted({w0, w1, *(t for c in vclips for t in (c.start, c.end) if w0 < t < w1)})
    segs: list[dict[str, Any]] = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < EPS:
            continue
        mid = (a + b) / 2
        cover = [c for c in vclips if c.start <= mid < c.end]
        top = min(cover, key=lambda c: order[c.track]) if cover else None
        src_t = (top.trim_in + (a - top.start)) if top else 0.0
        last = segs[-1] if segs else None
        if last and last["clip"] is top and (top is None or abs(last["src"] + last["dur"] - src_t) < 1e-3):
            last["dur"] += b - a  # same clip continuing (or a longer gap)
        else:
            segs.append({"clip": top, "src": src_t, "dur": b - a})

    sounds = []
    for c in clips:
        tr = tracks[c.track]
        if tr.muted or c.kind == "image":
            continue
        s0, s1 = max(c.start, w0), min(c.end, w1)
        if s1 - s0 < EPS:
            continue
        if c.kind == "video":
            try:
                if not media.probe(c.ref).get("has_audio"):
                    continue
            except media.MediaError:
                continue
        sounds.append({"clip": c, "src": c.trim_in + (s0 - c.start), "dur": s1 - s0, "at": s0 - w0,
                       "gain": c.volume * tr.volume})
    return {"w0": w0, "w1": w1, "duration": w1 - w0, "segments": segs, "sounds": sounds}


def command(tl: Timeline, out: str, w0: float | None = None, w1: float | None = None,
            width: int | None = None, height: int | None = None, crf: int = 18) -> tuple[list[str], float]:
    p = plan(tl, w0, w1)
    fps = tl.fps
    if not (width and height):  # size of the first picture used
        first = next((s["clip"] for s in p["segments"] if s["clip"]), None)
        info = media.probe(first.ref) if first else {}
        width, height = info.get("width") or 1280, info.get("height") or 720
    W, H = _even(width), _even(height)
    exe = media.ffmpeg()
    if not exe:
        raise ValueError("ffmpeg isn't installed")

    args: list[str] = [exe, "-nostdin", "-v", "error", "-y", "-nostats", "-progress", "pipe:1"]
    filters: list[str] = []
    vlabels: list[str] = []
    n = 0
    for i, s in enumerate(p["segments"]):
        c, dur = s["clip"], s["dur"]
        if c is None:
            args += ["-f", "lavfi", "-t", f"{dur:.4f}", "-i", f"color=c=black:s={W}x{H}:r={fps}"]
        elif c.kind == "image":
            args += ["-loop", "1", "-framerate", str(fps), "-t", f"{dur:.4f}", "-i", str(media.resolve(c.ref))]
        else:
            args += ["-ss", f"{s['src']:.4f}", "-t", f"{dur:.4f}", "-i", str(media.resolve(c.ref))]
        filters.append(f"[{n}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
                       f"setsar=1,fps={fps},format=yuv420p,trim=duration={dur:.4f},setpts=PTS-STARTPTS[v{i}]")
        vlabels.append(f"[v{i}]")
        n += 1
    filters.append(f"{''.join(vlabels)}concat=n={len(vlabels)}:v=1:a=0[vout]")

    alabels: list[str] = []
    for j, s in enumerate(p["sounds"]):
        args += ["-ss", f"{s['src']:.4f}", "-t", f"{s['dur']:.4f}", "-i", str(media.resolve(s["clip"].ref))]
        ms = int(round(s["at"] * 1000))
        filters.append(f"[{n}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={s['gain']:.3f},"
                       f"adelay={ms}|{ms}[a{j}]")
        alabels.append(f"[a{j}]")
        n += 1
    D = p["duration"]
    if alabels:
        filters.append(f"{''.join(alabels)}amix=inputs={len(alabels)}:normalize=0:dropout_transition=0,apad,atrim=duration={D:.4f}[aout]")
    else:
        args += ["-f", "lavfi", "-t", f"{D:.4f}", "-i", "anullsrc=r=48000:cl=stereo"]
        filters.append(f"[{n}:a]atrim=duration={D:.4f}[aout]")
        n += 1

    args += ["-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", str(int(crf)), "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{D:.4f}", out]
    return args, D


async def render(jobs, project_id: str | None, tl: Timeline, *, w0: float | None = None, w1: float | None = None,
                 width: int | None = None, height: int | None = None, name: str = "Timeline") -> dict[str, Any]:
    """Start a render as a studio item; returns the item at once and finishes in the background."""
    day = datetime.now().strftime("%Y-%m-%d")
    out_dir = config.OUTPUT_DIR / day
    out_dir.mkdir(parents=True, exist_ok=True)
    item_id = uuid.uuid4().hex[:12]
    target = out_dir / f"{item_id}_timeline.mp4"
    args, duration = command(tl, str(target), w0, w1, width, height, int(tl.render.get("crf", 18)))
    item = {
        "id": item_id, "kind": "video", "engine": "timeline", "project": project_id, "status": "running",
        "params": {"kind": "video", "engine": "timeline", "prompt": f"{name} · {len(tl.clips)} clips · {duration:.2f}s"},
        "seed": 0, "created": time.time(), "started": time.time(), "files": [], "progress": 0.0, "error": None,
        "info": {"seconds": round(duration, 2), "clips": len(tl.clips)},
    }
    jobs.items[item_id] = item
    jobs._update(item)

    async def run() -> None:
        try:
            proc = await asyncio.to_thread(subprocess.Popen, args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           creationflags=media.NO_WINDOW)
            loop = asyncio.get_running_loop()
            while True:
                line = await loop.run_in_executor(None, proc.stdout.readline)
                if not line:
                    break
                m = re.match(rb"out_time_us=(\d+)", line)
                if m and duration:
                    value = min(0.99, int(m.group(1)) / 1e6 / duration)
                    item["progress"] = value
                    jobs._publish({"type": "progress", "id": item_id, "value": value, "step": None, "steps": None,
                                   "message": "Rendering timeline"})
            err = (await asyncio.to_thread(proc.stderr.read)).decode(errors="replace")
            code = await asyncio.to_thread(proc.wait)
            if code or not target.is_file():
                raise RuntimeError(err.strip()[-800:] or f"ffmpeg exited with {code}")
            rel = target.relative_to(config.ROOT).as_posix()
            files = [{"name": target.name, "path": rel, "url": "/" + rel, "content_type": "video/mp4",
                      "size": target.stat().st_size}]
            jobs._update(item, status="done", files=files, progress=1.0, finished=time.time())
        except Exception as exc:  # noqa: BLE001
            log.exception("render %s failed", item_id)
            target.unlink(missing_ok=True)
            jobs._update(item, status="failed", error=str(exc)[:1500], finished=time.time())

    asyncio.create_task(run())
    return item
