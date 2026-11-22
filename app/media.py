"""Media files for the Inputs gallery: where they may come from, listing, thumbnails, bookmarks.

A media *ref* is how the app names a file:
  - "data/uploads/<file>" and "outputs/<day>/<file>" for files inside the app,
  - an absolute path (forward slashes) for files inside a bookmarked folder.

Only those places are readable. Bookmarks are app-wide, like Explorer's Quick
access, and live in data/library.json.

Thumbnails are made once and cached in data/thumbs (WebP): Pillow for
pictures, ffmpeg for a video frame or an audio waveform. The cache key is the
file's path, size and modified time, so an edited file gets a new thumbnail.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import string
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

from PIL import Image, ImageOps

from . import config

KINDS = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"},
    "video": {".mp4", ".webm", ".mov", ".mkv", ".m4v"},
    "audio": {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"},
}
EXT_KIND = {ext: k for k, exts in KINDS.items() for ext in exts}
THUMB_DIR = config.DATA_DIR / "thumbs"
LIBRARY_FILE = config.DATA_DIR / "library.json"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class MediaError(ValueError):
    pass


def kind_of(name: str) -> str | None:
    return EXT_KIND.get(Path(name).suffix.lower())


# --------------------------------------------------------------------------- bookmarks

def _read_library() -> dict[str, Any]:
    try:
        return json.loads(LIBRARY_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return {"bookmarks": []}


def _write_library(data: dict[str, Any]) -> None:
    LIBRARY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = LIBRARY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), "utf-8")
    tmp.replace(LIBRARY_FILE)


def bookmarks() -> list[dict[str, Any]]:
    out = []
    for b in _read_library().get("bookmarks", []):
        out.append({**b, "exists": Path(b["path"]).is_dir()})
    return out


def add_bookmark(path: str, name: str = "") -> dict[str, Any]:
    p = Path(path.strip().strip('"')).expanduser()
    if not p.is_absolute():
        raise MediaError("Use a full folder path, like D:\\Pictures")
    try:
        p = p.resolve(strict=True)
    except OSError as exc:
        raise MediaError(f"Folder not found: {path}") from exc
    if not p.is_dir():
        raise MediaError("That's a file; bookmark its folder instead")
    if p == Path(p.anchor):
        raise MediaError("Bookmark a folder, not a whole drive")
    data = _read_library()
    for b in data.get("bookmarks", []):
        if Path(b["path"]) == p:
            return b
    b = {"id": uuid.uuid4().hex[:10], "name": (name or p.name).strip()[:80], "path": p.as_posix(), "added": time.time()}
    data.setdefault("bookmarks", []).append(b)
    _write_library(data)
    return b


def update_bookmark(bid: str, name: str) -> dict[str, Any]:
    data = _read_library()
    for b in data.get("bookmarks", []):
        if b["id"] == bid:
            b["name"] = name.strip()[:80] or b["name"]
            _write_library(data)
            return b
    raise MediaError("Bookmark not found")


def remove_bookmark(bid: str) -> None:
    data = _read_library()
    data["bookmarks"] = [b for b in data.get("bookmarks", []) if b["id"] != bid]
    _write_library(data)


def bookmark(bid: str) -> Path:
    for b in _read_library().get("bookmarks", []):
        if b["id"] == bid:
            return Path(b["path"])
    raise MediaError("Bookmark not found")


# --------------------------------------------------------------------------- refs and paths

def allowed_roots() -> list[Path]:
    from . import projectmedia  # the projects' folders (ComfyUI's output/bob)

    roots = [config.UPLOAD_DIR.resolve(), config.OUTPUT_DIR.resolve(), projectmedia.LINK.resolve()]
    roots += [Path(b["path"]) for b in _read_library().get("bookmarks", [])]
    return roots


def reveal(path: Path) -> None:
    """Open Explorer with the file selected. The command line is written out as Explorer wants it,
    /select,"C:\a folder\file.mp4": given as a list, the whole /select,... argument was quoted as one
    when the path had a space, and Explorer opened its default folder instead."""
    p = os.path.normpath(str(path))
    subprocess.Popen(f'explorer.exe /select,"{p}"', creationflags=NO_WINDOW)


def resolve(ref: str) -> Path:
    """Turn a media ref into a real file path, refusing anything outside the allowed places."""
    if not ref:
        raise MediaError("No file given")
    raw = Path(ref)
    p = (raw if raw.is_absolute() else config.ROOT / ref.lstrip("/")).resolve()
    if not any(p == r or r in p.parents for r in allowed_roots()):
        raise MediaError(f"Not an allowed media location: {ref}")
    if not p.is_file():
        raise MediaError(f"File not found: {ref}")
    return p


def recycle(paths: list[Path]) -> None:
    """Send files to the Recycle Bin (Windows), so a delete can be undone from there.

    Elsewhere only the studio's own folders (uploads, results) are deleted for good; files in
    bookmarked folders are refused, since they belong to the user and couldn't come back."""
    if not paths:
        return
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                        ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                        ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

        FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 3, 0x4, 0x10, 0x40, 0x400
        op = SHFILEOPSTRUCTW(wFunc=FO_DELETE, pFrom="\0".join(str(p) for p in paths) + "\0\0",
                             fFlags=FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI)
        rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        if rc or op.fAnyOperationsAborted:
            raise MediaError(f"Windows couldn't move the files to the Recycle Bin (code {rc})")
        return
    from . import projectmedia

    own = [config.UPLOAD_DIR.resolve(), config.OUTPUT_DIR.resolve(), projectmedia.LINK.resolve()]
    for p in paths:
        if not any(r in p.parents for r in own):
            raise MediaError(f"Only the studio's own files can be deleted here (no Recycle Bin): {p.name}")
    for p in paths:
        p.unlink()


