"""Runtime settings, overridable through environment variables."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Native ComfyUI (used for model discovery, system stats, object_info).
COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")

# Comfy API v2 surface used by comfy-sdk. For a local ComfyUI this is
# comfy-api-proxy, which the app starts automatically if nothing answers here.
PROXY_URL = os.environ.get("COMFY_BASE_URL", "http://127.0.0.1:8189").rstrip("/")
AUTO_START_PROXY = os.environ.get("BOB_AUTO_START_PROXY", "1") != "0"

# Local LLM for the "Write for me" prompt helper: "ollama" or "openai" (any
# OpenAI-compatible server: llama.cpp llama-server, LM Studio, vLLM...). The UI can override both.
LLM_BACKEND = os.environ.get("BOB_LLM_BACKEND", "ollama")
LLM_URL = os.environ.get("BOB_LLM_URL", "http://127.0.0.1:8080")  # llama-server's default port
LLM_MODEL = os.environ.get("BOB_LLM_MODEL", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("BOB_OLLAMA_MODEL", "")  # empty = pick the smallest preferred model
OLLAMA_KEEP_ALIVE = os.environ.get("BOB_OLLAMA_KEEP_ALIVE", "0")  # "0" unloads after each call to free VRAM for H3

HOST = os.environ.get("BOB_HOST", "127.0.0.1")
PORT = int(os.environ.get("BOB_PORT", "8700"))

DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
PROXY_STATE_DIR = DATA_DIR / "proxy-state"
HISTORY_FILE = DATA_DIR / "history.json"
OUTPUT_DIR = ROOT / "outputs"
STATIC_DIR = ROOT / "static"

for _d in (DATA_DIR, UPLOAD_DIR, PROXY_STATE_DIR, OUTPUT_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def proxy_executable() -> str | None:
    """Locate the comfy-api-proxy console script (venv first, then PATH)."""
    scripts = Path(sys.executable).parent
    for name in ("comfy-api-proxy.exe", "comfy-api-proxy"):
        candidate = scripts / name
        if candidate.exists():
            return str(candidate)
    return shutil.which("comfy-api-proxy")
