"""FastAPI app: JSON API + server-sent events + the static studio UI."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, appsettings, audiotools, config, llm, media, modelpaths, models, projects, prompts, render, syscheck, updater, workflows
from .comfy import ComfyService
from .jobs import EnhanceOpts, GenerateRequest, JobManager, media_path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

comfy = ComfyService()
jobs = JobManager(comfy)

REQUIRED_NODES = {
    "h3": {"MiniMaxH3ImageToVideo", "SamplerCustomAdvanced", "VAEDecodeAudio", "CreateVideo", "SaveVideo"},
    "h3ref": {"MiniMaxH3ReferenceToVideo", "SamplerCustomAdvanced", "VAEDecodeAudio", "CreateVideo", "SaveVideo"},
    "klein": {"EmptyFlux2LatentImage", "TextGenerate"},
    "krea2": {"ConditioningZeroOut", "TextGenerate"},
    "h3image": {"MiniMaxH3ImageConditioning", "ConditioningZeroOut"},
    "music3": {"MiniMaxMusic3TextEncode", "EmptyMiniMaxMusic3LatentAudio", "SaveAudioMP3"},
    "angles": {"TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "CFGNorm", "ModelSamplingAuraFlow"},
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
    # Settings › Updates: check GitHub for a newer version now and then (and install it when idle, if Automatic).
    update_task = asyncio.create_task(updater.loop(_rendering))
    yield
    update_task.cancel()
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


@app.get("/api/update")
async def update_status():
    return updater.status()


@app.post("/api/update/check")
async def update_check():
    return await updater.check()


@app.post("/api/update/apply")
async def update_apply():
    """Install the newer version from GitHub and restart the studio."""
    try:
        return await updater.apply(_rendering)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/syscheck")
async def system_check():
    return await asyncio.to_thread(syscheck.run)


@app.get("/api/enhance/caps")
async def enhance_caps():
    """Which enhance steps this ComfyUI can run, and the SeedVR2 models it has."""
    import json as _json
    import urllib.request as _ur

    def options(node: str, field: str) -> list[str]:
        try:
            with _ur.urlopen(f"{config.COMFYUI_URL}/object_info/{node}", timeout=20) as r:
                spec = _json.loads(r.read())[node]["input"]["required"][field]
            return spec[0] if isinstance(spec[0], list) else (spec[1] or {}).get("options", [])
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            return []

    installed = await comfy.installed_models()
    has = lambda *n: all(jobs.has_node(x) for x in n)  # noqa: E731
    # Only models that are on disk: the SeedVR2 loader lists every model it knows and downloads a missing
    # one when it runs (3–16 GB), which must never happen behind your back.
    dits = [m for m in await asyncio.to_thread(options, "SeedVR2LoadDiTModel", "model") if m in await jobs.seedvr2_files()]
    return {
        "facerefine": has("H3FaceTrackCrop", "H3FaceStitch", "H3PerFrameDenoise", "H3InjectVideoLatent", "MiniMaxH3NativeAudioLock"),
        "dlss": has("DLSS5EnhanceImages", "DLSS5Settings"),
        "seedvr2": has("SeedVR2VideoUpscaler", "SeedVR2LoadDiTModel", "SeedVR2LoadVAEModel") and bool(dits),
        "seedvr2_models": dits,
        "relayvsr": has("RelayVSRConditioning", "VSRDecode") and any("relayvsr" in n.lower() for n in installed.get("diffusion_models", []))
                    and any("relayvsr" in n.lower() for n in installed.get("vae", [])),
    }


class EnhanceReq(BaseModel):
    item: str | None = Field(None, max_length=64)  # a studio result
    ref: str | None = Field(None, max_length=2000)  # or any media file (no FaceRefine context then)
    options: EnhanceOpts
    seed: int = -1
    project: str | None = Field(None, max_length=64)


@app.post("/api/enhance")
async def enhance(req: EnhanceReq):
    """Enhance / upscale a picture or video: FaceRefine -> DLSS 5 -> SeedVR2 or RelayVSR x2."""
    try:
        if req.item:
            it = jobs.items.get(req.item)
            if not it or it.get("status") != "done" or not it.get("files"):
                raise HTTPException(404, "That result isn't finished or doesn't exist")
            items = await jobs.enhance_item(it, req.options, seed=req.seed)
        elif req.ref:
            items = await jobs.enhance_ref(req.ref, req.options, seed=req.seed, project=req.project)
        else:
            raise HTTPException(400, "Nothing to enhance")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"items": items}


@app.get("/api/loras")
async def loras_list(refresh: bool = False):
    """Every LoRA ComfyUI can load, with what it's for and its details (app/loras.py)."""
    from . import loras

    names = (await comfy.installed_models(refresh=refresh)).get("loras", [])
    rows = await asyncio.to_thread(loras.scan, names, refresh)
    return {"loras": rows, "families": loras.FAMILIES, "engine_families": {k: sorted(v) for k, v in loras.ENGINE_FAMILIES.items()}}


