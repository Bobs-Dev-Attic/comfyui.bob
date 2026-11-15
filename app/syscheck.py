"""System check: is this machine ready to run Bob Studio?

Run it on its own before starting the app (start.bat does this):

    python -m app.syscheck            # human-readable report, exit 1 on any failure
    python -m app.syscheck --wait 60  # give ComfyUI up to 60 s to come up first
    python -m app.syscheck --json

The app serves the same report at GET /api/syscheck. Each check returns a
status: "ok", "warn" (works, but slower or limited), "fail" (won't work) or
"info".
"""
from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any, Callable

import httpx

from . import __version__, config, modelpaths, models

GB = 1024 ** 3

# H3 is the heaviest engine: ~20 GB of int8 weights plus the 32B text encoder.
# ComfyUI swaps weights between VRAM and system RAM, so both matter.
VRAM_FAIL_GB, VRAM_WARN_GB = 8, 16
RAM_FAIL_GB, RAM_WARN_GB = 16, 32
RAM_FREE_WARN_GB = 8
DISK_FAIL_GB, DISK_WARN_GB = 5, 20
PYTHON_MIN = (3, 11)
PACKAGES = {"comfy_sdk": "comfy-sdk", "fastapi": "fastapi", "uvicorn": "uvicorn", "PIL": "pillow",
            "httpx": "httpx", "multipart": "python-multipart"}


@dataclass
class Check:
    id: str
    label: str
    status: str  # ok | warn | fail | info
    detail: str
    fix: str = ""


def _gb(n: float) -> str:
    return f"{n / GB:.1f} GB"


# --------------------------------------------------------------------------- probes

def memory() -> tuple[int, int] | None:
    """(total, available) bytes of system RAM, without extra dependencies."""
    if sys.platform == "win32":
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(st)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return st.ullTotalPhys, st.ullAvailPhys
        return None
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0]) * 1024
        return info["MemTotal"], info.get("MemAvailable", info["MemFree"])
    except (OSError, KeyError, ValueError):
        try:
            pages, size = os.sysconf("SC_PHYS_PAGES"), os.sysconf("SC_PAGE_SIZE")
            return pages * size, pages * size
        except (ValueError, OSError, AttributeError):
            return None


