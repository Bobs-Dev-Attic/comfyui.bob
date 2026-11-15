"""API-format graph builders.

The graphs mirror the official ComfyUI templates (``video_minimax_h3_t2v``,
``video_minimax_h3_i2v``, ``image_flux3_klein_distilled_t2i`` and
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
    steps: int | None = None,
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
