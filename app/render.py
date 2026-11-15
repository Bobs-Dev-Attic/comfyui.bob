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

# Render formats: extension, picture codec args (None = sound only), sound codec args, label.
# {crf} and {preset} are filled from the quality and speed options.
FORMATS: dict[str, dict[str, Any]] = {
    "mp4-h264": {"ext": ".mp4", "label": "MP4 · H.264 (plays everywhere)", "audio": ["-c:a", "aac", "-b:a", "{abr}k"],
                 "video": ["-c:v", "libx264", "-preset", "{preset}", "-crf", "{crf}", "-pix_fmt", "yuv420p"]},
    "mp4-h264-nvenc": {"ext": ".mp4", "label": "MP4 · H.264, NVIDIA NVENC (fast)", "audio": ["-c:a", "aac", "-b:a", "{abr}k"], "encoder": "h264_nvenc",
                       "video": ["-c:v", "h264_nvenc", "-preset", "{nvpreset}", "-rc", "vbr", "-cq", "{crf}", "-b:v", "0", "-pix_fmt", "yuv420p"]},
    "mp4-h265": {"ext": ".mp4", "label": "MP4 · H.265/HEVC (smaller files)", "audio": ["-c:a", "aac", "-b:a", "{abr}k"], "encoder": "libx265",
                 "video": ["-c:v", "libx265", "-preset", "{preset}", "-crf", "{crf265}", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]},
    "webm-vp9": {"ext": ".webm", "label": "WebM · VP9 + Opus (web)", "audio": ["-c:a", "libopus", "-b:a", "{abr}k"], "encoder": "libvpx-vp9",
                 "video": ["-c:v", "libvpx-vp9", "-crf", "{crfvp9}", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "{vp9speed}", "-pix_fmt", "yuv420p"]},
    "mov-prores": {"ext": ".mov", "label": "MOV · ProRes 422 HQ (editing, large)", "audio": ["-c:a", "pcm_s16le"], "encoder": "prores_ks",
                   "video": ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]},
    "wav": {"ext": ".wav", "label": "WAV · sound only (lossless)", "audio": ["-c:a", "pcm_s16le"], "video": None},
    "mp3": {"ext": ".mp3", "label": "MP3 · sound only", "audio": ["-c:a", "libmp3lame", "-b:a", "{abr}k"], "video": None, "encoder": "libmp3lame"},
}
QUALITY = {"high": 18, "medium": 23, "small": 28}           # x264 CRF; the others are derived
SPEED = {"fast": ("veryfast", "p2", 6), "balanced": ("medium", "p5", 4), "best": ("slow", "p7", 2)}


def _hex(c: str) -> tuple[float, float, float]:
    c = (c or "#ffffff").lstrip("#")
    try:
        return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return (1.0, 1.0, 1.0)


def fx_active(fx: Any) -> bool:
    if not fx or not fx.enabled:
        return False
    return bool(abs(fx.exposure) > 1e-3 or abs(fx.contrast - 1) > 1e-3 or abs(fx.saturation - 1) > 1e-3
                or abs(fx.temperature) > 0.5 or abs(fx.tint) > 0.5 or fx.look != "none" or fx.vignette > 1e-3
                or fx.blur > 1e-3 or fx.sharpen > 1e-3 or fx.grain > 1e-3 or any(l.intensity > 1e-3 for l in fx.lights))


