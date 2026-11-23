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

import json
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
# MiniMax H3 Image is tuned for about 4 MP (2048 x 2048 of area).
H3_IMAGE_QUALITY = {"draft": 1.0, "standard": 2.0, "high": 4.0, "xl": 8.0, "max": 16.0}  # it's trained for 4 to 20 MP

# ComfyUI-H3-Image-EasyFix (PedroMarinhoDev, Apache-2.0): against H3 Image's grainy, speckled fine texture.
# Steering nudges step 0 toward the cleaner texture H3 Image draws with an empty picture in the prompt; the
# Re-Noise Sampler redraws the fine texture on steps 3 to 5. Settings are the pack's own example workflow's.
EASYFIX_NODES = {"H3ImageSteering", "H3ImageSampler", "ManualSigmas", "SamplerCustomAdvanced", "BasicGuider", "RandomNoise", "KSamplerSelect"}
H3_IMAGE_SIGMAS = "1.0, 0.9675236940383911, 0.8875485062599182, 0.75, 0.5327739119529724, 0.23200887441635132, 0.0"
EASYFIX = {"strength": 0.7, "steer_steps": "0", "plan": "RNmid", "s_noise": 0.95, "sampler": "euler_ancestral"}

# MOSS-Image: 1 to 2 MP recommended (0.25 to 4 MP work), sides in multiples of 16.
MOSS_QUALITY = {"draft": 0.5, "standard": 1.0, "high": 2.0}
# MOSS Edit: the result takes the first picture's shape at this size (the template uses 1 MP; much lower
# makes the model re-frame the subject instead of editing the picture it was given).
MOSS_EDIT_QUALITY = {"draft": 0.5, "standard": 1.0, "high": 1.5}
MOSS_EDIT_MAX_PICTURES = 4


def dims_for(aspect: tuple[float, float], megapixels: float, multiple: int = 32) -> tuple[int, int]:
    """Same math as ComfyUI's ResolutionSelector (1 MP = 1024*1024)."""
    aw, ah = aspect
    area = megapixels * 1024 * 1024
    w = math.sqrt(area * aw / ah)
    h = w * ah / aw
    snap = lambda v: max(multiple, int(round(v / multiple)) * multiple)  # noqa: E731
    return snap(w), snap(h)


