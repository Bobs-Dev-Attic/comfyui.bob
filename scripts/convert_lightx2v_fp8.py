r"""Make a lightx2v-style fp8 checkpoint loadable by ComfyUI.

Some fp8 releases (e.g. lightx2v's qwen_image_edit_2511_fp8_e4m3fn_scaled.safetensors) store fp8
weights with a per-output-channel `.weight_scale` and no quantization metadata. ComfyUI ignores
those scales and renders noise. This folds each scale into its weight and writes a plain fp8 file
(like Comfy-Org's unscaled fp8 checkpoints); every other tensor is copied unchanged. The source is
only read. Needs torch (run it with ComfyUI's own Python):

    python_embeded\python.exe scripts\convert_lightx2v_fp8.py <in.safetensors> <out.safetensors>

Bob Studio looks for the Qwen Image Edit 2511 output as qwen_image_edit_2511_fp8_e4m3fn_plain.safetensors.
"""
import json
import struct
import sys
import time

import torch

src, dst = sys.argv[1], sys.argv[2]
DT = {"BF16": torch.bfloat16, "F16": torch.float16, "F32": torch.float32, "F8_E4M3": torch.float8_e4m3fn}

f = open(src, "rb")
n = struct.unpack("<Q", f.read(8))[0]
head = json.loads(f.read(n))
base = 8 + n
head.pop("__metadata__", None)
keys = sorted(head, key=lambda k: head[k]["data_offsets"][0])
scaled = {k for k in keys if k.endswith(".weight") and head[k]["dtype"] == "F8_E4M3" and k[:-7] + ".weight_scale" in head}
order = [k for k in keys if not (k.endswith(".weight_scale") and k[:-13] + ".weight" in scaled)]

out, off = {}, 0
for k in order:
    a, b = head[k]["data_offsets"]
    out[k] = {"dtype": head[k]["dtype"], "shape": head[k]["shape"], "data_offsets": [off, off + b - a]}
    off += b - a
out["__metadata__"] = {"converted_from": src.replace("\\", "/").rsplit("/", 1)[-1], "format": "plain fp8, scales folded in"}
hb = json.dumps(out, separators=(",", ":")).encode()
hb += b" " * (-len(hb) % 8)


def read(k):
    a, b = head[k]["data_offsets"]
    f.seek(base + a)
    return torch.frombuffer(bytearray(f.read(b - a)), dtype=torch.uint8).view(DT[head[k]["dtype"]]).reshape(head[k]["shape"])


dev = "cuda" if torch.cuda.is_available() else "cpu"
t0, worst = time.time(), 0.0
with open(dst, "wb") as g:
    g.write(struct.pack("<Q", len(hb)))
    g.write(hb)
    for k in order:
        if k in scaled:
            w = read(k).to(dev).float() * read(k[:-7] + ".weight_scale").to(dev).float()
            q = w.clamp(-448.0, 448.0).to(torch.float8_e4m3fn)
            worst = max(worst, ((q.float() - w).abs().mean() / w.abs().mean().clamp(min=1e-12)).item())
            g.write(q.cpu().view(torch.uint8).numpy().tobytes())
        else:
            a, b = head[k]["data_offsets"]
            f.seek(base + a)
            g.write(f.read(b - a))
print(f"done: {len(scaled)} layers folded, worst mean relative error {worst:.4f}, {time.time() - t0:.0f}s", flush=True)
