"""API-format graph builders.

The graphs mirror the official ComfyUI templates (``video_minimax_h3_t2v``,
``video_minimax_h3_i2v``, ``image_flux3_klein_distilled_t2i``, the "Text to Image (Krea-2 Turbo)" blueprint and
``audio_minimax_music_3``) with their subgraphs flattened, so they run on the
local models through the plain API format the comfy-sdk submits.

Every builder returns a :class:`Built` holding the graph, the node ids whose
outputs we collect, and the node ids that take uploaded images (filled in with
SDK asset handles by the caller).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

FPS = 24

ASPECTS: dict[str, tuple[int, int]] = {
    "16:9": (16, 9),
    "9:16": (9, 16),
    "1:1": (1, 1),
    "4:3": (4, 3),
    "3:4": (3, 4),
    "3:2": (3, 2),
    "2:3": (2, 3),
    "21:9": (21, 9),
}

# H3's trained canvas is a 768px short edge (1344x768 at 16:9, ~0.98 MP).
H3_QUALITY = {"draft": 0.4, "standard": 0.6, "full": 0.98}
H3_AUDIO_ONLY_MP = 0.2  # sound-only runs don't need pixels; keep the latent small
KLEIN_QUALITY = {"draft": 0.5, "standard": 1.0, "high": 2.0}
KREA2_QUALITY = {"draft": 0.5, "standard": 1.0, "high": 2.0}


def dims_for(aspect: tuple[float, float], megapixels: float, multiple: int = 32) -> tuple[int, int]:
    """Same math as ComfyUI's ResolutionSelector (1 MP = 1024*1024)."""
    aw, ah = aspect
    area = megapixels * 1024 * 1024
    w = math.sqrt(area * aw / ah)
    h = w * ah / aw
    snap = lambda v: max(multiple, int(round(v / multiple)) * multiple)  # noqa: E731
    return snap(w), snap(h)


def h3_length(seconds: float) -> int:
    """Seconds -> frame count on H3's 17k+5 grid at 24 fps (template formula)."""
    a = max(5, round(seconds * FPS))
    return a + (5 - (a % 17)) % 17


class Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self._next = 1

    def add(self, class_type: str, **inputs: Any) -> str:
        nid = str(self._next)
        self._next += 1
        self.nodes[nid] = {"class_type": class_type, "inputs": inputs}
        return nid

    @staticmethod
    def out(nid: str, slot: int = 0) -> list:
        return [nid, slot]


def chain_loras(g: "Graph", model: str, loras: list[tuple[str, float]] | None) -> str:
    """LoraLoaderModelOnly per chosen LoRA (name as ComfyUI lists it, strength), after the
    model and any turbo LoRA. Returns the last node id."""
    for name, strength in loras or []:
        if abs(float(strength)) < 1e-6:
            continue
        model = g.add("LoraLoaderModelOnly", model=[model, 0], lora_name=name, strength_model=float(strength))
    return model


@dataclass
class Built:
    graph: dict[str, Any]
    outputs: list[str]
    image_inputs: dict[str, str] = field(default_factory=dict)  # role -> LoadImage node id
    info: dict[str, Any] = field(default_factory=dict)


# --------------------------------------------------------------------------- H3

def h3_frame_alignment(first: bool, last: bool, frames: int) -> str:
    """Lead-in line H3 needs to honour keyframes (it ignores a last frame without it).

    Wording follows MiniMax's h3-prompt-writing guide as used by iv-studio.
    """
    if first and last:
        return (
            "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the "
            "0.00-second mark of the target video; Picture 2 (from the final shot) aligns with the "
            f"{(frames - 1) / FPS:.2f}-second mark of the target video."
        )
    if first:
        return ("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) "
                "is fully referenced.")
    if last:
        return (f"For the target video, at {(frames - 1) / FPS:.2f} seconds into the target video, <Picture 1> "
                "(from the final shot) is fully referenced.")
    return ""


def build_h3(
    files: dict[str, str | None],
    *,
    output: str,  # "video" | "audio" | "image"
    prompt: str,
    width: int,
    height: int,
    seconds: float,
    seed: int,
    turbo: bool,
    steps: int | None = None,
    first_frame: bool = False,
    last_frame: bool = False,
    prefix: str = "bob/h3",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    g = Graph()
    o = Graph.out

    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    model = unet
    use_turbo = turbo and bool(files.get("turbo_lora"))
    if use_turbo:
        model = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=files["turbo_lora"], strength_model=1.0)
        lora = files["turbo_lora"].lower()
        default_steps = 4 if "4step" in lora else 8
    else:
        default_steps = 20
    n_steps = int(steps or default_steps)
    model = chain_loras(g, model, loras)

    clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])

    length = 5 if output == "image" else h3_length(seconds)
    lead = h3_frame_alignment(first_frame, last_frame, length)
    if lead and "aligns with" not in prompt and "fully referenced" not in prompt:
        prompt = f"{lead}\n\n{prompt}"
    cond_inputs: dict[str, Any] = dict(
        clip=o(clip), vae=o(vae), prompt=prompt, width=width, height=height, length=length
    )
    image_inputs: dict[str, str] = {}
    for role, wanted in (("first_frame", first_frame), ("last_frame", last_frame)):
        if wanted:
            load = g.add("LoadImage", image="")  # filled with an SDK asset by the caller
            image_inputs[role] = load
            scaled = g.add("ImageScale", image=o(load), upscale_method="lanczos", width=width, height=height, crop="center")
            cond_inputs[role] = o(scaled)
    cond = g.add("MiniMaxH3ImageToVideo", **cond_inputs)

    noise = g.add("RandomNoise", noise_seed=int(seed))
    sampler = g.add("KSamplerSelect", sampler_name="res_multistep")
    sigmas = g.add("BasicScheduler", model=o(model), scheduler="simple", steps=n_steps, denoise=1.0)
    guider = g.add("BasicGuider", model=o(model), conditioning=o(cond, 0))
    latent = g.add(
        "SamplerCustomAdvanced",
        noise=o(noise), guider=o(guider), sampler=o(sampler), sigmas=o(sigmas), latent_image=o(cond, 1),
    )

    outputs: list[str] = []
    if output in ("video", "audio"):
        audio_vae = g.add("VAELoader", vae_name=files["audio_vae"])
        audio = g.add("VAEDecodeAudio", samples=o(latent), vae=o(audio_vae))
    if output == "video":
        frames = g.add("VAEDecode", samples=o(latent), vae=o(vae))
        video = g.add("CreateVideo", images=o(frames), audio=o(audio), fps=float(FPS))
        outputs.append(g.add("SaveVideo", video=o(video), filename_prefix=prefix, format="auto", codec="auto"))
    elif output == "audio":
        outputs.append(g.add("SaveAudioMP3", audio=o(audio), filename_prefix=prefix, quality="V0"))
    elif output == "image":
        frames = g.add("VAEDecode", samples=o(latent), vae=o(vae))
        still = g.add("ImageFromBatch", image=o(frames), batch_index=0, length=1)
        outputs.append(g.add("SaveImage", images=o(still), filename_prefix=prefix))
    else:
        raise ValueError(f"unknown H3 output {output!r}")

    return Built(
        graph=g.nodes,
        outputs=outputs,
        image_inputs=image_inputs,
        info={"width": width, "height": height, "frames": length, "steps": n_steps, "turbo": use_turbo,
              "final_prompt": prompt,
              "seconds": round(length / FPS, 2) if output != "image" else None},
    )


