"""The Prompt step's helpers: a catalog of saved prompts, tag presets, and the live
model-specific rewrite.

Catalog (data/prompt_library.json): entries {id, title, model, prompt, tags, updated}.
``model`` is the kind:engine the prompt was written for ("image:krea2", "video:h3"...), ``tags`` a
JSON object of named values; a prompt refers to them as <name> or {{name}}, and a tag
with several values gives one at random. The ComfyUI Prompt Explorer node's library can
be imported once (it keeps its own file; nothing is shared afterwards).

Tag presets (data/tag_presets.json, seeded from app/tag_presets.json): {category: [tag...]}
for the tag picker; <category_slug/> in a prompt picks one at random.

Live rewrite: the browser sends the prompt after a short pause in typing; a local LLM
rewrites it in the selected model's own style and the text streams back. The LLM stays
loaded ("warm") for a few minutes while someone is typing and is unloaded as soon as a
render starts, so it never holds VRAM during one.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

import httpx

from . import config, llm

log = logging.getLogger("bob.prompts")

LIBRARY = config.DATA_DIR / "prompt_library.json"
PRESETS = config.DATA_DIR / "tag_presets.json"
DEFAULT_PRESETS = Path(__file__).with_name("tag_presets.json")
_lock = threading.Lock()

# The Prompt Explorer node's model names, as Bob engine keys (import only).
NODE_MODELS = {"flux2": "image:klein", "flux": "image:klein", "krea2": "image:krea2", "krea": "image:krea2",
               "minimax h3": "video:h3", "h3": "video:h3", "music 3": "audio:music3", "moss": "image:moss", "moss edit": "image:mossedit"}


# --------------------------------------------------------------------------- catalog

def _read() -> list[dict[str, Any]]:
    try:
        data = json.loads(LIBRARY.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        log.warning("prompt_library.json unreadable: %s", exc)
        return []
    entries = data.get("entries") if isinstance(data, dict) else None
    return [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []


def _write(entries: list[dict[str, Any]]) -> None:
    tmp = LIBRARY.with_suffix(".tmp")
    tmp.write_text(json.dumps({"version": 1, "entries": entries}, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(LIBRARY)


def _clean_tags(tags: Any) -> dict[str, Any]:
    if isinstance(tags, str):
        try:
            tags = json.loads(tags)
        except ValueError:
            return {}
    if not isinstance(tags, dict):
        return {}
    out: dict[str, Any] = {}
    for k, v in tags.items():
        k = str(k).strip()[:80]
        if not k:
            continue
        if isinstance(v, list):
            out[k] = [str(x) if not isinstance(x, (dict, list)) else json.dumps(x, ensure_ascii=False) for x in v][:200]
        elif isinstance(v, dict):
            out[k] = v  # nested groups (from the node) stay as they are: <group.key>
        else:
            out[k] = str(v)
    return out


def _sanitize(item: dict[str, Any]) -> dict[str, Any]:
    title = str(item.get("title", "")).strip()[:200]
    if not title:
        raise ValueError("Give the prompt a title")
    return {
        "id": str(item.get("id") or uuid.uuid4().hex)[:40],
        "title": title,
        "model": str(item.get("model", "") or "").strip()[:40],
        "prompt": str(item.get("prompt", "") or "")[:40000],
        "tags": _clean_tags(item.get("tags", {})),
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }


def _sorted(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(entries, key=lambda e: str(e.get("title", "")).lower())


def list_entries() -> list[dict[str, Any]]:
    with _lock:
        return _sorted(_read())


def save_entry(item: dict[str, Any]) -> dict[str, Any]:
    entry = _sanitize(item)
    with _lock:
        entries = _read()
        i = next((k for k, e in enumerate(entries) if e.get("id") == entry["id"]), -1)
        if i >= 0:
            entries[i] = entry
        else:
            entries.append(entry)
        _write(entries)
    return entry


def delete_entry(entry_id: str) -> bool:
    with _lock:
        entries = _read()
        keep = [e for e in entries if e.get("id") != entry_id]
        if len(keep) == len(entries):
            return False
        _write(keep)
    return True


def node_library() -> Path | None:
    """The Prompt Explorer node's library.json, if it can be found."""
    roots = []
    if config.COMFYUI_DIR:
        base = Path(config.COMFYUI_DIR)
        roots += [base / "ComfyUI" / "custom_nodes", base / "custom_nodes"]
    for r in roots:
        p = r / "comfyui-prompt-explorer" / "library.json"
        if p.is_file():
            return p
    return None


