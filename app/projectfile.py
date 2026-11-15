"""The project.json format (schema "bob.project/2"), validated with pydantic.

    {
      "schema": "bob.project/2",          format id; older files are migrated on load
      "id", "name", "created", "modified", "app_version", "notes", "thumb",
      "settings": { ... },                 what the studio form was set to (StudioSettings)
      "config":   { ... },                 per-project preferences (ProjectConfig)
      "library":  { "media": [...], "tags": [...], "virtual_folders": [...] }
    }

docs/PROJECT_FORMAT.md describes every field; docs/project.schema.json is the
JSON Schema generated from these models (python -m app.projectfile).
"""
from __future__ import annotations

import json
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import __version__

SCHEMA = "bob.project/2"
Kind = Literal["image", "video", "audio"]


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def clean_tag(t: str) -> str:
    return re.sub(r"\s+", " ", str(t)).strip()[:40]


# --------------------------------------------------------------------------- settings

class PictureRef(BaseModel):
    """A picture used as an input: `ref` is what the server reads, `url` what the browser shows."""
    ref: str
    url: str = ""


class Frames(BaseModel):
    first_frame: PictureRef | None = None
    last_frame: PictureRef | None = None


class StudioSettings(BaseModel):
    """The studio form, saved as you work. Unknown keys are kept so newer versions can add fields."""
    model_config = ConfigDict(extra="allow")
    v: int = 1
    kind: Kind | None = None
    engine: dict[str, str] = Field(default_factory=dict, description="model per kind, e.g. {'video': 'h3ref'}")
    prompt: str = ""
    lyrics: str = ""
    aspect: str = "16:9"
    quality: str = "draft"
    seconds: float = 5
    seed: str | int = -1
    steps: str | int | None = ""
    batch: int = Field(1, ge=1, le=4)
    turbo: bool = True
    enhance: bool = False
    fidelity: bool = False
    refs: list[PictureRef] = Field(default_factory=list, description="H3 Reference pictures, in <Picture N> order")
    frames: Frames = Field(default_factory=Frames)


# --------------------------------------------------------------------------- config

class GalleryConfig(BaseModel):
    """How the Inputs media gallery looks for this project."""
    source: str = Field("library", description="library | results | uploads | vf:<folder id> | bm:<bookmark id>")
    thumb_size: int = Field(132, ge=72, le=320)
    sort: Literal["added", "name", "modified", "kind"] = "added"
    descending: bool = True
    kind: Literal["all", "image", "video", "audio"] = "all"


class WriterConfig(BaseModel):
    """Prompt writer preferences for this project (None = use the app's)."""
    backend: str | None = None
    model: str | None = None
    dialogue: bool = False
    shots: int | None = Field(None, ge=1, le=6)


class ProjectConfig(BaseModel):
    model_config = ConfigDict(extra="allow")
    gallery: GalleryConfig = Field(default_factory=GalleryConfig)
    writer: WriterConfig = Field(default_factory=WriterConfig)
    autosave: bool = Field(True, description="save changes automatically; off = save with Ctrl+S or the Save button")
    autosave_delay: float = Field(0.7, ge=0.2, le=300, description="seconds after the last change before saving")
    defaults: dict[str, Any] = Field(default_factory=dict, description="settings a reset goes back to")


# --------------------------------------------------------------------------- library

class MediaItem(BaseModel):
    """A file in the project's library. Only the reference is stored; the file stays where it is."""
    id: str = Field(default_factory=new_id)
    ref: str = Field(..., description="data/uploads/…, outputs/…, or an absolute path inside a bookmarked folder")
    kind: Kind
    name: str
    added: float = Field(default_factory=time.time)
    source: Literal["upload", "output", "bookmark", "other"] = "other"
    tags: list[str] = Field(default_factory=list)
    rating: int = Field(0, ge=0, le=5)
    note: str = ""

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        seen, out = set(), []
        for t in (clean_tag(x) for x in v):
            if t and t.lower() not in seen:
                seen.add(t.lower())
                out.append(t)
        return out


class TagDef(BaseModel):
    name: str
    color: str = Field("", description="CSS colour; empty = automatic")


class VirtualFolder(BaseModel):
    """A saved view of the library: every item whose tags match. Items aren't moved or copied."""
    id: str = Field(default_factory=new_id)
    name: str
    tags: list[str] = Field(default_factory=list)
    match: Literal["all", "any"] = "all"
    kinds: list[Kind] = Field(default_factory=list, description="empty = every kind")
    created: float = Field(default_factory=time.time)


class Library(BaseModel):
    media: list[MediaItem] = Field(default_factory=list)
    tags: list[TagDef] = Field(default_factory=list)
    virtual_folders: list[VirtualFolder] = Field(default_factory=list)


# --------------------------------------------------------------------------- timeline

