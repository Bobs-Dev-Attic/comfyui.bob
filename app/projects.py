"""Projects: folders on disk under PROJECTS_DIR, browsed like Windows Explorer.

A project is a folder that holds ``project.json``; any other folder is a plain
folder for organising projects. Projects keep the studio's settings (model,
prompt, pictures, duration...) and notes; generated items point back to a
project by its id, so renaming or moving a project folder keeps its history.

Deleting moves things into ``PROJECTS_DIR/.trash`` instead of erasing them.
"""
from __future__ import annotations

import json
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from . import config

PROJECT_FILE = "project.json"
TRASH = ".trash"
INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


class ProjectError(ValueError):
    pass


def root() -> Path:
    config.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    return config.PROJECTS_DIR.resolve()


def safe(rel: str | None) -> Path:
    """Resolve a "/"-separated path relative to the projects root, refusing to leave it."""
    base = root()
    rel = (rel or "").replace("\\", "/").strip("/")
    p = (base / rel).resolve() if rel else base
    if p != base and base not in p.parents:
        raise ProjectError("Path is outside the projects folder")
    if any(part.startswith(".") for part in p.relative_to(base).parts):
        raise ProjectError("Hidden folders can't be used")
    return p


def rel_of(p: Path) -> str:
    return p.resolve().relative_to(root()).as_posix()


def clean_name(name: str) -> str:
    name = INVALID.sub("", (name or "").strip()).strip(" .")
    if not name:
        raise ProjectError("Enter a name")
    if name.lower() in RESERVED:
        raise ProjectError(f"“{name}” is reserved by Windows; pick another name")
    return name[:120]


def unique(parent: Path, name: str) -> Path:
    target = parent / name
    n = 2
    while target.exists():
        target = parent / f"{name} ({n})"
        n += 1
    return target


def is_project(p: Path) -> bool:
    return (p / PROJECT_FILE).is_file()


