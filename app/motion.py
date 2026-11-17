"""Motion layers (engine "motion"): objects cut out of a picture, moved along paths, rendered by H3.

The method of PxTicks' h3-motion (Time-to-Move on MiniMax H3), rebuilt for this studio:

1. The page selects each object with AI select (SAM 3.1): a white-on-black mask per layer.
2. Erase (the image editor's Qwen edit) removes them all: the empty background, the "plate".
3. The page keys each layer's path; it sends, per frame, the layer's offset (as a share of the picture's
   width and height), its scale and whether it's flipped. The preview draws the same numbers.
4. render() here draws the rough animation (the plate with every cut-out at its place) and a mask video
   (white over the objects) at the generation size, framed like the first frame (centre crop).
5. workflows.build_motion runs H3 from the original picture as the first frame, with vloTimeToMove
   (ComfyUI-vlo) holding the white areas to the rough animation for the first steps, then letting go, so
   H3 keeps the motion but redraws the objects so they belong in the shot, with sound.
"""
from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from . import media

FPS = 24
TOKEN_PX = 32  # H3 holds whole tokens: 2 x 2 latent cells of 16 px


def _fit(iw: int, ih: int, W: int, H: int) -> tuple[float, float, float]:
    """Centre-crop framing of an iw x ih picture on a W x H canvas: (scale, x offset, y offset)."""
    k = max(W / iw, H / ih)
    return k, (W - iw * k) / 2, (H - ih * k) / 2


def _layer(src: Image.Image, mask_path: Path) -> dict[str, Any] | None:
    """A layer's cut-out (RGBA, cropped to the object, softly edged) and where it sits in the picture."""
    with Image.open(mask_path) as m:
        mask = ImageOps.grayscale(m).resize(src.size, Image.Resampling.LANCZOS)
    hard = mask.point(lambda v: 255 if v >= 128 else 0)
    box = hard.getbbox()
    if not box:
        return None
    soft = hard.filter(ImageFilter.GaussianBlur(1.2))
    cut = src.convert("RGBA")
    cut.putalpha(soft)
    return {"cut": cut.crop(box), "hard": hard.crop(box), "box": box}


def load_layers(first_frame: str, masks: list[str]) -> tuple[Image.Image, list[dict[str, Any] | None]]:
    src = Image.open(media.resolve(first_frame)).convert("RGB")
    return src, [_layer(src, media.resolve(m)) for m in masks]