def import_node_library() -> dict[str, int]:
    """Copy the node's entries in (once: entries already imported, by id, are skipped)."""
    src = node_library()
    if not src:
        raise ValueError("The Prompt Explorer node's library wasn't found (looked under BOB_COMFYUI_DIR's custom_nodes)")
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Couldn't read the node's library: {exc}") from exc
    incoming = data.get("entries", []) if isinstance(data, dict) else []
    added = skipped = 0
    with _lock:
        entries = _read()
        have = {e.get("id") for e in entries}
        for it in incoming:
            if not isinstance(it, dict) or not str(it.get("title", "")).strip():
                continue
            if it.get("id") in have:
                skipped += 1
                continue
            m = str(it.get("model", "")).strip()
            try:
                entry = _sanitize({**it, "model": NODE_MODELS.get(m.lower(), m)})
            except ValueError:
                continue
            entries.append(entry)
            have.add(entry["id"])
            added += 1
        if added:
            _write(entries)
    return {"added": added, "skipped": skipped}


def presets() -> dict[str, list[str]]:
    if not PRESETS.exists() and DEFAULT_PRESETS.exists():
        shutil.copyfile(DEFAULT_PRESETS, PRESETS)
    try:
        data = json.loads(PRESETS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): [str(x) for x in v] for k, v in data.items() if isinstance(v, list)} if isinstance(data, dict) else {}


# --------------------------------------------------------------------------- live rewrite

COMMON = """You rewrite prompts for {name}. Keep every subject, detail, name, color, number and quoted line the user gave, and add nothing that changes the idea; fill in only what the format needs.
Keep every spoken line (inside <d>…</d>) word for word, in <d>…</d>.
Reply with the rewritten prompt only: no title, no notes, no quotes around it, no markdown."""
# Reference tags the user wrote are named in the instructions (only those: naming others makes models invent them).
REF_TAG = re.compile(r"<(?:Picture|Audio|Subject|Image|Video) \d+>|<d>")

NO_NEG = "Describe only what is there: never use negations (no, not, without, never). Skip filler such as masterpiece, best quality, 8k, highly detailed."

