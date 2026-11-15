"""Projects: folders on disk under PROJECTS_DIR, browsed like Windows Explorer.

A project is a folder that holds ``project.json`` (format: app/projectfile.py,
docs/PROJECT_FORMAT.md); any other folder is a plain folder for organising
projects. Generated items point back to a project by its id, so renaming or
moving a project folder keeps its history.

"experiment" is a built-in project stored in data/experiment: the Experiment
mode's settings and media library, never listed with the real projects.

Deleting moves things into ``PROJECTS_DIR/.trash`` instead of erasing them.
"""
from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from . import config, media
from . import projectfile as pfile
from .projectfile import MediaItem, ProjectFile, VirtualFolder

PROJECT_FILE = "project.json"
TRASH = ".trash"
EXPERIMENT = "experiment"
INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


class ProjectError(ValueError):
    pass


def root() -> Path:
    config.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    return config.PROJECTS_DIR.resolve()


def experiment_dir() -> Path:
    d = config.DATA_DIR / "experiment"
    if not (d / PROJECT_FILE).is_file():
        d.mkdir(parents=True, exist_ok=True)
        pfile.save(d / PROJECT_FILE, ProjectFile(id=EXPERIMENT, name="Experiment"))
    return d


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
    try:
        return p.resolve().relative_to(root()).as_posix()
    except ValueError:
        return ""  # the experiment lives outside the projects folder


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


def load_file(p: Path) -> ProjectFile:
    try:
        return pfile.load(p / PROJECT_FILE)
    except (OSError, ValueError, ValidationError) as exc:
        raise ProjectError(f"Can't read {p.name}/project.json: {exc}") from exc


def save_file(p: Path, pf: ProjectFile, touch: bool = True) -> None:
    if touch:
        pf.modified = time.time()
    pfile.save(p / PROJECT_FILE, pf)


def as_dict(p: Path, pf: ProjectFile) -> dict[str, Any]:
    d = pf.dump()
    d["path"] = rel_of(p)
    return d


def read(p: Path) -> dict[str, Any]:
    return as_dict(p, load_file(p))


_index: dict[str, Path] = {}


def find(project_id: str) -> Path:
    """Folder of a project by id (cached; rescans when it moved)."""
    if project_id == EXPERIMENT:
        return experiment_dir()
    p = _index.get(project_id)
    if p and is_project(p):
        try:
            if load_file(p).id == project_id:
                return p
        except ProjectError:
            pass
    _index.clear()
    for f in root().rglob(PROJECT_FILE):
        if TRASH in f.relative_to(root()).parts:
            continue
        try:
            pid = pfile.load(f).id
        except (OSError, ValueError, ValidationError):
            continue
        _index[pid] = f.parent
    if project_id not in _index:
        raise ProjectError("Project not found; it may have been deleted")
    return _index[project_id]


def edit(project_id: str, fn) -> dict[str, Any]:
    """Load, change with fn(ProjectFile), validate, save, and return the project."""
    p = find(project_id)
    pf = load_file(p)
    fn(pf)
    try:
        pf = ProjectFile.model_validate(pf.dump())
    except ValidationError as exc:
        raise ProjectError(f"Invalid project data: {exc.errors()[0]['msg']}") from exc
    save_file(p, pf)
    return as_dict(p, pf)


# --------------------------------------------------------------------------- browsing

def entry(p: Path, counts: dict[str, int]) -> dict[str, Any]:
    st = p.stat()
    if is_project(p):
        try:
            pf = load_file(p)
            s = pf.settings
            return {"name": p.name, "path": rel_of(p), "type": "project", "id": pf.id, "title": pf.name,
                    "modified": pf.modified, "created": pf.created, "items": counts.get(pf.id, 0), "thumb": pf.thumb,
                    "model": s.engine.get(s.kind or "", None), "kind": s.kind, "media": len(pf.library.media)}
        except ProjectError:
            return {"name": p.name, "path": rel_of(p), "type": "project", "id": None, "title": p.name,
                    "modified": st.st_mtime, "items": 0, "broken": True}
    kids = [c for c in p.iterdir() if c.is_dir() and not c.name.startswith(".")]
    return {"name": p.name, "path": rel_of(p), "type": "folder", "modified": st.st_mtime, "items": len(kids)}


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


# --------------------------------------------------------------------------- projects

def create(folder: str | None, name: str, settings: dict[str, Any] | None, notes: str = "") -> dict[str, Any]:
    parent = safe(folder)
    if not parent.is_dir() or is_project(parent):
        raise ProjectError("Pick a folder to save the project in")
    title = clean_name(name)
    try:
        pf = ProjectFile(name=title, settings=settings or {}, notes=notes or "")
    except ValidationError as exc:
        raise ProjectError(f"Invalid settings: {exc.errors()[0]['msg']}") from exc
    p = unique(parent, title)
    p.mkdir(parents=True)
    save_file(p, pf, touch=False)
    _index[pf.id] = p
    return as_dict(p, pf)