def fx_filters(fx: Any, src: str, dst: str, tag: str, length: float, height: int) -> list[str]:
    """Filter-graph pieces that take [src] (any format) to [dst] (gbrp) with the clip's effects.

    Lights are soft masks drawn with geq at a quarter of the size (they're smooth, so that's
    invisible and 16× cheaper), scaled back up and blended in RGB:
      relight  A·(1 + I·B)   light falling on the plate, keeping its texture
      glow     A + I·B       light added on top
      shade    A·(1 − d·B)   a soft shadow
    A light can travel from (x, y) to (x2, y2) over the clip, and flicker."""
    out: list[str] = []
    chain = []
    if abs(fx.contrast - 1) > 1e-3 or abs(fx.saturation - 1) > 1e-3:
        chain.append(f"eq=contrast={fx.contrast:.3f}:saturation={fx.saturation:.3f}")
    chain.append("format=gbrp")
    gain = 2 ** fx.exposure
    if abs(gain - 1) > 1e-3 or abs(fx.tint) > 0.5:
        g_green = gain * (1 - 0.18 * fx.tint / 100)
        g_rb = gain * (1 + 0.06 * max(0.0, fx.tint) / 100)
        chain.append(f"colorchannelmixer=rr={g_rb:.4f}:gg={g_green:.4f}:bb={g_rb:.4f}")
    if abs(fx.temperature) > 0.5:
        chain.append(f"colortemperature=temperature={6500 - fx.temperature * 35:.0f}")
    if fx.look == "bw":
        chain.append("colorchannelmixer=.299:.587:.114:0:.299:.587:.114:0:.299:.587:.114")
    elif fx.look == "sepia":
        chain.append("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131")
    cur = f"{tag}g"
    out.append(f"[{src}]{','.join(chain)}[{cur}]")
    L = max(length, 1e-3)
    for i, lt in enumerate(l for l in fx.lights if l.intensity > 1e-3):
        x2 = lt.x if lt.x2 is None else lt.x2
        y2 = lt.y if lt.y2 is None else lt.y2
        p = f"min(1,max(0,T/{L:.4f}))"
        cx, cy = f"({lt.x:.4f}+({x2 - lt.x:.4f})*{p})", f"({lt.y:.4f}+({y2 - lt.y:.4f})*{p})"
        r = f"({lt.radius:.4f}*min(W,H))"
        g = f"exp(-(pow(X-{cx}*W,2)+pow(Y-{cy}*H,2))/(2*{r}*{r}))"
        if lt.flicker > 1e-3:
            g += f"*(1-{lt.flicker * 0.6:.3f}*0.5*(1+sin(T*13.1)*sin(T*5.3+1)))"
        rgb = (1.0, 1.0, 1.0) if lt.mode == "shade" else _hex(lt.color)
        b, m, ms, nxt = f"{tag}b{i}", f"{tag}m{i}", f"{tag}s{i}", f"{tag}l{i}"
        out.append(f"[{cur}]split[{b}][{m}]")
        out.append(f"[{m}]scale=iw/4:ih/4,geq=r='255*{rgb[0]:.3f}*{g}':g='255*{rgb[1]:.3f}*{g}':b='255*{rgb[2]:.3f}*{g}'[{ms}0]")
        out.append(f"[{ms}0][{b}]scale2ref[{ms}][{b}r]")
        I = lt.intensity
        expr = {"relight": f"min(255,A*(1+{I:.3f}*B/255))", "glow": f"min(255,A+{I:.3f}*B)",
                "shade": f"A*(1-{min(1.0, I * 0.7):.3f}*B/255)"}[lt.mode]
        out.append(f"[{b}r][{ms}]blend=all_expr='{expr}'[{nxt}]")
        cur = nxt
    tail = []
    if fx.vignette > 1e-3:
        tail.append(f"vignette=angle={0.15 + 0.85 * fx.vignette:.3f}")
    scale = max(0.25, height / 1080)
    if fx.blur > 1e-3:
        tail.append(f"gblur=sigma={fx.blur * scale:.2f}")
    if fx.sharpen > 1e-3:
        tail.append(f"unsharp=5:5:{fx.sharpen:.2f}")
    if fx.grain > 1e-3:
        tail.append(f"noise=alls={int(4 + 36 * fx.grain)}:allf=t")
    out.append(f"[{cur}]{','.join(tail) if tail else 'null'}[{dst}]")
    return out


def formats() -> list[dict[str, Any]]:
    """The render formats this ffmpeg can write."""
    have = _encoders()
    return [{"id": k, "label": v["label"], "ext": v["ext"], "video": v["video"] is not None}
            for k, v in FORMATS.items() if not v.get("encoder") or v["encoder"] in have]