def auto_edge(first_frame: str, layers: list[Any], width: int, height: int) -> int:
    """Edge freedom in canvas pixels (h3-motion's default): up to 16 px of each object's edge is left for H3
    to redraw, but only as much as still leaves every object two tokens (64 px) wide where it's smallest."""
    src, cuts = load_layers(first_frame, [l.mask for l in layers])
    k, _, _ = _fit(src.width, src.height, width, height)
    smallest = math.inf
    for lay, cut in zip(layers, cuts):
        if not cut:
            continue
        bw, bh = cut["cut"].size
        s = min((f[2] for f in lay.frames), default=1.0)
        smallest = min(smallest, min(bw, bh) * k * max(0.05, s))
    if smallest is math.inf:
        return 0
    return int(max(0, min(16, (smallest - 2 * TOKEN_PX) // 2)))


def recolor(img: Image.Image, adjust: dict[str, float] | None) -> Image.Image:
    """An object's colour (Animate objects' right-click menu): hue turned by `hue` degrees (in HSV), then saturation
    and brightness as factors (PIL's Color and Brightness enhancers). The page draws its preview with the same steps."""
    a = adjust or {}
    hue, sat, bri = float(a.get("hue", 0) or 0), float(a.get("sat", 1) if a.get("sat") is not None else 1), float(a.get("bri", 1) if a.get("bri") is not None else 1)
    if abs(hue) < 0.5 and abs(sat - 1) < 1e-3 and abs(bri - 1) < 1e-3:
        return img
    alpha = img.getchannel("A") if img.mode == "RGBA" else None
    rgb = img.convert("RGB")
    if abs(hue) >= 0.5:
        h, s, v = rgb.convert("HSV").split()
        shift = round(hue / 360 * 256) % 256
        h = h.point(lambda x: (x + shift) % 256)
        rgb = Image.merge("HSV", (h, s, v)).convert("RGB")
    if abs(sat - 1) >= 1e-3:
        rgb = ImageEnhance.Color(rgb).enhance(sat)
    if abs(bri - 1) >= 1e-3:
        rgb = ImageEnhance.Brightness(rgb).enhance(bri)
    if alpha is not None:
        rgb = rgb.convert("RGBA")
        rgb.putalpha(alpha)
    return rgb


def frame_of(lay: Any, f: int) -> tuple[float, float, float, bool, float, bool]:
    """A layer's frame: (dx, dy, scale, flipped left-right, rotation in degrees clockwise, flipped upside down)."""
    v = list(lay.frames[min(f, len(lay.frames) - 1)]) + [0, 0, 1, 0, 0, 0][len(lay.frames[0]):]
    dx, dy, s, fh, r, fv = (v + [0, 0, 1, 0, 0, 0])[:6]
    return float(dx), float(dy), max(0.05, float(s)), bool(fh), float(r), bool(fv)


def render(first_frame: str, plate: str, layers: list[Any], width: int, height: int, frames: int,
           out_ref: Path, out_mask: Path, out_first: Path | None = None) -> dict[str, Any]:
    """Draw the rough animation and its mask video (frames x width x height, 24 fps); with out_first, also its first
    frame as a picture (the first frame H3 starts from when the objects are changed at the start)."""
    exe = media.ffmpeg()
    if not exe:
        raise media.MediaError("ffmpeg isn't installed")
    src, cuts = load_layers(first_frame, [l.mask for l in layers])
    for lay, cut in zip(layers, cuts):
        if cut:
            cut["cut"] = recolor(cut["cut"], getattr(lay, "adjust", None))
    iw, ih = src.size
    k, ox, oy = _fit(iw, ih, width, height)
    with Image.open(media.resolve(plate)) as p:
        bg = p.convert("RGB").resize((iw, ih), Image.Resampling.LANCZOS)
    bg = bg.resize((round(iw * k), round(ih * k)), Image.Resampling.LANCZOS)
    base = Image.new("RGB", (width, height))
    base.paste(bg, (round(ox), round(oy)))

    def pipe(path: Path, fmt: str, crf: int):
        out_path = path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        return subprocess.Popen(
            [exe, "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", fmt, "-s", f"{width}x{height}",
             "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", str(crf), "-pix_fmt", "yuv420p", str(out_path)],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=media.NO_WINDOW)

    ref_p, mask_p = pipe(out_ref, "rgb24", 10), pipe(out_mask, "gray", 0)
    try:
        for f in range(frames):
            frame, mask = base.copy(), Image.new("L", (width, height))
            for lay, cut in zip(layers, cuts):
                if not cut:
                    continue
                dx, dy, s, fh, rot, fv = frame_of(lay, f)
                x0, y0, x1, y1 = cut["box"]
                cx, cy = (x0 + x1) / 2 + dx * iw, (y0 + y1) / 2 + dy * ih  # the object's centre, in the picture
                w, h = max(1, round((x1 - x0) * k * s)), max(1, round((y1 - y0) * k * s))
                img, hard = cut["cut"].resize((w, h), Image.Resampling.LANCZOS), cut["hard"].resize((w, h), Image.Resampling.NEAREST)
                # as the page draws it: flips, then the turn about the centre (canvas rotate = clockwise)
                if fh:
                    img, hard = ImageOps.mirror(img), ImageOps.mirror(hard)
                if fv:
                    img, hard = ImageOps.flip(img), ImageOps.flip(hard)
                if abs(rot) >= 0.05:
                    img = img.rotate(-rot, resample=Image.Resampling.BICUBIC, expand=True)
                    hard = hard.rotate(-rot, resample=Image.Resampling.NEAREST, expand=True)
                at = (round(ox + cx * k - img.width / 2), round(oy + cy * k - img.height / 2))
                frame.paste(img, at, img)
                mask.paste(255, (at[0], at[1], at[0] + hard.width, at[1] + hard.height), hard)
            if f == 0 and out_first is not None:
                out_first.parent.mkdir(parents=True, exist_ok=True)
                frame.save(out_first, "PNG")
            ref_p.stdin.write(frame.tobytes())
            mask_p.stdin.write(mask.tobytes())
    finally:
        for proc in (ref_p, mask_p):
            proc.stdin.close()
            proc.wait(timeout=300)
    for proc, path in ((ref_p, out_ref), (mask_p, out_mask)):
        if proc.returncode or not path.is_file():
            raise media.MediaError((proc.stderr.read() or b"").decode("utf-8", "replace")[-300:] or "Couldn't make the motion videos")
    return {"layers": sum(1 for c in cuts if c), "frames": frames}
