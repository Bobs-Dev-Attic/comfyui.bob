"""Small picture fixes done here rather than in ComfyUI (PIL only, no models)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

_MARK = (255, 0, 255)


def whiten_backdrop(path: Path, *, thresh: int = 36, feather: float = 1.5) -> float:
    """Turn a plain light backdrop pure white, in place: flood it from the picture's edges (from every
    edge pixel that looks like backdrop: light and grey), then blend white over the flooded area with a
    soft edge so hair keeps its fine strands. Returns the share of the picture made white (0 when there
    was no plain light backdrop touching the edges, or when nearly everything matched and it was left alone)."""
    im = Image.open(path)
    im.load()
    rgb = im.convert("RGB")
    w, h = rgb.size
    work = rgb.copy()
    px = rgb.load()
    step = max(1, min(w, h) // 64)
    seeds = [(x, y) for x in range(0, w, step) for y in (0, h - 1)] + [(x, y) for y in range(0, h, step) for x in (0, w - 1)]
    for x, y in seeds:
        r, g, b = px[x, y]
        if min(r, g, b) >= 170 and max(r, g, b) - min(r, g, b) <= 18 and work.getpixel((x, y)) != _MARK:
            ImageDraw.floodfill(work, (x, y), _MARK, thresh=thresh)
    hard = ImageChops.difference(work, Image.new("RGB", rgb.size, _MARK)).convert("L").point(lambda v: 255 if v == 0 else 0)
    share = hard.histogram()[255] / (w * h)
    if share == 0 or share > 0.95:
        return 0.0
    mask = hard.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(feather))
    out = Image.composite(Image.new("RGB", rgb.size, (255, 255, 255)), rgb, mask)
    out.save(path, **({"pnginfo": _pnginfo(im)} if path.suffix.lower() == ".png" else {"quality": 95}))
    return share


def _pnginfo(im: Image.Image):
    """Keep the PNG text chunks (ComfyUI's workflow and prompt) when re-saving."""
    from PIL.PngImagePlugin import PngInfo

    info = PngInfo()
    for k, v in (getattr(im, "text", None) or {}).items():
        info.add_text(k, v)
    return info


def mask_rect(mask: Path, out: Path, *, pad: int = 8) -> Path:
    """A white rectangle over the bounding box of the white area of ``mask`` (a little padded),
    the same size as the mask: the image editor marks this for Erase and Replace."""
    with Image.open(mask) as m0:
        m = m0.convert("L").point(lambda v: 255 if v > 127 else 0)
    box = m.getbbox()
    rect = Image.new("L", m.size, 0)
    if box:
        x0, y0, x1, y1 = box
        ImageDraw.Draw(rect).rectangle((max(0, x0 - pad), max(0, y0 - pad), min(m.width, x1 + pad) - 1,
                                        min(m.height, y1 + pad) - 1), fill=255)
    rect.convert("RGB").save(out)
    return out