def build_motion(
    files: dict[str, str | None],
    *,
    prompt: str,
    width: int,
    height: int,
    seconds: float,
    seed: int,
    turbo: bool,
    steps: int | None = None,
    hold: str = "normal",
    edge: int = 0,
    prefix: str = "bob/motion",
    loras: list[tuple[str, float]] | None = None,
    references: int = 0,
    audios: int = 0,
    clean_audio: bool = False,
    guide: str = "ttm",
    lock_audio: bool = False,
    pose_video: bool = False,
    pose_control: float = 0.0,
    frames: int | None = None,
    continue_overlap: int = 0,
    on_ref: bool = False,
) -> Built:
    """Motion layers (app/motion.py): H3 image-to-video from the original picture, with Time-to-Move
    (vloTimeToMove from ComfyUI-vlo) holding the moved objects to a rough cut-and-drag animation.

    image_inputs: first_frame (the picture), motion_ref (the rough animation) and motion_mask (white over the
    objects), both drawn by the caller at width x height with exactly `length` frames. The mask is eroded by
    `edge` pixels so H3 may redraw the cut edges. `hold`: how long the objects stay held to the path; TTM seeds
    everything at step 1 and frees the objects at the end step (loose = 2, normal = a third of the steps,
    tight = half).

    With `references` (1-8, a 3D scene's object pictures: image_inputs ref_0...), it runs on H3 Reference instead
    (`files` are the ref2va set): MiniMaxH3ReferenceToVideo with the first frame as <Picture 1>, aligned to 0.00 s
    as H3's keyframe wording does, and the object pictures as <Picture 2>... Time-to-Move holds the motion the same
    way (as FaceRefine does, H3 Reference's conditioning takes a latent made elsewhere).

    With `audios` (1-3 voices to speak with, image_inputs aref_0...: <Audio N> in the prompt), it runs on H3 Reference
    too, even with no object pictures; `clean_audio` cleans each and keeps its best 6-10 s of speech (H3RefAudioPrep).

    guide "reference" (a 3D scene's render): no Time-to-Move. The rough animation goes to H3 Reference as a reference
    video, <Video 1>, which the prompt says to follow for the camera and blocking only, not its look; H3 draws every
    frame itself. Looser than Time-to-Move's hold, but it copies none of the rough animation's holes and seams.
    The mask isn't used then.

    lock_audio (image_inputs lock_audio: a sound, or a video's soundtrack): the video's sound is that, exactly, and only
    the picture is sampled, attending to it (MiniMaxH3NativeAudioLock, ComfyUI-H3-NativeAudioLock), so the lips
    follow it. A render whose extra words were silenced is drawn again this way: the mouth then moves only for the
    lines.

    pose_video (image_inputs motion_pose: the people's OpenPose skeleton, drawn by the caller as the rough animation):
    with pose_control > 0 and the H3 Fun ControlNet Union (files fun_controlnet), it steers the people's pose in every
    frame at that strength (MiniMaxH3FunControlNetApply, a patch on the model, either guide); without it, on the
    reference guide, it goes to H3 Reference as <Video 2>, which the prompt says to move as.

    A part of a long render (long_plan): `frames` is its whole window, on H3's 17k+5 grid; with continue_overlap, the
    window's first frames are the part before's last ones (image_inputs tail: its video and sound, at this size), planted
    and kept as build_h3_ref does, so H3 carries on without a cut; the rough animation, mask and skeleton cover the
    whole window, the first frame is the tail's first, and only what comes after the overlap is saved."""
    if continue_overlap and continue_overlap not in H3_OVERLAPS:
        raise ValueError(f"The overlap must be one of {', '.join(map(str, H3_OVERLAPS))} frames")
    if not 0 <= references <= H3_MAX_REFS - 1:
        raise ValueError(f"A scene render takes at most {H3_MAX_REFS - 1} object pictures")
    g = Graph()
    o = Graph.out
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    model = unet
    by_ref = guide == "reference"
    # on H3 Reference's model (files are the ref2va set); on_ref: a long render's parts, whose carried-on latent is H3 Reference's
    ref_model = bool(references or audios or by_ref or on_ref)
    use_turbo = turbo and bool(files.get("turbo_lora"))
    if use_turbo:
        model = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=files["turbo_lora"], strength_model=1.0)
        lora = files["turbo_lora"].lower()
        # the ref2v turbo LoRA is 4-step unless it says 8; the fl2v one is 8-step unless it says 4 (as build_h3_ref, build_h3)
        default_steps = (8 if "8step" in lora else 4) if ref_model else (4 if "4step" in lora else 8)
    else:
        default_steps = 20
    n_steps = int(steps or default_steps)
    model = chain_loras(g, model, loras)
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    audio_vae = g.add("VAELoader", vae_name=files["audio_vae"])
    length = int(frames) if frames else h3_length(seconds)
    if (length - 5) % 17 or not 5 <= length <= H3_MAX_FRAMES or length <= continue_overlap:
        raise ValueError(f"A render's window is 5 + 17k frames, at most {H3_MAX_FRAMES}")

    first = g.add("LoadImage", image="")
    scaled = g.add("ImageScale", image=o(first), upscale_method="lanczos", width=width, height=height, crop="center")
    image_inputs: dict[str, str] = {"first_frame": first}
    ref = g.add("LoadVideo", file="")
    ref_parts = g.add("GetVideoComponents", video=o(ref))
    pose_parts = None
    if pose_video:  # the people's OpenPose skeleton (image_inputs motion_pose)
        pose = g.add("LoadVideo", file="")
        image_inputs["motion_pose"] = pose
        pose_parts = g.add("GetVideoComponents", video=o(pose))
    use_cn = bool(pose_parts and pose_control > 0 and files.get("fun_controlnet"))
    if use_cn:  # H3 Fun ControlNet Union: the skeleton steers the people's pose in every frame
        patch = g.add("ModelPatchLoader", name=files["fun_controlnet"])
        model = g.add("MiniMaxH3FunControlNetApply", model=o(model), model_patch=o(patch), vae=o(vae), strength=float(pose_control),
                      start_percent=0.0, end_percent=1.0, control_video=o(pose_parts, 0))
    elif pose_parts and not by_ref:
        raise ValueError("A pose skeleton without the H3 Fun ControlNet goes to H3 Reference: use the reference guide")
    if ref_model:
        if pose_parts and by_ref and not use_cn:  # without the ControlNet: <Video 2>
            prompt += ("\n\n<Video 2> is an OpenPose skeleton of the people in <Video 1> (coloured lines on black), frame for frame: "
                       "each person moves and poses exactly as their skeleton does. Draw no skeleton, lines or dots.")
        prompt = f"{h3_frame_alignment(True, False, length)}\n\n{prompt}"
        cond_inputs: dict[str, Any] = dict(clip=o(clip), vae=o(vae), audio_vae=o(audio_vae), prompt=prompt, width=width,
                                           height=height, length=length, ref_image_size="match")
        cond_inputs["ref_images.ref_image_0"] = o(scaled)
        for i in range(references):
            load = g.add("LoadImage", image="")  # an object's picture, filled by the caller
            image_inputs[f"ref_{i}"] = load
            cond_inputs[f"ref_images.ref_image_{i + 1}"] = o(load)
        for i in range(audios):
            load = g.add("LoadAudio", audio="")  # a voice to speak with, filled by the caller
            image_inputs[f"aref_{i}"] = load
            a = o(load)
            if clean_audio:
                a = o(g.add("H3RefAudioPrep", audio=a, clean="voice_focus", crop_mode="best_window", target_seconds=8.0, max_seconds=10.0,
                            max_pause_seconds=0.8, fade_ms=25, normalize_peak_db=-3.0, snap_to_latent_grid=True))
            cond_inputs[f"ref_audios.ref_audio_{i}"] = a
        if by_ref:  # the 3D scene's move: <Video 1>
            cond_inputs["ref_videos.ref_video_0"] = o(ref_parts, 0)
            if pose_parts and not use_cn:  # its people's skeleton: <Video 2>
                cond_inputs["ref_videos.ref_video_1"] = o(pose_parts, 0)
        cond = g.add("MiniMaxH3ReferenceToVideo", **cond_inputs)
    else:
        cond = g.add("MiniMaxH3ImageToVideo", clip=o(clip), vae=o(vae), prompt=prompt, width=width, height=height,
                     length=length, first_frame=o(scaled))

    msk = None
    if by_ref:
        ttm, end = model, 0
    else:
        ref_lat = g.add("VAEEncode", pixels=o(ref_parts, 0), vae=o(vae))
        msk = g.add("LoadVideo", file="")
        msk_parts = g.add("GetVideoComponents", video=o(msk))
        mask = o(g.add("ThresholdMask", mask=o(g.add("ImageToMask", image=o(msk_parts, 0), channel="red")), value=0.5))
        if edge > 0:
            mask = o(g.add("GrowMask", mask=mask, expand=-int(edge), tapered_corners=True))
        end = {"loose": 2, "tight": max(3, round(n_steps / 2))}.get(hold, max(2, round(n_steps / 3)))
        end = max(2, min(end, n_steps))
        ttm = g.add("vloTimeToMove", model=o(model), reference_latents=o(ref_lat), mask=mask, start_step=1, end_step=end)

    noise = g.add("RandomNoise", noise_seed=int(seed))
    sampler = g.add("KSamplerSelect", sampler_name="res_multistep")
    # H3 Reference: beta for full sampling, simple with its turbo LoRA (see build_h3_ref)
    scheduler = "beta" if ref_model and not use_turbo else "simple"
    sigmas = g.add("BasicScheduler", model=o(model), scheduler=scheduler, steps=n_steps, denoise=1.0)
    sample_model, start = o(ttm), o(cond, 1)
    ext = None
    if continue_overlap:  # carry on the part before without a cut (as build_h3_ref)
        if lock_audio:
            raise ValueError("A part of a long render can't hold its sound")
        tail = g.add("LoadVideo", file="")  # the part before's last frames at this size, made by the caller
        image_inputs["tail"] = tail
        tparts = g.add("GetVideoComponents", video=o(tail))
        prev = g.add("NKDAVLatent", images=o(tparts, 0), audio=o(tparts, 1), video_vae=o(vae), audio_vae=o(audio_vae),
                     audio_mode="keep", fps=float(FPS), ramp_ticks=0, ramp_out_ticks=0, ramp_shape="cosine")
        ext = g.add("NKDAVLatentExtend", previous=o(prev), new_latent=start, overlap_chunks=(continue_overlap - 5) // 17 + 1)
        start = o(ext, 0)
    lock = None
    if lock_audio:  # the sound held as given; only the picture is sampled
        held = g.add("LoadAudio", audio="")
        image_inputs["lock_audio"] = held
        lock = g.add("MiniMaxH3NativeAudioLock", model=sample_model, av_latent=start, audio_vae=o(audio_vae), audio=o(held))
        sample_model, start = o(lock, 0), o(lock, 1)
    guider = g.add("BasicGuider", model=sample_model, conditioning=o(cond, 0))
    latent = g.add("SamplerCustomAdvanced", noise=o(noise), guider=o(guider), sampler=o(sampler), sigmas=o(sigmas),
                   latent_image=start)
    audio = o(lock, 2) if lock else o(g.add("VAEDecodeAudio", samples=o(latent), vae=o(audio_vae)))
    pics = o(g.add("VAEDecode", samples=o(latent), vae=o(vae)))
    if ext:  # only what comes after the overlap: it follows the part before seamlessly
        pics = o(g.add("ImageFromBatch", image=pics, batch_index=continue_overlap, length=4096))
        audio = o(g.add("TrimAudioDuration", audio=audio, start_index=o(ext, 2), duration=3600.0))
    video = g.add("CreateVideo", images=pics, audio=audio, fps=float(FPS))
    save = g.add("SaveVideo", video=o(video), filename_prefix=prefix, format="auto", codec="auto")
    new = length - continue_overlap
    return Built(
        graph=g.nodes, outputs=[save],
        image_inputs={**image_inputs, "motion_ref": ref, **({"motion_mask": msk} if msk else {})},
        info={"width": width, "height": height, "frames": length, "seconds": round(new / FPS, 2), "steps": n_steps,
              **({"continues": True, "overlap": continue_overlap, "new_frames": new} if continue_overlap else {}),
              "turbo": use_turbo, "final_prompt": prompt, **({"audio": "held (lips drawn to it)"} if lock_audio else {}),
              **({"pose_guide": f"H3 Fun ControlNet (strength {pose_control:g})"} if use_cn else {}),
              **({"guide": "reference video (<Video 1>)" + (", pose skeleton (<Video 2>)" if pose_parts and not use_cn else "")} if by_ref else {"guide": "Time-to-Move", "hold_steps": f"1-{end}", "edge": edge}),
              **({"references": references, "model": "H3 Reference", "scheduler": scheduler} if ref_model else {})},
    )


H3_OVERLAPS = (22, 39, 56)  # frames of the previous video a continuation sees (17j+5; 39 fits the audio grid exactly)
H3_MAX_FRAMES = 362  # 17k+5, about 15 s: the longest window H3 renders at once
LONG_OVERLAP = 39  # a long render's parts each carry on the last 39 frames (1.6 s) of the part before
LONG_MAX_SECONDS = 60


def long_plan(frames: int, overlap: int = LONG_OVERLAP) -> list[dict[str, int]]:
    """A render longer than one window, in parts that each carry on the one before without a cut: [{start, frames,
    window_start, window}] in frames of the whole render (start/frames: what the part adds; window_start/window: what
    it renders, the overlap with the part before included). One part when it fits in a window. The parts are about as
    long as each other; every window is on H3's 17k+5 grid. static/scene3d.js longPlan() is the same."""
    if (frames - 5) % 17 or frames < 5:
        raise ValueError("A render is 5 + 17k frames")
    if frames <= H3_MAX_FRAMES:
        return [{"start": 0, "frames": frames, "window_start": 0, "window": frames}]
    k_all, k_first, k_more = (frames - 5) // 17, (H3_MAX_FRAMES - 5) // 17, (H3_MAX_FRAMES - overlap) // 17
    n = 1 + -(-(k_all - k_first) // k_more)
    k1 = min(k_first, max(round(k_all / n), k_all - k_more * (n - 1)))
    rest, ks = k_all - k1, [k1]
    for i in range(n - 1):  # the rest as evenly as it goes
        ks.append(rest // (n - 1) + (1 if i < rest % (n - 1) else 0))
    parts, at = [], 0
    for i, k in enumerate(ks):
        add = 5 + 17 * k if i == 0 else 17 * k
        parts.append({"start": at, "frames": add, "window_start": at - (overlap if i else 0), "window": add + (overlap if i else 0)})
        at += add
    return parts


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


# The sampler and scheduler each engine uses unless the Model step picks others: ComfyUI's
# templates for each model. H3 Reference uses beta without turbo (see build_h3_ref).
SAMPLING_DEFAULTS = {
    "h3": ("res_multistep", "simple"), "h3ref": ("res_multistep", "simple"), "klein": ("euler", "simple"),
    "krea2": ("euler", "simple"), "h3image": ("euler", "simple"), "music3": ("euler", "simple"),
    "moss": ("er_sde", "simple"), "mossedit": ("euler", "normal"),
}
# CFG each engine runs at (H3 and H3 Reference use a BasicGuider: no negative, which is CFG 1).
CFG_DEFAULTS = {"h3": 1.0, "h3ref": 1.0, "klein": 1.0, "krea2": 1.0, "h3image": 1.0, "music3": 1.7, "moss": 2.5, "mossedit": 4.0}


def apply_sampling(graph: dict[str, dict], sampler: str | None, scheduler: str | None,
                   cfg: float | None = None) -> dict[str, Any]:
    """Use the picked sampler, scheduler and/or CFG in a built graph: every KSampler,
    KSamplerSelect and BasicScheduler in it (the main engines have one of each). A CFG on a
    BasicGuider graph (H3) swaps it for a CFGGuider with a zeroed negative, as ComfyUI's own
    CFG workflows do. Returns what was changed, for the info."""
    changed: dict[str, Any] = {}
    next_id = max((int(k) for k in graph if str(k).isdigit()), default=0) + 1
    for nid, node in list(graph.items()):
        t, inp = node.get("class_type"), node.get("inputs", {})
        if sampler and t in ("KSampler", "KSamplerSelect"):
            inp["sampler_name"] = changed["sampler"] = sampler
        if scheduler and t in ("KSampler", "BasicScheduler"):
            inp["scheduler"] = changed["scheduler"] = scheduler
        if cfg is not None and t == "KSampler":
            inp["cfg"] = changed["cfg"] = float(cfg)
        if cfg is not None and t == "BasicGuider":
            neg = str(next_id); next_id += 1
            graph[neg] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": inp["conditioning"]}}
            graph[nid] = {"class_type": "CFGGuider", "inputs": {"model": inp["model"], "positive": inp["conditioning"],
                                                                "negative": [neg, 0], "cfg": float(cfg)}}
            changed["cfg"] = float(cfg)
    return changed


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


def h3_audio_lead(count: int, pictures: int = 0) -> str:
    """Default sentence naming the reference sounds, used when the prompt has no <Audio> tags. With
    reference pictures, voice N belongs to the person in picture N."""
    paired = min(count, pictures)
    if paired:
        pairs = [f"<Audio {i}> is the voice of the person in <Picture {i}>" for i in range(1, paired + 1)]
        rest = [f"<Audio {i}>" for i in range(paired + 1, count + 1)]
        extra = f" Use {_listed(rest)} as {'another voice' if len(rest) == 1 else 'other voices'} for whoever else speaks." if rest else ""
        return (f"{'; '.join(pairs)}: when that person speaks, keep their voice's timbre, accent and delivery.{extra}")
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
    continue_overlap: int = 0,
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
    if continue_overlap and continue_overlap not in H3_OVERLAPS:
        raise ValueError(f"The overlap must be one of {', '.join(map(str, H3_OVERLAPS))} frames")
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
        leads.append(h3_audio_lead(audios, references))
    if leads:
        prompt = " ".join(leads) + f"\n\n{prompt}"
    length = h3_length(seconds)
    if continue_overlap:  # the overlap takes the head of the window: both are on the 17k+5 grid, so is the sum less 5
        length += continue_overlap - 5
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
    start_latent, ext = o(cond, 1), None
    if continue_overlap:
        # Continue without a cut (the method of EDITS-WITH-AI's extender, with ComfyUI-NKD-Basic-Tools): the last
        # `continue_overlap` frames of the previous video, with their sound, are planted at the head of the new
        # window and masked "keep", so H3 carries on their motion and sound; the overlap is dropped after decoding.
        tail = g.add("LoadVideo", file="")  # the previous video's tail at this size, made by the caller
        image_inputs["tail"] = tail
        parts = g.add("GetVideoComponents", video=o(tail))
        prev = g.add("NKDAVLatent", images=o(parts, 0), audio=o(parts, 1), video_vae=o(vae), audio_vae=o(audio_vae),
                     audio_mode="keep", fps=float(FPS), ramp_ticks=0, ramp_out_ticks=0, ramp_shape="cosine")
        ext = g.add("NKDAVLatentExtend", previous=o(prev), new_latent=o(cond, 1), overlap_chunks=(continue_overlap - 5) // 17 + 1)
        start_latent = o(ext, 0)

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
        noise=o(noise), guider=o(guider), sampler=o(sampler), sigmas=o(sigmas), latent_image=start_latent,
    )
    audio = o(g.add("VAEDecodeAudio", samples=o(latent), vae=o(audio_vae)))
    frames = o(g.add("VAEDecode", samples=o(latent), vae=o(vae)))
    if ext:  # only what comes after the overlap: on the timeline it follows the previous video seamlessly
        frames = o(g.add("ImageFromBatch", image=frames, batch_index=continue_overlap, length=4096))
        audio = o(g.add("TrimAudioDuration", audio=audio, start_index=o(ext, 2), duration=3600.0))
    video = g.add("CreateVideo", images=frames, audio=audio, fps=float(FPS))
    save = g.add("SaveVideo", video=o(video), filename_prefix=prefix, format="auto", codec="auto")
    new = length - continue_overlap if continue_overlap else length
    return Built(
        graph=g.nodes,
        outputs=[save],
        image_inputs=image_inputs,
        info={"width": width, "height": height, "frames": new, "steps": n_steps, "turbo": use_turbo,
              "references": references, "audios": audios, "clean_audio": bool(audios and clean_audio),
              "max_fidelity": max_fidelity, "scheduler": scheduler, "final_prompt": prompt,
              "seconds": round(new / FPS, 2), **({"continues": True, "overlap": continue_overlap} if continue_overlap else {})},
    )


RETAKE_NODES = ("LTXVConcatAVLatent", "MVEx_AudioMaskToLatent", "VAEEncodeAudio")
ROFORMER_NODES = ("MelBandRoFormerModelLoader", "MelBandRoFormerSampler")  # kijai/ComfyUI-MelBandRoFormer
RETAKE_MAX_FRAMES = 362  # 17k+5, about 15 s: what H3 Reference renders in one window


def build_retake(
    files: dict[str, str | None],
    *,
    prompt: str,
    width: int,
    height: int,
    frames: int,
    seed: int,
    turbo: bool,
    steps: int | None = None,
    ranges: list[tuple[float, float]] | None = None,
    references: int = 0,
    audios: int = 0,
    clean_audio: bool = True,
    prefix: str = "bob/retake",
    loras: list[tuple[str, float]] | None = None,
    keep_background: str | None = None,
) -> Built:
    """Retake a video's sound and keep its picture (H3 Reference): the method of H3-AudioRetake-studio (MIT), with
    nodes most installs have. The video (role "retake_src", made by media.retake_source at width x height and
    `frames` long) and its sound go into one AV latent; MVEx_AudioMaskToLatent marks the sound to regenerate, all of
    it or the `ranges` (seconds), and on a latent with no mask yet keeps the whole picture. H3 Reference then voices
    it from the prompt: its lines, the voices (<Audio N>) and the pictures (<Picture N>; with none, the clip's middle
    frame is <Picture 1>). Only the sound comes back (FLAC); jobs puts it under the original picture
    (media.retake_mux), so the picture is the original's, frame for frame.

    keep_background (a MelBand RoFormer model's name): the new sound's voice alone is kept, over the original's
    music and other sounds. Both are split by MelBand RoFormer; the voice and the background come back as two files
    (outputs in that order) for jobs to mix."""
    if (frames - 5) % 17 or not 5 <= frames <= RETAKE_MAX_FRAMES:
        raise ValueError(f"A retake is 5 + 17k frames, at most {RETAKE_MAX_FRAMES}")
    g = Graph()
    o = Graph.out
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    model = unet
    use_turbo = turbo and bool(files.get("turbo_lora"))
    if use_turbo:
        model = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=files["turbo_lora"], strength_model=1.0)
        default_steps = 8 if "8step" in files["turbo_lora"].lower() else 4
    else:
        default_steps = 20
    n_steps = int(steps or default_steps)
    model = chain_loras(g, model, loras)
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    audio_vae = g.add("VAELoader", vae_name=files["audio_vae"])

    src = g.add("LoadVideo", file="")  # filled by the caller with media.retake_source's file
    parts = g.add("GetVideoComponents", video=o(src))
    image_inputs: dict[str, str] = {"retake_src": src}
    leads = []
    if "<Picture" not in prompt:
        leads.append(h3_reference_lead(references) if references else
                     "<Picture 1> is a frame of this very shot: keep its people, place and look.")
    if audios and "<Audio" not in prompt:
        leads.append(h3_audio_lead(audios, max(1, references)))
    if leads:
        prompt = " ".join(leads) + f"\n\n{prompt}"
    cond_inputs: dict[str, Any] = dict(clip=o(clip), vae=o(vae), audio_vae=o(audio_vae), prompt=prompt, width=width,
                                       height=height, length=frames, ref_image_size="match")
    if references:
        for i in range(references):
            load = g.add("LoadImage", image="")
            image_inputs[f"ref_{i}"] = load
            cond_inputs[f"ref_images.ref_image_{i}"] = o(load)
    else:
        cond_inputs["ref_images.ref_image_0"] = o(g.add("ImageFromBatch", image=o(parts, 0), batch_index=frames // 2, length=1))
    for i in range(audios):
        load = g.add("LoadAudio", audio="")
        image_inputs[f"aref_{i}"] = load
        a = o(load)
        if clean_audio:
            a = o(g.add("H3RefAudioPrep", audio=a, clean="voice_focus", crop_mode="best_window", target_seconds=8.0,
                        max_seconds=10.0, max_pause_seconds=0.8, fade_ms=25, normalize_peak_db=-3.0, snap_to_latent_grid=True))
        cond_inputs[f"ref_audios.ref_audio_{i}"] = a
    cond = g.add("MiniMaxH3ReferenceToVideo", **cond_inputs)

    av = g.add("LTXVConcatAVLatent", video_latent=o(g.add("VAEEncode", pixels=o(parts, 0), vae=o(vae))),
               audio_latent=o(g.add("VAEEncodeAudio", audio=o(parts, 1), vae=o(audio_vae))))
    span = ",".join(f"{a:.3f},{b:.3f}" for a, b in ranges or [])
    masked = g.add("MVEx_AudioMaskToLatent", latent=o(av), timing="auto", start_time=0.0, end_time=round(frames / FPS, 4),
                   existing_mask="replace", vae=o(audio_vae), time_ranges=span)

    noise = g.add("RandomNoise", noise_seed=int(seed))
    sampler = g.add("KSamplerSelect", sampler_name="res_multistep")
    sigmas = g.add("BasicScheduler", model=o(unet), scheduler="simple" if use_turbo else "beta", steps=n_steps, denoise=1.0)
    guider = g.add("BasicGuider", model=o(model), conditioning=o(cond, 0))
    latent = g.add("SamplerCustomAdvanced", noise=o(noise), guider=o(guider), sampler=o(sampler), sigmas=o(sigmas),
                   latent_image=o(masked))
    audio = g.add("VAEDecodeAudio", samples=o(latent), vae=o(audio_vae))
    if keep_background:
        rof = g.add("MelBandRoFormerModelLoader", model_name=keep_background)
        voice = g.add("MelBandRoFormerSampler", model=o(rof), audio=o(audio))      # vocals, instruments
        bed = g.add("MelBandRoFormerSampler", model=o(rof), audio=o(parts, 1))
        outputs = [g.add("SaveAudio", audio=o(voice, 0), filename_prefix=f"{prefix}_voice"),
                   g.add("SaveAudio", audio=o(bed, 1), filename_prefix=f"{prefix}_background")]
    else:
        outputs = [g.add("SaveAudio", audio=o(audio), filename_prefix=prefix)]
    return Built(
        graph=g.nodes, outputs=outputs, image_inputs=image_inputs,
        info={"width": width, "height": height, "frames": frames, "steps": n_steps, "turbo": use_turbo,
              "references": references, "audios": audios, "final_prompt": prompt, "keep_background": bool(keep_background),
              "ranges": [[round(a, 3), round(b, 3)] for a, b in ranges or []]},
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


# MOSS-Image's prompt enhancer, adapted from ComfyUI's MOSS-Image template (which follows OpenMOSS's
# "MOSS-Image Prompt Enhancer" skill): it turns a short idea into the long English caption the model was
# trained on, keeping any quoted text verbatim.
MOSS_ENHANCE_SYSTEM = (
    "You are a prompt engineer for an image generation model. The user sends a short, rough request, sometimes with "
    "exact copy to render. Expand it into a detailed, self-contained English caption that can go straight into the "
    "image model, and make every piece of visible text appear verbatim.\n\n"
    "Output only the caption. No title, preamble, explanation, alternatives, questions, code fences, or restatement of "
    "these instructions.\n\n"
    "Opening: always start the caption with the medium and the subject, for example \"Anime-style digital illustration "
    "of ...\", \"Studio photograph of ...\", \"Mixed-media poster of ...\". Never start with a verb.\n\n"
    "Preserve everything the user specifies: number of subjects, identity, action, clothing, style, era, composition, "
    "palette, exclusions, and any copy they quote. Add only plausible visual detail the user left open. Never add new "
    "people, plot, or dialogue, and never invent real product specifications, prices, or real people's names.\n\n"
    "Cover these facets when the scene has content for them, without padding: 1. Subject: appearance, build, hair, each "
    "garment and its material, accessories, texture. 2. Action: pose, hands, gaze, expression, in a single frame. "
    "3. Space: foreground, midground and background, relative positions, frame edges. 4. Setting: architecture, props, "
    "signs of time and place. 5. Framing: shot size, camera height and angle, perspective, placement in the frame. "
    "6. Light: key light direction and hardness, color temperature, practical sources, how light falls on materials. "
    "7. Tone: palette, contrast, grain, medium, atmosphere. 8. Text.\n\n"
    "Text rules: keep the user's wording verbatim in its original language inside double quotes; never rewrite, "
    "translate, shorten or repeat it. For each text block state the exact content, its carrier (sign, poster, label, "
    "screen), position and relative size, typeface style and color, and legibility. When the scene clearly needs text "
    "but none is given, write short, specific, scene-appropriate wording; never placeholders.\n\n"
    "Writing: flowing natural language in two to four paragraphs, ordered by space or by the viewer's eye. No tag soup "
    "and no empty quality words such as masterpiece or 8k. Every sentence adds new visible information. Aim for 220 to "
    "320 words for a single subject and 320 to 500 for posters, multi-subject or text-heavy scenes, never fewer than "
    "200 words. Describe only what is visible: no generation parameters, sizes or aspect ratios."
)
MOSS_NEGATIVE = "nsfw, worst quality, bad anatomy, watermark, jpeg artifact"


def moss_layout_prompt(caption: str, boxes: list[dict[str, Any]], width: int, height: int) -> str:
    """MOSS-Image's layout prompt, as ComfyUI's "MOSS-Image Layout Prompt" node builds it from Create Bounding
    Boxes: a JSON caption with the whole scene's caption and one item per box (in drawing order: background
    first), each box as pixel edges [y0, x0, y1, x1] measured from the canvas centre. Boxes come in as
    fractions of the canvas (x, y, w, h in 0..1) and go through the node's 0-1000 grid, so the numbers match."""
    items = []
    for b in boxes:
        x0, y0 = min(max(float(b["x"]), 0.0), 1.0), min(max(float(b["y"]), 0.0), 1.0)
        x1, y1 = min(x0 + max(float(b["w"]), 0.0), 1.0), min(y0 + max(float(b["h"]), 0.0), 1.0)
        g = [round(v * 1000) for v in (y0, x0, y1, x1)]  # Create Bounding Boxes' 0-1000 [ymin, xmin, ymax, xmax]
        label = b.get("type") if b.get("type") in ("text", "character") else "object"
        item: dict[str, Any] = {"label": label, "caption": str(b.get("desc") or "").strip()}
        if label == "text":
            item["text"] = str(b.get("text") or "")
        item["bbox"] = [math.floor(round(g[0] * height / 1000, 9)) - height // 2, math.floor(round(g[1] * width / 1000, 9)) - width // 2,
                        math.ceil(round(g[2] * height / 1000, 9)) - height // 2, math.ceil(round(g[3] * width / 1000, 9)) - width // 2]
        items.append(item)
    if not items:
        return caption
    layout = {"summary": {"caption": caption.strip()}, "items": items, "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
    return json.dumps(layout, ensure_ascii=False, separators=(",", ":"))


def build_moss(
    files: dict[str, str | None],
    *,
    prompt: str,
    width: int,
    height: int,
    seed: int,
    steps: int | None = None,
    enhance: bool = False,
    prefix: str = "bob/moss",
    loras: list[tuple[str, float]] | None = None,
    layout: list[dict[str, Any]] | None = None,
) -> Built:
    """MOSS-Image text-to-image, as ComfyUI's "MOSS-Image: Text to Image" template runs it: 25 steps, CFG 2.5,
    er_sde/simple, its standard negative, an EmptyFlux2LatentImage canvas. The Base checkpoint gets skip-layer
    guidance on layer 22 (the template's Base setting; the SFT template runs without it). Enhance rewrites the
    prompt with the same Qwen3.5 text encoder (TextGenerate) into a full caption first."""
    g = Graph()
    o = Graph.out
    unet_name = files["unet"] or ""
    unet = g.add("UNETLoader", unet_name=unet_name, weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="moss_image", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])

    model: Any = chain_loras(g, unet, loras)
    base = "base" in unet_name.replace("\\", "/").rsplit("/", 1)[-1].lower()
    if base:
        model = g.add("SkipLayerGuidanceDiTSimple", model=o(model), double_layers="", single_layers="22",
                      start_percent=0.0, end_percent=0.5)

    text: Any = prompt
    if layout:
        # Layout control: boxes for text, objects and characters. The prompt enhancer would rewrite the JSON and drop
        # boxes (ComfyUI's layout templates leave it off too), so it's skipped.
        text = moss_layout_prompt(prompt, layout, width, height)
        enhance = False
    if enhance:
        text = o(g.add(
            "TextGenerate",
            clip=o(clip),
            system_prompt=MOSS_ENHANCE_SYSTEM,
            prompt=prompt,
            max_length=4096,
            sampling_mode="on",  # a dynamic combo: its sub-inputs go in flat as "sampling_mode.<name>"
            **{f"sampling_mode.{k}": v for k, v in (("temperature", 0.7), ("top_k", 64), ("top_p", 0.95), ("min_p", 0.05),
                                                    ("repetition_penalty", 1.0), ("seed", int(seed) % (2**63)))},
            thinking=False,
            use_default_template=True,
        ))
    pos = g.add("CLIPTextEncode", clip=o(clip), text=text)
    neg = g.add("CLIPTextEncode", clip=o(clip), text=MOSS_NEGATIVE)
    empty = g.add("EmptyFlux2LatentImage", width=width, height=height, batch_size=1)
    sampled = g.add(
        "KSampler",
        model=o(model), seed=int(seed), steps=int(steps or 25), cfg=2.5, sampler_name="er_sde", scheduler="simple",
        positive=o(pos), negative=o(neg), latent_image=o(empty), denoise=1.0,
    )
    decoded = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
    save = g.add("SaveImage", images=o(decoded), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save],
                 info={"width": width, "height": height, "steps": int(steps or 25), "enhanced": enhance,
                       "checkpoint": "Base" if base else "SFT", **({"slg": "layer 22"} if base else {}),
                       **({"layout": f"{len(layout)} box{'es' if len(layout) != 1 else ''}"} if layout else {})})


def build_moss_edit(
    files: dict[str, str | None],
    *,
    prompt: str,
    pictures: int,
    megapixels: float,
    seed: int,
    steps: int | None = None,
    prefix: str = "bob/mossedit",
    loras: list[tuple[str, float]] | None = None,
) -> Built:
    """MOSS-Image Edit, as ComfyUI's "MOSS-Image: Image Edit" template runs it: the Moss-Image-Edit LoRA on the
    MOSS checkpoint, skip-layer guidance on layer 22 for the whole schedule, 30 steps, CFG 4, euler/normal. The
    first picture (ref_0) is the one to edit: scaled to the quality's size on a 16 px grid, it sets the output's
    size and shape. More pictures (a garment, a face, a prop) are scaled the same way and go to the encoder too;
    the prompt says what each is for. Both prompts see the pictures (TextEncodeMOSSImageEdit, edit_format
    "Moss-Image-Edit", which is what the LoRA was trained with)."""
    g = Graph()
    o = Graph.out
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="moss_image", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    model: Any = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=files["edit_lora"], strength_model=1.0)
    model = chain_loras(g, model, loras)
    model = g.add("SkipLayerGuidanceDiTSimple", model=o(model), double_layers="", single_layers="22",
                  start_percent=0.0, end_percent=1.0)

    inputs: dict[str, str] = {}
    images: dict[str, Any] = {}
    first: str | None = None
    for i in range(pictures):
        load = g.add("LoadImage", image="")
        inputs[f"ref_{i}"] = load
        scaled = g.add("ImageScaleToTotalPixels", image=o(load), upscale_method="lanczos", megapixels=float(megapixels),
                       resolution_steps=16)
        images[f"images.image_{i}"] = o(scaled)
        first = first or scaled
    size = g.add("GetImageSize", image=o(first))
    empty = g.add("EmptyFlux2LatentImage", width=o(size, 0), height=o(size, 1), batch_size=1)
    pos = g.add("TextEncodeMOSSImageEdit", clip=o(clip), prompt=prompt, edit_format="Moss-Image-Edit", vae=o(vae),
                image_strength=1.0, **images)
    neg = g.add("TextEncodeMOSSImageEdit", clip=o(clip), prompt=MOSS_NEGATIVE, edit_format="Moss-Image-Edit", vae=o(vae),
                image_strength=1.0, **images)
    sampled = g.add(
        "KSampler",
        model=o(model), seed=int(seed), steps=int(steps or 30), cfg=4.0, sampler_name="euler", scheduler="normal",
        positive=o(pos), negative=o(neg), latent_image=o(empty), denoise=1.0,
    )
    decoded = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
    save = g.add("SaveImage", images=o(decoded), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs=inputs,
                 info={"megapixels": megapixels, "steps": int(steps or 30), "pictures": pictures})


def build_h3_image(
    files: dict[str, str | None],
    *,
    prompt: str,
    width: int,
    height: int,
    seed: int,
    references: int = 0,
    steps: int | None = None,
    prefix: str = "bob/h3image",
    loras: list[tuple[str, float]] | None = None,
    clean: bool = False,
) -> Built:
    """MiniMax H3 Image text-to-image, as ComfyUI's "MiniMax-H3-Image: Text to Image" template runs it:
    MiniMaxH3ImageConditioning, 6 distilled steps (the checkpoint's PDD grid), cfg 1, euler/simple.
    References (image_inputs ref_0..) are <Picture 1>, <Picture 2>... in the prompt.
    """
    g = Graph()
    o = Graph.out
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    inputs: dict[str, str] = {}
    images: dict[str, Any] = {}
    for i in range(references):
        load = g.add("LoadImage", image="")
        inputs[f"ref_{i}"] = load
        images[f"images.image_{i + 1}"] = o(load)
    cond = g.add("MiniMaxH3ImageConditioning", clip=o(clip), vae=o(vae), prompt=prompt, width=int(width), height=int(height), **images)
    steps = int(steps or 6)  # its distilled grid has 6 steps; other counts interpolate it
    model = chain_loras(g, unet, loras)
    # Clean texture (EasyFix) follows the official 6-step grid, so it runs only on 6 steps.
    clean = clean and steps == 6
    if clean:
        e = EASYFIX
        steered = g.add("H3ImageSteering", model=o(model), strength=e["strength"], steps=e["steer_steps"])
        guider = g.add("BasicGuider", model=o(steered), conditioning=o(cond, 0))
        inner = g.add("KSamplerSelect", sampler_name=e["sampler"])
        renoise = g.add("H3ImageSampler", plan=e["plan"], custom_plan="SSRRRS", s_noise=e["s_noise"], sampler=o(inner))
        sigmas = g.add("ManualSigmas", sigmas=H3_IMAGE_SIGMAS)
        noise = g.add("RandomNoise", noise_seed=int(seed))
        sampled = g.add("SamplerCustomAdvanced", noise=o(noise), guider=o(guider), sampler=o(renoise), sigmas=o(sigmas),
                        latent_image=o(cond, 1))
    else:
        neg = g.add("ConditioningZeroOut", conditioning=o(cond, 0))
        sampled = g.add("KSampler", model=o(model), seed=int(seed), steps=steps, cfg=1.0, sampler_name="euler",
                        scheduler="simple", positive=o(cond, 0), negative=o(neg), latent_image=o(cond, 1), denoise=1.0)
    decoded = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
    save = g.add("SaveImage", images=o(decoded), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs=inputs,
                 info={"width": width, "height": height, "steps": steps, "references": references,
                       **({"clean_texture": True} if clean else {})})


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


# ComfyUI-H3-FaceRefine-Plus (AnniCodex): the finish build_enhance uses after the H3 face re-render when it's installed.
FACEREFINE_PLUS_NODES = ("H3FaceStitchPlus", "H3FaceFlowLock", "H3FaceToneMatch")
# ...and its V2 (face only): SAM 3's mask, the mask on the latent, Differential Diffusion, the sound held, the stock stitch
FACEREFINE_V2_NODES = ("H3FaceTrackCrop", "H3FaceStitch", "H3FaceMaskToLatent", "SAM3_Detect", "DifferentialDiffusion",
                       "LTXVConcatAVLatent", "LTXVSeparateAVLatent", "VAEEncodeAudio", "SetLatentNoiseMask", "SolidMask",
                       "ResizeImageMaskNode", "MiniMaxH3ReferenceToVideo")


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
    plus: bool = False,
    v2: dict[str, str | None] | None = None,
    sam: str | None = None,
    sparse: bool = False,
) -> Built:
    """Improve a finished picture or video, in this order (each step optional):

    1. FaceRefine (video): ComfyUI-H3-FaceRefine. Faces are tracked and cropped to a steady
       768 px canvas, the crops are encoded into an H3 audio+video latent next to the original
       sound (audio lock), and H3 Reference re-samples them at a low denoise with the source's
       own prompt, reference pictures/sounds and LoRAs, more where faces are small; the refined
       faces are stitched back. With ComfyUI-H3-FaceRefine-Plus installed (plus=True) and
       opts face_finish "plus", the finish is that pack's: Stitch Plus (antialiased paste, light and
       colour from the original frame, detail from the refined face), Flow Lock (pins the new features
       on the head, so the face doesn't wobble) and Tone Match (colour back to the source, lips too).
       opts face_mode "v2_face" / "v2_hair" (with `v2`, the H3 model set, and `sam`, a SAM 3 checkpoint): the Plus
       pack's V2 instead, which re-draws only the face (or face and hair) that SAM 3 masks.
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

    if opts.get("facerefine") and video and v2 and sam and str(opts.get("face_mode") or "v1").startswith("v2"):
        # FaceRefine Plus V2 (ComfyUI-H3-FaceRefine-Plus v0.2.0, its face_refine_plus_modes graph): SAM 3 masks the
        # face (or face and hair) in each tracked 768 px crop, and only that is re-drawn (H3 Face Mask To Latent: a
        # noise mask on the crops' own latent, Differential Diffusion), on H3 with its 8-step turbo LoRA, the sound
        # held as it is, conditioned on an empty prompt and the source's first reference picture; the stock stitch
        # pastes it back through the same masks. Faster than V1, and nothing outside the mask changes.
        hair = opts.get("face_mode") == "v2_hair"
        unet = g.add("UNETLoader", unet_name=v2["unet"], weight_dtype="default")
        model = unet
        use_turbo = bool(v2.get("turbo_lora"))
        if use_turbo:
            model = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=v2["turbo_lora"], strength_model=1.0)
        n_steps = (4 if "4step" in v2["turbo_lora"].lower() else 8) if use_turbo else int(opts.get("face_steps", 20))
        clip = g.add("CLIPLoader", clip_name=v2["clip"], type="minimax", device="default")
        vae = g.add("VAELoader", vae_name=v2["vae"])
        avae = g.add("VAELoader", vae_name=v2["audio_vae"])
        track = g.add("H3FaceTrackCrop", images=images, detector=opts.get("face_detector") or "bbox\\face_yolov8m.pt", confidence=0.35,
                      crop_factor=2.5, canvas_width=768, canvas_height=768, canvas_mode="manual", smooth_window=21,
                      size_smooth_window=51, smooth_method="gaussian", size_mode="per_frame", identity_track=True, identity_threshold=0.28,
                      select="largest_face", fallback_detector="none", fallback_head_frac=0.5, select_index=0,
                      identity_model="insightface", cut_detection="none", cut_threshold=3.0, absent_shots="off", X=0, Y=0, frame_index=0)
        sam3 = g.add("CheckpointLoaderSimple", ckpt_name=sam)
        said = g.add("CLIPTextEncode", clip=o(sam3, 1), text="face and hair" if hair else "face")
        masks = g.add("SAM3_Detect", model=o(sam3, 0), image=o(track, 0), conditioning=o(said), threshold=0.5, refine_iterations=2,
                      individual_masks=False)
        vlat = g.add("H3FaceMaskToLatent", latent=o(g.add("VAEEncode", pixels=o(track, 0), vae=o(vae))), masks=o(masks, 0),
                     threshold=0.3, shrink=12, edge_grow=16, fill_gap=4, grow_spatial=36, grow_temporal=1)
        cond_inputs: dict[str, Any] = dict(clip=o(clip), vae=o(vae), audio_vae=o(avae), prompt="", width=o(track, 4), height=o(track, 5),
                                           length=o(track, 6), ref_image_size="match")
        if references:  # the source's first reference picture (the pack's character sheet), at 2 MP
            load = g.add("LoadImage", image="")
            image_inputs["ref_0"] = load
            pic = g.add("ResizeImageMaskNode", input=o(load), resize_type="scale total pixels", **{"resize_type.megapixels": 2.0}, scale_method="area")
            pic = g.add("ResizeImageMaskNode", input=o(pic), resize_type="scale to multiple", **{"resize_type.multiple": 32}, scale_method="area")
            cond_inputs["ref_images.ref_image_0"] = o(pic)
        cond = g.add("MiniMaxH3ReferenceToVideo", **cond_inputs)
        if has_audio:  # the sound as it is, held (a noise mask of 0)
            alat = o(g.add("VAEEncodeAudio", audio=audio, vae=o(avae)))
        else:  # no sound: H3's empty one, held the same way
            alat = o(g.add("LTXVSeparateAVLatent", av_latent=o(cond, 1)), 1)
        alat = o(g.add("SetLatentNoiseMask", samples=alat, mask=o(g.add("SolidMask", value=0.0, width=32, height=32))))
        start = g.add("LTXVConcatAVLatent", video_latent=o(vlat, 0), audio_latent=alat)
        fast = model
        if sparse:  # the pack's speed-up: block-sparse attention after the first fifth of the steps
            fast = g.add("BlockSparseAttention", model=o(model), selection="sol-attn", **{"selection.tau": 1.3}, start_percent=0.2,
                         end_percent=1.0, dense_blocks="", min_tokens=12288, extra_tokens=256, sink_conditioning="exact_kv_and_rows",
                         verbose=False)
        dd = g.add("DifferentialDiffusion", model=o(fast), strength=1.0)
        sigmas = g.add("BasicScheduler", model=o(unet), scheduler="beta", steps=n_steps, denoise=float(opts.get("face_strength", 0.3)))
        sampled = g.add("SamplerCustomAdvanced", noise=o(g.add("RandomNoise", noise_seed=int(seed))),
                        guider=o(g.add("BasicGuider", model=o(dd), conditioning=o(cond, 0))),
                        sampler=o(g.add("KSamplerSelect", sampler_name="euler")), sigmas=o(sigmas), latent_image=o(start))
        faces = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
        images = o(g.add("H3FaceStitch", base_images=images, refined_crops=o(faces), transform=o(track, 1), masks=o(masks, 0),
                         paste_region="face_only", mask_dilation=24, feather=24, colour_match=1.0, blend=1.0, undetected_frames="fade_out",
                         feather_scales_with_crop=False))
        steps_done.append("facerefine_v2_hair" if hair else "facerefine_v2")
    elif opts.get("facerefine") and video and h3:
        # the Plus finish takes FaceRefine-Plus v0.2.0's tuning (its example graphs): a tighter crop (2.2 face heights)
        # and the same denoise on every face, small or large (Per-Frame Denoise 1.0 / 1.0); the stock finish keeps
        # large faces at 0.35 of it
        use_plus = plus and opts.get("face_finish", "plus") == "plus"
        unet = g.add("UNETLoader", unet_name=h3["unet"], weight_dtype="default")
        model = chain_loras(g, unet, loras)
        clip = g.add("CLIPLoader", clip_name=h3["clip"], type="minimax", device="default")
        vae = g.add("VAELoader", vae_name=h3["vae"])
        avae = g.add("VAELoader", vae_name=h3["audio_vae"])
        track = g.add("H3FaceTrackCrop", images=images, detector=opts.get("face_detector") or "bbox\\face_yolov8m.pt", confidence=0.35,
                      crop_factor=2.2 if use_plus else 3.0, canvas_width=768, canvas_height=768, canvas_mode="auto_capped_768", smooth_window=21,
                      size_smooth_window=51, smooth_method="gaussian", size_mode="per_frame", identity_track=True, identity_threshold=0.28,
                      select="largest_face", fallback_detector="face_yolov8m.pt", fallback_head_frac=0.5, select_index=0,
                      identity_model="insightface", cut_detection="none", cut_threshold=3.0, absent_shots="off", X=0, Y=0, frame_index=0)
        lead = []
        if references and "<Picture" not in prompt:
            lead.append(h3_reference_lead(references))
        if audios and "<Audio" not in prompt:
            lead.append(h3_audio_lead(audios, references))
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
                    denoise_multiplier_large_face=1.0 if use_plus else 0.35, scale_mode="absolute_px", face_px_small=30.0, face_px_large=120.0, gamma=1.0,
                    smooth_frames=9)
        sigmas = g.add("BasicScheduler", model=o(pfd, 2), scheduler="simple", steps=int(opts.get("face_steps", 20)),
                       denoise=float(opts.get("face_strength", 0.3)))
        guider = g.add("BasicGuider", model=o(pfd, 2), conditioning=o(cond, 0))
        sampled = g.add("SamplerCustomAdvanced", noise=o(g.add("RandomNoise", noise_seed=int(seed))), guider=o(guider),
                        sampler=o(g.add("KSamplerSelect", sampler_name="res_multistep")), sigmas=o(sigmas), latent_image=o(pfd, 0))
        faces = g.add("VAEDecode", samples=o(sampled), vae=o(vae))
        if use_plus:
            base = images
            stitched = g.add("H3FaceStitchPlus", base_images=base, refined_crops=o(faces), transform=o(track, 1), paste_region="face_only",
                             mask_dilation=24, feather=24, tone_mode="freq_sep", lowpass_face_frac=0.15, detail_gain=1.0, blend=1.0,
                             undetected_frames="fade_out")
            locked = g.add("H3FaceFlowLock", base_images=base, refined_images=o(stitched), sigma_frac=1.0 / 150.0, threshold=4.0,
                           base_offset=0)
            images = o(g.add("H3FaceToneMatch", source_images=base, processed_images=o(locked), sigma_luma_frac=0.01,
                             sigma_chroma_frac=1.0 / 300.0, source_offset=0, lip_fix=bool(opts.get("face_lipfix", True)),
                             face_detector="face_yolov8m.pt"))
            steps_done.append("facerefine_plus")
        else:
            images = o(g.add("H3FaceStitch", base_images=images, refined_crops=o(faces), transform=o(track, 1), paste_region="face_only",
                             mask_dilation=24, feather=24, colour_match=1.0, blend=1.0, undetected_frames="fade_out",
                             feather_scales_with_crop=False))
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
                 info={"steps": " → ".join({"facerefine": "FaceRefine", "facerefine_plus": "FaceRefine Plus", "facerefine_v2": "FaceRefine Plus V2 (face)",
                                       "facerefine_v2_hair": "FaceRefine Plus V2 (face + hair)", "dlss": "DLSS 5", "seedvr2": "SeedVR2", "relayvsr": "RelayVSR x2"}[s]
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


def build_track(sam_ckpt: str, *, first: int, count: int, width: int, height: int, fps: float,
                positive: list[dict] | None = None, negative: list[dict] | None = None, text: str = "",
                threshold: float = 0.5, prefix: str = "bob/track") -> Built:
    """Track one object through a video (app/tracking.py): SAM 3.1 finds it on the first frame (points in
    width x height pixels, or words) and SAM3_VideoTrack follows it. image_inputs: video (a LoadVideo).
    Output: a mask video, white over the object in every frame."""
    import json as _json

    g = Graph()
    o = Graph.out
    ckpt = g.add("CheckpointLoaderSimple", ckpt_name=sam_ckpt)
    load = g.add("LoadVideo", file="")
    parts = g.add("GetVideoComponents", video=o(load))
    clip = g.add("ImageFromBatch", image=o(parts, 0), batch_index=int(first), length=int(count))
    frames = g.add("ImageScale", image=o(clip), upscale_method="area", width=width, height=height, crop="disabled")
    first_frame = g.add("ImageFromBatch", image=o(frames), batch_index=0, length=1)
    args: dict[str, Any] = {"model": o(ckpt), "image": o(first_frame), "threshold": float(threshold),
                            "refine_iterations": 2, "individual_masks": False}
    if text.strip():
        args["conditioning"] = o(g.add("CLIPTextEncode", clip=o(ckpt, 1), text=text.strip()))
    if positive:
        args["positive_coords"] = _json.dumps([{"x": int(p["x"]), "y": int(p["y"])} for p in positive])
    if negative:
        args["negative_coords"] = _json.dumps([{"x": int(p["x"]), "y": int(p["y"])} for p in negative])
    det = g.add("SAM3_Detect", **args)
    track = g.add("SAM3_VideoTrack", images=o(frames), model=o(ckpt), initial_mask=o(det), detection_threshold=float(threshold),
                  max_objects=1, detect_interval=1)
    masks = g.add("SAM3_TrackToMask", track_data=o(track), object_indices="0")
    pics = g.add("MaskToImage", mask=o(masks))
    video = g.add("CreateVideo", images=o(pics), fps=float(fps))
    save = g.add("SaveVideo", video=o(video), filename_prefix=prefix, format="auto", codec="auto")
    return Built(graph=g.nodes, outputs=[save], image_inputs={"video": load})


EDIT_MODELS = {"qwen": "Qwen Image Edit 2511", "h3image": "MiniMax H3 Image", "mossedit": "MOSS-Image Edit"}


# Pictures an instruction edit can take besides the one it edits: Qwen Image Edit 2511 has three image inputs,
# MiniMax H3 Image nine. The edited picture is Picture 1 and these are Picture 2... (in H3's prompts <Picture 2>).
EDIT_EXTRA_REFS = {"qwen": 2, "h3image": 8, "mossedit": MOSS_EDIT_MAX_PICTURES - 1}
# The size each model edits at (instruct: the whole picture; it's scaled back afterwards).
EDIT_MEGAPIXELS = {"qwen": 1.0, "h3image": 4.0, "mossedit": 1.0}


def _edit_model(g: Graph, which: str, files: dict, ref: Any, text: Any, *, seed: int, steps: int | None,
                extra: list | None = None, loras: list[tuple[str, float]] | None = None) -> tuple[list, dict]:
    """An instruction edit of one picture (``ref``, a node) with the chosen model -> (decoded image output, info).
    ``extra``: more pictures (nodes) the instruction can point at as Picture 2... ``loras``: the user's LoRAs (name,
    strength), after the model's own LoRAs. The result's size is the model's own; callers scale it back."""
    o = Graph.out
    extra = list(extra or [])
    if len(extra) > EDIT_EXTRA_REFS[which]:
        raise ValueError(f"{EDIT_MODELS[which]} takes at most {EDIT_EXTRA_REFS[which]} more pictures")
    if which == "mossedit":
        # MOSS-Image Edit as ComfyUI's "MOSS-Image: Image Edit" template runs it (see build_moss_edit): the edit LoRA,
        # skip-layer guidance on layer 22, 30 steps at CFG 4; the picture is image_0 and sets the size.
        unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
        clip = g.add("CLIPLoader", clip_name=files["clip"], type="moss_image", device="default")
        vae = g.add("VAELoader", vae_name=files["vae"])
        model = g.add("LoraLoaderModelOnly", model=o(unet), lora_name=files["edit_lora"], strength_model=1.0)
        model = chain_loras(g, model, loras)
        model = g.add("SkipLayerGuidanceDiTSimple", model=o(model), double_layers="", single_layers="22",
                      start_percent=0.0, end_percent=1.0)
        pics = {"images.image_0": o(ref), **{f"images.image_{i + 1}": o(x) for i, x in enumerate(extra)}}
        pos = g.add("TextEncodeMOSSImageEdit", clip=o(clip), prompt=text, edit_format="Moss-Image-Edit", vae=o(vae),
                    image_strength=1.0, **pics)
        neg = g.add("TextEncodeMOSSImageEdit", clip=o(clip), prompt=MOSS_NEGATIVE, edit_format="Moss-Image-Edit", vae=o(vae),
                    image_strength=1.0, **pics)
        size = g.add("GetImageSize", image=o(ref))
        empty = g.add("EmptyFlux2LatentImage", width=o(size, 0), height=o(size, 1), batch_size=1)
        n_steps = int(steps or 30)
        sampled = g.add("KSampler", model=o(model), positive=o(pos), negative=o(neg), latent_image=o(empty),
                        seed=int(seed), steps=n_steps, cfg=4.0, sampler_name="euler", scheduler="normal", denoise=1.0)
        return o(g.add("VAEDecode", samples=o(sampled), vae=o(vae))), {"model": EDIT_MODELS["mossedit"], "steps": n_steps}
    if which == "h3image":
        # MiniMax H3 Image as ComfyUI's "Image Edit" template runs it: 6 distilled steps at cfg 1;
        # the picture conditions the text encoder and is anchored as a reference latent.
        unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
        clip = g.add("CLIPLoader", clip_name=files["clip"], type="minimax", device="default")
        vae = g.add("VAELoader", vae_name=files["vae"])
        cond = g.add("MiniMaxH3ImageConditioning", clip=o(clip), vae=o(vae), prompt=text, width=0, height=0,
                     **{"images.image_1": o(ref)}, **{f"images.image_{i + 2}": o(x) for i, x in enumerate(extra)})
        neg = g.add("ConditioningZeroOut", conditioning=o(cond, 0))
        n_steps = 6
        model = chain_loras(g, unet, loras)
        sampled = g.add("KSampler", model=o(model), positive=o(cond, 0), negative=o(neg), latent_image=o(cond, 1),
                        seed=int(seed), steps=n_steps, cfg=1.0, sampler_name="euler", scheduler="simple", denoise=1.0)
        return o(g.add("VAEDecode", samples=o(sampled), vae=o(vae))), {"model": EDIT_MODELS["h3image"], "steps": n_steps}
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=files["clip"], type="qwen_image", device="default")
    vae = g.add("VAELoader", vae_name=files["vae"])
    fast = bool(files.get("lightning_lora"))
    model = unet
    if fast:
        model = g.add("LoraLoaderModelOnly", model=o(model), lora_name=files["lightning_lora"], strength_model=1.0)
    model = chain_loras(g, model, loras)
    model = g.add("ModelSamplingAuraFlow", model=o(model), shift=3.1)
    model = g.add("CFGNorm", model=o(model), strength=1.0)
    more = {f"image{i + 2}": o(x) for i, x in enumerate(extra)}
    pos = g.add("TextEncodeQwenImageEditPlus", clip=o(clip), prompt=text, vae=o(vae), image1=o(ref), **more)
    neg = g.add("TextEncodeQwenImageEditPlus", clip=o(clip), prompt="", vae=o(vae), image1=o(ref), **more)
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
    references: int = 0,
    megapixels: float | None = None,
    loras: list[tuple[str, float]] | None = None,
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
               result is scaled back to the picture's size. With `references` (image_inputs ref_0...),
               more pictures the instruction names as Picture 2... (a 3D scene's object pictures).
    edit_model picks the model for erase, replace and instruct: "qwen" (Qwen Image Edit 2511),
    "h3image" (MiniMax H3 Image, 6 steps) or "mossedit" (MOSS-Image Edit, 30 steps).
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
        # `megapixels`: work at that size and return it (the source's shape); else the model's size, returned at the source's
        ref = g.add("ImageScaleToTotalPixels", image=o(src), upscale_method="lanczos",
                    megapixels=float(megapixels or EDIT_MEGAPIXELS.get(edit_model, 1.0)), resolution_steps=32)
        extra = []
        for i in range(references):
            load = g.add("LoadImage", image="")
            inputs[f"ref_{i}"] = load
            extra.append(g.add("ImageScaleToTotalPixels", image=o(load), upscale_method="lanczos", megapixels=1.0, resolution_steps=32))
        decoded, model_info = _edit_model(g, edit_model, files, ref, prompt.strip(), seed=seed, steps=steps, extra=extra, loras=loras)
        if loras:
            model_info["loras"] = len([1 for _, k in loras if abs(float(k)) >= 1e-6])
        if references:
            model_info["references"] = references
        if megapixels:
            model_info["megapixels"] = megapixels
        out = decoded if megapixels else o(g.add("ImageScale", image=decoded, upscale_method="lanczos", width=o(size, 0), height=o(size, 1), crop="disabled"))
        save = g.add("SaveImage", images=out, filename_prefix=prefix)
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


# --------------------------------------------------------------------------- 3D

# What Make 3D needs (ComfyUI's "Pixal3D / TRELLIS.2 image to model" template, its TRELLIS.2 branch).
TRELLIS_FILES = {
    "unet": "trellis_2_int8_convrot.safetensors",
    "clip_vision": "dino_v3_L_naf_fp32.safetensors",
    "shape_vae": "trellis_2_shape_vae_bf16.safetensors",
    "texture_vae": "trellis_2_texture_vae_bf16.safetensors",
}
MAKE3D_QUALITY = {"standard": (200_000, 2048), "high": (700_000, 4096),
                  # Make 3D figure: light enough for the page to re-pose (skin) it every frame
                  "figure": (60_000, 2048)}  # faces, texture size
# Make 3D figure: SAM 3D Body's model (ComfyUI's models/detection) and the nodes that fit it and write its rigged body
SAM3D_BODY_NODES = ("SAM3DBody_Loader", "SAM3DBody_Predict", "BuildPoseFile")
# ...and the A-pose picture it starts from: arms well away from the body and the legs apart, so the textured model has
# a surface of its own under each arm and between the legs, and comes apart cleanly when it's posed
FIGURE_APOSE_PROMPT = (
    "Show the same person, with exactly the same face, hair, body, clothes and shoes, standing in an A-pose for a 3D "
    "scan: facing the camera straight on, arms held straight out and down at 45 degrees away from the body so there is "
    "clear space between the arms and the body and clothes, palms facing forward, feet apart at shoulder width with a "
    "clear gap between the legs. Their whole body from head to feet is in the frame, centred, on a plain light grey "
    "backdrop with soft even light.")


def build_make3d(files: dict[str, str], *, seed: int, quality: str = "standard", masked: bool = False,
                 bg_model: str | None = None, prefix: str = "bob/3d") -> Built:
    """A textured 3D model (GLB) of the object in one picture, with TRELLIS.2 as ComfyUI's template runs it:
    structure -> shape (upsampled to 1536) -> texture, then remeshed, decimated, UV-unwrapped and baked (colour,
    normal map, ambient occlusion). image_inputs: source (the picture) and, when ``masked``, mask (white = the
    object); otherwise the background is removed with ``bg_model`` (BiRefNet)."""
    g = Graph()
    o = Graph.out
    faces, tex = MAKE3D_QUALITY.get(quality, MAKE3D_QUALITY["standard"])
    unet = g.add("UNETLoader", unet_name=files["unet"], weight_dtype="default")
    vision = g.add("CLIPVisionLoader", clip_name=files["clip_vision"])
    svae = g.add("VAELoader", vae_name=files["shape_vae"])
    tvae = g.add("VAELoader", vae_name=files["texture_vae"])
    src = g.add("LoadImage", image="")
    inputs = {"source": src}
    if masked:
        mload = g.add("LoadImage", image="")
        inputs["mask"] = mload
        mask = g.add("ImageToMask", image=o(mload), channel="red")
    else:
        bg = g.add("LoadBackgroundRemovalModel", bg_removal_name=bg_model)
        mask = g.add("RemoveBackground", bg_removal_model=o(bg), image=o(src))
    crop = g.add("ImageCropToMask", images=o(src), masks=o(mask), width=1024, height=1024, pad_factor=1.1,
                 grow_mask=0, background="#000000")
    cond = g.add("Trellis2Conditioning", clip_vision_model=o(vision), image=o(crop))
    pos, neg = o(cond, 0), o(cond, 1)
    s = int(seed) % (2**32)
    # structure
    m1 = g.add("ModelSamplingSD3", model=o(g.add("RescaleCFG", model=o(g.add(
        "CFGOverride", model=o(unet), cfg=1.0, start_percent=0.667, end_percent=1.0)), multiplier=0.7)), shift=5.0)
    k1 = g.add("KSampler", model=o(m1), positive=pos, negative=neg, latent_image=o(g.add("EmptyTrellis2LatentStructure", batch_size=1)),
               seed=s, steps=12, cfg=7.5, sampler_name="euler", scheduler="normal", denoise=1.0)
    voxel = g.add("VaeDecodeStructureTrellis2", samples=o(k1), vae=o(svae), resolution="32")
    # shape, then upsampled
    stage = g.add("Trellis2ShapeStage", positive=pos, negative=neg, voxel=o(voxel))
    m2 = g.add("RescaleCFG", model=o(g.add("CFGOverride", model=o(unet), cfg=1.0, start_percent=0.769, end_percent=1.0)),
               multiplier=0.5)
    k2 = g.add("KSampler", model=o(m2), positive=o(stage, 0), negative=o(stage, 1), latent_image=o(stage, 2),
               seed=s + 1, steps=20, cfg=7.5, sampler_name="euler", scheduler="normal", denoise=1.0)
    up = g.add("Trellis2UpsampleStage", positive=o(stage, 0), negative=o(stage, 1), shape_latent=o(k2), vae=o(svae),
               target_resolution=1536)
    k3 = g.add("KSampler", model=o(m2), positive=o(up, 0), negative=o(up, 1), latent_image=o(up, 2),
               seed=s + 1, steps=12, cfg=7.5, sampler_name="euler", scheduler="simple", denoise=1.0)
    shape = g.add("VaeDecodeShapeTrellis", samples=o(k3), vae=o(svae))
    # texture
    tstage = g.add("Trellis2TextureStage", positive=o(up, 0), negative=o(up, 1), shape_latent=o(k3))
    k4 = g.add("KSampler", model=o(unet), positive=o(tstage, 0), negative=o(tstage, 1), latent_image=o(tstage, 2),
               seed=s + 2, steps=12, cfg=1.0, sampler_name="euler", scheduler="normal", denoise=1.0)
    colors = g.add("VaeDecodeTextureTrellis", samples=o(k4), vae=o(tvae), shape_subdivides=o(shape, 1))
    # a clean, lighter mesh with a baked texture
    info = g.add("GetMeshInfo", mesh=o(shape, 0))
    remesh = g.add("RemeshMesh", mesh=o(info, 0), resolution=768, sign_mode="solid", **{"sign_mode.fill": 20.0,
                   "sign_mode.qef": False}, band=1.0, project_back=0.0, fix_poles=False, smooth_iters=20,
                   drop_small_components=0.01, precluster_max_verts=20_000_000)
    low = g.add("MeshSmoothNormals", mesh=o(g.add("DecimateMesh", mesh=o(remesh), target_face_count=faces,
                                                   placement_mode="midpoint")), crease_angle=180.0)
    uv = g.add("UnwrapMesh", mesh=o(low), segmenter="pec", resolution=tex, padding=1, weld_distance=0.0002)
    bake = g.add("BakeTextureFromVoxel", mesh=o(uv), voxel_colors=o(colors), texture_size=tex, reference_mesh=o(shape, 0))
    normal = g.add("BakeNormalMapFromMesh", low_poly=o(uv), high_poly=o(remesh), resolution=min(tex, 2048),
                   cage_distance=0.05, ignore_backfaces=True)
    ao = g.add("BakeAmbientOcclusion", low_poly=o(uv), high_poly=o(remesh), resolution=1024, samples=64,
               max_distance=0.71, strength=1.0, bias=0.01)
    textured = g.add("ApplyTextureToMesh", mesh=o(uv), base_color=o(bake, 0), metallic=o(bake, 1), roughness=o(bake, 2),
                     occlusion=o(ao), normal_map=o(normal))
    final = g.add("MeshSmoothNormals", mesh=o(textured), crease_angle=180.0)
    save = g.add("SaveGLB", mesh=o(final), filename_prefix=prefix)
    preview = g.add("SaveImage", images=o(crop), filename_prefix=prefix + "_input")
    return Built(graph=g.nodes, outputs=[save, preview], image_inputs=inputs,
                 info={"model": "TRELLIS.2", "faces": faces, "texture": tex, "quality": quality})


def build_sam3d_body(model_file: str, *, prefix: str = "bob/3d/body") -> Built:
    """SAM 3D Body (ComfyUI's own nodes) fitted to the person in a picture, written as its rigged body: a GLB of the
    MHR body mesh with its 127-bone skeleton and skin weights, the bones as they stand in the picture (figrig.Body).
    image_inputs: source."""
    g = Graph()
    o = Graph.out
    src = g.add("LoadImage", image="")
    model = g.add("SAM3DBody_Loader", model_file=model_file)
    fit = g.add("SAM3DBody_Predict", sam3d_body_model=o(model), image=o(src), run_hand_refinement=True, fov=0.0, batch_size=8)
    body = g.add("BuildPoseFile", pose_data=o(fit), format="glb", **{"format.mesh_style": "body_mesh",
                 "format.mesh_style.bone_vis": "off", "format.mesh_style.shader": "default", "format.bone_smooth_window": 0},
                 fps=24.0, camera_translation="off", track_index=0, sam3d_body_model=o(model))
    save = g.add("SaveGLB", mesh=o(body), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs={"source": src}, info={"model": "SAM 3D Body"})


def build_scene_background(*, largest: int = 1280, decimation: int = 2, prefix: str = "bob/scene") -> Built:
    """The background of a 3D scene: Depth Anything 3 turns the picture into a textured surface mesh (a GLB, glTF
    axes: camera at the origin looking down -Z, Y up). Each vertex's UV is its place in the picture and -Z its depth.

    Multi-view mode with ray_pose is the one that estimates the camera from a single picture (cam_dec returns none),
    but its intrinsics are in the model's working size while the mesh is laid on the picture's own grid, so the mesh
    is skewed. The page rebuilds it from UV and depth, with the field of view read from the mesh (principal point /
    focal length, which doesn't depend on that size; app/model3d.py). image_inputs: source."""
    g = Graph()
    o = Graph.out
    src = g.add("LoadImage", image="")
    pic = g.add("ImageScaleToMaxDimension", image=o(src), upscale_method="area", largest_size=int(largest))
    model = g.add("LoadDA3Model", model_name="depth_anything_3_base.safetensors", weight_dtype="default")
    geo = g.add("DA3Inference", da3_model=o(model), image=o(pic), resolution=1008, resize_method="upper_bound_resize",
                mode="multiview", **{"mode.ref_view_strategy": "first", "mode.pose_method": "ray_pose"})
    mesh = g.add("DA3GeometryToMesh", da3_geometry=o(geo), batch_index=0, decimation=int(decimation),
                 discontinuity_threshold=0.04, confidence_threshold=0.0, use_sky_mask=False, texture=True)
    save = g.add("SaveGLB", mesh=o(mesh), filename_prefix=prefix)
    return Built(graph=g.nodes, outputs=[save], image_inputs={"source": src}, info={"model": "Depth Anything 3"})
