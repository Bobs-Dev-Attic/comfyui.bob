# Changelog

All notable changes to Bob Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The current version lives in
`app/__init__.py` and is shown in the app's top bar and in `/api/status`.

## [0.11.0] - 2026-11-15

### Added
- **Startup backup.** When the app starts, every project (and Experiment) gets a copy of its `project.json` in
  `.history`, unless nothing changed since the last copy.
- **Project settings** (⚙ Settings… on the Project step, for projects and Experiment):
  - **Auto-save** on or off, and how soon after a change it saves.
    - When it's off, the top bar shows **Unsaved · Save**.
    - **Ctrl+S** saves.
    - Switching projects asks Save / Don't save / Cancel, and closing the tab warns.
  - **Linked audio** on or off, and where the sound goes: a new audio track for each video (new default) or the
    first free one.
  - A link to earlier versions.
- **Audio mixing.**
  - **Mixer** (🎚, Shift+M): a strip per track with mute, solo, pan and volume in dB. Double-click a slider to
    reset it.
  - **Master strip:** volume, a loudness target (Off, −14, −16 or −23 LUFS) and a limiter, plus a live peak meter.
  - **Sound…** on a clip's right-click menu: volume (dB), pan, fade in, fade out and mute. On a video whose
    sound is linked, it edits the sound clip.
  - **Fades:** drag the dots at a clip's top corners; the faded corners are shaded.
  - **Solo:** the **S** button on track headers.
- **Preview through Web Audio:** the program monitor plays the mix you'll render, including gains above 100 %,
  pan, fades, crossfades, solo, mute, the master volume and the limiter.
- `project.json`:
  - Clips: `pan`, `muted`, `fade_in`, `fade_out`.
  - Tracks: `pan`, `solo`.
  - Timeline: `master`, `link_audio_track`.
  - Config: `autosave`, `autosave_delay`.

### Changed
- **Video sound gets its own track.** Adding videos with sound puts each one's sound on its own audio track
  (A1, A2, A3…), so they can be mixed separately.
- **Render mix.** Rendering mixes with pan, fades and solo.
  - Linked sound clips on other tracks crossfade with their videos' transition.
  - The master runs volume, then two-pass `loudnorm` (measured, then applied: −14.0, −16.7 and −23.7 LUFS in
    tests), then a limiter.
- Rendering and FCPXML export save the timeline first, even when auto-save is off.
- FCPXML exports muted clips at −96 dB.

## [0.10.0] - 2026-11-15

### Added
- **Transitions.** Two clips that overlap on a track blend over the overlap, with each clip using its own frames.
  - **Making one:** press **Ctrl+T**, click the ⧓ button or use the clip menu to add one at the nearest cut. This
    pulls the next clip, everything after it and its linked sound left. You can also hold **Shift** when dropping a
    clip onto the end of another.
  - **Types:** 24 picture transitions, including cross dissolve, dip to black or white, pixel dissolve, wipes,
    slides, smooth slides, push, circle open and close, radial, zoom in, pixelate, blur, squeeze and barn door.
    Sound always crossfades.
  - **Changing one:** right-click or double-click a transition to change its type or length (in seconds and
    frames), or delete it with **Del**. Deleting restores the cut.
  - **Rendering:** each video track is built with ffmpeg `xfade` and the tracks are stacked; clip sound fades
    out and in to crossfade.
  - **Preview:** dissolves, dips, wipes, slides and circles play live with two layered players. Other types
    preview as a dissolve and render exactly.
  - **FCPXML:** a transition on the storyline exports as a cut in the middle of the overlap plus a Cross Dissolve
    spanning it; overlaps on other tracks become cuts.
- **Linked audio.** Adding a video with sound also puts its sound on an audio track as a linked clip, and the
  video clip itself goes silent.
  - A free audio track is used, or a new one is added.
  - The 🔗 button switches this on or off and is saved per project.
  - Linked clips select, move, trim, split, copy and delete together; **Alt+click** picks just one.
  - The clip menu has **Unlink**, **Detach sound to an audio track**, and **Link the two selected clips**.
  - When two linked videos get a transition, their sounds crossfade too.
