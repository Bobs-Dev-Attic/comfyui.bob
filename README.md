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

On Windows, double-click **`start.bat`**. On first run it creates `.venv` and installs the packages. Every run then
does the following:
1. Starts ComfyUI if it isn't running and `BOB_COMFYUI_DIR` is set in `.env`.
2. Checks the system.
3. Starts the app and opens the browser.

Options: `--no-browser`, `--skip-check`, `--no-comfyui`. Without `BOB_COMFYUI_DIR`, start ComfyUI yourself on
`127.0.0.1:8188` first. By hand:

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m app.syscheck
.venv\Scripts\python run.py --open
```

The app is at http://127.0.0.1:8700. The app starts `comfy-api-proxy` (Comfy API v2) on
port 8189 by itself if nothing is listening there.

## What it does

| Tab | Engine | Output |
|---|---|---|
| Video | MiniMax H3: text-to-video, or image-to-video with optional first and last keyframes | MP4 with native stereo audio |
| Video | H3 Reference: 1–9 reference pictures (people, objects, places, style) tagged `<Picture N>` in the prompt, and up to 3 reference sounds tagged `<Audio N>` to clone a voice (Inputs › Reference sound). Needs the separate `minimax_h3_ref2va` model (about 19.5 GB) | MP4 with native stereo audio |
| Image | H3 still (one frame on H3's 768p canvas), FLUX 3 Klein (with optional prompt upsampler), Krea 2, or MiniMax H3 Image (6 steps, up to 4 MP, optional reference pictures tagged `<Picture N>`; files from [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image)) | PNG |
| Audio | H3 sound (generates sound jointly with a tiny video and keeps only the audio) or MiniMax Music 3 | MP3 |

The side panel walks through a generation in steps: **1 Project → 2 Model → 3 Inputs → 4 Prompt → 5 Settings →
6 Generate**. Drag its edge to make it wider or narrower.

- **Projects:** New project, Open existing (an Explorer-style browser), or Experiment (no project).
  - Projects are folders under `projects/`, and each one keeps its settings, notes and results.
  - Settings save automatically, and the last project reopens on the next visit (Settings › Projects can turn that off).
  - **Versions…** (project card, project settings, or the ☰ menu): every change is kept as a version, at most every N
    minutes, keeping the last N (both in Settings › Projects). Each version lists what changed since the one before
    (prompt, model, settings, clips, library, notes). **Save a version** keeps a named one, which is never pruned;
    any version can be named, renamed, deleted or restored, and a restore keeps the current state first.
  - **✎ Rename…** and **🗑 Delete…** (project card or ☰ menu; also right-click in the Explorer) rename the open project
    and its folder, or move it to the projects trash (`projects/.trash`). Its results stay in the gallery.
  - **⧉ Duplicate…** (project card, or right-click in the Explorer) copies a project: settings always, and the
    timeline, media library and results if you choose. Experiment can be copied into a new project the same way.
    Files aren't duplicated; both projects use the same uploads and results.

- **✏ Edit** (any finished picture: the viewer's button): an image editor over the stage (the timeline hides). The toolbar
  has **Crop** (free or a ratio), **Resize** (plus rotate and flip), **Adjust** (brightness, contrast, saturation, hue,
  grayscale, sepia) and **Select + AI**. Select by hand with a brush, with **AI select** (paint over an object and SAM 3.1
  selects all of it), or by typing what to select. Then **Erase** it, **Replace it with…** something you describe, or
  **Change it with a prompt** (Krea 2, with a strength). **Edit the whole picture** takes an instruction ("make it
  night time") with no selection. Erase, Replace and whole-picture edits use the **Edit model** you pick: Qwen Image
  Edit 2511 (4 steps, fast) or MiniMax H3 Image (6 steps; needs its diffusion model and VAE from
  [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image) plus H3's Qwen3-VL 32B text
  encoder). **Remove background** works
  on the whole picture, to transparent, white or black (BiRefNet when one is in `models/background_removal`, else
  u2net). Every AI edit is also a result in the gallery; Undo/Redo step through them. **Save as new result** keeps the
  crop, size and color changes. Needs `sam3.1_multiplex_fp16` in `models/checkpoints` for AI select, and the NKD
  Nodes (inpaint crop and stitch).
- **🔄 Angles** (any picture: viewer, results menu or media library): re-shoot it from other camera angles with Qwen Image
  Edit 2511 and the multiple-angles LoRA. Pick directions × heights on a grid or a preset such as **24 head angles**, make a
  plain backdrop pure white, upscale each with SeedVR2, and put them in a new project. Needs `qwen_image_edit_2511` (bf16,
  fp8mixed, or a lightx2v fp8 file converted with `scripts/convert_lightx2v_fp8.py`), `qwen_2.5_vl_7b`, `qwen_image_vae`,
  `qwen-image-edit-2511-multiple-angles-lora` and, for 4-step speed, the 2511 Lightning LoRA.
- **✨ Enhance** (any finished picture or video: the viewer's button or the results menu): improve it with a chain, in order:
  **FaceRefine** (videos made with H3: tracks the main face and re-renders it with H3 Reference at a low denoise, using the
  video's own prompt, references and LoRAs, then stitches it back), **DLSS 5** (NVIDIA neural rendering, 1x look or 1.5–3x
  upscale), then **SeedVR2** (restore and upscale to 720p–2160p, 3B or 7B) or **RelayVSR ×2** (fast 2x video
  super-resolution). Settings › **After generating** can run it on every new result. Needs the ComfyUI-H3-FaceRefine,
  ComfyUI-DLSS5-Enhancer and SeedVR2 custom nodes, and the RelayVSR model files; missing ones are greyed out. The window,
  the After generating setting and the Activity console estimate how long it takes, learning from your own runs.
- **Shots** (video, after Inputs): plan the video shot by shot: each shot has a length, framing, where, what happens, a camera
  move, a spoken line with a voice from the reference sounds, and its own first/last frame (H3) or reference pictures (H3
  Reference). Turn on **Use shots** and pick **One video · multi-shot** (one generation in H3's `[Shot 1] … [Shot 2] At
  00:03.000, …` format) or **One video per shot** (a generation per shot, laid out on the timeline in order).
- **LoRAs** (every model): add LoRAs with a strength, reorder them, and click trigger words into the prompt. **📂 Browse
  LoRAs…** opens a Windows Explorer style browser over every LoRA ComfyUI can load: folder tree, address bar, search,
  details or large icons, and a details pane (what model it's for, base, rank, size, trigger words, description, preview
  picture if there is one next to the file). It shows only LoRAs that fit the selected model unless you untick that, and
  hides RefMod reference files (they need the RefMod nodes).
- **Media gallery** (Inputs step, or **🗂 Media**): the project's library, virtual folders, bookmarked folders,
  results and uploads.
  - Thumbnails are cached in `data/thumbs`.
  - Tag files and save tag filters as virtual folders.
  - Double-click or drag a picture onto a slot to use it.
  - Pick several with the ✓ on each tile (or Ctrl/Shift+click, Select all); **🗑 Delete…** sends files to the
    Recycle Bin, and **Remove** only takes them out of the library.
- **Activity console** (the top bar's Activity chip, a queue item's **Log**, or **Ctrl+Shift+A**): every
  generation, render and export, with a detailed log, progress, elapsed time, time left and when it'll finish.
- **☰ Menu and Settings** (left of "Bob Studio", or **Ctrl+,**): app-wide settings in a window, saved to
  `data/settings.json` as you change them:
  - **Appearance:** 8 color themes (System, Dark, Light, Midnight, Graphite, Forest, Paper, High contrast), 8 accent
    colors, text size and reduce motion.
  - **Projects:** how many automatic versions to keep, how often, a version at startup, and reopening the last project.
  - **Generation:** a chime or a desktop notification when a job finishes, and asking before deleting a result.
  - **Image editor:** the default edit model.
  - **Settings file:** edit the JSON directly, export it, import it, or reset everything. **About** shows the version.
- **Project files:** `project.json` stores settings, preferences, the media library and the timeline, and keeps
  earlier versions you can restore (in the project's `.history` folder). Every project is backed up when the app starts. **⚙ Settings…** on the Project
  step turns auto-save off (then **Ctrl+S** saves, and you're asked before leaving unsaved changes). See
  [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md).

- **Results gallery** (top, left of the viewer; **🗂 Gallery** or **Alt+G** shows or hides it): rate (★1–5) and tag
  results, then drag them onto the multi-track **timeline** below.
  - Trim, split, ripple-delete and snap clips; add markers and an In/Out range.
  - Add transitions with **Ctrl+T** (24 types).
  - **✨ Video Fx** (Shift+E, or right-click a clip): grade (exposure, contrast, saturation, temperature, tint,
    black and white or sepia), up to 4 lights you drag into place on the viewer (relight, glow or shade, with colour,
    size, strength, flicker, and an optional path across the clip), vignette, blur, sharpen and film grain. Presets
    include Golden hour, Moonlight, Noir, Neon side light, Candle flicker, Light sweep and Film look.
    **Keyframes** make the grade and the lights change over the clip: add one, move the playhead, change
    something (that sets another), and choose smooth, linear or hold easing. The lighting
    approach (multiplying the picture by a soft light ratio so its texture stays) comes from
    [AInVFX Paint a Plate](https://github.com/AInVFX/ainvfx-paintaplate) (Apache-2.0), done here with ffmpeg
    instead of generative models.
  - **🎥 Camera track** (Shift+C, ＋ Camera): camera moves over the finished picture: pan, tilt, roll, zoom,
    dolly, truck, crane and orbit, keyframed, with handheld shake and presets (push in, orbit, crane, dutch tilt,
    dolly zoom…). The viewer previews it in 3D and the render matches. **AI reshoot** regenerates the shot along
    the move: FLUX Klein fills in what the camera newly sees from your description and reference pictures, then
    MiniMax H3 makes the video; it lands on its own track. The Camera window has a **3D view** like Blender's:
    the picture as a card (a relief once **Analyse depth** has run Depth Anything 3), the camera as an object you drag
    to move, rotate or orbit, its path and keyframes, and **Look through** to see the shot with parallax (the main viewer shows that parallax too while the playhead is in the move). Idea from
    [Reshoot 4D](https://github.com/itsmetamike/reshoot-4d) (AGPL-3.0, no code used), built on the models here.
  - **⬇ Render…** opens the render options: file name, where to save (outputs or a bookmarked folder), format
    (H.264, H.264 on NVENC, H.265, VP9/WebM, ProRes, WAV, MP3), resolution, frame rate, quality, speed and
    sound (loudness, bitrate, sample rate, mono or stereo). Optionally add a timestamp to the file name or burn
    the timecode into the picture.
  - Videos with sound get their own audio track each. Audio clips are drawn as waveform graphs, scaled by
    their volume and fades, with the volume line on top and red marks where the sound would clip. Click the line
    to add volume keyframes, drag them, double-click to delete. Mix with **🎚 Mixer** (Shift+M): per-track volume, pan,
    mute and solo, and a master with loudness targets (−14/−16/−23 LUFS) and a limiter. Right-click a clip for
    **Sound…** (volume, pan, fades, mute), or drag the dots at its top corners to fade.
  - Videos with sound bring it onto a linked audio track.
  - Play the edit back, render it to MP4, or export FCPXML for DaVinci Resolve.
  - Press **?** for the keyboard shortcuts, and use **▦ Layout** (Alt+1–9) for panel layouts.

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
- **System check:** checks the following:
  - Python and its packages.
  - RAM (16 GB minimum, 32 GB+ recommended).
  - The NVIDIA GPU and its VRAM (16 GB+ for H3).
  - Disk space.
  - ComfyUI, the model folders and the installed models.
  - The API proxy and the prompt-writer LLM.

  The check runs from `start.bat`, at startup, and from the **System** chip in the top bar.
- **Model folders:** set `BOB_EXTRA_MODEL_PATHS` in `.env` to your ComfyUI `extra_model_paths.yaml`. The app then finds
  models on disk that the running ComfyUI isn't loading, and tells you which `--extra-model-paths-config` file to
  restart ComfyUI with.
- **Prompt Writer:** click **✍ Writer** next to Gallery (or Alt+W, or ✍ Prompt Writer next to the prompt). It opens as a pane in
  the top section, between the gallery and the viewer; **↗ Pop out** puts it in its own window.
  - Type your idea on the left; the LLM fills the style, sound and per-shot fields (framing, setting, action, camera,
    spoken line).
  - The H3 prompt on the right rebuilds on every keystroke, colour-coded by who wrote each part: H3 format, you, the
    LLM, or missing.
  - Typing into a field locks it 🔒, so the LLM keeps it and writes around it.
  - **Use in studio** sends the prompt back.
- **Model check:** each engine checks its model files. Music 3 isn't installed here yet, so the app shows which files to get from https://huggingface.co/Comfy-Org/MiniMax-Music-3.

## Layout

- `app/workflows.py`: API-format graphs, flattened from the official ComfyUI templates
  (`video_minimax_h3_t2v` / `_i2v`, `image_flux3_klein_distilled_t2i`, `audio_minimax_music_3`).
- `app/models.py`: model files per engine, with fallbacks (int8 or nvfp4 text encoder, 8- or 4-step LoRA).
- `app/llm.py`: the prompt writer (backends, schema, validator, assembler).
- `app/syscheck.py`: the system check (command line and `/api/syscheck`).
- `app/modelpaths.py`: reads `extra_model_paths.yaml` and scans model folders on disk.
- `start.bat`: the Windows launcher; `app/comfylaunch.py` starts ComfyUI for it.
- `app/comfy.py`: comfy-sdk client, proxy lifecycle, and native ComfyUI calls.
- `app/jobs.py`: submits jobs, streams progress, downloads outputs to `outputs/`, keeps history in `data/history.json`.
- `app/main.py`: the HTTP API.
- `app/projects.py`: project folders, browsing, rename, trash, and the media library (tags, virtual folders).
- `app/projectfile.py`: the `project.json` schema (pydantic), migration, and JSON Schema export.
- `app/media.py`: media sources, bookmarks, the thumbnail cache, the folder picker, probing and frame grabs.
- `app/render.py`: renders a timeline to MP4 with ffmpeg.
- `app/fcpxml.py`: exports a timeline as FCPXML 1.9 for DaVinci Resolve and Final Cut Pro.
- `static/`: the UI (vanilla JS, no build step).
  - `shell.js`: the side panel steps, projects, settings persistence and the panel splitter.
  - `winman.js`: movable, resizable windows.
  - `explorer.js`: the project browser.
  - `media.js`: the media gallery.
  - `bin.js`: the Results bin.
  - `timeline.js`: the timeline, the viewer switch and layouts. `writer.html`/`writer.js` is the Prompt Writer (the top section's Writer pane, or a window);
  `h3prompt.js` mirrors the server's prompt assembly (`tests/h3prompt_parity.py` keeps them identical).

Settings are environment variables, or lines in a local `.env` file (copy `.env.example`): `COMFYUI_URL`, `COMFY_BASE_URL` (proxy),
`BOB_PORT`, `BOB_HOST`, `BOB_EXTRA_MODEL_PATHS` (your `extra_model_paths.yaml`), `BOB_COMFYUI_DIR` and
`BOB_COMFYUI_ARGS` (the ComfyUI that `start.bat` starts), `BOB_FFMPEG` (thumbnails for video and sound), and `BOB_AUTO_START_PROXY=0` to skip starting the proxy. Prompt writer defaults:
`BOB_LLM_BACKEND` (`ollama` or `openai`), `OLLAMA_URL`, `BOB_OLLAMA_MODEL`, `BOB_OLLAMA_KEEP_ALIVE` (default `0`),
`BOB_LLM_URL` (default `http://127.0.0.1:8080`, llama-server's port) and `BOB_LLM_MODEL`. The UI remembers its own choice.