PROFILES: dict[str, tuple[str, str]] = {
    "flux": ("FLUX 3 Klein, an image model that reads natural language",
             "Write one flowing paragraph of 40 to 90 words: the main subject and what it is doing first, then its details (clothing only for people), "
             "then the setting, then light, lens and style. Plain sentences: no comma-separated tag lists and no weights such as (word:1.2). " + NO_NEG),
    "krea": ("Krea 2, a photoreal image model that reads natural language",
             "Write one paragraph of 30 to 80 words in plain, concrete photographic language: subject and action, wardrobe and materials, "
             "place, light and time of day, camera and lens. No tag lists and no weights such as (word:1.2). " + NO_NEG),
    "moss": ("MOSS-Image, an image model trained on long, detailed English captions and good at rendering text",
             "Write two or three paragraphs of 120 to 250 words in plain natural language. Start with the medium and the subject "
             "(e.g. \"Studio photograph of …\", \"Anime-style illustration of …\"), then the subject's details, pose, the space "
             "from foreground to background, framing and camera, light, palette and texture. Any text to show goes in double "
             "quotes, word for word, with where it sits, its typeface and color. No tag lists and no weights such as (word:1.2). " + NO_NEG),
    "mossedit": ("MOSS-Image Edit, which changes a photo by a short instruction and keeps everything else",
                 "Write one or two sentences, as the edit model was trained: \"Change only the <thing> to <new thing>. Keep the "
                 "<people, faces, hair, poses, background and composition> unchanged.\" Name exactly what changes and what stays; "
                 "with several pictures, say what each one is for (e.g. the coat from the second picture). No scene description "
                 "beyond the change. " + NO_NEG),
    "h3still": ("MiniMax H3 rendering one still frame",
                "Line 1: the style (medium, look, palette, lens, mood) in one line.\nThen a blank line.\nThen one paragraph: the framing, "
                "the setting and its light, then the subject and pose. " + NO_NEG),
    "h3image": ("MiniMax H3 Image, a still-image model that can use reference pictures",
                "Line 1: the style in one line.\nThen a blank line.\nThen one paragraph: framing, setting and light, subject and pose. "
                "Refer to things from the reference pictures by their tags (e.g. the woman from <Picture 1>). " + NO_NEG),
    "h3video": ("MiniMax H3, a video model that renders picture and sound from a shot list",
                "Format:\nLine 1: the style (medium, look, palette, lens, mood).\nA blank line.\nOne line per shot, each starting with its tag [Shot 1], [Shot 2]…: "
                "\"[Shot 1] <camera angle> <framing>. <setting and light>. <action in present tense>. The camera is <where it stands relative to the subject> and <one move>.\" "
                "e.g. \"[Shot 1] Low-angle wide shot. … The camera is behind her at shoulder height and tracks her up the stairs.\" "
                "Later shots begin with the start time, e.g. \"[Shot 2] At 00:04.000, close-up. …\". Spoken words go after "
                "\"They say:\" as <d>[English] the words</d>.\nA blank line.\noverall_soundscape: <ambience and effects in order>\n"
                "non_diegetic_music: <score style, or N/A>\nUse one shot unless the user describes several; the clip is {seconds} seconds. " + NO_NEG),
    "h3ref": ("MiniMax H3 Reference, a video model that uses reference pictures tagged <Picture 1>, <Picture 2>…",
              "Use the same format as an H3 shot list:\nLine 1: the style.\nA blank line.\n\"[Shot 1] <framing>. <setting and light>. "
              "<action>. The camera is <where it stands relative to the subject> and <one move>.\" with the camera angle before the framing, "
              "e.g. \"Low-angle wide shot\" (later shots begin with their start time, e.g. At 00:04.000,).\nA blank line.\n"
              "overall_soundscape: …\nnon_diegetic_music: …\nRefer to people, objects and places from the references by tag instead of "
              "describing their looks. The clip is {seconds} seconds. " + NO_NEG),
    "h3sound": ("MiniMax H3 making sound only",
                "Exactly two lines:\noverall_soundscape: <ambience and sound effects in time order, with rough times such as at 2 seconds>\n"
                "non_diegetic_music: <score style and mood, or N/A>\nThe clip is {seconds} seconds."),
    "music": ("Music 3, a song model; this is its style caption",
              "One line of comma-separated descriptors, 10 to 30 words: genre and sub-genre, mood, tempo or BPM, key instruments, "
              "vocal type and delivery, production style."),
}


def system_prompt(profile: str, seconds: float, text: str = "", keep: list[str] | None = None,
                  refs: int | None = None, arefs: int = 0) -> str:
    name, rules = PROFILES[profile]
    out = COMMON.format(name=name)
    tags = list(dict.fromkeys(m.group(0) for m in REF_TAG.finditer(text)))
    if tags:
        shown = ", ".join("<d>…</d>" if t == "<d>" else t for t in tags)
        out += f"\nCopy these tags exactly, each where it belongs: {shown}."
    if refs is not None and profile in ("h3ref", "h3image"):
        if refs:
            tags = ", ".join(f"<Picture {i}>" for i in range(1, refs + 1))
            out += f"\nThere are {refs} reference picture(s), tagged {tags}. Use only these tags."
        else:
            out += "\nNo reference pictures are added yet: write no <Picture N> tags."
    if arefs and profile == "h3ref":
        pairs = ", ".join(f"<Audio {i}> is the voice of the person in <Picture {i}>" for i in range(1, arefs + 1))
        out += (f"\nVoices: {pairs}. When that person speaks, write it as e.g. \"The woman from <Picture 1> says, in the "
                f"voice of <Audio 1>: <d>[English] …</d>\"; never give a person another number's voice.")
    if keep:
        out += "\nUse each of these words exactly as written, unchanged and once: " + "; ".join(f'"{k[:80]}"' for k in keep[:30]) + "."
    return out + "\n\n" + rules.replace("{seconds}", f"{seconds:g}")


