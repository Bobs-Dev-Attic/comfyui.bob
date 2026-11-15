"""H3 prompt writer backed by a local LLM: Ollama, or any OpenAI-compatible
server such as llama.cpp's llama-server or LM Studio.

The approach follows EDITS-WITH-AI (Apache-2.0, ideas only): the LLM never writes
the final prompt. It fills short, typed fields through JSON-schema constrained
output, then code assembles them into H3's shot format with frame-snapped
timestamps. A validator checks the fields (negations, filler, word limits,
reference tags, shot count) and sends the problems back for another try.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from PIL import Image

from . import config, workflows

log = logging.getLogger("bob.llm")

FRAMINGS = ["extreme close-up", "close-up", "medium close-up", "medium shot", "full shot", "wide shot",
            "extreme wide shot"]
# Smaller first: fast, and leaves VRAM for H3. Any installed model can be picked in the UI.
PREFERRED = ("qwen3-vl:8b-instruct", "qwen3-vl", "gemma4", "qwen3", "gemma3", "llama3")

NEGATION = re.compile(r"\b(no|not|never|without|don't|doesn't|isn't|aren't|nothing|nobody|none|neither|nor)\b", re.I)
FILLER = re.compile(r"\b(masterpiece|best quality|8k|4k|ultra[- ]?hd|hdr|highly detailed|trending|award[- ]winning)\b", re.I)
TAG = re.compile(r"<Picture (\d+)>")
LIMITS = {"style": 35, "setting": 30, "action": 45, "camera": 16, "soundscape": 70, "music": 30}


class LLMError(RuntimeError):
    pass


# --------------------------------------------------------------------------- backends
#
# Messages are kept in Ollama's shape ({role, content, images: [b64]}) and converted
# for OpenAI-compatible servers (llama.cpp llama-server, LM Studio, vLLM, ...).

BACKENDS = {
    "ollama": {"label": "Ollama", "url": config.OLLAMA_URL},
    "openai": {"label": "OpenAI-compatible server (llama.cpp, LM Studio…)", "url": config.LLM_URL},
}


def _clean_url(url: str | None, backend: str) -> str:
    url = (url or BACKENDS[backend]["url"]).strip().rstrip("/")
    if not re.match(r"^https?://[^\s/]+", url):
        raise LLMError(f"Not an http(s) URL: {url!r}")
    return url


class Backend:
    name = ""
    label = ""

    def __init__(self, url: str) -> None:
        self.url = url

    async def models(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def vision(self, model: str) -> bool | None:
        """True/False when known, None when the server can't say (we try and fall back)."""
        return None

    async def chat(self, model: str, messages: list[dict[str, Any]], schema: dict[str, Any], *,
                   seed: int | None = None, temperature: float = 0.7) -> str:
        raise NotImplementedError

    async def pick(self, wanted: str | None, default: str = "") -> str:
        names = [m["name"] for m in await self.models()]
        if not names:
            raise LLMError(f"{self.label} at {self.url} lists no chat models")
        if wanted:
            if wanted in names:
                return wanted
            raise LLMError(f"Model {wanted!r} is not available on {self.label}")
        if default in names:
            return default
        for pref in PREFERRED:
            hit = next((n for n in names if n.startswith(pref)), None)
            if hit:
                return hit
        return names[0]

    async def _post(self, path: str, body: dict[str, Any], timeout: float = 300) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(f"{self.url}{path}", json=body)
        except httpx.HTTPError as exc:
            raise LLMError(f"{self.label} is not reachable at {self.url} ({type(exc).__name__})") from exc
        if r.status_code != 200:
            raise LLMError(f"{self.label} error {r.status_code}: {r.text[:400]}")
        return r.json()