def load(project_id: str) -> dict[str, Any]:
    p = find(project_id)
    return as_dict(p, load_file(p))


def update(project_id: str, *, settings: dict[str, Any] | None = None, notes: str | None = None,
           config_: dict[str, Any] | None = None, timeline: dict[str, Any] | None = None) -> dict[str, Any]:
    def fn(pf: ProjectFile) -> None:
        if timeline is not None:
            pf.timeline = timeline
        if settings is not None:
            pf.settings = settings
        if notes is not None:
            pf.notes = notes
        if config_ is not None:
            pf.config = {**pf.config.model_dump(), **config_}
    return edit(project_id, fn)


def touch(project_id: str | None, thumb: str | None) -> None:
    """A job in the project finished: remember its result as the project's thumbnail."""
    if not project_id:
        return
    try:
        p = find(project_id)
        pf = load_file(p)
    except ProjectError:
        return
    if thumb:
        pf.thumb = thumb
    save_file(p, pf)


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
        pf = load_file(target)
        pf.name = new
        save_file(target, pf)
        _index[pf.id] = target
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


# --------------------------------------------------------------------------- media library

def _source(ref: str) -> str:
    if ref.startswith("data/uploads/"):
        return "upload"
    if ref.startswith("outputs/"):
        return "output"
    return "bookmark"


def _new_item(ref: str) -> MediaItem:
    p = media.resolve(ref)  # also checks the file is in an allowed place
    kind = media.kind_of(p.name)
    if not kind:
        raise ProjectError(f"Not a picture, video or sound file: {p.name}")
    return MediaItem(ref=media.ref_of(p), kind=kind, name=p.name, source=_source(media.ref_of(p)))


def library(project_id: str) -> dict[str, Any]:
    """The library with each item's current URL, thumbnail and whether the file still exists."""
    p = find(project_id)
    lib = load_file(p).library
    items = []
    for m in lib.media:
        d = m.model_dump()
        try:
            f = media.resolve(m.ref)
            st = f.stat()
            d.update(exists=True, url=media.url_of(m.ref), thumb=media.thumb_url(m.ref, st.st_mtime),
                     size=st.st_size, modified=st.st_mtime)
        except (media.MediaError, OSError):
            d.update(exists=False, url="", thumb="", size=0, modified=0)
        items.append(d)
    counts: dict[str, int] = {}
    for m in lib.media:
        for t in m.tags:
            counts[t] = counts.get(t, 0) + 1
    tags = [{"name": t.name, "color": t.color, "count": counts.get(t.name, 0)} for t in lib.tags]
    return {"media": items, "tags": tags, "virtual_folders": [v.model_dump() for v in lib.virtual_folders]}


def _sync_tags(pf: ProjectFile) -> None:
    """Every tag used by an item is listed in library.tags (keeping colours of existing ones)."""
    known = {t.name.lower(): t for t in pf.library.tags}
    for m in pf.library.media:
        for t in m.tags:
            if t.lower() not in known:
                known[t.lower()] = pfile.TagDef(name=t)
                pf.library.tags.append(known[t.lower()])


def add_media(project_id: str, refs: list[str], tags: list[str] | None = None) -> dict[str, Any]:
    errors: list[str] = []

    def fn(pf: ProjectFile) -> None:
        have = {m.ref: m for m in pf.library.media}
        for ref in refs:
            try:
                item = _new_item(ref)
            except (media.MediaError, ProjectError) as exc:
                errors.append(str(exc))
                continue
            existing = have.get(item.ref)
            if existing:
                if tags:
                    existing.tags = [*existing.tags, *tags]
                continue
            if tags:
                item.tags = list(tags)
            pf.library.media.append(item)
            have[item.ref] = item
        _sync_tags(pf)
    edit(project_id, fn)
    return {**library(project_id), "errors": errors}


def remove_media(project_id: str, ids: list[str]) -> dict[str, Any]:
    drop = set(ids)

    def fn(pf: ProjectFile) -> None:
        pf.library.media = [m for m in pf.library.media if m.id not in drop]
    edit(project_id, fn)
    return library(project_id)


