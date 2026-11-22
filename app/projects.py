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

import json
import os
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


HISTORY_DIR = ".history"
LABELS_FILE = "labels.json"  # <project>/.history/labels.json: {version file: name}; named versions are never pruned


def _limits() -> tuple[int, float]:
    """(versions kept, seconds between automatic versions), from the app settings."""
    from . import appsettings
    s = appsettings.get().projects
    return s.versions_keep, s.version_minutes * 60.0


def _labels(hist: Path) -> dict[str, str]:
    try:
        data = json.loads((hist / LABELS_FILE).read_text("utf-8"))
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_labels(hist: Path, labels: dict[str, str]) -> None:
    hist.mkdir(exist_ok=True)
    live = {k: v for k, v in labels.items() if (hist / k).is_file()}
    (hist / LABELS_FILE).write_text(json.dumps(live, indent=2), "utf-8")


_VERSION_NAME = re.compile(r"project-(\d{8}-\d{6})(?:-(.*?))?(?:-(\d+))?$")


def _version_parts(f: Path) -> tuple[str, str, int]:
    """project-YYYYMMDD-HHMMSS[-tag][-n].json -> (time, tag, n); n counts versions kept in the same second."""
    m = _VERSION_NAME.match(f.stem)
    if not m:
        return ("", "", 0)
    tag, n = m.group(2) or "", int(m.group(3) or 1)
    if tag.isdigit() and not m.group(3):  # project-..-HHMMSS-2: a counter, not a tag
        tag, n = "", int(tag)
    return (m.group(1), tag, n)


def _versions(hist: Path) -> list[Path]:
    """Version files, oldest first: by when each was kept, then the same-second counter in the name."""
    return sorted(hist.glob("project-*.json"), key=lambda f: (f.stat().st_mtime_ns, _version_parts(f)[0], _version_parts(f)[2]))


def _prune(hist: Path) -> None:
    keep, _ = _limits()
    labels = _labels(hist)
    auto = [f for f in _versions(hist) if f.name not in labels]
    for old in auto[: max(0, len(auto) - keep)]:
        old.unlink(missing_ok=True)


def backup(p: Path, *, force: bool = False, tag: str = "", label: str = "") -> Path | None:
    """Keep the current project.json in <project>/.history before it's overwritten.

    Automatic versions are rate-limited (Settings > Projects: one every N minutes) and the last
    N are kept; force (startup, a named version) always copies, unless the file is identical to
    the newest version. A label makes it a named version, which is never pruned."""
    src = p / PROJECT_FILE
    if not src.is_file():
        return None
    hist = p / HISTORY_DIR
    hist.mkdir(exist_ok=True)
    versions = _versions(hist)
    _, every = _limits()
    if versions and not label:
        if not force and time.time() - versions[-1].stat().st_mtime < every:
            return None
        if versions[-1].read_bytes() == src.read_bytes():
            return None  # nothing changed since the last version
    stem = f"project-{time.strftime('%Y%m%d-%H%M%S')}{'-' + tag if tag else ''}"
    # Two versions in the same second: number them past every one already there (never reuse a
    # pruned name, or the newer version would sort as the older one).
    same = [v for v in versions if v.stem == stem or (v.stem.startswith(stem + "-") and v.stem[len(stem) + 1:].isdigit())]
    n = max((_version_parts(v)[2] for v in same), default=0)
    dst = hist / (f"{stem}.json" if not same and not (hist / f"{stem}.json").exists() else f"{stem}-{max(n, 1) + 1}.json")
    while dst.exists():
        n = max(n, 1) + 1
        dst = hist / f"{stem}-{n + 1}.json"
    shutil.copy(src, dst)
    os.utime(dst)  # the version's time is when it was kept (Windows' copy keeps the source's time)
    if label:
        labels = _labels(hist)
        labels[dst.name] = label.strip()[:120]
        _save_labels(hist, labels)
    _prune(hist)
    return dst