def ref_of(p: Path) -> str:
    p = p.resolve()
    try:
        return p.relative_to(config.ROOT.resolve()).as_posix()
    except ValueError:
        return p.as_posix()


def url_of(ref: str) -> str:
    if ref.startswith(("outputs/", "data/uploads/")):
        return "/" + quote(ref)
    return "/api/media/file?path=" + quote(ref, safe="")


def thumb_url(ref: str, mtime: float, w: int = 256) -> str:
    return f"/api/media/thumb?path={quote(ref, safe='')}&w={w}&v={int(mtime)}"


def describe(p: Path) -> dict[str, Any] | None:
    kind = kind_of(p.name)
    if not kind:
        return None
    try:
        st = p.stat()
    except OSError:
        return None
    ref = ref_of(p)
    return {"ref": ref, "name": p.name, "kind": kind, "size": st.st_size, "modified": st.st_mtime,
            "url": url_of(ref), "thumb": thumb_url(ref, st.st_mtime)}


# --------------------------------------------------------------------------- listing

def list_folder(base: Path, sub: str = "", limit: int = 2000) -> dict[str, Any]:
    """Folders and media files directly inside base/sub (sub is relative, "/"-separated)."""
    base = base.resolve()
    here = (base / sub).resolve() if sub else base
    if here != base and base not in here.parents:
        raise MediaError("Path is outside the folder")
    if not here.is_dir():
        raise MediaError("Folder not found")
    folders, files = [], []
    try:
        entries = sorted(os.scandir(here), key=lambda e: e.name.lower())
    except OSError as exc:
        raise MediaError(f"Can't read {here}: {exc.strerror or exc}") from exc
    for e in entries:
        if e.name.startswith((".", "$")):
            continue
        try:
            if e.is_dir():
                folders.append({"name": e.name, "sub": Path(here, e.name).relative_to(base).as_posix()})
            elif e.is_file() and len(files) < limit:
                d = describe(Path(e.path))
                if d:
                    files.append(d)
        except OSError:
            continue
    rel = here.relative_to(base).as_posix() if here != base else ""
    crumbs, acc = [], []
    for part in Path(rel).parts if rel else []:
        acc.append(part)
        crumbs.append({"name": part, "sub": "/".join(acc)})
    return {"sub": rel, "crumbs": crumbs, "folders": folders, "files": files, "truncated": len(files) >= limit}


