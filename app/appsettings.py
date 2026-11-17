"""App-wide settings, kept as JSON in data/settings.json (the Settings window, static/settings.js).

Every field has a default, so a missing or partial file is fine; unknown keys are dropped and
out-of-range values are rejected. Project versions (projects.backup) read their limits from here.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import config

PATH: Path = config.DATA_DIR / "settings.json"

THEMES = ("system", "dark", "light", "midnight", "graphite", "forest", "paper", "high-contrast")
ACCENTS = ("orange", "blue", "violet", "green", "pink", "teal", "gold", "red")


class _Section(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Appearance(_Section):
    theme: Literal[THEMES] = "system"  # type: ignore[valid-type]
    accent: Literal[ACCENTS] = "orange"  # type: ignore[valid-type]
    font_size: Literal["small", "normal", "large"] = "normal"
    reduce_motion: bool = False


class Projects(_Section):
    versions_keep: int = Field(30, ge=5, le=500)          # automatic versions kept per project
    version_minutes: float = Field(1.0, ge=0.25, le=240)  # at most one automatic version this often
    version_on_start: bool = True                         # a version of every project when the app starts
    reopen_last: bool = True                              # open the last project when the app opens


class Generation(_Section):
    confirm_delete: bool = True     # ask before deleting a result and its file
    sound_when_done: bool = False   # a short chime when a job finishes
    notify_when_done: bool = False  # a desktop notification when a job finishes while the tab is hidden


class Editor(_Section):
    edit_model: Literal["qwen", "h3image"] = "qwen"  # Erase, Replace and whole-picture edits


class Updates(_Section):
    # auto: install new versions from GitHub when nothing is rendering, then restart; notify: only say so; off: never check
    mode: Literal["auto", "notify", "off"] = "auto"
    check_minutes: int = Field(5, ge=1, le=1440)


class AppSettings(_Section):
    appearance: Appearance = Field(default_factory=Appearance)
    projects: Projects = Field(default_factory=Projects)
    generation: Generation = Field(default_factory=Generation)
    editor: Editor = Field(default_factory=Editor)
    updates: Updates = Field(default_factory=Updates)


_lock = threading.Lock()
_cache: AppSettings | None = None


def _read() -> AppSettings:
    try:
        raw = json.loads(PATH.read_text("utf-8"))
    except (OSError, ValueError):
        return AppSettings()
    try:
        return AppSettings.model_validate(raw if isinstance(raw, dict) else {})
    except ValidationError:
        # One bad value must not lose the others: keep each section that still validates.
        out = AppSettings()
        for name in AppSettings.model_fields:
            try:
                setattr(out, name, type(getattr(out, name)).model_validate(raw.get(name) or {}))
            except (ValidationError, AttributeError):
                pass
        return out


def get() -> AppSettings:
    global _cache
    with _lock:
        if _cache is None:
            _cache = _read()
        return _cache


def _write(s: AppSettings) -> AppSettings:
    global _cache
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(s.model_dump(), indent=2), "utf-8")
    tmp.replace(PATH)
    _cache = s
    return s


def _merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def update(patch: dict[str, Any]) -> AppSettings:
    """Merge a partial settings dict (e.g. {"appearance": {"theme": "light"}}); raises ValueError on bad values."""
    with _lock:
        current = _cache or _read()
        try:
            new = AppSettings.model_validate(_merge(current.model_dump(), patch))
        except ValidationError as exc:
            err = exc.errors()[0]
            raise ValueError(f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}") from exc
        return _write(new)


def replace(data: dict[str, Any]) -> AppSettings:
    """Replace everything (an imported settings file); missing values get their defaults."""
    with _lock:
        try:
            new = AppSettings.model_validate(data)
        except ValidationError as exc:
            err = exc.errors()[0]
            raise ValueError(f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}") from exc
        return _write(new)


def reset() -> AppSettings:
    with _lock:
        return _write(AppSettings())


def payload() -> dict[str, Any]:
    return {"settings": get().model_dump(), "defaults": AppSettings().model_dump(),
            "file": "data/settings.json", "themes": list(THEMES), "accents": list(ACCENTS)}
