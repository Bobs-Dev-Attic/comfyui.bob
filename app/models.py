"""Model requirements per generator, resolved against what ComfyUI has installed.

Each slot lists acceptable filenames in order of preference, so the app works
whether you downloaded the int8 or nvfp4 text encoder, the 8-step or 4-step
turbo LoRA, etc. Files are matched case-insensitively; a trailing ``*`` is a
prefix match.
"""
from __future__ import annotations

from dataclasses import dataclass, field

HF_H3 = "https://huggingface.co/Comfy-Org/MiniMax-H3"
HF_KLEIN = "https://huggingface.co/Comfy-Org"
HF_MUSIC3 = "https://huggingface.co/Comfy-Org/MiniMax-Music-3"


@dataclass(frozen=True)
class Slot:
    key: str
    folder: str
    candidates: tuple[str, ...]
    optional: bool = False
    label: str = ""


@dataclass(frozen=True)
class ModelSet:
    key: str
    title: str
    slots: tuple[Slot, ...]
    source: str = ""
    notes: str = ""
    extra: dict = field(default_factory=dict)


H3 = ModelSet(
    key="h3",
    title="MiniMax H3 (local)",
    source=HF_H3,
    slots=(
        Slot("unet", "diffusion_models", ("minimax_h3_fl2va*",), label="H3 diffusion model"),
        Slot("clip", "text_encoders", ("qwen3vl_32b_minimax_h3*",), label="Qwen3-VL 32B text encoder"),
        Slot("vae", "vae", ("minimax_h3_video_vae*",), label="H3 video VAE"),
        Slot("audio_vae", "vae", ("minimax_h3_audio_vae*",), label="H3 audio VAE"),
        Slot(
            "turbo_lora",
            "loras",
            ("minimax_h3_fl2v_*turbo_8step*", "minimax_h3_fl2v_*turbo_4step*", "minimax_h3*turbo*"),
            optional=True,
            label="Turbo LoRA (8/4-step)",
        ),
    ),
)

H3REF = ModelSet(
    key="h3ref",
    title="MiniMax H3 Reference (ref2va)",
    source=HF_H3,
    slots=(
        Slot("unet", "diffusion_models", ("minimax_h3_ref2va*",), label="H3 reference model (ref2va, ~19.5 GB)"),
        Slot("clip", "text_encoders", ("qwen3vl_32b_minimax_h3*",), label="Qwen3-VL 32B text encoder"),
        Slot("vae", "vae", ("minimax_h3_video_vae*",), label="H3 video VAE"),
        Slot("audio_vae", "vae", ("minimax_h3_audio_vae*",), label="H3 audio VAE"),
        Slot("turbo_lora", "loras", ("minimax_h3_ref2v_*turbo*",), optional=True, label="Ref2v turbo LoRA (4-step)"),
    ),
)

KLEIN = ModelSet(
    key="klein",
    title="FLUX 3 Image Klein",
    source=HF_KLEIN,
    slots=(
        Slot("unet", "diffusion_models", ("flux3-image-klein*",), label="FLUX 3 Klein diffusion model"),
        Slot("clip", "text_encoders", ("qwen3vl_4b*",), label="Qwen3-VL 4B text encoder"),
        Slot("vae", "vae", ("flux2-vae*",), label="FLUX 2 VAE"),
        Slot(
            "upsampler",
            "text_encoders",
            ("qwen3.5_9b_flux3_prompt_upsampler*",),
            optional=True,
            label="Prompt upsampler (Qwen3.5 9B)",
        ),
    ),
)

MUSIC3 = ModelSet(
    key="music3",
    title="MiniMax Music 3",
    source=HF_MUSIC3,
    slots=(
        Slot("unet", "diffusion_models", ("minimax_music3_dit_fp16*", "minimax_music3_dit*"), label="Music 3 DiT"),
        Slot("clip", "text_encoders", ("minimax_music3_text_encoder*",), label="Music 3 text encoder"),
        Slot("vae", "vae", ("minimax_music3_dav*",), label="Music 3 DAV (VAE)"),
    ),
)

ALL_SETS = {s.key: s for s in (H3, H3REF, KLEIN, MUSIC3)}


def _match(pattern: str, filename: str) -> bool:
    base = filename.replace("\\", "/").rsplit("/", 1)[-1].lower()
    pattern = pattern.lower()
    if "*" not in pattern:
        return base == pattern or base == pattern + ".safetensors"
    parts = pattern.split("*")
    pos = 0
    if not base.startswith(parts[0]):
        return False
    pos = len(parts[0])
    for part in parts[1:]:
        if not part:
            continue
        idx = base.find(part, pos)
        if idx < 0:
            return False
        pos = idx + len(part)
    return True


def resolve(model_set: ModelSet, installed: dict[str, list[str]]) -> dict:
    """Return {"ready": bool, "files": {slot: filename|None}, "missing": [...]}."""
    files: dict[str, str | None] = {}
    missing: list[dict] = []
    for slot in model_set.slots:
        found = None
        for cand in slot.candidates:
            found = next((f for f in installed.get(slot.folder, []) if _match(cand, f)), None)
            if found:
                break
        files[slot.key] = found
        if not found and not slot.optional:
            missing.append({"slot": slot.key, "folder": slot.folder, "label": slot.label, "want": slot.candidates[0]})
    return {
        "key": model_set.key,
        "title": model_set.title,
        "ready": not missing,
        "files": files,
        "missing": missing,
        "source": model_set.source,
    }
