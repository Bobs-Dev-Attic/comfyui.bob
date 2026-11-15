# Changelog

All notable changes to Bob Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The current version lives in
`app/__init__.py` and is shown in the app's top bar and in `/api/status`.

## [0.4.0] - 2026-11-15

### Added
- `start.bat` starts ComfyUI when it isn't running. It uses the install set in `BOB_COMFYUI_DIR` (a ComfyUI folder or a
  `ComfyUI_windows_portable` folder) and the extra arguments in `BOB_COMFYUI_ARGS`.
  - ComfyUI runs in its own window and keeps running after the launcher exits.
  - The launcher waits up to 180 s for ComfyUI to answer.
  - `start.bat --no-comfyui` skips this.
- `python -m app.comfylaunch` (`--dry-run` prints the command).
  - It picks the portable build's `python_embeded`, a venv inside the install, or the system Python.
  - It passes `--extra-model-paths-config` only for yaml files that aren't the install's own.

### Changed
- The **Model folders** check compares the model files on disk with what ComfyUI actually lists, instead of reading
  ComfyUI's command line. The portable build loads its own `extra_model_paths.yaml` without any flag, which the old
  test misreported.
- Model scanning matches the file types core ComfyUI lists; `.gguf` files, which need custom loaders, are skipped.
- When ComfyUI is unreachable, the system check points to `start.bat` or `BOB_COMFYUI_DIR`.

## [0.3.0] - 2026-11-15

### Added
- `start.bat` launcher: creates `.venv` and installs packages on first run (and again when `requirements.txt`
  changes), runs the system check, starts the app and opens the browser. If the app is already running it just
  opens it. Options: `--no-browser`, `--skip-check`.
- System check (`python -m app.syscheck`, `GET /api/syscheck`, and a **System** chip in the top bar):
  - Python version and packages; operating system and CPU threads.
  - System RAM: fails below 16 GB, warns below 32 GB.
  - NVIDIA GPU and VRAM: fails below 8 GB, warns below 16 GB.
  - Disk space for outputs.
  - ComfyUI version and device; model folders and installed models.
  - comfy-api-proxy and the prompt-writer LLM.
  - The check runs at startup and opens the report automatically when something fails.
- Model discovery from ComfyUI `extra_model_paths.yaml` files (`BOB_EXTRA_MODEL_PATHS`). Models found on disk but not
  loaded by the running ComfyUI are reported with their location and the exact restart flag.
- `run.py --open` opens the browser once the server answers.
- `.gitattributes` keeps Windows line endings in `.bat` files.

### Changed
- Missing-models panels show where a file was found on disk instead of offering a download.

## [0.2.0] - 2026-11-15

### Added
- Version tracking: `__version__` in `app/__init__.py`, shown in the top bar and returned by `/api/status`.
- This changelog, and a release flow: every change goes through a pull request, then a `vX.Y.Z` tag.
- Local `.env` support (gitignored) with a documented `.env.example`.
- `BOB_LLM_API_KEY` for OpenAI-compatible LLM servers that require a key. It is sent only to the server set in
  `BOB_LLM_URL`, never to a URL typed in the browser, and never returned by the API.
- `scripts/check_secrets.py`, a pre-commit scan for keys, tokens and secret files.

### Security
- `.gitignore` now excludes `.env*`, key and certificate files, and `secrets/`.

## [0.1.0] - 2026-11-15

### Added
- FastAPI studio driving a local ComfyUI through comfy-sdk (via an auto-started comfy-api-proxy) and the native REST API.
- MiniMax H3: text-to-video, image-to-video with first/last keyframes, stills, and sound-only.
- H3 reference-to-video with 1–9 `<Picture N>` references (needs the ref2va model).
- FLUX 3 Klein images with an optional prompt upsampler; MiniMax Music 3 when installed.
- "Write for me" prompt writer using Ollama or any OpenAI-compatible local server, with a validator and retries.
- Live step progress over SSE, takes, a gallery with reuse and re-roll, and per-engine model checks.

[0.4.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/releases/tag/v0.1.0
