"""Generation jobs: build a graph, submit it through comfy-sdk, stream progress, save outputs."""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import logging
import random
import re
import subprocess
import time
import urllib.parse
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from PIL import Image
from pydantic import BaseModel, Field

from . import config, imaging, media, models, motion, workflows
from .comfy import ComfyService

log = logging.getLogger("bob.jobs")

Kind = Literal["video", "image", "audio"]
Engine = Literal["h3", "h3ref", "klein", "krea2", "h3image", "moss", "mossedit", "music3", "reshoot", "enhance", "angles", "imgedit", "motion", "retake"]
EditOp = Literal["erase", "replace", "prompt", "instruct", "remove_bg", "adjust"]


class LoraUse(BaseModel):
    name: str = Field(..., max_length=500)  # as ComfyUI lists it (models/loras)
    strength: float = Field(1.0, ge=-10, le=10)


class EnhanceOpts(BaseModel):
    """The enhance chain (workflows.build_enhance): FaceRefine -> DLSS 5 -> an upscaler."""
    facerefine: bool = False
    face_strength: float = Field(0.3, ge=0.05, le=1.0)  # 0.30: FaceRefine-Plus v0.2.0's default (0.15 changed too little on small faces)
    face_steps: int = Field(20, ge=4, le=50)
    # How the refined faces go back into the frame. "plus" = ComfyUI-H3-FaceRefine-Plus (Stitch Plus freq_sep,
    # Flow Lock, Tone Match) when that pack is installed, else the stock H3 Face Stitch; "stock" = always the stock one.
    face_finish: Literal["plus", "stock"] = "plus"
    face_lipfix: bool = True  # Tone Match's lip pass (Plus finish only)
    dlss: bool = False
    dlss_mode: Literal["1x", "1.5x", "1.724x", "2x", "3x"] = "1x"
    dlss_style: Literal["Default", "Natural", "Cinematic"] = "Default"
    dlss_intensity: float = Field(1.0, ge=0, le=2)
    upscaler: Literal["none", "seedvr2", "relayvsr"] = "none"
    seedvr2_model: str | None = Field(None, max_length=200)
    seedvr2_res: int = Field(1080, ge=256, le=4320)
    relay_detail: float = Field(0.45, ge=0, le=1)


# Live preview (ComfyUI's per-prompt extra_data.preview_method; app/proxy_launch.py lets it through the proxy):
# fast = latent-to-RGB colour projection (no measurable cost). Not "taesd": ComfyUI 0.44 can't load the taeh3 tiny
# decoder (its VAE() leaves first_stage_model None) and the whole sampler fails.
PREVIEW_METHODS = {"off": None, "fast": "latent2rgb"}


async def submit_job(client: Any, wf: Any, preview_method: str | None) -> Any:
    """client.submit(wf), with ComfyUI's preview method for this prompt when asked. The SDK has no way to add
    extra_data, so this does what its submit does (materialize, post_jobs) with it. A proxy that refuses the
    field (one not started by app/proxy_launch.py) gets the job again without it."""
    if not preview_method:
        return await client.submit(wf)
    from comfy_sdk import _core
    from comfy_sdk.client import AsyncJob
    from comfy_sdk.exceptions import to_sdk_error
    from comfy_low.errors import ApiError

    graph = await client._materialize(wf)
    try:
        model = await client._low.post_jobs(graph, idempotency_key=_core.new_idempotency_key(), extra_data={"preview_method": preview_method})
        return AsyncJob(client._low, model)
    except ApiError as exc:
        if "extra_data" not in str(exc) and "extra_data" not in str(to_sdk_error(exc)):
            raise to_sdk_error(exc) from exc
        log.warning("the ComfyUI API proxy refused the live-preview setting; restart the studio to restart the proxy")
        return await client.submit(wf)


class MotionLayer(BaseModel):
    mask: str = Field(..., max_length=2000)  # white = the object, on the first frame
    # one entry per frame: [dx, dy, scale, flip, rotation, flip upside down] (dx, dy: the object's move as a share of
    # the picture's width and height; rotation in degrees, clockwise; the last two may be left out)
    frames: list[list[float]] = Field(..., min_length=1, max_length=400)
    adjust: dict[str, float] | None = None  # the object's colour: hue (degrees), sat and bri (factors)


class LayoutBox(BaseModel):
    """A MOSS-Image layout box, as fractions of the canvas; drawn background first."""
    x: float = Field(..., ge=0, le=1)
    y: float = Field(..., ge=0, le=1)
    w: float = Field(..., gt=0, le=1)
    h: float = Field(..., gt=0, le=1)
    type: Literal["text", "object", "character"] = "object"
    text: str = Field("", max_length=1000)  # text boxes: the exact words to draw
    desc: str = Field("", max_length=4000)