## Secrets

Keys and tokens live only in the environment or in `.env`, which git ignores. The one secret the app uses today
is `BOB_LLM_API_KEY`: it is sent only to the server in `BOB_LLM_URL` and is never shown in the UI or returned by the
API. Run `.venv\Scripts\python scripts\check_secrets.py` before committing; it fails on anything that looks like a
key, token, or secret file.

## Releases

Every change ships through a pull request: bump `__version__` in `app/__init__.py`, add an entry to
[CHANGELOG.md](CHANGELOG.md), merge, then tag the merge commit `vX.Y.Z`.

## Credits

- Ideas for H3 prompting, keyframe alignment and the app/preset pattern come from
  [iv-studio](https://github.com/hollisorg/iv-studio) (MIT) and
  [freefield](https://github.com/neuregex/freefield) (MIT).
- The prompt writer's "LLM fills short fields, code assembles the prompt, validator retries" design comes from
  [EDITS-WITH-AI](https://github.com/xentome/EDITS-WITH-AI) (Apache-2.0). No code was copied; the prompts are original.
- The timeline draws on ideas from EDITS-WITH-AI (Apache-2.0), [Imagination Studio](https://github.com/drowzeys/Imagination-Studio-by-keys-Wasserman)
  (Apache-2.0) and the Sonder Editor's documentation. No code was copied from any of them.
- The gallery and takes ideas come from
  [ComfyUI-Sonder-Editor](https://github.com/SonderSaid/ComfyUI-Sonder-Editor). It is GPL-3.0, so no code was copied from it.