def list_results(items: list[dict[str, Any]], project: str | None) -> list[dict[str, Any]]:
    """Finished results of one project (None = Experiment), newest first."""
    out = []
    for it in items:
        if it.get("status") != "done" or (it.get("project") or None) != project:
            continue
        for f in it.get("files", []):
            p = config.ROOT / f["path"]
            d = describe(p) if p.is_file() else None
            if d:
                d["job"] = it["id"]
                d["prompt"] = (it.get("params") or {}).get("prompt", "")[:200]
                out.append(d)
    return out


# --------------------------------------------------------------------------- thumbnails

def ffmpeg() -> str | None:
    return os.environ.get("BOB_FFMPEG") or shutil.which("ffmpeg")


def tail_clip(ref: str, frames: int, width: int, height: int, out: Path) -> Path:
    """The last `frames` frames of a video at 24 fps and width x height (cropped to fill), with its sound (silence
    when it has none), for continuing it without a cut (workflows.build_h3_ref, continue_overlap)."""
    src = resolve(ref)
    exe = ffmpeg()
    if not exe:
        raise MediaError("ffmpeg isn't installed")
    info = probe(ref)
    dur = float(info.get("duration") or 0)
    secs = frames / 24.0
    if dur < secs:
        raise MediaError(f"{src.name} is {dur:.2f} s long: shorter than the {frames}-frame overlap")
    start = max(0.0, dur - secs - 0.05)
    vf = (f"fps=24,scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,"
          f"trim=start_frame=0,setpts=PTS-STARTPTS")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [exe, "-nostdin", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(src)]
    if info.get("has_audio"):
        cmd += ["-map", "0:v:0", "-map", "0:a:0"]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0"]
    # the LAST `frames` frames: keep them all, then cut from the end
    cmd += ["-vf", vf + f",reverse,trim=end_frame={frames},reverse,setpts=PTS-STARTPTS",
            "-af", f"aresample=48000,areverse,atrim=end={secs:.4f},areverse,asetpts=PTS-STARTPTS",
            "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", str(out)]
    r = subprocess.run(cmd, capture_output=True, timeout=300, creationflags=NO_WINDOW)
    if r.returncode or not out.is_file():
        raise MediaError((r.stderr or b"").decode("utf-8", "replace").strip()[-300:] or f"Couldn't cut the end of {src.name}")
    return out


def parse_ranges(text: str, duration: float) -> list[tuple[float, float]]:
    """ "1.2-3.4, 5-6" (or "1.2,3.4,5,6") -> [(1.2, 3.4), (5.0, 6.0)]: stretches of a clip in seconds, sorted, merged
    where they touch, inside 0..duration. "" -> []."""
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text or "")]
    if len(nums) % 2:
        raise MediaError("Give each stretch as a start and an end, in seconds (e.g. 1.2-3.4)")
    out: list[tuple[float, float]] = []
    for a, b in sorted(zip(nums[::2], nums[1::2])):
        a, b = max(0.0, a), min(duration, b)
        if b - a < 0.2:
            raise MediaError(f"{a:g}-{b:g} s: a stretch needs at least 0.2 s inside the clip ({duration:.2f} s)")
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def retake_source(ref: str, width: int, height: int, frames: int, out: Path) -> Path:
    """A video for retaking its sound (engine "retake"): 24 fps at width x height (cropped to fill), the last frame
    held out to `frames` (H3's 17k+5 grid), and its sound padded with silence to the same length (all silence when it
    has none). The picture here is only what H3 hears the sound against; the result keeps the original's."""
    src = resolve(ref)
    exe = ffmpeg()
    if not exe:
        raise MediaError("ffmpeg isn't installed")
    info = probe(ref)
    secs = frames / 24.0
    cmd = [exe, "-nostdin", "-v", "error", "-y", "-i", str(src)]
    if info.get("has_audio"):
        cmd += ["-map", "0:v:0", "-map", "0:a:0"]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0"]
    vf = (f"fps=24,scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,"
          f"tpad=stop_mode=clone:stop_duration={secs:.3f},trim=end_frame={frames},setpts=PTS-STARTPTS")
    cmd += ["-vf", vf, "-af", f"aresample=48000,apad,atrim=end={secs:.4f},asetpts=PTS-STARTPTS",
            "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", str(out)]
    out.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(cmd, capture_output=True, timeout=600, creationflags=NO_WINDOW)
    if r.returncode or not out.is_file():
        raise MediaError((r.stderr or b"").decode("utf-8", "replace").strip()[-300:] or f"Couldn't prepare {src.name}")
    return out