H3_MAX_REFS = 9


def _listed(tags: list[str]) -> str:
    return tags[0] if len(tags) == 1 else ", ".join(tags[:-1]) + " and " + tags[-1]


def h3_reference_lead(count: int) -> str:
    """Default sentence naming the reference pictures, used when the prompt has no tags."""
    tags = [f"<Picture {i}>" for i in range(1, count + 1)]
    return f"Use {_listed(tags)} as reference{'s' if count > 1 else ''} for the characters, objects and style."


def h3_audio_lead(count: int) -> str:
    """Default sentence naming the reference sounds, used when the prompt has no <Audio> tags."""
    tags = [f"<Audio {i}>" for i in range(1, count + 1)]
    return (f"Use {_listed(tags)} as the voice reference{'s' if count > 1 else ''}: whoever speaks keeps "
            f"{'that voice' if count == 1 else 'the matching voice'}, its timbre, accent and delivery.")


def build_h3_ref(
    files: dict[str, str | None],
    *,
    prompt: str,
    width: int,
    height: int,
    seconds: float,
    seed: int,
    references: int,
    turbo: bool,
    steps: int | None = None,
    max_fidelity: bool = False,
    audios: int = 0,
    clean_audio: bool = True,
    prefix: str = "bob/h3ref",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    """Reference-to-video (template ``video_minimax_h3_r2v``): 0-9 reference pictures and
    0-3 reference sounds (voices to clone), at least one of either.

    Reference images are tagged in connection order as <Picture 1>, <Picture 2>... and sounds
    as <Audio 1>... The node sizes pictures itself (``match`` = down to the generation's area;
    ``max`` = 2048px short edge, sharper identity but several times slower). With clean_audio,
    each sound goes through H3RefAudioPrep first: noise removal and the best 6-10 s window of
    speech, which is what voice cloning works best from.
    """
    if not 0 <= references <= H3_MAX_REFS or not 0 <= audios <= 3 or references + audios == 0:
        raise ValueError(f"Reference-to-video takes 1 to {H3_MAX_REFS} pictures and/or 1 to 3 sounds")
    g = Graph()
    o = Graph.out

    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    model = unet
    use_turbo = turbo and bool(files.get("turbo_lora"))
    if use_turbo:
        model = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=files["turbo_lora"], strength_model=1.0)
        lora = files["turbo_lora"].lower()
        default_steps = 8 if "8step" in lora else 4
    else:
        default_steps = 20
    n_steps = int(steps or default_steps)
    model = chain_loras(g, model, loras)

    clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    audio_vae = g.add("VAELoader", vae_name=files["audio_vae"])

    leads = []
    if references and "<Picture" not in prompt:
        leads.append(h3_reference_lead(references))
    if audios and "<Audio" not in prompt:
        leads.append(h3_audio_lead(audios))
    if leads:
        prompt = " ".join(leads) + f"\n\n{prompt}"
    length = h3_length(seconds)
    cond_inputs: dict[str, Any] = dict(
        clip=o(clip), vae=o(vae), audio_vae=o(audio_vae), prompt=prompt, width=width, height=height,
        length=length, ref_image_size="max" if max_fidelity else "match",
    )
    image_inputs: dict[str, str] = {}
    for i in range(references):
        load = g.add("LoadImage", image="")  # filled with an SDK asset by the caller
        image_inputs[f"ref_{i}"] = load
        cond_inputs[f"ref_images.ref_image_{i}"] = o(load)  # autogrow input: <group>.<slot>
    for i in range(audios):
        load = g.add("LoadAudio", audio="")  # filled with an SDK asset by the caller (audio or a video's soundtrack)
        image_inputs[f"aref_{i}"] = load
        src = o(load)
        if clean_audio:
            src = o(g.add("H3RefAudioPrep", audio=src, clean="voice_focus", crop_mode="best_window", target_seconds=8.0,
                          max_seconds=10.0, max_pause_seconds=0.8, fade_ms=25, normalize_peak_db=-3.0, snap_to_latent_grid=True))
        cond_inputs[f"ref_audios.ref_audio_{i}"] = src
    cond = g.add("MiniMaxH3ReferenceToVideo", **cond_inputs)

    noise = g.add("RandomNoise", noise_seed=int(seed))
    sampler = g.add("KSamplerSelect", sampler_name="res_multistep")
    # The template notes say beta beats simple for reference-heavy prompts, which holds for
    # full sampling. The turbo LoRA is distilled for simple: with beta at 4 steps the video
    # comes out blown-out and streaked (tested 2026-11-15, same seed and prompt).
    scheduler = "simple" if use_turbo else "beta"
    sigmas = g.add("BasicScheduler", model=o(unet), scheduler=scheduler, steps=n_steps, denoise=1.0)
    guider = g.add("BasicGuider", model=o(model), conditioning=o(cond, 0))
    latent = g.add(
        "SamplerCustomAdvanced",
        noise=o(noise), guider=o(guider), sampler=o(sampler), sigmas=o(sigmas), latent_image=o(cond, 1),
    )
    audio = g.add("VAEDecodeAudio", samples=o(latent), vae=o(audio_vae))
    frames = g.add("VAEDecode", samples=o(latent), vae=o(vae))
    video = g.add("CreateVideo", images=o(frames), audio=o(audio), fps=float(FPS))
    save = g.add("SaveVideo", video=o(video), filename_prefix=prefix, format="auto", codec="auto")
    return Built(
        graph=g.nodes,
        outputs=[save],
        image_inputs=image_inputs,
        info={"width": width, "height": height, "frames": length, "steps": n_steps, "turbo": use_turbo,
              "references": references, "audios": audios, "clean_audio": bool(audios and clean_audio),
              "max_fidelity": max_fidelity, "scheduler": scheduler, "final_prompt": prompt,
              "seconds": round(length / FPS, 2)},
    )


# ------------------------------------------------------------------ FLUX 3 Klein

KLEIN_UPSAMPLER_SYSTEM = (
    "You are the prompt upsampler of a text-to-image model. Expand the user's short request into ONE "
    "detailed, self-contained caption: the exact text the image model receives. Output only the caption, "
    "with no greetings, explanations, refusals, questions, Markdown, headings, JSON, coordinates, ids or "
    "angle-bracket tokens, and no quotes around it. The request may begin with a \"TARGET CANVAS: W:H\" line: "
    "compose for that canvas and never mention the ratio or the canvas. Keep every explicit subject, attribute, "
    "count, spatial constraint, style cue and piece of wording. Without a stated style, plan an actual photograph. "
    "Lead with medium and style, then scene, lighting and camera, then the subjects with concrete colors, "
    "materials and state. Transcribe any requested text verbatim inside double quotes. All prose is English. "
    "Typical length is 100 to 350 words.\n\nOutput only the caption."
)


