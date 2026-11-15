# Bob Studio

A small Python web app that turns your local ComfyUI into a focused studio for
**MiniMax H3** video, images and sound. It uses the official
[`comfy-sdk`](https://github.com/Comfy-Org/comfy-python-sdk) to run jobs and the
native ComfyUI API to discover models.

```
browser ── FastAPI (app/) ── comfy-sdk ── comfy-api-proxy :8189 ── ComfyUI :8188
                         └── native REST (/models, /system_stats, /free) ──┘
```

## Run

ComfyUI must already be running on `127.0.0.1:8188`.

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python run.py
```

Open http://127.0.0.1:8700. The app starts `comfy-api-proxy` (Comfy API v2) on
port 8189 by itself if nothing is listening there.

## What it does

| Tab | Engine | Output |
|---|---|---|
| Video | MiniMax H3: text-to-video, or image-to-video with optional first and last keyframes | MP4 with native stereo audio |
| Video | H3 Reference: 1–9 reference pictures (people, objects, places, style) tagged `<Picture N>` in the prompt. Needs the separate `minimax_h3_ref2va` model (about 19.5 GB) | MP4 with native stereo audio |
| Image | H3 still (one frame on H3's 768p canvas) or FLUX 3 Klein (with optional prompt upsampler) | PNG |
| Audio | H3 sound (generates sound jointly with a tiny video and keeps only the audio) or MiniMax Music 3 | MP3 |

Other features:

- **Quality presets:** Draft 480p, Standard 576p, Full 768p.
- **Duration:** snapped to H3's 17k+5 frame grid at 24 fps.
- **Turbo:** an 8-step LoRA.
- **Takes:** 1–4 per run, each on the next seed.
- **Live progress:** sampler step progress over server-sent events, with a cancel button.
- **Gallery:** grouped by day, with reuse settings, re-roll, download, and delete. Use **→ First frame** or **→ Last frame** (or drag) to animate an image.
- **Keyframe prompts:** H3's keyframe alignment line is added to the prompt automatically. Without it, H3 ignores a last frame.
- **✨ Write for me:** turns a one-line idea into an H3 shot list with a local LLM. Choose **Ollama** or any
  **OpenAI-compatible server** (llama.cpp `llama-server`, LM Studio, vLLM) under *Prompt writer*. The LLM only fills
  short JSON fields (style, framing, setting, action, camera, optional spoken line, soundscape, music); code assembles
  them into H3's format with frame-snapped `[Shot N] At 00:SS.mmm` times. A validator rejects negations, filler, overlong
  fields, repeated or looping dialogue, and missing or invalid `<Picture N>` tags, and sends the problems back for up to
  3 tries. Vision models also look at your keyframes and reference pictures. Ollama unloads the model after each prompt
  so H3 gets the VRAM back.
- **Model check:** each engine checks its model files. Music 3 isn't installed here yet, so the app shows which files to get from https://huggingface.co/Comfy-Org/MiniMax-Music-3.

## Layout

- `app/workflows.py`: API-format graphs, flattened from the official ComfyUI templates
  (`video_minimax_h3_t2v` / `_i2v`, `image_flux3_klein_distilled_t2i`, `audio_minimax_music_3`).
- `app/models.py`: model files per engine, with fallbacks (int8 or nvfp4 text encoder, 8- or 4-step LoRA).
- `app/llm.py`: the prompt writer (backends, schema, validator, assembler).
- `app/comfy.py`: comfy-sdk client, proxy lifecycle, and native ComfyUI calls.
- `app/jobs.py`: submits jobs, streams progress, downloads outputs to `outputs/`, keeps history in `data/history.json`.
- `app/main.py`: the HTTP API.
- `static/`: the UI (vanilla JS, no build step).

Settings are environment variables: `COMFYUI_URL`, `COMFY_BASE_URL` (proxy),
`BOB_PORT`, `BOB_HOST`, and `BOB_AUTO_START_PROXY=0` to skip starting the proxy. Prompt writer defaults:
`BOB_LLM_BACKEND` (`ollama` or `openai`), `OLLAMA_URL`, `BOB_OLLAMA_MODEL`, `BOB_OLLAMA_KEEP_ALIVE` (default `0`),
`BOB_LLM_URL` (default `http://127.0.0.1:8080`, llama-server's port) and `BOB_LLM_MODEL`. The UI remembers its own choice.

## Credits

- Ideas for H3 prompting, keyframe alignment and the app/preset pattern come from
  [iv-studio](https://github.com/hollisorg/iv-studio) (MIT) and
  [freefield](https://github.com/neuregex/freefield) (MIT).
- The prompt writer's "LLM fills short fields, code assembles the prompt, validator retries" design comes from
  [EDITS-WITH-AI](https://github.com/xentome/EDITS-WITH-AI) (Apache-2.0). No code was copied; the prompts are original.
- The gallery and takes ideas come from
  [ComfyUI-Sonder-Editor](https://github.com/SonderSaid/ComfyUI-Sonder-Editor). It is GPL-3.0, so no code was copied from it.