_ENC: set[str] | None = None


def _encoders() -> set[str]:
    global _ENC
    if _ENC is None:
        exe = media.ffmpeg()
        _ENC = set()
        if exe:
            try:
                r = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                                   creationflags=media.NO_WINDOW, timeout=20)
                _ENC = {ln.split()[1] for ln in r.stdout.splitlines() if len(ln.split()) > 1 and ln.startswith(" ") and ln.split()[0][:1] in "VA"}
            except (OSError, subprocess.SubprocessError):
                pass
    return _ENC


def _fill(args: list[str], **kv: Any) -> list[str]:
    return [a.format(**kv) if "{" in a else a for a in args]


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


def sound_fades(tl: Timeline, clips: list[Clip], out_of: dict[str, Any], into: dict[str, Any]) -> dict[str, tuple[float, float]]:
    """(fade-in, fade-out) seconds per clip: its own fades, plus crossfades at transitions.

    A transition fades the two clips' sound into each other. When linked sound clips sit on
    other tracks (one audio track per video), they get the same fades so they crossfade too,
    unless they already have their own transition."""
    by_id = {c.id: c for c in clips}
    fades = {c.id: (c.fade_in, c.fade_out) for c in clips}

    def bump(cid: str, fin: float = 0.0, fout: float = 0.0) -> None:
        a, b = fades.get(cid, (0.0, 0.0))
        fades[cid] = (max(a, fin), max(b, fout))

    for t in {id(t): t for t in [*out_of.values(), *into.values()]}.values():
        a, b = by_id.get(t.a), by_id.get(t.b)
        if not (a and b):
            continue
        d = a.end - b.start
        bump(a.id, fout=d)
        bump(b.id, fin=d)
        if a.link and b.link:
            pa = [x for x in clips if x.link == a.link and x is not a]
            pb = [x for x in clips if x.link == b.link and x is not b]
            for x in pa:
                if x.id not in out_of:
                    bump(x.id, fout=d)
            for x in pb:
                if x.id not in into:
                    bump(x.id, fin=d)
    return fades