_warm: set[tuple[str, str]] = set()  # (url, model) of Ollama models held loaded for typing
KEEP = "4m"


def _backend(backend: str | None, url: str | None) -> llm.Backend:
    return llm.make_backend(backend, url)


# Auto model: for short image and music prompts, the first of these that is installed (a small model
# is as good there and leaves more VRAM); H3 shot lists keep the Prompt writer's default model, as
# small models break that format.
LIVE_PREFERRED = ("qwen3:4b-instruct", "qwen3:4b", "llama3.2:3b", "gemma3:4b", "qwen3:1.7b")
STRICT_FORMAT = {"h3video", "h3ref", "h3sound", "h3still", "h3image"}

# Asking the server which models it has takes 0.2-0.3 s (the model itself answers in ~0.03 s once
# loaded), so the choice is remembered for a while.
_picked: dict[tuple[str, str, str, bool], tuple[float, str]] = {}
PICK_TTL = 120


async def _model(b: llm.Backend, model: str | None, profile: str | None = None) -> str:
    small = profile not in STRICT_FORMAT
    key = (b.name, b.url, model or "", small and not model)
    hit = _picked.get(key)
    if hit and time.time() - hit[0] < PICK_TTL:
        return hit[1]
    name = ""
    if not model and small:
        try:
            names = [m["name"] for m in await b.models()]
        except llm.LLMError:
            names = []
        name = next((n for pref in LIVE_PREFERRED for n in names if n == pref or n.startswith(pref + "-")), "")
    if not name:
        default = config.OLLAMA_MODEL if b.name == "ollama" else config.LLM_MODEL
        name = await b.pick(model or None, default)
    _picked[key] = (time.time(), name)
    return name


async def warm(backend: str | None, url: str | None, model: str | None, profile: str | None = None) -> dict[str, Any]:
    """Load the model now (Ollama), so the first rewrite answers quickly."""
    b = _backend(backend, url)
    name = await _model(b, model, profile)
    if b.name == "ollama":
        try:
            async with httpx.AsyncClient(timeout=120) as c:
                # The same options as rewrite(), or Ollama loads the model a second time for a different context size.
                await c.post(f"{b.url}/api/generate", json={"model": name, "keep_alive": KEEP, "options": {"num_ctx": 4096}})
        except httpx.HTTPError as exc:
            raise llm.LLMError(f"Ollama is not reachable at {b.url}") from exc
        _warm.add((b.url, name))
    return {"model": name, "backend": b.name}


async def release() -> None:
    """Unload the warm models (a render is starting). Quiet: never fails the caller."""
    held = list(_warm)
    _warm.clear()
    for url, model in held:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(f"{url}/api/generate", json={"model": model, "keep_alive": 0})
            log.info("unloaded %s for a render", model)
        except httpx.HTTPError:
            pass