class Ollama(Backend):
    name, label = "ollama", "Ollama"
    _caps: dict[tuple[str, str], list[str]] = {}

    async def models(self) -> list[dict[str, Any]]:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f"{self.url}/api/tags")
                r.raise_for_status()
                out = []
                for m in r.json().get("models", []):
                    caps = await self._capabilities(m["name"], c)
                    if "completion" not in caps:
                        continue  # embedding models etc.
                    out.append({"name": m["name"], "vision": "vision" in caps,
                                "params": m.get("details", {}).get("parameter_size")})
                return out
        except httpx.HTTPError as exc:
            raise LLMError(f"Ollama is not reachable at {self.url}") from exc

    async def _capabilities(self, model: str, c: httpx.AsyncClient | None = None) -> list[str]:
        key = (self.url, model)
        if key not in self._caps:
            if c is None:
                async with httpx.AsyncClient(timeout=10) as c2:
                    r = await c2.post(f"{self.url}/api/show", json={"model": model})
            else:
                r = await c.post(f"{self.url}/api/show", json={"model": model})
            r.raise_for_status()
            self._caps[key] = r.json().get("capabilities", ["completion"])
        return self._caps[key]

    async def vision(self, model: str) -> bool | None:
        return "vision" in await self._capabilities(model)

    async def chat(self, model, messages, schema, *, seed=None, temperature=0.7) -> str:
        body: dict[str, Any] = {
            "model": model, "messages": messages, "stream": False, "format": schema,
            # num_predict + repeat_penalty stop small models looping inside a free-text field.
            "options": {"temperature": temperature, "num_ctx": 8192, "num_predict": 2048, "repeat_penalty": 1.1,
                        **({"seed": seed} if seed is not None else {})},
            # Unload right after by default so the GPU is free again for H3.
            "keep_alive": config.OLLAMA_KEEP_ALIVE,
        }
        if "thinking" in await self._capabilities(model):
            body["think"] = False
        return (await self._post("/api/chat", body))["message"]["content"]


class OpenAICompatible(Backend):
    name, label = "openai", "Local LLM server"

    async def models(self) -> list[dict[str, Any]]:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f"{self.url}/v1/models")
                r.raise_for_status()
        except httpx.HTTPError as exc:
            raise LLMError(f"No OpenAI-compatible server at {self.url} (expected {self.url}/v1/models)") from exc
        data = r.json()
        items = data.get("data") or data.get("models") or []
        return [{"name": m.get("id") or m.get("name"), "vision": None, "params": None} for m in items
                if (m.get("id") or m.get("name"))]

    @staticmethod
    def _convert(messages: list[dict[str, Any]], with_images: bool) -> list[dict[str, Any]]:
        out = []
        for m in messages:
            imgs = m.get("images") or []
            if imgs and with_images:
                parts: list[dict[str, Any]] = [{"type": "text", "text": m["content"]}]
                parts += [{"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b}"}} for b in imgs]
                out.append({"role": m["role"], "content": parts})
            else:
                out.append({"role": m["role"], "content": m["content"]})
        return out

    async def chat(self, model, messages, schema, *, seed=None, temperature=0.7) -> str:
        has_images = any(m.get("images") for m in messages)
        body: dict[str, Any] = {
            "model": model, "temperature": temperature, "max_tokens": 2048, "stream": False,
            "response_format": {"type": "json_schema", "json_schema": {"name": "h3_prompt", "schema": schema}},
            "frequency_penalty": 0.3,
            # llama.cpp: skip the thinking phase on Qwen3-style templates; other servers ignore it.
            "chat_template_kwargs": {"enable_thinking": False},
            **({"seed": seed} if seed is not None else {}),
        }
        try:
            data = await self._post("/v1/chat/completions", {**body, "messages": self._convert(messages, True)})
        except LLMError as exc:
            if not has_images or "error 4" not in str(exc):
                raise
            # Text-only model (e.g. llama-server without --mmproj): retry without pictures.
            log.info("server refused images, retrying text-only: %s", exc)
            self.text_only = True
            data = await self._post("/v1/chat/completions", {**body, "messages": self._convert(messages, False)})
        text = data["choices"][0]["message"].get("content") or ""
        return _extract_json(text)