def mix_audio(voice: Path, background: Path, out: Path) -> Path:
    """A voice over a background, as they are (no level change): a retake's new voice over the original's music and
    sounds (MelBand RoFormer's two parts)."""
    exe = ffmpeg()
    if not exe:
        raise MediaError("ffmpeg isn't installed")
    cmd = [exe, "-nostdin", "-v", "error", "-y", "-i", str(voice), "-i", str(background), "-filter_complex",
           "[0:a]aresample=48000,aformat=channel_layouts=stereo[v];[1:a]aresample=48000,aformat=channel_layouts=stereo[b];"
           "[v][b]amix=inputs=2:normalize=0:duration=longest[a]", "-map", "[a]", "-c:a", "flac", str(out)]
    r = subprocess.run(cmd, capture_output=True, timeout=300, creationflags=NO_WINDOW)
    if r.returncode or not out.is_file():
        raise MediaError((r.stderr or b"").decode("utf-8", "replace").strip()[-300:] or "Couldn't mix the voice and background")
    return out


def retake_mux(ref: str, new_audio: Path, ranges: list[tuple[float, float]], out: Path, fade: float = 0.08) -> Path:
    """The original video, picture untouched (stream copy), with the retake's sound: all of it, or with `ranges`
    only those stretches, crossfading over `fade` s at each edge into the original sound around them."""
    src = resolve(ref)
    exe = ffmpeg()
    if not exe:
        raise MediaError("ffmpeg isn't installed")
    info = probe(ref)
    dur = float(info.get("duration") or 0)
    cmd = [exe, "-nostdin", "-v", "error", "-y", "-i", str(src), "-i", str(new_audio)]
    new = f"[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=end={dur:.4f}"
    if ranges and info.get("has_audio"):
        # m(t): 1 inside a stretch, easing to 0 over `fade` s outside it; the new sound times m, the original 1 - m
        f = max(0.01, fade)
        m = "+".join(f"clip(min((t-{a:.4f}+{f})/{f},({b:.4f}+{f}-t)/{f}),0,1)" for a, b in ranges)
        m = f"min(1,{m})"
        fc = (f"{new},volume='{m}':eval=frame[n];"
              f"[0:a]aresample=48000,aformat=channel_layouts=stereo,volume='1-({m})':eval=frame[o];"
              "[n][o]amix=inputs=2:normalize=0:duration=first[a]")
    else:
        fc = f"{new}[a]"
    cmd += ["-filter_complex", fc, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(out)]
    out.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(cmd, capture_output=True, timeout=600, creationflags=NO_WINDOW)
    if r.returncode or not out.is_file():
        raise MediaError((r.stderr or b"").decode("utf-8", "replace").strip()[-300:] or "Couldn't put the new sound in")
    return out


def playable_audio(ref: str) -> Path:
    """The file's sound as Opus in WebM, for browsers that can't decode its own codec (AAC in MP4
    on Chromium builds without proprietary codecs, like Avast Secure Browser). Cached next to the
    thumbnails; timing matches the original from 0 s."""
    src = resolve(ref)
    st = src.stat()
    key = hashlib.sha1(f"{src}|{st.st_size}|{st.st_mtime_ns}|opus1".encode()).hexdigest()
    out = THUMB_DIR / key[:2] / f"{key}.webm"
    if out.is_file():
        return out
    exe = ffmpeg()
    if not exe:
        raise MediaError("ffmpeg isn't installed")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".tmp.webm")
    r = subprocess.run([exe, "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn", "-map", "0:a:0",
                        "-c:a", "libopus", "-b:a", "160k", "-ar", "48000", str(tmp)],
                       capture_output=True, timeout=600, creationflags=NO_WINDOW)
    if r.returncode or not tmp.is_file():
        tmp.unlink(missing_ok=True)
        raise MediaError((r.stderr or b"").decode("utf-8", "replace").strip()[-300:] or "no sound in that file")
    tmp.replace(out)
    return out


