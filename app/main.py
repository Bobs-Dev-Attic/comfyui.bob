"""FastAPI app: JSON API + server-sent events + the static studio UI."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config, llm, models, workflows
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
    await comfy.start()
    yield
    await comfy.stop()


app = FastAPI(title="ComfyUI.Bob Studio", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def no_cache_ui(request: Request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
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


@app.get("/api/capabilities")
async def capabilities(refresh: bool = False):
    if not await comfy.system_stats():
        raise HTTPException(503, "ComfyUI is not reachable at " + config.COMFYUI_URL)
    installed = await comfy.installed_models(refresh=refresh)
    try:
        nodes = await comfy.node_types()
    except Exception:
        nodes = set()
    engines = {}
    for key, mset in models.ALL_SETS.items():
        r = models.resolve(mset, installed)
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
            backend=req.backend, url=req.url, model=req.model or None,
        ))
    except (llm.LLMError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"mode": mode, **result}


@app.post("/api/free")
async def free():
    return {"ok": await comfy.free_vram()}


ALLOWED_UPLOAD = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_UPLOAD:
        raise HTTPException(400, f"Unsupported file type {ext or '(none)'}; use PNG, JPG, WEBP or BMP")
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(400, "Image is larger than 50 MB")
    target = config.UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}{ext}"
    target.write_bytes(data)
    rel = target.relative_to(config.ROOT).as_posix()
    return {"ref": rel, "url": "/" + rel, "name": file.filename}


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