def _extract_json(text: str) -> str:
    """Strip <think> blocks and code fences some servers leave around the JSON."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    if "</think>" in text:
        text = text.split("</think>", 1)[1].strip()
    m = re.search(r"\{.*\}", text, flags=re.S)
    return m.group(0) if m else text


def make_backend(backend: str | None, url: str | None) -> Backend:
    backend = backend or config.LLM_BACKEND
    if backend not in BACKENDS:
        raise LLMError(f"Unknown LLM backend {backend!r}")
    cls = Ollama if backend == "ollama" else OpenAICompatible
    return cls(_clean_url(url, backend))


# --------------------------------------------------------------------------- request

@dataclass
class WriteRequest:
    mode: str  # "t2v" | "i2v" | "ref" | "still" | "sound"
    idea: str
    seconds: float = 5.0
    shots: int | None = None
    aspect: str = "16:9"
    images: list[Path] = field(default_factory=list)  # keyframes (i2v) or references (ref)
    first_frame: bool = False
    last_frame: bool = False
    dialogue: bool = True
    backend: str | None = None  # "ollama" | "openai"; None = config default
    url: str | None = None  # server URL; None = backend default
    model: str | None = None
    seed: int | None = None


def auto_shots(seconds: float) -> int:
    return max(1, min(5, round(seconds / 3.5)))


def shot_times(frames: int, n: int) -> list[float]:
    """Start time of each shot, evenly spaced and snapped to whole frames."""
    total = frames / workflows.FPS
    return [round(k * total / n * workflows.FPS) / workflows.FPS for k in range(n)]


def dialogue_budget(seconds: float) -> int:
    return max(2, int(seconds * 2.5))


def fmt_time(t: float) -> str:
    return f"{int(t // 60):02d}:{t % 60:06.3f}"


def _image_b64(path: Path, edge: int = 896) -> str:
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((edge, edge))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


# --------------------------------------------------------------------------- schema + instructions

def _text(words: int) -> dict[str, Any]:
    return {"type": "string", "maxLength": words * 9}  # hard cap for the grammar; validator enforces words


def _schema(req: WriteRequest, n: int) -> dict[str, Any]:
    if req.mode == "sound":
        return {"type": "object", "required": ["soundscape", "music"], "properties": {
            "soundscape": _text(LIMITS["soundscape"]), "music": _text(LIMITS["music"])}}
    shot_props: dict[str, Any] = {
        "framing": {"type": "string", "enum": FRAMINGS},
        "setting": _text(LIMITS["setting"]),
        "action": _text(LIMITS["action"]),
        "camera": _text(LIMITS["camera"]),
    }
    if req.dialogue and req.mode != "still":
        shot_props["dialogue"] = _text(40)
    shot = {"type": "object", "required": list(shot_props), "properties": shot_props}
    props: dict[str, Any] = {"style": _text(LIMITS["style"]),
                             "shots": {"type": "array", "items": shot, "minItems": n, "maxItems": n}}
    req_fields = ["style", "shots"]
    if req.mode != "still":
        props["soundscape"] = _text(LIMITS["soundscape"])
        props["music"] = _text(LIMITS["music"])
        req_fields += ["soundscape", "music"]
    return {"type": "object", "required": req_fields, "properties": props}


SYSTEM = """You plan shots for MiniMax H3, a video model that renders picture and sound together from a written shot list.
You fill in JSON fields. Code turns them into the final prompt, so write plain field values only.

Field rules:
- style: one line with medium, look, palette, lens and mood, e.g. "Cinematic live-action, warm tungsten palette, 35mm lens, quiet tension". At most 35 words.
- framing: pick one from the list.
- setting: where the shot is and its light, as concrete visual facts. At most 30 words.
- action: what the subject does in this shot, starting with the subject, in present tense, with concrete gestures, colors and materials. At most 45 words.
- camera: exactly one move, starting with a verb, e.g. "holds a static shot", "pushes in slowly", "pans left at slow speed", "tracks alongside the subject". At most 16 words.
- dialogue: the spoken words only, in English, about 2.5 words per second of the shot; use "" when nobody speaks.
- soundscape: ambience and sound effects, in order and tied to the action. At most 70 words.
- music: the score style and mood, or "N/A" for none.

Writing rules:
- Describe only what is there. Never use negations ("no", "not", "without", "never"); H3 has no negative prompt.
- Skip filler such as "masterpiece", "8k", "highly detailed".
- Keep the same subject, look and wardrobe from shot to shot unless the idea changes them.
- Vary framing and camera between neighbouring shots.
- Keep everything physically plausible and readable in a few seconds.
- Follow the user's idea; it decides the story. Keep every specific detail the user gave."""