def nvidia_gpus() -> list[dict[str, Any]] | None:
    """GPUs from nvidia-smi, or None if the tool isn't there."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total,memory.used,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4:
            gpus.append({"name": parts[0], "total": float(parts[1]) * 1024 ** 2,
                         "used": float(parts[2]) * 1024 ** 2, "driver": parts[3]})
    return gpus


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host if host not in ("0.0.0.0", "") else "127.0.0.1", port)) == 0


def comfy_stats(timeout: float = 3) -> dict[str, Any] | None:
    try:
        r = httpx.get(f"{config.COMFYUI_URL}/system_stats", timeout=timeout)
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError):
        return None


def comfy_models() -> dict[str, list[str]]:
    folders = sorted({s.folder for m in models.ALL_SETS.values() for s in m.slots})
    out: dict[str, list[str]] = {}
    with httpx.Client(timeout=10) as c:
        for f in folders:
            try:
                r = c.get(f"{config.COMFYUI_URL}/models/{f}")
                out[f] = r.json() if r.status_code == 200 else []
            except (httpx.HTTPError, ValueError):
                out[f] = []
    return out


# --------------------------------------------------------------------------- checks

def check_python() -> Check:
    v = sys.version_info
    ok = v[:2] >= PYTHON_MIN
    return Check("python", "Python", "ok" if ok else "fail", f"{platform.python_version()} ({sys.executable})",
                 "" if ok else f"Install Python {PYTHON_MIN[0]}.{PYTHON_MIN[1]}+ and recreate .venv")


def check_packages() -> Check:
    missing = [pip for mod, pip in PACKAGES.items() if importlib.util.find_spec(mod) is None]
    if missing:
        return Check("packages", "Python packages", "fail", "Missing: " + ", ".join(missing),
                     r"Run: .venv\Scripts\pip install -r requirements.txt")
    return Check("packages", "Python packages", "ok", "All required packages are installed")


def check_os() -> Check:
    return Check("os", "Operating system", "info",
                 f"{platform.system()} {platform.release()} ({platform.machine()}), {os.cpu_count()} CPU threads")


def check_ram() -> Check:
    mem = memory()
    if not mem:
        return Check("ram", "System memory", "warn", "Could not read system memory")
    total, avail = mem
    detail = f"{_gb(total)} total, {_gb(avail)} free"
    if total < RAM_FAIL_GB * GB:
        return Check("ram", "System memory", "fail", detail,
                     f"H3 needs at least {RAM_FAIL_GB} GB of RAM ({RAM_WARN_GB} GB+ recommended)")
    if total < RAM_WARN_GB * GB:
        return Check("ram", "System memory", "warn", detail,
                     f"{RAM_WARN_GB} GB+ is recommended: ComfyUI keeps H3 weights in RAM between runs")
    if avail < RAM_FREE_WARN_GB * GB:
        return Check("ram", "System memory", "warn", detail, "Little RAM is free; close other large apps")
    return Check("ram", "System memory", "ok", detail)


def check_gpu(stats: dict[str, Any] | None) -> Check:
    gpus = nvidia_gpus()
    if gpus:
        g = max(gpus, key=lambda x: x["total"])
        free = g["total"] - g["used"]
        detail = (f"{g['name']}, {_gb(g['total'])} VRAM ({_gb(free)} free now), driver {g['driver']}"
                  + (f" · {len(gpus)} GPUs" if len(gpus) > 1 else ""))
        total = g["total"]
    elif stats and stats.get("devices"):
        d = stats["devices"][0]
        if d.get("type") != "cuda":
            return Check("gpu", "GPU", "fail", f"ComfyUI is running on {d.get('type', 'CPU')}",
                         "H3 needs an NVIDIA GPU with CUDA; start ComfyUI on the GPU")
        total = d.get("vram_total", 0)
        detail = f"{d.get('name', 'CUDA device')}, {_gb(total)} VRAM"
    else:
        return Check("gpu", "GPU", "fail", "No NVIDIA GPU found (nvidia-smi is missing and ComfyUI is unreachable)",
                     "Install an NVIDIA GPU driver, or start ComfyUI so it can report the device")
    if total < VRAM_FAIL_GB * GB:
        return Check("gpu", "GPU", "fail", detail, f"H3 needs at least {VRAM_WARN_GB} GB of VRAM")
    if total < VRAM_WARN_GB * GB:
        return Check("gpu", "GPU", "warn", detail,
                     f"Below {VRAM_WARN_GB} GB: H3 will offload heavily and run slowly; FLUX 3 Klein is fine")
    return Check("gpu", "GPU", "ok", detail)


def check_disk() -> Check:
    target = config.OUTPUT_DIR if config.OUTPUT_DIR.exists() else config.ROOT
    usage = shutil.disk_usage(target)
    detail = f"{_gb(usage.free)} free of {_gb(usage.total)} on {target.anchor or target}"
    if usage.free < DISK_FAIL_GB * GB:
        return Check("disk", "Disk space", "fail", detail, f"Free at least {DISK_FAIL_GB} GB for outputs and uploads")
    if usage.free < DISK_WARN_GB * GB:
        return Check("disk", "Disk space", "warn", detail, f"Less than {DISK_WARN_GB} GB free; videos add up quickly")
    return Check("disk", "Disk space", "ok", detail)


def check_comfyui(stats: dict[str, Any] | None) -> Check:
    if not stats:
        return Check("comfyui", "ComfyUI", "fail", f"Not reachable at {config.COMFYUI_URL}",
                     "Run start.bat to start it from BOB_COMFYUI_DIR" if config.COMFYUI_DIR
                     else "Start ComfyUI first, or set BOB_COMFYUI_DIR in .env so start.bat starts it")
    sysinfo = stats.get("system", {})
    detail = f"{sysinfo.get('comfyui_version', '?')} at {config.COMFYUI_URL}, PyTorch {sysinfo.get('pytorch_version', '?')}"
    return Check("comfyui", "ComfyUI", "ok", detail)


def comfy_paths_config(stats: dict[str, Any] | None) -> list[str]:
    """The --extra-model-paths-config file(s) the running ComfyUI was started with."""
    argv = (stats or {}).get("system", {}).get("argv") or []
    out = []
    for i, a in enumerate(argv):
        if a == "--extra-model-paths-config":
            out += [x for x in argv[i + 1:] if not x.startswith("--")][:1]
        elif a.startswith("--extra-model-paths-config="):
            out.append(a.split("=", 1)[1])
    return out


def _same_file(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def check_model_paths(stats: dict[str, Any] | None) -> Check:
    files = modelpaths.yaml_files()
    if not files:
        return Check("model_paths", "Model folders", "info", "Using only the folders ComfyUI reports",
                     "Optional: set BOB_EXTRA_MODEL_PATHS in .env to your extra_model_paths.yaml")
    absent = [str(f) for f in files if not f.is_file()]
    if absent:
        return Check("model_paths", "Model folders", "warn", "Not found: " + ", ".join(absent),
                     "Fix BOB_EXTRA_MODEL_PATHS in .env")
    gone = modelpaths.missing_dirs()
    detail = f"{len(files)} paths file(s)" + (f"; {len(gone)} listed folder(s) don't exist" if gone else "")
    if not stats:
        return Check("model_paths", "Model folders", "ok", detail)
    # Compare by file name: the portable build loads its own yaml without any
    # command-line flag, so ComfyUI's argv can't tell us which folders it uses.
    visible = {n.replace("\\", "/").rsplit("/", 1)[-1].lower() for names in comfy_models().values() for n in names}
    on_disk = {name.rsplit("/", 1)[-1].lower() for files_ in modelpaths.scan().values() for name in files_}
    hidden = on_disk - visible
    if not hidden:
        return Check("model_paths", "Model folders", "ok", detail + "; ComfyUI sees every model file in them")
    used = comfy_paths_config(stats)
    detail += (f"; {len(hidden)} model file(s) on disk are not visible to the running ComfyUI"
               + (f" (started with {used[0]})" if used else ""))
    fix = (f"Close the running ComfyUI, then run start.bat to start {config.COMFYUI_DIR}" if config.COMFYUI_DIR
           else f'Start ComfyUI with --extra-model-paths-config "{files[0]}"')
    return Check("model_paths", "Model folders", "warn", detail, fix)


def check_models(stats: dict[str, Any] | None) -> Check:
    if not stats:
        return Check("models", "Models", "info", "Skipped: ComfyUI is not reachable")
    installed = comfy_models()
    disk = modelpaths.scan()
    ready, hidden, missing = [], [], []
    for mset in models.ALL_SETS.values():
        r = models.resolve(mset, installed, disk)
        if r["ready"]:
            ready.append(mset.title)
        elif r["all_on_disk"]:
            hidden.append(mset.title)
        else:
            missing.append(mset.title)
    detail = "Ready: " + (", ".join(ready) or "none")
    if hidden:
        detail += " · On disk but not loaded by ComfyUI: " + ", ".join(hidden)
    if missing:
        detail += " · Not installed: " + ", ".join(missing)
    fix = ("Start ComfyUI with your extra_model_paths.yaml to use the models on disk "
           "(see Model folders)") if hidden else ""
    if not ready:
        return Check("models", "Models", "fail", detail, fix or "Download the MiniMax H3 models (see README)")
    if not models.resolve(models.H3, installed)["ready"]:
        return Check("models", "Models", "warn", detail, fix or "The core MiniMax H3 models are missing")
    return Check("models", "Models", "warn" if hidden else "ok", detail, fix)


def check_proxy() -> Check:
    alive = port_in_use("127.0.0.1", int(config.PROXY_URL.rsplit(":", 1)[-1].split("/")[0] or 8189))
    exe = config.proxy_executable()
    if alive:
        return Check("proxy", "comfy-api-proxy", "ok", f"Running at {config.PROXY_URL}")
    if not exe:
        return Check("proxy", "comfy-api-proxy", "fail", "Not running and not installed",
                     r"Run: .venv\Scripts\pip install -r requirements.txt")
    if not config.AUTO_START_PROXY:
        return Check("proxy", "comfy-api-proxy", "fail", f"Not running at {config.PROXY_URL} and auto-start is off",
                     "Start it yourself or set BOB_AUTO_START_PROXY=1")
    return Check("proxy", "comfy-api-proxy", "ok", "Installed; the app starts it automatically")


def check_port() -> Check:
    if port_in_use(config.HOST, config.PORT):
        return Check("port", "App port", "warn", f"Port {config.PORT} is already in use",
                     f"Bob Studio may already be running at http://127.0.0.1:{config.PORT}, or set BOB_PORT")
    return Check("port", "App port", "ok", f"Port {config.PORT} is free")


def check_llm() -> Check:
    if config.LLM_BACKEND == "ollama":
        url, path, name = config.OLLAMA_URL, "/api/tags", "Ollama"
    else:
        url, path, name = config.LLM_URL, "/v1/models", "LLM server"
    try:
        r = httpx.get(f"{url.rstrip('/')}{path}", timeout=3)
        r.raise_for_status()
        j = r.json()
        n = len(j.get("models") or j.get("data") or [])
        return Check("llm", "Prompt writer", "ok", f"{name} at {url} with {n} model(s)")
    except (httpx.HTTPError, ValueError):
        return Check("llm", "Prompt writer", "info", f"{name} is not running at {url}",
                     "Optional: start it to use Write for me")


def run(include_port: bool = False) -> dict[str, Any]:
    stats = comfy_stats()
    probes: list[Callable[[], Check]] = [
        check_python, check_packages, check_os, check_ram, lambda: check_gpu(stats), check_disk,
        lambda: check_comfyui(stats), lambda: check_model_paths(stats), lambda: check_models(stats),
        check_proxy, check_llm,
    ]
    if include_port:
        probes.append(check_port)
    checks = []
    for probe in probes:
        try:
            checks.append(probe())
        except Exception as exc:  # a broken probe must never take the report down
            checks.append(Check(getattr(probe, "__name__", "check"), "Check", "warn", f"Could not run: {exc}"))
    worst = "fail" if any(c.status == "fail" for c in checks) else (
        "warn" if any(c.status == "warn" for c in checks) else "ok")
    return {"version": __version__, "status": worst, "time": time.time(), "checks": [asdict(c) for c in checks]}


# --------------------------------------------------------------------------- CLI

def _print(report: dict[str, Any]) -> None:
    color = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
    if color and sys.platform == "win32":
        os.system("")  # enable ANSI escapes in the Windows console
    tint = {"ok": "32", "warn": "33", "fail": "31", "info": "36"}
    tag = {"ok": " OK ", "warn": "WARN", "fail": "FAIL", "info": "INFO"}
    print(f"\nBob Studio {report['version']} - system check\n")
    plain = lambda s: s.replace(" · ", " | ").encode("ascii", "replace").decode()  # any console code page
    for c in report["checks"]:
        c = {**c, "detail": plain(c["detail"]), "fix": plain(c["fix"])}
        t = f"[{tag[c['status']]}]"
        if color:
            t = f"\033[{tint[c['status']]}m{t}\033[0m"
        print(f"  {t} {c['label']:<17} {c['detail']}")
        if c["fix"] and c["status"] in ("warn", "fail", "info"):
            print(f"         {'':<17} -> {c['fix']}")
    summary = {"ok": "All checks passed.", "warn": "Ready, with warnings.", "fail": "Some checks failed."}
    print(f"\n{summary[report['status']]}\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Check this machine before starting Bob Studio.")
    ap.add_argument("--wait", type=float, default=0, help="seconds to wait for ComfyUI to come up")
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    ap.add_argument("--no-port", action="store_true", help="skip the app port check")
    args = ap.parse_args(argv)
    if args.wait and not comfy_stats(timeout=2):
        print(f"Waiting up to {args.wait:.0f} s for ComfyUI at {config.COMFYUI_URL}...", flush=True)
        deadline = time.monotonic() + args.wait
        while time.monotonic() < deadline and not comfy_stats(timeout=2):
            time.sleep(2)
    report = run(include_port=not args.no_port)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print(report)
    return 1 if report["status"] == "fail" else 0


if __name__ == "__main__":
    sys.exit(main())
