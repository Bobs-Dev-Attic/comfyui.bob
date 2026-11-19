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
HF_KREA2 = "https://huggingface.co/Comfy-Org/Krea-2"
HF_MUSIC3 = "https://huggingface.co/Comfy-Org/MiniMax-Music-3"
HF_QWEN_EDIT = "https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI"
HF_H3_IMAGE = "https://huggingface.co/Comfy-Org/MiniMax-H3-Image"
HF_MOSS = "https://huggingface.co/Comfy-Org/MOSS-Image"


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
    # Words in a diffusion model's file name that mark it as made for this engine (fine-tunes
    # whose names don't match the slot's candidates), for the "Diffusion model" picker.
    unet_hints: tuple[str, ...] = ()


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

# Krea 2 Turbo, as ComfyUI's "Text to Image (Krea-2 Turbo)" blueprint runs it: the fp8 file first,
# then the bf16 original. The Qwen3-VL 4B text encoder is shared with Klein.
KREA2 = ModelSet(
    key="krea2",
    title="Krea 2 Turbo",
    source=HF_KREA2,
    unet_hints=("krea",),
    slots=(
        Slot("unet", "diffusion_models", ("krea2_turbo_fp8*", "krea-2-turbo*", "krea2_turbo*", "krea-2*"),
             label="Krea 2 Turbo diffusion model"),
        Slot("clip", "text_encoders", ("qwen3vl_4b*",), label="Qwen3-VL 4B text encoder"),
        Slot("vae", "vae", ("qwen_image_vae*",), label="Qwen Image VAE"),
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

# Angles: Qwen Image Edit 2511 re-shoots a picture from another camera angle with fal's
# multiple-angles LoRA ("<sks> <azimuth> <elevation> <distance>"), in 4 steps with Lightning.
# lightx2v's "_fp8_e4m3fn_scaled" file keeps per-channel scales ComfyUI doesn't read (it renders
# noise), so it isn't a candidate: convert it with scripts/convert_lightx2v_fp8.py.
ANGLES = ModelSet(
    key="angles",
    title="Qwen Image Edit 2511 · Angles",
    source=HF_QWEN_EDIT,
    slots=(
        Slot("unet", "diffusion_models", ("qwen_image_edit_2511_fp8_e4m3fn_plain*", "qwen_image_edit_2511_bf16*",
                                          "qwen_image_edit_2511_fp8mixed*", "qwen_image_edit_2511_fp8_e4m3fn.safetensors"),
             label="Qwen Image Edit 2511 (bf16, fp8mixed, or converted fp8)"),
        Slot("clip", "text_encoders", ("qwen_2.5_vl_7b*",), label="Qwen2.5-VL 7B text encoder"),
        Slot("vae", "vae", ("qwen_image_vae*",), label="Qwen Image VAE"),
        Slot("angles_lora", "loras", ("qwen-image-edit-2511-multiple-angles*",), label="Multiple-angles LoRA (fal)"),
        Slot("lightning_lora", "loras", ("qwen-image-edit-2511-lightning-4steps*", "qwen-image-edit-2511-lightning*"),
             optional=True, label="Lightning 4-step LoRA (else 20 steps)"),
    ),
)

# The image editor's Erase and Replace (not an engine of its own): Qwen Image Edit 2511 with the
# Lightning LoRA when installed; the same files Angles uses, without the angles LoRA. Erase also
# uses Krea 2's Qwen3-VL 4B text encoder, when installed, to name the background to fill with.
QWEN_EDIT = ModelSet(
    key="qwen_edit",
    title="Qwen Image Edit 2511",
    source=HF_QWEN_EDIT,
    slots=tuple(s for s in ANGLES.slots if s.key != "angles_lora")
    + (Slot("describer", "text_encoders", ("qwen3vl_4b*",), optional=True, label="Qwen3-VL 4B (names the background)"),),
)

# MiniMax H3 Image: MiniMax's image model (6 distilled steps), as a text-to-image engine and as the
# image editor's other edit model. It shares H3's Qwen3-VL 32B text encoder; its VAE is its own.
H3_IMAGE = ModelSet(
    key="h3image",
    title="MiniMax H3 Image",
    source=HF_H3_IMAGE,
    unet_hints=("h3_image", "h3-image"),
    slots=(
        Slot("unet", "diffusion_models", ("minimax_h3_image_pruned_int8*", "minimax_h3_image_pruned_w4a8*",
                                          "minimax_h3_image_pruned_bf16*", "minimax_h3_image*"), label="H3 Image diffusion model"),
        Slot("clip", "text_encoders", ("qwen3vl_32b_minimax_h3_nvfp4*", "qwen3vl_32b_minimax_h3*"), label="Qwen3-VL 32B text encoder"),
        Slot("vae", "vae", ("minimax_h3_image_vae*",), label="H3 Image VAE"),
        Slot("describer", "text_encoders", ("qwen3vl_4b*",), optional=True, label="Qwen3-VL 4B (names what to erase)"),
    ),
)

# MOSS-Image (OpenMOSS, Apache-2.0): a 5B image model with strong in-picture text, as ComfyUI's
# "MOSS-Image: Text to Image" template runs it. The SFT checkpoint first, then Base (int8 before bf16).
# Its text encoder is the plain Qwen3.5 9B w4a8 file (not Klein's flux3 upsampler), and its VAE the
# small FLUX.2 VAE (not flux2-vae itself).
MOSS = ModelSet(
    key="moss",
    title="MOSS-Image",
    source=HF_MOSS,
    unet_hints=("moss",),
    slots=(
        Slot("unet", "diffusion_models", ("moss_image_sft_int8*", "moss_image_sft*", "moss-image-sft*",
                                          "moss_image_base_int8*", "moss_image_base*", "moss-image-base*", "moss_image*", "moss-image*"),
             label="MOSS-Image diffusion model (SFT or Base)"),
        Slot("clip", "text_encoders", ("qwen3.5_9b_w4a8_gptq*",), label="Qwen3.5 9B text encoder (w4a8)"),
        Slot("vae", "vae", ("flux2-vae_small*", "flux2_vae_small*"), label="FLUX.2 small VAE"),
    ),
)

# MOSS Edit: ComfyUI's "MOSS-Image: Image Edit" template. The Moss-Image-Edit LoRA (chinoll) on a MOSS
# checkpoint (SFT first), the same text encoder and VAE; the pictures go into TextEncodeMOSSImageEdit.
MOSS_EDIT = ModelSet(
    key="mossedit",
    title="MOSS-Image Edit",
    source=HF_MOSS,
    unet_hints=("moss",),
    slots=MOSS.slots + (
        Slot("edit_lora", "loras", ("moss_image_edit_lora*", "moss-image-edit*", "moss_image_edit*"), label="MOSS-Image Edit LoRA"),
    ),
)

ALL_SETS = {s.key: s for s in (H3, H3REF, KLEIN, KREA2, H3_IMAGE, MOSS, MOSS_EDIT, MUSIC3, ANGLES)}


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


def _find(slot: Slot, names) -> str | None:
    for cand in slot.candidates:
        found = next((f for f in names if _match(cand, f)), None)
        if found:
            return found
    return None


def unet_choices(model_set: ModelSet, installed: dict[str, list[str]]) -> dict[str, list[str]] | None:
    """Diffusion models the user may swap in for this engine: those made for it first
    (they match the slot's candidates or the set's name hints), then every other one."""
    slot = next((s for s in model_set.slots if s.key == "unet"), None)
    if not slot:
        return None
    names = sorted(installed.get(slot.folder, []), key=str.lower)
    base = lambda n: n.replace("\\", "/").rsplit("/", 1)[-1].lower()  # noqa: E731
    fits = [n for n in names if any(_match(c, n) for c in slot.candidates) or any(h in base(n) for h in model_set.unet_hints)]
    return {"match": fits, "other": [n for n in names if n not in fits]}


def resolve(model_set: ModelSet, installed: dict[str, list[str]],
            disk: dict[str, dict[str, str]] | None = None) -> dict:
    """Match a model set against what ComfyUI reports.

    ``installed`` is ComfyUI's /models listing; only those files can be used.
    ``disk`` (from modelpaths.scan) adds files found in extra_model_paths.yaml
    folders, so a slot ComfyUI can't see reports where the file actually is.
    Returns {"ready", "files": {slot: name|None}, "missing": [...], "on_disk": n}.
    """
    files: dict[str, str | None] = {}
    missing: list[dict] = []
    for slot in model_set.slots:
        found = _find(slot, installed.get(slot.folder, []))
        files[slot.key] = found
        if found:
            continue
        local = disk.get(slot.folder, {}) if disk else {}
        hit = _find(slot, local)
        if hit or not slot.optional:
            missing.append({"slot": slot.key, "folder": slot.folder, "label": slot.label,
                            "want": slot.candidates[0], "optional": slot.optional,
                            "on_disk": local[hit] if hit else None})
    required = [m for m in missing if not m["optional"]]
    return {
        "key": model_set.key,
        "title": model_set.title,
        "ready": not required,
        "files": files,
        "missing": required,
        "optional_on_disk": [m for m in missing if m["optional"]],
        "all_on_disk": bool(required) and all(m["on_disk"] for m in required),
        "source": model_set.source,
    }