def read(p: Path) -> dict[str, Any]:
    try:
        data = json.loads((p / PROJECT_FILE).read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise ProjectError(f"Can't read {p.name}: {exc}") from exc
    data["path"] = rel_of(p)
    data.setdefault("name", p.name)
    return data


def write(p: Path, data: dict[str, Any]) -> None:
    body = {k: v for k, v in data.items() if k != "path"}
    tmp = p / (PROJECT_FILE + ".tmp")
    tmp.write_text(json.dumps(body, indent=1), "utf-8")
    tmp.replace(p / PROJECT_FILE)


_index: dict[str, Path] = {}


def find(project_id: str) -> Path:
    """Folder of a project by id (cached; rescans when it moved)."""
    p = _index.get(project_id)
    if p and is_project(p):
        try:
            if read(p).get("id") == project_id:
                return p
        except ProjectError:
            pass
    _index.clear()
    for f in root().rglob(PROJECT_FILE):
        if TRASH in f.relative_to(root()).parts:
            continue
        try:
            pid = json.loads(f.read_text("utf-8")).get("id")
        except (OSError, ValueError):
            continue
        if pid:
            _index[pid] = f.parent
    if project_id not in _index:
        raise ProjectError("Project not found; it may have been deleted")
    return _index[project_id]


# --------------------------------------------------------------------------- browsing

def entry(p: Path, counts: dict[str, int]) -> dict[str, Any]:
    st = p.stat()
    if is_project(p):
        try:
            d = read(p)
        except ProjectError:
            d = {"name": p.name}
        return {"name": p.name, "path": rel_of(p), "type": "project", "id": d.get("id"),
                "title": d.get("name", p.name), "modified": d.get("modified", st.st_mtime),
                "created": d.get("created"), "items": counts.get(d.get("id"), 0), "thumb": d.get("thumb"),
                "model": (d.get("settings") or {}).get("engine"), "kind": (d.get("settings") or {}).get("kind")}
    kids = [c for c in p.iterdir() if c.is_dir() and not c.name.startswith(".")]
    return {"name": p.name, "path": rel_of(p), "type": "folder", "modified": st.st_mtime,
            "items": len(kids)}


def browse(rel: str | None, counts: dict[str, int]) -> dict[str, Any]:
    p = safe(rel)
    if not p.is_dir():
        raise ProjectError("Folder not found")
    if is_project(p):
        raise ProjectError("That's a project, not a folder")
    entries = [entry(c, counts) for c in sorted(p.iterdir(), key=lambda c: c.name.lower())
               if c.is_dir() and not c.name.startswith(".")]
    here = rel_of(p) if p != root() else ""
    crumbs = [{"name": "Projects", "path": ""}]
    acc = []
    for part in Path(here).parts if here else []:
        acc.append(part)
        crumbs.append({"name": part, "path": "/".join(acc)})
    return {"path": here, "parent": "/".join(acc[:-1]) if acc else None, "crumbs": crumbs, "entries": entries,
            "root": str(root())}


def tree(rel: str = "", depth: int = 6) -> dict[str, Any]:
    p = safe(rel)
    children = []
    if depth > 0:
        for c in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if c.is_dir() and not c.name.startswith(".") and not is_project(c):
                children.append(tree(rel_of(c), depth - 1))
    return {"name": p.name if rel else "Projects", "path": rel_of(p) if rel else "", "children": children}


def recent(counts: dict[str, int], limit: int = 8) -> list[dict[str, Any]]:
    out = []
    for f in root().rglob(PROJECT_FILE):
        if TRASH in f.relative_to(root()).parts:
            continue
        try:
            out.append(entry(f.parent, counts))
        except (OSError, ProjectError):
            continue
    return sorted(out, key=lambda e: e.get("modified") or 0, reverse=True)[:limit]


# --------------------------------------------------------------------------- changes

def create(folder: str | None, name: str, settings: dict[str, Any] | None, notes: str = "") -> dict[str, Any]:
    parent = safe(folder)
    if not parent.is_dir() or is_project(parent):
        raise ProjectError("Pick a folder to save the project in")
    title = clean_name(name)
    p = unique(parent, title)
    p.mkdir(parents=True)
    now = time.time()
    data = {"id": uuid.uuid4().hex[:12], "name": title, "created": now, "modified": now, "version": 1,
            "settings": settings or {}, "notes": notes or "", "thumb": None}
    write(p, data)
    _index[data["id"]] = p
    return read(p)


def load(project_id: str) -> dict[str, Any]:
    return read(find(project_id))


def update(project_id: str, *, settings: dict[str, Any] | None = None, notes: str | None = None) -> dict[str, Any]:
    p = find(project_id)
    data = read(p)
    if settings is not None:
        data["settings"] = settings
    if notes is not None:
        data["notes"] = notes
    data["modified"] = time.time()
    write(p, data)
    return read(p)


def touch(project_id: str | None, thumb: str | None) -> None:
    """A job in the project finished: remember its result as the project's thumbnail."""
    if not project_id:
        return
    try:
        p = find(project_id)
        data = read(p)
    except ProjectError:
        return
    if thumb:
        data["thumb"] = thumb
    data["modified"] = time.time()
    write(p, data)


def make_folder(parent: str | None, name: str) -> dict[str, Any]:
    base = safe(parent)
    if not base.is_dir() or is_project(base):
        raise ProjectError("Folders can only go inside folders")
    p = unique(base, clean_name(name))
    p.mkdir()
    return {"path": rel_of(p), "name": p.name}


def rename(rel: str, name: str) -> dict[str, Any]:
    p = safe(rel)
    if p == root() or not p.is_dir():
        raise ProjectError("Nothing to rename")
    new = clean_name(name)
    target = p.parent / new
    if target.exists() and target.resolve() != p.resolve():
        raise ProjectError(f"“{new}” already exists here")
    p.rename(target)
    if is_project(target):
        data = read(target)
        data["name"] = new
        data["modified"] = time.time()
        write(target, data)
        _index[data["id"]] = target
    return {"path": rel_of(target), "name": new}


def delete(rel: str) -> dict[str, Any]:
    """Move a project or folder into .trash (recoverable by hand)."""
    p = safe(rel)
    if p == root() or not p.is_dir():
        raise ProjectError("Nothing to delete")
    trash = root() / TRASH
    trash.mkdir(exist_ok=True)
    target = unique(trash, f"{time.strftime('%Y%m%d-%H%M%S')} {p.name}")
    shutil.move(str(p), str(target))
    _index.clear()
    return {"trashed": str(target)}
