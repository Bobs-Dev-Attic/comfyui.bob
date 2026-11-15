"""Generation jobs: build a graph, submit it through comfy-sdk, stream progress, save outputs."""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import logging
import random
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from PIL import Image
from pydantic import BaseModel, Field

from . import config, media, models, workflows
from .comfy import ComfyService

log = logging.getLogger("bob.jobs")

Kind = Literal["video", "image", "audio"]
Engine = Literal["h3", "h3ref", "klein", "music3", "reshoot", "enhance", "angles"]


class LoraUse(BaseModel):
    name: str = Field(..., max_length=500)  # as ComfyUI lists it (models/loras)
    strength: float = Field(1.0, ge=-4, le=4)


class EnhanceOpts(BaseModel):
    """The enhance chain (workflows.build_enhance): FaceRefine -> DLSS 5 -> an upscaler."""
    facerefine: bool = False
    face_strength: float = Field(0.4, ge=0.05, le=1.0)
    face_steps: int = Field(20, ge=4, le=50)
    dlss: bool = False
    dlss_mode: Literal["1x", "1.5x", "1.724x", "2x", "3x"] = "1x"
    dlss_style: Literal["Default", "Natural", "Cinematic"] = "Default"
    dlss_intensity: float = Field(1.0, ge=0, le=2)
    upscaler: Literal["none", "seedvr2", "relayvsr"] = "none"
    seedvr2_model: str | None = Field(None, max_length=200)
    seedvr2_res: int = Field(1080, ge=256, le=4320)
    relay_detail: float = Field(0.45, ge=0, le=1)


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
    source: str | None = Field(None, max_length=2000)  # enhance: the picture or video to improve (a media ref)
    enhance_opts: EnhanceOpts | None = None  # engine "enhance": the chain
    enhance_of: str | None = Field(None, max_length=64)  # enhance: the studio item it came from
    enhance_after: dict[str, Any] | None = None  # set by the page: enhance this result when it's done (Settings)
    pose: str | None = Field(None, max_length=200)  # angles: "<azimuth> <elevation> <distance>" (workflows.ANGLE_*)
    clean_audio: bool = True  # clean them and keep the best 6-10 s of speech (H3RefAudioPrep, when installed)
    max_fidelity: bool = False  # reference pictures at 2048px instead of the output's size
    enhance: bool = False  # Klein prompt upsampler
    lyrics: str = Field("", max_length=20000)  # Music 3
    batch: int = Field(1, ge=1, le=4)  # number of takes (seeds seed, seed+1, ...)
    project: str | None = Field(None, max_length=64)  # project id; None = Experiment
    # AI reshoot (camera moves): guide frames + masks of the uncovered areas, and where they sit
    guides: list[str] = Field(default_factory=list, max_length=8)
    guide_masks: list[str] = Field(default_factory=list, max_length=8)
    guide_frames: list[int] = Field(default_factory=list, max_length=8)
    fill_prompt: str = Field("", max_length=8000)
    camera_clip: str | None = Field(None, max_length=64)


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
        tmp.replace(config.HISTORY_FILE)

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
        else:
            sets = [models.ALL_SETS["h3"], models.ALL_SETS["klein"]] if req.engine == "reshoot" else [models.ALL_SETS[req.engine]]
        files: dict[str, Any] = {}
        for mset in sets:
            resolved = models.resolve(mset, installed)
            if not resolved["ready"]:
                names = ", ".join(m["want"] for m in resolved["missing"])
                raise ValueError(f"{mset.title} is missing model files: {names}")
            files[mset.key] = resolved["files"]
        if req.engine == "enhance":
            await self._enhance_check(req, installed)
            files["relay"] = {"unet": next((n for n in installed.get("diffusion_models", []) if "relayvsr" in n.lower()), ""),
                              "vae": next((n for n in installed.get("vae", []) if "relayvsr" in n.lower()), "")}
            resolved = {"files": files}
        else:
            resolved = {"files": files if req.engine == "reshoot" else files[sets[0].key]}
        self._validate(req)
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
        if req.engine == "klein" and req.kind != "image":
            raise ValueError("FLUX 3 Klein only makes images")
        if req.engine == "music3" and req.kind != "audio":
            raise ValueError("Music 3 only makes audio")
        if req.engine == "reshoot":
            if req.kind != "video":
                raise ValueError("A reshoot makes video")
            if len(req.guides) < 2 or len(req.guides) != len(req.guide_masks) or len(req.guides) != len(req.guide_frames):
                raise ValueError("A reshoot needs at least two guide frames, each with a mask")
            for ref in (*req.guides, *req.guide_masks):
                media_path(ref)
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
        if not req.prompt.strip():
            raise ValueError("Prompt is empty")
        if req.aspect not in workflows.ASPECTS:
            raise ValueError(f"Unknown aspect ratio {req.aspect}")
        if req.ref_audios and req.engine != "h3ref":
            raise ValueError("Reference sounds (voice cloning) need the H3 Reference model")
        for ref in req.ref_audios:
            if media.kind_of(ref) not in ("audio", "video"):
                raise ValueError(f"A reference sound must be a sound or video file: {ref}")
        for ref in (req.first_frame, req.last_frame, *req.references, *req.ref_audios):
            if ref:
                media_path(ref)  # raises if invalid

    def _build(self, item: dict[str, Any], req: GenerateRequest, files: dict[str, str | None]) -> workflows.Built:
        seed = item["seed"]
        prefix = f"bob/{req.kind}/{item['id']}"
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
            )
        if req.engine == "klein":
            mp = workflows.KLEIN_QUALITY.get(req.quality, 1.0)
            w, h = workflows.dims_for(aspect, mp, multiple=16)
            return workflows.build_klein(
                files, prompt=req.prompt, width=w, height=h, seed=seed, steps=req.steps or 16,
                enhance=req.enhance, aspect_label=req.aspect, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
            )
        return workflows.build_music3(
            files, caption=req.prompt, lyrics=req.lyrics or "[Instrumental]", seconds=req.seconds, seed=seed,
            steps=req.steps or 30, prefix=prefix, loras=[(lu.name, lu.strength) for lu in req.loras],
        )

    async def _run(self, item: dict[str, Any], req: GenerateRequest, files: dict[str, str | None]) -> None:
        from comfy_sdk import JobFailed, OutputReady, Preview, Progress, StatusChange

        client = self.comfy.client
        try:
            t_start = time.time()
            built = self._build(item, req, files)
            item["info"] = built.info
            self.log(item, f"Built the {req.engine} workflow: {len(built.graph)} nodes"
                     + "".join(f", {k} {v}" for k, v in (built.info or {}).items() if isinstance(v, (int, float, str)) and len(str(v)) < 40))
            wf = client.workflows.from_json(built.graph)
            for role, node_id in built.image_inputs.items():
                field = "image"
                if role == "source":
                    ref, field = req.source, ("file" if media.kind_of(req.source or "") == "video" else "image")
                elif role.startswith("aref_"):
                    ref, field = req.ref_audios[int(role[5:])], "audio"
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

            # No `metadata=`: comfy-api-proxy 0.1.6 rejects the SDK's mapping form.
            job = await client.submit(wf)
            self._handles[item["id"]] = job
            self.log(item, f"Sent to ComfyUI (job {job.id})")
            self._update(item, status="queued", comfy_job=job.id, started=None)

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
                                self.log(item, f"Step {ev.step} of {ev.steps}")
                        # ev.value is the share of graph nodes done (loaders count), so
                        # during sampling report step progress, which is what users expect.
                        value = ev.step / ev.steps if ev.steps else ev.value
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

            self.log(item, "Downloading the results")
            saved = await self._download(item, done, built.outputs)
            self.log(item, f"Done in {time.time() - t_start:.1f} s: " + ", ".join(f"{f['name']} ({f['size'] / 2**20:.1f} MB)" for f in saved))
            self._update(item, status="done", files=saved, progress=1.0, finished=time.time())
            if req.enhance_after and req.engine != "enhance" and saved:
                asyncio.create_task(self._enhance_after(item))
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
            status = "cancelled" if type(exc).__name__ in ("Cancelled", "CancelledError") else "failed"
            self.log(item, f"{status.title()}: {_short_error(exc)[:400]}", "error")
            self._update(item, status=status, error=_short_error(exc), finished=time.time())
        finally:
            self._handles.pop(item["id"], None)
            self._tasks.pop(item["id"], None)

    async def _download(self, item: dict[str, Any], job: Any, output_nodes: list[str]) -> list[dict[str, Any]]:
        day = datetime.now().strftime("%Y-%m-%d")
        out_dir = config.OUTPUT_DIR / day
        out_dir.mkdir(parents=True, exist_ok=True)
        outputs = [o for n in output_nodes for o in job.get_outputs(n)] or list(job.outputs)
        saved = []
        for out in outputs:
            name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(out.name).name)
            target = out_dir / (name if name.startswith(item["id"]) else f"{item['id']}_{name}")
            await out.to_file(target)
            rel = target.relative_to(config.ROOT).as_posix()
            saved.append({
                "name": name,
                "path": rel,
                "url": "/" + rel,
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


def _short_error(exc: Exception) -> str:
    text = str(exc) or type(exc).__name__
    return text if len(text) < 1500 else text[:1500] + "…"