def commands(tl: Timeline, out: str, w0: float | None = None, w1: float | None = None,
             width: int | None = None, height: int | None = None, crf: int = 18,
             opts: dict[str, Any] | None = None) -> tuple[list[list[str]], float, list[str]]:
    """Three ffmpeg runs: picture (out.v.<ext>), sound (out.a.wav), then a mux into `out`.

    `opts` (Render options): format (FORMATS key), fps, quality (high|medium|small), speed
    (fast|balanced|best), audio (bool), audio_bitrate (kbps), sample_rate, channels (1|2),
    loudness ("mixer" = the master's target, "off", or LUFS as a number).

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
    o = dict(opts or {})
    fmt = FORMATS.get(o.get("format") or "mp4-h264", FORMATS["mp4-h264"])
    want_video = fmt["video"] is not None
    want_audio = bool(o.get("audio", True)) or not want_video
    W, H, fps = _even(width), _even(height), float(o.get("fps") or tl.fps)
    fps = int(fps) if abs(fps - round(fps)) < 1e-6 else fps
    q = QUALITY.get(o.get("quality") or "", int(crf))
    preset, nvpreset, vp9speed = SPEED.get(o.get("speed") or "balanced", SPEED["balanced"])
    kv = {"crf": q, "crf265": q + 4, "crfvp9": q + 13, "preset": preset, "nvpreset": nvpreset, "vp9speed": vp9speed,
          "abr": int(o.get("audio_bitrate") or 192)}
    rate, chans = int(o.get("sample_rate") or 48000), int(o.get("channels") or 2)
    loud_opt = o.get("loudness", "mixer")
    loudness = tl.master.loudness if loud_opt in (None, "mixer") else (None if loud_opt == "off" else float(loud_opt))
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
    fit = f"scale={W}:{H}:force_original_aspect_ratio=decrease,setsar=1,fps={fps},settb=AVTB"
    place = f"format=yuva420p,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1"

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
            if fx_active(c.fx):  # effects run on the picture itself (lights follow it), then it's placed
                pre, post = f"{lab}p", f"{lab}x"
                filters.append(f"[{idx}:v]{fit},trim=duration={_dur(c):.4f},setpts=PTS-STARTPTS[{pre}]")
                filters.extend(fx_filters(c.fx, pre, post, f"{lab}f", _dur(c), H))
                filters.append(f"[{post}]{place}[{lab}]")
            else:
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
    burn = ""
    if o.get("burn_timecode"):
        font = next((f for f in (Path("C:/Windows/Fonts/consola.ttf"), Path("C:/Windows/Fonts/arial.ttf"),
                                 Path("/System/Library/Fonts/Menlo.ttc"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"))
                     if f.is_file()), None)
        r = round(fps) if isinstance(fps, float) else fps
        start = int(round(w0 * r))
        tc = f"{start // (3600 * r):02d}\\:{start // (60 * r) % 60:02d}\\:{start // r % 60:02d}\\:{start % r:02d}"
        ff = f"fontfile='{font.as_posix().replace(':', chr(92) + ':')}':" if font else ""
        size = max(14, H // 30)
        burn = (f",drawtext={ff}timecode='{tc}':rate={r}:fontsize={size}:fontcolor=white:box=1:boxcolor=black@0.55:"
                f"boxborderw={size // 3}:x=(w-tw)/2:y=h-th-{size}")
    filters.append(f"[{cur}]trim=start={w0:.4f}:end={w1:.4f},setpts=PTS-STARTPTS,format=yuv420p{burn}[vout]")

    # ---------------------------------------------------------------- sound
    fades_for = sound_fades(tl, clips, out_of, into)
    soloing = any(t.solo for t in tl.tracks)
    alabels: list[str] = []
    for c in clips:
        tr = tracks[c.track]
        if tr.muted or c.muted or c.kind == "image" or (tr.kind == "video" and c.audio_off) or (soloing and not tr.solo):
            continue
        if c.kind == "video":
            try:
                if not media.probe(c.ref).get("has_audio"):
                    continue
            except media.MediaError:
                continue
        idx = add_input(c, "a")
        L = _dur(c)
        fin, fout = fades_for.get(c.id, (0.0, 0.0))
        fades = []
        if fin > EPS:
            fades.append(f"afade=t=in:st=0:d={min(fin, L):.4f}")
        if fout > EPS:
            fades.append(f"afade=t=out:st={max(0.0, L - fout):.4f}:d={min(fout, L):.4f}")
        bal = max(-1.0, min(1.0, c.pan + tr.pan))
        pan = [f"pan=stereo|c0={min(1.0, 1 - bal):.3f}*c0|c1={min(1.0, 1 + bal):.3f}*c1"] if abs(bal) > 1e-3 else []
        ms = int(round(c.start * 1000))
        chain = ",".join(["aformat=sample_rates=48000:channel_layouts=stereo", f"volume={c.volume * tr.volume:.3f}", *pan, *fades,
                          f"adelay={ms}|{ms}"])
        lab = f"a{len(alabels)}"
        afilters.append(f"[{idx}:a]{chain}[{lab}]")
        alabels.append(f"[{lab}]")
    master = [f"volume={tl.master.volume:.3f}"] if abs(tl.master.volume - 1) > 1e-3 else []
    # Loudness needs the finished mix measured first (two-pass loudnorm, a separate step below);
    # without it the limiter goes straight on the mix.
    if tl.master.limiter and loudness is None:
        master.append("alimiter=limit=0.95:level=disabled")
    if alabels:
        afilters.append(f"{''.join(alabels)}amix=inputs={len(alabels)}:normalize=0:dropout_transition=0,apad,"
                        f"atrim=start={w0:.4f}:end={w1:.4f},asetpts=PTS-STARTPTS{''.join(',' + m for m in master)}[aout]")
    else:
        afilters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={w1 - w0:.4f}[aout]")

    D_out = w1 - w0
    vfile, afile = out + ".v" + fmt["ext"] if want_video else "", out + ".a.wav"
    raw = out + ".raw.wav" if loudness is not None else afile
    if want_video:
        vargs += ["-filter_complex", ";".join(filters), "-map", "[vout]", "-an", *_fill(fmt["video"], **kv), "-t", f"{D_out:.4f}", vfile]
    aargs += ["-filter_complex", ";".join(afilters), "-map", "[aout]", "-vn", "-c:a", "pcm_s16le", "-t", f"{D_out:.4f}", raw]
    fast = ["-movflags", "+faststart"] if fmt["ext"] in (".mp4", ".mov") else []
    sound = ["-ar", str(rate), "-ac", str(chans), *_fill(fmt["audio"], **kv)]
    if want_video and want_audio:
        mux = [exe, "-nostdin", "-v", "error", "-y", "-nostats", "-progress", "pipe:1", "-i", vfile, "-i", afile, "-map", "0:v", "-map", "1:a",
               "-c:v", "copy", *sound, *fast, "-t", f"{D_out:.4f}", out]
    elif want_video:
        mux = [exe, "-nostdin", "-v", "error", "-y", "-nostats", "-progress", "pipe:1", "-i", vfile, "-map", "0:v", "-c:v", "copy", *fast,
               "-t", f"{D_out:.4f}", out]
    else:
        mux = [exe, "-nostdin", "-v", "error", "-y", "-nostats", "-progress", "pipe:1", "-i", afile, "-map", "0:a", *sound, "-t", f"{D_out:.4f}", out]
    steps: list[Any] = [vargs if want_video else None, aargs if want_audio else None]
    if want_audio and raw != afile:
        steps.append(("loudnorm", raw, afile, float(loudness), bool(tl.master.limiter)))
    steps.append(mux)
    return steps, D_out, [f for f in (vfile, afile, raw if raw != afile else "") if f]


def loudnorm_two_pass(src: str, dst: str, target: float, limiter: bool) -> None:
    """Measure the mix's loudness, then normalise it exactly (EBU R128, linear gain)."""
    exe = media.ffmpeg()
    spec = f"I={target:g}:TP=-1.5:LRA=11"
    r = subprocess.run([exe, "-nostdin", "-hide_banner", "-i", src, "-af", f"loudnorm={spec}:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=media.NO_WINDOW, timeout=600)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr)
    if not m:
        raise RuntimeError("Couldn't measure the loudness of the mix")
    import json
    v = json.loads(m.group(0))
    if float(v["input_i"]) < -70:  # silence: nothing to normalise
        chain = "anull"
    else:
        chain = (f"loudnorm={spec}:measured_I={v['input_i']}:measured_TP={v['input_tp']}:measured_LRA={v['input_lra']}:"
                 f"measured_thresh={v['input_thresh']}:offset={v['target_offset']}:linear=true,aresample=48000")
    if limiter:
        chain += ",alimiter=limit=0.95:level=disabled"
    r = subprocess.run([exe, "-nostdin", "-v", "error", "-y", "-i", src, "-af", chain, "-c:a", "pcm_s16le", dst],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=media.NO_WINDOW, timeout=600)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-500:])


