"""Make 3D figure: a rigged, textured 3D figure of the person in a picture, for a 3D scene's Person.

Four steps, in the background (a few minutes), each a ComfyUI job but the last:
  1. Qwen Image Edit draws the same person in an A-pose (workflows.FIGURE_APOSE_PROMPT), so their arms and legs stand
     clear of the body and the clothes.
  2. SAM 3D Body fits its rigged body to that A-pose picture, and to the person's own picture (for the pose they
     stand in there).
  3. TRELLIS.2 makes the textured model of the A-pose picture, light enough to pose in the page (quality "figure").
  4. figrig.build lines the two up and gives the model the body's skeleton and skin weights.

A figure is a Make 3D model (model3d's list) with kind "figure": outputs/3d/<id>.glb (the rigged figure), <id>_rig.json
(its bones, for the page) and <id>_input.png (the A-pose picture, its thumbnail). The pose in the picture is kept in
its entry ("pose"), as a Person's pose.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from . import config, figrig, model3d, workflows

log = logging.getLogger("bob.figure3d")
STEPS = ["Drawing them in an A-pose", "Fitting the body", "Making the 3D model", "Rigging it"]


def start(jobs: Any, *, source: str, name: str, project: str | None, seed: int | None, files: dict[str, Any]) -> dict[str, Any]:
    """Queue a figure: returns its entry at once (status "running")."""
    fid = uuid.uuid4().hex[:12]
    seed = int(seed) if seed is not None and seed >= 0 else random.randint(0, 2**31 - 1)
    entry = {"id": fid, "kind": "figure", "name": name.strip()[:120] or "3D figure", "source": source, "mask": None,
             "project": project, "quality": "figure", "seed": seed, "model": "SAM 3D Body + TRELLIS.2", "status": "running",
             "step": STEPS[0], "error": None, "created": time.time(), "finished": None, "seconds": None, "glb": None,
             "thumb": None, "rig": None, "size": None}
    with model3d._lock:
        items = model3d._read()
        items.append(entry)
        model3d._write(items)
    model3d._tasks[fid] = asyncio.get_running_loop().create_task(_run(jobs, fid, source, seed, files))
    return model3d._public(entry)


async def _glb_of(jobs: Any, built: workflows.Built, refs: dict[str, str], stem: str, target: Path, timeout: float) -> Path:
    paths = await jobs.run_quick(built, refs, timeout=timeout)
    glb = next((p for p in paths if p.suffix.lower() == ".glb"), None)
    try:
        if glb:
            shutil.move(str(glb), target)
        elif not await model3d._fetch_glb(jobs.comfy.http, stem, target):
            raise RuntimeError("ComfyUI returned no 3D model")
    finally:
        for p in paths:
            if p.exists() and p.parent == config.UPLOAD_DIR:
                p.unlink(missing_ok=True)
    return target


async def _run(jobs: Any, fid: str, source: str, seed: int, files: dict[str, Any]) -> None:
    t0 = time.monotonic()
    out = model3d.OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    work = [out / f"{fid}_apose_body.glb", out / f"{fid}_photo_body.glb", out / f"{fid}_mesh.glb"]
    rel = lambda p: p.relative_to(config.ROOT).as_posix()  # noqa: E731
    try:
        # 1. the A-pose picture
        built = workflows.build_imgedit("instruct", files["qwen"], prompt=workflows.FIGURE_APOSE_PROMPT, seed=seed,
                                        prefix=f"bob/3d/{fid}_apose")
        paths = await jobs.run_quick(built, {"source": source}, timeout=1200)
        pic = next((p for p in paths if p.suffix.lower() in (".png", ".jpg", ".webp")), None)
        if not pic:
            raise RuntimeError("The A-pose picture wasn't made")
        apose = out / f"{fid}_input.png"
        shutil.move(str(pic), apose)
        for p in paths:
            p.unlink(missing_ok=True)
        model3d._update(fid, thumb=rel(apose), step=STEPS[1])
        # 2. the body, fitted to the A-pose picture and to the person's own
        for stem, ref, target in ((f"{fid}_aposebody", rel(apose), work[0]), (f"{fid}_photobody", source, work[1])):
            await _glb_of(jobs, workflows.build_sam3d_body(files["sam3d_body"], prefix=f"bob/3d/{stem}"), {"source": ref},
                          stem, target, timeout=600)
        model3d._update(fid, step=STEPS[2])
        # 3. the textured model of the A-pose picture
        built = workflows.build_make3d(files["trellis"], seed=seed, quality="figure", bg_model=files["bg_model"],
                                       prefix=f"bob/3d/{fid}_mesh")
        await _glb_of(jobs, built, {"source": rel(apose)}, f"{fid}_mesh", work[2], timeout=3600)
        model3d._update(fid, step=STEPS[3])
        # 4. rigged
        glb = out / f"{fid}.glb"
        rig = await asyncio.to_thread(figrig.build, work[0], work[1], work[2], glb)
        rig_path = out / f"{fid}_rig.json"
        rig_path.write_text(json.dumps(rig, separators=(",", ":")), "utf-8")
        if not model3d.get(fid):  # deleted while it was being made
            for p in out.glob(f"{fid}*"):
                p.unlink(missing_ok=True)
            return
        model3d._update(fid, status="done", step=None, finished=time.time(), seconds=round(time.monotonic() - t0, 1),
                        glb=rel(glb), rig=rel(rig_path), size=glb.stat().st_size, pose=rig.get("pose"),
                        height=rig.get("height"))
        log.info("3D figure %s made in %.0f s (%d vertices, %.1f cm from the body)", fid, time.monotonic() - t0,
                 rig["vertices"], rig["gap"] * 100)
    except asyncio.CancelledError:
        model3d._update(fid, status="failed", error="Cancelled", finished=time.time())
        raise
    except Exception as exc:  # noqa: BLE001 - ComfyUI's own error text is the useful part
        log.exception("3D figure %s failed", fid)
        model3d._update(fid, status="failed", error=str(exc)[:500] or type(exc).__name__, finished=time.time())
    finally:
        for p in work:
            p.unlink(missing_ok=True)
        model3d._tasks.pop(fid, None)