class GenerateRequest(BaseModel):
    kind: Kind
    engine: Engine = "h3"
    prompt: str = Field("", max_length=20000)
    aspect: str = "16:9"
    quality: str = "draft"
    seconds: float = Field(5.0, ge=0.5, le=300)
    seed: int = -1
    turbo: bool = True
    steps: int | None = Field(None, ge=1, le=100)
    first_frame: str | None = None  # media ref: "data/uploads/<file>" or "outputs/<date>/<file>"
    last_frame: str | None = None
    references: list[str] = Field(default_factory=list, max_length=9)  # H3 reference-to-video pictures
    ref_audios: list[str] = Field(default_factory=list, max_length=3)  # H3 reference sounds: voices to clone (<Audio N>)
    loras: list[LoraUse] = Field(default_factory=list, max_length=8)  # LoRAs on the model, in order
    unet: str | None = Field(None, max_length=500)  # a diffusion model to use instead of the engine's default
    # The Model step's sampler and scheduler (None = the engine's own, workflows.SAMPLING_DEFAULTS).
    sampler: str | None = Field(None, max_length=80)
    scheduler: str | None = Field(None, max_length=80)
    cfg: float | None = Field(None, ge=0.0, le=30.0)  # None = the engine's own (workflows.CFG_DEFAULTS)
    # Image editor (engine "imgedit", static/editor.js): the op, the selection mask (a media ref,
    # white = selected), how much the prompt op may change, and remove_bg's new background.
    edit_op: EditOp | None = None
    edit_mask: str | None = Field(None, max_length=2000)
    edit_strength: float = Field(0.75, ge=0.05, le=1.0)
    edit_bg: Literal["transparent", "white", "black"] = "transparent"
    # Model for erase, replace and instruct: Qwen Image Edit 2511 or MiniMax H3 Image.
    edit_model: Literal["qwen", "h3image", "mossedit"] = "qwen"
    # Instruct: the size the edit model works at and returns, in megapixels, with the source's shape (a 3D scene's
    # photo for an H3 Image shot follows the Quality setting). None: the model's own size, returned at the source's size.
    edit_megapixels: float | None = Field(None, ge=0.25, le=16.0)
    source: str | None = Field(None, max_length=2000)  # enhance: the picture or video to improve (a media ref)
    enhance_opts: EnhanceOpts | None = None  # engine "enhance": the chain
    enhance_of: str | None = Field(None, max_length=64)  # enhance: the studio item it came from
    enhance_after: dict[str, Any] | None = None  # set by the page: enhance this result when it's done (Settings)
    # a scene render: enhance its final take (EnhanceOpts) once it has settled: its words checked, its lips redrawn
    # and any sound retake done; the take with the best words is the one enhanced
    enhance_final: dict[str, Any] | None = None
    pose: str | None = Field(None, max_length=200)  # angles: "<azimuth> <elevation> <distance>" (workflows.ANGLE_*)
    white_bg: bool = False  # angles: make the plain backdrop pure white (imaging.whiten_backdrop)
    clean_audio: bool = True  # clean them and keep the best 6-10 s of speech (H3RefAudioPrep, when installed)
    quiet_extra: bool = True  # after a video with lines: silence the stretches of its sound that aren't them (app/heard.py)
    # ...and then draw its picture again to that sound, so the lips move only for the lines (a scene render, when
    # ComfyUI-H3-NativeAudioLock is installed)
    resync_after_quiet: bool = True
    # a scene render whose lines are heard under this score (%) gets its sound retaken once, its picture kept (0: never;
    # None: Settings > Generation's)
    auto_retake_below: int | None = Field(None, ge=0, le=100)
    retake_of: str | None = Field(None, max_length=40)  # a retake made by itself: the render whose sound it makes again
    lock_audio: str | None = Field(None, max_length=2000)  # a scene render: keep this sound exactly, sample the picture only
    relock_of: str | None = Field(None, max_length=40)  # that render's id: its picture is replaced by this one's when done
    preview: Literal["off", "fast"] = "off"  # live preview while sampling (Settings > Advanced)
    max_fidelity: bool = False  # reference pictures at 2048px instead of the output's size
    # H3 Reference: continue this video without a cut (its last `overlap` frames and sound are kept and carried on;
    # the result is only what comes after them). Needs ComfyUI-NKD-Basic-Tools (NKDAVLatentExtend).
    continue_from: str | None = Field(None, max_length=2000)
    # Retake (engine "retake"): the sound of `source` (a video) made again from the prompt, its picture kept. The
    # stretches to redo in seconds ("1.2-3.4, 5-6"); empty = all of it.
    retake_ranges: str = Field("", max_length=300)
    retake_keep_bg: bool = False  # keep the original's music and sounds; only the voice is new (MelBand RoFormer)
    overlap: Literal[22, 39, 56] = 39
    # Motion layers (engine "motion", app/motion.py): first_frame is the picture, motion_plate the picture with the
    # objects erased, and each layer an object's mask with its place in every frame.
    motion_plate: str | None = Field(None, max_length=2000)
    motion_layers: list[MotionLayer] = Field(default_factory=list, max_length=6)
    motion_hold: Literal["loose", "normal", "tight"] = "normal"
    motion_edge: int = Field(-1, ge=-1, le=64)  # -1 = automatic
    # "composite": start H3 from the rough animation's first frame instead of the picture (an object changed at the
    # start: moved, sized, turned, flipped, recoloured or partly erased)
    motion_first: Literal["picture", "composite"] = "picture"
    # Or a rough animation drawn elsewhere (a 3D scene, scene3d.js) with its mask (white = follow it), in place of the
    # plate and layers; both are conformed to the render's size and length here.
    motion_video: str | None = Field(None, max_length=2000)
    motion_video_mask: str | None = Field(None, max_length=2000)
    # how H3 follows a 3D scene's rough animation: held to it (Time-to-Move), or shown it as <Video 1> on H3 Reference
    motion_guide: Literal["ttm", "reference"] = "ttm"
    # the 3D scene's people as an OpenPose skeleton video (drawn in the page, as the rough animation): with the
    # reference guide it goes to H3 Reference as <Video 2>, which they're told to move as
    motion_pose_video: str | None = Field(None, max_length=2000)
    # how hard the skeleton steers the people through the H3 Fun ControlNet, when it's installed (0 = not at all)
    motion_pose_strength: float = Field(1.0, ge=0, le=2)
    # a render longer than H3's window (about 15 s) is made in parts (workflows.long_plan): each part's prompt, written
    # by the page for its stretch of the shot (empty: every part gets `prompt`)
    long_prompts: list[str] = Field(default_factory=list, max_length=8)
    enhance: bool = False  # Klein prompt upsampler / Krea 2 prompt expander
    layout: list[LayoutBox] | None = Field(None, max_length=60)  # MOSS-Image layout control
    clean_texture: bool = True  # H3 Image: EasyFix steering + re-noise, when ComfyUI-H3-Image-EasyFix is installed
    lyrics: str = Field("", max_length=20000)  # Music 3
    batch: int = Field(1, ge=1, le=4)  # number of takes (seeds seed, seed+1, ...)
    project: str | None = Field(None, max_length=64)  # project id; None = Experiment
    # the 3D scene it's for (its photos, fills, renders): saved in its folder, bob/<Project>/scenes/<Scene>/
    scene: str | None = Field(None, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    # AI reshoot (camera moves): guide frames + masks of the uncovered areas, and where they sit
    guides: list[str] = Field(default_factory=list, max_length=8)
    guide_masks: list[str] = Field(default_factory=list, max_length=8)
    guide_frames: list[int] = Field(default_factory=list, max_length=8)
    fill_prompt: str = Field("", max_length=8000)
    camera_clip: str | None = Field(None, max_length=64)


WORKFLOW_DIR = config.DATA_DIR / "workflows"


def save_workflow(item_id: str, graph: dict[str, Any]) -> None:
    """Keep the exact ComfyUI graph (API format) a result was made with: data/workflows/<id>.json."""
    try:
        WORKFLOW_DIR.mkdir(parents=True, exist_ok=True)
        (WORKFLOW_DIR / f"{item_id}.json").write_text(json.dumps(graph, indent=2), "utf-8")
    except OSError:
        pass  # a missing copy must never fail the job


class JobManager:
    def __init__(self, comfy: ComfyService) -> None:
        self.comfy = comfy
        self.items: dict[str, dict[str, Any]] = {}
        self._handles: dict[str, Any] = {}  # item id -> AsyncJob
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._enhancing: set[tuple[str, str]] = set()  # enhance requests being set up (see enhance_item)
        self._load()

    # ------------------------------------------------------------------ persistence
    def _load(self) -> None:
        if config.HISTORY_FILE.exists():
            try:
                for item in json.loads(config.HISTORY_FILE.read_text("utf-8")):
                    if item.get("status") in ("queued", "running", "submitting"):
                        item["status"] = "failed"
                        item["error"] = "Interrupted: the studio restarted while this was running."
                    self.items[item["id"]] = item
            except (OSError, ValueError):
                log.exception("could not read history; starting empty")

    def _save(self) -> None:
        tmp = config.HISTORY_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(list(self.items.values()), indent=1), "utf-8")
        # On Windows the swap fails while another program has history.json open for a moment (antivirus, a backup,
        # a script reading it): try again for up to about two seconds before giving up.
        for attempt in range(20):
            try:
                tmp.replace(config.HISTORY_FILE)
                return
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.1)

    # ------------------------------------------------------------------ pub/sub
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def _publish(self, event: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    async def _enhance_check(self, req: GenerateRequest, installed: dict[str, list[str]]) -> None:
        """The enhance steps need their custom nodes and models; say which is missing."""
        e = req.enhance_opts
        need = []
        if e.facerefine:
            need += ["H3FaceTrackCrop", "H3FaceStitch", "H3PerFrameDenoise", "H3InjectVideoLatent", "MiniMaxH3NativeAudioLock"]
        if e.dlss:
            need += ["DLSS5EnhanceImages", "DLSS5Settings"]
        if e.upscaler == "seedvr2":
            need += ["SeedVR2VideoUpscaler", "SeedVR2LoadDiTModel", "SeedVR2LoadVAEModel"]
            have = await self.seedvr2_files()
            if "ema_vae_fp16.safetensors" not in have:
                raise ValueError("SeedVR2's VAE (ema_vae_fp16.safetensors) isn't in models/SEEDVR2")
            if not e.seedvr2_model:
                e.seedvr2_model = next((m for m in have if m.startswith("seedvr2_ema_3b") and "fp8" in m), None) or                     next((m for m in have if m.startswith("seedvr2_ema_")), None)
            if not e.seedvr2_model or e.seedvr2_model not in have:
                # the loader would download a missing model (gigabytes) instead of failing
                raise ValueError(f"SeedVR2 model {e.seedvr2_model or '(none)'} isn't installed in models/SEEDVR2; "
                                 f"installed: {', '.join(m for m in have if m.startswith('seedvr2_ema_')) or 'none'}")
        if e.upscaler == "relayvsr":
            need += ["RelayVSRConditioning", "VSRDecode"]
            if not any("relayvsr" in n.lower() for n in installed.get("diffusion_models", [])) or \
               not any("relayvsr" in n.lower() for n in installed.get("vae", [])):
                raise ValueError("RelayVSR needs relayvsr_x2_*.safetensors (diffusion_models) and relayvsr_flash_vae_x2_*.safetensors (vae)")
        missing = [n for n in need if not self.has_node(n)]
        if missing:
            raise ValueError(f"ComfyUI is missing these nodes: {', '.join(missing)}")

    async def seedvr2_files(self) -> list[str]:
        """SeedVR2 model files on disk (ComfyUI's models/SEEDVR2 folders)."""
        try:
            r = await self.comfy.http.get(f"{config.COMFYUI_URL}/models/seedvr2", timeout=10.0)
            return [n for n in r.json() if not n.endswith((".json", ".download", ".tmp", ".part"))] if r.status_code == 200 else []
        except Exception:  # noqa: BLE001
            return []

    _nodes: set[str] | None = None

    def has_node(self, name: str) -> bool:
        """Whether ComfyUI has a node type (custom nodes differ between installs); cached."""
        if JobManager._nodes is None:
            try:
                import urllib.request
                with urllib.request.urlopen(f"{config.COMFYUI_URL}/object_info/{name}", timeout=20) as r:
                    return name in json.loads(r.read())
            except (OSError, ValueError):
                return False
        return name in JobManager._nodes

    def log(self, item: dict[str, Any], msg: str, level: str = "info") -> None:
        """Add a line to an item's activity log (shown in the Activity console) and stream it."""
        entry = {"t": time.time(), "msg": str(msg)[:600], "level": level}
        lines = item.setdefault("log", [])
        lines.append(entry)
        if len(lines) > 300:
            del lines[:-300]
        self._publish({"type": "log", "id": item["id"], **entry})

    def _update(self, item: dict[str, Any], **changes: Any) -> None:
        item.update(changes)
        self._save()
        self._publish({"type": "item", "item": item})

    # ------------------------------------------------------------------ public API
    def project_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for it in self.items.values():
            if it.get("project"):
                counts[it["project"]] = counts.get(it["project"], 0) + 1
        return counts

    def list(self) -> list[dict[str, Any]]:
        return sorted(self.items.values(), key=lambda i: i["created"], reverse=True)

    def delete(self, item_id: str, delete_files: bool = False) -> bool:
        item = self.items.pop(item_id, None)
        if not item:
            return False
        (WORKFLOW_DIR / f"{item_id}.json").unlink(missing_ok=True)
        if delete_files:
            # A copied project's results share their files: keep any another result still uses.
            used = {f.get("path") for other in self.items.values() for f in other.get("files", [])}
            for f in item.get("files", []):
                p = config.ROOT / f["path"]
                if f["path"] not in used and p.is_file() and config.OUTPUT_DIR in p.resolve().parents:
                    p.unlink()
        self._save()
        self._publish({"type": "deleted", "id": item_id})
        return True

    # ------------------------------------------------------------------ enhance
    async def enhance_ref(self, ref: str, opts: EnhanceOpts, *, seed: int = -1, project: str | None = None,
                          params: dict[str, Any] | None = None, of: str | None = None) -> list[dict[str, Any]]:
        """Enhance a picture or video (FaceRefine -> DLSS 5 -> SeedVR2 or RelayVSR). params: the
        generation it came from (FaceRefine re-uses its prompt, references, sounds and LoRAs)."""
        params = params or {}
        kind = media.kind_of(ref)
        if kind not in ("image", "video"):
            raise ValueError("Enhance works on pictures and videos")
        if opts.facerefine and params.get("engine") not in ("h3", "h3ref"):
            raise ValueError("FaceRefine re-samples faces with H3, so it needs a video made with H3 or H3 Reference here")
        return await self.generate(GenerateRequest(
            kind=kind, engine="enhance", prompt=params.get("prompt") or "", seed=seed,
            references=params.get("references") or [], ref_audios=params.get("ref_audios") or [], clean_audio=params.get("clean_audio", True),
            loras=params.get("loras") or [], source=ref, enhance_opts=opts, enhance_of=of, project=project,
        ))

    async def enhance_item(self, it: dict[str, Any], opts: EnhanceOpts, *, seed: int = -1) -> list[dict[str, Any]]:
        # The same enhance of the same result asked for again within two minutes (a second open
        # page, an old page that still auto-enhances, a double click) gets the one already made.
        want = opts.model_dump()

        def same(had: dict[str, Any] | None) -> bool:  # an empty SeedVR2 model means "the default", filled in later
            if not had:
                return False
            a, b = dict(had), dict(want)
            if not a.get("seedvr2_model") or not b.get("seedvr2_model"):
                a.pop("seedvr2_model", None)
                b.pop("seedvr2_model", None)
            return a == b

        for other in self.items.values():
            p = other.get("params") or {}
            if (other.get("engine") == "enhance" and p.get("enhance_of") == it["id"] and same(p.get("enhance_opts"))
                    and other.get("status") not in ("failed", "cancelled", "interrupted") and time.time() - other["created"] < 120):
                return [other]
        key = (it["id"], json.dumps({k: v for k, v in want.items() if k != "seedvr2_model"}, sort_keys=True))
        if key in self._enhancing:  # the same request is being set up right now
            return []
        self._enhancing.add(key)
        try:
            f = next((x for x in it["files"] if (x.get("content_type") or "").split("/")[0] in ("video", "image")), it["files"][0])
            return await self.enhance_ref(f["path"], opts, seed=seed, project=it.get("project"), params=it.get("params") or {}, of=it["id"])
        finally:
            self._enhancing.discard(key)

    async def _retake_mux(self, item: dict[str, Any], req: "GenerateRequest", saved: list[dict[str, Any]],
                          info: dict[str, Any]) -> list[dict[str, Any]]:
        """A retake's new sound under the original picture (media.retake_mux): the video replaces the sound file."""
        sound = config.ROOT / saved[0]["path"]
        target = sound.with_name(f"{item['id']}_retake.mp4")
        if info.get("keep_background") and len(saved) > 1:  # the new voice over the original's background
            bed = config.ROOT / saved[1]["path"]
            mixed = sound.with_name(f"{item['id']}_retake_mix.flac")
            await asyncio.to_thread(media.mix_audio, sound, bed, mixed)
            sound.unlink(missing_ok=True)
            bed.unlink(missing_ok=True)
            sound = mixed
            self.log(item, "Kept the original's music and sounds under the new voice (MelBand RoFormer)")
        ranges = [tuple(r) for r in info.get("ranges") or []]
        await asyncio.to_thread(media.retake_mux, req.source, sound, ranges, target)
        sound.unlink(missing_ok=True)
        (config.UPLOAD_DIR / f"{item['id']}_retake_src.mp4").unlink(missing_ok=True)
        rel = target.relative_to(config.ROOT).as_posix()
        self.log(item, "Put the new sound under the original picture" + (" (the rest of the sound is the original's)" if ranges else ""))
        return [{"name": target.name, "path": rel, "url": "/" + rel, "content_type": "video/mp4", "size": target.stat().st_size}]

    async def hear(self, item: dict[str, Any]) -> dict[str, Any]:
        """Whisper hears a finished video's words and scores them against its lines (app/heard.py): item["heard"]."""
        from . import heard

        if not self.has_node(heard.NODE):
            raise heard.HeardError("Checking the words needs the crt-nodes pack in ComfyUI (its CRT_AudioTranscriptBatch node)")
        res = await heard.check(item, media_path, say=lambda m: self.log(item, m))
        self._update(item, heard=res)
        if res.get("extra") and (item.get("params") or {}).get("quiet_extra", True) and not item.get("quieted"):
            res = await self.quiet(item, res) or res
        return res

    async def quiet(self, item: dict[str, Any], res: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """Silence the stretches of a video's sound that aren't its lines (app/heard.py quiet_extra), then hear it
        again. -> the new item["heard"], or None when there was nothing it could take out."""
        from . import heard

        f = next((x for x in item.get("files", []) if (x.get("content_type") or "").startswith("video")), None)
        lines, lang = heard.lines_of((item.get("params") or {}).get("prompt", ""))
        if not f or not lines:
            raise heard.HeardError("It has no video with spoken lines")
        path = media_path(f["path"])
        q = await heard.quiet_extra(path, " ".join(lines), lang, say=lambda m: self.log(item, m))
        if not q:
            self.log(item, "The extra words run into the lines without a pause: nothing could be silenced on its own")
            return None
        files = [dict(x, size=path.stat().st_size) if x is f else x for x in item["files"]]
        self._update(item, files=files, quieted=q)
        res = await heard.check(item, media_path, say=lambda m: self.log(item, m))
        self._update(item, heard=res)
        p = item.get("params") or {}
        long = ((item.get("info") or {}).get("parts") or 1) > 1  # a long render: no one window holds all of it
        if p.get("engine") == "motion" and p.get("resync_after_quiet", True) and not long and self.has_node("MiniMaxH3NativeAudioLock"):
            try:
                await self.resync(item)
            except Exception as exc:  # noqa: BLE001 - the silenced video stands
                self.log(item, f"Couldn't redraw the picture to the cleaned sound: {exc}", "warn")
        return res

    async def resync(self, item: dict[str, Any]) -> dict[str, Any]:
        """Draw a scene render's picture again with its (cleaned) sound held exactly, so the lips follow that sound:
        the same request and seed, with lock_audio. When it's done its picture replaces this one's (_on_resynced)."""
        f = next((x for x in item.get("files", []) if (x.get("content_type") or "").startswith("video")), None)
        if not f:
            raise ValueError("It has no video")
        sound = config.UPLOAD_DIR / f"{item['id']}_held_sound.wav"
        r = await asyncio.to_thread(subprocess.run, [media.ffmpeg(), "-nostdin", "-v", "error", "-y", "-i", str(media_path(f["path"])),
                                                     "-vn", "-ac", "1", "-ar", "48000", str(sound)],
                                    capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=media.NO_WINDOW)
        if r.returncode or not sound.is_file():
            raise ValueError(r.stderr.strip()[-200:] or "no sound")
        params = {k: v for k, v in (item.get("params") or {}).items() if k in GenerateRequest.model_fields}
        params.update(lock_audio=sound.relative_to(config.ROOT).as_posix(), relock_of=item["id"], quiet_extra=False,
                      seed=item.get("seed", -1), batch=1)
        new = (await self.generate(GenerateRequest(**params)))[0]
        self.log(item, f"Drawing the picture again to the cleaned sound, so the lips move only for the lines ({new['id']})")
        self._update(item, resync={"by": new["id"], "status": "running", "at": time.time()})
        return new

    async def _on_resynced(self, helper: dict[str, Any], saved: list[dict[str, Any]]) -> None:
        """The lip-synced picture is done: it replaces the original render's video (kept as <name>_unsynced.mp4) and
        the helper result goes."""
        import shutil

        orig = self.items.get((helper.get("params") or {}).get("relock_of") or "")
        new = next((x for x in saved if (x.get("content_type") or "").startswith("video")), None)
        f = orig and next((x for x in orig.get("files", []) if (x.get("content_type") or "").startswith("video")), None)
        if not (orig and new and f):
            return
        dst, src = media_path(f["path"]), media_path(new["path"])
        keep = dst.with_name(f"{dst.stem}_unsynced{dst.suffix}")
        if not keep.exists():
            dst.replace(keep)
        shutil.copyfile(src, dst)
        self._update(orig, files=[dict(x, size=dst.stat().st_size) if x is f else x for x in orig["files"]],
                     resync={"by": helper["id"], "status": "done", "at": time.time(),
                             "unsynced": keep.relative_to(config.ROOT).as_posix() if keep.is_relative_to(config.ROOT) else str(keep)})
        self.log(orig, f"Lips redrawn to the cleaned sound ({helper['id']}); the version before is {keep.name}")
        src.unlink(missing_ok=True)
        self.delete(helper["id"])
        if not await self._maybe_retake(orig):
            await self._enhance_final(orig)

    async def _enhance_final(self, item: dict[str, Any]) -> None:
        """A scene render asked to enhance its final take (enhance_final): once nothing more is coming (its retake, if
        any, finished or failed), the take with the best words, it or its retake, is enhanced. Once."""
        p = item.get("params") or {}
        if not p.get("enhance_final") or item.get("final_enhance") or item.get("status") != "done":
            return
        best, rid = item, (item.get("auto_retake") or {}).get("by")
        r = rid and self.items.get(rid)
        if r and r.get("status") in ("queued", "running"):
            return  # when the retake is done (or fails)
        if r and r.get("status") == "done" and r.get("files") and ((r.get("heard") or {}).get("score") or -1) > ((item.get("heard") or {}).get("score") or -1):
            best = r
        try:
            opts = EnhanceOpts.model_validate(p["enhance_final"])
            if best.get("engine") == "retake" or p.get("engine") not in ("h3", "h3ref"):
                opts.facerefine = False  # FaceRefine re-samples with H3's own settings: H3 and H3 Reference only
            if not (opts.facerefine or opts.dlss or opts.upscaler != "none"):
                return
            self._update(item, final_enhance={"status": "starting", "of": best["id"], "at": time.time()})
            made = await self.enhance_item(best, opts)
            self._update(item, final_enhance={"status": "queued", "of": best["id"], "by": made[0]["id"] if made else None, "at": time.time()})
            self.log(item, f"Enhancing the final take ({'the sound retake' if best is not item else 'this one'}): {', '.join(x['id'] for x in made)}")
        except Exception as exc:  # noqa: BLE001 - the takes stand as they are
            self._update(item, final_enhance={"status": "failed", "error": _short_error(exc)[:300], "at": time.time()})
            self.log(item, f"Couldn't enhance the final take: {_short_error(exc)}", "warn")

    async def _maybe_retake(self, item: dict[str, Any]) -> dict[str, Any] | None:
        """A scene render whose lines came out under its auto_retake_below score: its sound made again once (engine
        "retake", the picture kept frame for frame), tagged retake_of so the page puts it beside it as another take;
        the take with the best words is the one used. -> the new item, or None."""
        p, res = item.get("params") or {}, item.get("heard") or {}
        from . import appsettings

        b = p.get("auto_retake_below")
        below, score = int(appsettings.get().generation.retake_below if b is None else b), res.get("score")
        if p.get("engine") != "motion" or not below or score is None or score >= below or item.get("auto_retake"):
            return None
        if ((item.get("info") or {}).get("parts") or 1) > 1:
            self.log(item, f"Words {score}% (under {below}%), but a retake makes up to {workflows.RETAKE_MAX_FRAMES / 24:.0f} s: "
                     "this long render keeps its sound")
            return None
        f = next((x for x in item.get("files", []) if (x.get("content_type") or "").startswith("video")), None)
        if not f:
            return None
        params = {k: v for k, v in p.items() if k in GenerateRequest.model_fields}
        params.update(engine="retake", kind="video", source=f["path"], retake_ranges="", seed=-1, batch=1, retake_of=item["id"],
                      retake_keep_bg=all(self.has_node(n) for n in workflows.ROFORMER_NODES), auto_retake_below=0,
                      first_frame=None, last_frame=None, continue_from=None, enhance_after=None, motion_video=None,
                      motion_video_mask=None, motion_layers=[], lock_audio=None, relock_of=None, enhance_final=None)
        self._update(item, auto_retake={"status": "starting", "at": time.time()})
        try:
            new = (await self.generate(GenerateRequest(**params)))[0]
        except Exception as exc:  # noqa: BLE001 - the render stands as it is
            self._update(item, auto_retake={"status": "failed", "error": str(exc)[:300], "at": time.time()})
            self.log(item, f"Words {score}% (under {below}%), but the sound couldn't be retaken: {exc}", "warn")
            await self._enhance_final(item)
            return None
        self._update(item, auto_retake={"by": new["id"], "status": "queued", "at": time.time()})
        self.log(item, f"Words {score}% (under {below}%): retaking the sound once, the picture kept ({new['id']})")
        return new

    async def _hear_after(self, item: dict[str, Any]) -> None:
        """A video with spoken lines is heard once it's done, so its takes can be ranked by their words."""
        try:
            await self.hear(item)
        except Exception as exc:  # noqa: BLE001 - a failed check mustn't touch the finished render
            self.log(item, f"Checking the words: {exc}", "warn")
        await self._settled(item)

    async def _settled(self, item: dict[str, Any]) -> None:
        """After a video's words check: a scene render may want its sound retaken, then its final take enhanced; a
        retake that's done (or failed) lets its render's final take be enhanced."""
        of = (item.get("params") or {}).get("retake_of")
        if of and self.items.get(of):
            return await self._enhance_final(self.items[of])
        if (item.get("resync") or {}).get("status") == "running":
            return  # once the lips are redrawn (_on_resynced)
        if item.get("heard") is None or not await self._maybe_retake(item):
            await self._enhance_final(item)

    async def _enhance_after(self, item: dict[str, Any]) -> None:
        """Settings > After generating (or Angles' "Enhance each"): the result asked to be enhanced
        when done. Runs here, once, so it doesn't depend on a page being open (or on how many are)."""
        params = item.get("params") or {}
        try:
            opts = EnhanceOpts.model_validate(params["enhance_after"])
        except (ValueError, TypeError) as exc:
            self.log(item, f"Not enhancing afterwards: {exc}", "warn")
            return
        if item["kind"] != "video":
            opts.facerefine = False
            if opts.upscaler == "relayvsr":
                opts.upscaler = "none"
        if opts.facerefine and params.get("engine") not in ("h3", "h3ref"):
            opts.facerefine = False
        if not (opts.facerefine or opts.dlss or opts.upscaler != "none"):
            return
        try:
            made = await self.enhance_item(item, opts)
            self.log(item, f"Enhancing afterwards: {', '.join(x['id'] for x in made)}")
        except Exception as exc:  # noqa: BLE001 - never let this break the finished result
            self.log(item, f"Couldn't enhance afterwards: {_short_error(exc)}", "warn")

    def copy_items(self, src_project: str, dst_project: str) -> int:
        """Give a copied project its own copy of the source's finished results (same files)."""
        n = 0
        src = None if src_project == "experiment" else src_project  # Experiment's results have no project
        for item in sorted(list(self.items.values()), key=lambda i: i["created"]):
            if (item.get("project") or None) != src or item.get("status") != "done":
                continue
            new = copy.deepcopy(item)
            new.update(id=uuid.uuid4().hex[:12], project=dst_project, copied_from=item["id"])
            self.items[new["id"]] = new
            self._publish({"type": "item", "item": new})
            n += 1
        if n:
            self._save()
        return n

    async def cancel(self, item_id: str) -> bool:
        handle = self._handles.get(item_id)
        if not handle:
            return False
        try:
            await handle.cancel()
        except Exception as exc:  # AlreadyCompleted / CancelRefused
            log.info("cancel %s: %s", item_id, exc)
            return False
        return True

    async def generate(self, req: GenerateRequest) -> list[dict[str, Any]]:
        installed = await self.comfy.installed_models()
        if req.engine == "enhance":
            sets = [models.ALL_SETS["h3ref"]] if req.enhance_opts and req.enhance_opts.facerefine else []
        elif req.engine == "imgedit":
            edit_set = {"h3image": models.H3_IMAGE, "mossedit": models.MOSS_EDIT_EDITOR}.get(req.edit_model, models.QWEN_EDIT)
            sets = ([] if req.edit_op == "remove_bg" else [edit_set] if req.edit_op in ("erase", "replace", "instruct")
                    else [models.ALL_SETS["krea2"]])
        else:
            sets = ([models.ALL_SETS["h3"], models.ALL_SETS["klein"]] if req.engine == "reshoot"
                    # a 3D scene with object pictures renders on H3 Reference (workflows.build_motion)
                    else [models.ALL_SETS["h3ref" if req.references or req.ref_audios or req.motion_guide == "reference" or self.is_long(req) else "h3"]] if req.engine == "motion"
                    else [models.ALL_SETS["h3ref"]] if req.engine == "retake"
                    else [models.ALL_SETS[req.engine]])
        files: dict[str, Any] = {}
        for mset in sets:
            resolved = models.resolve(mset, installed)
            if not resolved["ready"]:
                names = ", ".join(m["want"] for m in resolved["missing"])
                raise ValueError(f"{mset.title} is missing model files: {names}")
            files[mset.key] = resolved["files"]
        if req.engine == "retake" and req.retake_keep_bg:  # MelBand RoFormer's model, for keeping the background
            names = installed.get("diffusion_models", [])
            pick = (next((n for n in names if re.search(r"melband.*fp16", n, re.I)), None)
                    or next((n for n in names if re.search(r"melband", n, re.I)), None))
            if not pick:
                raise ValueError("Keeping the background needs a MelBand RoFormer model (e.g. MelBandRoformer_fp16.safetensors) "
                                 "in ComfyUI's models/diffusion_models")
            files["h3ref"] = {**files["h3ref"], "melband": pick}
        if req.engine == "enhance":
            await self._enhance_check(req, installed)
            files["relay"] = {"unet": next((n for n in installed.get("diffusion_models", []) if "relayvsr" in n.lower()), ""),
                              "vae": next((n for n in installed.get("vae", []) if "relayvsr" in n.lower()), "")}
            resolved = {"files": files}
        else:
            resolved = {"files": files if req.engine == "reshoot" else files[sets[0].key] if sets else {}}
            if req.engine == "imgedit" and req.edit_op == "remove_bg":
                bg = sorted(installed.get("background_removal", []), key=lambda n: ("birefnet" not in n.lower(), n.lower()))
                resolved["files"] = {"bg_model": bg[0] if bg else None}
            if req.unet and sets and req.engine != "reshoot":
                # The user's own pick from the Model step's "Diffusion model" list.
                known = {n.replace("\\", "/").lower(): n for n in installed.get("diffusion_models", [])}
                pick = known.get(req.unet.replace("\\", "/").lower())
                if not pick:
                    raise ValueError(f"Diffusion model not found in ComfyUI: {req.unet}")
                if "unet" not in resolved["files"]:
                    raise ValueError(f"{sets[0].title} has no diffusion model to replace")
                resolved = {"files": {**resolved["files"], "unet": pick}}
                req.unet = pick
        self._validate(req)
        if req.engine == "h3image" and req.clean_texture:  # only with ComfyUI-H3-Image-EasyFix installed
            try:
                req.clean_texture = workflows.EASYFIX_NODES <= await self.comfy.node_types()
            except Exception:  # noqa: BLE001
                req.clean_texture = False
        if req.engine not in workflows.SAMPLING_DEFAULTS:
            req.cfg = None
        if req.sampler or req.scheduler:
            if req.engine not in workflows.SAMPLING_DEFAULTS:
                req.sampler = req.scheduler = req.cfg = None  # editor, enhance, angles…: their own tuned sampling
            else:
                await self.comfy.node_types()
                if req.sampler and self.comfy.samplers and req.sampler not in self.comfy.samplers:
                    raise ValueError(f"ComfyUI has no sampler named {req.sampler}")
                if req.scheduler and self.comfy.schedulers and req.scheduler not in self.comfy.schedulers:
                    raise ValueError(f"ComfyUI has no scheduler named {req.scheduler}")
        if req.loras:
            from . import loras as lora_mod
            known = {n.replace("\\", "/"): n for n in installed.get("loras", [])}
            for lu in req.loras:
                n = known.get(lu.name.replace("\\", "/"))
                if not n:
                    raise ValueError(f"LoRA not found in ComfyUI: {lu.name}")
                lu.name = n
            info = {r["name"]: r for r in lora_mod.scan([lu.name for lu in req.loras])}
            for lu in req.loras:
                if info.get(lu.name, {}).get("kind") == "refmod":
                    raise ValueError(f"{lu.name} is a RefMod reference, not a LoRA: it needs the RefMod nodes")

        base_seed = req.seed if req.seed >= 0 else random.randint(0, 2**48)
        created = []
        for i in range(req.batch):
            item = {
                "id": uuid.uuid4().hex[:12],
                "kind": req.kind,
                "engine": req.engine,
                "project": req.project,
                "status": "submitting",
                "params": req.model_dump(),
                "seed": base_seed + i,
                "created": time.time(),
                "files": [],
                "progress": 0.0,
                "error": None,
                "info": {},
            }
            self.items[item["id"]] = item
            self._update(item)
            self._tasks[item["id"]] = asyncio.create_task(self._run(item, req, resolved["files"]))
            created.append(item)
        return created

    # ------------------------------------------------------------------ internals
    def _validate(self, req: GenerateRequest) -> None:
        if req.engine == "h3" and req.kind not in ("video", "image", "audio"):
            raise ValueError("H3 supports video, image and audio")
        if req.engine == "h3ref":
            if req.kind != "video":
                raise ValueError("H3 Reference only makes video")
            if not req.references and not req.ref_audios:
                raise ValueError("Add at least one reference picture or reference sound")
        if req.engine == "motion":
            if req.kind != "video":
                raise ValueError("Motion layers make video")
            if req.motion_pose_video:
                if not req.motion_video:
                    raise ValueError("A pose skeleton video goes with a 3D scene's render")
                media_path(req.motion_pose_video)
            if req.motion_guide == "reference":
                if not req.motion_video:
                    raise ValueError("A reference video is a 3D scene's render: it needs the scene's rough animation")
                if not self.has_node("MiniMaxH3ReferenceToVideo"):
                    raise ValueError("Following a reference video needs H3 Reference (MiniMaxH3ReferenceToVideo) in ComfyUI")
            elif not self.has_node("vloTimeToMove"):
                raise ValueError("Motion layers need ComfyUI-vlo (vloTimeToMove) in ComfyUI")
            n = workflows.h3_length(req.seconds)
            if n > workflows.H3_MAX_FRAMES:  # a long render, in parts (_render_long)
                win = f"{workflows.H3_MAX_FRAMES / workflows.FPS:.0f} s"
                if req.seconds > workflows.LONG_MAX_SECONDS + 0.05:
                    raise ValueError(f"A scene render is at most {workflows.LONG_MAX_SECONDS} s long")
                if not req.motion_video:
                    raise ValueError(f"Motion layers make up to {win}: longer is for a 3D scene's render")
                if req.lock_audio:
                    raise ValueError(f"Holding the sound works on renders up to {win}")
                if not (self.has_node("NKDAVLatentExtend") and self.has_node("NKDAVLatent")):
                    raise ValueError(f"A render longer than {win} is made in parts that carry on each other: "
                                     "it needs ComfyUI-NKD-Basic-Tools (NKD AV Latent Extend) in ComfyUI")
                if any(len(t) > 20000 for t in req.long_prompts):
                    raise ValueError("A part's prompt is too long")
            if req.motion_video:
                if not req.first_frame or not req.motion_video_mask:
                    raise ValueError("A rough animation needs the picture and its mask video")
                for ref in (req.first_frame, req.motion_video, req.motion_video_mask):
                    media_path(ref)
            elif not req.first_frame or not req.motion_plate or not req.motion_layers:
                raise ValueError("Motion layers need the picture, its empty background and at least one object")
            for lay in req.motion_layers:
                media_path(lay.mask)
                if len(lay.frames) < n:
                    raise ValueError(f"A layer has {len(lay.frames)} frames of path; {n} are needed for {req.seconds:g} s")
                if any(not 4 <= len(f) <= 6 for f in lay.frames):
                    raise ValueError("Each frame of a layer's path is [dx, dy, scale, flip, rotation, flip upside down]")
            if not req.motion_video:
                media_path(req.motion_plate)
            if req.references:
                if not req.motion_video:
                    raise ValueError("Object pictures are for a 3D scene's render")
                if len(req.references) > workflows.H3_MAX_REFS - 1:
                    raise ValueError(f"A scene render takes at most {workflows.H3_MAX_REFS - 1} object pictures")
                if not self.has_node("MiniMaxH3ReferenceToVideo"):
                    raise ValueError("Object pictures need H3 Reference (MiniMaxH3ReferenceToVideo) in ComfyUI")
                for ref in req.references:
                    media_path(ref)
        if req.engine == "retake":
            if req.kind != "video":
                raise ValueError("A retake makes video")
            if not req.source or media.kind_of(req.source) != "video":
                raise ValueError("A retake needs the video whose sound to make again")
            missing = [n for n in (*workflows.RETAKE_NODES, "MiniMaxH3ReferenceToVideo") if not self.has_node(n)]
            if missing:
                raise ValueError(f"Retaking the sound needs these nodes in ComfyUI: {', '.join(missing)} "
                                 "(MVEx_AudioMaskToLatent is in the MaskVidExperiments custom nodes; the rest come with ComfyUI)")
            if not req.prompt.strip():
                raise ValueError("A retake needs a prompt: what is said and heard")
            info = media.probe(req.source)
            dur = float(info.get("duration") or 0)
            if dur * 24 > workflows.RETAKE_MAX_FRAMES:
                raise ValueError(f"The video is {dur:.1f} s long: a retake takes up to {workflows.RETAKE_MAX_FRAMES / 24:.0f} s")
            media.parse_ranges(req.retake_ranges, dur)  # raises when a stretch is wrong
            if req.retake_keep_bg and not all(self.has_node(n) for n in workflows.ROFORMER_NODES):
                raise ValueError("Keeping the background needs ComfyUI-MelBandRoFormer (MelBand RoFormer nodes) in ComfyUI")
        if req.continue_from:
            if req.engine != "h3ref":
                raise ValueError("Continuing a video without a cut needs H3 Reference")
            if media.kind_of(req.continue_from) != "video":
                raise ValueError(f"Can only continue a video: {req.continue_from}")
            if not (self.has_node("NKDAVLatentExtend") and self.has_node("NKDAVLatent")):
                raise ValueError("Continuing without a cut needs ComfyUI-NKD-Basic-Tools (NKD AV Latent Extend) in ComfyUI")
            media_path(req.continue_from)
        if req.engine == "klein" and req.kind != "image":
            raise ValueError("FLUX 3 Klein only makes images")
        if req.engine == "krea2" and req.kind != "image":
            raise ValueError("Krea 2 only makes images")
        if req.engine == "h3image" and req.kind != "image":
            raise ValueError("MiniMax H3 Image only makes images")
        if req.engine == "moss" and req.kind != "image":
            raise ValueError("MOSS-Image only makes images")
        if req.engine == "mossedit":
            if req.kind != "image":
                raise ValueError("MOSS Edit makes pictures")
            if not req.references:
                raise ValueError("MOSS Edit needs the picture to edit: add it in the Inputs step")
            if len(req.references) > workflows.MOSS_EDIT_MAX_PICTURES:
                raise ValueError(f"MOSS Edit takes at most {workflows.MOSS_EDIT_MAX_PICTURES} pictures")
            for ref in req.references:
                if media.kind_of(media_path(ref).name) != "image":
                    raise ValueError("MOSS Edit works on pictures")
            if not req.prompt.strip():
                raise ValueError("Say what to change, e.g. “Change only the jacket to a black wool coat.”")
        if req.engine == "music3" and req.kind != "audio":
            raise ValueError("Music 3 only makes audio")
        if req.engine == "reshoot":
            if req.kind != "video":
                raise ValueError("A reshoot makes video")
            if len(req.guides) < 2 or len(req.guides) != len(req.guide_masks) or len(req.guides) != len(req.guide_frames):
                raise ValueError("A reshoot needs at least two guide frames, each with a mask")
            for ref in (*req.guides, *req.guide_masks):
                media_path(ref)
        if req.engine == "imgedit":
            if req.kind != "image":
                raise ValueError("The image editor makes pictures")
            if not req.source:
                raise ValueError("Pick a picture to edit")
            media_path(req.source)
            if req.edit_op not in ("erase", "replace", "prompt", "instruct", "remove_bg"):
                raise ValueError("Pick an AI edit: erase, replace, change with a prompt, edit the whole picture, "
                                 "or remove the background")
            if req.edit_op not in ("remove_bg", "instruct"):
                if not req.edit_mask:
                    raise ValueError("Select an area first (paint over it with the brush)")
                media_path(req.edit_mask)
            if req.edit_model == "mossedit" and req.edit_op in ("erase", "replace"):
                raise ValueError("MOSS-Image Edit only edits the whole picture: pick Qwen Image Edit or H3 Image for Erase and Replace")
            if req.edit_op in ("replace", "prompt", "instruct") and not req.prompt.strip():
                raise ValueError("Say what should be there")
            if req.references:
                if req.edit_op != "instruct":
                    raise ValueError("More pictures are for an edit of the whole picture")
                most = workflows.EDIT_EXTRA_REFS[req.edit_model]
                if len(req.references) > most:
                    raise ValueError(f"{workflows.EDIT_MODELS[req.edit_model]} takes at most {most} more pictures")
                for ref in req.references:
                    if media.kind_of(media_path(ref).name) != "image":
                        raise ValueError("The extra pictures must be pictures")
        if req.engine == "angles":
            if req.kind != "image":
                raise ValueError("Angles makes pictures")
            if len(req.references) != 1:
                raise ValueError("Angles needs exactly one reference picture")
            if not (req.pose or "").strip():
                raise ValueError("Pick a camera angle")
            if media.kind_of(req.references[0]) != "image":
                raise ValueError("The reference must be a picture")
            media_path(req.references[0])
            return
        if req.engine == "enhance":
            if not req.source or not req.enhance_opts:
                raise ValueError("Nothing to enhance")
            kind = media.kind_of(req.source)
            if kind not in ("image", "video") or kind != req.kind:
                raise ValueError("Enhance works on pictures and videos")
            if kind == "image" and (req.enhance_opts.facerefine or req.enhance_opts.upscaler == "relayvsr"):
                raise ValueError("FaceRefine and RelayVSR are for videos; pictures can use DLSS 5 and SeedVR2")
            media_path(req.source)
            return
        if not req.prompt.strip() and not (req.engine == "imgedit" and req.edit_op in ("erase", "remove_bg")):
            raise ValueError("Prompt is empty")
        if req.aspect not in workflows.ASPECTS:
            raise ValueError(f"Unknown aspect ratio {req.aspect}")
        if req.ref_audios and req.engine not in ("h3ref", "motion", "retake"):
            raise ValueError("Reference sounds (voice cloning) need the H3 Reference model")
        for ref in req.ref_audios:
            if media.kind_of(ref) not in ("audio", "video"):
                raise ValueError(f"A reference sound must be a sound or video file: {ref}")
        for ref in (req.first_frame, req.last_frame, *req.references, *req.ref_audios):
            if ref:
                media_path(ref)  # raises if invalid

    def _build(self, item: dict[str, Any], req: GenerateRequest, files: dict[str, str | None]) -> workflows.Built:
        seed = item["seed"]
        # ComfyUI saves it in its project's folder (output/bob/<Project>/..., app/projectmedia.py)
        from . import projectmedia

        rel = projectmedia.media_dir(req.project, req.scene, req.kind).relative_to(projectmedia.LINK).as_posix()
        prefix = f"bob/{rel}/{item['id']}"
        aspect = workflows.ASPECTS[req.aspect]
        if req.engine == "h3":
            if req.kind == "audio":
                mp = workflows.H3_AUDIO_ONLY_MP
            else:
                mp = workflows.H3_QUALITY.get(req.quality, workflows.H3_QUALITY["draft"])
            frame_ref = req.first_frame or req.last_frame
            if frame_ref and req.kind == "video":
                with Image.open(media_path(frame_ref)) as im:
                    aspect = im.size  # follow the keyframe's own aspect ratio
            w, h = workflows.dims_for(aspect, mp)
            return workflows.build_h3(
                files, output=req.kind, prompt=req.prompt, width=w, height=h, seconds=req.seconds, seed=seed,
                turbo=req.turbo, steps=req.steps, first_frame=bool(req.first_frame) and req.kind == "video",
                last_frame=bool(req.last_frame) and req.kind == "video", prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
            )
        if req.engine == "enhance":
            kind = media.kind_of(req.source or "")
            has_audio, src = False, {}
            try:
                src = media.probe(req.source)
                has_audio = kind == "video" and bool(src.get("has_audio"))
            except (media.MediaError, OSError, ValueError):
                pass
            built = workflows.build_enhance(
                video=kind == "video", has_audio=has_audio, opts=req.enhance_opts.model_dump(), seed=seed, prompt=req.prompt,
                plus=all(self.has_node(n) for n in workflows.FACEREFINE_PLUS_NODES),
                h3=files.get("h3ref"), references=len(req.references), audios=len(req.ref_audios),
                clean_audio=req.clean_audio and self.has_node("H3RefAudioPrep"), relay=files.get("relay"),
                loras=[(lu.name, lu.strength) for lu in req.loras], prefix=prefix,
            )
            # Sizes for the gallery and the time estimates (static/enhance.js estimate()).
            sw, sh = src.get("width"), src.get("height")
            if sw and sh:
                ow, oh = enhanced_size(req.enhance_opts, sw, sh, kind == "video")
                built.info.update(src_width=sw, src_height=sh, width=ow, height=oh)
            if kind == "video" and src.get("duration") and src.get("fps"):
                built.info["frames"] = max(1, round(src["duration"] * src["fps"]))
            return built
        if req.engine == "angles":
            return workflows.build_angles(files, pose=req.pose or "", prompt=req.prompt, seed=seed, steps=req.steps,
                                          prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras])
        if req.engine == "reshoot":
            with Image.open(media_path(req.guides[0])) as im:
                w, h = im.size
            return workflows.build_reshoot(
                files["h3"], files["klein"], prompt=req.prompt, fill_prompt=req.fill_prompt, width=w, height=h,
                seconds=req.seconds, seed=seed, turbo=req.turbo, guide_frames=req.guide_frames,
                references=len(req.references), steps=req.steps, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
            )
        if req.engine == "h3ref":
            mp = workflows.H3_QUALITY.get(req.quality, workflows.H3_QUALITY["draft"])
            w, h = workflows.dims_for(aspect, mp)
            return workflows.build_h3_ref(
                files, prompt=req.prompt, width=w, height=h, seconds=req.seconds, seed=seed,
                references=len(req.references), turbo=req.turbo, steps=req.steps,
                max_fidelity=req.max_fidelity, audios=len(req.ref_audios),
                clean_audio=req.clean_audio and self.has_node("H3RefAudioPrep"), prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
                continue_overlap=req.overlap if req.continue_from else 0,
            )
        if req.engine == "retake":
            info = media.probe(req.source)
            dur = float(info.get("duration") or 0)
            frames = workflows.h3_length(dur)
            if frames < round(dur * workflows.FPS):  # h3_length rounds to the nearest: never shorter than the clip
                frames += 17
            w, h = workflows.dims_for((info.get("width") or 16, info.get("height") or 9), workflows.H3_QUALITY["draft"])
            built = workflows.build_retake(
                files, prompt=req.prompt, width=w, height=h, frames=frames, seed=seed, turbo=req.turbo, steps=req.steps,
                ranges=media.parse_ranges(req.retake_ranges, dur), references=len(req.references), audios=len(req.ref_audios),
                clean_audio=req.clean_audio and self.has_node("H3RefAudioPrep"), prefix=prefix,
                loras=[(lu.name, lu.strength) for lu in req.loras], keep_background=files.get("melband"))
            built.info.update(width=info.get("width"), height=info.get("height"), sample_width=w, sample_height=h,
                              seconds=round(dur, 2), source=req.source)
            return built
        if req.engine == "motion":
            mp = workflows.H3_QUALITY.get(req.quality, workflows.H3_QUALITY["draft"])
            with Image.open(media_path(req.first_frame)) as im:  # framed like the picture
                w, h = workflows.dims_for(im.size, mp)
            edge = (req.motion_edge if req.motion_edge >= 0 else 2 if req.motion_video
                    else motion.auto_edge(req.first_frame, req.motion_layers, w, h))
            return workflows.build_motion(
                files, prompt=req.prompt, width=w, height=h, seconds=req.seconds, seed=seed, turbo=req.turbo, steps=req.steps,
                hold=req.motion_hold, edge=edge, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
                references=len(req.references), audios=len(req.ref_audios),
                clean_audio=req.clean_audio and self.has_node("H3RefAudioPrep"), guide=req.motion_guide,
                lock_audio=bool(req.lock_audio),
                # the skeleton: through the H3 Fun ControlNet when it's there (either guide), else H3 Reference's <Video 2>
                pose_video=bool(req.motion_pose_video and ((files.get("fun_controlnet") and req.motion_pose_strength > 0) or req.motion_guide == "reference")),
                pose_control=req.motion_pose_strength if files.get("fun_controlnet") else 0.0,
            )
        if req.engine == "imgedit":
            return workflows.build_imgedit(
                req.edit_op, files if req.edit_op != "remove_bg" else None, prompt=req.prompt, strength=req.edit_strength,
                seed=seed, steps=req.steps, background=req.edit_bg, bg_model=(files or {}).get("bg_model"), edit_model=req.edit_model, prefix=prefix,
                references=len(req.references) if req.edit_op == "instruct" else 0,
                megapixels=req.edit_megapixels if req.edit_op == "instruct" else None,
                loras=[(lu.name, lu.strength) for lu in req.loras] if req.edit_op == "instruct" else None,
            )
        if req.engine == "klein":
            mp = workflows.KLEIN_QUALITY.get(req.quality, 1.0)
            w, h = workflows.dims_for(aspect, mp, multiple=16)
            return workflows.build_klein(
                files, prompt=req.prompt, width=w, height=h, seed=seed, steps=req.steps or 16,
                enhance=req.enhance, aspect_label=req.aspect, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
            )
        if req.engine == "h3image":
            mp = workflows.H3_IMAGE_QUALITY.get(req.quality, 2.0)
            w, h = workflows.dims_for(aspect, mp, multiple=32)
            # Clean texture needs the EasyFix nodes and the official sigmas (no scheduler of the user's own).
            clean = req.clean_texture and not req.scheduler  # checked against ComfyUI's nodes in submit
            return workflows.build_h3_image(files, prompt=req.prompt, width=w, height=h, seed=seed, references=len(req.references), steps=req.steps,
                                            prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras], clean=clean)
        if req.engine == "mossedit":
            return workflows.build_moss_edit(
                files, prompt=req.prompt, pictures=len(req.references), megapixels=workflows.MOSS_EDIT_QUALITY.get(req.quality, 1.0),
                seed=seed, steps=req.steps or 30, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
            )
        if req.engine == "moss":
            mp = workflows.MOSS_QUALITY.get(req.quality, 1.0)
            w, h = workflows.dims_for(aspect, mp, multiple=16)
            return workflows.build_moss(
                files, prompt=req.prompt, width=w, height=h, seed=seed, steps=req.steps or 25,
                enhance=req.enhance, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
                layout=[b.model_dump() for b in req.layout] if req.layout else None,
            )
        if req.engine == "krea2":
            mp = workflows.KREA2_QUALITY.get(req.quality, 1.0)
            w, h = workflows.dims_for(aspect, mp, multiple=16)
            return workflows.build_krea2(
                files, prompt=req.prompt, width=w, height=h, seed=seed, steps=req.steps or 8,
                enhance=req.enhance, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
            )
        return workflows.build_music3(
            files, caption=req.prompt, lyrics=req.lyrics or "[Instrumental]", seconds=req.seconds, seed=seed,
            steps=req.steps or 30, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
        )

    async def _run(self, item: dict[str, Any], req: GenerateRequest, files: dict[str, str | None]) -> None:
        from comfy_sdk import JobFailed

        try:
            t_start = time.time()
            if self.is_long(req):  # longer than H3's window: in parts, each carrying on the one before
                saved, info, req = await self._render_long(item, req, files)
            else:
                saved, info, req = await self._render_one(item, req, files)
            self.log(item, f"Done in {time.time() - t_start:.1f} s: " + ", ".join(f"{f['name']} ({f['size'] / 2**20:.1f} MB)" for f in saved))
            self._update(item, status="done", files=saved, progress=1.0, finished=time.time())
            self._write_request(item, req, info)
            if req.enhance_after and req.engine != "enhance" and saved:
                asyncio.create_task(self._enhance_after(item))
            from . import heard  # its spoken lines, as heard: ranks a set of takes

            if req.relock_of:  # a lip-sync pass: its picture goes to the render it redraws
                await self._on_resynced(item, saved)
            elif heard.wants(item) and self.has_node(heard.NODE):
                asyncio.create_task(self._hear_after(item))
            elif req.enhance_final or req.retake_of:  # no words to check: it has settled already
                asyncio.create_task(self._settled(item))
            if item.get("project"):
                from . import projects  # the project's thumbnail and "modified" follow its latest result

                params = item.get("params", {})
                if item["kind"] == "image" and saved:
                    thumb = saved[0]["path"]
                else:  # videos and sound: the picture it started from, if any
                    thumb = params.get("first_frame") or (params.get("references") or [None])[0]
                projects.touch(item["project"], thumb or None)
        except JobFailed as exc:
            status = "cancelled" if "cancel" in str(exc).lower() else "failed"
            self.log(item, f"{status.title()}: {_short_error(exc)[:400]}", "error")
            self._update(item, status=status, error=_short_error(exc), finished=time.time())
        except Exception as exc:  # network errors, invalid workflow, etc.
            log.exception("job %s failed", item["id"])
            if getattr(exc, "details", None):
                log.error("job %s details: %.3000r", item["id"], exc.details)
            status = "cancelled" if type(exc).__name__ in ("Cancelled", "CancelledError") else "failed"
            self.log(item, f"{status.title()}: {_short_error(exc)[:400]}", "error")
            self._update(item, status=status, error=_short_error(exc), finished=time.time())
        finally:
            self._handles.pop(item["id"], None)
            self._tasks.pop(item["id"], None)
            of = (item.get("params") or {}).get("retake_of")
            if of and item.get("status") in ("failed", "cancelled") and self.items.get(of):  # the render's final take: itself
                asyncio.create_task(self._enhance_final(self.items[of]))

    def is_long(self, req: GenerateRequest) -> bool:
        """A 3D scene's render longer than H3's window (about 15 s): made in parts (_render_long)."""
        return req.engine == "motion" and workflows.h3_length(req.seconds) > workflows.H3_MAX_FRAMES

    async def _render_long(self, item: dict[str, Any], req: GenerateRequest,
                           files: dict[str, str | None]) -> tuple[list[dict[str, Any]], dict[str, Any], GenerateRequest]:
        """A 3D scene's render longer than H3's window, in parts (workflows.long_plan): the rough animation, its mask
        and the skeleton fitted to the whole length once, then each part rendered in turn from its stretch of them,
        every part after the first carrying on the last 1.6 s (picture and sound) of the one before without a cut
        (NKD AV Latent Extend, workflows.build_motion continue_overlap). Each part has its own prompt when the page
        wrote them (long_prompts: its stretch of the camera move, the lines said in it); the parts are joined into one
        video at the end. Each part is its own ComfyUI job, so the GPU holds one window at a time, as for a short
        render. -> (files, info, req)"""
        import shutil

        from . import projectmedia

        client = self.comfy.client
        total = workflows.h3_length(req.seconds)
        plan = workflows.long_plan(total)
        n, ov = len(plan), workflows.LONG_OVERLAP
        prompts = list(req.long_prompts) if len(req.long_prompts) == n else [req.prompt] * n
        if req.long_prompts and len(req.long_prompts) != n:
            self.log(item, f"The page wrote {len(req.long_prompts)} part prompts for {n} parts: each part gets the whole shot's", "warn")
        mp = workflows.H3_QUALITY.get(req.quality, workflows.H3_QUALITY["draft"])
        with Image.open(media_path(req.first_frame)) as im:
            w, h = workflows.dims_for(im.size, mp)
        edge = req.motion_edge if req.motion_edge >= 0 else 2
        use_cn = bool(files.get("fun_controlnet") and req.motion_pose_strength > 0)
        use_pose = bool(req.motion_pose_video and (use_cn or req.motion_guide == "reference"))
        up, iid = config.UPLOAD_DIR, item["id"]
        full = {"motion_ref": up / f"{iid}_motion.mp4", "motion_mask": up / f"{iid}_motion_mask.mp4"}
        first = up / f"{iid}_motion_first.png" if req.motion_first == "composite" else None
        info = await asyncio.to_thread(motion.conform, req.motion_video, req.motion_video_mask, w, h, total,
                                       full["motion_ref"], full["motion_mask"], first)
        d = self._media_dir(item)
        try:
            shutil.copyfile(full["motion_ref"], d / f"{iid}_3d.mp4")
            if req.motion_guide != "reference":
                shutil.copyfile(full["motion_mask"], d / f"{iid}_3d_mask.mp4")
        except Exception as exc:  # noqa: BLE001 - a copy, never the render
            self.log(item, f"Couldn't keep the 3D render in the project's folder: {exc}", "warn")
        self.log(item, f"Fitted the 3D scene's rough animation: {info['frames']} frames at {info['size']}"
                 + (", starting from its own first frame" if first else ""))
        if use_pose:
            full["motion_pose"] = up / f"{iid}_motion_pose.mp4"
            await asyncio.to_thread(motion.conform, req.motion_pose_video, req.motion_pose_video, w, h, total,
                                    full["motion_pose"], up / f"{iid}_motion_pose_gray.mp4")
            try:
                shutil.copyfile(full["motion_pose"], d / f"{iid}_3d_pose.mp4")
            except Exception as exc:  # noqa: BLE001
                self.log(item, f"Couldn't keep the pose skeleton in the project's folder: {exc}", "warn")
            self.log(item, "Fitted the people's pose skeleton" + (" (the H3 Fun ControlNet)" if use_cn else " (<Video 2>)"))
        if first:
            req = req.model_copy(update={"first_frame": first.relative_to(config.ROOT).as_posix()})
        sec = lambda f: f"{f / workflows.FPS:.1f} s"  # noqa: E731
        item["info"] = {"width": w, "height": h, "frames": total, "seconds": round(total / workflows.FPS, 2), "parts": n,
                        "plan": [{"from": round(p["start"] / workflows.FPS, 2), "to": round((p["start"] + p["frames"]) / workflows.FPS, 2)}
                                 for p in plan],
                        "overlap": ov}
        self._update(item)
        self.log(item, f"A long render: {sec(total)} in {n} parts ("
                 + ", ".join(f"{sec(p['start'])}-{sec(p['start'] + p['frames'])}" for p in plan)
                 + f"), each after the first carrying on the last {sec(ov)} of the one before without a cut")
        rel = projectmedia.media_dir(req.project, req.scene, req.kind).relative_to(projectmedia.LINK).as_posix()
        outs: list[dict[str, Any]] = []
        last_info: dict[str, Any] = {}
        for i, part in enumerate(plan):
            say = f"Part {i + 1} of {n}: "
            # the voices go to a part whose prompt speaks with them (the page leaves them out of a part with no lines)
            voices = len(req.ref_audios) if "<Audio" in prompts[i] or prompts[i] == req.prompt else 0
            built = workflows.build_motion(
                files, prompt=prompts[i], width=w, height=h, seconds=part["window"] / workflows.FPS, seed=item["seed"],
                turbo=req.turbo, steps=req.steps, hold=req.motion_hold, edge=edge, prefix=f"bob/{rel}/{iid}_part{i + 1}",
                loras=[(lu.name, lu.strength) for lu in req.loras], references=len(req.references), audios=voices,
                clean_audio=req.clean_audio and self.has_node("H3RefAudioPrep"), guide=req.motion_guide, pose_video=use_pose,
                pose_control=req.motion_pose_strength if files.get("fun_controlnet") else 0.0,
                frames=part["window"], continue_overlap=ov if i else 0, on_ref=True)
            if req.sampler or req.scheduler or req.cfg is not None:
                built.info = {**built.info, **workflows.apply_sampling(built.graph, req.sampler, req.scheduler, req.cfg)}
            last_info = built.info
            sent = copy.deepcopy(built.graph)
            wf = client.workflows.from_json(built.graph)
            files_in: dict[str, Path] = {}
            for role in ("motion_ref", "motion_mask", "motion_pose"):  # its stretch of the whole length
                if role in built.image_inputs:
                    files_in[role] = up / f"{iid}_p{i + 1}_{role}.mp4"
                    await asyncio.to_thread(media.cut_frames, full[role], part["window_start"], part["window"], files_in[role])
            if i:  # the part before's last frames, and the first of them as <Picture 1>
                files_in["tail"] = up / f"{iid}_p{i + 1}_tail.mp4"
                await asyncio.to_thread(media.tail_clip, outs[-1]["path"], ov, w, h, files_in["tail"])
                files_in["first_frame"] = up / f"{iid}_p{i + 1}_first.png"
                await asyncio.to_thread(media.first_frame_of, files_in["tail"], files_in["first_frame"])
            for role, node_id in built.image_inputs.items():
                if role in files_in:
                    path, field = files_in[role], "image" if role == "first_frame" else "file"
                elif role == "first_frame":
                    path, field = media_path(req.first_frame), "image"
                elif role.startswith("aref_"):
                    path, field = media_path(req.ref_audios[int(role[5:])]), "audio"
                elif role.startswith("ref_"):
                    path, field = media_path(req.references[int(role[4:])]), "image"
                else:
                    raise ValueError(f"A long render has no input {role}")
                wf.set_input(node_id, field, client.assets.from_file(path))
                if str(node_id) in sent:
                    sent[str(node_id)]["inputs"][field] = path.name
                    sent[str(node_id)].setdefault("_meta", {})["title"] = role
            save_workflow(iid if i == 0 else f"{iid}_part{i + 1}", sent)
            self.log(item, f"{say}{sec(part['start'])} to {sec(part['start'] + part['frames'])}"
                     + (f", carrying on from {sec(part['window_start'])}" if i else "") + f": {len(built.graph)} nodes, {part['window']} frames")
            done = await self._execute(item, built, wf, req, span=(i / n, (i + 1) / n), say=say)
            got = await self._download(item, done, built.outputs)
            vid = next((x for x in got if (x.get("content_type") or "").startswith("video")), None)
            if not vid:
                raise ValueError(f"Part {i + 1} came back without a video")
            outs.append(vid)
            self.log(item, f"{say}done")
        target = d / f"{iid}_long.mp4"
        self.log(item, f"Joining the {n} parts")
        await asyncio.to_thread(media.join_videos, [config.ROOT / x["path"] for x in outs], target)
        for x in outs:  # the parts are in the joined video
            (config.ROOT / x["path"]).unlink(missing_ok=True)
        for f in up.glob(f"{iid}_p*_*"):
            f.unlink(missing_ok=True)
        rel_t = target.relative_to(config.ROOT).as_posix()
        saved = [{"name": target.name, "path": rel_t, "url": "/" + urllib.parse.quote(rel_t), "content_type": "video/mp4",
                  "size": target.stat().st_size}]
        info = {**last_info, **item["info"], "final_prompt": prompts[0]}
        if len(set(prompts)) > 1:
            info["part_prompts"] = prompts
        for k in ("new_frames", "continues"):
            info.pop(k, None)
        return saved, info, req

    async def _render_one(self, item: dict[str, Any], req: GenerateRequest,
                          files: dict[str, str | None]) -> tuple[list[dict[str, Any]], dict[str, Any], GenerateRequest]:
        """One graph, one ComfyUI job: built, its inputs uploaded, run, its results downloaded. -> (files, info, req)"""
        client = self.comfy.client
        built = self._build(item, req, files)
        if req.engine in workflows.SAMPLING_DEFAULTS and (req.sampler or req.scheduler or req.cfg is not None):
            built.info = {**(built.info or {}), **workflows.apply_sampling(built.graph, req.sampler, req.scheduler, req.cfg)}
        item["info"] = built.info
        self.log(item, f"Built the {req.engine} workflow: {len(built.graph)} nodes"
                 + "".join(f", {k} {v}" for k, v in (built.info or {}).items() if isinstance(v, (int, float, str)) and len(str(v)) < 40))
        # The SDK works on the dict it's given (set_input puts the upload handle in it), so the copy saved
        # for "View workflow" is a separate one: editing the shared dict sent ComfyUI a plain file name
        # that was never uploaded ("Invalid image file").
        saved = copy.deepcopy(built.graph)
        wf = client.workflows.from_json(built.graph)
        if req.engine == "motion":  # the rough animation, its mask and (when asked) its first frame, before the uploads
            vids = {"motion_ref": config.UPLOAD_DIR / f"{item['id']}_motion.mp4",
                    "motion_mask": config.UPLOAD_DIR / f"{item['id']}_motion_mask.mp4"}
            first = config.UPLOAD_DIR / f"{item['id']}_motion_first.png" if req.motion_first == "composite" else None
            if req.motion_video:  # drawn in the page (a 3D scene): fitted to this render's size and length
                info = await asyncio.to_thread(
                    motion.conform, req.motion_video, req.motion_video_mask, int(built.info["width"]),
                    int(built.info["height"]), int(built.info["frames"]), vids["motion_ref"], vids["motion_mask"], first)
                # the 3D scene's render as H3 got it, in its scene's folder (<id>_3d.mp4; its mask with Time-to-Move)
                try:
                    import shutil

                    d = self._media_dir(item)
                    shutil.copyfile(vids["motion_ref"], d / f"{item['id']}_3d.mp4")
                    if req.motion_guide != "reference":
                        shutil.copyfile(vids["motion_mask"], d / f"{item['id']}_3d_mask.mp4")
                except Exception as exc:  # noqa: BLE001 - a copy, never the render
                    self.log(item, f"Couldn't keep the 3D render in the project's folder: {exc}", "warn")
                self.log(item, f"Fitted the 3D scene's rough animation: {info['frames']} frames at {info['size']}"
                         + (", starting from its own first frame" if first else ""))
                if "motion_pose" in built.image_inputs:  # its people's skeleton (<Video 2>), fitted the same way
                    pose_out = config.UPLOAD_DIR / f"{item['id']}_motion_pose.mp4"
                    await asyncio.to_thread(
                        motion.conform, req.motion_pose_video, req.motion_pose_video, int(built.info["width"]),
                        int(built.info["height"]), int(built.info["frames"]), pose_out,
                        config.UPLOAD_DIR / f"{item['id']}_motion_pose_gray.mp4")
                    try:
                        import shutil

                        shutil.copyfile(pose_out, self._media_dir(item) / f"{item['id']}_3d_pose.mp4")
                    except Exception as exc:  # noqa: BLE001 - a copy, never the render
                        self.log(item, f"Couldn't keep the pose skeleton in the project's folder: {exc}", "warn")
                    self.log(item, "Fitted the people's pose skeleton (<Video 2>)")
            else:
                info = await asyncio.to_thread(
                    motion.render, req.first_frame, req.motion_plate, req.motion_layers, int(built.info["width"]),
                    int(built.info["height"]), int(built.info["frames"]), vids["motion_ref"], vids["motion_mask"], first)
                self.log(item, f"Drew the rough animation: {info['layers']} object(s), {info['frames']} frames"
                         + (", starting from its own first frame" if first else ""))
            if first:
                req = req.model_copy(update={"first_frame": first.relative_to(config.ROOT).as_posix()})
        for role, node_id in built.image_inputs.items():
            field = "image"
            if role == "edit_rect":  # the image editor's marked rectangle, made from the selection
                rect = config.UPLOAD_DIR / f"{item['id']}_rect.png"
                await asyncio.to_thread(imaging.mask_rect, media_path(req.edit_mask), rect)
                wf.set_input(node_id, field, client.assets.from_file(rect))
                continue
            if role in ("motion_ref", "motion_mask", "motion_pose"):  # motion layers: the rough animation, its mask, the skeleton
                vids = {"motion_ref": config.UPLOAD_DIR / f"{item['id']}_motion.mp4",
                        "motion_mask": config.UPLOAD_DIR / f"{item['id']}_motion_mask.mp4",
                        "motion_pose": config.UPLOAD_DIR / f"{item['id']}_motion_pose.mp4"}
                wf.set_input(node_id, "file", client.assets.from_file(vids[role]))
                sent = saved.get(str(node_id))
                if sent:
                    sent["inputs"]["file"] = vids[role].name
                    sent.setdefault("_meta", {})["title"] = role
                continue
            if role == "tail":  # continuing without a cut: the previous video's last frames at this size
                tail = config.UPLOAD_DIR / f"{item['id']}_tail.mp4"
                await asyncio.to_thread(media.tail_clip, req.continue_from, req.overlap,
                                        int(built.info["width"]), int(built.info["height"]), tail)
                self.log(item, f"Continues {req.continue_from} without a cut ({req.overlap} frames of overlap)")
                wf.set_input(node_id, "file", client.assets.from_file(tail))
                sent = saved.get(str(node_id))
                if sent:
                    sent["inputs"]["file"] = tail.name
                    sent.setdefault("_meta", {})["title"] = f"tail: {req.continue_from}"
                continue
            if role == "retake_src":  # retaking the sound: the video at the size and length H3 samples it
                prep = config.UPLOAD_DIR / f"{item['id']}_retake_src.mp4"
                await asyncio.to_thread(media.retake_source, req.source, int(built.info["sample_width"]),
                                        int(built.info["sample_height"]), int(built.info["frames"]), prep)
                self.log(item, f"Retakes the sound of {req.source}"
                         + (f" from {', '.join(f'{a:g}-{b:g} s' for a, b in built.info['ranges'])}" if built.info["ranges"] else ", all of it"))
                wf.set_input(node_id, "file", client.assets.from_file(prep))
                sent = saved.get(str(node_id))
                if sent:
                    sent["inputs"]["file"] = prep.name
                    sent.setdefault("_meta", {})["title"] = f"retake: {req.source}"
                continue
            if role == "source":
                ref, field = req.source, ("file" if media.kind_of(req.source or "") == "video" else "image")
            elif role.startswith("aref_"):
                ref, field = req.ref_audios[int(role[5:])], "audio"
            elif role == "lock_audio":
                ref, field = req.lock_audio, "audio"
            elif role.startswith("ref_"):
                ref = req.references[int(role[4:])]
            elif role.startswith("guide_"):
                ref = req.guides[int(role[6:])]
            elif role.startswith("mask_"):
                ref = req.guide_masks[int(role[5:])]
            else:
                ref = getattr(req, role)
            self.log(item, f"Input {role}: {ref}")
            wf.set_input(node_id, field, client.assets.from_file(media_path(ref)))
            sent = saved.get(str(node_id))
            if sent:  # the saved copy names the file (ComfyUI needs it in its input folder to load it)
                sent["inputs"][field] = Path(ref).name
                sent.setdefault("_meta", {})["title"] = f"{role}: {ref}"
        save_workflow(item["id"], saved)

        done = await self._execute(item, built, wf, req)
        self.log(item, "Downloading the results")
        saved = await self._download(item, done, built.outputs)
        if req.engine == "retake" and saved:
            saved = await self._retake_mux(item, req, saved, built.info)
        if req.white_bg and req.engine == "angles":
            await self._whiten(item, saved)
        return saved, built.info, req

    async def _execute(self, item: dict[str, Any], built: workflows.Built, wf: Any, req: GenerateRequest,
                       span: tuple[float, float] = (0.0, 1.0), say: str = "") -> Any:
        """Send a graph to ComfyUI and follow it to the end: its progress (within `span` of the item's, for a part
        of a long render), previews and queue place. -> the finished job (raises JobFailed when it failed)."""
        from comfy_sdk import OutputReady, Preview, Progress, StatusChange

        client = self.comfy.client
        lo, hi = span
        # No `metadata=`: comfy-api-proxy 0.1.6 rejects the SDK's mapping form.
        job = await submit_job(client, wf, PREVIEW_METHODS.get(req.preview))
        self._handles[item["id"]] = job
        self.log(item, f"{say}Sent to ComfyUI (job {job.id})")
        if item["status"] != "running":
            self._update(item, status="queued", comfy_job=job.id, started=None)
        else:
            self._update(item, comfy_job=job.id)

        async def pump_events() -> None:
            last_preview = 0.0
            last_node, last_quarter = None, -1
            async for ev in job.events():
                if isinstance(ev, Progress):
                    if item["status"] != "running":
                        self.log(item, "Running on the GPU")
                        self._update(item, status="running", started=time.time())
                    node = getattr(ev, "current_node", None)
                    if node and node != last_node:
                        last_node = node
                        ctype = (built.graph.get(str(node)) or {}).get("class_type", "")
                        self.log(item, f"Node {node}{f' · {ctype}' if ctype else ''}")
                    if ev.steps:
                        quarter = int(4 * ev.step / ev.steps)
                        if quarter != last_quarter:
                            last_quarter = quarter
                            self.log(item, f"{say}Step {ev.step} of {ev.steps}")
                    # ev.value is the share of graph nodes done (loaders count), so
                    # during sampling report step progress, which is what users expect.
                    value = lo + (hi - lo) * (ev.step / ev.steps if ev.steps else ev.value)
                    item["progress"] = value
                    self._publish({"type": "progress", "id": item["id"], "value": value,
                                   "step": ev.step, "steps": ev.steps, "node": ev.current_node,
                                   "message": ev.message})
                elif isinstance(ev, Preview):
                    now = time.monotonic()
                    if now - last_preview > 0.75:
                        last_preview = now
                        b64 = base64.b64encode(ev.data).decode()
                        self._publish({"type": "preview", "id": item["id"],
                                       "src": f"data:{ev.content_type};base64,{b64}"})
                elif isinstance(ev, StatusChange):
                    if ev.status == "running" and item["status"] != "running":
                        self.log(item, "Running on the GPU")
                        self._update(item, status="running", started=time.time())
                    elif ev.status in ("queued", "pending"):
                        if ev.queue_position is not None:
                            self.log(item, f"Waiting in ComfyUI's queue (position {ev.queue_position})")
                        self._publish({"type": "queue", "id": item["id"], "position": ev.queue_position})
                elif isinstance(ev, OutputReady):
                    pass  # we download everything once the job is final

        events_task = asyncio.create_task(pump_events())
        try:
            # The SDK's wait() backs off up to ~15 s between polls; poll at a
            # steady 1 s so results show up promptly, then let result() raise
            # JobFailed with the server's error details if it didn't succeed.
            from comfy_sdk import _core

            while True:
                await job.refresh()
                if _core.is_terminal(job.status):
                    break
                await asyncio.sleep(1.0)
            done = await job.result()
        finally:
            events_task.cancel()
        return done


    async def run_quick(self, built: workflows.Built, refs: dict[str, str], timeout: float = 300) -> list[Path]:
        """Run a small helper graph (not a studio item, e.g. the editor's AI select) and save its
        outputs in data/uploads. ``refs``: image role -> media ref."""
        from comfy_sdk import _core

        client = self.comfy.client
        wf = client.workflows.from_json(built.graph)
        for role, node_id in built.image_inputs.items():  # "aref…" roles are sounds (LoadAudio), "video…" LoadVideo, the rest pictures
            field = "audio" if role.startswith("aref") else "file" if role.startswith("video") else "image"
            wf.set_input(node_id, field, client.assets.from_file(media_path(refs[role])))
        job = await client.submit(wf)
        deadline = time.monotonic() + timeout
        while True:
            await job.refresh()
            if _core.is_terminal(job.status):
                break
            if time.monotonic() > deadline:
                await job.cancel()
                raise TimeoutError("ComfyUI took too long")
            await asyncio.sleep(0.4)
        done = await job.result()
        paths = []
        for out in [o for n in built.outputs for o in done.get_outputs(n)] or list(done.outputs):
            target = config.UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}{Path(out.name).suffix or '.png'}"
            await out.to_file(target)
            paths.append(target)
        return paths

    def add_edit(self, data: bytes, *, source: str | None, project: str | None, note: str = "") -> dict[str, Any]:
        """A picture the image editor made in the browser (crop, resize, colors) becomes a result."""
        item_id = uuid.uuid4().hex[:12]
        out_dir = config.OUTPUT_DIR / datetime.now().strftime("%Y-%m-%d")
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / f"{item_id}_edit.png"
        target.write_bytes(data)
        with Image.open(target) as im:
            w, h = im.size
        rel = target.relative_to(config.ROOT).as_posix()
        now = time.time()
        item = {
            "id": item_id, "kind": "image", "engine": "imgedit", "project": project, "status": "done",
            "params": {"kind": "image", "engine": "imgedit", "edit_op": "adjust", "source": source, "prompt": note[:2000],
                       "project": project},
            "seed": 0, "created": now, "started": now, "finished": now, "progress": 1.0, "error": None,
            "info": {"width": w, "height": h, "op": "adjust"},
            "files": [{"name": target.name, "path": rel, "url": "/" + rel, "content_type": "image/png", "size": target.stat().st_size}],
        }
        self.items[item_id] = item
        self._update(item)
        if project:
            from . import projects

            projects.touch(project, rel)
        return item

    async def _whiten(self, item: dict[str, Any], saved: list[dict[str, Any]]) -> None:
        for f in saved:
            if not (f.get("content_type") or "").startswith("image/"):
                continue
            p = config.ROOT / f["path"]
            try:
                share = await asyncio.to_thread(imaging.whiten_backdrop, p)
            except Exception as exc:  # noqa: BLE001 - keep the picture as it came
                self.log(item, f"Couldn't whiten the background: {_short_error(exc)}", "warn")
                continue
            f["size"] = p.stat().st_size
            self.log(item, f"Background made pure white ({share:.0%} of the picture)" if share
                     else "No plain light background to whiten, left as it is")

    def _media_dir(self, item: dict[str, Any]) -> Path:
        """Its project's folder (its scene's, for a 3D scene's photo, fill or render): app/projectmedia.py."""
        from . import projectmedia

        p = item.get("params") or {}
        return projectmedia.media_dir(item.get("project"), p.get("scene"), item.get("kind") or p.get("kind") or "video")

    def _write_request(self, item: dict[str, Any], req: "GenerateRequest", info: dict[str, Any]) -> None:
        """Beside the result: what was asked for and what was sent (the prompt as ComfyUI got it, sizes, steps)."""
        from . import projectmedia

        try:
            projectmedia.write_json(self._media_dir(item) / f"{item['id']}.json", {
                "id": item["id"], "engine": req.engine, "kind": req.kind, "seed": item.get("seed"), "created": item.get("created"),
                "finished": item.get("finished"), "request": req.model_dump(), "sent": info, "files": item.get("files")})
        except Exception as exc:  # noqa: BLE001 - never let this touch the finished result
            self.log(item, f"Couldn't save its request beside it: {exc}", "warn")

    async def _download(self, item: dict[str, Any], job: Any, output_nodes: list[str]) -> list[dict[str, Any]]:
        try:
            out_dir = self._media_dir(item)
        except Exception as exc:  # noqa: BLE001 - the dated folder, as before
            self.log(item, f"Saving to the dated outputs folder: its project's folder isn't there ({exc})", "warn")
            out_dir = config.OUTPUT_DIR / datetime.now().strftime("%Y-%m-%d")
        out_dir.mkdir(parents=True, exist_ok=True)
        outputs = [o for n in output_nodes for o in job.get_outputs(n)] or list(job.outputs)
        saved = []
        for out in outputs:
            name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(out.name).name)
            target = out_dir / (name if name.startswith(item["id"]) else f"{item['id']}_{name}")
            # on this PC ComfyUI saved it right here already (its prefix is this folder): no second copy
            if not (target.is_file() and target.stat().st_size > 0):
                await out.to_file(target)
            rel = target.relative_to(config.ROOT).as_posix()
            saved.append({
                "name": name,
                "path": rel,
                "url": "/" + urllib.parse.quote(rel),
                "content_type": out.content_type,
                "size": target.stat().st_size,
            })
        return saved