def run_steps(steps: list[Any], timeout: float = 600) -> None:
    """Run render steps in order (for tests and tools; the studio runs them with progress)."""
    for st in steps:
        if st is None:
            continue
        if isinstance(st, tuple) and st[0] == "loudnorm":
            loudnorm_two_pass(*st[1:])
            continue
        r = subprocess.run(st, capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=media.NO_WINDOW, timeout=timeout)
        if r.returncode:
            raise RuntimeError(r.stderr.strip()[-500:])


def command(tl: Timeline, out: str, w0: float | None = None, w1: float | None = None,
            width: int | None = None, height: int | None = None, crf: int = 18) -> tuple[list[list[str]], float]:
    """The render steps (see commands); kept for callers that run them in order themselves."""
    steps, d, _tmp = commands(tl, out, w0, w1, width, height, crf)
    return steps, d


def safe_name(s: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", (s or "").strip()).strip(" .")
    return s[:120]


def destination(folder: str, filename: str, ext: str, item_id: str, overwrite: bool = False,
                stamp: bool = False) -> Path:
    """Where a render goes: outputs/<date> by default, or a folder inside outputs or a bookmarked folder."""
    if folder:
        d = Path(folder)
        d = (d if d.is_absolute() else config.ROOT / folder).resolve()
        if not any(d == r or r in d.parents for r in media.allowed_roots()):
            raise ValueError("Renders can go to the studio's outputs or a bookmarked folder (Inputs › Media › bookmark it first)")
        if not d.is_dir():
            raise ValueError(f"Folder not found: {folder}")
    else:
        d = config.OUTPUT_DIR / datetime.now().strftime("%Y-%m-%d")
        d.mkdir(parents=True, exist_ok=True)
    base = safe_name(filename) or f"{item_id}_timeline"
    if stamp:  # "My cut 2026-11-15 14.03.27": sorts by time, safe on every file system
        base = f"{base} {datetime.now().strftime('%Y-%m-%d %H.%M.%S')}"
    target = d / f"{base}{ext}"
    n = 2
    while target.exists() and not overwrite:
        target = d / f"{base} ({n}){ext}"
        n += 1
    return target


async def render(jobs, project_id: str | None, tl: Timeline, *, w0: float | None = None, w1: float | None = None,
                 width: int | None = None, height: int | None = None, name: str = "Timeline",
                 opts: dict[str, Any] | None = None) -> dict[str, Any]:
    """Start a render as a studio item; returns the item at once and finishes in the background."""
    o = dict(opts or {})
    fmt_id = o.get("format") or "mp4-h264"
    if fmt_id not in FORMATS:
        raise ValueError(f"Unknown format: {fmt_id}")
    if FORMATS[fmt_id].get("encoder") and FORMATS[fmt_id]["encoder"] not in _encoders():
        raise ValueError(f"This ffmpeg can't write {FORMATS[fmt_id]['label']}")
    fmt = FORMATS[fmt_id]
    item_id = uuid.uuid4().hex[:12]
    target = destination(o.get("folder") or "", o.get("filename") or "", fmt["ext"], item_id, bool(o.get("overwrite")),
                         bool(o.get("timestamp")))
    steps, duration, temps = commands(tl, str(target), w0, w1, width, height, int(tl.render.get("crf", 18)), o)
    kind = "video" if fmt["video"] is not None else "audio"
    item = {
        "id": item_id, "kind": kind, "engine": "timeline", "project": project_id, "status": "running",
        "params": {"kind": kind, "engine": "timeline", "prompt": f"{name} · {len(tl.clips)} clips · {duration:.2f}s"},
        "seed": 0, "created": time.time(), "started": time.time(), "files": [], "progress": 0.0, "error": None,
        "info": {"seconds": round(duration, 2), "clips": len(tl.clips), "format": fmt["label"], "file": target.as_posix()},
        "log": [],
    }
    jobs.items[item_id] = item
    jobs._update(item)
    say = lambda msg, level="info": jobs.log(item, msg, level)  # noqa: E731
    say(f"Render: {len(tl.clips)} clips, {duration:.2f} s of timeline" + (f" (In {w0:.2f}s – Out {w1:.2f}s)" if (w0 or w1) else ""))
    say(f"Format {fmt['label']}" + (f", {width}×{height}" if width else ", size of the first clip") +
        f", {o.get('fps') or tl.fps} fps, quality {o.get('quality') or 'high'}, speed {o.get('speed') or 'balanced'}")
    if kind == "video":
        say("Sound: " + ("off" if not o.get("audio", True) else
                         f"{o.get('sample_rate') or 48000} Hz, {'mono' if int(o.get('channels') or 2) == 1 else 'stereo'}"
                         f", {o.get('audio_bitrate') or 192} kbps"))
    fx_n = sum(1 for c in tl.clips if fx_active(c.fx))
    if fx_n:
        say(f"Video Fx on {fx_n} clip{'s' if fx_n != 1 else ''}"
            + (f", {sum(len([l for l in c.fx.lights if l.intensity > 0]) for c in tl.clips if fx_active(c.fx))} light(s)"
               if any(c.fx and c.fx.lights for c in tl.clips) else ""))
    if o.get("burn_timecode") and kind == "video":
        say("Burning in the timecode")
    say(f"Saving to {target.as_posix()}")

    async def run_step(args: list[str], base: float, span: float, label: str) -> None:
        t0 = time.time()
        say(f"{label}…")
        proc = await asyncio.to_thread(subprocess.Popen, args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, creationflags=media.NO_WINDOW)
        loop = asyncio.get_running_loop()
        speed, last_note = "", 0.0
        while True:
            line = await loop.run_in_executor(None, proc.stdout.readline)
            if not line:
                break
            sm = re.match(rb"speed=\s*([\d.]+x)", line)
            if sm:
                speed = sm.group(1).decode()
            m = re.match(rb"out_time_us=(\d+)", line)
            if m and duration:
                done_s = int(m.group(1)) / 1e6
                value = min(0.99, base + span * min(1.0, done_s / duration))
                item["progress"] = value
                jobs._publish({"type": "progress", "id": item_id, "value": value, "step": None, "steps": None,
                               "message": f"{label}{f' · {speed}' if speed else ''}"})
                if time.time() - last_note > 5:
                    last_note = time.time()
                    say(f"{label}: {min(done_s, duration):.1f} / {duration:.1f} s{f' at {speed}' if speed else ''}")
        err = (await asyncio.to_thread(proc.stderr.read)).decode(errors="replace")
        code = await asyncio.to_thread(proc.wait)
        if code:
            raise RuntimeError(err.strip()[-800:] or f"ffmpeg exited with {code}")
        say(f"{label}: done in {time.time() - t0:.1f} s")

    async def run() -> None:
        t_start = time.time()
        try:
            vstep, astep = steps[0], steps[1]
            if vstep:
                await run_step(vstep, 0.0, 0.80 if astep else 0.95, "Rendering picture")
            if astep:
                await run_step(astep, 0.80 if vstep else 0.0, 0.12 if vstep else 0.80, "Mixing sound")
            for st in steps[2:-1]:  # loudness normalisation
                jobs._publish({"type": "progress", "id": item_id, "value": 0.93, "step": None, "steps": None, "message": "Normalising loudness"})
                say(f"Normalising loudness to {st[3]:g} LUFS (measure, then apply)…")
                await asyncio.to_thread(loudnorm_two_pass, *st[1:])
            await run_step(steps[-1], 0.95, 0.04, "Finishing")
            if not target.is_file():
                raise RuntimeError("ffmpeg didn't write the file")
            ctype = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg"}[fmt["ext"]]
            try:
                rel = target.relative_to(config.ROOT).as_posix()
                url = "/" + rel if rel.startswith(config.OUTPUT_DIR.relative_to(config.ROOT).as_posix() + "/") else None
            except ValueError:
                rel, url = target.as_posix(), None
            from urllib.parse import quote
            files = [{"name": target.name, "path": rel, "url": url or f"/api/media/file?path={quote(rel)}", "content_type": ctype,
                      "size": target.stat().st_size}]
            say(f"Done in {time.time() - t_start:.1f} s: {target.name}, {target.stat().st_size / 2**20:.1f} MB")
            jobs._update(item, status="done", files=files, progress=1.0, finished=time.time())
        except Exception as exc:  # noqa: BLE001
            log.exception("render %s failed", item_id)
            say(f"Failed: {str(exc)[:400]}", "error")
            target.unlink(missing_ok=True)
            jobs._update(item, status="failed", error=str(exc)[:1500], finished=time.time())
        finally:
            for t in temps:
                Path(t).unlink(missing_ok=True)

    asyncio.create_task(run())
    return item
