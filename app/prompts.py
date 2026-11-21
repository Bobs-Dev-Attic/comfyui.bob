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

# A spoken line on H3: said once, with no words of H3's own around it (as the Prompt and Shots steps and V2 word it)
ONCE = "Only the words inside the dialogue tag are spoken, once; before and after them the speaker stays silent with their lips closed."
ONCE_MANY = ("Only the words inside the dialogue tags are spoken, each line once; before, between and after them the speakers "
             "stay silent with their lips closed.")
SAY_ONCE = (f'Only when the prompt has spoken words: they go after "They say once:" (or "<who> says once:") as <d>[English] the '
            f'words</d>, and the shot\'s line goes on with: "{ONCE}" Add no spoken words of your own.')

# H3's shot list (H3 and H3 Reference)
H3_SHOTS = ("Format:\nLine 1: the style (medium, look, palette, lens, mood).\nA blank line.\nOne line per shot, each starting with its tag [Shot 1], [Shot 2]…: "
            "\"[Shot 1] <camera angle> <framing>. <setting and light>. <action in present tense>. The camera is <where it stands relative to the subject> and <one move>.\" "
            "e.g. \"[Shot 1] Low-angle wide shot. … The camera is behind her at shoulder height and tracks her up the stairs.\" "
            "Later shots begin with the start time, e.g. \"[Shot 2] At 00:04.000, close-up. …\". " + SAY_ONCE + "\nA blank line.\noverall_soundscape: <ambience and effects in order>\n"
            "non_diegetic_music: <score style, or N/A>\nUse one shot unless the user describes several; the clip is {seconds} seconds.")

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
    "h3video": ("MiniMax H3, a video model that renders picture and sound from a shot list", H3_SHOTS + " " + NO_NEG),
    # the same shot list, word for word: with a shorter version of it, small models skipped the style line and [Shot 1]
    "h3ref": ("MiniMax H3 Reference, a video model that uses reference pictures tagged <Picture 1>, <Picture 2>…",
              # the tags first: below the long shot-list format, small models dropped them (5 runs in 12, against 1)
              "Most important: keep every reference tag. Each person, object and place from a reference picture is named by its "
              "tag every time it comes up, as the prompt names it (e.g. \"the woman from <Picture 1>\", \"<Picture 2>\"); the "
              "picture carries their looks, so describe only what they do.\n" + H3_SHOTS + " " + NO_NEG),
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
        out += (f"\nVoices: {pairs}. When that person speaks, write it as e.g. \"The woman from <Picture 1> says once, in the "
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


_D = re.compile(r"<d>(.*?)</d>", re.S)
_SOUND = re.compile(r"^(?:overall_soundscape|non_diegetic_music):", re.M)
_QUOTED = re.compile(r"[\"“]([^\"“”\n]{1,400})[\"”]")


def _said(t: str) -> str:
    """A spoken line, compared loosely: no [Language] tag, quotes, punctuation or case."""
    t = re.sub(r"^\s*\[[^\]]{1,20}\]", "", t)
    return " ".join(re.sub(r"[^\w\s]", " ", t.lower()).split())


def restore_lines(original: str, text: str) -> str:
    """The spoken lines the user wrote (<d>…</d> in `original`), back in the rewrite as they wrote them. A small model
    may drop the [English] tag, turn the tags into quotes, move a line below the sound fields, or leave it out: each
    line goes back in its shot as <d>[as written]</d> (a line left out goes at the end of its shot)."""
    lines = []  # (as written, loosely, its [Shot N] or 0, "<Audio N>" whose voice or "")
    for m in _D.finditer(original):
        before = original[:m.start()]
        shot = re.findall(r"\[Shot (\d+)\]", before)
        voice = re.search(r"voice of (<Audio \d+>)[^<.]{0,20}:\s*$", before)
        lines.append((m.group(1).strip(), _said(m.group(1)), int(shot[-1]) if shot else 0, voice.group(1) if voice else ""))
    if not lines:
        return text
    # the sound fields: what's below them that has a spoken line goes back up, at the end of the shots
    cut = _SOUND.search(text)
    body, sound = (text[:cut.start()], text[cut.start():]) if cut else (text, "")
    moved = []
    if sound:
        keep = []
        for ln in sound.split("\n"):
            (moved if "<d>" in ln and not _SOUND.match(ln) else keep).append(ln)
        sound = "\n".join(keep).strip()
    body = body.rstrip()
    if moved:
        body = _into_shot(body, " ".join(s.strip() for s in moved), 0)
    found = set()

    def back(m: re.Match) -> str:  # a line the model wrote, in <d> or in quotes: as the user wrote it
        k = next((i for i, l in enumerate(lines) if l[1] == _said(m.group(1)) and i not in found), None)
        if k is None:
            return m.group(0)
        found.add(k)
        return f"<d>{lines[k][0]}</d>"
    body = _QUOTED.sub(back, _D.sub(back, body))
    for i, (said, _, shot, voice) in enumerate(lines):
        if i not in found:
            body = _into_shot(body, f"They say once{f', in the voice of {voice}' if voice else ''}: <d>{said}</d>", shot)
    return f"{body}\n\n{sound}" if sound else body


def _into_shot(body: str, words: str, shot: int) -> str:
    """`words` added to a shot's line: [Shot N] (else the last shot), before its camera sentence when it has one."""
    rows = body.split("\n")
    at = next((i for i, r in enumerate(rows) if shot and r.startswith(f"[Shot {shot}]")), None)
    if at is None:
        at = max((i for i, r in enumerate(rows) if r.strip()), default=0)
    row = rows[at] if rows else ""
    cam = row.rfind(" The camera ")
    rows[at] = f"{row[:cam]} {words}{row[cam:]}" if cam > 0 else f"{row.rstrip()} {words}".strip()
    return "\n".join(rows)


def _parts(text: str) -> tuple[str, str]:
    """An H3 shot list split at its sound fields: (style and shots, sound)."""
    cut = _SOUND.search(text)
    return (text[:cut.start()].strip(), text[cut.start():].strip()) if cut else (text.strip(), "")


def shot_list(text: str) -> str:
    """An H3 rewrite in H3's shape: the style line, a blank line, the shots (the first tagged [Shot 1] when the model
    tagged none), a blank line, the sound fields."""
    body, sound = _parts(text)
    rows = [r.strip() for r in body.split("\n") if r.strip()]
    tagged = next((i for i, r in enumerate(rows) if r.startswith("[Shot ")), len(rows))
    if rows and not any(r.startswith("[Shot 1]") for r in rows) and tagged > 0:
        # no [Shot 1]: the shot is what comes before the first tag (or all of it). A short first line on its own is
        # the style; the shot starts after it.
        short = len(rows[0]) <= 200 and "<d>" not in rows[0] and not re.search(r"[.!?]\s+\S", rows[0])
        if tagged > 1 or (short and len(rows) > 1):
            k = 1 if short else 0
            rows[k] = f"[Shot 1] {rows[k]}"
        elif tagged < len(rows):
            # one paragraph run together before [Shot 2]: its first sentence is the style, the rest is shot 1
            style, _, rest = rows[0].partition(". ")
            rows[0:1] = [f"{style}.", f"[Shot 1] {rest}"] if rest else [f"[Shot 1] {rows[0]}"]
        else:
            rows[0] = f"[Shot 1] {rows[0]}"
    first = next((i for i, r in enumerate(rows) if r.startswith("[Shot ")), 0)
    # a row below a shot that isn't a shot of its own (a line of dialogue put under it) belongs to that shot
    shots: list[str] = []
    for r in rows[first:]:
        if shots and not r.startswith("[Shot "):
            shots[-1] += " " + r
        else:
            shots.append(r)
    style, shots = " ".join(rows[:first]), "\n".join(shots)
    return "\n\n".join(p for p in (style, shots, sound) if p)


def has_style(text: str) -> bool:
    body, _ = _parts(text)
    return bool(body) and not body.startswith("[Shot ")


def style_of(original: str) -> str:
    """The style line the user wrote (their first line, above their [Shot 1]), else ""."""
    body, _ = _parts(original)
    head = body.split("[Shot ", 1)[0].strip() if "[Shot " in body else ""
    return head if head and "\n" not in head and "<d>" not in head else ""


async def style_line(shots: str, backend: str | None, url: str | None, model: str | None) -> str:
    """Line 1 of an H3 shot list, written for these shots, when the rewrite left it out."""
    b = _backend(backend, url)
    name = await _model(b, model, "h3video")
    messages = [{"role": "system", "content": "You write line 1 of a MiniMax H3 shot list: its style (medium, look, palette, lens, mood), "
                 "in one line of 8 to 20 words that fits the shots. Reply with that line only."},
                {"role": "user", "content": _parts(shots)[0]}]
    line = _tidy("".join([p async for p in _chat(b, name, messages, 0.3, 60)])).split("\n")[0]
    line = re.sub(r"^(?:line 1|style)\s*:\s*", "", line, flags=re.I).strip().strip('"').strip()
    return "" if not line or line.startswith("[Shot ") or _SOUND.match(line) else line


def restore_tags(original: str, text: str) -> str:
    """A <Picture N> the rewrite dropped, back where it names what the user named with it: "the woman from <Picture 1>"
    in the user's text, and the rewrite's first "the woman" (or "a young woman") in the shots gets it back. A tag the
    user wrote on its own ("then <Picture 2> steps out") has nothing to find it by, and stays as the model left it."""
    body, sound = _parts(text)
    head, sep, shots = body.partition("[Shot ")  # not into the style line
    shots = sep + shots
    for n in dict.fromkeys(re.findall(r"<Picture (\d+)>", original)):
        tag = f"<Picture {n}>"
        if tag in text:
            continue
        m = re.search(rf"\b(?:the|an?)\s+(?:[\w-]+\s+){{0,2}}?([\w-]+)\s+from\s+{tag}", original, re.I)
        if not m:
            continue
        at = re.search(rf"\b(?:the|an?)\s+(?:[\w-]+\s+){{0,2}}?{re.escape(m.group(1))}\b(?!\s+from\s+<Picture)", shots, re.I)
        if at:
            shots = f"{shots[:at.end()]} from {tag}{shots[at.end():]}"
    body = head + shots if sep else head
    return "\n\n".join(p for p in (body.strip(), sound) if p)


def drop_invented(original: str, text: str) -> str:
    """A spoken line the user didn't write (small models make one up, e.g. a chef saying "Perfect."), taken out with
    the sentence that says it. A line the user wrote in plain quotes, not in <d>, counts as theirs."""
    said = _said(re.sub(r"<[^>]+>", " ", original))
    rows = []
    for row in text.split("\n"):
        for m in reversed(list(_D.finditer(row))):
            w = _said(m.group(1))
            if w and w in said:
                continue
            # the sentence starts after the last full stop (or spoken line) before it, else at the shot's start
            ends = [row.rfind(s, 0, m.start()) + len(s) for s in (". ", "! ", "? ", "</d> ") if row.rfind(s, 0, m.start()) >= 0]
            start = max(ends) if ends else (row.index("] ") + 2 if row.startswith("[Shot ") and "] " in row else 0)
            end = m.end() + re.match(r"[.!?\"”]*\s*", row[m.end():]).end()
            row = (row[:start] + row[end:]).rstrip()
        rows.append(row)
    return "\n".join(rows)


def finish(original: str, text: str) -> str:
    """An H3 rewrite checked: H3's shape, the user's picture tags and spoken lines as they wrote them (and no others),
    each line said once."""
    return say_once(drop_invented(original, restore_lines(original, restore_tags(original, shot_list(text)))))


_SAYS = re.compile(r"\b(says?|speaks?)\b(?!\s+once)(?=(?:,(?:[^:<\n]|<Audio \d+>){0,80})?:\s*<d>)", re.I)


def say_once(text: str) -> str:
    """H3's spoken lines, said once: "says"/"say" right before a <d>…</d> becomes "says once", and each shot's line
    with dialogue goes on with ONCE (ONCE_MANY for several lines) after its last line, once."""
    text = _SAYS.sub(lambda m: f"{m.group(1)} once", text)
    out = []
    for line in text.split("\n"):
        n = line.count("</d>")
        # wherever the model put it (in a shot with no lines too, as small models do), then where it belongs
        line = re.sub(r" ?(?:" + re.escape(ONCE_MANY) + "|" + re.escape(ONCE) + ")", "", line)
        if n:
            i = line.rfind("</d>") + 4
            i += re.match(r"[ \t]*[.!?]?", line[i:]).end()  # past a full stop right after the tag
            line = f"{line[:i].rstrip()} {ONCE_MANY if n > 1 else ONCE} {line[i:].lstrip()}".rstrip()
        out.append(line)
    return "\n".join(out)


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
    async for piece in _chat(b, name, messages, rewrite_temperature(creativity), 700):
        yield piece


async def _chat(b: llm.Backend, name: str, messages: list[dict[str, Any]], temperature: float, tokens: int) -> AsyncIterator[str]:
    """The model's reply, streamed in pieces (Ollama or an OpenAI-style server)."""
    if b.name == "ollama":
        body: dict[str, Any] = {"model": name, "messages": messages, "stream": True, "keep_alive": KEEP,
                                "options": {"temperature": temperature, "num_ctx": 4096, "num_predict": tokens,
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
    body = {"model": name, "messages": messages, "stream": True, "temperature": temperature, "max_tokens": tokens,
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
        done = _tidy("".join(out))
        if profile in ("h3video", "h3ref"):
            done = finish(text, done)
            if not has_style(done):  # the model skipped it: the user's own, else one written for these shots
                style = style_of(text) or await style_line(done, backend, url, model)
                if style:
                    done = f"{style}\n\n{done}"
        yield (json.dumps({"done": True, "text": done}) + "\n").encode()
    except (llm.LLMError, httpx.HTTPError) as exc:
        yield (json.dumps({"error": str(exc) or type(exc).__name__}) + "\n").encode()
    except asyncio.CancelledError:  # the browser moved on (the user kept typing)
        raise
