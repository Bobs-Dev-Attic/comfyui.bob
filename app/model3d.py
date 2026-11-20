"""Make 3D: a textured 3D model (GLB) of the object in a picture, with TRELLIS.2 in ComfyUI.

A model is made in the background (it takes a few minutes); the list of models lives in data/models3d.json and the
files in outputs/3d/: <id>.glb and <id>_input.png (the cut-out the model was made from, also its thumbnail).
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import shutil
import threading
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

from . import config, workflows

log = logging.getLogger("bob.model3d")
MODELS_FILE = config.DATA_DIR / "models3d.json"
OUT_DIR = config.OUTPUT_DIR / "3d"
_lock = threading.Lock()
_tasks: dict[str, asyncio.Task] = {}


def _read() -> list[dict[str, Any]]:
    try:
        return json.loads(MODELS_FILE.read_text("utf-8")).get("models", [])
    except (OSError, ValueError):
        return []


def _write(items: list[dict[str, Any]]) -> None:
    MODELS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = MODELS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"models": items}, indent=1, ensure_ascii=False), "utf-8")
    tmp.replace(MODELS_FILE)


def _update(model_id: str, **fields: Any) -> dict[str, Any] | None:
    with _lock:
        items = _read()
        for m in items:
            if m["id"] == model_id:
                m.update(fields)
                _write(items)
                return m
    return None


def _url(rel: str | None) -> str | None:
    return "/" + rel if rel else None


def _public(m: dict[str, Any]) -> dict[str, Any]:
    return {**m, "glb_url": _url(m.get("glb")), "thumb_url": _url(m.get("thumb"))}


def list_models(project: str | None = None) -> list[dict[str, Any]]:
    items = [m for m in _read() if project is None or m.get("project") == project]
    return [_public(m) for m in sorted(items, key=lambda m: m.get("created", 0), reverse=True)]


def get(model_id: str) -> dict[str, Any] | None:
    return next((_public(m) for m in _read() if m["id"] == model_id), None)


def recover() -> None:
    """At startup: a model that was being made when the studio stopped won't finish."""
    with _lock:
        items = _read()
        changed = False
        for m in items:
            if m.get("status") == "running":
                m.update(status="failed", error="The studio restarted while this was being made", finished=time.time())
                changed = True
        if changed:
            _write(items)


def busy() -> bool:
    return any(not t.done() for t in _tasks.values())


def rename(model_id: str, name: str) -> dict[str, Any] | None:
    m = _update(model_id, name=name.strip()[:120] or "3D model")
    return _public(m) if m else None


def delete(model_id: str) -> bool:
    with _lock:
        items = _read()
        keep = [m for m in items if m["id"] != model_id]
        if len(keep) == len(items):
            return False
        _write(keep)
    t = _tasks.pop(model_id, None)
    if t and not t.done():
        t.cancel()
    for p in OUT_DIR.glob(f"{model_id}*"):
        p.unlink(missing_ok=True)
    return True


def start(jobs: Any, files: dict[str, str], *, source: str, mask: str | None, name: str, project: str | None,
          quality: str, seed: int | None, bg_model: str | None) -> dict[str, Any]:
    """Queue a model: returns its entry at once (status "running"); the work goes on in the background."""
    model_id = uuid.uuid4().hex[:12]
    seed = int(seed) if seed is not None and seed >= 0 else random.randint(0, 2**31 - 1)
    entry = {"id": model_id, "name": name.strip()[:120] or "3D model", "source": source, "mask": mask,
             "project": project, "quality": quality, "seed": seed, "model": "TRELLIS.2", "status": "running",
             "error": None, "created": time.time(), "finished": None, "seconds": None, "glb": None, "thumb": None,
             "size": None}
    with _lock:
        items = _read()
        items.append(entry)
        _write(items)
    built = workflows.build_make3d(files, seed=seed, quality=quality, masked=bool(mask), bg_model=bg_model,
                                   prefix=f"bob/3d/{model_id}")
    refs = {"source": source, **({"mask": mask} if mask else {})}
    _tasks[model_id] = asyncio.get_running_loop().create_task(_run(jobs, model_id, built, refs))
    return _public(entry)