class Track(BaseModel):
    """A lane on the timeline. Upper video tracks cover lower ones."""
    id: str = Field(default_factory=new_id)
    kind: Literal["video", "audio"]
    name: str
    muted: bool = False
    locked: bool = False
    hidden: bool = Field(False, description="video tracks only: leave out of the picture")
    volume: float = Field(1.0, ge=0, le=2)
    pan: float = Field(0, ge=-1, le=1)
    solo: bool = Field(False, description="when any track is soloed, only soloed tracks are heard")
    height: int = Field(56, ge=28, le=200)


class Light(BaseModel):
    """A light painted onto the picture (ideas from AInVFX Paint a Plate, Apache-2.0).

    relight: multiplies the picture by a soft light ratio, so its texture stays (light falling on things);
    glow: adds light on top (a lamp, a haze); shade: darkens (a shadow, a flag). Position is a fraction
    of the picture; with x2/y2 the light travels there over the clip."""
    mode: Literal["relight", "glow", "shade"] = "relight"
    x: float = Field(0.5, ge=-0.5, le=1.5, description="0 = left edge, 1 = right edge")
    y: float = Field(0.35, ge=-0.5, le=1.5, description="0 = top, 1 = bottom")
    x2: float | None = Field(None, ge=-0.5, le=1.5, description="where it ends up at the clip's end (None = still)")
    y2: float | None = Field(None, ge=-0.5, le=1.5)
    radius: float = Field(0.35, ge=0.02, le=3, description="soft radius, × the picture's shorter side")
    intensity: float = Field(1.0, ge=0, le=4)
    color: str = Field("#ffd890", pattern=r"^#[0-9a-fA-F]{6}$")
    flicker: float = Field(0, ge=0, le=1, description="0 = steady, 1 = strong flicker (fire, a failing bulb)")


class VideoFx(BaseModel):
    """Picture effects of one clip, applied before it's placed on the canvas."""
    enabled: bool = True
    exposure: float = Field(0, ge=-3, le=3, description="stops")
    contrast: float = Field(1, ge=0.2, le=3)
    saturation: float = Field(1, ge=0, le=3)
    temperature: float = Field(0, ge=-100, le=100, description="− cooler (blue), + warmer (orange)")
    tint: float = Field(0, ge=-100, le=100, description="− green, + magenta")
    look: Literal["none", "bw", "sepia"] = "none"
    vignette: float = Field(0, ge=0, le=1)
    blur: float = Field(0, ge=0, le=20, description="pixels at 1080p")
    sharpen: float = Field(0, ge=0, le=2)
    grain: float = Field(0, ge=0, le=1)
    lights: list[Light] = Field(default_factory=list, max_length=4)


class Clip(BaseModel):
    """A piece of a media file placed on a track. Times are seconds."""
    id: str = Field(default_factory=new_id)
    track: str
    ref: str
    kind: Kind
    name: str = ""
    start: float = Field(0, ge=0, description="where the clip begins on the timeline")
    trim_in: float = Field(0, ge=0, description="first second of the source used")
    trim_out: float = Field(..., gt=0, description="last second of the source used (exclusive)")
    source_duration: float | None = Field(None, description="length of the source file; None for stills")
    volume: float = Field(1.0, ge=0, le=2)
    color: str = ""
    job: str | None = Field(None, description="the studio result this clip came from")
    link: str | None = Field(None, description="clips sharing a link id move, trim, split and delete together")
    audio_off: bool = Field(False, description="video clip whose own sound is off because a linked audio clip carries it")
    muted: bool = Field(False, description="this clip's sound is off")
    pan: float = Field(0, ge=-1, le=1, description="-1 = left, 0 = centre, 1 = right")
    fade_in: float = Field(0, ge=0, description="seconds of sound fade-in at the clip's start")
    fade_out: float = Field(0, ge=0, description="seconds of sound fade-out at the clip's end")
    fx: VideoFx | None = Field(None, description="picture effects: grading, lights, vignette, blur, grain")

    @property
    def end(self) -> float:
        return self.start + self.trim_out - self.trim_in


class Marker(BaseModel):
    id: str = Field(default_factory=new_id)
    t: float = Field(..., ge=0)
    label: str = ""
    color: str = ""


TRANSITIONS = {  # ffmpeg xfade name -> label; audio transitions are always a crossfade
    "fade": "Cross dissolve", "fadeblack": "Dip to black", "fadewhite": "Dip to white", "dissolve": "Pixel dissolve",
    "wipeleft": "Wipe left", "wiperight": "Wipe right", "wipeup": "Wipe up", "wipedown": "Wipe down",
    "slideleft": "Slide left", "slideright": "Slide right", "slideup": "Slide up", "slidedown": "Slide down",
    "smoothleft": "Smooth left", "smoothright": "Smooth right", "coverleft": "Push left", "coverright": "Push right",
    "circleopen": "Circle open", "circleclose": "Circle close", "radial": "Radial", "zoomin": "Zoom in",
    "pixelize": "Pixelate", "hblur": "Blur", "squeezeh": "Squeeze", "horzopen": "Barn door",
}