def tag_media(project_id: str, refs: list[str], add: list[str], remove: list[str]) -> dict[str, Any]:
    """Add/remove tags on files; files not in the library yet are added (tagging = collecting)."""
    add = [pfile.clean_tag(t) for t in add if pfile.clean_tag(t)]
    gone = {pfile.clean_tag(t).lower() for t in remove}
    errors: list[str] = []

    def fn(pf: ProjectFile) -> None:
        have = {m.ref: m for m in pf.library.media}
        for ref in refs:
            m = have.get(ref)
            if m is None:
                if not add:
                    continue
                try:
                    m = _new_item(ref)
                except (media.MediaError, ProjectError) as exc:
                    errors.append(str(exc))
                    continue
                pf.library.media.append(m)
                have[m.ref] = m
            m.tags = [t for t in [*m.tags, *add] if t.lower() not in gone]
        _sync_tags(pf)
    edit(project_id, fn)
    return {**library(project_id), "errors": errors}


def update_media(project_id: str, item_id: str, *, rating: int | None = None, note: str | None = None) -> dict[str, Any]:
    def fn(pf: ProjectFile) -> None:
        for m in pf.library.media:
            if m.id == item_id:
                if rating is not None:
                    m.rating = rating
                if note is not None:
                    m.note = note
                return
        raise ProjectError("Item not found")
    edit(project_id, fn)
    return library(project_id)


def rate_media(project_id: str, refs: list[str], rating: int) -> dict[str, Any]:
    """Set the 0–5 star rating of files; files not in the library yet are added."""
    if not 0 <= rating <= 5:
        raise ProjectError("Ratings go from 0 to 5")
    errors: list[str] = []

    def fn(pf: ProjectFile) -> None:
        have = {m.ref: m for m in pf.library.media}
        for ref in refs:
            m = have.get(ref)
            if m is None:
                if not rating:
                    continue
                try:
                    m = _new_item(ref)
                except (media.MediaError, ProjectError) as exc:
                    errors.append(str(exc))
                    continue
                pf.library.media.append(m)
                have[m.ref] = m
            m.rating = rating
    edit(project_id, fn)
    return {**library(project_id), "errors": errors}


def save_folder(project_id: str, folder: dict[str, Any]) -> dict[str, Any]:
    """Create or update a virtual folder (matched by id)."""
    try:
        vf = VirtualFolder.model_validate(folder)
    except ValidationError as exc:
        raise ProjectError(f"Invalid folder: {exc.errors()[0]['msg']}") from exc
    if not vf.name.strip():
        raise ProjectError("Give the folder a name")
    vf.tags = [t for t in (pfile.clean_tag(x) for x in vf.tags) if t]
    if not vf.tags:
        raise ProjectError("Pick at least one tag")

    def fn(pf: ProjectFile) -> None:
        folders = pf.library.virtual_folders
        if any(f.id == vf.id for f in folders):
            pf.library.virtual_folders = [vf if f.id == vf.id else f for f in folders]
        else:
            folders.append(vf)
        for t in vf.tags:
            if t.lower() not in {x.name.lower() for x in pf.library.tags}:
                pf.library.tags.append(pfile.TagDef(name=t))
    edit(project_id, fn)
    return library(project_id)


def delete_folder(project_id: str, folder_id: str) -> dict[str, Any]:
    def fn(pf: ProjectFile) -> None:
        pf.library.virtual_folders = [f for f in pf.library.virtual_folders if f.id != folder_id]
    edit(project_id, fn)
    return library(project_id)


def rename_tag(project_id: str, old: str, new: str) -> dict[str, Any]:
    new_c = pfile.clean_tag(new)
    if not new_c:
        raise ProjectError("Enter a tag name")
    o = old.lower()

    def swap(tags: list[str]) -> list[str]:
        return [new_c if t.lower() == o else t for t in tags]

    def fn(pf: ProjectFile) -> None:
        for m in pf.library.media:
            m.tags = swap(m.tags)
        for f in pf.library.virtual_folders:
            f.tags = swap(f.tags)
        pf.library.tags = [t for t in pf.library.tags if t.name.lower() != o]
        _sync_tags(pf)
    edit(project_id, fn)
    return library(project_id)


def set_tag_color(project_id: str, name: str, color: str) -> dict[str, Any]:
    if color and not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ProjectError("Colour must look like #ff7a45")

    def fn(pf: ProjectFile) -> None:
        for t in pf.library.tags:
            if t.name.lower() == name.lower():
                t.color = color
    edit(project_id, fn)
    return library(project_id)


def delete_tag(project_id: str, name: str) -> dict[str, Any]:
    n = name.lower()

    def fn(pf: ProjectFile) -> None:
        for m in pf.library.media:
            m.tags = [t for t in m.tags if t.lower() != n]
        for f in pf.library.virtual_folders:
            f.tags = [t for t in f.tags if t.lower() != n]
        pf.library.virtual_folders = [f for f in pf.library.virtual_folders if f.tags]
        pf.library.tags = [t for t in pf.library.tags if t.name.lower() != n]
    edit(project_id, fn)
    return library(project_id)