async def _fetch_glb(http: Any, model_id: str, target: Path) -> bool:
    """The comfy-sdk proxy hands back pictures, videos and sounds but not SaveGLB's "3d" output, so the model is
    found in ComfyUI's own history (by its file name, which starts with the model's id) and downloaded."""
    r = await http.get(f"{config.COMFYUI_URL}/history", params={"max_items": 64}, timeout=30.0)
    r.raise_for_status()
    for entry in reversed(list(r.json().values())):
        for out in (entry.get("outputs") or {}).values():
            for f in out.get("3d") or []:
                name = f.get("filename") or ""
                if name.startswith(f"{model_id}_") and name.lower().endswith(".glb"):
                    v = await http.get(f"{config.COMFYUI_URL}/view", timeout=300.0, params={
                        "filename": name, "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
                    v.raise_for_status()
                    target.write_bytes(v.content)
                    return target.stat().st_size > 0
    return False


async def _run(jobs: Any, model_id: str, built: workflows.Built, refs: dict[str, str]) -> None:
    t0 = time.monotonic()
    paths: list[Path] = []
    try:
        paths = await jobs.run_quick(built, refs, timeout=3600)
        glb = next((p for p in paths if p.suffix.lower() == ".glb"), None)
        png = next((p for p in paths if p.suffix.lower() == ".png"), None)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        target = OUT_DIR / f"{model_id}.glb"
        if glb:
            shutil.move(str(glb), target)
        elif not await _fetch_glb(jobs.comfy.http, model_id, target):
            raise RuntimeError("ComfyUI returned no 3D model")
        thumb = None
        if png:
            thumb = OUT_DIR / f"{model_id}_input.png"
            shutil.move(str(png), thumb)
        if not get(model_id):  # deleted while it was being made
            target.unlink(missing_ok=True)
            if thumb:
                thumb.unlink(missing_ok=True)
            return
        _update(model_id, status="done", finished=time.time(), seconds=round(time.monotonic() - t0, 1),
                glb=target.relative_to(config.ROOT).as_posix(), size=target.stat().st_size,
                thumb=thumb.relative_to(config.ROOT).as_posix() if thumb else None)
        log.info("3D model %s made in %.0f s", model_id, time.monotonic() - t0)
    except asyncio.CancelledError:
        _update(model_id, status="failed", error="Cancelled", finished=time.time())
        raise
    except Exception as exc:  # noqa: BLE001 - ComfyUI's own error text is the useful part
        log.exception("3D model %s failed", model_id)
        _update(model_id, status="failed", error=str(exc)[:500] or type(exc).__name__, finished=time.time())
    finally:
        for p in paths:
            if p.exists() and p.parent == config.UPLOAD_DIR:
                p.unlink(missing_ok=True)
        _tasks.pop(model_id, None)


# --------------------------------------------------------------------------- 3D scenes
# A scene: a picture's background as a depth surface (Depth Anything 3) with 3D models standing in it. The list lives
# in data/scenes3d.json; each background is outputs/3d/scene_<id>.glb. Objects are placed and moved in the page;
# the server keeps what it's sent.

SCENES_FILE = config.DATA_DIR / "scenes3d.json"


def _read_scenes() -> list[dict[str, Any]]:
    try:
        return json.loads(SCENES_FILE.read_text("utf-8")).get("scenes", [])
    except (OSError, ValueError):
        return []


def _write_scenes(items: list[dict[str, Any]]) -> None:
    SCENES_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SCENES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"scenes": items}, indent=1, ensure_ascii=False), "utf-8")
    tmp.replace(SCENES_FILE)


def _scene_public(s: dict[str, Any]) -> dict[str, Any]:
    q = lambda ref: f"/api/media/file?path={urllib.parse.quote(ref)}" if ref else None  # noqa: E731
    bd = s.get("backdrop") or {}
    return {**s, "bg_url": _url(s.get("bg")), "picture_url": q(s.get("picture")), "plate_url": q(s.get("plate")),
            "backdrop_url": q(bd.get("picture"))}


def list_scenes() -> list[dict[str, Any]]:
    return [_scene_public(s) for s in sorted(_read_scenes(), key=lambda s: s.get("updated", 0), reverse=True)]


def get_scene(scene_id: str) -> dict[str, Any] | None:
    return next((_scene_public(s) for s in _read_scenes() if s["id"] == scene_id), None)


def update_scene(scene_id: str, **fields: Any) -> dict[str, Any] | None:
    with _lock:
        items = _read_scenes()
        for s in items:
            if s["id"] == scene_id:
                s.update(fields, updated=time.time())
                _write_scenes(items)
                return _scene_public(s)
    return None