def _user_message(req: WriteRequest, n: int, frames: int) -> str:
    total = frames / workflows.FPS
    lines = [f"IDEA: {req.idea.strip()}", ""]
    if req.mode == "sound":
        lines += [f"Write the sound only, for a {total:.1f}-second clip. Put events in time order with rough "
                  "times such as \"at 2 seconds\"."]
        return "\n".join(lines)
    if req.mode == "still":
        lines += ["This is a single still image: one shot, the camera holds a static shot, and dialogue is \"\"."]
    else:
        times = shot_times(frames, n)
        spans = []
        for k in range(n):
            end = times[k + 1] if k + 1 < n else total
            budget = f", dialogue at most {dialogue_budget(end - times[k])} words" if req.dialogue else ""
            spans.append(f"Shot {k + 1}: {times[k]:.1f}s to {end:.1f}s{budget}")
        lines += [f"Clip length {total:.1f} seconds, aspect {req.aspect}, exactly {n} shot(s):", *spans]
    if req.mode == "i2v" and req.images:
        if req.first_frame:
            lines += ["", "The attached picture is the FIRST frame. Shot 1 starts exactly as this picture looks: "
                      "same subject, clothes, place, light and framing. Describe it as it appears, then the motion."]
        elif req.last_frame:
            lines += ["", "The attached picture is the LAST frame. The final shot must end exactly as this picture looks."]
        if req.first_frame and req.last_frame:
            lines += ["The second attached picture is the LAST frame; the final shot must end exactly as it looks."]
    if req.mode == "ref":
        tags = ", ".join(f"<Picture {i}>" for i in range(1, len(req.images) + 1))
        lines += ["", f"The attached pictures are references, tagged in order as {tags}. In the action and setting "
                  "fields, refer to people, objects and places from them by tag, e.g. \"the woman from <Picture 1>\", "
                  "instead of describing their looks. Use every tag at least once. Use only these tags."]
    if not req.dialogue:
        lines += ["Nobody speaks: dialogue is \"\" in every shot."]
    return "\n".join(lines)


# --------------------------------------------------------------------------- validation + assembly

def _words(s: str) -> int:
    return len(s.split())


def validate(data: dict[str, Any], req: WriteRequest, n: int, frames: int) -> list[str]:
    problems: list[str] = []

    def check(name: str, text: str, limit_key: str | None = None) -> None:
        if not text or not text.strip():
            problems.append(f"{name} is empty.")
            return
        if NEGATION.search(text):
            problems.append(f"{name} uses a negation ({NEGATION.search(text).group(0)!r}); say what is there instead.")
        if FILLER.search(text):
            problems.append(f"{name} uses filler ({FILLER.search(text).group(0)!r}); remove it.")
        if limit_key and _words(text) > LIMITS[limit_key]:
            problems.append(f"{name} has {_words(text)} words; keep it under {LIMITS[limit_key]}.")

    if req.mode == "sound":
        check("soundscape", data.get("soundscape", ""), "soundscape")
        return problems

    check("style", data.get("style", ""), "style")
    shots = data.get("shots") or []
    if len(shots) != n:
        problems.append(f"There are {len(shots)} shots; write exactly {n}.")
    for i, s in enumerate(shots, 1):
        check(f"Shot {i} setting", s.get("setting", ""), "setting")
        check(f"Shot {i} action", s.get("action", ""), "action")
        check(f"Shot {i} camera", s.get("camera", ""), "camera")
    if shots and req.mode != "still":
        times = shot_times(frames, len(shots)) + [frames / workflows.FPS]
        for i, s in enumerate(shots):
            line = (s.get("dialogue") or "").strip()
            budget = dialogue_budget(times[i + 1] - times[i])
            if _words(line) > budget:
                problems.append(f"Shot {i + 1} dialogue has {_words(line)} words; at most {budget} fit.")
            if line and any(line == (o.get("dialogue") or "").strip() for o in shots[:i]):
                problems.append(f"Shot {i + 1} repeats an earlier spoken line; write a new one or use \"\".")
            words = line.lower().split()
            if len(words) >= 8 and len(set(words)) < len(words) / 2:
                problems.append(f"Shot {i + 1} dialogue repeats itself; write one short natural line.")
    if req.mode != "still":
        check("soundscape", data.get("soundscape", ""), "soundscape")
    if req.mode == "ref":
        used = {int(x) for s in shots for f in ("setting", "action") for x in TAG.findall(s.get(f, ""))}
        count = len(req.images)
        bad = sorted(t for t in used if not 1 <= t <= count)
        if bad:
            problems.append(f"Invalid tags {', '.join(f'<Picture {t}>' for t in bad)}; only <Picture 1> to <Picture {count}> exist.")
        unused = [t for t in range(1, count + 1) if t not in used]
        if unused:
            problems.append(f"Use {', '.join(f'<Picture {t}>' for t in unused)} in an action or setting.")
    return problems


QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})


def _straighten(v: Any) -> Any:
    if isinstance(v, str):
        return v.translate(QUOTES)
    if isinstance(v, list):
        return [_straighten(x) for x in v]
    if isinstance(v, dict):
        return {k: _straighten(x) for k, x in v.items()}
    return v


def _sentence(s: str) -> str:
    s = s.strip().strip('"').strip()
    if not s:
        return s
    s = s[0].upper() + s[1:]
    return s if s[-1] in ".!?" else s + "."