@app.get("/api/loras/metadata")
async def loras_metadata(name: str):
    """A LoRA's full safetensors metadata (the __metadata__ block), for the Details dialog."""
    from . import loras

    path = await asyncio.to_thread(loras.find_path, name)
    if not path or not path.is_file():
        raise HTTPException(404, "That LoRA isn't on disk")
    try:
        return await asyncio.to_thread(loras.metadata, path)
    except (OSError, ValueError) as exc:
        raise HTTPException(422, f"Couldn't read its header: {exc}") from exc


@app.get("/api/loras/preview")
async def loras_preview(name: str):
    """The preview picture saved next to a LoRA (name.png, name.preview.png, ...)."""
    from . import loras

    path = await asyncio.to_thread(loras.find_path, name)
    pic = path and await asyncio.to_thread(loras.preview_path, path)
    if not pic:
        raise HTTPException(404, "No preview for that LoRA")
    return FileResponse(pic, headers={"Cache-Control": "max-age=3600"})


# ------------------------------------------------------------------ image editor (static/editor.js)

class SelectReq(BaseModel):
    source: str = Field(..., max_length=2000)
    positive: list[dict[str, float]] = Field(default_factory=list, max_length=64)
    negative: list[dict[str, float]] = Field(default_factory=list, max_length=64)
    box: dict[str, float] | None = None
    text: str = Field("", max_length=300)
    threshold: float = Field(0.5, ge=0.05, le=0.95)


def _sam_ckpt(installed: dict[str, list[str]]) -> str | None:
    return next((n for n in sorted(installed.get("checkpoints", []), reverse=True) if "sam3" in n.lower().replace("\\", "/").rsplit("/", 1)[-1]), None)


@app.post("/api/edit/select")
async def edit_select(req: SelectReq):
    """AI select: SAM 3.1 turns brush points, a box or words into a mask (a picture in data/uploads)."""
    if not (req.positive or req.box or req.text.strip()):
        raise HTTPException(400, "Paint over something, or type what to select")
    ckpt = _sam_ckpt(await comfy.installed_models())
    if not ckpt:
        raise HTTPException(409, "AI select needs a SAM 3 checkpoint (sam3*.safetensors) in models/checkpoints")
    built = workflows.build_ai_select(ckpt, positive=req.positive, negative=req.negative, box=req.box,
                                      text=req.text, threshold=req.threshold)
    try:
        paths = await jobs.run_quick(built, {"source": req.source})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - ComfyUI's own error text is the useful part
        raise HTTPException(502, f"AI select failed: {str(exc)[:500]}") from exc
    if not paths:
        raise HTTPException(502, "AI select returned nothing")
    rel = paths[0].relative_to(config.ROOT).as_posix()
    return {"mask": rel, "url": "/" + rel}


# ------------------------------------------------------------------ Inputs: describe a picture, audio tools

class DescribeReq(BaseModel):
    ref: str
    backend: str | None = None
    url: str | None = None
    model: str | None = None