def peaks(ref: str) -> dict[str, Any]:
    """Sound levels for drawing a waveform graph: per bucket the peak and RMS level (0–255,
    linear), `rate` buckets per second of the file. Cached next to the thumbnails."""
    import array
    import json
    import math

    src = resolve(ref)
    st = src.stat()
    key = hashlib.sha1(f"{src}|{st.st_size}|{st.st_mtime_ns}|peaks2".encode()).hexdigest()
    out = THUMB_DIR / key[:2] / f"{key}.peaks.json"
    if out.is_file():
        try:
            return json.loads(out.read_text("utf-8"))
        except (OSError, ValueError):
            pass
    exe = ffmpeg()
    if not exe:
        raise MediaError("ffmpeg isn't installed")
    sr = 8000
    r = subprocess.run([exe, "-nostdin", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                       capture_output=True, timeout=300, creationflags=NO_WINDOW)
    data = array.array("h")
    data.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    seconds = len(data) / sr
    rate = 100 if seconds <= 600 else 25
    n = sr // rate
    peak, rms = bytearray(), bytearray()
    for i in range(0, len(data), n):
        b = data[i:i + n]
        if not b:
            break
        peak.append(min(255, round(max(max(b), -min(b)) / 32768 * 255)))
        rms.append(min(255, round(math.sqrt(math.sumprod(b, b) / len(b)) / 32768 * 255)))
    res = {"rate": rate, "seconds": round(seconds, 3), "peak": list(peak), "rms": list(rms)}
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(res, separators=(",", ":")), "utf-8")
    tmp.replace(out)
    return res


def thumbnail(ref: str, width: int = 256) -> Path:
    """Path of a cached WebP thumbnail for ref, making it first if needed."""
    width = max(64, min(640, int(width)))
    src = resolve(ref)
    st = src.stat()
    key = hashlib.sha1(f"{src}|{st.st_size}|{st.st_mtime_ns}|{width}".encode()).hexdigest()
    out = THUMB_DIR / key[:2] / f"{key}.webp"
    if out.is_file():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    kind = kind_of(src.name)
    tmp = out.with_suffix(".tmp.webp")
    if kind == "image":
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((width, width * 2))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            im.save(tmp, "WEBP", quality=82, method=4)
    else:
        exe = ffmpeg()
        if not exe:
            raise MediaError("ffmpeg isn't installed, so there's no thumbnail for this file")
        if kind == "video":
            cmd = [exe, "-nostdin", "-v", "error", "-y", "-ss", "0.5", "-i", str(src), "-frames:v", "1",
                   "-vf", f"scale={width}:-2", "-c:v", "libwebp", "-quality", "80", str(tmp)]
            r = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=NO_WINDOW)
            if r.returncode or not tmp.is_file():  # very short clips: take the first frame
                cmd[cmd.index("-ss") + 1] = "0"
                r = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=NO_WINDOW)
        else:  # audio: a waveform picture
            h = max(48, width // 2)
            cmd = [exe, "-nostdin", "-v", "error", "-y", "-i", str(src), "-filter_complex",
                   f"aformat=channel_layouts=mono,showwavespic=s={width}x{h}:colors=#3ccfc0",
                   "-frames:v", "1", "-c:v", "libwebp", str(tmp)]
            r = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=NO_WINDOW)
        if r.returncode or not tmp.is_file():
            raise MediaError(f"ffmpeg couldn't read {src.name}: {r.stderr.decode(errors='replace')[-300:]}")
    tmp.replace(out)
    return out


def cache_size() -> dict[str, Any]:
    files = [*THUMB_DIR.rglob("*.webp"), *THUMB_DIR.rglob("*.peaks.json")] if THUMB_DIR.exists() else []
    return {"files": len(files), "bytes": sum(f.stat().st_size for f in files)}


def clear_cache() -> dict[str, Any]:
    before = cache_size()
    if THUMB_DIR.exists():
        shutil.rmtree(THUMB_DIR)
    return before


# --------------------------------------------------------------------------- probe and frames

_probe_cache: dict[tuple[str, int, float], dict[str, Any]] = {}