- **Earlier versions.** `project.json` is copied into `.history` before it changes (at most once a minute, the
  last 30). **Earlier versions…** on the Project step lists and restores them, keeping the current state first.
- `project.json` timeline fields `transitions`, `link_audio`, and `clips[].link` / `audio_off`; see
  `docs/PROJECT_FORMAT.md`.

### Changed
- Timeline renders run as three ffmpeg steps (picture, sound, mux). In ffmpeg 8 a single graph mixing video
  transitions and several sound inputs deadlocked intermittently (6 of 15 test runs); split, 0 of 60 hung.
- Project updates are validated as they arrive, so bad data gets a readable error instead of a server error.

### Fixed
- Restoring settings that have no model choice left the form unchanged.

## [0.9.0] - 2026-11-15

### Added
- **Export FCPXML for DaVinci Resolve** (timeline **⬇ Render** menu, `GET /api/timeline/fcpxml`, `app/fcpxml.py`).
  - Writes FCPXML 1.9. In Resolve, use **File › Import › Timeline…**; Final Cut Pro reads it too.
  - The lowest video track becomes the primary storyline, with gaps.
  - Upper video tracks become connected clips on lanes 1, 2, … and audio tracks on lanes −1, −2, …, which Resolve
    turns into V2/V3 and audio tracks.
  - Times are whole frames, and each connected clip is placed in its parent's time.
  - Stills are exported as held `video` elements, clip and track volume as `adjust-volume` (dB), muted or hidden
    tracks as disabled clips, and markers as `marker`.
  - Media is linked in place (`file:///` paths); nothing is copied.

## [0.8.1] - 2026-11-15

### Added
- Timeline transport: **◀| / |▶ frame-step buttons** beside Play. A press steps one frame, holding repeats, and
  Shift steps a second. Stepping pauses playback and shows the timeline in the viewer.

### Fixed
- Results bin thumbnails were squashed: a full bin squeezed the tiles, and the 16:10 thumbnail shrank to nothing.
  Rows now keep each tile's full height.

## [0.8.0] - 2026-11-15

### Added
- **Split right side.** The viewer is on top. Below it, the **Results bin** and the **timeline** sit side by side.
  - Drag the dividers to resize both splits; double-click a divider to reset it, or use the arrow keys on it. The
    sizes are remembered.
  - The viewer switches between **Result** (the selected result) and **Timeline** (playback of the edit).
- **Ratings and tags on results.**
  - ★1–5 on every bin tile and in the viewer: click a star, or press 1–5, or 0 to clear.
  - Tags with Shift+T or 🏷.
  - Both are stored in the project's media library, so they also show in the Inputs gallery.
  - The bin filters by kind, minimum stars, tag and search, and sorts by newest, oldest or best rated.
  - A tile shows ⧉ when its result is on the timeline, and hovering a video tile plays it, muted.
- **Multi-track timeline** (`static/timeline.js`), saved in `project.json → timeline`.
  - **Tracks:** video and audio tracks. Upper video covers lower. Each track has hide, mute and lock buttons,
    rename, height, volume, and add or delete.
  - **Clips:** drag them in from the bin or the media gallery, double-click a result, or press Enter. Move them,
    including onto another track of the same kind, and trim either edge; trimming is capped at the source length
    and shows a dotted ghost of the whole source.
  - **Overwrite editing:** dropping onto clips trims or splits what's underneath.
  - **Snapping** to clip edges, the playhead, markers and In/Out, with a guide line. N toggles it; hold Alt while
    dragging to skip it.
  - **Edit operations:** split at the playhead, ripple delete, copy and paste, duplicate, nudge.
  - **Markers, In/Out and loop:** markers can be renamed and dragged; the area outside In/Out is dimmed, and the
    In–Out range can loop.
  - **Navigation:** frame-accurate timecode, which can switch to seconds. Zoom with the slider, +/−, Ctrl+wheel at
    the pointer, or fit to the timeline or the selection.
  - **Undo and redo** (200 steps).
  - **Playback:** the uppermost visible clip is the picture, and audio-track clips play alongside.
  - **Continue a shot:** "Continue from the last frame", and **G** uses the frame at the playhead as the next
    generation's first frame.
  - **Render** to MP4 with ffmpeg: the whole timeline or the In–Out range, at the first clip's size or 1080p or
    720p. Live progress, and the result lands in the bin.
  - **Keyboard shortcuts** in the DaVinci/Sonder style; **?** lists them all.