def copy_scene(scene_id: str, *, name: str | None = None, project: str | None = None) -> dict[str, Any] | None:
    """A new scene from another (a template): its background, objects, camera path, length, framing and effects, in
    `project`. Its photos stay with the original (they're results of that scene) and it isn't a template itself."""
    with _lock:
        items = _read_scenes()
        src = next((s for s in items if s["id"] == scene_id), None)
        if not src or src.get("status") != "done":
            return None
        new_id, now = uuid.uuid4().hex[:12], time.time()
        entry = json.loads(json.dumps(src))
        entry.update(id=new_id, name=(name or src.get("name") or "3D scene").strip()[:120], project=project, photos=[],
                     template=False, from_template=scene_id, created=now, updated=now)
        if src.get("bg"):
            old = config.ROOT / src["bg"]
            if old.is_file():
                target = OUT_DIR / f"scene_{new_id}.glb"
                shutil.copyfile(old, target)
                entry["bg"] = target.relative_to(config.ROOT).as_posix()
        items.append(entry)
        _write_scenes(items)
    return _scene_public(entry)


def delete_scene(scene_id: str) -> bool:
    with _lock:
        items = _read_scenes()
        keep = [s for s in items if s["id"] != scene_id]
        if len(keep) == len(items):
            return False
        _write_scenes(keep)
    (OUT_DIR / f"scene_{scene_id}.glb").unlink(missing_ok=True)
    return True


def start_scene(jobs: Any, *, picture: str | None, plate: str | None, name: str, project: str | None,
                objects: list[dict[str, Any]], seconds: float | None = None, aspect: str | None = None) -> dict[str, Any]:
    """Make a scene's background (a few seconds); returns the entry at once (status "running"). Without a picture
    it's an empty scene (a floor and a backdrop, drawn in the page), ready at once."""
    scene_id = uuid.uuid4().hex[:12]
    now = time.time()
    entry = {"id": scene_id, "name": name.strip()[:120] or "3D scene", "project": project, "picture": picture,
             "plate": plate, "status": "running" if picture else "done", "error": None, "bg": None, "objects": objects,
             "seconds": float(seconds or 5.0), "camera_keys": [], "created": now, "updated": now}
    if not picture:  # an empty scene: its framing and backdrop
        entry.update(kind="empty", aspect=aspect or "16:9", lens=35.0,
                     backdrop={"sky": "#c9d3de", "floor": "#8b9098", "picture": None})
    with _lock:
        items = _read_scenes()
        items.append(entry)
        _write_scenes(items)
    if not picture:
        return _scene_public(entry)
    built = workflows.build_scene_background(prefix=f"bob/scene/{scene_id}")
    _tasks[f"scene_{scene_id}"] = asyncio.get_running_loop().create_task(_run_scene(jobs, scene_id, built, plate or picture))
    return _scene_public(entry)


async def _run_scene(jobs: Any, scene_id: str, built: workflows.Built, source: str) -> None:
    paths: list[Path] = []
    try:
        paths = await jobs.run_quick(built, {"source": source}, timeout=600)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        target = OUT_DIR / f"scene_{scene_id}.glb"
        glb = next((p for p in paths if p.suffix.lower() == ".glb"), None)
        if glb:
            shutil.move(str(glb), target)
        elif not await _fetch_glb(jobs.comfy.http, scene_id, target):
            raise RuntimeError("ComfyUI returned no background")
        if not update_scene(scene_id, status="done", bg=target.relative_to(config.ROOT).as_posix()):
            target.unlink(missing_ok=True)  # deleted meanwhile
    except asyncio.CancelledError:
        update_scene(scene_id, status="failed", error="Cancelled")
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("3D scene %s failed", scene_id)
        update_scene(scene_id, status="failed", error=str(exc)[:500] or type(exc).__name__)
    finally:
        for p in paths:
            if p.exists() and p.parent == config.UPLOAD_DIR:
                p.unlink(missing_ok=True)
        _tasks.pop(f"scene_{scene_id}", None)


def recover_scenes() -> None:
    with _lock:
        items = _read_scenes()
        if any(s.get("status") == "running" for s in items):
            for s in items:
                if s.get("status") == "running":
                    s.update(status="failed", error="The studio restarted while this was being made")
            _write_scenes(items)