class Transition(BaseModel):
    """Two clips on the same track overlap and blend: `a` plays out while `b` comes in.
    Its length is the overlap (a.end − b.start); each clip uses its own frames."""
    id: str = Field(default_factory=new_id)
    track: str
    a: str = Field(..., description="outgoing clip id")
    b: str = Field(..., description="incoming clip id")
    type: str = Field("fade", description="one of TRANSITIONS (ffmpeg xfade names)")


class Master(BaseModel):
    """The final mix."""
    volume: float = Field(1.0, ge=0, le=2)
    loudness: float | None = Field(None, ge=-36, le=-6, description="normalise to this many LUFS (e.g. -14 for web, -23 for broadcast); None = off")
    limiter: bool = Field(True, description="catch peaks so the mix never clips")


class Timeline(BaseModel):
    """The project's edit: tracks, clips, markers and view state. Saved as you work."""
    fps: int = Field(24, ge=1, le=120)
    tracks: list[Track] = Field(default_factory=lambda: [Track(kind="video", name="V1"), Track(kind="audio", name="A1")])
    clips: list[Clip] = Field(default_factory=list)
    markers: list[Marker] = Field(default_factory=list)
    playhead: float = Field(0, ge=0)
    zoom: float = Field(60, ge=2, le=1200, description="pixels per second")
    range_in: float | None = Field(None, ge=0)
    range_out: float | None = Field(None, ge=0)
    snap: bool = True
    transitions: list[Transition] = Field(default_factory=list)
    link_audio: bool = Field(True, description="adding a video with sound also puts its sound on an audio track")
    link_audio_track: Literal["new", "free"] = Field("new", description="new = a new audio track for each video; free = the first free audio track")
    master: Master = Field(default_factory=Master)
    render: dict[str, Any] = Field(default_factory=dict, description="export settings: width, height, crf")


# --------------------------------------------------------------------------- file

class ProjectFile(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="allow")
    schema_: str = Field(SCHEMA, alias="schema")
    id: str = Field(default_factory=new_id)
    name: str
    created: float = Field(default_factory=time.time)
    modified: float = Field(default_factory=time.time)
    app_version: str = __version__
    notes: str = ""
    thumb: str | None = None
    settings: StudioSettings = Field(default_factory=StudioSettings)
    config: ProjectConfig = Field(default_factory=ProjectConfig)
    library: Library = Field(default_factory=Library)
    timeline: Timeline = Field(default_factory=Timeline)

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json")


def migrate(raw: dict[str, Any]) -> dict[str, Any]:
    """Bring an older project.json up to the current schema."""
    raw = dict(raw)
    if raw.get("schema") == SCHEMA:
        return raw
    if raw.get("version") == 1 or "schema" not in raw:  # 0.6.0: flat file, no config or library
        raw.pop("version", None)
        settings = raw.get("settings") or {}
        raw["settings"] = settings
        raw.setdefault("config", {})
        lib = raw.setdefault("library", {})
        # Pictures already used as inputs become the start of the library.
        media, seen = lib.setdefault("media", []), set()
        pics = [*(settings.get("refs") or []), *((settings.get("frames") or {}).values())]
        for p in pics:
            if isinstance(p, dict) and p.get("ref") and p["ref"] not in seen:
                seen.add(p["ref"])
                media.append({"ref": p["ref"], "kind": "image", "name": Path(p["ref"]).name,
                              "source": "output" if p["ref"].startswith("outputs/") else "upload"})
        raw["schema"] = SCHEMA
    return raw


def load(path: Path) -> ProjectFile:
    return ProjectFile.model_validate(migrate(json.loads(path.read_text("utf-8"))))


def save(path: Path, pf: ProjectFile) -> None:
    pf.app_version = __version__
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(pf.dump(), indent=1, ensure_ascii=False), "utf-8")
    tmp.replace(path)


if __name__ == "__main__":  # write docs/project.schema.json
    out = Path(__file__).resolve().parent.parent / "docs" / "project.schema.json"
    out.parent.mkdir(exist_ok=True)
    schema = ProjectFile.model_json_schema(by_alias=True)
    schema["$id"] = "https://github.com/Bobs-Dev-Attic/comfyui.bob/docs/project.schema.json"
    schema["title"] = "Bob Studio project (bob.project/2)"
    out.write_text(json.dumps(schema, indent=2) + "\n", "utf-8")
    print(f"wrote {out}", file=sys.stderr)
