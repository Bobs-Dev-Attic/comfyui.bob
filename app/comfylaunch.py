"""Start a local ComfyUI install when it isn't running (used by start.bat).

    python -m app.comfylaunch            # start it if needed, wait until it answers
    python -m app.comfylaunch --dry-run  # print the command only

Settings (in .env):

    BOB_COMFYUI_DIR   ComfyUI folder, or a ComfyUI_windows_portable folder
    BOB_COMFYUI_ARGS  extra arguments, e.g. "--use-pytorch-cross-attention --reserve-vram 4"

The Python used is the portable build's python_embeded, else a venv inside the
install, else the system Python. Host and port come from COMFYUI_URL. A yaml
in BOB_EXTRA_MODEL_PATHS is passed with --extra-model-paths-config unless it is
the install's own extra_model_paths.yaml, which ComfyUI loads by itself.

Exit codes: 0 ComfyUI is up, 1 it did not come up, 2 not configured.
"""
from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from . import config, modelpaths
from .syscheck import comfy_stats


@dataclass
class Install:
    root: Path  # folder the command runs in
    comfy: Path  # folder holding main.py
    python: str


def find_install(folder: str) -> Install | None:
    base = Path(folder).expanduser()
    for comfy in (base / "ComfyUI", base):
        if (comfy / "main.py").is_file():
            break
    else:
        return None
    candidates = [base / "python_embeded" / "python.exe", comfy.parent / "python_embeded" / "python.exe"]
    for venv in (".venv", "venv"):
        candidates += [comfy / venv / "Scripts" / "python.exe", comfy / venv / "bin" / "python"]
    python = next((str(p) for p in candidates if p.is_file()), None) or shutil.which("python") or sys.executable
    root = base if (base / "python_embeded").is_dir() else comfy
    return Install(root=root, comfy=comfy, python=python)


def build_command(inst: Install) -> list[str]:
    url = urlparse(config.COMFYUI_URL)
    cmd = [inst.python, "-s", str(inst.comfy / "main.py")]
    if (inst.root / "python_embeded").is_dir():
        cmd.append("--windows-standalone-build")
    cmd += ["--listen", url.hostname or "127.0.0.1", "--port", str(url.port or 8188), "--disable-auto-launch"]
    own = inst.comfy / "extra_model_paths.yaml"
    for y in modelpaths.yaml_files():
        try:
            same = own.is_file() and os.path.samefile(y, own)
        except OSError:
            same = False
        if not same and y.is_file():
            cmd += ["--extra-model-paths-config", str(y)]
    extra = shlex.split(config.COMFYUI_ARGS, posix=False)
    return cmd + [a for a in extra if a != "--windows-standalone-build"]


def launch(inst: Install) -> subprocess.Popen:
    """Run ComfyUI in its own console window so it keeps running after start.bat."""
    flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    return subprocess.Popen(build_command(inst), cwd=inst.root, creationflags=flags,
                            start_new_session=not flags)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Start ComfyUI for Bob Studio if it isn't running.")
    ap.add_argument("--wait", type=float, default=180, help="seconds to wait for ComfyUI to answer")
    ap.add_argument("--dry-run", action="store_true", help="print the command without running it")
    args = ap.parse_args(argv)

    if not config.COMFYUI_DIR:
        print("BOB_COMFYUI_DIR is not set in .env, so ComfyUI won't be started automatically.")
        return 2
    inst = find_install(config.COMFYUI_DIR)
    if not inst:
        print(f"No ComfyUI found in {config.COMFYUI_DIR} (expected ComfyUI\\main.py). Fix BOB_COMFYUI_DIR in .env.")
        return 2
    if args.dry_run:
        print(subprocess.list2cmdline(build_command(inst)))
        return 0
    if comfy_stats(timeout=2):
        print(f"ComfyUI is already running at {config.COMFYUI_URL}.")
        return 0

    print(f"Starting ComfyUI from {inst.comfy} ...")
    print("  " + subprocess.list2cmdline(build_command(inst)))
    proc = launch(inst)
    deadline = time.monotonic() + args.wait
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            print(f"ComfyUI exited with code {proc.returncode}. Check its window for the error.")
            return 1
        if comfy_stats(timeout=2):
            print(f"ComfyUI is up at {config.COMFYUI_URL} (pid {proc.pid}).")
            return 0
        time.sleep(2)
    print(f"ComfyUI didn't answer within {args.wait:.0f} s; it may still be loading. Check its window.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
