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
| Image | H3 still (one frame on H3's 768p canvas), FLUX 3 Klein (with optional prompt upsampler), Krea 2, or MiniMax H3 Image (6 steps, up to 16 MP, optional reference pictures tagged `<Picture N>`; files from [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image); **Clean texture** with the [ComfyUI-H3-Image-EasyFix](https://github.com/PedroMarinhoDev/ComfyUI-H3-Image-EasyFix) node pack), or MOSS Image ([OpenMOSS MOSS-Image](https://github.com/OpenMOSS/MOSS-Image), Apache-2.0: good at text inside the picture and long prompts, 0.5–2 MP, optional prompt enhancer, **▣ Layout** boxes under the prompt that place text, objects and characters; files from [Comfy-Org/MOSS-Image](https://huggingface.co/Comfy-Org/MOSS-Image), ComfyUI 0.42 or later), or MOSS Edit (changes a photo by instruction, “Change only the X to Y. Keep … unchanged.”, with up to 3 more reference pictures; needs the `moss_image_edit_lora_rank_64_bf16` LoRA and ComfyUI 0.43 or later) | PNG |
| Audio | H3 sound (generates sound jointly with a tiny video and keeps only the audio) or MiniMax Music 3 | MP3 |

Settings › **Advanced** can also swap the diffusion model and pick the **sampler, scheduler, steps and CFG** (Default = the
model's ComfyUI template). A result's **{ } Workflow** button shows the exact ComfyUI workflow it was made with, to
compare with your own or load in ComfyUI.

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

- **✏ Edit** (any finished picture: the viewer's button; any picture in the media library: its menu, preview or the
  selection bar): an image editor over the stage (the timeline hides). The toolbar
  has **Crop** (free or a ratio), **Resize** (plus rotate and flip), **Adjust** (brightness, contrast, saturation, hue,
  grayscale, sepia) and **Select + AI**. Select with **Rectangle**, **Square**, **Ellipse**, **Circle**, **Lasso** or the
  **Magic wand** (tolerance, contiguous or not); Shift adds to the selection, Alt subtracts, both intersect (or pick
  New, Add, Subtract or Intersect), and marching ants outline it. Or select by hand with a brush, with **AI select**
  (paint over an object and SAM 3.1 selects all of it), or by typing what to select. Ctrl+A selects all, Ctrl+D
  deselects, Ctrl+Shift+I inverts; **Feather** softens the edge of new selections (Feather now softens the current one). Then **Erase** it, **Replace it with…** something you describe, or
  **Change it with a prompt** (Krea 2, with a strength). **Edit the whole picture** takes an instruction ("make it
  night time") with no selection. Erase, Replace and whole-picture edits use the **Edit model** you pick: Qwen Image
  Edit 2511 (4 steps, fast) or MiniMax H3 Image (6 steps; needs its diffusion model and VAE from
  [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image) plus H3's Qwen3-VL 32B text
  encoder); **Edit the whole picture** can also use MOSS-Image Edit (with the MOSS Edit model's files). **Remove background** works
  on the whole picture, to transparent, white or black (BiRefNet when one is in `models/background_removal`, else
  u2net). Every AI edit is also a result in the gallery; Undo/Redo step through them. **Save as new result** keeps the
  crop, size and color changes. Needs `sam3.1_multiplex_fp16` in `models/checkpoints` for AI select, and the NKD
  Nodes (inpaint crop and stitch).
- **🎬 Animate objects** (a picture's menu in the results, or on the Inputs step): cut objects out of the picture and
  move them along paths, then MiniMax H3 renders the shot from the picture with the objects following their paths
  (Time-to-Move, the method of [h3-motion](https://github.com/PxTicks/h3-motion)). Find each object by name or click
  it (AI select), make the empty background (Erase), drag each object at a time on the scrubber to key its path, set
  its size and flip, and Generate. Needs AI select and Erase (above), H3, and
  [ComfyUI-vlo](https://github.com/PxTicks/ComfyUI-vlo) 0.3+ for `vloTimeToMove`.
- **📷 Generate photo** in Animate objects: the picture at the playhead with the objects where you put them, made into
  one natural photograph by Qwen Image Edit 2511 (or MiniMax H3 Image).
- **🎯 Track an object** (a video's menu in the results): click an object (or name it) on any frame and SAM 3.1
  follows it for up to 15 s; misdetections are dropped, gaps filled and the path smoothed into a few keys. Save the
  path, then in Animate objects any object can **Use a tracked path** to move the same way. Needs the SAM 3.1 checkpoint.
- **🧊 Make 3D** (a picture's button in the gallery, its menu in the results, the Media page or the Inputs step, or an
  object's right-click menu in Animate objects): a textured 3D model (GLB) of the main object, or of the chosen object, with TRELLIS.2 as ComfyUI's
  template runs it (shape, texture, then remeshed, UV-unwrapped and baked). It's made in the background in a few minutes;
  ☰ › **3D models** lists them, and each opens in a small Blender-style viewer (drag to orbit, right-drag to pan, wheel to
  zoom; Texture, Clay or Wireframe; a floor grid and turntable), opens in your 3D app (🖥 Open in 3D app: what Windows
  uses for .glb, such as Blender), shows in Explorer (📂 Show in folder), or downloads as a `.glb`. The hidden sides
  are made up by the model. Needs `trellis_2_int8_convrot` (diffusion_models), `trellis_2_shape_vae_bf16` and
  `trellis_2_texture_vae_bf16` (vae), `dino_v3_L_naf_fp32` (clip_vision), from
  [Comfy-Org/TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2) and [Comfy-Org/Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D),
  plus BiRefNet (background_removal) for a whole picture. Models live in `data/models3d.json`, files in `outputs/3d/`.
- **🏞 3D scene** (a picture's button in the gallery, its menu in the results, the Media page or the Inputs step, or
  🏞 Open as a 3D scene in Animate objects): the picture in depth with 3D models
  standing in it. Depth Anything 3 (`depth_anything_3_base`, already used for camera moves) turns the background (the
  empty background from Animate objects when there is one, so objects don't show twice) into a surface, and its camera
  is estimated from the picture. Each object's 3D model (🧊 Make 3D, from the scene or Animate objects) stands where it
  was: on the ground under its foot, sized by its height in the picture. 🎥 looks through the picture's own camera
  (which shows the picture); drag to orbit, right-drag to pan, wheel to zoom; drag an object over the ground,
  Shift+drag to raise it, and turn or size it in the side panel. Scenes live in `data/scenes3d.json`; ☰ › **3D scenes**
  lists them, and the **Shots** step (MiniMax H3, H3 Reference) has a **🏞 3D scenes** panel with this project's scenes,
  ＋ New empty scene and From an Inputs picture. The camera and depth are estimates: sizes and distances are usually within about 10%.
  **Keyframes**: a timeline under the view (play, scrub, length up to 10 s on the H3 frame grid). Moving, turning or
  sizing an object at the playhead keys it there, so it moves along a smooth path through its keys (shown in yellow).
  The camera is keyed on purpose with **◆ Key the camera**: look around, key the view, move the playhead, key another;
  orbiting to look around doesn't change its path (shown in blue, with the camera at the playhead).
  **🎬 Render video…** makes the shot with MiniMax H3 the way Animate objects does (Time-to-Move): the page draws the
  scene's rough animation along its camera path at the picture's aspect, and a mask of what H3 should follow (the whole
  view when the camera moves, with the holes it opens left to H3; otherwise just the objects). H3 starts from the
  picture (when the scene starts as the picture) or from the scene's first frame, and goes on the timeline when it's
  done (unless you untick that). Needs what Animate objects needs. **Goes to** a shot instead (on the Shots step, a
  shot of the list or a new one): the shot keeps the drawn rough animation, its mask and the first picture, with the
  scene's text and length, and Generate on the Shots step makes it in order with the other shots (one video per shot).
  **Shots map to scenes**: a shot's Edit window (or 🎞 For a shot… on the panel) makes a scene from the shot's inputs
  (its keyframe or a reference picture its text names, or none; its length; the project's shape), or maps an existing
  one. That scene's Render then goes to its shot with the shot's What happens, `<Picture N>` becoming the object with
  that picture (📥 Inputs… on an object's Picture picks one from the Inputs step).
  A shot's scene shows **the shot camera as an object** (Camera › The camera as an object, for any scene): seen from
  outside, with its own gimbal (arrows move it, rings pan, tilt and roll it, each change keyed at the playhead), 👁 Look
  through it and ↩ Outside. A **floating position box** shows the selected object's or camera's X, Y, Z (and pan, tilt,
  roll and the camera's lens in mm) to read or type; drag it anywhere over the view. The lens is keyed with the
  camera: two keys with different lenses make a zoom.
  From outside, a moving camera's **dolly path** shows a dot each second and a faint camera at each key, and **📺 Preview
  what it sees** puts the camera's view at the playhead in a corner of the view while you scrub or play.
  Each camera key can **ease** to the next one (steady, ease in, ease out, ease in and out): choose it under the keys
  with the playhead on that key.
  **Focus and depth of field** (floating box): a keyed focus distance (⌖ On… an object; rack focus between keys) and
  an aperture (Off, f/1.4 to f/16), drawn from outside as the plane in focus and told to H3 and the first-frame photo.
  Looking through the camera, and in the corner preview, the view is **blurred by that depth of field** (View › Depth of
  field blur).
  **Camera shake** (floating box): a keyed amount (0 to 100 %) and a style (handheld, walking, vehicle, earthquake),
  added on top of the camera's path in the view, the preview and the render, and told to H3.
  **🏗 Crane move…** writes a jib move from the playhead (arm length, boom from/to, swing, aim, easing) as camera keys
  along the arc, and draws the rig from outside while it plays.
  **Generate** on the Shots step draws a mapped scene into its shot first when it isn't there or the scene changed, so
  the shot always follows the scene's camera; a Person without a picture takes the shot's `<Picture N>`.
  **Empty scenes** (☰ › New empty 3D scene) start from nothing: a floor with a 1 m grid, a sky colour and an optional
  backdrop picture, with the shot's shape and lens chosen in the View section; add 3D models and frame the shot.
  **📷 Generate photo…** (any scene) draws what the camera frames and has Qwen Image Edit 2511 (or MiniMax H3 Image)
  turn it into a photograph that keeps the layout. Its window has a field for what each object in view becomes ("a
  large pile of trash"); an object left empty keeps its look, except a Person, which becomes a real person. A Person with a picture is cut out of it (SAM 3) and pasted into the render in the mannequin's place before the edit model sees it, which then poses and blends them in, so no mannequin is left beside them. 🎬 Render video can start from such a photo (a new one of the first
  frame is made first, or an earlier one): the photo is painted onto the scene from its camera (projection mapping), so
  the rough animation H3 follows looks like the photo, and so does the video. Each moving object is first looked for in
  the photo (SAM 3, near its stand-in) and its path is moved and sized to start where the photo has it, so the real
  person walks off, not a grey mannequin, and the spot they leave is filled in, not left with a copy of them.
  **Tool bar and right-click menus**: add primitive shapes (cube, sphere, cylinder, cone, plane, ring) with a colour,
  a size in metres and a tilt, or a 3D model; choose what dragging an object does (move, raise, rotate, resize).
  Right-click an object to move, raise, rotate or resize it following the mouse, turn it 90°, size it up or down, set
  it on the ground, duplicate, rename, hide or delete it; right-click the ground to add a shape there. Keys: G, L, R,
  S, Shift+D, Del. Name a shape for what it should become (a wooden crate): 📷 Generate photo passes the names on.
  The selected object has a **gizmo**, as in Blender. Arrows move it along X, Y or Z. Rings turn it about each axis,
  using gimbal axes. Handles stretch it along its own axes, and the middle ball sizes all of it. Ctrl snaps. After G,
  R or S, press X, Y or Z to work along one axis. **Undo and redo**: ↶ and ↷ on the tool bar, Ctrl+Z and Ctrl+Y.
- **Objects in motion in a shot** (Shots › a shot's Edit window, One video per shot): give the shot a picture from the Inputs
  step and its objects' paths (the Animate objects window, in a "Use for this shot" mode). That shot then renders from the
  picture with the objects on their paths, with the shot's own text, length and settings; it can take a tracked path too.
- **🔄 Angles** (any picture: viewer, results menu or media library): re-shoot it from other camera angles with Qwen Image
  Edit 2511 and the multiple-angles LoRA. Pick directions × heights on a grid or a preset such as **24 head angles**, make a
  plain backdrop pure white, upscale each with SeedVR2, and put them in a new project. Needs `qwen_image_edit_2511` (bf16,
  fp8mixed, or a lightx2v fp8 file converted with `scripts/convert_lightx2v_fp8.py`), `qwen_2.5_vl_7b`, `qwen_image_vae`,
  `qwen-image-edit-2511-multiple-angles-lora` and, for 4-step speed, the 2511 Lightning LoRA.
- **✨ Enhance** (any finished picture or video: the viewer's button or the results menu): improve it with a chain, in order:
  **FaceRefine** (videos made with H3: tracks the main face and re-renders it with H3 Reference at a low denoise, using the
  video's own prompt, references and LoRAs, then stitches it back), **DLSS 5** (NVIDIA neural rendering, 1x look or 1.5–3x
  upscale), then **SeedVR2** (restore and upscale to 720p–2160p, 3B or 7B) or **RelayVSR ×2** (fast 2x video
  super-resolution). Settings › **Post-Processing** can run it on every new result (each step has its own Off). Needs the ComfyUI-H3-FaceRefine,
  ComfyUI-DLSS5-Enhancer and SeedVR2 custom nodes, and the RelayVSR model files; missing ones are greyed out. The window,
  Post-Processing and the Activity console estimate how long it takes, learning from your own runs.
- **Inputs** › reference pictures and sounds each have a **⋯** menu. Pictures: **Open** (a large view), **Edit…** (the
  image editor; saving swaps in the edited copy), **Describe with AI…** (a vision LLM, e.g. qwen3-vl, writes a detailed
  description, kept with the picture and marked ✨, which you can insert in the prompt or add to a shot as
  `<Picture N>: …`), **Remove**. Sounds: **Audio tools…** (remove music with Demucs, reduce background noise, remove
  rumble, even out loudness, volume, trim silence; every change plays back at once, with a Processed / Original
  switch, and **Save** swaps in the cleaned copy while the original file stays), **Remove**. Removing music needs the
  comfyui-demucs-voice-isolate nodes; the rest uses ffmpeg.
- **Subjects** (Shots step, H3 Reference): a detailed definition of who or what each reference picture is (face,
  eyes, hair, skin, marks, build, clothes), written by the vision model and editable. They go at the top of every shot's
  prompt's `subject_definitions` as `<Subject N>` so H3 keeps the subjects accurate; Generate writes any that are
  missing first.
- **Look, sound and music** (Shots step): changing one ✨ rewrites the shots to fit it (setting, light, weather,
  wording, camera) while keeping what happens, who is in it and every spoken line; ↶ Undo puts them back. During a
  render it waits for the render to finish. A switch under the fields turns it off.
- **Prompt format**: the Shots step writes prompts in MiniMax's official layout (Video Prompt Writing Guide). H3:
  `integrated_multimodal_description: [Shot 1] …` then `overall_soundscape:` and `non_diegetic_music:`. H3 Reference
  (full-reference mode): `subject_definitions`, `summary`, `retention_analysis`, `integrated_multimodal_description`
  (the guide calls this one `detailed_description` in reference mode), `overall_soundscape`, `non_diegetic_music`, with each reference picture a `<Subject N>`, each voice recording an
  `<Audio N>` voice-timbre reference, and speakers numbered `(S1)`, `(S2)`… The H3 output passes minimax-h3-tools'
  prompt lint; for H3 Reference it flags the main field's name, which is used here by choice.
- **Shots** (video, after Inputs): every H3 and H3 Reference video is planned here, shot by shot (video has no Prompt
  step). The shots are compact blocks: drag one to reorder, **⋯** for Edit, Move up/down, Duplicate and Delete, or
  double-click to edit. **Edit** opens a large window with the shot's length, framing, angle, camera position and move,
  where, what happens (hover a **Picture N** chip to see that picture; click it to open the Inputs step), a spoken line
  with who says it (a reference picture) and a voice, **✨ Write / 🪄 Enhance** for this shot from a one-line brief at a
  Creativity level, a title and notes, *Write the prompt myself*, and the exact prompt it sends. Inputs and Settings are the project's: the Inputs step's
  first frame starts shot 1 and its last frame ends the last shot. **✨ Write the shots from an idea** fills the whole list. A new
  project starts with one shot; Generate makes **One video per shot** (several shots go on the timeline in order) or
  **One multi-shot video** (H3's `[Shot 1] … [Shot 2] At 00:03.000, …` format). Older projects that used the Prompt step
  open with that prompt as shot 1's own prompt. **Add to timeline when done** (beside the mode buttons, on by default)
  puts each finished video at the end of the timeline; with takes, the first good take.
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
- **Live model view** (under the prompt, every model): as you type, the prompt is tidied for the selected model and
  checked. FLUX and Krea lose weights like `(word:1.2)` and filler such as "masterpiece, 8k"; H3 dialogue gets
  `[English]`; notes flag negations for H3, `<Picture N>` tags beyond the references you added, a missing camera move
  or sound, and overlong prompts. H3 shot lists (`[Shot N] At 00:SS.mmm, …`) are checked against the clip length:
  shots are renumbered and times written on whole frames; start times past the clip's end or out of order, spoken
  words that don't fit a shot (about 2.5 a second), very short shots, too many shots, and missing
  `overall_soundscape:` / `non_diegetic_music:` lines are flagged. **What the model gets** shows the exact text Generate sends (Tidy can be turned off).
- **✨ Live rewrite:** after a short pause in typing, a local LLM rewrites the prompt in the selected model's own format
  (a natural-language paragraph for FLUX and Krea, a style line plus `[Shot N]` lines and sound for H3, a style
  caption for Music 3) and streams it in under the prompt; **Tab** accepts it (Ctrl+Z undoes), **Esc** dismisses it.
  Template parts survive the rewrite. The rewrite also fixes what the live model view flagged (negations, missing
  `<Picture N>` references, camera move, sound lines, shot timing…), with a second pass for anything left, and says how
  many it fixed. Tidy tags untagged H3 shot lines `[Shot N]` and puts quoted speech in `<d>[English] …</d>`. The live rewrite has its own LLM choice next to its switch: **Auto** uses a small
  fast model (`qwen3:4b-instruct`, else `llama3.2:3b`, `gemma3:4b`…) for image and music prompts and the Prompt writer's
  default for H3 shot lists. It loads while you type and is unloaded when a render starts; live rewrites pause while
  one runs.
- **Prompt toolbar** (over the prompt): reference pictures as thumbnails (H3 Reference, H3 Image) and voices (🔊, H3
  Reference) insert `<Picture N>` / `<Audio N>` at the cursor; this prompt's tags; **🏷 Presets**; and **📚 Insert
  saved…**, which inserts a catalog prompt's text at the cursor and adds its tags.
- **✍ Shot writer** (H3 models; the Prompt tab's switch, Alt+W): the Prompt Writer now lives in the Prompt tab. Build
  the shot list field by field or let the LLM fill what you leave open; once it's complete it fills the prompt as you
  go (Undo brings your text back). **↗ Pop out** opens it in its own window. The side panel widens while the Shot
  writer shows (760 px; drag the splitter to change it, remembered apart from the usual width).
- **Voices go with pictures** (H3 Reference): `<Audio N>` is the voice of the person in `<Picture N>`. The Shot writer
  writes spoken lines as “They say, in the voice of <Audio N>:” for the person tagged in the shot, the live rewrite
  pairs them the same way, the live view flags a sentence that gives `<Picture 2>` the voice `<Audio 1>`, and a prompt
  without `<Audio>` tags gets a lead sentence that pairs them. The Shot writer shows each picture's voice under it
  (🔊 Audio N and the recording's name, or “no voice”); click it to insert the tag.
- **Duration check** (H3 video, H3 Reference): the live view and the Shot writer show how long the prompt needs (about
  2 s per shot to read, spoken lines at 2.5 words a second, timed shots from their start) against the clip length,
  warn when it may be cut off or needs more than H3's 15 s, and offer **Use N s** to set Duration. The Writer pane beside the viewer is gone.
- **Prompt tags and templates:** **+ Tag** adds a named value to the prompt, used as `<name>` or `{{name}}`; several
  values give one at random each Generate (the same one everywhere in the prompt). `{a|b}`, `{3::a|b}`, `<maybe p="0.3">…</maybe>`
  and `<list count="2">a, b, c</list>` roll too. **🏷 Presets** inserts ready-made words (hair, outfits, lighting,
  camera…) or `<category/>` for a random one (`data/tag_presets.json`). Tags are saved with the project.
- **📚 Catalog:** saved prompts with their tags, grouped by model, with search. Use one, save the current prompt (or
  update the one you loaded), delete. **Import from the Prompt Explorer node** copies the ComfyUI node's library in
  once. The catalog is Bob's own (`data/prompt_library.json`).
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

- **Qwen gap fill** (3D scene render from a photo): where the camera move shows what the photo never saw, Qwen
  paints the place in from a few wide views along the move, painted onto the scene under the photo (`fillGaps` in
  `static/scene3d.js`).
- **Bob Studio V2** (`/v2`, `static/v2.html`, `static/v2.js`): shot by shot in a 3D scene. The scene builder is
  the main view, each shot has its setting, action, dialogue, sound and music, and the model is chosen from what's in
  the shot. The shots line up on a timeline.
  Its object library (🧱 Objects) holds people, props and 3D models with their pictures and LoRAs, to drag into a
  shot's scene.
  Its camera library (🎥 Cameras) has ready-made moves worked out round the shot's subject (orbit, push in, crane,
  dolly zoom, follow…) and the cameras you save from shots.
  Shots have dialogue lines (an object with a voice in the library speaks with it) and background sound, and a
  Music 3 soundtrack can run under the whole timeline.
- **3D scene templates**: ☆ Save as template keeps a scene (its set, objects, camera path, length and effects) to
  start new scenes from, in any project (⭐ From a template…; `POST /api/scenes/{id}/copy`).
- **MiniMax H3 Image, shot by shot**: its reference pictures on the Inputs step, and its pictures planned on the Shots
  step (one picture per shot: framing, angle, place, subject). A shot mapped to a 3D scene is a photo of what the
  scene's shot camera sees (`Scene3D.photoForShot` in `static/scene3d.js`), at the Settings step's aspect and quality.
- **🔎 Score** (a result's details): five checks of a finished picture or video, each 0 to 100 with reasons:
  prompt adherence (a vision model answers yes/no checks drawn from the prompt), reference identity (ArcFace face
  match), camera (against a 3D scene's camera move, or what the prompt says), visual quality (ratings and the defects
  it can point to) and settings (size, length, frame rate, sound). Measured in ComfyUI's Python (`app/score_worker.py`),
  judged with the Prompt writer's vision model (`app/score.py`).

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
- `app/model3d.py`: Make 3D (TRELLIS.2 picture to GLB), the list of 3D models, and 3D scenes (Depth Anything 3
  backgrounds); `static/model3d.js` is the models window and the GLB viewer (WebGL 2, no libraries), `static/scene3d.js`
  the scene window.
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
