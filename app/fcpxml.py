"""Export a project's timeline as FCPXML 1.9 for DaVinci Resolve (and Final Cut Pro).

Layout of the file:
  - The lowest video track is the primary storyline (<spine>): its clips in order, with <gap>s
    filling the empty time, so the spine covers the whole edit.
  - Every other clip is a connected clip on a lane: upper video tracks are lanes 1, 2, ...
    (one per track, nearest first) and audio tracks are lanes -1, -2, .... Resolve imports
    lanes as separate tracks (V2, V3..., A2...).
  - Times are whole frames written as "N/fps s". Connected clips are attached to the spine item
    their start falls in, with offsets in that item's own time, as FCPXML requires.
  - Media is referenced in place (file:/// URLs); nothing is copied. Stills use <video> with a
    duration; muted or hidden tracks export disabled clips; volume becomes <adjust-volume>.
    Markers go on the spine item they fall in.
  - Transitions: in the studio a transition is an overlap of two clips. FCPXML (and Resolve) want a
    transition centred on a cut that borrows frames past it, so each overlap becomes a cut at its
    middle plus a <transition> spanning the old overlap; both clips have exactly the frames that needs.
    On the primary storyline it is exported as a Cross Dissolve (the type FCPXML importers map
    reliably); overlaps on other tracks become plain cuts at the middle.
  - A video clip whose sound moved to a linked audio clip is exported silent (-96 dB), so the sound
    isn't doubled.
"""
from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import media
from .projectfile import TRANSITIONS, Clip, Timeline
from .render import transitions_by_clip

VERSION = "1.9"


def _file_url(p: Path) -> str:
    posix = p.resolve().as_posix()
    if not posix.startswith("/"):  # Windows drive path: file:///E:/...
        posix = "/" + posix
    return "file://" + quote(posix, safe="/:")