- **Layouts:** Default, Edit, Review and Bin presets (Alt+1–4), plus up to five saved layouts (Alt+5–9). A layout
  covers the panel sizes, the side width and the zoom.
- API: `/api/media/probe`, `/api/media/frame`, `/api/timeline/render`, and `/api/projects/{id}/library/rate`.

### Changed
- The gallery is replaced by the Results bin.
- Gallery tiles and the viewer no longer autoplay. Sound starts only when you press play.

### Fixed
- A result could start looping with sound by itself when a project opened or the viewer changed.

## [0.7.0] - 2026-11-15

### Added
- **Project file format `bob.project/2`** (`app/projectfile.py`, documented in `docs/PROJECT_FORMAT.md`, JSON Schema in
  `docs/project.schema.json`). The file has sections for metadata, `settings` (the studio form), `config`
  (per-project preferences: gallery view, prompt writer) and `library` (media, tags, virtual folders).
  - Every save is validated, and unknown settings keys are kept for forward compatibility.
  - 0.6.0 projects migrate automatically. Their input pictures become the first library items.
- **Media gallery in the Inputs step.** **🗂 Media** in the top bar or **⤢** opens the same gallery as a
  resizable window with a navigation pane.
  - **Sources:** the project's Library, virtual folders, bookmarked folders (with sub-folders and breadcrumbs), the
    project's results, and Uploads.
  - **Finding things:** search across names, tags and prompts; filter by kind; filter by tag (all-of); sort; and
    resize thumbnails.
  - **Selecting:** click, Ctrl-click, Shift-click, Ctrl+A.
  - **Using a picture:** double-click, Enter, or drag a picture onto a keyframe or reference slot. H3 Reference adds
    `<Picture N>`; H3 fills the first frame, then the last.
  - **Right-click menu:** Open (a preview window), Use as first or last frame, Add as reference, Tags…, Add to or
    remove from the library, and Copy path.
  - **Importing:** with Import or by dropping files from the desktop. Pictures, videos and sounds are accepted, and
    uploads are streamed to disk.
- **Tags and virtual folders.**
  - Tag one or many files. Tagging also collects a file into the project's library.
  - Rename a tag, give it a colour, or delete it everywhere.
  - A virtual folder is a saved tag filter: all of these tags or any of them, optionally limited to kinds. Make one
    from the current tag filter, and edit or delete it by right-clicking.
- **Bookmarks:** app-wide folder shortcuts, like Explorer's Quick access, stored in `data/library.json`.
  - A folder picker lists common places and drives, or you can paste a path.
  - Right-click a bookmark to rename or remove it.
  - Files in bookmarked folders can be used as inputs.
- **Thumbnail cache** in `data/thumbs` (WebP).
  - Pictures use Pillow; video frames and audio waveforms use ffmpeg (`BOB_FFMPEG`).
  - The cache key includes size and modified time, and the URLs are immutable, so browsers keep them.
  - The window footer shows the cache size and can clear it.
  - Studio gallery tiles use these thumbnails too, instead of loading each video.

### Changed
- Media refs may be absolute paths inside a bookmarked folder; uploads, outputs and bookmarks are the only readable
  places.
- `/api/upload` accepts videos (up to 2 GB) and sounds (up to 500 MB) as well as pictures, streaming them to disk.
- Experiment mode stores its settings and media library in `data/experiment/project.json`.

## [0.6.0] - 2026-11-15

### Added
- **Step tabs** down the side panel walk through a generation: **1 Project → 2 Model → 3 Inputs → 4 Prompt →
  5 Settings → 6 Generate**.
  - Back/Next buttons and arrow keys move between steps, and finished steps get a ✓.
  - The Inputs step only appears for models that take pictures.
  - A Generate button stays in the footer on every step.
  - The Generate step sums up your choices, with an Edit link on each.
- **Model step:** cards grouped by Video, Image and Audio.
  - Each card shows whether its files are ready, not loaded, or not installed, plus the options it offers and the
    model file in use.
  - Picking a card sets up the following steps for that model.
