"""Generation jobs: build a graph, submit it through comfy-sdk, stream progress, save outputs."""
from __future__ import annotations

import asyncio
import base64
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

from . import config, models, workflows
from .comfy import ComfyService

log = logging.getLogger("bob.jobs")

Kind = Literal["video", "image", "audio"]
Engine = Literal["h3", "h3ref", "klein", "music3"]


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
    max_fidelity: bool = False  # reference pictures at 2048px instead of the output's size
    enhance: bool = False  # Klein prompt upsampler
    lyrics: str = Field("", max_length=20000)  # Music 3
    batch: int = Field(1, ge=1, le=4)  # number of takes (seeds seed, seed+1, ...)


class JobManager:
    def __init__(self, comfy: ComfyService) -> None:
        self.comfy = comfy
        self.items: dict[str, dict[str, Any]] = {}
        self._handles: dict[str, Any] = {}  # item id -> AsyncJob
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: set[asyncio.Queue] = set()
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

    def _update(self, item: dict[str, Any], **changes: Any) -> None:
        item.update(changes)
        self._save()
        self._publish({"type": "item", "item": item})

    # ------------------------------------------------------------------ public API
    def list(self) -> list[dict[str, Any]]:
        return sorted(self.items.values(), key=lambda i: i["created"], reverse=True)

    def delete(self, item_id: str, delete_files: bool = False) -> bool:
        item = self.items.pop(item_id, None)
        if not item:
            return False
        if delete_files:
            for f in item.get("files", []):
                p = config.ROOT / f["path"]
                if p.is_file() and config.OUTPUT_DIR in p.resolve().parents:
                    p.unlink()
        self._save()
        self._publish({"type": "deleted", "id": item_id})
        return True

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
        mset = models.ALL_SETS[req.engine]
        resolved = models.resolve(mset, installed)
        if not resolved["ready"]:
            names = ", ".join(m["want"] for m in resolved["missing"])
            raise ValueError(f"{mset.title} is missing model files: {names}")
        self._validate(req)

        base_seed = req.seed if req.seed >= 0 else random.randint(0, 2**48)
        created = []
        for i in range(req.batch):
            item = {
                "id": uuid.uuid4().hex[:12],
                "kind": req.kind,
                "engine": req.engine,
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
            if not req.references:
                raise ValueError("Add at least one reference picture")
        if req.engine == "klein" and req.kind != "image":
            raise ValueError("FLUX 3 Klein only makes images")
        if req.engine == "music3" and req.kind != "audio":
            raise ValueError("Music 3 only makes audio")
        if not req.prompt.strip():
            raise ValueError("Prompt is empty")
        if req.aspect not in workflows.ASPECTS:
            raise ValueError(f"Unknown aspect ratio {req.aspect}")
        for ref in (req.first_frame, req.last_frame, *req.references):
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
                last_frame=bool(req.last_frame) and req.kind == "video", prefix=prefix,
            )
        if req.engine == "h3ref":
            mp = workflows.H3_QUALITY.get(req.quality, workflows.H3_QUALITY["draft"])
            w, h = workflows.dims_for(aspect, mp)
            return workflows.build_h3_ref(
                files, prompt=req.prompt, width=w, height=h, seconds=req.seconds, seed=seed,
                references=len(req.references), turbo=req.turbo, steps=req.steps,
                max_fidelity=req.max_fidelity, prefix=prefix,
            )
        if req.engine == "klein":
            mp = workflows.KLEIN_QUALITY.get(req.quality, 1.0)
            w, h = workflows.dims_for(aspect, mp, multiple=16)
            return workflows.build_klein(
                files, prompt=req.prompt, width=w, height=h, seed=seed, steps=req.steps or 16,
                enhance=req.enhance, aspect_label=req.aspect, prefix=prefix,
            )
        return workflows.build_music3(
            files, caption=req.prompt, lyrics=req.lyrics or "[Instrumental]", seconds=req.seconds, seed=seed,
            steps=req.steps or 30, prefix=prefix,
        )

    async def _run(self, item: dict[str, Any], req: GenerateRequest, files: dict[str, str | None]) -> None:
        from comfy_sdk import JobFailed, OutputReady, Preview, Progress, StatusChange

        client = self.comfy.client
        try:
            built = self._build(item, req, files)
            item["info"] = built.info
            wf = client.workflows.from_json(built.graph)
            for role, node_id in built.image_inputs.items():
                ref = req.references[int(role[4:])] if role.startswith("ref_") else getattr(req, role)
                wf.set_input(node_id, "image", client.assets.from_file(media_path(ref)))

            # No `metadata=`: comfy-api-proxy 0.1.6 rejects the SDK's mapping form.
            job = await client.submit(wf)
            self._handles[item["id"]] = job
            self._update(item, status="queued", comfy_job=job.id, started=None)

            async def pump_events() -> None:
                last_preview = 0.0
                async for ev in job.events():
                    if isinstance(ev, Progress):
                        if item["status"] != "running":
                            self._update(item, status="running", started=time.time())
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
                            self._update(item, status="running", started=time.time())
                        elif ev.status in ("queued", "pending"):
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

            saved = await self._download(item, done, built.outputs)
            self._update(item, status="done", files=saved, progress=1.0, finished=time.time())
        except JobFailed as exc:
            status = "cancelled" if "cancel" in str(exc).lower() else "failed"
            self._update(item, status=status, error=_short_error(exc), finished=time.time())
        except Exception as exc:  # network errors, invalid workflow, etc.
            log.exception("job %s failed", item["id"])
            status = "cancelled" if type(exc).__name__ in ("Cancelled", "CancelledError") else "failed"
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


def media_path(ref: str) -> Path:
    """Resolve a media ref from the browser to a file inside uploads/ or outputs/ only."""
    ref = ref.lstrip("/")
    p = (config.ROOT / ref).resolve()
    allowed = (config.UPLOAD_DIR.resolve(), config.OUTPUT_DIR.resolve())
    if not any(a in p.parents for a in allowed) or not p.is_file():
        raise ValueError(f"Unknown media: {ref}")
    return p


def _short_error(exc: Exception) -> str:
    text = str(exc) or type(exc).__name__
    return text if len(text) < 1500 else text[:1500] + "…"
