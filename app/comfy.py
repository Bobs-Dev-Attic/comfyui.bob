"""Connection to the local ComfyUI.

Two surfaces are used:

* **comfy-sdk** (``AsyncComfy``) for everything job-shaped: uploading inputs as
  assets, submitting workflows, live progress/preview events, cancelling, and
  downloading outputs. Locally the SDK talks to ``comfy-api-proxy`` (Comfy API
  v2), which this module starts on demand.
* **Native ComfyUI REST** for things the v2 surface does not cover: installed
  model lists, system stats, node availability, and freeing VRAM.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import time
from typing import Any

import httpx

from . import config

log = logging.getLogger("bob.comfy")


class ComfyService:
    def __init__(self) -> None:
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0))
        self.client = None  # comfy_sdk.AsyncComfy, created in start()
        self._proxy_proc: subprocess.Popen | None = None
        self._models_cache: tuple[float, dict[str, list[str]]] | None = None
        self._node_types: set[str] | None = None
        self.samplers: list[str] = []    # KSampler's sampler and scheduler names (filled by node_types)
        self.schedulers: list[str] = []

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        if not await self.proxy_alive() and config.AUTO_START_PROXY:
            await self._spawn_proxy()
        os.environ["COMFY_BASE_URL"] = config.PROXY_URL
        from comfy_sdk import AsyncComfy  # imported late so COMFY_BASE_URL is set

        self.client = AsyncComfy(timeout=60.0, client_info="comfyui-bob-studio")

    async def stop(self) -> None:
        if self.client is not None:
            await self.client.aclose()
        await self.http.aclose()
        if self._proxy_proc and self._proxy_proc.poll() is None:
            self._proxy_proc.terminate()
            try:
                self._proxy_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proxy_proc.kill()

    async def _spawn_proxy(self) -> None:
        exe = config.proxy_executable()
        if not exe:
            log.warning("comfy-api-proxy not found; install it with `pip install comfy-api-proxy`")
            return
        port = httpx.URL(config.PROXY_URL).port or 8189
        cmd = [
            exe, "run",
            "--comfyui", config.COMFYUI_URL,
            "--port", str(port),
            "--state-dir", str(config.PROXY_STATE_DIR),
            "--max-upload-mb", "500",
        ]
        log.info("starting comfy-api-proxy: %s", " ".join(cmd))
        logfile = open(config.DATA_DIR / "proxy.log", "ab")  # noqa: SIM115 - lives as long as the proxy
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self._proxy_proc = subprocess.Popen(cmd, stdout=logfile, stderr=subprocess.STDOUT, creationflags=flags)
        for _ in range(60):
            if await self.proxy_alive():
                log.info("comfy-api-proxy is up at %s", config.PROXY_URL)
                return
            if self._proxy_proc.poll() is not None:
                break
            await asyncio.sleep(0.25)
        log.error("comfy-api-proxy did not come up; see data/proxy.log")

    # ------------------------------------------------------------------ health
    async def proxy_alive(self) -> bool:
        try:
            r = await self.http.get(f"{config.PROXY_URL}/api/v2/health", timeout=2.0)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    async def system_stats(self) -> dict[str, Any] | None:
        try:
            r = await self.http.get(f"{config.COMFYUI_URL}/system_stats", timeout=3.0)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError:
            return None

    async def queue_size(self) -> dict[str, int] | None:
        try:
            r = await self.http.get(f"{config.COMFYUI_URL}/queue", timeout=3.0)
            r.raise_for_status()
            q = r.json()
            return {"running": len(q.get("queue_running", [])), "pending": len(q.get("queue_pending", []))}
        except httpx.HTTPError:
            return None

    # ------------------------------------------------------------------ models
    async def installed_models(self, refresh: bool = False) -> dict[str, list[str]]:
        now = time.monotonic()
        if not refresh and self._models_cache and now - self._models_cache[0] < 30:
            return self._models_cache[1]
        folders = ("diffusion_models", "checkpoints", "text_encoders", "vae", "loras", "background_removal")
        results = await asyncio.gather(
            *(self.http.get(f"{config.COMFYUI_URL}/models/{f}", timeout=10.0) for f in folders),
            return_exceptions=True,
        )
        out: dict[str, list[str]] = {}
        for folder, res in zip(folders, results):
            out[folder] = res.json() if isinstance(res, httpx.Response) and res.status_code == 200 else []
        self._models_cache = (now, out)
        return out

    async def node_types(self) -> set[str]:
        if self._node_types is None:
            r = await self.http.get(f"{config.COMFYUI_URL}/object_info", timeout=60.0)
            r.raise_for_status()
            info = r.json()
            self._node_types = set(info.keys())
            # The sampler and scheduler names this ComfyUI offers (KSampler's own lists).
            req = (info.get("KSampler") or {}).get("input", {}).get("required", {})
            pick = lambda k: list(req.get(k, [[]])[0]) if req.get(k) and isinstance(req[k][0], list) else []  # noqa: E731
            self.samplers, self.schedulers = pick("sampler_name"), pick("scheduler")
        return self._node_types

    async def free_vram(self) -> bool:
        try:
            r = await self.http.post(
                f"{config.COMFYUI_URL}/free", json={"unload_models": True, "free_memory": True}, timeout=10.0
            )
            return r.status_code == 200
        except httpx.HTTPError:
            return False
