"""Render a project's timeline to one MP4 with ffmpeg.

Picture: each visible video track is built as its own stream with a transparent
background: its clips in order, joined by cuts (concat) or, where a transition
overlaps two clips, by ffmpeg's xfade. The tracks are then laid over a black
canvas from the bottom track up, so an upper track covers the ones below only
where it has a clip. Clips are scaled and padded to the output size.

Sound: every clip on an unmuted track that has sound is trimmed, delayed to its
place and mixed (video clips whose sound moved to a linked audio clip are left
out). Clips that meet in a transition get matching fade-out / fade-in, which
makes a crossfade.

An In/Out range is cut from the finished picture and sound.

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
from pathlib import Path
from typing import Any

from . import config, media
from .projectfile import TRANSITIONS, Clip, Timeline

log = logging.getLogger("bob.render")
EPS = 1e-4


def _even(n: float) -> int:
    n = int(round(n))
    return n - (n % 2)


def _dur(c: Clip) -> float:
    return c.trim_out - c.trim_in


def transitions_by_clip(tl: Timeline) -> tuple[dict[str, Any], dict[str, Any]]:
    """Valid transitions keyed by outgoing and incoming clip id."""
    clips = {c.id: c for c in tl.clips}
    out_of, into = {}, {}
    for t in tl.transitions:
        a, b = clips.get(t.a), clips.get(t.b)
        if a and b and a.track == b.track == t.track and a.start < b.start < a.end - EPS and b.end > a.end:
            out_of[a.id] = t
            into[b.id] = t
    return out_of, into


def size_of(tl: Timeline) -> tuple[int, int]:
    first = next((c for c in sorted(tl.clips, key=lambda c: c.start) if c.kind in ("video", "image")
                  and any(t.id == c.track and t.kind == "video" for t in tl.tracks)), None)
    info = media.probe(first.ref) if first else {}
    return info.get("width") or 1280, info.get("height") or 720


def commands(tl: Timeline, out: str, w0: float | None = None, w1: float | None = None,
             width: int | None = None, height: int | None = None, crf: int = 18) -> tuple[list[list[str]], float, list[str]]:
    """Three ffmpeg runs: picture (out.v.mp4), sound (out.a.wav), then a mux into `out`.

    Picture and sound are rendered separately on purpose: one graph mixing xfade/concat video with
    several audio inputs deadlocked intermittently in ffmpeg 8 (6 of 15 runs); split, 0 of 60.
    Returns (steps, duration, temporary files to delete afterwards)."""
    exe = media.ffmpeg()
    if not exe:
        raise ValueError("ffmpeg isn't installed")
    tracks = {t.id: t for t in tl.tracks}
    clips = [c for c in tl.clips if c.track in tracks and _dur(c) > EPS]
    D = max((c.end for c in clips), default=0.0)
    w0 = max(0.0, w0 or 0.0)
    w1 = min(D, w1) if w1 else D
    if w1 - w0 < 0.05:
        raise ValueError("The timeline (or the In/Out range) is empty")
    if not (width and height):
        width, height = size_of(tl)
    W, H, fps = _even(width), _even(height), tl.fps
    out_of, into = transitions_by_clip(tl)

    head = [exe, "-nostdin", "-v", "error", "-y", "-nostats", "-progress", "pipe:1"]
    vargs, aargs = list(head), list(head)
    filters: list[str] = []
    afilters: list[str] = []
    count = {"v": 0, "a": 0}

    def add_input(c: Clip, side: str = "v") -> int:
        args = vargs if side == "v" else aargs
        path = str(media.resolve(c.ref))
        if c.kind == "image":
            args.extend(["-loop", "1", "-framerate", str(fps), "-t", f"{_dur(c):.4f}", "-i", path])
        else:
            args.extend(["-an" if side == "v" else "-vn", "-ss", f"{c.trim_in:.4f}", "-t", f"{_dur(c):.4f}", "-i", path])
        count[side] += 1
        return count[side] - 1

    norm = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,format=yuva420p,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps={fps},settb=AVTB")

    # ---------------------------------------------------------------- picture, one stream per track
    layers: list[str] = []
    order = [t for t in tl.tracks if t.kind == "video" and not t.hidden]
    for ti, tr in enumerate(reversed(order)):  # bottom track first
        tclips = sorted((c for c in clips if c.track == tr.id and c.kind in ("video", "image")), key=lambda c: c.start)
        if not tclips:
            continue
        acc, acc_len, cursor, k = None, 0.0, 0.0, 0

        pieces: list[tuple[str, float, Any]] = []  # (label, length, transition into this piece)
        prev = None
        for c in tclips:
            t_in = into.get(c.id) if prev is not None and into.get(c.id) and into[c.id].a == prev.id else None
            if t_in is None and c.start > cursor + EPS:
                g = f"t{ti}g{len(pieces)}"
                filters.append(f"color=c=black@0.0:s={W}x{H}:r={fps}:d={c.start - cursor:.4f},format=yuva420p,settb=AVTB[{g}]")
                pieces.append((g, c.start - cursor, None))
            idx = add_input(c)
            lab = f"t{ti}c{len(pieces)}"
            filters.append(f"[{idx}:v]{norm},trim=duration={_dur(c):.4f},setpts=PTS-STARTPTS[{lab}]")
            overlap = (prev.end - c.start) if t_in is not None else 0.0
            pieces.append((lab, _dur(c), (t_in, overlap) if t_in is not None else None))
            cursor = c.end
            prev = c
        if D > cursor + EPS:
            g = f"t{ti}g{len(pieces)}"
            filters.append(f"color=c=black@0.0:s={W}x{H}:r={fps}:d={D - cursor:.4f},format=yuva420p,settb=AVTB[{g}]")
            pieces.append((g, D - cursor, None))
        for lab, length, trans in pieces:
            if acc is None:
                acc, acc_len = lab, length
                continue
            k += 1
            new = f"t{ti}j{k}"
            if trans is not None:
                t, d = trans
                kind = t.type if t.type in TRANSITIONS else "fade"
                filters.append(f"[{acc}][{lab}]xfade=transition={kind}:duration={d:.4f}:offset={acc_len - d:.4f}[{new}]")
                acc_len += length - d
            else:
                filters.append(f"[{acc}][{lab}]concat=n=2:v=1:a=0[{new}]")
                acc_len += length
            acc = new
        layers.append(acc)

    filters.append(f"color=c=black:s={W}x{H}:r={fps}:d={D:.4f},format=yuva420p,settb=AVTB[base]")
    cur = "base"
    for i, lab in enumerate(layers):
        filters.append(f"[{cur}][{lab}]overlay=eof_action=pass:format=auto[ov{i}]")
        cur = f"ov{i}"
    filters.append(f"[{cur}]trim=start={w0:.4f}:end={w1:.4f},setpts=PTS-STARTPTS,format=yuv420p[vout]")

    # ---------------------------------------------------------------- sound
    alabels: list[str] = []
    for c in clips:
        tr = tracks[c.track]
        if tr.muted or c.kind == "image" or (tr.kind == "video" and c.audio_off):
            continue
        if c.kind == "video":
            try:
                if not media.probe(c.ref).get("has_audio"):
                    continue
            except media.MediaError:
                continue
        idx = add_input(c, "a")
        L = _dur(c)
        fades = []
        if c.id in into:  # fade in over the overlap with the clip before
            a = next(x for x in clips if x.id == into[c.id].a)
            fades.append(f"afade=t=in:st=0:d={a.end - c.start:.4f}")
        if c.id in out_of:  # fade out over the overlap with the clip after
            b = next(x for x in clips if x.id == out_of[c.id].b)
            d = c.end - b.start
            fades.append(f"afade=t=out:st={L - d:.4f}:d={d:.4f}")
        ms = int(round(c.start * 1000))
        chain = ",".join([f"aformat=sample_rates=48000:channel_layouts=stereo", f"volume={c.volume * tr.volume:.3f}", *fades,
                          f"adelay={ms}|{ms}"])
        lab = f"a{len(alabels)}"
        afilters.append(f"[{idx}:a]{chain}[{lab}]")
        alabels.append(f"[{lab}]")
    if alabels:
        afilters.append(f"{''.join(alabels)}amix=inputs={len(alabels)}:normalize=0:dropout_transition=0,apad,"
                       f"atrim=start={w0:.4f}:end={w1:.4f},asetpts=PTS-STARTPTS[aout]")
    else:
        afilters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={w1 - w0:.4f}[aout]")

    D_out = w1 - w0
    vfile, afile = out + ".v.mp4", out + ".a.wav"
    vargs += ["-filter_complex", ";".join(filters), "-map", "[vout]", "-an",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", str(int(crf)), "-pix_fmt", "yuv420p", "-t", f"{D_out:.4f}", vfile]
    aargs += ["-filter_complex", ";".join(afilters), "-map", "[aout]", "-vn", "-c:a", "pcm_s16le", "-t", f"{D_out:.4f}", afile]
    mux = [exe, "-nostdin", "-v", "error", "-y", "-i", vfile, "-i", afile, "-map", "0:v", "-map", "1:a",
           "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{D_out:.4f}", out]
    return [vargs, aargs, mux], D_out, [vfile, afile]


def command(tl: Timeline, out: str, w0: float | None = None, w1: float | None = None,
            width: int | None = None, height: int | None = None, crf: int = 18) -> tuple[list[list[str]], float]:
    """The render steps (see commands); kept for callers that run them in order themselves."""
    steps, d, _tmp = commands(tl, out, w0, w1, width, height, crf)
    return steps, d


async def render(jobs, project_id: str | None, tl: Timeline, *, w0: float | None = None, w1: float | None = None,
                 width: int | None = None, height: int | None = None, name: str = "Timeline") -> dict[str, Any]:
    """Start a render as a studio item; returns the item at once and finishes in the background."""
    day = datetime.now().strftime("%Y-%m-%d")
    out_dir = config.OUTPUT_DIR / day
    out_dir.mkdir(parents=True, exist_ok=True)
    item_id = uuid.uuid4().hex[:12]
    target = out_dir / f"{item_id}_timeline.mp4"
    steps, duration, temps = commands(tl, str(target), w0, w1, width, height, int(tl.render.get("crf", 18)))
    item = {
        "id": item_id, "kind": "video", "engine": "timeline", "project": project_id, "status": "running",
        "params": {"kind": "video", "engine": "timeline", "prompt": f"{name} · {len(tl.clips)} clips · {duration:.2f}s"},
        "seed": 0, "created": time.time(), "started": time.time(), "files": [], "progress": 0.0, "error": None,
        "info": {"seconds": round(duration, 2), "clips": len(tl.clips)},
    }
    jobs.items[item_id] = item
    jobs._update(item)

    async def run_step(args: list[str], base: float, span: float, label: str) -> None:
        proc = await asyncio.to_thread(subprocess.Popen, args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, creationflags=media.NO_WINDOW)
        loop = asyncio.get_running_loop()
        while True:
            line = await loop.run_in_executor(None, proc.stdout.readline)
            if not line:
                break
            m = re.match(rb"out_time_us=(\d+)", line)
            if m and duration:
                value = min(0.99, base + span * min(1.0, int(m.group(1)) / 1e6 / duration))
                item["progress"] = value
                jobs._publish({"type": "progress", "id": item_id, "value": value, "step": None, "steps": None,
                               "message": label})
        err = (await asyncio.to_thread(proc.stderr.read)).decode(errors="replace")
        code = await asyncio.to_thread(proc.wait)
        if code:
            raise RuntimeError(err.strip()[-800:] or f"ffmpeg exited with {code}")

    async def run() -> None:
        try:
            await run_step(steps[0], 0.0, 0.80, "Rendering picture")
            await run_step(steps[1], 0.80, 0.15, "Mixing sound")
            await run_step(steps[2], 0.95, 0.04, "Finishing")
            if not target.is_file():
                raise RuntimeError("ffmpeg didn't write the file")
            rel = target.relative_to(config.ROOT).as_posix()
            files = [{"name": target.name, "path": rel, "url": "/" + rel, "content_type": "video/mp4",
                      "size": target.stat().st_size}]
            jobs._update(item, status="done", files=files, progress=1.0, finished=time.time())
        except Exception as exc:  # noqa: BLE001
            log.exception("render %s failed", item_id)
            target.unlink(missing_ok=True)
            jobs._update(item, status="failed", error=str(exc)[:1500], finished=time.time())
        finally:
            for t in temps:
                Path(t).unlink(missing_ok=True)

    asyncio.create_task(run())
    return item
