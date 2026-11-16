"""LoRAs for the LoRA browser: what's installed, what each one is for, and its details.

ComfyUI's /models/loras gives the names it can load (the names graphs must use). Each is
matched to its file through the model folders (modelpaths.scan) and its safetensors header is
read, never the weights, for:

- family: which model it's for, from the metadata (modelspec.architecture, ss_base_model_version),
  then the tensor names (each model family names its layers differently), then the folder and
  file name;
- kind: lora / lokr / loha, or "refmod" (Fantastic RefMod reference embeddings: they need the
  RefMod nodes and can't be applied as a LoRA), or "other";
- title, trigger words, description, rank, training base, and a preview picture when one sits
  next to the file (name.png, name.preview.png, ...) or in a CivitAI sidecar.

Results are cached by path, size and modified time in data/lora_cache.json.
"""
from __future__ import annotations

import json
import logging
import struct
import threading
from pathlib import Path
from typing import Any

from . import config, modelpaths

log = logging.getLogger("bob.loras")
CACHE_FILE = config.DATA_DIR / "lora_cache.json"
PREVIEW_EXTS = (".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp", ".png", ".jpg", ".jpeg", ".webp")
FAMILIES = {
    "h3": "MiniMax H3", "flux2": "FLUX 2 / Klein", "krea2": "Krea 2", "wan": "Wan 2.x", "qwen-image": "Qwen Image",
    "ltx": "LTX", "flux1": "FLUX 1", "sdxl": "SDXL", "sd15": "SD 1.5", "hunyuan": "Hunyuan", "music3": "Music 3", "unknown": "Unknown",
}
# The engines of this studio and the LoRA families that fit them.
ENGINE_FAMILIES = {"h3": {"h3"}, "h3ref": {"h3"}, "klein": {"flux2"}, "krea2": {"krea2"}, "music3": {"music3"}}
_lock = threading.Lock()
_mem: dict[str, Any] | None = None


def _load_cache() -> dict[str, Any]:
    global _mem
    if _mem is None:
        try:
            _mem = json.loads(CACHE_FILE.read_text("utf-8"))
        except (OSError, ValueError):
            _mem = {}
    return _mem


def _save_cache() -> None:
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_mem or {}, separators=(",", ":")), "utf-8")
        tmp.replace(CACHE_FILE)
    except OSError:
        log.warning("couldn't write the LoRA cache")


