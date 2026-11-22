"""Move results made before v0.147.0 from outputs/<date>/ into their projects' folders (bob/<Project>/..., ComfyUI's
output/bob), and point everything that refers to them at the new place.

    python scripts/move_to_project_folders.py            # dry run: what would move where
    python scripts/move_to_project_folders.py --apply    # with the studio stopped: back up, move, rewrite

A result goes to its scene's folder when it's known (a scene's photo, or a V2 shot's take: its scene), else to the
project's videos/, images/ or audio/. Beside each, <id>.json (its request and what was sent); a scene render also
gets its 3D render copied in as <id>_3d.mp4 when the upload is still there. Every reference (the results list, the
scenes, V2's boards and objects, the media library, every project file and its saved versions) is rewritten. The
JSON files are backed up first to data/backup_before_project_folders/. 3D models (outputs/3d) stay where they are.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
import urllib.parse
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, projectmedia  # noqa: E402

DATA = config.DATA_DIR
REF = re.compile(r'(/?)(outputs/\d{4}-\d{2}-\d{2}/[^"\\?#]+)')


def load(p: Path):
    return json.loads(p.read_text("utf-8"))


def json_files() -> list[Path]:
    """Every JSON store that can refer to a result."""
    out = [p for p in DATA.glob("*.json")] + list((DATA / "v2").glob("*.json")) + list((DATA / "experiment").rglob("*.json"))
    out += [p for p in config.PROJECTS_DIR.rglob("*.json")]
    return [p for p in out if p.is_file()]


def scene_of_items() -> dict[str, str]:
    """item id -> its 3D scene's id: a scene's photos, and V2's shots' takes."""
    m: dict[str, str] = {}
    try:
        for sc in load(DATA / "scenes3d.json").get("scenes", []):
            for ph in sc.get("photos") or []:
                if ph.get("id"):
                    m[ph["id"]] = sc["id"]
    except (OSError, ValueError):
        pass
    for f in (DATA / "v2").glob("*.json"):
        try:
            for s in load(f).get("shots", []):
                for rid in s.get("results") or []:
                    if s.get("scene"):
                        m.setdefault(rid, s["scene"])
        except (OSError, ValueError, AttributeError):
            continue
    return m


def plan() -> tuple[dict[str, str], list[tuple], list[str]]:
    """old ref -> new ref, the moves [(item, file, src, dst, scene)], and notes."""
    items = load(DATA / "history.json")
    scenes = scene_of_items()
    mapping, moves, notes = {}, [], []
    for it in items:
        for f in it.get("files") or []:
            ref = f.get("path") or ""
            if not REF.fullmatch(ref):
                continue
            src = ROOT / ref
            if not src.is_file():
                notes.append(f"missing, left as it is: {ref}")
                continue
            p = it.get("params") or {}
            scene = p.get("scene") or scenes.get(it["id"])
            d = projectmedia.media_dir(it.get("project"), scene, it.get("kind") or p.get("kind") or "video")
            dst = d / src.name
            if dst.exists() and dst.stat().st_size != src.stat().st_size:
                dst = d / f"{it['id']}_{src.name}"
            mapping[ref] = (ROOT / "bob" / dst.relative_to(projectmedia.LINK)).relative_to(ROOT).as_posix()
            moves.append((it, f, src, dst, scene))
    return mapping, moves, notes


def rewrite(text: str, mapping: dict[str, str]) -> tuple[str, int]:
    n = 0

    def sub(m: re.Match) -> str:
        nonlocal n
        new = mapping.get(m.group(2))
        if not new:
            return m.group(0)
        n += 1
        return "/" + urllib.parse.quote(new) if m.group(1) else new
    return REF.sub(sub, text), n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    mapping, moves, notes = plan()
    by = Counter(str(Path(m[3]).relative_to(projectmedia.LINK).parent) for m in moves)
    print(f"{len(moves)} files to move into {len(by)} folders:")
    for k, v in sorted(by.items()):
        print(f"  {v:4}  bob/{k}")
    refs = 0
    for p in json_files():
        refs += rewrite(p.read_text("utf-8", errors="replace"), mapping)[1]
    print(f"{refs} references to rewrite in {len(json_files())} JSON files")
    for n in notes[:20]:
        print("  note:", n)
    if not a.apply:
        print("Dry run: nothing changed. --apply to do it (with the studio stopped).")
        return

    # 1. back up every JSON store
    bk = DATA / "backup_before_project_folders" / time.strftime("%Y%m%d-%H%M%S")
    for p in json_files():
        rel = p.relative_to(ROOT) if ROOT in p.parents else Path("projects_dir") / p.relative_to(config.PROJECTS_DIR)
        (bk / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, bk / rel)
    print(f"Backed up the JSON files to {bk.relative_to(ROOT)}")
    # 2. move the files, and keep what each one was
    moved = 0
    for it, f, src, dst, scene in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            shutil.move(str(src), str(dst))
        elif src.exists():
            src.unlink()  # the same file is there already
        moved += 1
        p = it.get("params") or {}
        if scene and p.get("motion_video"):
            up = ROOT / p["motion_video"]
            if up.is_file() and not (dst.parent / f"{it['id']}_3d.mp4").exists():
                shutil.copy2(up, dst.parent / f"{it['id']}_3d.mp4")
        new_files = [{**x, "path": mapping.get(x.get("path"), x.get("path"))} for x in it.get("files") or []]
        projectmedia.write_json(dst.parent / f"{it['id']}.json", {
            "id": it["id"], "engine": it.get("engine"), "kind": it.get("kind"), "seed": it.get("seed"), "created": it.get("created"),
            "finished": it.get("finished"), "request": p, "sent": it.get("info"), "files": new_files})
    print(f"Moved {moved} files")
    # 3. point everything at the new places
    total = 0
    for p in json_files():
        if bk in p.parents:
            continue
        text = p.read_text("utf-8", errors="replace")
        new, n = rewrite(text, mapping)
        if n:
            tmp = p.with_name(p.name + ".tmp")
            tmp.write_text(new, "utf-8")
            tmp.replace(p)
            total += n
    print(f"Rewrote {total} references")


if __name__ == "__main__":
    main()
