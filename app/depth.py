"""Depth analysis for camera moves (Depth Anything 3 in ComfyUI).

The picture under a camera move (without the camera) is rendered small at 12 fps, sent to
ComfyUI, and Depth Anything 3 (base, mono) turns every frame into a depth picture: near is
bright, far is dark. The depth video is smoothed over time with ffmpeg and kept under
data/uploads/depth/<id>/depth.mp4. The Camera window's 3D view uses it to raise the picture
into a relief, and the render uses it for parallax (app/camera.py).

It runs as a studio item (engine "depth") so the Activity console shows its log; the gallery
leaves these out.
"""
from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any

from . import config, media, render

log = logging.getLogger("bob.depth")
MODEL = "depth_anything_3_base.safetensors"
FPS = 12


def _comfy() -> str:
    return config.COMFYUI_URL


def _post(path: str, data: bytes, ctype: str) -> dict[str, Any]:
    req = urllib.request.Request(_comfy() + path, data, {"Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def _get(path: str, timeout: float = 30) -> bytes:
    with urllib.request.urlopen(_comfy() + path, timeout=timeout) as r:
        return r.read()


def _upload(path: str, name: str) -> str:
    bnd = uuid.uuid4().hex
    data = open(path, "rb").read()
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            "Content-Type: video/mp4\r\n\r\n").encode() + data + (
        f"\r\n--{bnd}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{bnd}--\r\n").encode()
    return _post("/upload/image", body, f"multipart/form-data; boundary={bnd}")["name"]


def graph(video_name: str, prefix: str, megapixels: float = 0.4) -> dict[str, Any]:
    return {
        "1": {"class_type": "LoadVideo", "inputs": {"file": video_name}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "3": {"class_type": "CRT_DepthAnything3", "inputs": {
            "model_name": MODEL, "keep_model_loaded": False, "weight_dtype": "default", "image": ["2", 0],
            "megapixels": megapixels, "mode": "mono", "output": "depth", "normalization": "v2_style",
            "apply_sky_clip": False, "colored": False, "ref_view_strategy": "saddle_balanced", "pose_method": "cam_dec"}},
        "4": {"class_type": "CreateVideo", "inputs": {"images": ["3", 0], "fps": float(FPS)}},
        "5": {"class_type": "SaveVideo", "inputs": {"video": ["4", 0], "filename_prefix": prefix, "format": "auto", "codec": "auto"}},
    }


async def analyze(jobs: Any, project_id: str | None, tl: Any, clip: Any, sig: str = "") -> dict[str, Any]:
    """Start a depth analysis of the picture under a camera clip; returns the item at once."""
    seconds = clip.end - clip.start
    if seconds < 0.2:
        raise ValueError("The camera move is too short")
    item_id = uuid.uuid4().hex[:12]
    folder = config.UPLOAD_DIR / "depth" / item_id
    folder.mkdir(parents=True, exist_ok=True)
    item = {
        "id": item_id, "kind": "video", "engine": "depth", "project": project_id, "status": "running",
        "params": {"kind": "video", "engine": "depth", "prompt": f"Depth · {clip.name} · {seconds:.2f}s",
                   "camera_clip": clip.id, "sig": sig, "start": clip.start, "trim_in": clip.trim_in},
        "seed": 0, "created": time.time(), "started": time.time(), "files": [], "progress": 0.0, "error": None,
        "info": {"seconds": round(seconds, 2)}, "log": [],
    }
    jobs.items[item_id] = item
    jobs._update(item)
    say = lambda m, level="info": jobs.log(item, m, level)  # noqa: E731

    def progress(v: float, msg: str) -> None:
        item["progress"] = v
        jobs._publish({"type": "progress", "id": item_id, "value": v, "step": None, "steps": None, "message": msg})

    async def run() -> None:
        t0 = time.time()
        try:
            W0, H0 = render.size_of(tl)
            k = (0.4 * 1024 * 1024 / max(1, W0 * H0)) ** 0.5
            W, H = max(64, int(W0 * k) // 2 * 2), max(64, int(H0 * k) // 2 * 2)
            flat = folder / "flat.mp4"
            say(f"Rendering the picture under the move without the camera: {seconds:.2f} s at {W}×{H}, {FPS} fps")
            progress(0.05, "Rendering the picture")
            steps, _d, temps = render.commands(tl, str(flat), clip.start, clip.end, W, H,
                                               opts={"no_camera": True, "audio": False, "fps": FPS, "speed": "fast", "quality": "high"})
            try:
                await asyncio.to_thread(render.run_steps, steps, 600)
            finally:
                for t in temps:
                    if t != str(flat):
                        try:
                            __import__("os").remove(t)
                        except OSError:
                            pass
            say("Sending it to ComfyUI")
            progress(0.15, "Uploading")
            name = await asyncio.to_thread(_upload, str(flat), f"bob_depth_{item_id}.mp4")
            prefix = f"bob/depth/{item_id}"
            res = await asyncio.to_thread(_post, "/prompt", json.dumps({"prompt": graph(name, prefix)}).encode(), "application/json")
            pid = res.get("prompt_id")
            if not pid:
                raise RuntimeError(f"ComfyUI refused the depth graph: {json.dumps(res.get('node_errors') or res)[:400]}")
            say(f"Depth Anything 3 is running (ComfyUI prompt {pid})")
            n_frames = max(1, int(seconds * FPS))
            hist: dict[str, Any] = {}
            while True:
                await asyncio.sleep(1.0)
                hist = json.loads(await asyncio.to_thread(_get, f"/history/{pid}"))
                st = hist.get(pid, {}).get("status", {})
                if st.get("status_str") in ("success", "error") or st.get("completed"):
                    break
                el = time.time() - t0
                progress(min(0.9, 0.2 + 0.7 * (1 - 1 / (1 + el / max(5.0, n_frames * 0.35)))), "Estimating depth")
            st = hist[pid].get("status", {})
            if st.get("status_str") != "success":
                err = next((m[1].get("exception_message", "") for m in st.get("messages", []) if m[0] == "execution_error"), "")
                raise RuntimeError(f"Depth Anything failed: {err[:600] or 'see the ComfyUI log'}")
            out = next((v for o in hist[pid].get("outputs", {}).values() for key in ("images", "videos", "gifs") for v in o.get(key, [])), None)
            if not out:
                raise RuntimeError("ComfyUI didn't return the depth video")
            q = urllib.parse.urlencode({"filename": out["filename"], "subfolder": out.get("subfolder", ""), "type": out.get("type", "output")})
            raw = folder / "raw.mp4"
            raw.write_bytes(await asyncio.to_thread(_get, f"/view?{q}", 300))
            say("Smoothing the depth over time")
            progress(0.95, "Smoothing")
            target = folder / "depth.mp4"
            r = await asyncio.to_thread(subprocess.run, [media.ffmpeg(), "-nostdin", "-v", "error", "-y", "-i", str(raw), "-an",
                                                         "-vf", "format=gray,tmix=frames=3,format=yuv420p", "-c:v", "libx264", "-crf", "12",
                                                         "-preset", "fast", "-r", str(FPS), str(target)],
                                        capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=media.NO_WINDOW)
            if r.returncode or not target.is_file():
                raise RuntimeError(r.stderr.strip()[-400:] or "ffmpeg couldn't smooth the depth video")
            raw.unlink(missing_ok=True)
            flat.unlink(missing_ok=True)
            rel = target.relative_to(config.ROOT).as_posix()
            files = [{"name": target.name, "path": rel, "url": f"/api/media/file?path={urllib.parse.quote(rel)}",
                      "content_type": "video/mp4", "size": target.stat().st_size}]
            say(f"Done in {time.time() - t0:.1f} s: {rel}")
            jobs._update(item, status="done", files=files, progress=1.0, finished=time.time())
        except Exception as exc:  # noqa: BLE001
            log.exception("depth %s failed", item_id)
            say(f"Failed: {str(exc)[:400]}", "error")
            jobs._update(item, status="failed", error=str(exc)[:1500], finished=time.time())

    asyncio.create_task(run())
    return item
