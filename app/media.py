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
    roots = [config.UPLOAD_DIR.resolve(), config.OUTPUT_DIR.resolve()]
    roots += [Path(b["path"]) for b in _read_library().get("bookmarks", [])]
    return roots


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
    files = list(THUMB_DIR.rglob("*.webp")) if THUMB_DIR.exists() else []
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