def build(tl: Timeline, name: str = "Bob Studio") -> bytes:
    fps = tl.fps
    F = lambda t: max(0, int(round(t * fps)))           # seconds -> frames  # noqa: E731
    T = lambda f: "0s" if f == 0 else f"{f}/{fps}s"    # frames -> FCPXML time  # noqa: E731

    tracks = {t.id: t for t in tl.tracks}
    order = {t.id: i for i, t in enumerate(tl.tracks)}
    clips = [c.model_copy() for c in tl.clips if c.track in tracks and c.trim_out > c.trim_in]
    # Overlaps (transitions) -> a cut in the middle; remember the ones to export as <transition>.
    out_of, _into = transitions_by_clip(Timeline(**{**tl.model_dump(), "clips": [c.model_dump() for c in clips]}))
    by_id = {c.id: c for c in clips}
    cut_transitions: dict[str, tuple[float, float, str]] = {}  # incoming clip id -> (start s, length s, type)
    for a_id, t in out_of.items():
        a, b = by_id[a_id], by_id[t.b]
        d = a.end - b.start
        mid = b.start + d / 2
        a.trim_out -= a.end - mid
        b.trim_in += mid - b.start
        cut_transitions[b.id] = (mid - d / 2, d, t.type)
        b.start = mid
    if not clips:
        raise ValueError("The timeline is empty")
    video_tracks = [t for t in tl.tracks if t.kind == "video"]
    audio_tracks = [t for t in tl.tracks if t.kind == "audio"]
    bottom = video_tracks[-1] if video_tracks else None
    end_f = max(F(c.end) for c in clips)

    # ---------------------------------------------------------------- resources
    root = ET.Element("fcpxml", version=VERSION)
    res = ET.SubElement(root, "resources")
    formats: dict[tuple[int, int], str] = {}
    assets: dict[str, dict[str, Any]] = {}
    next_id = [1]

    def rid() -> str:
        next_id[0] += 1
        return f"r{next_id[0]}"

    def fmt(w: int, h: int) -> str:
        if (w, h) not in formats:
            formats[(w, h)] = fid = rid()
            ET.SubElement(res, "format", id=fid, frameDuration=f"1/{fps}s",
                          width=str(w), height=str(h))
        return formats[(w, h)]

    # Sequence format: the first picture's size (like the renderer), else 1920x1080.
    first_pic = next((c for c in sorted(clips, key=lambda c: c.start) if c.kind != "audio"), None)
    info0 = media.probe(first_pic.ref) if first_pic else {}
    seq_w, seq_h = info0.get("width") or 1920, info0.get("height") or 1080
    seq_fmt = fmt(seq_w, seq_h)

    for c in clips:
        if c.ref in assets:
            continue
        path = media.resolve(c.ref)
        info = media.probe(c.ref)
        a: dict[str, Any] = {"id": rid(), "name": path.name, "start": "0s"}
        if c.kind == "image":
            a.update(hasVideo="1", duration="0s", format=fmt(info["width"], info["height"]))
        else:
            dur = info.get("duration") or c.source_duration or (c.trim_out - c.trim_in)
            a["duration"] = T(F(dur))
            if c.kind == "video":
                a.update(hasVideo="1", format=fmt(info.get("width") or seq_w, info.get("height") or seq_h))
            if info.get("has_audio"):
                a.update(hasAudio="1", audioSources="1", audioChannels="2", audioRate="48000")
        el = ET.SubElement(res, "asset", **a)
        ET.SubElement(el, "media-rep", kind="original-media", src=_file_url(path))
        assets[c.ref] = {"id": a["id"], "audio": bool(info.get("has_audio")), "kind": c.kind}

    # ---------------------------------------------------------------- sequence
    lib = ET.SubElement(root, "library")
    event = ET.SubElement(lib, "event", name=name)
    project = ET.SubElement(event, "project", name=name)
    seq = ET.SubElement(project, "sequence", format=seq_fmt, duration=T(end_f), tcStart="0s", tcFormat="NDF",
                        audioLayout="stereo", audioRate="48k")
    spine = ET.SubElement(seq, "spine")

    def clip_el(parent: ET.Element, c: Clip, offset_f: int, lane: int | None) -> ET.Element:
        tr = tracks[c.track]
        a = assets[c.ref]
        attrs = {"ref": a["id"], "offset": T(offset_f), "name": c.name or Path(c.ref).name,
                 "duration": T(F(c.end) - F(c.start))}
        if lane is not None:
            attrs["lane"] = str(lane)
        if c.kind == "image":
            attrs["start"] = "0s"
            el = ET.SubElement(parent, "video", **attrs)
        else:
            attrs["start"] = T(F(c.trim_in))
            if c.kind == "video" and a["audio"]:
                attrs["audioRole"] = "dialogue"
            el = ET.SubElement(parent, "asset-clip", **attrs)
        if tr.muted and (tr.kind == "audio" or c.kind == "audio"):
            el.set("enabled", "0")
        if tr.hidden and tr.kind == "video":
            el.set("enabled", "0")
        gain = 0.0 if (c.kind == "video" and c.audio_off) or c.muted else c.volume * tr.volume
        if c.kind != "image" and abs(gain - 1) > 1e-3 and (a["audio"] or c.kind == "audio"):
            db = -96.0 if gain <= 0 else 20 * math.log10(gain)
            ET.SubElement(el, "adjust-volume", amount=f"{db:+.1f}dB")
        return el

    effect_id: list[str] = []

    def dissolve() -> str:
        if not effect_id:  # Final Cut's built-in Cross Dissolve; Resolve maps it to its own
            effect_id.append(rid())
            ET.SubElement(res, "effect", id=effect_id[0], name="Cross Dissolve",
                          uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265")
        return effect_id[0]

    # Spine: the bottom video track, gaps in between. Each item: (offset_f, end_f, local_start_f, element)
    items: list[tuple[int, int, int, ET.Element]] = []
    pos = 0
    base = sorted((c for c in clips if bottom and c.track == bottom.id), key=lambda c: c.start)
    for c in base:
        s, e = F(c.start), F(c.end)
        if s > pos:
            g = ET.SubElement(spine, "gap", name="Gap", offset=T(pos), start="0s", duration=T(s - pos))
            items.append((pos, s, 0, g))
        if c.id in cut_transitions and items and items[-1][1] == s:
            t0, d, kind = cut_transitions[c.id]
            ET.SubElement(spine, "transition", name="Cross Dissolve", offset=T(F(t0)), duration=T(max(1, F(d)))).append(
                ET.Element("filter-video", ref=dissolve(), name="Cross Dissolve"))
        el = clip_el(spine, c, s, None)
        items.append((s, e, 0 if c.kind == "image" else F(c.trim_in), el))
        pos = e
    if pos < end_f:
        g = ET.SubElement(spine, "gap", name="Gap", offset=T(pos), start="0s", duration=T(end_f - pos))
        items.append((pos, end_f, 0, g))

    def host(t_f: int) -> tuple[int, int, int, ET.Element]:
        for it in items:
            if it[0] <= t_f < it[1]:
                return it
        return items[-1]

    def lane_of(c: Clip) -> int:
        tr = tracks[c.track]
        if tr.kind == "video":
            return order[bottom.id] - order[tr.id]  # 1 = the track just above the bottom one
        return -(audio_tracks.index(tr) + 1)

    for c in sorted((c for c in clips if not (bottom and c.track == bottom.id)), key=lambda c: (c.start, lane_of(c))):
        s = F(c.start)
        p_off, _p_end, p_local, p_el = host(s)
        clip_el(p_el, c, p_local + (s - p_off), lane_of(c))

    for m in sorted(tl.markers, key=lambda m: m.t):
        t = min(F(m.t), max(0, end_f - 1))
        p_off, _p_end, p_local, p_el = host(t)
        ET.SubElement(p_el, "marker", start=T(p_local + (t - p_off)), duration=f"1/{fps}s", value=m.label or "Marker")

    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + body + "\n").encode("utf-8")