def _tidy(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    text = re.sub(r"^```\w*\n?|\n?```$", "", text.strip())
    text = re.sub(r"^(here(?:'s| is) (?:the |your )?(?:rewritten |revised )?prompt[^:\n]*:)\s*", "", text, flags=re.I)
    return text.strip().strip('"').strip()


def creativity_note(pct: int | None) -> str:
    """The Prompt tab's Creativity (0-100) as an instruction; None = the plain rewrite (keep, add nothing)."""
    if pct is None:
        return ""
    pct = max(0, min(100, int(pct)))
    return (f"\n\nCREATIVITY {pct}%: {llm.creativity_rule(pct)} Where this asks for more than the rules above allow, "
            "it wins, but keep the user's named subjects, quoted spoken lines and reference tags.")


def rewrite_temperature(pct: int | None) -> float:
    """0.3 for the plain rewrite; with Creativity, 0% -> 0.2 up to 100% -> 1.1."""
    return 0.3 if pct is None else round(0.2 + 0.9 * max(0, min(100, int(pct))) / 100, 2)


async def rewrite(text: str, profile: str, seconds: float, backend: str | None, url: str | None,
                  model: str | None, keep: list[str] | None = None, problems: list[str] | None = None,
                  refs: int | None = None, arefs: int = 0, creativity: int | None = None) -> AsyncIterator[str]:
    """Stream the rewritten prompt in pieces."""
    if profile not in PROFILES:
        raise llm.LLMError(f"No live rewrite for {profile!r}")
    b = _backend(backend, url)
    name = await _model(b, model, profile)
    ask = f"Prompt to rewrite:\n{text.strip()}"
    if problems:
        ask += ("\n\nThe prompt has these problems. Fixing them comes first, even where it means changing the user's "
                "wording; keep everything else:\n" + "\n".join(f"- {p[:400]}" for p in problems[:20]))
    messages = [{"role": "system", "content": system_prompt(profile, seconds, text, keep, refs, arefs) + creativity_note(creativity)},
                {"role": "user", "content": ask}]
    if b.name == "ollama":
        body: dict[str, Any] = {"model": name, "messages": messages, "stream": True, "keep_alive": KEEP,
                                "options": {"temperature": rewrite_temperature(creativity), "num_ctx": 4096, "num_predict": 700,
                                            "repeat_penalty": 1.1}}
        try:
            if "thinking" in await b._capabilities(name):  # type: ignore[attr-defined]
                body["think"] = False
        except httpx.HTTPError:
            pass
        _warm.add((b.url, name))
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5)) as c:
            async with c.stream("POST", f"{b.url}/api/chat", json=body) as r:
                if r.status_code != 200:
                    raise llm.LLMError(f"Ollama error {r.status_code}: {(await r.aread())[:300]!r}")
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    piece = json.loads(line).get("message", {}).get("content", "")
                    if piece:
                        yield piece
        return
    body = {"model": name, "messages": messages, "stream": True, "temperature": rewrite_temperature(creativity), "max_tokens": 700,
            "chat_template_kwargs": {"enable_thinking": False}}
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5), headers=b._headers()) as c:
        async with c.stream("POST", f"{b.url}/v1/chat/completions", json=body) as r:
            if r.status_code != 200:
                raise llm.LLMError(f"LLM server error {r.status_code}: {(await r.aread())[:300]!r}")
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    piece = json.loads(data)["choices"][0].get("delta", {}).get("content") or ""
                except (ValueError, KeyError, IndexError):
                    continue
                if piece:
                    yield piece


async def rewrite_stream(text: str, profile: str, seconds: float, backend: str | None, url: str | None,
                         model: str | None, keep: list[str] | None = None, problems: list[str] | None = None,
                         refs: int | None = None, arefs: int = 0, creativity: int | None = None) -> AsyncIterator[bytes]:
    """rewrite() as NDJSON lines for the browser: {"t": piece} ... {"done": true, "text": tidy} or {"error"}."""
    out: list[str] = []
    try:
        model = await _model(_backend(backend, url), model, profile)
        yield (json.dumps({"model": model}) + "\n").encode()
        async for piece in rewrite(text, profile, seconds, backend, url, model, keep, problems, refs, arefs, creativity):
            out.append(piece)
            yield (json.dumps({"t": piece}) + "\n").encode()
        yield (json.dumps({"done": True, "text": _tidy("".join(out))}) + "\n").encode()
    except (llm.LLMError, httpx.HTTPError) as exc:
        yield (json.dumps({"error": str(exc) or type(exc).__name__}) + "\n").encode()
    except asyncio.CancelledError:  # the browser moved on (the user kept typing)
        raise