def backup_all(tag: str = "startup") -> dict[str, int]:
    """Back up every project (and Experiment) once, e.g. when the app starts (Settings > Projects can turn it off)."""
    from . import appsettings
    if not appsettings.get().projects.version_on_start:
        return {"backed_up": 0, "unchanged": 0, "failed": 0, "off": 1}
    done = skipped = failed = 0
    dirs = [f.parent for f in root().rglob(PROJECT_FILE) if TRASH not in f.relative_to(root()).parts]
    exp = config.DATA_DIR / "experiment"
    if (exp / PROJECT_FILE).is_file():
        dirs.append(exp)
    for d in dirs:
        try:
            if backup(d, force=True, tag=tag):
                done += 1
            else:
                skipped += 1
        except OSError:
            failed += 1
    return {"backed_up": done, "unchanged": skipped, "failed": failed}


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def changes(old: ProjectFile, new: ProjectFile) -> list[str]:
    """What changed from one version to the next, in a few short phrases."""
    out: list[str] = []
    so, sn = old.settings, new.settings
    if so.prompt != sn.prompt:
        out.append("prompt edited")
    if sn.kind and (so.kind, so.engine.get(so.kind or "")) != (sn.kind, sn.engine.get(sn.kind)):
        eng = sn.engine.get(sn.kind, "")
        out.append(f"model: {sn.kind}{' · ' + eng if eng else ''}")
    other = [k for k in ("aspect", "quality", "seconds", "seed", "steps", "batch", "turbo", "enhance", "lyrics")
             if getattr(so, k) != getattr(sn, k)]
    if [r.ref for r in so.refs] != [r.ref for r in sn.refs]:
        other.append("reference pictures")
    if so.loras != sn.loras:
        other.append("LoRAs")
    if other:
        out.append("settings: " + ", ".join(other))
    co, cn = {c.id: c for c in old.timeline.clips}, {c.id: c for c in new.timeline.clips}
    added, removed = len(cn.keys() - co.keys()), len(co.keys() - cn.keys())
    moved = sum(1 for k in cn.keys() & co.keys() if cn[k] != co[k])
    if added:
        out.append(f"+{_plural(added, 'clip')}")
    if removed:
        out.append(f"-{_plural(removed, 'clip')}")
    if moved:
        out.append(f"{_plural(moved, 'clip')} changed")
    if len(old.timeline.tracks) != len(new.timeline.tracks):
        out.append(_plural(len(new.timeline.tracks), "track"))
    if old.timeline.transitions != new.timeline.transitions or old.timeline.markers != new.timeline.markers:
        out.append("transitions or markers")
    mo, mn = {m.id for m in old.library.media}, {m.id for m in new.library.media}
    if mn - mo:
        out.append(f"+{_plural(len(mn - mo), 'library item')}")
    if mo - mn:
        out.append(f"-{_plural(len(mo - mn), 'library item')}")
    kept_old = [(m.id, m.tags, m.rating, m.note) for m in old.library.media if m.id in mn]
    kept_new = [(m.id, m.tags, m.rating, m.note) for m in new.library.media if m.id in mo]
    if sorted(kept_old) != sorted(kept_new):
        out.append("tags or ratings")
    if old.notes != new.notes:
        out.append("notes")
    if old.name != new.name:
        out.append(f"renamed to {new.name}")
    if old.config != new.config:
        out.append("project settings")
    return out


def history(project_id: str) -> list[dict[str, Any]]:
    """Versions, newest first, each with what changed since the version before it. The first row
    (file None) is the current state, with what changed since the newest version."""
    p = find(project_id)
    hist = p / HISTORY_DIR
    labels = _labels(hist)
    loaded: list[tuple[Path, ProjectFile]] = []
    for f in _versions(hist):
        try:
            loaded.append((f, pfile.load(f)))
        except (OSError, ValueError, ValidationError):
            continue
    rows = []
    for i, (f, pf) in enumerate(loaded):
        rows.append({"file": f.name, "saved": f.stat().st_mtime, "label": labels.get(f.name, ""),
                     "tag": _version_parts(f)[1], "clips": len(pf.timeline.clips), "media": len(pf.library.media),
                     "prompt": (pf.settings.prompt or "")[:80],
                     "changes": changes(loaded[i - 1][1], pf) if i else ["the oldest version kept"]})
    try:
        cur = load_file(p)
        rows.append({"file": None, "saved": cur.modified, "label": "", "tag": "current", "clips": len(cur.timeline.clips),
                     "media": len(cur.library.media), "prompt": (cur.settings.prompt or "")[:80],
                     "changes": changes(loaded[-1][1], cur) if loaded else []})
    except ProjectError:
        pass
    return rows[::-1]


def save_version(project_id: str, label: str) -> dict[str, Any]:
    """Keep the current state now as a named version (kept until deleted)."""
    p = find(project_id)
    label = (label or "").strip() or time.strftime("Saved %b %d, %H:%M")
    dst = backup(p, force=True, label=label)
    if not dst:
        raise ProjectError("Nothing to keep yet: the project hasn't been saved")
    return {"file": dst.name, "label": label}