DESCRIBE_SYSTEM = (
    "You define the subject of a reference picture so a video model can show it accurately, the same in every shot, "
    "from text alone. Use as much detail as that needs: 70-170 words, one paragraph of plain present-tense English, "
    "starting with what the subject is (e.g. 'a woman in her late twenties', 'a black Labrador', 'a red 1960s convertible'). "
    "For a person: apparent age, build, face shape, eyes (colour, shape), eyebrows, nose, lips, skin tone and texture, "
    "distinctive marks (freckles, moles, tattoos, scars, piercings), hair (colour, length, texture, style), and what they "
    "wear with colours and materials, or that they wear nothing; then accessories. For an animal or object: kind, size, "
    "shape, materials, colours, markings and condition. Leave out the photo's background, light, pose and camera, which "
    "each shot sets itself; but if the picture is mainly a place or a visual style, describe that instead, with its "
    "light and palette. Describe only what is visible: no names, no guesses about story or feelings, no lists, "
    "no 'the image shows'.")


@app.post("/api/describe")
async def describe_picture(req: DescribeReq):
    """Describe with AI: a vision LLM writes a detailed description of a reference picture for prompts."""
    path = media_path(req.ref)
    if media.kind_of(path.name) != "image":
        raise HTTPException(400, "Only pictures can be described")
    try:
        b = llm.make_backend(req.backend, req.url)
        model = await b.pick(req.model or None, config.OLLAMA_MODEL if b.name == "ollama" else config.LLM_MODEL)
        if not req.model and await b.vision(model) is False:  # Auto: the first model that can see pictures
            for m in await b.models():
                if await b.vision(m["name"]):
                    model = m["name"]
                    break
        if await b.vision(model) is False:
            raise HTTPException(400, f"{model} can't see pictures: pick a vision model (for example qwen3-vl) for the Prompt writer")
        t0 = asyncio.get_running_loop().time()
        raw = await b.chat(model, [{"role": "system", "content": DESCRIBE_SYSTEM},
                                   {"role": "user", "content": "Describe this picture.", "images": [llm._image_b64(path, 1024)]}],
                           {"type": "object", "properties": {"description": {"type": "string", "maxLength": 1800}},
                            "required": ["description"]}, temperature=0.3)
        text = str(json.loads(raw).get("description", "")).strip()
    except llm.LLMError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(502, f"The model's answer wasn't usable: {exc}") from exc
    if not text:
        raise HTTPException(502, "The model returned no description")
    return {"text": text, "model": model, "seconds": round(asyncio.get_running_loop().time() - t0, 1)}


class AudioReq(BaseModel):
    ref: str
    opts: audiotools.AudioOpts = Field(default_factory=audiotools.AudioOpts)


async def _isolate_voice(ref: str) -> Path:
    if not jobs.has_node("DemucsVoiceIsolate"):
        raise ValueError("Removing music needs the comfyui-demucs-voice-isolate nodes in ComfyUI")
    g = workflows.Graph()
    load = g.add("LoadAudio", audio="")
    iso = g.add("DemucsVoiceIsolate", audio=[load, 0], stem="vocals")
    save = g.add("SaveAudio", audio=[iso, 0], filename_prefix="bob/voice")
    paths = await jobs.run_quick(workflows.Built(graph=g.nodes, outputs=[save], image_inputs={"aref": load}), {"aref": ref}, timeout=1800)
    if not paths:
        raise RuntimeError("Voice isolation returned nothing")
    return paths[0]


async def _audio(req: AudioReq, keep: bool) -> dict:
    media_path(req.ref)  # raises if invalid
    try:
        return await audiotools.render(req.ref, req.opts, _isolate_voice, keep=keep)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - ffmpeg's or ComfyUI's own error text is the useful part
        raise HTTPException(502, str(exc)[:500]) from exc


@app.post("/api/audio/preview")
async def audio_preview(req: AudioReq):
    return await _audio(req, keep=False)


@app.post("/api/audio/save")
async def audio_save(req: AudioReq):
    out = await _audio(req, keep=True)
    return {**out, "name": Path(req.ref).stem + " (cleaned).flac", "kind": "audio"}