def build_klein(
    files: dict[str, str | None],
    *,
    prompt: str,
    width: int,
    height: int,
    seed: int,
    steps: int = 16,
    enhance: bool = False,
    aspect_label: str = "1:1",
    prefix: str = "bob/klein",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    g = Graph()
    o = Graph.out
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="flux3", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])

    text: Any = prompt
    use_enhance = enhance and bool(files.get("upsampler"))
    if use_enhance:
        up = g.add("CLIPLoader", clip_name=files["upsampler"], type="flux3", device="default")
        text = o(g.add(
            "TextGenerate",
            clip=o(up),
            prompt=f"TARGET CANVAS: {aspect_label}\n{prompt}",
            system_prompt=KLEIN_UPSAMPLER_SYSTEM,
            max_length=3584,
            sampling_mode="off",
            thinking=False,
            use_default_template=True,
        ))
    pos = g.add("CLIPTextEncode", clip=o(clip), text=text)
    neg = g.add("CLIPTextEncode", clip=o(clip), text="")
    empty = g.add("EmptyFlux2LatentImage", width=width, height=height, batch_size=1)
    sampled = g.add(
        "KSampler",
        model=o(chain_loras(g, unet, loras)), seed=int(seed), steps=int(steps), cfg=1.0, sampler_name="euler", scheduler="simple",
        positive=o(pos), negative=o(neg), latent_image=o(empty), denoise=1.0,
    )
    decoded = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
    save = g.add("SaveImage", images=o(decoded), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save],
                 info={"width": width, "height": height, "steps": steps, "enhanced": use_enhance})


# ------------------------------------------------------------------ Krea 2 Turbo

# The prompt expander of ComfyUI's "Text to Image (Krea-2 Turbo)" blueprint: the Krea 2 text
# encoder (Qwen3-VL 4B) rewrites the request, and the user's words follow this text.
KREA2_ENHANCE_PROMPT = (
    "You are an expert prompt engineer for text-to-image models. Your task is to expand the user's prompt into a "
    "highly effective image-generation prompt.\n\n"
    "Follow these rules strictly:\n"
    "1. Faithfulness First: Preserve all original subjects, actions, colors, and spatial relationships. Do not add "
    "new objects, props, characters, or animals unless the user clearly implies them.\n"
    "2. Practical T2I Structure: Group subjects with their own attributes and actions. Use grounded phrasing for "
    "poses, interactions, and spatial layout.\n"
    "3. Text Rendering: If the user requests visible text, specify the exact text and wrap requested words in quotes.\n"
    "4. Avoid Over-Specification: Do not invent highly specific clothing, colors, materials, or scene details unless "
    "the input supports them.\n"
    "5. Structure: Write one cohesive paragraph. No bullets, JSON, markdown, or planning notes.\n"
    "6. Respect Existing Detail: If the prompt is already detailed, lightly polish rather than heavily expand.\n"
    "7. Preserve User Medium: When the user names a medium (photo, illustration, painting, 3D render), honor it.\n\n"
    "User's Input:\n\n"
)


def build_krea2(
    files: dict[str, str | None],
    *,
    prompt: str,
    width: int,
    height: int,
    seed: int,
    steps: int | None = None,
    enhance: bool = False,
    prefix: str = "bob/krea2",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    """Krea 2 Turbo text-to-image: 8 steps, cfg 1, euler/simple, zeroed negative (blueprint defaults)."""
    g = Graph()
    o = Graph.out
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="krea2", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])

    text: Any = prompt
    if enhance:
        text = o(g.add(
            "TextGenerate",
            clip=o(clip),
            prompt=KREA2_ENHANCE_PROMPT + prompt,
            max_length=512,
            sampling_mode="on",  # a dynamic combo: its sub-inputs go in flat as "sampling_mode.<name>"
            **{f"sampling_mode.{k}": v for k, v in (("temperature", 0.7), ("top_k", 64), ("top_p", 0.95), ("min_p", 0.05),
                                                    ("repetition_penalty", 1.05), ("seed", int(seed) % (2**63)))},
            thinking=False,
            use_default_template=True,
        ))
    pos = g.add("CLIPTextEncode", clip=o(clip), text=text)
    neg = g.add("ConditioningZeroOut", conditioning=o(pos))
    empty = g.add("EmptyLatentImage", width=width, height=height, batch_size=1)
    sampled = g.add(
        "KSampler",
        model=o(chain_loras(g, unet, loras)), seed=int(seed), steps=int(steps), cfg=1.0, sampler_name="euler", scheduler="simple",
        positive=o(pos), negative=o(neg), latent_image=o(empty), denoise=1.0,
    )
    decoded = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
    save = g.add("SaveImage", images=o(decoded), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save],
                 info={"width": width, "height": height, "steps": steps, "enhanced": enhance})


# ------------------------------------------------------------------- Angles (Qwen Image Edit 2511)

# fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA: "<sks> <azimuth> <elevation> <distance>".
ANGLE_AZIMUTHS = ["front view", "front-right quarter view", "right side view", "back-right quarter view",
                  "back view", "back-left quarter view", "left side view", "front-left quarter view"]
ANGLE_ELEVATIONS = ["low-angle shot", "eye-level shot", "elevated shot", "high-angle shot"]
ANGLE_DISTANCES = ["close-up", "medium shot", "wide shot"]


# The LoRA alone tends to turn back-quarter views into side profiles; spelling out what the camera
# sees fixes that (tested on 2511 + Lightning, same seed).
ANGLE_HINTS = {
    "back-right quarter view": "The camera is behind the person, over their right shoulder: we see mostly the back of "
                               "the head and hair, the face is turned away from the camera, only the edge of the cheek shows.",
    "back-left quarter view": "The camera is behind the person, over their left shoulder: we see mostly the back of "
                              "the head and hair, the face is turned away from the camera, only the edge of the cheek shows.",
}


def angle_prompt(pose: str, extra: str = "") -> str:
    pose = pose.strip()
    hint = next((v for k, v in ANGLE_HINTS.items() if pose.startswith(k)), "")
    rest = " ".join(x for x in (hint, extra.strip()) if x)
    return f"<sks> {pose}" + (f". {rest}" if rest else "")