def label_version(project_id: str, name: str, label: str) -> dict[str, Any]:
    """Name a version (it's then never pruned), or clear its name (it becomes automatic again)."""
    hist = find(project_id) / HISTORY_DIR
    f = hist / Path(name).name
    if not f.is_file() or not f.name.startswith("project-"):
        raise ProjectError("That version doesn't exist")
    labels = _labels(hist)
    if label.strip():
        labels[f.name] = label.strip()[:120]
    else:
        labels.pop(f.name, None)
    _save_labels(hist, labels)
    return {"file": f.name, "label": labels.get(f.name, "")}


def delete_version(project_id: str, name: str) -> dict[str, Any]:
    hist = find(project_id) / HISTORY_DIR
    f = hist / Path(name).name
    if not f.is_file() or not f.name.startswith("project-"):
        raise ProjectError("That version doesn't exist")
    f.unlink()
    labels = _labels(hist)
    if labels.pop(f.name, None) is not None:
        _save_labels(hist, labels)
    return {"deleted": f.name}


def restore(project_id: str, name: str) -> dict[str, Any]:
    """Bring back an earlier version (the current one is kept as a named version first, so it can come back)."""
    p = find(project_id)
    f = p / HISTORY_DIR / Path(name).name
    if not f.is_file() or not f.name.startswith("project-"):
        raise ProjectError("That version doesn't exist")
    old = pfile.load(f)
    when = _labels(p / HISTORY_DIR).get(f.name) or time.strftime("%b %d, %H:%M", time.localtime(f.stat().st_mtime))
    backup(p, force=True, tag="before-restore", label=f"Before going back to {when}")
    old.id = load_file(p).id  # keep the identity (results point to it)
    save_file(p, old, keep_version=False)  # the current state was just kept above
    return as_dict(p, old)


def save_file(p: Path, pf: ProjectFile, touch: bool = True, keep_version: bool = True) -> None:
    if touch:
        pf.modified = time.time()
    if keep_version:
        try:
            backup(p)
        except OSError:
            pass  # a failed backup must never block saving
    pfile.save(p / PROJECT_FILE, pf)
    from . import projectmedia  # a copy in the project's media folder (ComfyUI's output/bob/<Project>)

    projectmedia.mirror_project(pf.id, as_dict(p, pf))


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
    try:
        return _update(project_id, settings, notes, config_, timeline)
    except ValidationError as exc:
        err = exc.errors()[0]
        raise ProjectError(f"Invalid project data at {'.'.join(map(str, err['loc']))}: {err['msg']}") from exc


def _update(project_id, settings, notes, config_, timeline) -> dict[str, Any]:
    def fn(pf: ProjectFile) -> None:
        if timeline is not None:
            pf.timeline = pfile.Timeline.model_validate(timeline)
        if settings is not None:
            pf.settings = pfile.StudioSettings.model_validate(settings)
        if notes is not None:
            pf.notes = notes
        if config_ is not None:
            pf.config = pfile.ProjectConfig.model_validate({**pf.config.model_dump(), **config_})
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


def copy(project_id: str, name: str, folder: str | None = None, *, timeline: bool = True,
         library: bool = True) -> dict[str, Any]:
    """Duplicate a project (or Experiment) as a new project with its own id.

    Settings, config, notes and the thumbnail always come along; the timeline and the media
    library when asked. Other files in the project's folder are copied too, its version history
    isn't (the copy starts its own). Media files themselves aren't duplicated: both projects point
    at the same uploads and outputs. Results are copied by the caller (jobs.copy_items)."""
    src = find(project_id)
    pf = load_file(src)
    parent = safe(folder) if folder is not None else (src.parent if rel_of(src) else root())
    if not parent.is_dir() or is_project(parent):
        raise ProjectError("Pick a folder to save the copy in")
    target = unique(parent, clean_name(name))  # "Name (2)" when the name is taken: the project is called that too
    shutil.copytree(src, target, ignore=shutil.ignore_patterns(HISTORY_DIR, PROJECT_FILE, ".*"))
    now = time.time()
    data = pf.dump()
    data.update(id=pfile.new_id(), name=target.name, created=now, modified=now, app_version=pfile.__version__)
    if not timeline:
        data["timeline"] = pfile.Timeline().model_dump()
    if not library:
        data["library"] = pfile.Library().model_dump()
    new = ProjectFile.model_validate(data)
    save_file(target, new, touch=False, keep_version=False)
    _index[new.id] = target
    return {**as_dict(target, new), "copied_from": pf.id}


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