- **Projects**, saved as folders under `projects/` (`BOB_PROJECTS_DIR` to change it):
  - **New project:** a name, a location chosen in an Explorer window, starting from the current settings or the
    defaults, and notes.
  - **Open existing:** an Explorer-style browser.
    - Back, Forward, Up, Refresh, a clickable address bar and search.
    - A Quick access › Recent list and a folder tree.
    - A Details view with sortable Name, Date modified, Type and Items columns, or Large icons with project
      thumbnails.
    - A status bar, a right-click menu (Open, Rename, Delete), and keyboard shortcuts: Enter, Backspace,
      Alt+arrows, F2, Del, F5, Ctrl+Shift+N.
    - Delete moves things into `projects/.trash`.
  - **Experiment:** work without a project, with settings kept in the browser. **Save as project…** turns an
    experiment into a project at any time.
  - A Recent projects list, and notes saved with each project.
  - Results are tagged with their project. The gallery has a **This project / All** switch, and the viewer follows
    the open project.
  - A project's thumbnail and date follow its latest result. Renaming or moving a project keeps its history,
    because results point to the project's id.
- **Settings persist:**
  - The open project's settings save to its `project.json` as you work: model, prompt, pictures, size, length,
    turbo, seed, steps and takes.
  - In Experiment mode they're kept in the browser.
  - The last project and step reopen on the next visit.
- **Adjustable side panel:**
  - Drag the divider, or use the arrow keys on it. Double-click resets the width.
  - The width is remembered.
- **Movable, resizable windows** (`static/winman.js`) for New project, Open, the system check, and the prompts
  and confirmations:
  - Drag the title bar to move a window, or any edge or corner to resize it. Double-click the title bar to
    maximise.
  - Esc closes a window, and keyboard focus stays inside it.
  - Each window remembers its position and size.
- API: `/api/projects` endpoints (`browse`, `tree`, `recent`, create, get, update, folder, rename, delete), and
  `project` on `/api/generate`.

### Changed
- The Video/Image/Audio tabs and the engine switch are replaced by the Model step.
- The system check opens in a movable window instead of a fixed dialog.

## [0.5.1] - 2026-11-15

### Fixed
- H3 Reference with **Turbo** produced blown-out, streaked video. The reference graph used the `beta` scheduler, which
  the template recommends for full sampling, but the 4-step turbo LoRA is distilled for `simple`. Turbo runs now use
  `simple`; 20-step runs keep `beta`. Both were checked with the same seed and prompt on the real ref2va model. The
  scheduler is recorded in each job's info.

## [0.5.0] - 2026-11-15

### Added
- **Prompt Writer window** (`/writer`, opened with **↗ Writer window** next to the prompt). It works like the
  EDITS-WITH-AI editor:
  - **Your idea:** type it on the left. With **Auto** on, the local LLM rewrites the prompt a moment after you stop
    typing.
  - **Fields:** style, sound and music, plus one card per shot (framing, setting and light, action, camera, and an
    optional spoken line), each with a 🔒 lock.
  - **Locks:** typing into a field locks it, so the LLM keeps it word for word and writes the rest around it. Click
    🔒 to let the LLM rewrite it.
  - **Live H3 prompt:** the right side rebuilds on every keystroke, with no LLM call, and is colour-coded by who
    wrote each part: H3 format, you, the LLM, or missing. Click any part to jump to its field.
  - **Live checks:** negations, filler, word limits, spoken-line length, and unused or invalid `<Picture N>` tags.
  - **Sync with the studio:** the window follows the studio's engine, duration, aspect, keyframes and reference
    pictures, and keeps duration in sync both ways. Clicking a picture inserts its tag. **Use in studio** puts the
    prompt in the studio's prompt box, with Undo.
  - **Draft:** the draft is kept in the browser between sessions.
- `/api/prompt/write` accepts `locked` fields. The LLM is told to keep them, they are put back over its answer, and
  the validator never sends them back for a retry.
- `static/h3prompt.js` mirrors the server's prompt assembly; `tests/h3prompt_parity.py` checks that both build the
  identical prompt.

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

[0.10.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Bobs-Dev-Attic/comfyui.bob/releases/tag/v0.1.0