def enhanced_size(o: EnhanceOpts, w: int, h: int, video: bool) -> tuple[int, int]:
    """The picture size an enhance chain ends at (DLSS 5 scale, then SeedVR2's short side or RelayVSR x2)."""
    k = {"1x": 1, "1.5x": 1.5, "1.724x": 1.724, "2x": 2, "3x": 3}.get(o.dlss_mode, 1) if o.dlss else 1
    fw, fh = w * k, h * k
    if o.upscaler == "seedvr2":
        s = o.seedvr2_res / min(fw, fh)
        fw, fh = fw * s, fh * s
    elif o.upscaler == "relayvsr" and video:
        fw, fh = fw * 2, fh * 2
    return round(fw / 2) * 2, round(fh / 2) * 2


def media_path(ref: str) -> Path:
    """Resolve a media ref from the browser: uploads, outputs, or a bookmarked folder only."""
    from . import media

    try:
        return media.resolve(ref)
    except media.MediaError as exc:
        raise ValueError(str(exc)) from exc


def _node_errors(details) -> str:
    """ComfyUI's per-node validation errors ({node_id: {class_type, errors: [{message, details}]}}) in a line each."""
    if not isinstance(details, dict):
        return str(details)[:600] if details else ""
    nodes = details.get("node_errors", details)
    lines = []
    for nid, n in (nodes.items() if isinstance(nodes, dict) else []):
        if not isinstance(n, dict):
            continue
        for e in n.get("errors") or []:
            if isinstance(e, dict):
                lines.append(f"{n.get('class_type', '?')} #{nid}: {e.get('message', '')}"
                             f"{(' (' + str(e.get('details')) + ')') if e.get('details') else ''}")
    return "; ".join(lines)


def _short_error(exc: Exception) -> str:
    text = str(exc) or type(exc).__name__
    # A workflow ComfyUI refused: say which node and why, not only "Prompt outputs failed validation".
    extra = _node_errors(getattr(exc, "details", None) or getattr(getattr(exc, "__cause__", None), "details", None))
    if extra and extra not in text:
        text = f"{text}: {extra}"
    return text if len(text) < 1500 else text[:1500] + "…"
