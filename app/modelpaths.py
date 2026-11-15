"""Find model files on disk from ComfyUI ``extra_model_paths.yaml`` files.

ComfyUI only reports the models of the folders it was started with. Reading
the same yaml files lets the studio find models that exist on this machine but
that the running ComfyUI can't see, and say how to fix that.

Set the files in .env (local, gitignored), separated by ``;``:

    BOB_EXTRA_MODEL_PATHS=C:/path/to/ComfyUI/extra_model_paths.yaml

Paths follow ComfyUI's rules: a section may set ``base_path``; relative paths
resolve against it, or against the yaml's own folder when there is none. The
``models/`` folder next to each yaml (that ComfyUI install's own) is included.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import yaml

from . import config

log = logging.getLogger("bob.modelpaths")

MODEL_EXTS = {".safetensors", ".sft", ".gguf", ".ckpt", ".pt", ".pth", ".bin"}
# Legacy folder names ComfyUI maps onto the current ones.
ALIASES = {"unet": "diffusion_models", "clip": "text_encoders"}
SKIP_KEYS = {"base_path", "is_default", "custom_nodes", "configs"}
CACHE_SECONDS = 60

_cache: tuple[float, dict] | None = None


def yaml_files() -> list[Path]:
    return [Path(p.strip()).expanduser() for p in config.EXTRA_MODEL_PATHS.split(";") if p.strip()]


def folders_from_yaml(path: Path) -> dict[str, list[Path]]:
    """{folder: [directories]} as ComfyUI would read them from one yaml file."""
    try:
        data = yaml.safe_load(path.read_text("utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        log.warning("cannot read %s: %s", path, exc)
        return {}
    root = path.resolve().parent
    out: dict[str, list[Path]] = {}
    for section in data.values():
        if not isinstance(section, dict):
            continue
        base = section.get("base_path")
        base_dir = (root / Path(str(base)).expanduser()) if base else None
        for key, value in section.items():
            if key in SKIP_KEYS or value is None:
                continue
            folder = ALIASES.get(key, key)
            for line in str(value).splitlines():
                line = line.strip()
                if not line:
                    continue
                p = Path(line).expanduser()
                if not p.is_absolute():
                    p = (base_dir or root) / p
                out.setdefault(folder, []).append(p)
    # That install's own models folder, which ComfyUI always uses.
    own = root / "models"
    if own.is_dir():
        for sub in own.iterdir():
            if sub.is_dir():
                out.setdefault(ALIASES.get(sub.name, sub.name), []).append(sub)
    return out


def all_folders() -> dict[str, list[Path]]:
    merged: dict[str, list[Path]] = {}
    for f in yaml_files():
        for folder, dirs in folders_from_yaml(f).items():
            for d in dirs:
                if d not in merged.setdefault(folder, []):
                    merged[folder].append(d)
    return merged


def scan(refresh: bool = False) -> dict[str, dict[str, str]]:
    """{folder: {relative name: absolute path}} for model files on disk.

    Relative names use "/" like ComfyUI's /models API (e.g. "minimaxh3/x.safetensors").
    """
    global _cache
    now = time.monotonic()
    if not refresh and _cache and now - _cache[0] < CACHE_SECONDS:
        found = _cache[1]
    else:
        found = {}
        from .models import ALL_SETS  # only the folders our engines use

        wanted = {s.folder for m in ALL_SETS.values() for s in m.slots}
        for folder, dirs in all_folders().items():
            if folder not in wanted:
                continue
            files: dict[str, str] = {}
            for d in dirs:
                if not d.is_dir():
                    continue
                for dirpath, _dirs, names in os.walk(d, followlinks=True):
                    for name in names:
                        if os.path.splitext(name)[1].lower() in MODEL_EXTS:
                            full = Path(dirpath) / name
                            files.setdefault(full.relative_to(d).as_posix(), str(full))
            found[folder] = files
        _cache = (now, found)
    return found


def missing_dirs() -> list[str]:
    return sorted({str(d) for dirs in all_folders().values() for d in dirs if not d.is_dir()})