def build_angles(
    files: dict[str, str | None],
    *,
    pose: str,
    prompt: str = "",
    seed: int,
    steps: int | None = None,
    megapixels: float = 1.0,
    strength: float = 0.9,
    prefix: str = "bob/angles",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    """One picture of the reference from another camera angle. image_inputs: ref_0."""
    g = Graph()
    o = Graph.out
    model = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="qwen_image", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    fast = bool(files.get("lightning_lora"))
    if fast:
        model = g.add("LoraLoaderModelOnly", model=o(model), lora_name=files["lightning_lora"], strength_model=1.0)
    model = g.add("LoraLoaderModelOnly", model=o(model), lora_name=files["angles_lora"], strength_model=float(strength))
    model = chain_loras(g, model, loras)
    model = g.add("ModelSamplingAuraFlow", model=o(model), shift=3.1)
    model = g.add("CFGNorm", model=o(model), strength=1.0)
    load = g.add("LoadImage", image="")  # filled with an SDK asset by the caller
    ref = g.add("ImageScaleToTotalPixels", image=o(load), upscale_method="lanczos", megapixels=float(megapixels), resolution_steps=16)
    text = angle_prompt(pose, prompt)
    pos = g.add("TextEncodeQwenImageEditPlus", clip=o(clip), prompt=text, vae=o(vae), image1=o(ref))
    neg = g.add("TextEncodeQwenImageEditPlus", clip=o(clip), prompt="", vae=o(vae), image1=o(ref))
    pos = g.add("FluxKontextMultiReferenceLatentMethod", conditioning=o(pos), reference_latents_method="index_timestep_zero")
    neg = g.add("FluxKontextMultiReferenceLatentMethod", conditioning=o(neg), reference_latents_method="index_timestep_zero")
    latent = g.add("VAEEncode", pixels=o(ref), vae=o(vae))
    n_steps = int(steps or (4 if fast else 20))
    sampled = g.add("KSampler", model=o(model), positive=o(pos), negative=o(neg), latent_image=o(latent), seed=int(seed),
                    steps=n_steps, cfg=1.0 if fast else 4.0, sampler_name="euler", scheduler="simple", denoise=1.0)
    decoded = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
    save = g.add("SaveImage", images=o(decoded), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs={"ref_0": load},
                 info={"pose": pose, "steps": n_steps, "final_prompt": text, "megapixels": megapixels})


# ------------------------------------------------------------------- AI reshoot

def build_reshoot(
    h3: dict[str, str | None],
    klein: dict[str, str | None],
    *,
    prompt: str,
    fill_prompt: str,
    width: int,
    height: int,
    seconds: float,
    seed: int,
    turbo: bool,
    guide_frames: list[int],
    references: int = 0,
    steps: int = 8,
    klein_steps: int = 12,
    prefix: str = "bob/reshoot",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    """Regenerate a shot along a new camera move.

    Guide frames are the original picture warped to the new camera, with masks of the areas
    the move uncovers. FLUX Klein fills those areas (the frame and any reference pictures are
    Klein references, so the fill continues the scene), the filled frames are pasted back over
    the untouched pixels, and MiniMax H3 makes the video: the first and last guides as its first
    and last frames, the ones between as guides at their frame positions."""
    g = Graph()
    o = Graph.out
    image_inputs: dict[str, str] = {}

    k_unet = g.add("UNETLoader", unet_name=klein["unet"], weight_dtype="default")
    k_clip = g.add("CLIPLoader", clip_name=klein["clip"], type="flux3", device="default")
    k_vae = g.add("VAELoader", vae_name=klein["vae"])
    k_pos = g.add("CLIPTextEncode", clip=o(k_clip), text=fill_prompt)
    k_neg = g.add("CLIPTextEncode", clip=o(k_clip), text="")
    ref_lats = []
    for i in range(references):
        load = g.add("LoadImage", image="")
        image_inputs[f"ref_{i}"] = load
        scaled = g.add("ImageScale", image=o(load), upscale_method="lanczos", width=width, height=height, crop="center")
        ref_lats.append(g.add("VAEEncode", pixels=o(scaled), vae=o(k_vae)))
    filled = []
    for i, _ in enumerate(guide_frames):
        load = g.add("LoadImage", image="")
        image_inputs[f"guide_{i}"] = load
        mload = g.add("LoadImageMask", image="", channel="red")
        image_inputs[f"mask_{i}"] = mload
        img = g.add("ImageScale", image=o(load), upscale_method="lanczos", width=width, height=height, crop="disabled")
        mask = g.add("GrowMask", mask=o(mload), expand=6, tapered_corners=True)
        lat = g.add("VAEEncode", pixels=o(img), vae=o(k_vae))
        noised = g.add("SetLatentNoiseMask", samples=o(lat), mask=o(mask))
        cond = g.add("ReferenceLatent", conditioning=o(k_pos), latent=o(lat))
        for r in ref_lats:
            cond = g.add("ReferenceLatent", conditioning=o(cond), latent=o(r))
        sampled = g.add("KSampler", model=o(k_unet), seed=int(seed) + i, steps=int(klein_steps), cfg=1.0, sampler_name="euler",
                        scheduler="simple", positive=o(cond), negative=o(k_neg), latent_image=o(noised), denoise=1.0)
        decoded = g.add("VAEDecode", samples=o(sampled), vae=o(k_vae))
        filled.append(g.add("ImageCompositeMasked", destination=o(img), source=o(decoded), x=0, y=0, resize_source=False, mask=o(mask)))

    unet = g.add("UNETLoader", unet_name=h3["unet"], weight_dtype="default")
    model = unet
    use_turbo = turbo and bool(h3.get("turbo_lora"))
    if use_turbo:
        model = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=h3["turbo_lora"], strength_model=1.0)
        default_steps = 4 if "4step" in h3["turbo_lora"].lower() else 8
    else:
        default_steps = 20
    n_steps = int(steps or default_steps)
    model = chain_loras(g, model, loras)
    clip = g.add("CLIPLoader", clip_name=h3["clip"], type="minimax", device="default")
    vae = g.add("VAELoader", vae_name=h3["vae"])
    length = h3_length(seconds)
    lead = h3_frame_alignment(True, True, length)
    text = f"{lead}\n\n{prompt}"
    cond = g.add("MiniMaxH3ImageToVideo", clip=o(clip), vae=o(vae), prompt=text, width=width, height=height, length=length,
                 first_frame=o(filled[0]), last_frame=o(filled[-1]))
    positive = o(cond, 0)
    for img, frame in list(zip(filled, guide_frames))[1:-1]:
        positive = o(g.add("MiniMaxH3AddGuide", positive=positive, latent=o(cond, 1), frame_idx=int(min(frame, length - 1)),
                           vae=o(vae), image=o(img)))
    noise = g.add("RandomNoise", noise_seed=int(seed))
    sampler = g.add("KSamplerSelect", sampler_name="res_multistep")
    sigmas = g.add("BasicScheduler", model=o(model), scheduler="simple", steps=n_steps, denoise=1.0)
    guider = g.add("BasicGuider", model=o(model), conditioning=positive)
    latent = g.add("SamplerCustomAdvanced", noise=o(noise), guider=o(guider), sampler=o(sampler), sigmas=o(sigmas),
                   latent_image=o(cond, 1))
    audio_vae = g.add("VAELoader", vae_name=h3["audio_vae"])
    audio = g.add("VAEDecodeAudio", samples=o(latent), vae=o(audio_vae))
    frames = g.add("VAEDecode", samples=o(latent), vae=o(vae))
    video = g.add("CreateVideo", images=o(frames), audio=o(audio), fps=float(FPS))
    save = g.add("SaveVideo", video=o(video), filename_prefix=prefix, format="auto", codec="auto")
    return Built(graph=g.nodes, outputs=[save], image_inputs=image_inputs,
                 info={"width": width, "height": height, "frames": length, "steps": n_steps, "turbo": use_turbo,
                       "guides": len(guide_frames), "references": references, "final_prompt": text,
                       "seconds": round(length / FPS, 2)})


# ------------------------------------------------------------------- Enhance / upscale

DLSS_MODES = {"1x": "1x (DLAA / native)", "1.5x": "1.5x (Quality)", "1.724x": "1.724x (Balanced)", "2x": "2x (Performance)",
              "3x": "3x (Ultra Performance)"}


def build_enhance(
    *,
    video: bool,
    has_audio: bool,
    opts: dict[str, Any],
    seed: int,
    prompt: str = "",
    h3: dict[str, str | None] | None = None,
    references: int = 0,
    audios: int = 0,
    clean_audio: bool = True,
    relay: dict[str, str] | None = None,
    loras: list[tuple[str, float]] | None = None,
    prefix: str = "bob/enhance",
) -> Built:
    """Improve a finished picture or video, in this order (each step optional):

    1. FaceRefine (video): ComfyUI-H3-FaceRefine. Faces are tracked and cropped to a steady
       768 px canvas, the crops are encoded into an H3 audio+video latent next to the original
       sound (audio lock), and H3 Reference re-samples them at a low denoise with the source's
       own prompt, reference pictures/sounds and LoRAs, more where faces are small; the refined
       faces are stitched back.
    2. DLSS 5 (ComfyUI-DLSS5-Enhancer): NVIDIA neural rendering per frame, in playback order,
       at 1x (look only) or upscaling 1.5-3x.
    3. An upscaler: SeedVR2 (diffusion restoration to a target short side, 3B or 7B) or RelayVSR
       x2 (a Wan-based video super-resolution model, one step).
    """
    g = Graph()
    o = Graph.out
    image_inputs: dict[str, str] = {}
    src = g.add("LoadVideo" if video else "LoadImage", **({"file": ""} if video else {"image": ""}))
    image_inputs["source"] = src
    if video:
        comps = g.add("GetVideoComponents", video=o(src))
        images, audio, fps = o(comps, 0), o(comps, 1), o(comps, 2)
    else:
        images, audio, fps = o(src, 0), None, None
    steps_done = []

    if opts.get("facerefine") and video and h3:
        unet = g.add("UNETLoader", unet_name=h3["unet"], weight_dtype="default")
        model = chain_loras(g, unet, loras)
        clip = g.add("CLIPLoader", clip_name=h3["clip"], type="minimax", device="default")
        vae = g.add("VAELoader", vae_name=h3["vae"])
        avae = g.add("VAELoader", vae_name=h3["audio_vae"])
        track = g.add("H3FaceTrackCrop", images=images, detector=opts.get("face_detector") or "bbox\\face_yolov8m.pt", confidence=0.35,
                      crop_factor=3.0, canvas_width=768, canvas_height=768, canvas_mode="auto_capped_768", smooth_window=21,
                      size_smooth_window=51, smooth_method="gaussian", size_mode="per_frame", identity_track=True, identity_threshold=0.28,
                      select="largest_face", fallback_detector="face_yolov8m.pt", fallback_head_frac=0.5, select_index=0,
                      identity_model="insightface", cut_detection="none", cut_threshold=3.0, absent_shots="off", X=0, Y=0, frame_index=0)
        lead = []
        if references and "<Picture" not in prompt:
            lead.append(h3_reference_lead(references))
        if audios and "<Audio" not in prompt:
            lead.append(h3_audio_lead(audios))
        text = (" ".join(lead) + "\n\n" + prompt) if lead else prompt
        cond_inputs: dict[str, Any] = dict(clip=o(clip), vae=o(vae), audio_vae=o(avae), prompt=text or "A person.", width=o(track, 4),
                                           height=o(track, 5), length=o(track, 6), ref_image_size="match")
        for i in range(references):
            load = g.add("LoadImage", image="")
            image_inputs[f"ref_{i}"] = load
            cond_inputs[f"ref_images.ref_image_{i}"] = o(load)
        for i in range(audios):
            load = g.add("LoadAudio", audio="")
            image_inputs[f"aref_{i}"] = load
            a = o(load)
            if clean_audio:
                a = o(g.add("H3RefAudioPrep", audio=a, clean="voice_focus", crop_mode="best_window", target_seconds=8.0, max_seconds=10.0,
                            max_pause_seconds=0.8, fade_ms=25, normalize_peak_db=-3.0, snap_to_latent_grid=True))
            cond_inputs[f"ref_audios.ref_audio_{i}"] = a
        cond = g.add("MiniMaxH3ReferenceToVideo", **cond_inputs)
        lat = o(g.add("H3InjectVideoLatent", av_latent=o(cond, 1), images=o(track, 0), vae=o(vae)), 0)
        mdl = o(model)
        if has_audio:
            lock = g.add("MiniMaxH3NativeAudioLock", model=mdl, av_latent=lat, audio_vae=o(avae), audio=audio)
            mdl, lat = o(lock, 0), o(lock, 1)
        pfd = g.add("H3PerFrameDenoise", model=mdl, av_latent=lat, transform=o(track, 1), denoise_multiplier_small_face=1.0,
                    denoise_multiplier_large_face=0.35, scale_mode="absolute_px", face_px_small=30.0, face_px_large=120.0, gamma=1.0,
                    smooth_frames=9)
        sigmas = g.add("BasicScheduler", model=o(pfd, 2), scheduler="simple", steps=int(opts.get("face_steps", 20)),
                       denoise=float(opts.get("face_strength", 0.4)))
        guider = g.add("BasicGuider", model=o(pfd, 2), conditioning=o(cond, 0))
        sampled = g.add("SamplerCustomAdvanced", noise=o(g.add("RandomNoise", noise_seed=int(seed))), guider=o(guider),
                        sampler=o(g.add("KSamplerSelect", sampler_name="res_multistep")), sigmas=o(sigmas), latent_image=o(pfd, 0))
        faces = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
        images = o(g.add("H3FaceStitch", base_images=images, refined_crops=o(faces), transform=o(track, 1), paste_region="face_only",
                         mask_dilation=24, feather=24, colour_match=1.0, blend=1.0, undetected_frames="fade_out", feather_scales_with_crop=False))
        steps_done.append("facerefine")

    if opts.get("dlss"):
        settings = g.add("DLSS5Settings", upscaling_mode=DLSS_MODES.get(opts.get("dlss_mode") or "1x", DLSS_MODES["1x"]), nr_preset="Default",
                         nr_style=opts.get("dlss_style") or "Default", nr_intensity=float(opts.get("dlss_intensity", 1.0)),
                         local_tone_strength=1.0, local_structure_strength=1.5, skin_structure_strength=2.0, automatic_mask=True,
                         dlss_model_preset="M", motion="auto" if video else "none", scene_change_threshold=0.24, warmup_frames=0, runtime_dir="")
        images = o(g.add("DLSS5EnhanceImages", images=images, settings=o(settings), verify_neural_rendering=True))
        steps_done.append("dlss")

    up = opts.get("upscaler") or "none"
    if up == "seedvr2":
        dit = g.add("SeedVR2LoadDiTModel", model=opts.get("seedvr2_model") or "seedvr2_ema_3b_fp8_e4m3fn.safetensors", device="cuda:0",
                    blocks_to_swap=0, swap_io_components=False, offload_device="cpu", cache_model=False, attention_mode="sdpa")
        svae = g.add("SeedVR2LoadVAEModel", model="ema_vae_fp16.safetensors", device="cuda:0", encode_tiled=True, encode_tile_size=1024,
                     encode_tile_overlap=128, decode_tiled=True, decode_tile_size=768, decode_tile_overlap=128, tile_debug="false",
                     offload_device="cpu", cache_model=False)
        images = o(g.add("SeedVR2VideoUpscaler", image=images, dit=o(dit), vae=o(svae), seed=int(seed) % 4294967295,
                         resolution=int(opts.get("seedvr2_res", 1080)), max_resolution=0, batch_size=33 if video else 1,
                         uniform_batch_size=bool(video), color_correction="lab", temporal_overlap=3 if video else 0, prepend_frames=0,
                         input_noise_scale=0.0, latent_noise_scale=0.0, offload_device="cpu", enable_debug=False))
        steps_done.append("seedvr2")
    elif up == "relayvsr" and video and relay:
        m = g.add("UNETLoader", unet_name=relay["unet"], weight_dtype="default")
        m = g.add("ModelAttentionBackend", model=o(m), attention="comfy kitchen attention")
        cond = g.add("RelayVSRConditioning", model=o(m), images=images)
        sampled = g.add("SamplerCustomAdvanced", noise=o(g.add("RandomNoise", noise_seed=int(seed))),
                        guider=o(g.add("BasicGuider", model=o(m), conditioning=o(cond, 0))),
                        sampler=o(g.add("KSamplerSelect", sampler_name="euler")),
                        sigmas=o(g.add("BasicScheduler", model=o(m), scheduler="simple", steps=1, denoise=1.0)), latent_image=o(cond, 1))
        rvae = g.add("VAELoader", vae_name=relay["vae"])
        images = o(g.add("VSRDecode", vae=o(rvae), samples=o(sampled), images=images, detail=float(opts.get("relay_detail", 0.45))))
        steps_done.append("relayvsr")
    if not steps_done:
        raise ValueError("Pick at least one step: FaceRefine, DLSS 5 or an upscaler")

    if video:
        vid_inputs: dict[str, Any] = dict(images=images, fps=fps)
        if has_audio:
            vid_inputs["audio"] = audio
        save = g.add("SaveVideo", video=o(g.add("CreateVideo", **vid_inputs)), filename_prefix=prefix, format="auto", codec="auto")
    else:
        save = g.add("SaveImage", images=images, filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs=image_inputs,
                 info={"steps": " → ".join({"facerefine": "FaceRefine", "dlss": "DLSS 5", "seedvr2": "SeedVR2", "relayvsr": "RelayVSR x2"}[s]
                                          for s in steps_done), "video": video})


# ------------------------------------------------------------------- Music 3

def build_music3(
    files: dict[str, str | None],
    *,
    caption: str,
    lyrics: str,
    seconds: float,
    seed: int,
    steps: int = 30,
    cfg: float = 1.7,
    prefix: str = "bob/music3",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    g = Graph()
    o = Graph.out
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    enc = g.add(
        "MiniMaxMusic3TextEncode",
        clip=o(clip), caption=caption, lyrics=lyrics, seed=int(seed), max_duration=float(seconds),
        cfg_scale=cfg, top_k=50,
    )
    neg = g.add("ConditioningZeroOut", conditioning=o(enc, 0))
    empty = g.add("EmptyMiniMaxMusic3LatentAudio", seconds=o(enc, 1), batch_size=1)
    sampled = g.add(
        "KSampler",
        model=o(chain_loras(g, unet, loras)), seed=int(seed), steps=int(steps), cfg=cfg, sampler_name="euler", scheduler="simple",
        positive=o(enc, 0), negative=o(neg), latent_image=o(empty), denoise=1.0,
    )
    audio = g.add("VAEDecodeAudio", samples=o(sampled), vae=o(vae))
    save = g.add("SaveAudioMP3", audio=o(audio), filename_prefix=prefix, quality="V0")
    return Built(graph=g.nodes, outputs=[save], info={"seconds": seconds, "steps": steps})


# ------------------------------------------------------------------ Image editor (static/editor.js)

# The editor's AI tools. Masks come from the browser as black/white PNGs the size of the
# picture (white = selected), loaded with LoadImage and read from the red channel.
# Replace paints the selection's rectangle solid magenta on the cropped context and tells Qwen
# Image Edit 2511 what goes there (magenta is rare in photos; a red mark was read as a red
# object). Erase names the selected thing and asks Qwen to remove it from the clean picture:
# painting over it made Qwen redraw the object from the hole's shape, or tint the fill.
EDIT_MARK_COLOR = 0xFF00FF
EDIT_REPLACE_INSTRUCTION = ("Replace the solid magenta patch with {what}. Make it fit the scene's lighting, perspective, "
                            "scale and style. No magenta remains. Keep everything else exactly the same.")
EDIT_ERASE_INSTRUCTION = ("Remove {what}. Fill the space where it was with the background that was behind it, matching "
                          "the surrounding surfaces, textures and lighting. Keep everything else exactly the same.")
EDIT_NAME_PROMPT = ("Something in this picture is tinted magenta. Name only that tinted thing in a few words, with "
                    "its color, for example: 'the blue cup' or 'the man in the red jacket'. Answer with the name only.")


def build_ai_select(sam_ckpt: str, *, positive: list[dict] | None = None, negative: list[dict] | None = None,
                    box: dict | None = None, text: str = "", threshold: float = 0.5,
                    prefix: str = "bob/select") -> Built:
    """SAM 3.1 selection: points from the AI brush strokes, a box, or words (open vocabulary).
    image_inputs: source. Output: the mask as a black/white picture."""
    import json as _json

    g = Graph()
    o = Graph.out
    ckpt = g.add("CheckpointLoaderSimple", ckpt_name=sam_ckpt)
    load = g.add("LoadImage", image="")
    args: dict[str, Any] = {"model": o(ckpt), "image": o(load), "threshold": float(threshold),
                            "refine_iterations": 2, "individual_masks": False}
    if text.strip():
        args["conditioning"] = o(g.add("CLIPTextEncode", clip=o(ckpt, 1), text=text.strip()))
    if positive:
        args["positive_coords"] = _json.dumps([{"x": int(p["x"]), "y": int(p["y"])} for p in positive])
    if negative:
        args["negative_coords"] = _json.dumps([{"x": int(p["x"]), "y": int(p["y"])} for p in negative])
    if box:
        args["bboxes"] = {k: int(box[k]) for k in ("x", "y", "width", "height")}
    det = g.add("SAM3_Detect", **args)
    pic = g.add("MaskToImage", mask=o(det))
    save = g.add("SaveImage", images=o(pic), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs={"source": load})


EDIT_MODELS = {"qwen": "Qwen Image Edit 2511", "h3image": "MiniMax H3 Image"}


def _edit_model(g: Graph, which: str, files: dict, ref: Any, text: Any, *, seed: int, steps: int | None) -> tuple[list, dict]:
    """An instruction edit of one picture (``ref``, a node) with the chosen model -> (decoded image output, info).
    The result's size is the model's own; callers scale it back."""
    o = Graph.out
    if which == "h3image":
        # MiniMax H3 Image as ComfyUI's "Image Edit" template runs it: 6 distilled steps at cfg 1;
        # the picture conditions the text encoder and is anchored as a reference latent.
        unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
        clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
        vae = g.add("VAELoader", vae_name=files["vae"])
        cond = g.add("MiniMaxH3ImageConditioning", clip=o(clip), vae=o(vae), prompt=text, width=0, height=0,
                     **{"images.image_1": o(ref)})
        neg = g.add("ConditioningZeroOut", conditioning=o(cond, 0))
        n_steps = 6
        sampled = g.add("KSampler", model=o(unet), positive=o(cond, 0), negative=o(neg), latent_image=o(cond, 1),
                        seed=int(seed), steps=n_steps, cfg=1.0, sampler_name="euler", scheduler="simple", denoise=1.0)
        return o(g.add("VAEDecode", samples=o(sampled), vae=o(vae))), {"model": EDIT_MODELS["h3image"], "steps": n_steps}
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="qwen_image", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    fast = bool(files.get("lightning_lora"))
    model = unet
    if fast:
        model = g.add("LoraLoaderModelOnly", model=o(model), lora_name=files["lightning_lora"], strength_model=1.0)
    model = g.add("ModelSamplingAuraFlow", model=o(model), shift=3.1)
    model = g.add("CFGNorm", model=o(model), strength=1.0)
    pos = g.add("TextEncodeQwenImageEditPlus", clip=o(clip), prompt=text, vae=o(vae), image1=o(ref))
    neg = g.add("TextEncodeQwenImageEditPlus", clip=o(clip), prompt="", vae=o(vae), image1=o(ref))
    pos = g.add("FluxKontextMultiReferenceLatentMethod", conditioning=o(pos), reference_latents_method="index_timestep_zero")
    neg = g.add("FluxKontextMultiReferenceLatentMethod", conditioning=o(neg), reference_latents_method="index_timestep_zero")
    n_steps = 4 if fast else int(steps or 20)
    sampled = g.add("KSampler", model=o(model), positive=o(pos), negative=o(neg),
                    latent_image=o(g.add("VAEEncode", pixels=o(ref), vae=o(vae))), seed=int(seed), steps=n_steps,
                    cfg=1.0 if fast else 4.0, sampler_name="euler", scheduler="simple", denoise=1.0)
    return o(g.add("VAEDecode", samples=o(sampled), vae=o(vae))), {"model": EDIT_MODELS["qwen"], "steps": n_steps}


def build_imgedit(
    op: str,
    files: dict[str, str | None] | None,
    *,
    prompt: str = "",
    strength: float = 1.0,
    seed: int = 0,
    steps: int | None = None,
    background: str = "transparent",
    bg_model: str | None = None,
    edit_model: str = "qwen",
    prefix: str = "bob/edit",
) -> Built:
    """One AI edit of a picture. image_inputs: source; edit_mask for the selection ops; and
    edit_rect (the selection's bounding rectangle, made by jobs) for replace.

    NKDInpaintCrop cuts the selection out with context at about 1 MP and NKDInpaintStitch puts
    the result back; then only the edited area is pasted onto the original.
      erase    Qwen Image Edit 2511: "Remove <the selection>" on the clean crop; what it is comes
               from the user's words, else Qwen3-VL names it (looking at it tinted magenta).
      replace  Qwen Image Edit 2511: the rectangle is painted magenta, "replace it with …".
      prompt   Krea 2 redraws the selection at the given strength (Differential Diffusion).
      remove_bg  BiRefNet (core RemoveBackground) when a background-removal model is installed,
               else rembg's u2net; the background becomes transparent, white or black.
      instruct The whole picture edited by an instruction ("make it night"), no selection; the
               result is scaled back to the picture's size.
    edit_model picks the model for erase, replace and instruct: "qwen" (Qwen Image Edit 2511) or
    "h3image" (MiniMax H3 Image, 6 steps).
    """
    g = Graph()
    o = Graph.out
    src = g.add("LoadImage", image="")
    inputs = {"source": src}
    if op == "remove_bg":
        if bg_model:
            m = g.add("LoadBackgroundRemovalModel", bg_removal_name=bg_model)
            fg = o(g.add("RemoveBackground", bg_removal_model=o(m), image=o(src)))
        else:
            pic = g.add("Image Rembg (Remove Background)", images=o(src), transparency=False, model="u2net",
                        post_processing=False, only_mask=True, alpha_matting=False, alpha_matting_foreground_threshold=240,
                        alpha_matting_background_threshold=10, alpha_matting_erode_size=10, background_color="none")
            fg = o(g.add("ImageToMask", image=o(pic), channel="red"))
        if background == "transparent":
            out = g.add("JoinImageWithAlpha", image=o(src), alpha=o(g.add("InvertMask", mask=fg)))
        else:
            color = 0xFFFFFF if background == "white" else 0x000000
            size = g.add("GetImageSize", image=o(src))
            bg = g.add("EmptyImage", width=o(size, 0), height=o(size, 1), batch_size=1, color=color)
            out = g.add("ImageCompositeMasked", destination=o(bg), source=o(src), x=0, y=0, resize_source=False, mask=fg)
        save = g.add("SaveImage", images=o(out), filename_prefix=prefix)
        return Built(graph=g.nodes, outputs=[save], image_inputs=inputs,
                     info={"op": op, "remover": "BiRefNet" if bg_model else "u2net", "background": background})

    assert files, "the AI edits need model files"
    if op == "instruct":
        size = g.add("GetImageSize", image=o(src))
        ref = g.add("ImageScaleToTotalPixels", image=o(src), upscale_method="lanczos",
                    megapixels=1.0 if edit_model == "qwen" else 4.0, resolution_steps=32)
        decoded, model_info = _edit_model(g, edit_model, files, ref, prompt.strip(), seed=seed, steps=steps)
        out = g.add("ImageScale", image=decoded, upscale_method="lanczos", width=o(size, 0), height=o(size, 1), crop="disabled")
        save = g.add("SaveImage", images=o(out), filename_prefix=prefix)
        return Built(graph=g.nodes, outputs=[save], image_inputs=inputs, info={"op": op, **model_info, "final_prompt": prompt.strip()})

    mask_pic = g.add("LoadImage", image="")
    inputs["edit_mask"] = mask_pic
    mask = g.add("ImageToMask", image=o(mask_pic), channel="red")
    erase = op == "erase"
    # Replace marks the selection's bounding rectangle (jobs makes it: imaging.mask_rect), so the
    # new thing isn't clipped to the old one's outline; Erase and the prompt edit use the selection.
    area = mask
    if op == "replace":
        rect_pic = g.add("LoadImage", image="")
        inputs["edit_rect"] = rect_pic
        area = g.add("ImageToMask", image=o(rect_pic), channel="red")
    crop = g.add("NKDInpaintCrop", image=o(src), mask=o(area), invert_mask=False, fill_holes=True,
                 mask_expand=16 if op != "prompt" else 8, mask_blur=10 if op != "prompt" else 8, inpaint_blend=1.0,
                 padding=128 if op != "prompt" else 96, resize_mode="Megapixels", megapixels=1.0, longest_side=1024,
                 min_resolution=768, max_resolution=2048, separate_regions=False, region_min_area=0.1, max_regions=8,
                 region_order="Largest First")
    if op in ("erase", "replace"):
        # The edit model (Qwen Image Edit 2511 or MiniMax H3 Image) on the cropped context, then
        # only the edited area is pasted back.
        size = g.add("GetImageSize", image=o(crop, 1))
        magenta = g.add("EmptyImage", width=o(size, 0), height=o(size, 1), batch_size=1, color=EDIT_MARK_COLOR)
        hard = g.add("ThresholdMask", mask=o(crop, 2), value=0.5)
        text: Any
        if erase:
            # Qwen removes a named object from a clean picture very well (a painted-over hole made
            # it redraw the object or tint the fill). So: name what's selected (the user's words,
            # else Qwen3-VL looks at it tinted magenta), then "Remove <it>" on the clean crop.
            ref = g.add("ImageScaleToTotalPixels", image=o(crop, 1), upscale_method="lanczos", megapixels=1.0, resolution_steps=16)
            if prompt.strip():
                name: Any = prompt.strip()
            elif files.get("describer"):
                half = g.add("MaskComposite", destination=o(hard), source=o(g.add("SolidMask", value=0.55, width=o(size, 0),
                             height=o(size, 1))), x=0, y=0, operation="multiply")
                tinted = g.add("ImageCompositeMasked", destination=o(crop, 1), source=o(magenta), x=0, y=0, resize_source=False, mask=o(half))
                look = g.add("ImageScaleToTotalPixels", image=o(tinted), upscale_method="lanczos", megapixels=0.6, resolution_steps=16)
                eye = g.add("CLIPLoader", clip_name=files["describer"], type="krea2", device="default")
                name = o(g.add("TextGenerate", clip=o(eye), image=o(look), prompt=EDIT_NAME_PROMPT, max_length=40,
                               sampling_mode="off", thinking=False, use_default_template=True))
            else:
                name = "the object in the middle"
            head, tail = EDIT_ERASE_INSTRUCTION.split("{what}")
            text = (o(g.add("StringConcatenate", string_a=head, string_b=o(g.add(
                "StringConcatenate", string_a=name, string_b=tail, delimiter="")), delimiter=""))
                if isinstance(name, list) else head + name + tail)
        else:
            marked = g.add("ImageCompositeMasked", destination=o(crop, 1), source=o(magenta), x=0, y=0, resize_source=False, mask=o(hard))
            ref = g.add("ImageScaleToTotalPixels", image=o(marked), upscale_method="lanczos", megapixels=1.0, resolution_steps=16)
            text = EDIT_REPLACE_INSTRUCTION.format(what=prompt.strip())
        decoded, model_info = _edit_model(g, edit_model, files, ref, text, seed=seed, steps=steps)
        back = g.add("ImageScale", image=decoded, upscale_method="lanczos", width=o(size, 0), height=o(size, 1), crop="disabled")
        # No color matching here: it pulls the old colors back in and leaves a ghost of what was removed.
        stitched = g.add("NKDInpaintStitch", image=o(back), crop_data=o(crop, 4), feather=10, edge_hardness=0.0,
                         match_colors=0.0, seamless_edges=False)
        info = {"op": op, **model_info,
                "final_prompt": text if isinstance(text, str) else EDIT_ERASE_INSTRUCTION.format(what="<the selection, named by Qwen3-VL>")}
    else:
        # Change with a prompt: Krea 2 redraws the selection at the chosen strength.
        unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
        clip = g.add("CLIPLoader", clip_name=files["clip"], type="krea2", device="default")
        vae = g.add("VAELoader", vae_name=files["vae"])
        latent = g.add("SetLatentNoiseMask", samples=o(g.add("VAEEncode", pixels=o(crop, 1), vae=o(vae))), mask=o(crop, 2))
        model = g.add("DifferentialDiffusion", model=o(unet))
        pos = g.add("CLIPTextEncode", clip=o(clip), text=prompt.strip())
        neg = g.add("ConditioningZeroOut", conditioning=o(pos))
        denoise = max(0.05, min(1.0, float(strength)))
        sampled = g.add("KSampler", model=o(model), seed=int(seed), steps=int(steps or 8), cfg=1.0, sampler_name="euler",
                        scheduler="simple", positive=o(pos), negative=o(neg), latent_image=o(latent), denoise=denoise)
        decoded = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
        stitched = g.add("NKDInpaintStitch", image=o(decoded), crop_data=o(crop, 4), feather=10, edge_hardness=0.0,
                         match_colors=0.3, seamless_edges=False)
        info = {"op": op, "model": "Krea 2", "steps": int(steps or 8), "denoise": denoise}
    # Paste the result onto the original through a soft mask, so nothing outside the edited area
    # changes (the model's slight color shift elsewhere in the crop can't show as a rectangle).
    # Replace takes its whole marked rectangle; Erase and the prompt edit the grown selection.
    grow, blur = {"replace": (10, 8.0), "erase": (14, 8.0)}.get(op, (6, 6.0))
    soft = g.add("GrowMaskWithBlur", mask=o(area), expand=grow, incremental_expandrate=0.0,
                 tapered_corners=True, flip_input=False, blur_radius=blur, lerp_alpha=1.0, decay_factor=1.0)
    stitched = g.add("ImageCompositeMasked", destination=o(src), source=o(stitched), x=0, y=0, resize_source=False, mask=o(soft))
    save = g.add("SaveImage", images=o(stitched), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs=inputs, info=info)