def _header(path: Path) -> dict[str, Any]:
    with path.open("rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n <= 0 or n > 100_000_000:
            raise ValueError("not a safetensors header")
        return json.loads(f.read(n))


def _family(md: dict[str, Any], keys: list[str], name: str) -> str:
    text = " ".join(str(md.get(k, "")) for k in ("modelspec.architecture", "ss_base_model_version", "modelspec.title", "ss_sd_model_name")).lower()
    for fam, needles in (("h3", ("minimax", "h3")), ("flux2", ("klein", "flux.2", "flux-2", "flux2", "flux3", "flux.3")),
                         ("krea2", ("krea",)), ("wan", ("wan",)), ("qwen-image", ("qwen",)), ("ltx", ("ltx",)),
                         ("hunyuan", ("hunyuan",)), ("sdxl", ("sdxl", "sd_xl", "xl_base")), ("sd15", ("sd_v1", "sd1", "v1-5")),
                         ("flux1", ("flux",))):
        if any(n in text for n in needles):
            return fam
    k = " ".join(keys[:60])
    if ".attn.out_proj." in k or ".attn.qkv_proj." in k:
        return "h3"
    if ".attn.gate." in k:
        return "krea2"
    if ".cross_attn.k." in k or ".self_attn.q." in k:
        return "wan"
    if "transformer_blocks." in k and (".attn.to_k" in k or ".attn.add_k_proj" in k) and "single_transformer_blocks" not in k:
        return "qwen-image"
    if "double_blocks." in k or "single_blocks." in k or "single_transformer_blocks." in k:
        return "flux2" if "klein" in name.lower() or "flux2" in name.lower() else "flux1"
    if "lora_unet_" in k or "down_blocks" in k or "input_blocks" in k:
        return "sdxl" if "xl" in name.lower() else "sd15"
    low = name.lower().replace("\\", "/")
    for fam, needles in (("h3", ("minimax", "h3_", "_h3", "/h3")), ("krea2", ("krea",)), ("wan", ("wan",)), ("qwen-image", ("qwen",)),
                         ("ltx", ("ltx",)), ("flux2", ("klein", "flux2")), ("flux1", ("flux",)), ("sdxl", ("sdxl",))):
        if any(n in low for n in needles):
            return fam
    return "unknown"


def _kind(md: dict[str, Any], keys: list[str]) -> str:
    if "refmod_meta" in md or keys == ["latent"]:
        return "refmod"
    k = " ".join(keys[:80])
    if "lokr_" in k:
        return "lokr"
    if "hada_" in k:
        return "loha"
    if "lora_" in k or "lora." in k or ".alpha" in k:
        return "lora"
    return "other"


def _triggers(md: dict[str, Any], side: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for w in side.get("trainedWords") or []:
        out += [x.strip() for x in str(w).split(",") if x.strip()]
    tp = md.get("modelspec.trigger_phrase")
    if tp:
        out += [x.strip() for x in str(tp).split(",") if x.strip()]
    if len(out) < 3 and md.get("ss_tag_frequency"):
        try:
            freq: dict[str, int] = {}
            for tags in json.loads(md["ss_tag_frequency"]).values():
                for t, c in tags.items():
                    freq[t.strip()] = freq.get(t.strip(), 0) + int(c)
            out += [t for t, _ in sorted(freq.items(), key=lambda kv: -kv[1])[:6] if t]
        except (ValueError, AttributeError, TypeError):
            pass
    seen, uniq = set(), []
    for w in out:
        if w.lower() not in seen and len(w) <= 60:
            seen.add(w.lower())
            uniq.append(w)
    return uniq[:10]


def _sidecar(path: Path) -> dict[str, Any]:
    base = path.with_suffix("")
    for ext in (".civitai.info", ".json", ".metadata.json"):
        p = Path(str(base) + ext)
        if p.is_file() and p.stat().st_size < 2_000_000:
            try:
                d = json.loads(p.read_text("utf-8", errors="replace"))
                if isinstance(d, dict):
                    return d
            except ValueError:
                pass
    return {}


def preview_path(path: Path) -> Path | None:
    base = str(path.with_suffix(""))
    for ext in PREVIEW_EXTS:
        p = Path(base + ext)
        if p.is_file():
            return p
    return None


def _describe(name: str, path: Path) -> dict[str, Any]:
    st = path.stat()
    info: dict[str, Any] = {"size": st.st_size, "mtime": st.st_mtime}
    try:
        h = _header(path)
    except (OSError, ValueError, struct.error) as exc:
        info.update(family="unknown", kind="other", error=str(exc)[:200])
        return info
    md = {k: v for k, v in (h.get("__metadata__") or {}).items() if isinstance(v, str)}
    keys = [k for k in h if k != "__metadata__"]
    side = _sidecar(path)
    rank = None
    for k in keys:
        if k.endswith("lora_A.weight") or k.endswith("lora_down.weight"):
            shape = h[k].get("shape") or []
            rank = min(shape) if shape else None
            break
    desc = md.get("modelspec.description") or side.get("description") or (side.get("model") or {}).get("description") or ""
    info.update(
        family=_family(md, keys, name), kind=_kind(md, keys),
        title=md.get("modelspec.title") or side.get("name") or (side.get("model") or {}).get("name") or md.get("ss_output_name") or "",
        base=md.get("modelspec.architecture") or md.get("ss_base_model_version") or (side.get("baseModel") or ""),
        triggers=_triggers(md, side), description=str(desc)[:600], rank=rank or (int(md["ss_network_dim"]) if str(md.get("ss_network_dim", "")).isdigit() else None),
        tensors=len(keys), trainer=md.get("software") or md.get("ss_training_comment") or "",
    )
    return info


def scan(comfy_names: list[str], refresh: bool = False) -> list[dict[str, Any]]:
    """All LoRAs ComfyUI can load, with their details (cached)."""
    files = modelpaths.scan(refresh=refresh).get("loras", {})
    out = []
    with _lock:
        cache = _load_cache()
        changed = False
        for name in comfy_names:
            key = name.replace("\\", "/")
            path = Path(files[key]) if key in files else None
            row: dict[str, Any] = {"name": name, "path": key, "folder": key.rsplit("/", 1)[0] if "/" in key else "",
                                   "file": key.rsplit("/", 1)[-1]}
            if path and path.is_file():
                st = path.stat()
                ck = f"{path}|{st.st_size}|{st.st_mtime_ns}"
                info = cache.get(ck)
                if info is None or refresh:
                    info = _describe(name, path)
                    cache[ck] = info
                    changed = True
                row.update(info)
                row["preview"] = preview_path(path) is not None
            else:
                row.update(family=_family({}, [], name), kind="lora", size=None, mtime=None, preview=False, missing_file=True)
            row["family_label"] = FAMILIES.get(row.get("family", "unknown"), "Unknown")
            row["turbo"] = "turbo" in key.lower() and row.get("family") == "h3"  # the studio applies these itself
            out.append(row)
        if changed:
            _save_cache()
    return out


def metadata(path: Path) -> dict[str, Any]:
    """The full __metadata__ block (values cut at 20k characters) and a summary of the tensors."""
    try:
        h = _header(path)
    except struct.error as exc:
        raise ValueError(str(exc)) from exc
    md = {k: (v if isinstance(v, str) else json.dumps(v))[:20000] for k, v in (h.get("__metadata__") or {}).items()}
    keys = [k for k in h if k != "__metadata__"]
    dtypes = sorted({str(h[k].get("dtype")) for k in keys if isinstance(h[k], dict)})
    return {"metadata": dict(sorted(md.items())), "tensors": len(keys), "dtypes": dtypes}


def find_path(name: str) -> Path | None:
    key = name.replace("\\", "/")
    p = modelpaths.scan().get("loras", {}).get(key)
    return Path(p) if p else None