@app.post("/api/edit/save")
async def edit_save(file: UploadFile = File(...), source: str = Form(""), project: str = Form(""), note: str = Form("")):
    """Save the editor's picture (crop, resize, colors done in the browser) as a new result."""
    data = await file.read(60 * 1024 * 1024 + 1)
    if len(data) > 60 * 1024 * 1024:
        raise HTTPException(400, "The picture is larger than 60 MB")
    try:
        from PIL import Image as _Image
        import io as _io

        with _Image.open(_io.BytesIO(data)) as im:
            im.verify()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Not a picture: {exc}") from exc
    return {"item": jobs.add_edit(data, source=source or None, project=project or None, note=note)}


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
        r["unet_choices"] = models.unet_choices(mset, installed)
        engines[key] = r
    editor = {
        "select": bool(_sam_ckpt(installed)) and "SAM3_Detect" in nodes,
        # The models for erase, replace and whole-picture edits; erase and replace also need the NKD crop nodes.
        "qwen": models.resolve(models.QWEN_EDIT, installed)["ready"] and "TextEncodeQwenImageEditPlus" in nodes,
        "h3image": models.resolve(models.H3_IMAGE, installed)["ready"] and "MiniMaxH3ImageConditioning" in nodes,
        "crop": {"NKDInpaintCrop", "NKDInpaintStitch"} <= nodes,
        "inpaint": engines["krea2"]["ready"] and {"NKDInpaintCrop", "NKDInpaintStitch"} <= nodes,
        "remove_bg": ("RemoveBackground" in nodes and bool(installed.get("background_removal")))
                     or "Image Rembg (Remove Background)" in nodes,
        "remover": "BiRefNet" if installed.get("background_removal") else "u2net",
    }
    editor["erase"] = editor["crop"] and (editor["qwen"] or editor["h3image"])
    return {
        "editor": editor,
        "engines": engines,
        "aspects": list(workflows.ASPECTS),
        "h3_quality": workflows.H3_QUALITY,
        "klein_quality": workflows.KLEIN_QUALITY,
        "krea2_quality": workflows.KREA2_QUALITY,
        "h3image_quality": workflows.H3_IMAGE_QUALITY,
        "samplers": comfy.samplers, "schedulers": comfy.schedulers,
        "sampling_defaults": {k: {"sampler": a, "scheduler": b, "cfg": workflows.CFG_DEFAULTS.get(k)}
                              for k, (a, b) in workflows.SAMPLING_DEFAULTS.items()},
        "fps": workflows.FPS,
        "model_paths": [str(p) for p in modelpaths.yaml_files()],
        "comfyui_paths_config": syscheck.comfy_paths_config(await comfy.system_stats()),
    }


@app.get("/api/h3/length")
async def h3_length(seconds: float):
    frames = workflows.h3_length(seconds)
    return {"frames": frames, "seconds": round(frames / workflows.FPS, 2)}


class ClientLog(BaseModel):
    msg: str = Field(..., max_length=2000)


@app.post("/api/client-log")
async def client_log(entry: ClientLog):
    """Browser-side events worth keeping (Generate presses, script errors) in the server log."""
    logging.getLogger("bob.client").warning("%s", entry.msg.replace("\n", " | ")[:2000])
    return {"ok": True}


@app.post("/api/generate")
async def generate(req: GenerateRequest):
    asyncio.create_task(prompts.release())  # a live-rewrite LLM must not hold VRAM during the render
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


@app.get("/api/items/{item_id}/workflow")
async def item_workflow(item_id: str, download: bool = False):
    """The exact ComfyUI workflow (API format) a result was made with, to compare or load in ComfyUI."""
    from .jobs import WORKFLOW_DIR
    f = WORKFLOW_DIR / f"{item_id}.json"
    if not f.is_file():
        raise HTTPException(404, "No saved workflow for this result (it was made before v0.33.0)")
    headers = {"Content-Disposition": f'attachment; filename="bob-{item_id}-workflow_api.json"'} if download else {}
    return FileResponse(f, media_type="application/json", headers=headers)


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
    voices: int = Field(0, ge=0, le=9)  # H3 Reference voice recordings, paired with the pictures by number
    dialogue: bool = False
    backend: str | None = None
    url: str | None = None
    model: str | None = None
    locked: dict = Field(default_factory=dict)
    creativity: int = Field(50, ge=0, le=100)  # 0 = literal ... 100 = free reinterpretation
    draft: dict = Field(default_factory=dict)  # Enhance: the current fields, improved rather than rewritten


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
            voices=req.voices if mode == "ref" else 0,
            backend=req.backend, url=req.url, model=req.model or None, locked=req.locked or {},
            creativity=req.creativity, draft=req.draft or {},
        ))
    except (llm.LLMError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"mode": mode, **result}


