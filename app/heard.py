"""What a video's speaker actually says, against the lines its prompt gave (take ranking).

H3 doesn't always say the lines: it drops words, adds its own, or mumbles. After a video with spoken lines
(<d>…</d> in its prompt) is rendered, its sound is heard by Whisper (large-v3-turbo through faster-whisper, the
crt-nodes CRT_AudioTranscriptBatch node in ComfyUI) and compared with the lines word by word: the score is
1 - (word edit distance / words in the lines), as H3-AudioRetake-studio ranks its takes (MIT, its wordMatch).
A take that says the lines and nothing else scores 100; words left out, changed or added each cost one.
The result is kept on the item as item["heard"]; the gallery marks the best of a set of takes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from . import config, media

log = logging.getLogger("bob.heard")
NODE = "CRT_AudioTranscriptBatch"
MODEL = "large-v3-turbo"  # about 1.6 GB, fetched by the node into ComfyUI's models/stt/faster-whisper on first use
_D = re.compile(r"<d>(.*?)</d>", re.S)
_lock = asyncio.Lock()  # one at a time: each loads Whisper (a few GB of VRAM), then frees it


class HeardError(Exception):
    pass


def lines_of(prompt: str) -> tuple[list[str], str]:
    """The spoken lines in a prompt (without their [Language] tag), and the language Whisper should hear
    ("english"; "auto" when the tag isn't a plain language name)."""
    lines, lang = [], ""
    for m in _D.finditer(prompt or ""):
        t = m.group(1).strip()
        tag = re.match(r"\[([A-Za-z ]{2,20})\]\s*", t)
        if tag:
            lang = lang or tag.group(1).strip().lower()
            t = t[tag.end():]
        t = t.strip().strip('"“”').strip()
        if t:
            lines.append(t)
    return lines, lang or "auto"


def words(text: str) -> list[str]:
    """Words compared loosely: lower case, no punctuation ("Who's" and "whos" are the same word)."""
    return re.findall(r"[a-z0-9]+", re.sub(r"['’]", "", (text or "").lower()))


def match(expected: str, heard: str) -> tuple[float, int]:
    """(score 0-1: 1 - word edit distance / words expected, words heard beyond those expected)."""
    a, b = words(expected), words(heard)
    if not a:
        return 0.0, len(b)
    row = list(range(len(b) + 1))
    for i, w in enumerate(a):
        prev, row[0] = row[0], i + 1
        for j, v in enumerate(b):
            prev, row[j + 1] = row[j + 1], min(row[j + 1] + 1, row[j] + 1, prev + (w != v))
    return max(0.0, 1 - row[len(b)] / len(a)), max(0, len(b) - len(a))


def _comfy(path: str, data: bytes | None = None, ctype: str = "application/json", timeout: float = 60) -> bytes:
    import urllib.request

    req = urllib.request.Request(config.COMFYUI_URL + path, data, {"Content-Type": ctype} if data is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _upload(path: Path, name: str) -> str:
    bnd = uuid.uuid4().hex
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            "Content-Type: audio/wav\r\n\r\n").encode() + path.read_bytes() + (
        f"\r\n--{bnd}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{bnd}--\r\n").encode()
    return json.loads(_comfy("/upload/image", body, f"multipart/form-data; boundary={bnd}"))["name"]


def graph(audio_name: str, language: str) -> dict[str, Any]:
    return {
        "1": {"class_type": "LoadAudio", "inputs": {"audio": audio_name}},
        "2": {"class_type": NODE, "inputs": {
            "audio": ["1", 0], "isolate_voice": False, "keep_model_loaded": False, "whisper_model": MODEL,
            "compute_type": "float16", "vad_filter": True, "transcribe_batch_size": 8, "beam_size": 5, "language": language}},
        "3": {"class_type": "PreviewAny", "inputs": {"source": ["2", 1]}},  # the text, read back from /history
        "4": {"class_type": "PreviewAny", "inputs": {"source": ["2", 2]}},  # its status: "… | 1 failed" when Whisper failed
    }


def _text(hist: dict[str, Any], node: str) -> str:
    t = hist.get("outputs", {}).get(node, {}).get("text", [""])
    return (t[0] if isinstance(t, list) and t else str(t or "")).strip()


def _drop(pid: str) -> None:
    """Our own Whisper job, out of ComfyUI's queue: deleted if it's waiting, interrupted if it's running (a hung
    transcription would otherwise hold the queue, and every render behind it)."""
    for path, body in (("/queue", {"delete": [pid]}), ("/interrupt", {"prompt_id": pid})):
        try:
            _comfy(path, json.dumps(body).encode())
        except Exception:  # noqa: BLE001
            pass


def _log_error() -> str:
    """Why the node failed: it logs the error and returns empty text (e.g. "Library cublas64_12.dll is not found")."""
    try:
        entries = json.loads(_comfy("/internal/logs/raw")).get("entries", [])
    except Exception:  # noqa: BLE001
        return ""
    line = next((e.get("m", "") for e in reversed(entries) if "[CRT Audio Transcript Batch] ERROR" in e.get("m", "")), "")
    return line.split(":", 1)[-1].strip() if ":" in line else line.strip()


async def transcribe(video: Path, language: str, timeout: float = 600) -> str:
    """The words Whisper hears in a video's sound. `timeout`: seconds it may run once it's running (waiting behind
    renders in ComfyUI's queue doesn't count; the first run also fetches the model)."""
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "sound.wav"
        r = await asyncio.to_thread(subprocess.run, [media.ffmpeg(), "-nostdin", "-v", "error", "-y", "-i", str(video), "-vn",
                                                     "-ac", "1", "-ar", "16000", str(wav)],
                                    capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=media.NO_WINDOW)
        if r.returncode or not wav.is_file():
            raise HeardError(r.stderr.strip()[-300:] or "This video has no sound to hear")
        name = await asyncio.to_thread(_upload, wav, f"bob_heard_{uuid.uuid4().hex[:10]}.wav")
    res = json.loads(await asyncio.to_thread(_comfy, "/prompt", json.dumps({"prompt": graph(name, language)}).encode()))
    pid = res.get("prompt_id")
    if not pid:
        raise HeardError(f"ComfyUI refused the Whisper graph: {json.dumps(res.get('node_errors') or res)[:400]}")
    started = None
    while True:
        await asyncio.sleep(1.0)
        hist = json.loads(await asyncio.to_thread(_comfy, f"/history/{pid}")).get(pid, {})
        st = hist.get("status", {})
        if st.get("status_str") in ("success", "error") or st.get("completed"):
            break
        if started is None:
            q = json.loads(await asyncio.to_thread(_comfy, "/queue"))
            if any(r[1] == pid for r in q.get("queue_running", [])):
                started = time.monotonic()
            elif (not any(r[1] == pid for r in q.get("queue_pending", []))
                  and not json.loads(await asyncio.to_thread(_comfy, f"/history/{pid}")).get(pid)):  # not done in between
                raise HeardError("The Whisper job left ComfyUI's queue unfinished (was ComfyUI restarted?)")
        elif time.monotonic() - started > timeout:
            await asyncio.to_thread(_drop, pid)
            raise HeardError("Whisper took too long (it was taken out of ComfyUI's queue)")
    if st.get("status_str") != "success":
        err = next((m[1].get("exception_message", "") for m in st.get("messages", []) if m[0] == "execution_error"), "")
        raise HeardError(f"Whisper failed: {err[:400] or 'see the ComfyUI log'}")
    if "failed" in _text(hist, "4"):  # the node says so only in its status: its text is just empty
        err = await asyncio.to_thread(_log_error)
        if "cublas64_12" in err:
            err += (". faster-whisper is built for CUDA 12 and this ComfyUI's PyTorch for CUDA 13: CUDA 12's cuBLAS "
                    "(the nvidia-cublas-cu12 package) has to be where CTranslate2 finds it")
        raise HeardError(f"Whisper failed: {err[:500] or 'see the ComfyUI log'}")
    text = _text(hist, "3")
    return "" if text == "(empty)" else text


def wants(item: dict[str, Any]) -> bool:
    """A finished video whose prompt has spoken lines."""
    return (item.get("kind") == "video" and item.get("status") == "done" and bool(item.get("files"))
            and bool(lines_of((item.get("params") or {}).get("prompt", ""))[0]))


async def check(item: dict[str, Any], path_of: Callable[[str], Path], say: Callable[[str], None] = lambda m: None) -> dict[str, Any]:
    """Hear a finished video and score its words against its lines. -> item["heard"]."""
    lines, lang = lines_of((item.get("params") or {}).get("prompt", ""))
    if not lines:
        raise HeardError("Its prompt has no spoken lines (<d>…</d>) to check")
    f = next((x for x in item.get("files", []) if (x.get("content_type") or "").startswith("video")), None)
    if not f:
        raise HeardError("It has no video to hear")
    expected = " ".join(lines)
    async with _lock:
        t0 = time.time()
        say(f"Hearing the words with Whisper {MODEL} ({lang})")
        text = await transcribe(path_of(f["path"]), lang)
    score, extra = match(expected, text)
    res = {"score": round(score * 100), "heard": text, "expected": expected, "extra": extra, "language": lang,
           "model": MODEL, "at": time.time(), "seconds": round(time.time() - t0, 1)}
    say(f"Words: {res['score']}% heard as written" + (f", {extra} more word{'s' if extra > 1 else ''} than the lines" if extra else ""))
    return res
