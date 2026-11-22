"""Each project's own folder of media and files: ComfyUI's output/bob/<Project>.

The studio sees that folder as `bob/` in its own root (a directory junction to ComfyUI's output/bob, made at startup),
so its media refs stay plain relative paths ("bob/Restaurant dinner/scenes/Shot 1/ab12cd34_00001_.mp4") that every
part of the studio already resolves, and ComfyUI saves a render straight into the folder it belongs in.

    bob/<Project>/
      project.json             a copy of the project file, kept up to date
      board.json               V2's shots
      videos/  images/  audio/ results that aren't a scene's
      scenes/<Scene>/
        scene.json             the 3D scene (objects, camera keys)
        <id>_3d.mp4            its render of the move, as H3 followed it (and <id>_3d_mask.mp4 with Time-to-Move)
        <id>_00001_.png/.mp4   its photos, the edit model's fills and close-up views, its takes
        <id>.json              each one's request: the prompt as sent, the model, seed and settings

Folder names are the project's and the scene's names when they were first used (recorded in bob/.folders.json, so a
rename doesn't split a project's files); two of the same name get the id after it. Without BOB_COMFYUI_DIR the folder
is a plain bob/ in the studio's root."""
from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import threading
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger(__name__)

LINK = config.ROOT / "bob"
INDEX = ".folders.json"
_lock = threading.Lock()


def comfy_bob_dir() -> Path | None:
    """ComfyUI's output/bob on this PC (its --output-directory when one is set), from BOB_COMFYUI_DIR."""
    if not config.COMFYUI_DIR:
        return None
    try:
        args = shlex.split(config.COMFYUI_ARGS or "", posix=False)
    except ValueError:
        args = []
    for i, a in enumerate(args):
        if a == "--output-directory" and i + 1 < len(args):
            return Path(args[i + 1].strip('"')).expanduser() / "bob"
    from . import comfylaunch

    inst = comfylaunch.find_install(config.COMFYUI_DIR)
    return inst.comfy / "output" / "bob" if inst else None


def setup() -> Path:
    """Make bob/ in the studio's root: a junction to ComfyUI's output/bob, else a plain folder. Returns the real folder."""
    target = comfy_bob_dir()
    try:
        if target:
            target.mkdir(parents=True, exist_ok=True)
            if not os.path.lexists(LINK):
                if os.name == "nt":
                    subprocess.run(["cmd", "/c", "mklink", "/J", str(LINK), str(target)], capture_output=True, check=True,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                else:
                    LINK.symlink_to(target, target_is_directory=True)
            elif LINK.resolve() != target.resolve():
                log.warning("bob/ in the studio's folder isn't ComfyUI's output/bob (%s); project files go to bob/ as it is", target)
        LINK.mkdir(parents=True, exist_ok=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        log.warning("Couldn't link bob/ to ComfyUI's output/bob: %s", exc)
        LINK.mkdir(parents=True, exist_ok=True)
    return LINK.resolve()


def clean(name: str) -> str:
    """A name Windows takes as a folder: no <>:"/\\|?* or control characters, no trailing dots or spaces."""
    s = re.sub(r'[<>:"/\\|?*#%&\x00-\x1f]+', " ", str(name or "")).strip().rstrip(". ")
    s = re.sub(r"\s+", " ", s)[:80].rstrip(". ")
    if not s or s.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        s = f"_{s}" if s else "Untitled"
    return s


def _index() -> dict[str, Any]:
    try:
        return json.loads((LINK / INDEX).read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _save_index(ix: dict[str, Any]) -> None:
    LINK.mkdir(parents=True, exist_ok=True)
    tmp = LINK / (INDEX + ".tmp")
    tmp.write_text(json.dumps(ix, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(LINK / INDEX)


def _project_name(project_id: str | None) -> tuple[str, str]:
    if not project_id or project_id == "experiment":
        return "experiment", "Experiment"
    from . import projects

    try:
        return project_id, projects.load(project_id).get("name") or project_id
    except Exception:  # noqa: BLE001 - a project that's gone keeps its id as its name
        return project_id, project_id


def project_folder(project_id: str | None) -> str:
    """The project's folder name under bob/ (fixed the first time it's used)."""
    pid, name = _project_name(project_id)
    with _lock:
        ix = _index()
        p = ix.setdefault("projects", {})
        if pid in p:
            return p[pid]["folder"]
        taken = {v["folder"].lower() for v in p.values()}
        folder = clean(name)
        if folder.lower() in taken or folder.lower() in {"video", "image", "audio", "3d", "relief", "scene", "voice", "motion"}:
            folder = f"{folder} ({pid[:6]})"
        p[pid] = {"folder": folder, "scenes": {}}
        _save_index(ix)
        return folder


def scene_folder(project_id: str | None, scene_id: str, scene_name: str | None = None) -> str:
    """A scene's folder under its project's scenes/ (fixed the first time it's used)."""
    pf = project_folder(project_id)
    pid = _project_name(project_id)[0]
    with _lock:
        ix = _index()
        sc = ix["projects"][pid].setdefault("scenes", {})
        if scene_id in sc:
            return f"{pf}/scenes/{sc[scene_id]}"
        if scene_name is None:
            from . import model3d

            scene_name = (model3d.get_scene(scene_id) or {}).get("name") or scene_id
        folder = clean(scene_name)
        if folder.lower() in {v.lower() for v in sc.values()}:
            folder = f"{folder} ({scene_id[:6]})"
        sc[scene_id] = folder
        _save_index(ix)
        return f"{pf}/scenes/{folder}"


KIND_DIRS = {"video": "videos", "image": "images", "audio": "audio"}


def media_dir(project_id: str | None, scene_id: str | None = None, kind: str = "video") -> Path:
    """Where a result goes: its scene's folder, else its project's videos/, images/ or audio/. Made if it's not there."""
    rel = scene_folder(project_id, scene_id) if scene_id else f"{project_folder(project_id)}/{KIND_DIRS.get(kind, 'other')}"
    d = LINK / rel
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_json(path: Path, data: Any) -> None:
    """Write a copy (best effort: a mirror must never stop the save it mirrors)."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(path)
    except OSError as exc:
        log.warning("Couldn't write %s: %s", path, exc)


def mirror_project(project_id: str, data: dict[str, Any]) -> None:
    try:
        write_json(LINK / project_folder(project_id) / "project.json", data)
    except Exception as exc:  # noqa: BLE001
        log.warning("Couldn't copy the project file into its folder: %s", exc)


def mirror_board(project_id: str | None, data: dict[str, Any]) -> None:
    try:
        write_json(LINK / project_folder(project_id) / "board.json", data)
    except Exception as exc:  # noqa: BLE001
        log.warning("Couldn't copy V2's shots into the project's folder: %s", exc)


_scene_cache: dict[str, str] = {}


def mirror_scenes(scenes: list[dict[str, Any]]) -> None:
    """Each scene's JSON into its folder (only the ones that changed since the last time)."""
    for sc in scenes:
        sid = sc.get("id")
        if not sid:
            continue
        text = json.dumps(sc, ensure_ascii=False, indent=1)
        if _scene_cache.get(sid) == text:
            continue
        try:
            d = LINK / scene_folder(sc.get("project"), sid, sc.get("name") or sid)
            write_json(d / "scene.json", sc)
            _scene_cache[sid] = text
        except Exception as exc:  # noqa: BLE001
            log.warning("Couldn't copy scene %s into its folder: %s", sid, exc)