# ------------------------------------------------------------------ prompt catalog + live rewrite

def _rendering() -> bool:
    return any(i.get("status") in ("queued", "running", "submitting") for i in jobs.list())


@app.get("/api/prompts")
async def prompt_list():
    return {"entries": prompts.list_entries(), "presets": prompts.presets(),
            "node_library": bool(prompts.node_library())}


class PromptEntry(BaseModel):
    id: str | None = Field(None, max_length=40)
    title: str = Field(..., max_length=200)
    model: str = Field("", max_length=40)
    prompt: str = Field("", max_length=40000)
    tags: dict = Field(default_factory=dict)


@app.post("/api/prompts")
async def prompt_save(entry: PromptEntry):
    try:
        saved = prompts.save_entry(entry.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"entry": saved, "entries": prompts.list_entries()}


@app.delete("/api/prompts/{entry_id}")
async def prompt_delete(entry_id: str):
    if not prompts.delete_entry(entry_id):
        raise HTTPException(404, "No such prompt")
    return {"entries": prompts.list_entries()}


@app.post("/api/prompts/import-node")
async def prompt_import_node():
    try:
        result = await asyncio.to_thread(prompts.import_node_library)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, "entries": prompts.list_entries()}


class LiveLLM(BaseModel):
    backend: str | None = Field(None, max_length=20)
    url: str | None = Field(None, max_length=500)
    model: str | None = Field(None, max_length=200)
    profile: str | None = Field(None, max_length=20)


class RewriteRequest(LiveLLM):
    text: str = Field(..., min_length=1, max_length=8000)
    profile: str = Field(..., max_length=20)
    seconds: float = Field(5.0, ge=0.5, le=600)
    keep: list[str] = Field(default_factory=list, max_length=30)  # words the rewrite must keep (stand-ins for template parts)
    problems: list[str] = Field(default_factory=list, max_length=20)  # what the live model view flagged: the rewrite fixes them
    refs: int | None = Field(None, ge=0, le=9)  # reference pictures added (H3 Reference / H3 Image)
    arefs: int = Field(0, ge=0, le=9)  # voice references (H3 Reference)
    creativity: int | None = Field(None, ge=0, le=100)  # the Prompt tab's Creativity; None = keep the idea as written


@app.post("/api/prompt/warm")
async def prompt_warm(req: LiveLLM):
    if _rendering():
        return {"paused": True}
    try:
        return await prompts.warm(req.backend, req.url, req.model, req.profile)
    except llm.LLMError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/prompt/rewrite")
