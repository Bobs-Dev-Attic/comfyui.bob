"""Score: how well a result matches what was asked, in five checks, each 0-100 with its reasons.

- prompt:   the final prompt broken into yes/no checks a vision model answers from a few frames (DSG / TIFA style)
- identity: each reference picture's face against the faces in the result (InsightFace ArcFace, cosine)
- camera:   a 3D scene render against the camera move it was given (outline match + the same move); otherwise
            the apparent camera move against what the prompt says (static, pan, push in…)
- quality:  a vision model's ratings (composition, light, sharpness, realism) and the artifacts it spots
- settings: size, aspect, length, frame rate and sound against the request

The measuring (frames, faces, motion) runs in ComfyUI's Python (app/score_worker.py), which has OpenCV, PyAV and
InsightFace; the vision model is the Prompt writer's (Ollama or an OpenAI-compatible server).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import time
from pathlib import Path
from typing import Any

from . import comfylaunch, config, llm, media

log = logging.getLogger("bob.score")
OUT = config.UPLOAD_DIR / "score"  # its frames are shown with the scorecard
WEIGHTS = {"prompt": 0.35, "identity": 0.2, "camera": 0.2, "quality": 0.15, "settings": 0.1}


class ScoreError(RuntimeError):
    pass


def _worker_python() -> tuple[str, Path]:
    inst = comfylaunch.find_install(config.COMFYUI_DIR) if config.COMFYUI_DIR else None
    if not inst:
        raise ScoreError("Score measures with ComfyUI's Python: set BOB_COMFYUI_DIR in .env")
    return inst.python, inst.comfy / "models" / "insightface"


async def _measure(job: dict[str, Any]) -> dict[str, Any]:
    py, root = _worker_python()
    job["insightface_root"] = str(root)
    f = Path(job["out_dir"]) / "job.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(job), "utf-8")
    proc = await asyncio.create_subprocess_exec(py, "-s", str(Path(__file__).with_name("score_worker.py")), str(f),
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=600)
    except asyncio.TimeoutError as exc:
        proc.kill()
        raise ScoreError("Measuring took too long") from exc
    text = out.decode("utf-8", "replace").strip().splitlines()
    try:
        res = json.loads(text[-1]) if text else {}
    except ValueError:
        res = {}
    if proc.returncode or "error" in res or not res:
        tail = err.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise ScoreError(res.get("error") or f"Measuring failed: {' / '.join(tail) or proc.returncode}")
    return res


# ---------------------------------------------------------------- what the prompt says of the camera
CAM_WORDS = [
    (r"\b(static|holds? (a )?(static|still|steady)|locked[- ]off|does not move|stays still)\b", "static"),
    (r"\b(push(es)? in|dolly(ies)? in|zoom(s)? in|moves? (in|closer|toward)|creeps? in)\b", "in"),
    (r"\b(pull(s)? (back|out)|dolly(ies)? out|zoom(s)? out|moves? (back|away))\b", "out"),
    (r"\b(pan(s)?|truck(s)?|track(s)?|glide(s)?|slide(s)?|move(s)?|orbit(s)?) (to the )?left\b", "left"),
    (r"\b(pan(s)?|truck(s)?|track(s)?|glide(s)?|slide(s)?|move(s)?|orbit(s)?) (to the )?right\b", "right"),
    (r"\b(tilt(s)? up|crane(s)? up|rise(s)?|boom(s)? up|pedestal(s)? up)\b", "up"),
    (r"\b(tilt(s)? down|crane(s)? down|lower(s)?|descend(s)?|boom(s)? down)\b", "down"),
]


def camera_expected(prompt: str) -> list[str]:
    cam = " ".join(s for s in re.split(r"(?<=[.!?])\s+", prompt) if re.search(r"\bcamera\b", s, re.I)) or ""
    return sorted({w for pat, w in CAM_WORDS if re.search(pat, cam, re.I)})


# ---------------------------------------------------------------- the vision model
CHECKS_SYSTEM = (
    "You turn a prompt for an image or video model into the checks a viewer can make from a few frames of the result. "
    "Write 6 to 12 short yes/no questions, each about ONE thing the prompt asks for that can be seen: who or what is "
    "there, how many, what they look like and wear, what they do, the place, the light and time of day, the framing "
    "and camera angle, the style. Skip sound, music, speech content, timing words, and section headings. A prompt may "
    "name pictures as <Picture N>: don't ask whether someone looks like a picture (that is checked separately); ask "
    "about the visible description instead. Phrase each so 'yes' means the prompt was followed.")
ANSWER_SYSTEM = (
    "You check a generated {kind} against a list of yes/no questions. You see {n} frame(s) of it, in order. Answer "
    "every question from what is visible: yes only if it clearly holds (in most frames, for things that last), "
    "no if it doesn't or can't be seen. Give a short reason for each (under 15 words).")
QUALITY_SYSTEM = (
    "You judge the visual quality of a generated {kind} from {n} frame(s), strictly, as a film editor would. Rate "
    "1-10: composition, lighting, sharpness (detail and focus), realism (believable materials, anatomy, physics). "
    "Then list only the defects you can actually point to in these frames, each with its kind and exactly where it "
    "is (which frame, which part of the picture, on what). Most good results have none: an empty list is the usual "
    "answer. Never list a kind just because it is possible; text only counts if there is text in the picture.")


async def _vision_backend(opts: dict[str, Any]) -> tuple[llm.Backend, str]:
    b = llm.make_backend(opts.get("backend"), opts.get("url"))
    model = await b.pick(opts.get("model") or None, config.OLLAMA_MODEL if b.name == "ollama" else config.LLM_MODEL)
    if await b.vision(model) is False:
        for m in await b.models():
            if await b.vision(m["name"]):
                return b, m["name"]
        raise ScoreError(f"{model} can't see pictures: Score needs a vision model (for example qwen3-vl)")
    return b, model


async def _prompt_checks(b: llm.Backend, model: str, prompt: str, frames: list[str], kind: str) -> dict[str, Any]:
    q_schema = {"type": "object", "properties": {"checks": {"type": "array", "minItems": 3, "maxItems": 12, "items": {
        "type": "object", "properties": {"q": {"type": "string", "maxLength": 160},
                                         "about": {"type": "string", "enum": ["subject", "look", "action", "place", "light", "camera", "style"]}},
        "required": ["q", "about"]}}}, "required": ["checks"]}
    raw = await b.chat(model, [{"role": "system", "content": CHECKS_SYSTEM}, {"role": "user", "content": prompt[:6000]}], q_schema, temperature=0)
    # what frames can't show (sound, speech, music) goes, whatever the model wrote
    unseen = re.compile(r"\b(sound|audio|music|noise|hear|heard|voice|speech|says?|said|speak|speaks|spoken|talk|silent|soundscape)\b", re.I)
    checks = [c for c in json.loads(raw).get("checks", []) if str(c.get("q", "")).strip() and not unseen.search(str(c["q"]))][:12]
    if not checks:
        raise ScoreError("The vision model wrote no checks")
    a_schema = {"type": "object", "properties": {"answers": {"type": "array", "items": {"type": "object", "properties": {
        "i": {"type": "integer"}, "yes": {"type": "boolean"}, "why": {"type": "string", "maxLength": 140}}, "required": ["i", "yes", "why"]}}},
        "required": ["answers"]}
    listing = "\n".join(f"{i + 1}. {c['q']}" for i, c in enumerate(checks))
    imgs = [llm._image_b64(Path(f), 768) for f in frames]
    raw = await b.chat(model, [{"role": "system", "content": ANSWER_SYSTEM.format(kind=kind, n=len(frames))},
                               {"role": "user", "content": f"Questions:\n{listing}", "images": imgs}], a_schema, temperature=0)
    ans = {int(a.get("i", 0)): a for a in json.loads(raw).get("answers", [])}
    rows = [{"q": c["q"], "about": c.get("about"), "yes": bool(ans.get(i + 1, {}).get("yes")), "why": str(ans.get(i + 1, {}).get("why", "not answered"))}
            for i, c in enumerate(checks)]
    score = round(100 * sum(r["yes"] for r in rows) / len(rows))
    return {"score": score, "checks": rows, "model": model}


async def _quality(b: llm.Backend, model: str, frames: list[str], kind: str) -> dict[str, Any]:
    r = {"type": "integer", "minimum": 1, "maximum": 10}
    kinds = ["hands or limbs", "face or eyes", "warped or melted object", "duplicate or ghost", "garbled text", "smear or blur patch",
             "flicker between frames", "broken perspective", "other"]
    schema = {"type": "object", "properties": {"composition": r, "lighting": r, "sharpness": r, "realism": r,
              "defects": {"type": "array", "maxItems": 6, "items": {"type": "object", "properties": {
                  "kind": {"type": "string", "enum": kinds}, "where": {"type": "string", "minLength": 8, "maxLength": 100}},
                  "required": ["kind", "where"]}}},
              "required": ["composition", "lighting", "sharpness", "realism", "defects"]}
    imgs = [llm._image_b64(Path(f), 768) for f in frames]
    raw = await b.chat(model, [{"role": "system", "content": QUALITY_SYSTEM.format(kind=kind, n=len(frames))},
                               {"role": "user", "content": "Rate it.", "images": imgs}], schema, temperature=0)
    d = json.loads(raw)
    ratings = {k: max(1, min(10, int(d.get(k, 5)))) for k in ("composition", "lighting", "sharpness", "realism")}
    # one line per kind of defect (a model often repeats one per frame); "no text" and the like aren't defects
    nothing = re.compile(r"^\W*(no|none|n/?a|nothing|not (visible|present|seen))\b|\bno (text|defects?|artifacts?)\b", re.I)
    arts, kinds_seen = [], set()
    for a in d.get("defects", []):
        where = str((a or {}).get("where", "")).strip() if isinstance(a, dict) else ""
        if len(where) < 8 or nothing.search(where) or a.get("kind") in kinds_seen:
            continue
        kinds_seen.add(a.get("kind")); arts.append(f"{a.get('kind')}: {where}")
    score = max(0, round(sum(ratings.values()) / 4 * 10 - 6 * len(arts)))
    return {"score": score, "ratings": ratings, "artifacts": arts, "model": model}


# ---------------------------------------------------------------- the measured checks
def _identity(m: dict[str, Any] | None, names: dict[str, str]) -> dict[str, Any] | None:
    if not m:
        return None
    if m.get("error"):
        return {"score": None, "error": m["error"]}
    rows = []
    for r in m.get("refs", []):
        name = names.get(r["ref"], Path(r["ref"]).name)
        if not r.get("face"):
            rows.append({"ref": name, "note": "no face in the reference picture"}); continue
        if not r.get("with_face"):
            rows.append({"ref": name, "score": 0, "note": "no face found in the result"}); continue
        # ArcFace cosine: about 0.2 for strangers, 0.6+ for the same person
        s = lambda c: max(0, min(100, round((c - 0.2) / 0.45 * 100)))  # noqa: E731
        small = r.get("face_px") is not None and r["face_px"] < 48
        rows.append({"ref": name, "score": s(r["mean"]), "mean": r["mean"], "min": r["min"], "worst": s(r["min"]),
                     "seen": f"{r['with_face']} of {r['frames']} frames" + (f", faces about {r['face_px']} px" if r.get("face_px") else ""),
                     **({"note": "the faces are tiny here, so this is rough (a closer shot or a higher quality compares better)"} if small else {})})
    scored = [r["score"] for r in rows if r.get("score") is not None]
    return {"score": round(sum(scored) / len(scored)) if scored else None, "refs": rows}


def _camera(c: dict[str, Any] | None, scene: bool) -> dict[str, Any] | None:
    if not c:
        return None
    seen, exp = c.get("seen", []), c.get("expected", [])
    if scene and c.get("edges") is not None:
        edges, path = c["edges"], c.get("path")
        score = round(100 * (0.6 * edges + 0.4 * (path if path is not None else edges)))
        return {"score": score, "edges": round(edges * 100), "path": None if path is None else round(path * 100),
                "seen": seen, "given": classify_words(c.get("ref_track")), "track": c.get("track"),
                "note": "against the 3D scene's camera move"}
    if not exp:
        return {"score": None, "seen": seen, "track": c.get("track"), "note": "the prompt says nothing a camera check can test"}
    if exp == ["static"]:
        ok = seen == ["static"]
        return {"score": 100 if ok else max(0, 100 - 25 * len(seen)), "expected": exp, "seen": seen, "track": c.get("track")}
    want = [w for w in exp if w != "static"]
    hit = sum(w in seen for w in want)
    wrong = sum(w not in want for w in seen if w != "static")
    return {"score": max(0, round(100 * hit / len(want)) - 20 * wrong), "expected": exp, "seen": seen, "track": c.get("track")}


def classify_words(t: dict[str, Any] | None) -> list[str]:
    if not t:
        return []
    w = []
    if t["zoom"] > 1.06: w.append("in")
    if t["zoom"] < 0.94: w.append("out")
    if t["dx"] > 0.06: w.append("left")
    if t["dx"] < -0.06: w.append("right")
    if t["dy"] > 0.06: w.append("up")
    if t["dy"] < -0.06: w.append("down")
    if abs(t["turn"]) > 3: w.append("roll")
    return w or ["static"]


def _settings(item: dict[str, Any], probe: dict[str, Any], kind: str) -> dict[str, Any]:
    p, info = item.get("params") or {}, item.get("info") or {}
    rows = []
    W, H = probe.get("width"), probe.get("height")
    if info.get("width") and info.get("height") and W and H:
        rows.append({"name": "Size", "ok": (W, H) == (info["width"], info["height"]) or abs(W / H - info["width"] / info["height"]) < 0.02,
                     "detail": f"{W}×{H} (asked {info['width']}×{info['height']})"})
    asp = p.get("aspect")
    if asp and re.match(r"^\d+:\d+$", asp) and W and H and p.get("engine") not in ("motion", "imgedit"):
        a, b = map(int, asp.split(":"))
        rows.append({"name": "Aspect", "ok": abs(W / H - a / b) < 0.03, "detail": f"{W / H:.3f} (asked {asp})"})
    if kind == "video":
        fps = probe.get("fps") or 0
        rows.append({"name": "Frame rate", "ok": abs(fps - 24) < 0.6, "detail": f"{fps:.2f} fps (24 asked)"})
        want = info.get("seconds") or p.get("seconds")
        dur = probe.get("duration") or (probe.get("frames", 0) / fps if fps else 0)
        if want:
            rows.append({"name": "Length", "ok": abs(dur - float(want)) <= max(0.25, 0.06 * float(want)), "detail": f"{dur:.2f} s (asked {float(want):.2f} s)"})
        if p.get("engine") in ("h3", "h3ref", "motion"):
            rows.append({"name": "Sound", "ok": bool(probe.get("has_audio")), "detail": "has sound" if probe.get("has_audio") else "no sound track"})
    score = round(100 * sum(r["ok"] for r in rows) / len(rows)) if rows else None
    return {"score": score, "checks": rows}


# ---------------------------------------------------------------- the whole score
async def score_item(item: dict[str, Any], media_path, opts: dict[str, Any], say=lambda m: None) -> dict[str, Any]:
    files = item.get("files") or []
    f = next((x for x in files if media.kind_of(x.get("path", "")) in ("video", "image")), None)
    if item.get("status") != "done" or not f:
        raise ScoreError("Only a finished picture or video can be scored")
    path = media_path(f["path"])
    kind = media.kind_of(path.name)
    p, info = item.get("params") or {}, item.get("info") or {}
    prompt = str(info.get("final_prompt") or p.get("prompt") or "").strip()
    refs = [r for r in (p.get("references") or []) if r]
    names = {}
    ref_paths = []
    for k, r in enumerate(refs):
        try:
            rp = media_path(r)
        except Exception:  # noqa: BLE001
            continue
        if media.kind_of(rp.name) == "image":
            ref_paths.append(str(rp)); names[str(rp)] = f"<Picture {k + 2 if p.get('engine') == 'motion' else k + 1}>"
    out = OUT / item["id"]
    shutil.rmtree(out, ignore_errors=True)
    mref = config.UPLOAD_DIR / f"{item['id']}_motion.mp4"
    mmask = config.UPLOAD_DIR / f"{item['id']}_motion_mask.mp4"
    scene = p.get("engine") == "motion" and bool(p.get("motion_video")) and mref.is_file()
    say("Measuring the frames, faces and camera move…")
    t0 = time.time()
    m = await _measure({"media": str(path), "kind": kind, "out_dir": str(out), "frames": 4 if kind == "video" else 1,
                        "refs": ref_paths, "motion_ref": str(mref) if scene else None,
                        "motion_mask": str(mmask) if scene and mmask.is_file() else None, "camera_expected": camera_expected(prompt)})
    checks: dict[str, Any] = {"settings": _settings(item, m.get("probe", {}), kind)}
    if ref_paths:
        checks["identity"] = _identity(m.get("identity"), names)
    if kind == "video":
        checks["camera"] = _camera(m.get("camera"), scene)
    try:
        b, model = await _vision_backend(opts)
        if prompt:
            say(f"Checking the prompt with {model}…")
            checks["prompt"] = await _prompt_checks(b, model, prompt, m["frames"], kind)
        say(f"Rating the quality with {model}…")
        checks["quality"] = await _quality(b, model, m["frames"], kind)
    except (llm.LLMError, ScoreError, ValueError) as exc:
        msg = str(exc)
        checks.setdefault("prompt", {"score": None, "error": msg})
        checks.setdefault("quality", {"score": None, "error": msg})
    got = {k: v["score"] for k, v in checks.items() if v and v.get("score") is not None}
    wsum = sum(WEIGHTS[k] for k in got)
    overall = round(sum(WEIGHTS[k] * v for k, v in got.items()) / wsum) if wsum else None
    return {"overall": overall, "checks": checks, "at": time.time(), "seconds": round(time.time() - t0, 1),
            "frames": [f"/api/media/file?path={Path(x).relative_to(config.ROOT).as_posix()}" for x in m.get("frames", []) if Path(x).is_file()]}
