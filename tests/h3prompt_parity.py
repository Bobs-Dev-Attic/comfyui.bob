"""Check that static/h3prompt.js builds exactly the prompt app/llm.py builds.

Run:  .venv\\Scripts\\python tests\\h3prompt_parity.py   (needs Node.js on PATH)
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import llm, workflows  # noqa: E402

SHOT = {"framing": "wide shot", "setting": "rain-slicked alley; neon reflections", "action": "the woman from <Picture 1> turns",
        "camera": "The camera pushes in slowly.", "dialogue": "You're late. You're late. You're late. You're late."}
CASES = [
    ("t2v", 8, {"style": "cinematic, 35mm", "soundscape": "rain and distant traffic", "music": "",
                "shots": [SHOT, {**SHOT, "framing": "close-up", "dialogue": "", "camera": "holds a static shot"},
                          {**SHOT, "framing": "medium shot", "dialogue": "Okay “fine” 我需要 it"}]}),
    ("ref", 6, {"style": "Comic ink.", "soundscape": "Roar!", "music": "N/A",
                "shots": [{**SHOT, "dialogue": "a b c d e f g h i j k l m n o p q r s t u v w x y z"}, SHOT]}),
    ("i2v", 5, {"style": "\"quoted style\"", "soundscape": "wind", "music": "soft piano",
                "shots": [{**SHOT, "dialogue": "Move on now, please move on now, please move on now"}]}),
    ("still", 5, {"style": "watercolor", "shots": [{"framing": "Medium Shot", "setting": "a library", "action": "a fox reads"}]}),
    ("sound", 6, {"soundscape": "thunder at 0s, a dog barks at 3s", "music": ""}),
    # Camera angle + position (the fields are optional; old drafts without them build as before).
    ("t2v", 8, {"style": "noir", "soundscape": "rain", "music": "",
                "shots": [{**SHOT, "angle": "low angle", "position": "behind her at shoulder height,", "dialogue": ""},
                          {**SHOT, "angle": "Over the shoulder", "position": "The camera is across the table from him.",
                           "dialogue": "", "camera": "racks focus"},
                          {**SHOT, "angle": "slightly tilted", "position": "", "dialogue": ""}]}),
    ("still", 5, {"style": "watercolor", "shots": [{"framing": "Wide Shot", "angle": "overhead", "setting": "a library",
                                                     "action": "a fox reads", "position": "positioned high above the desk"}]}),
]


def python_side() -> list[str]:
    out = []
    for mode, seconds, data in CASES:
        req = llm.WriteRequest(mode=mode, idea="x", seconds=seconds)
        n = 1 if mode in ("still", "sound") else len(data["shots"])
        frames = 5 if mode == "still" else workflows.h3_length(seconds)
        out.append(llm.assemble(data, req, n, frames))
    return out


JS = r"""
require(process.argv[1]);
const cases = JSON.parse(process.argv[2]);
const H = globalThis.H3Prompt;
const out = cases.map(([mode, seconds, data]) => {
  const n = (mode === "still" || mode === "sound") ? 1 : data.shots.length;
  const frames = mode === "still" ? 5 : H.h3Length(seconds);
  return H.toText(H.assemble(data, mode, n, frames));
});
process.stdout.write(JSON.stringify(out));
"""


def js_side() -> list[str]:
    res = subprocess.run(["node", "-e", JS, str(ROOT / "static" / "h3prompt.js"), json.dumps(CASES)],
                         capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(res.stdout)


def main() -> int:
    py, js = python_side(), js_side()
    bad = 0
    for (mode, _s, _d), a, b in zip(CASES, py, js):
        if a != b:
            bad += 1
            print(f"MISMATCH in {mode}:\n--- python\n{a}\n--- js\n{b}\n")
    for s in (2, 2.5, 3.1, 5, 7.25, 8, 15):
        r = subprocess.run(["node", "-e", f"require({json.dumps(str(ROOT / 'static' / 'h3prompt.js'))});"
                            f"process.stdout.write(String(H3Prompt.h3Length({s})))"], capture_output=True, text=True)
        if int(r.stdout) != workflows.h3_length(s):
            bad += 1
            print(f"MISMATCH h3_length({s}): python {workflows.h3_length(s)} js {r.stdout}")
    print("parity OK" if not bad else f"{bad} mismatch(es)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