async def prompt_rewrite(req: RewriteRequest):
    if _rendering():
        raise HTTPException(409, "Live rewrite pauses while a render runs, so the LLM doesn't take its VRAM")
    if req.profile not in prompts.PROFILES:
        raise HTTPException(400, f"No live rewrite for {req.profile}")
    return StreamingResponse(prompts.rewrite_stream(req.text, req.profile, req.seconds, req.backend, req.url, req.model, req.keep,
                                                     req.problems, req.refs, req.arefs, req.creativity),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


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


class VersionLabel(BaseModel):
    label: str = Field("", max_length=120)


@app.post("/api/projects/{project_id}/versions")
async def versions_save(project_id: str, req: VersionLabel):
    """Keep the current state now as a named version."""
    return _project_call(projects.save_version, project_id, req.label)


@app.put("/api/projects/{project_id}/versions/{name}")
async def versions_label(project_id: str, name: str, req: VersionLabel):
    return _project_call(projects.label_version, project_id, name, req.label)


@app.delete("/api/projects/{project_id}/versions/{name}")
async def versions_delete(project_id: str, name: str):
    return _project_call(projects.delete_version, project_id, name)


# ------------------------------------------------------------------ app settings (data/settings.json)
@app.get("/api/settings")
async def settings_get():
    return appsettings.payload()


@app.put("/api/settings")
async def settings_update(patch: dict):
    """Merge a partial settings object, e.g. {"appearance": {"theme": "light"}}."""
    try:
        appsettings.update(patch)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return appsettings.payload()


@app.post("/api/settings/import")
async def settings_import(data: dict):
    """Replace every setting (an exported settings.json); missing values get their defaults."""
    try:
        appsettings.replace(data.get("settings", data) if isinstance(data.get("settings"), dict) else data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return appsettings.payload()


@app.post("/api/settings/reset")
async def settings_reset():
    appsettings.reset()
    return appsettings.payload()


@app.post("/api/projects/{project_id}/restore")
async def projects_restore(project_id: str, req: PathName):
    return _project_call(projects.restore, project_id, req.name)


@app.post("/api/projects/folder")
async def projects_folder(req: PathName):
    return _project_call(projects.make_folder, req.path, req.name)


@app.post("/api/projects/rename")
async def projects_rename(req: PathName):
    return _project_call(projects.rename, req.path, req.name)


class AnglesReq(BaseModel):
    ref: str = Field(..., max_length=2000)  # the reference picture (a media ref)
    poses: list[str] = Field(..., min_length=1, max_length=96)  # "<azimuth> <elevation> <distance>"
    prompt: str = Field("", max_length=4000)  # added after the pose: background, lighting, what to keep
    seed: int = -1
    project: str | None = Field(None, max_length=64)
    enhance_after: dict | None = None  # Enhance chain to run on each result (the server runs it when each is done)
    white_bg: bool = False  # make the plain backdrop pure white before enhancing


@app.get("/api/angles/options")
async def angles_options():
    return {"azimuths": workflows.ANGLE_AZIMUTHS, "elevations": workflows.ANGLE_ELEVATIONS, "distances": workflows.ANGLE_DISTANCES}


@app.post("/api/angles")
async def angles(req: AnglesReq):
    """Re-shoot one picture from several camera angles (Qwen Image Edit 2511 + multiple-angles LoRA):
    one result per pose, all with the same seed so they stay alike."""
    if media.kind_of(req.ref) != "image":
        raise HTTPException(400, "Angles needs a picture")
    seed = req.seed if req.seed >= 0 else random.randint(0, 2**48)
    items = []
    try:
        for pose in req.poses:
            items += await jobs.generate(GenerateRequest(kind="image", engine="angles", references=[req.ref], pose=pose,
                                                         prompt=req.prompt, seed=seed, project=req.project,
                                                         enhance_after=req.enhance_after, white_bg=req.white_bg))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"items": items}


class ProjectCopy(BaseModel):
    id: str = Field(..., max_length=64)  # the project to copy ("experiment" works too)
    name: str = Field(..., max_length=200)
    folder: str | None = Field(None, max_length=2000)  # None = next to the original
    timeline: bool = True
    library: bool = True
    results: bool = True


@app.post("/api/projects/copy")
async def projects_copy(req: ProjectCopy):
    """Duplicate a project: settings always, the timeline, library and results when asked."""
    p = _project_call(projects.copy, req.id, req.name, req.folder, timeline=req.timeline, library=req.library)
    p["results_copied"] = jobs.copy_items(req.id, p["id"]) if req.results else 0
    return p


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
    timestamp: bool = Field(False, description="add the date and time to the file name")
    burn_timecode: bool = Field(False, description="draw the timecode on the picture")


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


class MediaDelete(BaseModel):
    refs: list[str] = Field(..., min_length=1, max_length=2000)
    project: str = ""


@app.post("/api/media/delete")
async def media_delete(req: MediaDelete):
    """Delete media files: they go to the Recycle Bin. Results made from them leave the gallery,
    and the files leave the given project's library (other projects show them as missing)."""
    paths, refs, errors = [], [], []
    for ref in dict.fromkeys(req.refs):
        try:
            paths.append(media.resolve(ref)); refs.append(ref)
        except media.MediaError as exc:
            errors.append(str(exc))
    try:
        await asyncio.to_thread(media.recycle, paths)
    except media.MediaError as exc:
        raise HTTPException(400, str(exc)) from exc
    gone = {media.ref_of(p) for p in paths} | set(refs)
    results = [it["id"] for it in jobs.list() if any(f.get("path") in gone for f in it.get("files", []))]
    for item_id in results:
        jobs.delete(item_id, delete_files=False)  # the files are already in the Recycle Bin
    lib = None
    if req.project:
        try:
            ids = [m["id"] for m in projects.library(req.project)["media"] if m["ref"] in gone]
            lib = projects.remove_media(req.project, ids) if ids else projects.library(req.project)
        except projects.ProjectError:
            pass
    return {"deleted": len(paths), "results": len(results), "errors": errors, "lib": lib}


@app.get("/api/media/peaks")
async def media_peaks(path: str):
    """Sound levels of a file for waveform graphs (cached)."""
    async with _thumb_slots:
        try:
            return await asyncio.to_thread(media.peaks, path)
        except (media.MediaError, OSError, subprocess.SubprocessError) as exc:
            raise HTTPException(404, str(exc)) from exc


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


class DepthReq(BaseModel):
    project: str = "experiment"
    clip: str = Field(..., max_length=64)
    sig: str = Field("", max_length=200)


@app.post("/api/timeline/depth")
async def timeline_depth(req: DepthReq):
    """Analyse the depth of the picture under a camera move (Depth Anything 3, app/depth.py)."""
    from . import depth

    p = _project_call(projects.find, req.project)
    pf = _project_call(projects.load_file, p)
    c = next((x for x in pf.timeline.clips if x.id == req.clip and x.kind == "camera" and x.cam), None)
    if not c:
        raise HTTPException(404, "That camera move isn't in the saved timeline")
    try:
        return await depth.analyze(jobs, None if req.project == "experiment" else req.project, pf.timeline, c, req.sig)
    except (ValueError, media.MediaError) as exc:
        raise HTTPException(400, str(exc)) from exc


class ReshootReq(BaseModel):
    project: str = "experiment"
    clip: str = Field(..., max_length=64)
    prompt: str = Field("", max_length=4000)
    references: list[str] = Field(default_factory=list, max_length=6)
    guides: int = Field(3, ge=2, le=6)
    quality: Literal["draft", "standard", "full"] = "draft"
    seed: int = -1
    turbo: bool = True


@app.post("/api/timeline/reshoot")
async def timeline_reshoot(req: ReshootReq):
    """AI reshoot of a camera move: guide frames along the move, Klein fills what the move
    uncovers, H3 regenerates the shot (app/camera.py, workflows.build_reshoot)."""
    from . import camera

    p = _project_call(projects.find, req.project)
    pf = _project_call(projects.load_file, p)
    c = next((x for x in pf.timeline.clips if x.id == req.clip and x.kind == "camera" and x.cam), None)
    if not c:
        raise HTTPException(404, "That camera move isn't in the saved timeline")
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(400, "Describe the scene: the model uses it to fill in what the camera now sees")
    for ref in req.references:
        try:
            media_path(ref)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    try:
        prep = await asyncio.to_thread(camera.prepare_reshoot, pf.timeline, c, req.quality, req.guides)
    except (ValueError, RuntimeError, media.MediaError, subprocess.SubprocessError) as exc:
        raise HTTPException(400, str(exc)) from exc
    move = camera.describe(c.cam, prep["seconds"], c.trim_in)
    greq = GenerateRequest(
        kind="video", engine="reshoot", seconds=prep["seconds"], quality=req.quality, seed=req.seed, turbo=req.turbo,
        prompt=f"{prompt}\n\n{move} Keep the same people, action, lighting and place as in the guide pictures.",
        fill_prompt=("Fill only the empty black areas with a seamless, natural continuation of this scene, matching its "
                     f"perspective, lighting and style: {prompt} Keep everything else exactly as it is."),
        references=req.references, guides=prep["guides"], guide_masks=prep["masks"], guide_frames=prep["frames"],
        project=None if req.project == "experiment" else req.project, camera_clip=c.id,
    )
    try:
        items = await jobs.generate(greq)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    for it in items:
        jobs.log(it, f"Reshoot of a {prep['seconds']:.2f} s camera move at {prep['width']}×{prep['height']}: {move}")
        jobs.log(it, f"{len(prep['guides'])} guide frames at frames {', '.join(map(str, prep['frames']))}; Klein fills the uncovered areas, then H3 makes the video")
    return {"items": items, "clip": c.id, "start": c.start, "seconds": prep["seconds"]}


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
