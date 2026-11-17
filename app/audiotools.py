"""Audio tools for reference sounds (Inputs › Reference sounds › ⋯ › Audio tools…).

A chain of ffmpeg filters, optionally after Demucs voice isolation in ComfyUI ("remove music"):

    voice isolation (Demucs, cached per source) -> rumble high-pass -> FFT noise reduction
    -> loudness normalisation -> volume -> trim silence -> limiter

``preview`` renders the chain to a short-lived file the page plays while you adjust it; ``save``
renders it to a new upload that replaces the reference (the original file is left as it is).
"""
from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field

from . import config, media

PREVIEW_PREFIX = "pv_"
PREVIEW_TTL = 3600  # seconds a preview file is kept


class AudioOpts(BaseModel):
    voice_only: bool = False  # Demucs: keep the voice, drop music and other sounds
    rumble: bool = False  # high-pass at 80 Hz: hum, wind, handling noise
    denoise: int = Field(0, ge=0, le=100)  # steady background noise (hiss, fans, room tone)
    normalize: bool = False  # even loudness (EBU R128, -16 LUFS)
    volume_db: float = Field(0.0, ge=-24, le=24)
    trim: bool = False  # cut silence at the start and end

    def is_plain(self) -> bool:
        return not (self.voice_only or self.rumble or self.denoise or self.normalize or abs(self.volume_db) > 0.01 or self.trim)


def filters(o: AudioOpts) -> str:
    """The ffmpeg -af chain for everything but voice isolation."""
    af: list[str] = []
    if o.rumble:
        af.append("highpass=f=80")
    if o.denoise:
        # afftdn: reduction 6-40 dB and a noise floor raised from -50 to -25 dB as the slider goes up (measured on
        # pink noise under speech: -25 dB about doubles the hiss cut and leaves the speech level as it was)
        af.append(f"afftdn=nr={6 + o.denoise * 0.34:.1f}:nf={-50 + o.denoise * 0.25:.1f}:tn=1")
    if o.normalize:
        af.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    if abs(o.volume_db) > 0.01:
        af.append(f"volume={o.volume_db:+.1f}dB")
    if o.trim:
        trim = "silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB"
        af += [trim, "areverse", trim, "areverse"]
    af.append("alimiter=limit=0.97:level=disabled")  # no clipping after a boost
    return ",".join(af)


def _key(ref: str) -> str:
    p = media.resolve(ref)
    st = p.stat()
    return hashlib.sha1(f"{p}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:16]


async def _ffmpeg(src: Path, out: Path, af: str) -> None:
    exe = media.ffmpeg()
    if not exe:
        raise RuntimeError("ffmpeg isn't installed")
    args = [exe, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-vn", "-af", af, "-ar", "48000"]
    args += ["-c:a", "libmp3lame", "-b:a", "192k"] if out.suffix == ".mp3" else ["-c:a", "flac"]
    proc = await asyncio.create_subprocess_exec(*args, str(out), stdout=asyncio.subprocess.DEVNULL,
                                                stderr=asyncio.subprocess.PIPE, creationflags=media.NO_WINDOW)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        out.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg: {err.decode(errors='replace').strip()[-300:] or proc.returncode}")


_isolating: dict[str, asyncio.Task] = {}


async def voice_of(ref: str, isolate: Callable[[str], Awaitable[Path]]) -> Path:
    """The voice-only version of a reference sound, made once per source file and kept."""
    target = config.UPLOAD_DIR / f"vox_{_key(ref)}.flac"
    if target.exists():
        return target
    task = _isolating.get(target.name)
    if task is None:
        async def run() -> Path:
            made = await isolate(ref)
            made.replace(target)
            return target
        task = _isolating[target.name] = asyncio.create_task(run())
    try:
        return await task
    finally:
        _isolating.pop(target.name, None)


def _sweep() -> None:
    now = time.time()
    for p in config.UPLOAD_DIR.glob(f"{PREVIEW_PREFIX}*"):
        try:
            if now - p.stat().st_mtime > PREVIEW_TTL:
                p.unlink()
        except OSError:
            pass


async def render(ref: str, o: AudioOpts, isolate: Callable[[str], Awaitable[Path]], *, keep: bool) -> dict[str, Any]:
    """Run the chain on a reference sound. keep=False: a preview file; True: a new upload."""
    src = media.resolve(ref)
    if media.kind_of(src.name) not in ("audio", "video"):
        raise ValueError("That isn't a sound or video file")
    t0 = time.monotonic()
    if o.voice_only:
        src = await voice_of(ref, isolate)
    if keep:
        out = config.UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}.flac"
    else:
        _sweep()
        h = hashlib.sha1(f"{_key(ref)}|{o.voice_only}|{filters(o)}".encode()).hexdigest()[:16]  # same sound + chain = same file
        out = config.UPLOAD_DIR / f"{PREVIEW_PREFIX}{h}.mp3"
    if keep or not out.exists():
        await _ffmpeg(src, out, filters(o))
    rel = out.relative_to(config.ROOT).as_posix()
    return {"ref": rel, "url": "/" + rel, "seconds": round(time.monotonic() - t0, 2)}