def ffprobe() -> str | None:
    exe = ffmpeg()
    if exe:
        cand = Path(exe).with_name("ffprobe" + Path(exe).suffix)
        if cand.is_file():
            return str(cand)
    return shutil.which("ffprobe")


def probe(ref: str) -> dict[str, Any]:
    """Duration, size and audio of a media file (cached by path, size and time)."""
    src = resolve(ref)
    st = src.stat()
    key = (str(src), st.st_size, st.st_mtime)
    if key in _probe_cache:
        return _probe_cache[key]
    kind = kind_of(src.name)
    info: dict[str, Any] = {"ref": ref, "kind": kind, "duration": None, "width": None, "height": None,
                            "fps": None, "has_audio": kind == "audio"}
    if kind == "image":
        with Image.open(src) as im:
            info["width"], info["height"] = im.size
    else:
        exe = ffprobe()
        if not exe:
            raise MediaError("ffprobe isn't installed, so clip lengths can't be read")
        r = subprocess.run([exe, "-v", "error", "-show_entries",
                            "format=duration:stream=codec_type,width,height,avg_frame_rate", "-of", "json", str(src)],
                           capture_output=True, timeout=30, creationflags=NO_WINDOW)
        if r.returncode:
            raise MediaError(f"Can't read {src.name}")
        data = json.loads(r.stdout or b"{}")
        info["duration"] = float((data.get("format") or {}).get("duration") or 0) or None
        for s in data.get("streams", []):
            if s.get("codec_type") == "video" and not info["width"]:
                info["width"], info["height"] = s.get("width"), s.get("height")
                num, _, den = (s.get("avg_frame_rate") or "0/1").partition("/")
                info["fps"] = round(float(num) / float(den or 1), 3) if float(den or 1) else None
            if s.get("codec_type") == "audio":
                info["has_audio"] = True
    _probe_cache[key] = info
    return info


def grab_frame(ref: str, t: float) -> dict[str, Any]:
    """Save the frame of a video at t seconds (or a copy of a picture) as a PNG upload."""
    src = resolve(ref)
    target = config.UPLOAD_DIR / f"frame_{uuid.uuid4().hex[:10]}.png"
    if kind_of(src.name) == "image":
        with Image.open(src) as im:
            im.save(target, "PNG")
    else:
        exe = ffmpeg()
        if not exe:
            raise MediaError("ffmpeg isn't installed")
        dur = probe(ref).get("duration") or 0
        t = max(0.0, min(float(t), max(0.0, dur - 0.05)))
        r = subprocess.run([exe, "-nostdin", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", str(target)],
                           capture_output=True, timeout=60, creationflags=NO_WINDOW)
        if r.returncode or not target.is_file():
            raise MediaError(f"Couldn't grab a frame from {src.name}")
    rel = ref_of(target)
    return {"ref": rel, "url": url_of(rel), "name": target.name}


# --------------------------------------------------------------------------- folder picker

def list_dirs(path: str = "") -> dict[str, Any]:
    """Sub-folders of path for the bookmark picker; "" lists drives and common folders."""
    if not path:
        places = []
        home = Path.home()
        for name in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"):
            p = home / name
            if p.is_dir():
                places.append({"name": name, "path": p.as_posix(), "type": "place"})
        if sys.platform == "win32":
            drives = [f"{d}:/" for d in string.ascii_uppercase if os.path.exists(f"{d}:/")]
        else:
            drives = ["/"]
        return {"path": "", "parent": None, "dirs": places + [{"name": d, "path": d, "type": "drive"} for d in drives]}
    p = Path(path).expanduser()
    if not p.is_dir():
        raise MediaError("Folder not found")
    dirs = []
    try:
        for e in sorted(os.scandir(p), key=lambda e: e.name.lower()):
            if e.name.startswith((".", "$")):
                continue
            try:
                if e.is_dir():
                    dirs.append({"name": e.name, "path": Path(e.path).as_posix(), "type": "folder"})
            except OSError:
                continue
    except OSError as exc:
        raise MediaError(f"Can't open {p}: {exc.strerror or exc}") from exc
    parent = p.resolve().parent
    return {"path": p.resolve().as_posix(), "parent": "" if parent == p.resolve() else parent.as_posix(), "dirs": dirs}