def clean_dialogue(line: str, budget: int) -> str:
    """Last line of defence against looping small models: Latin text only, no
    repeated phrases, and no more words than fit in the shot."""
    line = re.sub(r"[^\x00-\u024F\u2018-\u201F\u2026]+.*", "", line.strip().strip('"')).strip()
    out: list[str] = []
    for w in line.split():
        out.append(w)
        rep = next((k for k in range(2, 7) if len(out) >= 2 * k and out[-k:] == out[-2 * k:-k]), 0)
        if rep:
            out = out[:-rep]
            break
    text = " ".join(out[:budget])
    return text.rstrip(",;:-—… ")


def _camera(s: str) -> str:
    s = re.sub(r"^(the\s+)?camera\s+", "", s.strip(), flags=re.I).rstrip(".")
    return f"The camera {s}."


def assemble(data: dict[str, Any], req: WriteRequest, n: int, frames: int) -> str:
    if req.mode == "sound":
        return (f"overall_soundscape: {_sentence(data['soundscape'])}\n"
                f"non_diegetic_music: {data.get('music', '').strip() or 'N/A'}")
    style = _sentence(data["style"])
    shots = data["shots"][:n]
    if req.mode == "still":
        s = shots[0]
        return f"{style}\n\n{s['framing'].capitalize()}. {_sentence(s['setting'])} {_sentence(s['action'])} The camera holds a static shot."
    times = shot_times(frames, len(shots)) + [frames / workflows.FPS]
    out = [style, ""]
    for k, s in enumerate(shots):
        when = "" if k == 0 else f"At {fmt_time(times[k])}, "
        body = f"{when}{s['framing']}. {_sentence(s['setting'])} {_sentence(s['action'])}"
        line = clean_dialogue(s.get("dialogue") or "", dialogue_budget(times[k + 1] - times[k]))
        if line:
            body += f" They say: <d>[English] {line}</d>"
        out.append(f"[Shot {k + 1}] {body[0].upper() + body[1:]} {_camera(s['camera'])}")
    music = data.get("music", "").strip() or "N/A"
    out += ["", f"overall_soundscape: {_sentence(data['soundscape'])}", f"non_diegetic_music: {music}"]
    return "\n".join(out)


# --------------------------------------------------------------------------- entry point

async def write_prompt(req: WriteRequest, attempts: int = 3) -> dict[str, Any]:
    if not req.idea.strip():
        raise LLMError("Write a short idea in the prompt box first")
    llm = make_backend(req.backend, req.url)
    model = await llm.pick(req.model, config.OLLAMA_MODEL if llm.name == "ollama" else config.LLM_MODEL)
    n = 1 if req.mode in ("still", "sound") else (req.shots or auto_shots(req.seconds))
    frames = workflows.h3_length(req.seconds)

    user: dict[str, Any] = {"role": "user", "content": _user_message(req, n, frames)}
    can_see = await llm.vision(model)
    if req.images and can_see is not False:
        user["images"] = [_image_b64(p) for p in req.images]
    messages = [{"role": "system", "content": SYSTEM}, user]
    schema = _schema(req, n)

    t0 = time.monotonic()
    best: tuple[dict[str, Any], list[str]] | None = None
    for attempt in range(1, attempts + 1):
        raw = await llm.chat(model, messages, schema, seed=None if req.seed is None else req.seed + attempt)
        try:
            data = json.loads(raw)
        except ValueError:
            problems = ["The reply was cut off or was not valid JSON; keep every field short."]
            data = None
        else:
            problems = validate(data, req, n, frames)
        if data is not None and (best is None or len(problems) < len(best[1])):
            best = (data, problems)
        if not problems:
            break
        log.info("prompt attempt %d problems: %s", attempt, problems)
        messages += [{"role": "assistant", "content": raw},
                     {"role": "user", "content": "Your answer has these problems:\n- " + "\n- ".join(problems)
                      + "\nWrite the whole answer again in the same format, fixing them."}]
    if best is None:
        raise LLMError("The model did not return usable JSON")
    data, problems = best
    data = _straighten(data)
    if req.mode != "sound" and data.get("shots") and len(data["shots"]) < n:
        n = len(data["shots"])
    return {
        "prompt": assemble(data, req, n, frames),
        "fields": data,
        "backend": llm.name,
        "model": model,
        "vision": bool(req.images and can_see is not False and not getattr(llm, "text_only", False)),
        "attempts": attempt,
        "warnings": problems,
        "seconds": round(time.monotonic() - t0, 1),
    }
