"""FastAPI app: JSON API + server-sent events + the static studio UI."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config, llm, media, modelpaths, models, projects, render, syscheck, workflows
from .comfy import ComfyService
from .jobs import GenerateRequest, JobManager, media_path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

comfy = ComfyService()
jobs = JobManager(comfy)

REQUIRED_NODES = {
    "h3": {"MiniMaxH3ImageToVideo", "SamplerCustomAdvanced", "VAEDecodeAudio", "CreateVideo", "SaveVideo"},
    "h3ref": {"MiniMaxH3ReferenceToVideo", "SamplerCustomAdvanced", "VAEDecodeAudio", "CreateVideo", "SaveVideo"},
    "klein": {"EmptyFlux2LatentImage", "TextGenerate"},
    "music3": {"MiniMaxMusic3TextEncode", "EmptyMiniMaxMusic3LatentAudio", "SaveAudioMP3"},
}


@asynccontextmanager
async def lifespan(_: FastAPI):
    report = await asyncio.to_thread(syscheck.run)
    for c in report["checks"]:
        if c["status"] in ("warn", "fail"):
            logging.getLogger("bob.syscheck").warning("%s: %s %s", c["label"], c["detail"], c["fix"] and f"({c['fix']})")
    # A version of every project is kept at startup, so the state before this session can always come back.
    result = await asyncio.to_thread(projects.backup_all)
    logging.getLogger("bob.projects").info("startup backup: %s", result)
    await comfy.start()
    yield
    await comfy.stop()


app = FastAPI(title="ComfyUI.Bob Studio", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def no_cache_ui(request: Request, call_next):
    response = await call_next(request)
    if request.url.path in ("/", "/writer") or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"  # revalidate so UI edits show up on reload
    return response


@app.get("/api/status")
async def status():
    stats, proxy_ok, queue = await asyncio.gather(comfy.system_stats(), comfy.proxy_alive(), comfy.queue_size())
    gpu = None
    if stats and stats.get("devices"):
        d = stats["devices"][0]
        name = d.get("name", "").split(" : ")[0]  # "cuda:0 NVIDIA RTX ... : cudaMallocAsync"
        gpu = {"name": name.split(" ", 1)[1] if name.startswith("cuda:") else name,
               "vram_total": d.get("vram_total"), "vram_free": d.get("vram_free")}
    return {
        "version": __version__,
        "comfyui": bool(stats),
        "comfyui_version": stats and stats["system"].get("comfyui_version"),
        "proxy": proxy_ok,
        "gpu": gpu,
        "queue": queue,
    }


@app.get("/api/syscheck")
async def system_check():
    return await asyncio.to_thread(syscheck.run)


@app.get("/api/capabilities")
async def capabilities(refresh: bool = False):
    if not await comfy.system_stats():
        raise HTTPException(503, "ComfyUI is not reachable at " + config.COMFYUI_URL)
    installed = await comfy.installed_models(refresh=refresh)
    disk = await asyncio.to_thread(modelpaths.scan, refresh)
    try:
        nodes = await comfy.node_types()
    except Exception:
        nodes = set()
    engines = {}
    for key, mset in models.ALL_SETS.items():
        r = models.resolve(mset, installed, disk)
        missing_nodes = sorted(REQUIRED_NODES[key] - nodes) if nodes else []
        r["missing_nodes"] = missing_nodes
        r["ready"] = r["ready"] and not missing_nodes
        engines[key] = r
    return {
        "engines": engines,
        "aspects": list(workflows.ASPECTS),
        "h3_quality": workflows.H3_QUALITY,
        "klein_quality": workflows.KLEIN_QUALITY,
        "fps": workflows.FPS,
        "model_paths": [str(p) for p in modelpaths.yaml_files()],
        "comfyui_paths_config": syscheck.comfy_paths_config(await comfy.system_stats()),
    }


@app.get("/api/h3/length")
async def h3_length(seconds: float):
    frames = workflows.h3_length(seconds)
    return {"frames": frames, "seconds": round(frames / workflows.FPS, 2)}


@app.post("/api/generate")
async def generate(req: GenerateRequest):
    try:
        items = await jobs.generate(req)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"items": items}


@app.get("/api/items")
async def items():
    return {"items": jobs.list()}


@app.post("/api/items/{item_id}/cancel")
async def cancel(item_id: str):
    return {"ok": await jobs.cancel(item_id)}


@app.delete("/api/items/{item_id}")
async def delete(item_id: str, files: bool = False):
    if not jobs.delete(item_id, delete_files=files):
        raise HTTPException(404, "not found")
    return {"ok": True}


# ------------------------------------------------------------------ prompt writer (local LLM)

@app.get("/api/llm/backends")
async def llm_backends():
    # Report only whether a key is configured, never the key itself.
    keyed = {"openai": bool(config.LLM_API_KEY)}
    return {"default": config.LLM_BACKEND,
            "backends": [{"key": k, "label": v["label"], "url": v["url"], "api_key": keyed.get(k, False)}
                         for k, v in llm.BACKENDS.items()]}


@app.get("/api/llm/models")
async def llm_models(backend: str = config.LLM_BACKEND, url: str | None = None):
    try:
        b = llm.make_backend(backend, url)
        found = await b.models()
        default = await b.pick(None, config.OLLAMA_MODEL if b.name == "ollama" else config.LLM_MODEL) if found else None
        return {"ok": True, "backend": b.name, "url": b.url, "models": found, "default": default}
    except llm.LLMError as exc:
        return {"ok": False, "backend": backend, "url": url, "models": [], "default": None, "error": str(exc)}


class WritePromptRequest(BaseModel):
    kind: str
    engine: str = "h3"
    idea: str = Field("", max_length=8000)
    seconds: float = Field(5.0, ge=0.5, le=30)
    shots: int | None = Field(None, ge=1, le=6)
    aspect: str = "16:9"
    first_frame: str | None = None
    last_frame: str | None = None
    references: list[str] = Field(default_factory=list, max_length=9)
    dialogue: bool = False
    backend: str | None = None
    url: str | None = None
    model: str | None = None
    locked: dict = Field(default_factory=dict)


@app.post("/api/prompt/write")
async def write_prompt(req: WritePromptRequest):
    if req.engine == "h3ref" and req.kind == "video":
        mode, refs = "ref", req.references
        if not refs:
            raise HTTPException(400, "Add the reference pictures first so the model can see them")
    elif req.engine == "h3" and req.kind == "video":
        refs = [r for r in (req.first_frame, req.last_frame) if r]
        mode = "i2v" if refs else "t2v"
    elif req.engine == "h3" and req.kind == "image":
        mode, refs = "still", []
    elif req.engine == "h3" and req.kind == "audio":
        mode, refs = "sound", []
    else:
        raise HTTPException(400, "The prompt writer is for the H3 engines")
    try:
        images = [media_path(r) for r in refs]
        result = await llm.write_prompt(llm.WriteRequest(
            mode=mode, idea=req.idea, seconds=req.seconds, shots=req.shots, aspect=req.aspect, images=images,
            first_frame=bool(req.first_frame), last_frame=bool(req.last_frame), dialogue=req.dialogue,
            backend=req.backend, url=req.url, model=req.model or None, locked=req.locked or {},
        ))
    except (llm.LLMError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"mode": mode, **result}


# ------------------------------------------------------------------ projects

class NewProject(BaseModel):
    folder: str = ""
    name: str = Field(..., max_length=200)
    settings: dict = Field(default_factory=dict)
    notes: str = Field("", max_length=20000)


class ProjectPatch(BaseModel):
    settings: dict | None = None
    notes: str | None = Field(None, max_length=20000)
    config: dict | None = None
    timeline: dict | None = None


class PathName(BaseModel):
    path: str = ""
    name: str = ""


def _project_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except (projects.ProjectError, media.MediaError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(400, f"File system error: {exc.strerror or exc}") from exc


@app.get("/api/projects/browse")
async def projects_browse(path: str = ""):
    return _project_call(projects.browse, path, jobs.project_counts())


@app.get("/api/projects/tree")
async def projects_tree():
    return _project_call(projects.tree)


@app.get("/api/projects/recent")
async def projects_recent(limit: int = 8):
    return {"projects": _project_call(projects.recent, jobs.project_counts(), limit)}


@app.post("/api/projects")
async def projects_create(req: NewProject):
    return _project_call(projects.create, req.folder, req.name, req.settings, req.notes)


@app.get("/api/projects/by-path")
async def projects_by_path(path: str):
    p = _project_call(projects.safe, path)
    if not projects.is_project(p):
        raise HTTPException(404, "Not a project")
    return _project_call(projects.read, p)


@app.get("/api/projects/{project_id}")
async def projects_get(project_id: str):
    return _project_call(projects.load, project_id)


@app.put("/api/projects/{project_id}")
async def projects_update(project_id: str, req: ProjectPatch):
    return _project_call(projects.update, project_id, settings=req.settings, notes=req.notes, config_=req.config,
                         timeline=req.timeline)


@app.get("/api/projects/{project_id}/history")
async def projects_history(project_id: str):
    return {"versions": _project_call(projects.history, project_id)}


@app.post("/api/projects/{project_id}/restore")
async def projects_restore(project_id: str, req: PathName):
    return _project_call(projects.restore, project_id, req.name)


@app.post("/api/projects/folder")
async def projects_folder(req: PathName):
    return _project_call(projects.make_folder, req.path, req.name)


@app.post("/api/projects/rename")
async def projects_rename(req: PathName):
    return _project_call(projects.rename, req.path, req.name)


@app.post("/api/projects/delete")
async def projects_delete(req: PathName):
    return _project_call(projects.delete, req.path)


# ------------------------------------------------------------------ media library (Inputs gallery)

class Refs(BaseModel):
    refs: list[str] = Field(default_factory=list, max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=50)


class TagEdit(BaseModel):
    refs: list[str] = Field(default_factory=list, max_length=2000)
    add: list[str] = Field(default_factory=list, max_length=50)
    remove: list[str] = Field(default_factory=list, max_length=50)


class Rate(BaseModel):
    refs: list[str] = Field(default_factory=list, max_length=2000)
    rating: int = Field(..., ge=0, le=5)


class FrameReq(BaseModel):
    path: str
    t: float = Field(0, ge=0)


class RenderReq(BaseModel):
    project: str = "experiment"
    range_in: float | None = Field(None, ge=0)
    range_out: float | None = Field(None, ge=0)
    width: int | None = Field(None, ge=64, le=7680)
    height: int | None = Field(None, ge=64, le=4320)
    # Render options (the Render dialog); all optional.
    filename: str = Field("", max_length=120)
    folder: str = Field("", max_length=1000)
    format: str = "mp4-h264"
    fps: float | None = Field(None, ge=1, le=120)
    quality: Literal["high", "medium", "small"] = "high"
    speed: Literal["fast", "balanced", "best"] = "balanced"
    audio: bool = True
    audio_bitrate: int = Field(192, ge=64, le=512)
    sample_rate: Literal[44100, 48000] = 48000
    channels: Literal[1, 2] = 2
    loudness: str = Field("mixer", pattern=r"^(mixer|off|-\d{1,2}(\.\d)?)$")
    overwrite: bool = False


class Ids(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=2000)


class MediaPatch(BaseModel):
    rating: int | None = Field(None, ge=0, le=5)
    note: str | None = Field(None, max_length=2000)


class TagPatch(BaseModel):
    name: str
    new_name: str | None = None
    color: str | None = None


class BookmarkIn(BaseModel):
    path: str = ""
    name: str = ""


@app.get("/api/projects/{project_id}/library")
async def library_get(project_id: str):
    return await asyncio.to_thread(_project_call, projects.library, project_id)


@app.post("/api/projects/{project_id}/library/add")
async def library_add(project_id: str, req: Refs):
    return await asyncio.to_thread(_project_call, projects.add_media, project_id, req.refs, req.tags)


@app.post("/api/projects/{project_id}/library/remove")
async def library_remove(project_id: str, req: Ids):
    return _project_call(projects.remove_media, project_id, req.ids)


@app.post("/api/projects/{project_id}/library/tags")
async def library_tags(project_id: str, req: TagEdit):
    return await asyncio.to_thread(_project_call, projects.tag_media, project_id, req.refs, req.add, req.remove)


@app.post("/api/projects/{project_id}/library/rate")
async def library_rate(project_id: str, req: Rate):
    return await asyncio.to_thread(_project_call, projects.rate_media, project_id, req.refs, req.rating)


@app.patch("/api/projects/{project_id}/library/media/{item_id}")
async def library_media_patch(project_id: str, item_id: str, req: MediaPatch):
    return _project_call(projects.update_media, project_id, item_id, rating=req.rating, note=req.note)


@app.post("/api/projects/{project_id}/library/folders")
async def library_folder_save(project_id: str, folder: dict):
    return _project_call(projects.save_folder, project_id, folder)


@app.delete("/api/projects/{project_id}/library/folders/{folder_id}")
async def library_folder_delete(project_id: str, folder_id: str):
    return _project_call(projects.delete_folder, project_id, folder_id)


@app.post("/api/projects/{project_id}/library/tag")
async def library_tag_patch(project_id: str, req: TagPatch):
    if req.new_name is not None:
        return _project_call(projects.rename_tag, project_id, req.name, req.new_name)
    if req.color is not None:
        return _project_call(projects.set_tag_color, project_id, req.name, req.color)
    return _project_call(projects.delete_tag, project_id, req.name)


@app.get("/api/media/list")
async def media_list(source: str, path: str = "", id: str = "", project: str = ""):
    """source: uploads | results | bookmark (with id)."""
    if source == "results":
        return {"files": media.list_results(jobs.list(), project or None), "folders": [], "crumbs": [], "sub": ""}
    if source == "uploads":
        return await asyncio.to_thread(_project_call, media.list_folder, config.UPLOAD_DIR, path)
    if source == "bookmark":
        base = _project_call(media.bookmark, id)
        return await asyncio.to_thread(_project_call, media.list_folder, base, path)
    raise HTTPException(400, "Unknown source")


_thumb_slots = asyncio.Semaphore(4)


@app.get("/api/media/thumb")
async def media_thumb(path: str, w: int = 256):
    async with _thumb_slots:
        try:
            f = await asyncio.to_thread(media.thumbnail, path, w)
        except (media.MediaError, OSError) as exc:
            raise HTTPException(404, str(exc)) from exc
    # The URL carries the file's modified time (v=…), so the browser may keep it for good.
    return FileResponse(f, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/media/file")
async def media_file(path: str):
    try:
        f = media.resolve(path)
    except media.MediaError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(f)


@app.get("/api/media/probe")
async def media_probe(path: str):
    return await asyncio.to_thread(_project_call, media.probe, path)


@app.post("/api/media/frame")
async def media_frame(req: FrameReq):
    return await asyncio.to_thread(_project_call, media.grab_frame, req.path, req.t)


@app.post("/api/timeline/render")
async def timeline_render(req: RenderReq):
    """Render the saved timeline of a project to an MP4; it shows up as a studio result."""
    p = _project_call(projects.find, req.project)
    pf = _project_call(projects.load_file, p)
    try:
        opts = req.model_dump(exclude={"project", "range_in", "range_out", "width", "height"})
        return await render.render(jobs, None if req.project == "experiment" else req.project, pf.timeline,
                                   w0=req.range_in, w1=req.range_out, width=req.width, height=req.height,
                                   name=pf.name, opts=opts)
    except (ValueError, media.MediaError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/timeline/formats")
async def timeline_formats():
    """Render formats this ffmpeg can write, and places a render can be saved to."""
    fmts = await asyncio.to_thread(render.formats)
    places = [{"name": "Studio results (outputs)", "path": ""}] + [{"name": b["name"], "path": b["path"]} for b in media.bookmarks()]
    return {"formats": fmts, "places": places}


@app.get("/api/timeline/fcpxml")
async def timeline_fcpxml(project: str = "experiment"):
    """The project's timeline as FCPXML 1.9 (DaVinci Resolve: File > Import > Timeline)."""
    from fastapi.responses import Response

    from . import fcpxml

    p = _project_call(projects.find, project)
    pf = _project_call(projects.load_file, p)
    try:
        data = await asyncio.to_thread(fcpxml.build, pf.timeline, pf.name)
    except (ValueError, media.MediaError) as exc:
        raise HTTPException(400, str(exc)) from exc
    safe = "".join(ch if ch.isalnum() or ch in " -_." else "_" for ch in pf.name).strip() or "timeline"
    return Response(data, media_type="application/xml",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.fcpxml"'})


@app.get("/api/media/cache")
async def media_cache():
    return await asyncio.to_thread(media.cache_size)


@app.delete("/api/media/cache")
async def media_cache_clear():
    return await asyncio.to_thread(media.clear_cache)


@app.get("/api/bookmarks")
async def bookmarks_list():
    return {"bookmarks": media.bookmarks()}


@app.post("/api/bookmarks")
async def bookmarks_add(req: BookmarkIn):
    return _project_call(media.add_bookmark, req.path, req.name)


@app.patch("/api/bookmarks/{bid}")
async def bookmarks_rename(bid: str, req: BookmarkIn):
    return _project_call(media.update_bookmark, bid, req.name)


@app.delete("/api/bookmarks/{bid}")
async def bookmarks_remove(bid: str):
    media.remove_bookmark(bid)
    return {"ok": True}


@app.get("/api/fs/dirs")
async def fs_dirs(path: str = ""):
    return await asyncio.to_thread(_project_call, media.list_dirs, path)


@app.post("/api/free")
async def free():
    return {"ok": await comfy.free_vram()}


UPLOAD_LIMITS = {"image": 50, "video": 2048, "audio": 500}  # MB per kind


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    kind = media.kind_of(file.filename or "")
    if not kind:
        raise HTTPException(400, f"Unsupported file type {ext or '(none)'}: use a picture, a video (MP4, WEBM, MOV) or a sound file")
    limit = UPLOAD_LIMITS[kind] * 1024 * 1024
    target = config.UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}{ext}"
    size = 0
    try:  # stream to disk so large clips don't sit in memory
        with target.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(400, f"{file.filename} is larger than {UPLOAD_LIMITS[kind]} MB")
                out.write(chunk)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    rel = target.relative_to(config.ROOT).as_posix()
    return {"ref": rel, "url": "/" + rel, "name": file.filename, "kind": kind}


@app.get("/api/events")
async def events(request: Request):
    q = jobs.subscribe()

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            jobs.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


app.mount("/outputs", StaticFiles(directory=config.OUTPUT_DIR), name="outputs")
app.mount("/data/uploads", StaticFiles(directory=config.UPLOAD_DIR), name="uploads")
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/writer")
async def writer_page():
    return FileResponse(config.STATIC_DIR / "writer.html")
