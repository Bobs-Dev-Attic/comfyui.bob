# Changelog

All notable changes to Bob Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The current version lives in
`app/__init__.py` and is shown in the app's top bar and in `/api/status`.

## [0.68.0] - 2026-11-17

### Added
- **🎬 Animate objects** (motion layers): break a picture into layers of objects, move them along animated paths,
  and have MiniMax H3 render the shot. Open it from a picture's menu in the results or on the Inputs step.
  - **Objects:** find one by name ("the red car") or Pick and click it: AI select (SAM 3.1) makes a layer per
    object.
  - **Empty background:** one Erase of every object at once, for them to move over.
  - **Path:** move the scrubber and drag an object to key where it is then; size and flip are keyed the same way.
    Between keys it follows a smooth curve; the path shows as dots; ▶ plays the rough animation.
  - **Generate:** the studio draws the rough animation (the objects pasted along their paths over the empty
    background) and a mask of them, and H3 renders from the original picture with Time-to-Move holding the objects
    to their paths for the first steps, then letting H3 redraw them so they belong in the shot, with sound. Follow
    the path loosely, normally or tightly; edge freedom is set by object size (h3-motion's rule).
  - New engine `motion` (`app/motion.py`, `workflows.build_motion`): request fields `motion_plate`,
    `motion_layers` (each object's mask and its move, size and flip in every frame), `motion_hold`, `motion_edge`.
  - Needs [ComfyUI-vlo](https://github.com/PxTicks/ComfyUI-vlo) (0.3.1 installed on this machine) for
    `vloTimeToMove`; the method is PxTicks' [h3-motion](https://github.com/PxTicks/h3-motion), rebuilt here.

## [0.67.1] - 2026-11-17

### Fixed
- **A shot that continues without a cut uses its own framing and angle.** It used to keep the shot before's view
  ("the same camera and framing"), so a run of continued shots sat on one framing and lost its flow. Now, when the
  framing or angle differs from the shot before, the prompt has the camera travel there in one smooth, continuous
  move inside the same take (say from the wide shot to a low-angle close-up), and the shot's own camera line follows
  once it gets there ("Once it gets there, the camera slowly pushes in"). With the same framing and angle, it says
  so. The people, clothes, place and light still carry on from the last frame.

## [0.67.0] - 2026-11-17

### Added
- **Continue without a cut** (a shot's Edit window › From shot N, H3 Reference, One video per shot). The shot waits
  for the one before and carries it on as the same shot: the last 39 frames of that video, with their sound, are
  planted at the start of the new one and kept as they are, so H3 continues their motion and sound (😺NKD AV Latent
  Extend from ComfyUI-NKD-Basic-Tools, the method of EDITS-WITH-AI's extender). Those frames are dropped from the
  result, so on the timeline it follows the shot before seamlessly. Its last frame also goes in as the first-frame
  picture, and the prompt says the same shot carries on. If the shot before failed, it starts with a cut instead.
  A ↪ on the shot shows it continues; the Shots preview says so too.
- Generate requests take `continue_from` (a video to continue) and `overlap` (22, 39 or 56 frames).

## [0.66.0] - 2026-11-17

### Added
- **Carry each shot into the next** (Shots step, H3 Reference, One video per shot with two or more shots; on by
  default). The shots render one after another instead of all at once; from shot 2 on, the last frame of the shot
  before goes to H3 as a hidden reference picture (after the Inputs' pictures, so <Picture 1>, <Picture 2>… keep
  their numbers). The prompt defines it as the place of the previous shot (location, set dressing, light, time of
  day, colour grade, and the people's clothes, hair and props), cites it in the shot so H3 actually uses it, and says
  in the summary what happened in the previous shot. A failed shot hands on no frame; cancelling one stops the
  rest. A run waiting when the page closes carries on when it opens again. The Shots preview shows exactly this.
- A shot with no **Where** of its own keeps the place written in the shot before it, in words (H3 follows the
  written place more than a picture).

### Changed
- **One seed for all the shots of a run** (One video per shot): when the seed is random, one is picked and used for
  every shot, since the seed weighs a lot in what H3 makes.

Approach informed by EDITS-WITH-AI (the last frame as the last reference picture, its measured notes on H3) and
ComfyUI-Sonder-Editor (scene pictures as environment references with what to preserve).

## [0.65.0] - 2026-11-17

### Changed
- **A video's sound goes on the existing audio tracks.** Adding a video (by hand or with Add to timeline when done)
  no longer makes a new audio track for each one: its linked sound goes on the first audio track that's free at
  that time, so videos added one after another line up on V1 with their sound on A1. A new audio track is made only
  when every audio track already has sound there. This is now the default for every project, including ones saved
  with the old setting. Project settings › Sound goes on › "A new audio track for each video" brings back one
  track per video (stored as `"own"`; the old `"new"` reads as the new default).

## [0.64.0] - 2026-11-17

### Fixed
- **H3 Reference used the first voice for everyone.** Every video got all the reference sounds, so when only
  <Picture 2> spoke, H3 heard <Audio 1> first and tended to give her that voice (MiniMax's guide warns that similar
  voices can merge into one timbre). Now each video gets only the recordings it uses (each spoken line's voice, and
  any <Audio N> written in its shots or in the look, sound and music), renumbered from <Audio 1> in the prompt and
  in the request. A video where <Picture 2> speaks alone gets just her voice. A shot with nobody speaking sends no
  recordings; a multi-shot video with two speakers still sends both, each bound to its speaker. A shot with its own
  prompt still gets them all.
- A voice picked on a spoken line is now defined as that speaker's voice in subject_definitions, summary and
  retention_analysis (before, <Audio N> was always said to belong to <Subject N>).

## [0.63.0] - 2026-11-17

### Fixed
- **Timeline sound in browsers without AAC** (Avast Secure Browser, plain Chromium). These play the H.264 picture
  but can't decode AAC, the sound H3 videos carry, so every audio track was silent. The timeline now plays such a
  file's sound from an Opus copy the studio makes once and caches (`/api/media/audio`): straight away when the
  browser says it has no AAC, or as soon as it fails to play a file's own sound. Video clips that keep their sound
  on a video track are covered too.

## [0.62.0] - 2026-11-17

### Fixed
- **Silent timeline playback is safer and explains itself.** Sound only goes through the browser's audio mixer while
  that mixer is actually running; otherwise clips play directly, so a stopped audio device can no longer silence
  every track for the rest of the session. The preview also follows the system's default output when the device
  changes (headphones, Bluetooth).

### Added
- Two seconds into timeline playback, if clips that should be heard are silent, a note says why when it can: a
  soloed track (S) silencing the others, muted tracks or clips, the Master volume all the way down, or the
  browser's audio being stopped. Unexplained silence is written to the studio log with what the browser reports.

## [0.61.0] - 2026-11-17

### Added
- **Add to timeline when done**, a checkbox beside the "One video per shot" / "One multi-shot video" buttons on the
  Shots step (on by default, saved with the project). When it's on, a finished video goes at the end of the
  timeline's first video track: one shot or a multi-shot video as soon as it's done (with several takes, the first
  good take), several shots in order once all are done, as before. Turn it off to keep results in the bin only.

## [0.60.0] - 2026-11-17

### Added
- **↻ Rebuild** beside the prompt in a shot's Edit window: reads every field again and rebuilds the prompt, in case an
  edit wasn't picked up; it says whether it found anything the prompt had missed.

### Changed
- The prompt in a shot's Edit window follows every kind of edit, not only typing: shortly after any input, change,
  paste, cut, drop or key, the window reads all its fields back into the shot and rebuilds the prompt (so a paste from
  the right-click menu, drag and drop or autofill can't leave it stale). A brief highlight shows when it changes.

## [0.59.0] - 2026-11-17

### Fixed
- **Prompt tags and { } choices now work in a shot's fields.** Where, What happens and Spoken line were sent exactly as
  typed, so `<hero>`, `{dawn|dusk}`, `<list>` and `<maybe>` reached H3 literally (only a shot with its own prompt was
  resolved). Now all three are filled in when the prompt is built, as on the Prompt step: the preview shows one roll,
  and each Generate rolls afresh, once for the whole video, so a tag picks the same thing in every shot and line while
  each { } choice is rolled on its own. `<Picture N>`, `<Audio N>` and `<Subject N>` pass through for H3.

### Changed
- **A larger Spoken line** in the shot's Edit window (a three-line box), with **Speaker** and **Voice** below it.
- What happens and Spoken line have chips for the reference pictures and your own tags, plus **＋ Tag** to make one
  (the tag editor from the Prompt step, which video no longer shows).

## [0.58.0] - 2026-11-17

### Added
- **A live log at the bottom of the Generate step**: the running generation (or the last one) with its status,
  progress bar and every log line as it happens (building the workflow, sending it, each sampling step, saving), the
  same lines as the Activity console; **Activity…** opens the console on it.

### Fixed
- **The Generate step's Shots row shows the prompt exactly as Generate sends it**: the whole multi-shot prompt, or each
  shot's own prompt, in a scrolling box (it showed only the first shot's action before). When subject definitions are
  still missing it says the vision model writes them when you press Generate.
- Results, the queue, the Activity console, notifications, timeline clip names and the Enhance window name a result by
  its first shot's text instead of the start of its prompt, which now opens with section names such as
  `subject_definitions:`.

## [0.57.0] - 2026-11-17

### Added
- **The shots follow the look, sound and music.** When you change Look, Soundscape or Music on the Shots step (on
  leaving the field), the prompt writer rewrites every shot to fit: the place's light, time of day, weather and colours,
  the wording of the action and the camera. What happens, who is in it, the order and every spoken line stay as they
  are; shots with their own prompt are left alone. **↶ Undo** puts the shots back. If a render is running it waits for
  it to finish, so the LLM doesn't take the GPU. A switch under the fields turns it off (saved with the project).
  Example: two sunny-park shots became a rainy, neon-lit alley at night with the same girl, dog, ball and line, in 11 s.

## [0.56.1] - 2026-11-17

### Changed
- H3 Reference prompts call their main section `integrated_multimodal_description:` (as H3 prompts do) instead of the
  guide's `detailed_description:`. The other five sections are unchanged.

## [0.56.0] - 2026-11-17

### Changed
- **Shot prompts use MiniMax's official H3 prompt layout** (the Video Prompt Writing Guide; checked clean with
  minimax-h3-tools' prompt lint):
  - **H3 Reference** (full-reference mode) now has its six sections:
    `subject_definitions:` (`<Subject 1> is the subject of <Picture 1>: …` per picture, and `<Audio 1> is the
    voice-timbre reference for <Subject 1> (S1).` per voice), `summary:` (`[reference generation + audio reference]
    …`), `retention_analysis:` (where each subject appears, `fully_preserved`; each voice `reference`),
    `detailed_description:` (the look, then `[Shot 1] …` with `<Subject N>` in place of `<Picture N>`, and
    `<Subject 1> (S1) says, using the voice timbre referenced from <Audio 1>: <d>[English] …</d>`),
    `overall_soundscape:` and `non_diegetic_music:`.
  - **H3** prompts now start `integrated_multimodal_description: [Shot 1] <look> …`, with speakers numbered `(S1)`,
    `(S2)`…, then `overall_soundscape:` and `non_diegetic_music:`, each set apart by a blank line (the keyframe line,
    when there are keyframes, still goes first).
- The Subjects switch now chooses whether `subject_definitions` carries the detailed definitions or a plain line per
  picture.

## [0.55.0] - 2026-11-17

### Added
- **Subject definitions in H3 Reference prompts.** Shot prompts now define each reference picture's subject after the
  style line, one line each: `<Picture 1>: a woman in her late twenties, …`. A new **Subjects** section on the Shots
  step shows each picture with its definition (edit it freely), **✨ Describe** per picture, **✨ Describe the missing
  ones**, and a switch to leave them out. **Generate defines any missing subject first** with the vision model, so a
  prompt never goes out without them (if it can't, it says so and generates without). A shot with its own prompt gets
  the definitions after its first paragraph.
- ✨ Write for a shot is told who is who, so it keeps people and their clothes straight.

### Changed
- **Describe with AI writes subject definitions**: as much detail as an accurate video needs (about 70–170 words):
  apparent age, build, face shape, eyes, eyebrows, nose, lips, skin tone and texture, distinctive marks, hair, and what
  they wear (or that they wear nothing), or an animal's or object's kind, materials, colours and markings. It leaves out
  the photo's own background, light, pose and camera, which each shot sets; a picture of a place or a style is still
  described as one, with its light and palette.

## [0.54.0] - 2026-11-17

### Added
- **Live preview** (Settings › Advanced): **On** shows the first frame forming on the running result and in the viewer,
  once per sampling step, so you can stop a take that's going wrong. It's ComfyUI's latent colour sketch: soft, but
  you can read the scene. Measured on a 3 s draft H3 video: 28.9 s with or without it, 8 previews. Remembered per browser.
- The studio now starts its ComfyUI API proxy through `app/proxy_launch.py`, which lets a job's preview setting
  through to ComfyUI (the proxy otherwise only accepts an API key there). If an older proxy refuses it, the run goes
  ahead without a preview.

### Notes
- A sharper preview with the TAEH3 tiny decoder isn't offered: ComfyUI 0.44 can't load `taeh3.safetensors` for
  previews, and asking for it makes the sampler fail.

## [0.53.0] - 2026-11-17

### Added
- **A ⋯ menu on each reference picture** (Inputs) in place of its ×:
  - **Open**: the picture in a large window, with its description.
  - **Edit…**: the image editor; saving swaps the edited copy in as that picture (it's also kept in your results).
  - **Describe with AI…**: a vision model (the Prompt writer's LLM, e.g. qwen3-vl; with Auto, the first that can see
    pictures) writes a detailed description: the subject, face, hair, clothes and pose, or an object's materials and
    colours, then light and camera view. Edit it, **Copy** it, **Insert in prompt** (pictures and sound) or **Add to
    shot** (video) as `<Picture N>: …`. It's kept with the picture (a ✨ on the tile; saved in the project).
  - **Remove**.
- **A ⋯ menu on each reference sound** with **Audio tools…** and Remove. Audio tools: **Remove music** (keep only the
  voice, with Demucs in ComfyUI; done once per file, about 8 s for a short clip), **Reduce background noise** (0–100%),
  **Remove rumble** (below 80 Hz), **Even out loudness**, **Volume** (±12 dB) and **Trim silence**. Every change plays
  back within a moment, keeping your place; **Processed / Original** compares the two. **Save** replaces the sound
  with the cleaned copy; the original file is kept.

## [0.52.0] - 2026-11-17

### Changed
- **Post-Processing on the Settings step** replaces *After generating* and its *Enhance settings…* window: a collapsible
  section like Advanced, its summary line showing what runs (or Off). Its steps are right there: **1 · FaceRefine**,
  **2 · DLSS 5** (Off or a mode) and **3 · Upscale** (Off, SeedVR2 or RelayVSR ×2), each with its options when on.
  Each step has its own **Off**; with every step off no enhanced file is made, so the *Nothing more / Enhance each
  result* switch is gone. The section estimates how long the chain adds per result, and is hidden for sound.
  Your earlier choice carries over: *Enhance each result* keeps the steps you had; *Nothing more* starts with all off.
  The ✨ Enhance… window on a result keeps its own last choices.
- **Diffusion model, Sampling (sampler and scheduler), Steps and CFG moved to Settings › Advanced**, beside Seed and
  Takes. The Model step now only picks the model.

## [0.51.0] - 2026-11-17

### Added
- **Picture previews in a shot's Edit window**: hover a **Picture N** chip by *What happens* to see that reference
  picture; click the preview to go to the Inputs step. Clicking the chip still inserts the tag.

### Changed
- **The shot's Edit window no longer has Inputs or Settings sections.** Pictures, frames and settings live on the Inputs
  and Settings steps and apply to every shot: the Inputs step's first frame starts shot 1 and its last frame ends the
  last shot, every H3 Reference shot uses all the reference pictures, and quality, aspect, turbo, seed and steps come from
  Settings. Frames, picture choices or settings a shot had of its own are dropped when a project opens.
- A shot block's thumbnail is the first picture its action mentions (H3 Reference).

### Fixed
- Clicking the *What happens* heading no longer inserts a Picture tag (the chips were inside its label).

## [0.50.0] - 2026-11-17

### Added
- **Speaker for a shot's spoken line** (H3 Reference): in the shot's Edit window, pick which reference picture's
  person says the line. The prompt then reads “The person from <Picture 2> says, in the voice of <Audio 2>: …”.
  With Voice left on its default, the speaker's own recording is used (<Audio N> goes with <Picture N>, shown as
  “Speaker's · <Audio N>”); pick another voice to override it. ✨ Write is told who speaks, and the shot block's 🗣
  shows who says the line.

## [0.49.1] - 2026-11-17

### Fixed
- **Typing in a shot's Edit window works again.** Every key saved the project and rebuilt the window, which put the
  caret back at the start of the field, so words came out scrambled (most visibly in Camera position). The window now
  only rebuilds for changes to the shot list, and keeps the caret, the focused field and the scroll position when it does.

## [0.49.0] - 2026-11-17

### Changed
- **Video is planned on the Shots step.** For MiniMax H3 and H3 Reference the workflow is now Project → Model → Inputs →
  Shots → LoRAs → Settings → Generate; the Prompt step is for pictures and sound only. Shots is always on (no *Use
  shots* switch), and a new project starts with one shot made as **One video per shot**.
- **Shots are compact blocks**: a thumbnail, the shot's title, time and framing, and what happens. Drag a block to
  reorder (with more than one), use its **⋯** menu (Edit, Move up, Move down, Duplicate, Delete), or double-click it.
- Older projects open unchanged in effect: a project that made its video from the Prompt step gets that prompt as shot
  1's own prompt; one that used shots keeps them.

### Added
- **The shot's Edit window**: everything about one shot in a large window, with ‹ › (Alt+←/→) to step through shots.
  - **✨ Write / 🪄 Enhance** this shot from a one-line brief, at a Creativity level, with the shot before it as
    context so people and places carry over; **↶ Undo** puts the fields back.
  - Length, framing, angle, camera position and move, where, what happens (with Picture tags), spoken line and voice.
  - Inputs: the shot's first and last frame (shot 1 and the last shot use the Inputs step's frames when they have none
    of their own) or which reference pictures it uses.
  - **Settings for this shot only**: quality, aspect, turbo, seed and steps; blank uses the project's Settings.
  - **Write the prompt myself**: the shot sends your text instead of the fields.
  - A title (shown on the block) and notes, and a live preview of the exact prompt the shot sends.
- **✨ Write the shots from an idea** on the Shots step: an idea, a number of shots and a length become a full shot list
  (plus the look, sound and music when those are empty).
- The Generate step's summary shows the shots (count, length, how they're made) and flags empty ones; Generate stops on
  an empty shot and says which.

## [0.48.1] - 2026-11-17

### Fixed
- **Moving Creativity in the Prompt tab now changes the rewrite.** Before, the slider only took effect on the next
  ✨ Rewrite or the next edit to the prompt, so the suggestion on screen stayed the same. Now, when you let go of the
  slider, the prompt is rewritten again at the new value (with Live on, or while a suggestion is showing), and the
  suggestion says which creativity wrote it (e.g. "· 100% Wild").

## [0.48.0] - 2026-11-17

### Added
- **The studio keeps itself up to date** (Settings › Updates). Every few minutes it checks GitHub's main branch;
  when there's a newer version and nothing is rendering, it installs it (and any new Python packages), restarts in a
  new console window, and the page offers **Reload**. Choose *Install it automatically* (the default), *Tell me; I'll
  install it* (with an **Update and restart** button), or *Don't check*, and how often to check.
- It never overwrites anything: a copy on another branch, with edits of its own to the studio's files, or with
  commits that aren't on GitHub isn't updated, and Settings › Updates says why.

## [0.47.0] - 2026-11-17

### Added
- **✨ Rewrite and Creativity in the Prompt tab's model panel** (the box under the prompt, e.g. “H3 Reference”, and the
  same for every model with a rewrite). Rewrite reshapes the prompt for the model right away, even with Live off; Tab
  or Accept takes it, Ctrl+Z brings yours back. Creativity (0–100%, Literal to Wild) sets how far the rewrite may go
  beyond what you wrote; it also applies to the live rewrite and to ✨ Write for me, and is remembered.

### Changed
- The live rewrite toggle is now labelled **Live**. It follows the Creativity setting (25%, Faithful, by default:
  close to how it rewrote before).

## [0.46.0] - 2026-11-17

### Added
- **Creativity for the H3 Shot writer** (0–100%, with Literal, Faithful, Enhanced, Bold and Wild presets). It tells
  the LLM how far it may go beyond your idea, from "film exactly what it says" to "reinterpret it as a surprising
  concept", and sets how freely it samples. Your locked fields are always kept as written.
- **🪄 Enhance** in the Shot writer: improves the shot list as it is now at the chosen creativity, instead of
  writing it again from the idea.
- **Camera angle and camera position for each shot** (Shot writer and the Shots step). The prompt now says where the
  camera is, e.g. “[Shot 1] Low-angle wide shot. … The camera is behind her at shoulder height and tracks her up the
  stairs.”, which H3 follows far better than a move alone. The LLM picks them, varies them between shots and keeps
  screen direction consistent. Both are optional: older shot lists build the same prompt as before. The live rewrite
  for H3 and H3 Reference uses the same format.
- **Z** switches the result viewer between Fit and 100%.

## [0.45.0] - 2026-11-17

### Added
- **Zoom control on the result viewer** (top right, for pictures and videos): − / **Fit** / +. Click **Fit** to switch
  to actual size (100%) and back. In Fit the result scales with the viewer; a fixed zoom keeps its size and scrolls
  (drag to move). The mouse wheel zooms at the pointer for videos now too. The choice is kept for the next result.

### Fixed
- **A result video didn't shrink when the bar above the timeline was dragged up**: it kept its height and was cut
  off. It now fits the viewer at any size, like pictures.

## [0.44.0] - 2026-11-17

### Changed
- **The selected result's details no longer take space under the viewer.** Its stars, facts (engine, size, steps,
  seed, time) and the Cancel and ＋ Timeline buttons sit in the viewer's header; the prompt, tags and all the other
  buttons (Reuse settings, Re-roll, Edit, Download, Workflow, Delete…) drop down over the top of the viewer with
  **ℹ Details** or **Alt+I** (Esc inside it closes it). The viewer keeps its full height, so the top section can be
  made smaller to give the timeline more room. Whether the panel is open is remembered.

## [0.43.2] - 2026-11-16

### Fixed
- **Every job with an input file failed with “Prompt outputs failed validation”** (H3 Reference pictures and voices,
  keyframes, enhance, editor edits) since 0.33.0. Saving the workflow for “View workflow” renamed each input in the
  same graph the ComfyUI SDK sends, replacing the upload with a bare file name that ComfyUI never received. The saved
  copy is now a separate one.
- A workflow ComfyUI refuses now says which node failed and why (e.g. “LoadImage #7: Invalid image file …”), and the
  full details go to the server log, instead of only “Prompt outputs failed validation”.

## [0.43.1] - 2026-11-16

### Fixed
- **Generate did nothing in a project with a LoRA at a strength like 0.75.** The LoRA strength box only allowed steps
  of 0.1, so the browser counted 0.75 (which the slider can set) as invalid and silently refused to submit the form;
  the box is on the LoRAs step, so it couldn't even point at it. The form no longer leaves validation to the browser
  (Bob checks the values itself), and LoRA strengths go in steps of 0.05.

### Added
- Generate presses (sent, stopped and why, refused) and page script errors are written to the server log, to find
  the cause when Generate seems to do nothing.

## [0.43.0] - 2026-11-16

### Added
- **The Shot writer shows which voice each picture uses** (H3 Reference): under each reference picture, “🔊 Audio N”
  with the recording's name (click to insert `<Audio N>`), or “no voice” when that picture has none; voices beyond the
  pictures are listed as for whoever else speaks.

### Fixed
- **Generate could do nothing visible.** In the Shot writer, a finished shot list that hadn't been edited since it
  was restored never reached the prompt, so Generate sent an empty prompt; the server's error showed only on the
  Generate step, out of sight when Generate was pressed from the Prompt tab (the top Generate button or Ctrl+Enter).
  - Generate now takes the Shot writer's shot list when it's showing; an incomplete one says how many fields are
    empty instead.
  - An empty prompt is caught before sending: Bob goes to the Prompt step and says so.
  - Any error from Generate also shows as a message wherever you are.

## [0.42.0] - 2026-11-16

### Changed
- **H3 Reference pairs voices with pictures by number: `<Audio N>` is the voice of the person in `<Picture N>`.**
  - **Shot writer:** the LLM is told the pairs, and a shot's spoken line becomes “They say, in the voice of
    `<Audio N>`:” for the first person tagged in its action who has a voice.
  - **Live rewrite:** told the same pairs, and writes lines as “The woman from `<Picture 1>` says, in the voice of
    `<Audio 1>`: `<d>…</d>`”.
  - **Live view:** flags a sentence that pairs `<Picture N>` with another number's voice (the rewrite fixes it).
  - **Generate:** a prompt without `<Audio>` tags gets a lead sentence pairing each voice with its picture (voices
    beyond the pictures are for whoever else speaks), instead of “the matching voice”.

### Fixed
- The live rewrite keeps spoken lines (`<d>…</d>`) word for word; it could drop them.

## [0.41.0] - 2026-11-16

### Added
- **Duration suggestion for H3 video and H3 Reference.** The live model view (and the top of the Shot writer) shows
  how long the prompt needs against the clip, e.g. “⏱ needs ~6.4 s of 5.2 s”: about 2 s per shot, spoken lines at
  2.5 words a second, and timed shots from their start time.
  - **May be cut off** when it needs more than the clip, with **Use N s** to set Duration (rounded so H3's frame grid
    still covers it); a tip when the clip is 4 s or more longer than needed; a warning when it needs more than H3's
    15 s.
  - The live rewrite gets the “cut off” warning as a problem to fix (fewer shots, shorter lines).

### Changed
- **The side panel widens while the Shot writer is open** (760 px by default) and goes back to its usual width on
  other steps or in ✏ Prompt. Dragging the splitter changes the width that's showing; both are remembered.
- The “spoken words won't fit” note for prompts without shots is now part of the duration check.

## [0.40.0] - 2026-11-16

### Added
- **The live rewrite fixes what the live model view flags.** The problems go to the LLM as concrete instructions
  (reword these negations as what is there; only these `<Picture N>` tags exist; add a camera move; add the sound
  lines; fix these shot times…), together with the references you've added. If anything is still flagged, a second
  pass rewrites the result once more. The suggestion says how many problems it fixed and lists what's left.
- **A toolbar over the prompt.** For H3 Reference and H3 Image: your reference pictures as thumbnails (and voices for
  H3 Reference) that insert `<Picture N>` / `<Audio N>` at the cursor, plus **+ Reference** to add more. For every
  model: this prompt's tags, **+ Tag**, **🏷 Presets**, and **📚 Insert saved…**, which inserts a catalog prompt's
  text at the cursor and adds its tags (keeping yours when a name is taken).
- **Tidy for H3 shot lists:** shot lines without their tag get `[Shot 1]`, `[Shot 2]`…, and quoted speech after
  says / asks / whispers… goes into `<d>[English] …</d>`.

### Changed
- **The Prompt Writer moved into the Prompt tab** as the **✍ Shot writer**, next to **✏ Prompt** (H3 models; Alt+W
  switches). A complete shot list fills the prompt as you build it, with Undo to get your text back; **↗ Pop out**
  still opens it in its own window. The Writer pane beside the viewer and its ✍ Writer button are gone.

## [0.39.0] - 2026-11-16

### Added
- **H3 shot-list checks in the live model view** (H3 video and H3 Reference), against the clip length in Settings and
  updated as it changes:
  - Put right: shots numbered 1, 2, 3… in order; start times written as `00:SS.mmm` on whole frames.
  - Flagged: a shot with no start time (with a suggested one), start times after the clip's end or not going up,
    more spoken words than fit a shot (about 2.5 a second), shots under a second, more shots than the clip has room
    for, and a missing `overall_soundscape:` or `non_diegetic_music:` line.
  - Without a shot list, spoken words are checked against the whole clip.
- H3 sound prompts are checked for their `overall_soundscape:` and `non_diegetic_music:` lines.

## [0.38.0] - 2026-11-16

### Added
- **A model choice for the live rewrite**, next to its switch, separate from the Prompt writer's. **Auto** (the
  default) uses a small fast model for image and music prompts (`qwen3:4b-instruct` first, then `qwen3:4b`,
  `llama3.2:3b`, `gemma3:4b`, `qwen3:1.7b`) and the Prompt writer's default for H3 shot lists, where small models break
  the format. It shows which model it picked.

### Changed
- **Live rewrites start about three times sooner**: the first words show about 0.2 s after the pause instead of
  0.6 s. Bob no longer asks the LLM server for its model list on every rewrite (that took most of the time; a warm
  model answers in about 0.03 s), and the pause before a rewrite is 0.6 s instead of 0.85 s.
- Every model warmed for the live rewrite is unloaded when a render starts, not just the last one.

## [0.37.0] - 2026-11-16

### Added
- **Live model view in the Prompt step.** As you type, the prompt is tidied for the selected model and checked:
  weights like `(word:1.2)` and filler words come out for FLUX 3 Klein and Krea 2, H3 dialogue gets `[English]`, and
  notes flag what the model handles badly (negations for H3, `<Picture N>` beyond the references, no camera move or
  sound, tag lists for sentence models, overlong prompts). **What the model gets** shows exactly what Generate sends.
- **✨ Live rewrite.** After a short pause in typing, a local LLM (Ollama or an OpenAI-compatible server, the Prompt
  writer's choice) rewrites the prompt in the selected model's own format and streams it in under the prompt. Tab
  accepts (Ctrl+Z undoes), Esc dismisses, ↻ asks again. With the model warm the first words show in about half a
  second.
  - The LLM loads when you start typing and stays loaded for a few minutes; it's unloaded when a render starts, and
    live rewrites pause while one runs.
  - Template parts (`{a|b}`, `<preset/>`, prompt tags) survive the rewrite; anything it drops is added back on accept.
- **Prompt tags and templates**, as in the Prompt Explorer node: named values used as `<name>` or `{{name}}` (several
  values: one at random, the same throughout the prompt), plus `{a|b}`, weighted `{3::a|b}`, `<maybe p="…">`,
  `<list>` and `<category/>` from the presets. Each Generate rolls them again. Tags are saved with the project.
- **🏷 Tag presets**: ready-made words by category (hair, outfits, lighting, camera, mood…), filterable; tick and insert,
  or insert a random pick.
- **📚 Prompt catalog**: Bob's own library of saved prompts and their tags, grouped by model, with search; use, save,
  update and delete. **Import from the Prompt Explorer node** copies that node's library in once.

## [0.36.0] - 2026-11-16

### Added
- **Feather for selections in the image editor** (Select + AI). A **Feather** slider (0–100 px) softens the edge of
  new selections from the shape tools, the lasso, the magic wand and AI select, so Erase, Replace and prompt edits
  blend into the picture. **Feather now** softens the current selection by that amount (undo takes it back).
  - The orange tint fades across the soft edge; the marching ants run along its halfway line.
  - A selection that reaches the picture's border stays solid there instead of fading out.

## [0.35.0] - 2026-11-16

### Added
- **✏ Edit in the Media Library.** Any picture there opens in the image editor: from its right-click menu, its preview
  window, or the selection bar when one picture is picked. Saves and AI edits become results of the open project; the
  library file itself isn't changed.
- **Selection tools in the image editor** (Select + AI): **Rectangle**, **Square**, **Ellipse**, **Circle**, **Lasso**
  and **Magic wand**, next to AI select, Brush and Eraser.
  - **Marching ants** outline the selection in every tool but Crop (they stand still with Reduce motion on).
  - New, **Add**, **Subtract** and **Intersect** choose how a new selection combines with the current one; Shift adds,
    Alt subtracts and Shift + Alt intersects for one selection.
  - The magic wand selects the area of similar color around the clicked pixel, with a **Tolerance** (0–255) and a
    **Contiguous** switch (off: that color anywhere in the picture).
  - While dragging a shape its size shows next to it; a click without dragging deselects.
  - Shortcuts: M rectangle, O ellipse, L lasso, W magic wand, Ctrl+A select all, Ctrl+D deselect, Ctrl+Shift+I invert.

### Changed
- The selection's orange tint is lighter, so the ants read better.

## [0.34.0] - 2026-11-16

### Added
- **LoRA check when the model changes.** Switching to another model shows a window when that leaves LoRAs made for a
  different model, for example H3 LoRAs on Krea 2. It lists each one (what it's for, its strength) and offers **Remove
  them** or **Keep them**.
  - It asks only when the change creates a new mismatch: not again when the LoRAs didn't fit the previous model
    either, and not for LoRAs whose model can't be told from the file.
  - It also runs when **→ Reference**, **→ First/Last frame** or **Switch to H3 Reference** change the model.
  - The Generate step's summary has a **LoRAs** row that flags mismatches ("⚠ 2 made for another model").

## [0.33.0] - 2026-11-16

### Added
- **Steps and CFG on the Model tab**, under Sampler and Scheduler. Steps moved here from Settings › Advanced. Empty
  means the engine's own value, shown in the box.
  - **CFG** applies to Klein, Krea 2, H3 Image and Music 3. H3 and H3 Reference have no CFG in their templates (a
    BasicGuider with no negative); a value there switches to a CFG guider with an empty negative, like ComfyUI's CFG
    workflows. That runs about 2× slower.
  - **H3 Image** steps can now be changed too (it stays 6 by default; other counts interpolate its distilled schedule).
  - Both are saved with the project and restored by Reuse.
- **{ } Workflow** (results viewer): the exact ComfyUI workflow, in API format, that a result was made with.
  - It shows the sampler, scheduler, steps, CFG and seed, plus every model file used, and the full JSON to copy or
    download.
  - Drag the downloaded file onto ComfyUI to load it, or compare it with your own workflow when results differ.
  - Saved in `data/workflows/` for new results (`GET /api/items/{id}/workflow`); deleting a result deletes its copy.

## [0.32.1] - 2026-11-16

### Changed
- **Model tab:** the selected model's card now has a light accent-tinted background, like the open step tab, so it
  stands out more. It follows every theme and accent.

## [0.32.0] - 2026-11-16

### Added
- **Sampler and scheduler on the Model tab.** Below the Diffusion model picker, **Sampling** has a Sampler and a
  Scheduler list. Both use ComfyUI's own names (KSampler's lists, so custom samplers show up too).
  - **Default** keeps what the model's ComfyUI template uses: res_multistep with simple for H3; simple with turbo and
    beta without for H3 Reference; euler with simple for Klein, Krea 2, H3 Image and Music 3.
  - The choice is kept per engine, saved with the project, shown in the Generate summary, and restored by Reuse.
  - Picking something else on a distilled model (H3 turbo, Krea 2 Turbo, H3 Image) shows a warning, because those
    models are tuned for their own schedule.
  - API: generation requests take `sampler` and `scheduler`. An unknown name is refused, and other engines ignore
    them (editor, enhance, angles and reshoot keep their tuned sampling). `/api/capabilities` lists `samplers`,
    `schedulers` and `sampling_defaults`, and a result's info records what it used.

## [0.31.0] - 2026-11-16

### Added
- **Media library: select several items, and delete.**
  - **Selecting:** every tile has a check circle, shown on hover and on all tiles once anything is selected. Click it
    to add or remove that item. **Select all** is in the status bar and the selection bar. Ctrl+click, Shift+click and
    Ctrl+A still work.
  - **🗑 Delete…** (selection bar, right-click menu, Shift+Delete, or Delete outside the Library view) moves the
    selected files to the **Windows Recycle Bin**, where they can be restored. Results made from them leave the
    gallery, and they leave this project's library. Other projects that use them show them as missing. Delete in the
    Library view still only removes items from the library (Remove); the files stay.
  - API: `POST /api/media/delete` `{refs, project}`. Without a Recycle Bin (not on Windows), only the studio's own
    uploads and results can be deleted.

## [0.30.0] - 2026-11-16

### Added
- **Rename and delete the open project** from the project card (**✎ Rename…** and **🗑 Delete…**) or the ☰ menu.
  - **Rename** saves pending changes, then renames both the project and its folder.
  - **Delete** asks first, then moves the project's folder (settings, timeline, library and versions) to the projects
    trash (`projects\.trash`), where it can be recovered by hand. Its generated results stay in the gallery under
    **All**. The studio then switches to Experiment.

### Fixed
- Deleting the open project (here, or from the Explorer) no longer tries to save pending settings or timeline
  changes into the deleted project.

## [0.29.1] - 2026-11-16

### Changed
- **Side step tabs.** The open step's tab now has an accent-tinted background, with a slim accent triangle on its
  edge pointing at the panel it opens, in place of the accent bar. The other tabs have a subtle gray background, and
  hovering darkens it a little. On narrow screens the triangle points down. It follows every theme and accent.

## [0.29.0] - 2026-11-16

### Added
- **MiniMax H3 Image engine** (Image tab). MiniMax's image model makes pictures from text in 6 distilled steps at
  1, 2 or 4 MP (Draft, Standard, High). It can take up to 9 reference pictures, named `<Picture 1>`, `<Picture 2>`…
  in the prompt. It runs the way ComfyUI's "MiniMax-H3-Image: Text to Image" template does, uses the H3 Image
  diffusion model and VAE plus H3's Qwen3-VL 32B text encoder, and takes H3 LoRAs. Steps are locked at 6.
- **☰ Menu** left of "Bob Studio": Settings, theme and colors, project versions, project settings, a new project, and
  About.
- **Settings window** (the menu, or Ctrl+,): a modal with sections for Appearance, Projects, Generation, Image editor,
  Settings file and About. Changes apply at once and are saved to `data/settings.json`. The file is validated (a bad
  value is refused with a message), and the window can edit the JSON directly, export it, import it or reset it.
  - **Color themes:** System, Dark, Light, Midnight, Graphite, Forest, Paper and High contrast, plus 8 accent colors
    (the favicon follows the accent), text size and reduce motion. The page starts in the saved theme, with no flash.
  - **Projects:** versions to keep (5–500, default 30), how often an automatic version is kept (15 s to 1 h, default 1
    minute), a version of every project at startup, and reopening the last project.
  - **Generation:** a chime and/or a desktop notification when a job finishes, and asking before deleting a result.
  - **Image editor:** the default edit model. The editor's picker now saves it here instead of in the browser.
- **Project versions with tracked changes.** The Versions window (formerly "Earlier versions") lists each version
  with what changed since the one before: the prompt, the model, settings, clips added, removed or changed, library
  items, tags, notes, and project settings. The top row shows what changed since the last version.
  - **Save a version** keeps the current state under a name, such as "Before the new ending". Named versions are
    never pruned.
  - Any version can be named, renamed, deleted or restored. A restore first keeps the current state as a named
    version ("Before going back to …").
  - API: `POST /api/projects/{id}/versions` with a `label`, `PUT` or `DELETE /api/projects/{id}/versions/{file}`, and
    `GET`, `PUT`, `POST …/import` and `POST …/reset` on `/api/settings`.

### Fixed
- Versions are ordered by when they were kept. On Windows the copy kept the project file's own modified time.
- Restoring a version whose settings were empty (a new project's first version) left the current form on screen,
  where autosave could write it back over the restore.

## [0.28.0] - 2026-11-16

### Added
- **MiniMax H3 Image in the image editor.** The Select + AI panel has an **Edit model** choice for Erase, Replace and
  whole-picture edits:
  - **Qwen Image Edit 2511:** 4 steps with the Lightning LoRA. It's the fast one and stays the default.
  - **MiniMax H3 Image:** MiniMax's image model, run the way ComfyUI's "MiniMax-H3-Image: Image Edit" template runs it
    (6 distilled steps, cfg 1). It uses the H3 Image diffusion model and VAE, plus the Qwen3-VL 32B text encoder that
    H3 already uses. The first edit loads about 34 GB of models.
  - The picker remembers your choice in this browser and greys out a model that isn't installed.
- **Edit the whole picture.** A new box in the Select + AI panel takes an instruction ("make it night time", "turn
  it into a watercolor") and edits the whole picture with the chosen model. No selection is needed, and the result
  keeps the picture's size.
- **API:** generation requests for engine `imgedit` take `edit_model` (`qwen` or `h3image`) and the new `edit_op`
  `instruct`. In `/api/capabilities`, `editor` gains `qwen`, `h3image` and `crop`.

## [0.27.0] - 2026-11-15

### Added
- **Image editor.** A finished picture's **✏ Edit** button opens an editor over the stage, and the timeline hides
  while it's open.
  - **Toolbar:** Move, Crop, Resize, Adjust and Select + AI, plus Undo/Redo, Fit/100% and **Save as new result**. The
    mouse wheel zooms at the pointer in every tool; the middle button or Space + drag pans.
  - **Crop:** free or a fixed ratio (original, 1:1, 4:3, 3:2, 16:9 and the portrait ones). Drag the box or its handles;
    Enter applies.
  - **Resize:** width and height (proportions locked or not) or 25–200 %, with high-quality resampling. Also rotate
    90° and flip.
  - **Adjust:** brightness, contrast, saturation, hue, grayscale and sepia, with a live preview. Apply bakes them in.
  - **Select:** a brush and an eraser, or **AI select**. Paint a stroke over an object and SAM 3.1 selects all of it
    (Alt + stroke takes it away), or type what to select ("the cup"). Clear, Invert and All.
  - **AI edits on the selection:**
    - **Erase:** Qwen Image Edit 2511 removes it and fills in the background. Qwen3-VL names what's selected, or you
      can type its name.
    - **Replace with…:** Qwen Image Edit 2511 puts what you describe in its place.
    - **Change with a prompt:** Krea 2 redraws it as much as the strength allows.
  - **Remove background:** works on the whole picture, to transparent, white or black. It uses BiRefNet when a model
    is in `models/background_removal`, else u2net.
  - **How the AI edits work:** they only redraw a crop around the selection (NKD Inpaint Crop/Stitch) and paste back
    only the edited area, so the rest of the picture keeps its pixels. Each one is a job and a result in the gallery,
    and becomes the editor's picture; Undo goes back.
  - **Saving:** crop, size and color changes are saved with **Save as new result**, which adds a result with a note
    of what was done.
  - **API:** `POST /api/edit/select` (SAM 3.1 from points, a box or words) and `POST /api/edit/save`. Generation
    requests take engine `imgedit` with `edit_op`, `edit_mask`, `edit_strength` and `edit_bg`. `/api/capabilities`
    has an `editor` section saying which tools are ready.

### Notes
- Erase took several tries to get right. Painting over the selection and telling Qwen to "fill the hole" made it
  redraw the object from the hole's shape, or tint the fill. Krea 2 inpainting at full strength left noise. Naming
  the object and asking Qwen to remove it from the clean picture works. Faint traces can remain; Undo and try again,
  or type what it is.

## [0.26.0] - 2026-11-15

### Added
- **Choose the diffusion model.** The Model step has a **Diffusion model** list for the selected engine.
  - **Default** keeps the file the app picks. **Made for <engine>** lists files that match the engine,
    including fine-tunes found by name (for example any "krea" file for Krea 2). **Other diffusion models**
    lists the rest, with a warning that they may not work.
  - The text encoder, VAE and graph stay the same; only the diffusion model is swapped.
  - The choice is kept per engine, saved with the project, shown on the model card and in the Generate
    summary, and stored with each result, so "use these settings" brings it back.
  - Generation requests take `unet`. The server checks that ComfyUI has the file and resolves its exact name
    (forward or back slashes both work). It rejects an unknown file with a clear error.
  - `/api/capabilities` lists each engine's `unet_choices`.

## [0.25.1] - 2026-11-15

### Changed
- **LoRAs step: change a strength with the mouse wheel.** With the pointer over a LoRA's strength box,
  wheel up adds 0.1 and wheel down takes away 0.1. Hold Shift for steps of 1. It stays within -10 to 10.
- **LoRAs step: no model name under each file name.** The line now appears only when the LoRA isn't made
  for the selected model, to show the "not for …" warning.

## [0.25.0] - 2026-11-15

### Changed
- **LoRAs step: reworked LoRA rows.**
  - **Full name:** each row shows the LoRA's full file name with its folder. Long names wrap at `_ - . /`
    instead of being cut off.
  - **Strength:** only a number box now, from -10.0 to 10.0 in 0.1 steps (the slider is gone). The server
    accepts the same range, and so does the strength box in the LoRA browser.
  - **Reorder:** drag a row by its ⠿ grip, instead of using the ↑ ↓ buttons. A line shows where it will
    land. Dragging works with a mouse, a pen or touch.
  - **⋯ menu on each row:** Move up, Move down, Replace…, Details… and Remove.
    - **Replace…** opens the LoRA browser and swaps in the LoRA you pick, keeping the row's place and strength.
    - **Details…** opens a dialog with the preview, what the LoRA is made for, base, type, rank, tensors and
      data types, size, trigger words, and its full safetensors metadata. Long values (tag frequencies,
      training settings) fold open, with JSON pretty-printed.
  - New endpoint `GET /api/loras/metadata?name=…` returns a LoRA's `__metadata__` block.

## [0.24.1] - 2026-11-15

### Added
- **Zoom in the Result viewer.** With the pointer over a picture, the mouse wheel zooms in and out at the
  pointer, from fit up to 16x. A badge shows the zoom in % of the picture's real pixels.
  - Scroll bars appear when the zoomed picture is bigger than the viewer. You can also drag the picture to move
    it, and double-click goes back to fit.
  - A touchpad zooms smoothly: one mouse-wheel notch is one 1.2x step.

## [0.24.0] - 2026-11-15

### Added
- **Krea 2 image engine.** Pick **Krea 2** under Image, next to FLUX 3 Klein.
  - It runs Krea 2 Turbo the way ComfyUI's "Text to Image (Krea-2 Turbo)" blueprint does: 8 steps, cfg 1,
    euler/simple and a zeroed negative.
  - It uses the Krea 2 Turbo diffusion model (the fp8 file first, then the bf16 original), the Qwen3-VL 4B
    text encoder (`krea2` type, shared with Klein) and the Qwen Image VAE.
  - Draft, Standard and High give 0.5, 1 and 2 MP.
  - **Enhance prompt** has Krea 2's own text encoder expand short prompts, as the blueprint does, so it needs
    no extra model.
  - Krea 2 LoRAs are offered for it in the LoRAs step.

## [0.23.0] - 2026-11-15

### Added
- **Angles: "Make a plain background pure white"** (on by default).
  - **Why:** the model keeps the reference's backdrop tone, so "plain white" came out light grey (about 225).
  - **What it does:** after each angle is saved, the server floods the light, grey backdrop from the picture's
    edges and blends pure white over it with a soft edge, so hair keeps its fine strands. It runs before SeedVR2,
    so the enhanced copies are white too.
  - **How:** it uses PIL only (`app/imaging.py`) and needs no model, in under a second per picture. A
    background-removal model (u2net) was tried first, but it cut away shoulders on back views.
  - If there's no plain light backdrop touching the edges, the picture is left as it is, and the job's log says
    which.
  - `POST /api/angles` takes `white_bg`, and so do generation requests.

### Fixed
- **Angles: back-¾ views came out as side profiles** (back-left even as a front-¾ view). The prompt for
  back-right and back-left quarter views now spells out what the camera sees: from behind, over the shoulder,
  mostly the back of the head, with only the edge of the cheek showing. A stronger LoRA (1.2) and full
  20-step sampling made no difference. Tested on all six back-¾ poses.

## [0.22.0] - 2026-11-15

### Added
- **🔄 Angles:** re-shoot a picture from other camera angles with **Qwen Image Edit 2511** and fal's multiple-angles
  LoRA (4 steps with the Lightning LoRA, about 10 s per angle once loaded).
  - **Where:** a picture's **🔄 Angles…** in the viewer, the results menu, or the media library.
  - **Choosing angles:** a grid of 8 directions (front, ¾ views, profiles, back) × 4 heights (low, eye level,
    elevated, high). Presets: **24 head angles** (8 × low/eye/elevated, close-up), 8 around at eye level, all 32.
    The distance is close-up, medium or wide.
  - **Prompt:** an "Also ask for" line, by default a plain pure-white studio background, even light, and the same
    face, hair and clothing. Every angle uses the same seed.
  - **Enhance:** each angle can be upscaled with SeedVR2 to 1080p, 1440p or 2160p as it finishes, using the
    Enhance chain.
  - **Projects:** results go in the current project, or in a new one that keeps the reference in its library
    (tagged "reference") and a note of what was made.
  - The window estimates the total time.
  - `POST /api/angles {ref, poses, prompt, project, enhance_after}` and `GET /api/angles/options`. Generation
    requests have a new `pose` field, and there's a new engine, `angles`.
- `scripts/convert_lightx2v_fp8.py`: makes lightx2v-style fp8 checkpoints loadable.
  - **Why:** these files keep a per-channel `weight_scale`, which ComfyUI ignores, so they render noise. That
    includes `qwen_image_edit_2511_fp8_e4m3fn_scaled`.
  - **What it does:** folds the scales into plain fp8 weights.
  - **Use:** the Angles engine looks for the result as `qwen_image_edit_2511_fp8_e4m3fn_plain.safetensors`, or
    the official bf16 or fp8mixed file.

### Changed
- "Reuse settings" is hidden for Enhance and Angles results. They aren't settings the form can hold.

### Fixed
- **Settings › After generating now runs on the server, once per result.**
  - **Before:** each open Bob Studio page started its own enhance when a result finished, so two open pages
    meant two identical enhances. It also needed a page to be open.
  - **Duplicate guard:** a repeat request for the same enhance of the same result returns the one already
    made. This covers a request within two minutes, or one still being set up, which also catches pages
    still running the old code.

## [0.21.0] - 2026-11-15

### Added
- **⧉ Duplicate a project:** from the project card (**Duplicate…**) or by right-clicking a project in the Explorer.
  - **Always copied:** settings (model, prompt, LoRAs, Shots, inputs), notes and options.
  - **Optional:** the timeline, the media library (tags, ratings, folders) and the results, each with its own
    switch.
  - **The copy:** goes next to the original or anywhere you browse to. It can open right away. A name that's
    taken becomes "Name (2)".
  - **Experiment:** its card has **Copy to a project…**, which also brings its timeline, library and results
    (Save as project only takes the settings).
  - **Files:** media isn't duplicated; both projects point at the same uploads and outputs. Copied results
    record `copied_from`.
- `POST /api/projects/copy`.

### Changed
- Deleting a result with its files keeps any file another result still uses (a copied project's results share
  them).

### Fixed
- A project whose saved Shots list had shots with missing fields (a hand-edited or partial file) failed to open
  with "Cannot read properties of undefined". Missing shot fields now get their defaults.

## [0.20.0] - 2026-11-15

### Added
- **✨ Enhance** for finished pictures and videos (the viewer's button, or the results menu). The steps run in
  this order, each one optional:
  1. **FaceRefine** (videos made with H3 or H3 Reference), with the ComfyUI-H3-FaceRefine nodes.
     - **How:** it tracks the main face into a steady 768 px crop, injects it into an H3 audio+video latent next to
       the original sound, and re-samples it with H3 Reference. It uses the video's own prompt, reference
       pictures and sounds, and LoRAs, at a low denoise (strength 0.4, 20 steps by default), with more where faces
       are small. The refined face is then stitched back.
     - **Origin:** the same chain as the "mmh3-r2v-dlss5-relayvsr" workflow on this machine.
  2. **DLSS 5** (ComfyUI-DLSS5-Enhancer): NVIDIA neural rendering, from 1x (look only) to 1.5x, 1.72x, 2x or 3x
     upscaling. Styles: Default, Natural, Cinematic. Intensity is adjustable.
  3. **An upscaler:**
     - **SeedVR2** (pictures and videos): to a 720p, 1080p, 1440p or 2160p short side, with any installed 3B/7B
       model (default 3B fp8). Tiled VAE, LAB colour correction, and 33-frame batches with overlap for video.
     - **RelayVSR ×2** (video): Wan-based super-resolution in one step, detail 0.45 by default.
  - **The window:** shows the output size before you run it, and greys out any step this ComfyUI lacks
    (`GET /api/enhance/caps`). It remembers your last choices.
  - **Results:** each enhance is a studio result of its own (engine "enhance") with a log in Activity, and keeps
    the sound.
- **Settings › After generating:** "Enhance each result" runs the chosen chain automatically when a picture or
  video finishes. Enhanced results aren't enhanced again.
- **Enhance time estimates:**
  - **The model:** each step's cost per frame and megapixel was measured on this studio's runs, plus model
    loading. The total is scaled by how long recent enhance runs of the same chain really took here, so it
    settles to the machine. On the test runs it predicted 182 s against an actual 181 s (FaceRefine → DLSS 5 →
    RelayVSR on a 5 s 480p video), and 30 s against 26 s (DLSS 5 2x → SeedVR2 on a picture).
  - **Where it shows:**
    - The Enhance window shows how long the run takes.
    - Settings › After generating shows how much it adds per result at the current size and length.
    - In Activity, a running enhance counts down from its expected total. Each step restarts the progress bar,
      so the rate alone misread it.
    - A generation set to enhance afterwards shows "Then enhance ~X more" and when everything is done; the
      top-bar chip shows "+ enhance ~X".
  - **Data:** enhance results record their source size, frame count and output size (`info.src_width`,
    `src_height`, `frames`, `width`, `height`).
- `POST /api/enhance`. Generation requests: `enhance_opts`, `source`, `enhance_of`, `enhance_after`.

### Fixed
- SeedVR2 only offers, and only accepts, models that are installed in `models/SEEDVR2`. Its loader would
  otherwise download a missing model (several GB) on the first run without asking.

## [0.19.0] - 2026-11-15

### Added
- **Shots step** (video models, after Inputs). The video is planned shot by shot.
  - **Each shot:** a length; a framing (wide, medium, close-up, over-the-shoulder, POV, insert…); where; what
    happens (with `<Picture N>` buttons); a camera move; an optional spoken line, voiced with one of the
    reference sounds; and its own first and last frame (H3) or the reference pictures it uses (H3 Reference).
  - **Editing:** add, duplicate, reorder or delete shots, and set a "Look", soundscape and music for the whole
    video. A live preview shows the prompt.
  - **Use shots** makes Generate build from this list, with a banner on the Prompt step saying so. Two ways:
    - **One video · multi-shot:** one generation in H3's multi-shot format, timed from each shot's length. The
      first shot's first frame and the last shot's last frame are the keyframes. It warns over 15 s or 6 shots.
    - **One video per shot:** a generation per shot, each with its own inputs. When they're all done they go on
      the timeline in order.
- **LoRAs step** (every model, after Shots). Add up to 8 LoRAs with a strength from −4 to 4, reorder them,
  and click trigger words into the prompt.
  - **In the graph:** they chain after the model (and H3's turbo LoRA) in every graph: H3, H3 Reference, the
    reshoot, Klein and Music 3.
  - **Checks:** they're validated against ComfyUI's list, and RefMod files are refused.
- **LoRA Explorer** (📂 Browse LoRAs…), a Windows Explorer style browser.
  - **Browsing:** a folder tree with counts, Back/Forward/Up, an address bar, search across folders, Details
    (sortable: name, made for, type, rank, size, modified) or Large icons, and a details pane.
  - **Details pane:** preview picture if one sits next to the file, what model it's for (✓ fits / ⚠ not), base,
    type, rank, tensors, size, trainer, trigger words (click to copy) and description.
  - **Filters:** only LoRAs for the selected model (on by default), by model family, and hide RefMods.
  - **Adding:** set a strength and double-click, press Enter or click Add.
  - **Keys:** arrows, Backspace, Ctrl+F and F5 work.
  - **Back end:** `GET /api/loras` reads only the safetensors headers. It classifies each file from its metadata,
    then its tensor names, then its folder and name; 487 files take 0.65 s, cached in `data/lora_cache.json`.
    `GET /api/loras/preview` serves the preview pictures.
- `project.json` settings: `loras`, `shots`. Generation requests: `loras`.

## [0.18.0] - 2026-11-15

### Added
- **Reference sound for voice cloning** (Inputs step, with **H3 Reference** video).
  - **Adding a voice:** upload or drag in up to 3 recordings, either sound files or videos whose soundtrack has
    the voice. Each one gets a player and an **Audio N** tag that inserts `<Audio N>` into the prompt.
  - **Prompting:** say who speaks with which voice, e.g. "…says 'See you tomorrow' in the voice of
    `<Audio 1>`". Without tags, a lead sentence names the voice references.
  - **Clean-up:** **Clean it up and keep the best 6–10 s of speech** (on by default) runs each recording through
    the `H3RefAudioPrep` node: voice-focused noise removal and the densest pause-free window of speech. It's
    skipped when that node isn't installed.
  - **On H3 (not Reference):** the section offers a one-click switch to H3 Reference.
  - **Without pictures:** H3 Reference now also runs with sounds only.
  - **Consent:** a note asks you to clone only voices you have permission to use.
  - `project.json` settings: `audios`, `clean_audio`. Generation requests: `ref_audios`, `clean_audio`.

## [0.17.0] - 2026-11-15

### Changed
- **The Prompt Writer lives in the top section.** It's a pane between the gallery and the viewer.
  - **Opening it:** the **✍ Writer** button next to Gallery, **Alt+W**, or ✍ Prompt Writer on the Prompt step.
  - **Size:** drag its edge to resize; the width and whether it's open are remembered, and layouts include it.
  - **Sharing room:** on narrow screens the gallery, writer and viewer share the space, and the viewer keeps at
    least 300 px.
  - **Behaviour:** the writer works as before: linked to the studio, with **Use in studio** filling the prompt
    box. Inside the pane it drops its own title bar and switches to one column when narrow.
  - **↗ Pop out** opens it in its own window again.

## [0.16.2] - 2026-11-15

### Added
- **Fx in the depth preview.** The 3D renderer (main viewer and Look through) now draws the clip's Fx lights
  (relight, glow, shade, with colour, size, strength, flicker, motion and keyframes) and its vignette.
  - **Same maths as the render**, applied to the picture before the camera, so they sit on the relief.
  - **Grade:** still applied over the whole view, so the preview can look slightly more saturated than the
    render.

## [0.16.1] - 2026-11-15

### Added
- **Parallax in the main viewer.**
  - **Where:** inside a camera move that has depth, the program monitor draws the shot with the same 3D
    renderer as the Camera window's Look through: the picture as a relief seen through the camera.
  - **Playback:** it plays along, with the depth video kept in step.
  - **What carries over:** the Video Fx grade is applied.
  - **What doesn't:** transitions aren't drawn inside a camera move with depth (Fx lights and the vignette are, since 0.16.2).
  - **Outside such a move**, the viewer is unchanged.

## [0.16.0] - 2026-11-15

### Added
- **3D view in the Camera window** (WebGL, Blender style).
  - **The scene:** the picture is a card in the middle of a floor grid. The shot camera is an object with its
    frustum and the outline of what it sees on the picture. Its path and keyframes are drawn when the move is
    keyframed.
  - **Moving the camera:** drag it with **✥ Move** (Shift: toward or away from you), **⟳ Rotate** (Shift: roll)
    or **◎ Orbit** (up/down: crane). The wheel over the camera zooms it.
  - **Moving the view:** drag empty space to orbit, right-drag or Shift-drag to pan, and use the wheel to zoom.
  - **Keys:** G, R and O pick the tool, C toggles look-through, and F frames the scene.
  - **Look through** shows the shot from the camera itself.
  - **Keyframes:** with keyframes, every change sets one at the playhead.
- **Depth and parallax.** **🧊 Analyse depth** runs Depth Anything 3 (base) in ComfyUI on the picture under the
  move. It took 10 s for a 2.3 s move in testing; the model downloads on first use, about 256 MB.
  - **3D view:** the card becomes a relief, with a strength slider.
  - **Render:** parallax is added before the perspective warp. Near things shift and grow against the
    background as the camera travels.
  - **Out of date:** a warning shows when the picture under the move has changed since the analysis.
  - **AI reshoot:** guide frames get the parallax too.
  - `project.json`: `cam.depth`.
  - New `app/depth.py` and `POST /api/timeline/depth`. Depth items don't show in the results gallery.

### Fixed
- **Crash in guide frames.** ffmpeg 8's `displace` crashed (access violation) when both of its inputs were
  seeked. Guide frames now pick the depth frame inside the filter graph.

## [0.15.0] - 2026-11-15

### Added
- **Audio volume keyframes.** Click the yellow volume line on an audio clip to add a point, drag points up/down
  and sideways, and double-click a point to delete it. The first point also pins the clip's level at both ends.
  - **Easing:** linear between points.
  - **Trims:** points are in the clip's source time, so they stay put.
  - **Where it shows:** the preview, the waveform graph and the render (an ffmpeg `volume` expression) all
    follow them.
  - **Removing them:** Sound… and the clip menu can remove them.
  - `project.json`: `clips[].vol_keys`.
- **Camera track** (🎥 in the toolbar, **Shift+C**, ＋ Camera, or double-click the track). Camera moves apply to
  everything below the track, treated as a flat picture in 3D.
  - **Moves:** pan, tilt, roll, zoom, dolly, truck, crane (pedestal) and orbit, with keyframes (smooth, linear
    or hold) and handheld shake.
  - **Presets:** push in, pull out, pan, tilt up, orbit, crane up, dutch tilt, dolly zoom and handheld.
  - **Fill:** areas the move uncovers can be black or a blurred picture.
  - **Preview:** the viewer previews the move in 3D (CSS `matrix3d`). The render projects the corners every 3
    frames into ffmpeg `perspective`.
  - **Turning moves off:** per move, or for all of them with the track's 👁.
  - **FCPXML:** camera moves aren't exported.
- **AI reshoot** of a camera move (in the Camera window).
  - **How it works:** describe the scene and optionally add reference pictures. The studio makes 2–6 guide
    frames along the move with masks of what it uncovers. FLUX Klein fills those areas from your words, the frame
    and the references. MiniMax H3 then generates the shot from the filled guides (first and last frames, with
    guides between).
  - **Result:** the new shot lands on its own track under the Camera track, without its own sound, and the move
    turns off so it isn't applied twice.
  - **Progress:** follow it in the Activity console.
  - **Background:** the idea comes from Reshoot 4D (AGPL-3.0, no code used). That project uses 4D Gaussian
    splats, ReDirector and LTX 2.3; this uses only models already installed here.

### Changed
- Very long filter graphs (long camera paths) are passed to ffmpeg in a file. Windows command lines stop at
  32k characters.

## [0.14.0] - 2026-11-15

### Added
- **Keyframes for Video Fx.** Exposure, contrast, saturation, temperature, tint, vignette, blur and every light's
  position, size, strength, flicker and colour can change over a clip.
  - **The keyframe bar** in the Video Fx window shows a ◆ per key and the playhead. Click to move the playhead,
    drag a ◆ to retime it, and use ◀◆ / ◆▶ to jump between keys.
  - **Buttons:** Add keyframe, Delete keyframe, Remove all, and ease to the next key (Smooth, Linear or Hold).
  - **Editing:** once a clip has keys, changing any setting or dragging a light on the viewer sets a key at the
    playhead. The window shows the values at the playhead.
  - **Where keys live:** in the clip's source time, so they stay on the same picture when you trim or split.
    Clips show their keys as small ◆ marks.
  - **Preview and render:** the live preview animates too. The render uses frame expressions and per-frame
    commands.
  - `project.json`: `clips[].fx.keys`.
- **Waveform graphs on audio tracks.** Audio clips are drawn from measured peak and RMS levels instead of a
  stretched picture.
  - **What it shows:** what you'll hear. The graph is scaled by clip × track volume, fades and crossfades, with
    red marks where it would clip.
  - **Volume line:** yellow; the middle is 100 % and the top is 200 %.
  - **Muted or un-soloed clips** draw grey.
  - **Live redraw** while you drag a fade.
  - New `GET /api/media/peaks`, cached in `data/thumbs`.

### Fixed
- **Exposure above +1 stop** made the render fail: ffmpeg's colour mixer allows a gain of at most 2. Large
  gains are now split over several mixers.
- **Out-only renders:** a render with an Out point but no In point failed before starting (0.12.0).

## [0.13.0] - 2026-11-15

### Added
- **Video Fx** for picture clips: **✨** in the timeline toolbar, **Shift+E**, or **Video Fx…** on the clip's
  right-click menu.
  - **Grade:** exposure (stops), contrast, saturation, temperature, tint, and black and white or sepia.
  - **Lights:** up to 4 per clip. Drag the numbered dots on the viewer to place them.
    - **Kinds:** **Relight** brightens what's there and keeps its texture, **Glow** adds light on top, and
      **Shade** darkens.
    - **Settings:** colour, strength, size and flicker. **Moves** makes a light travel from ● to ○ over the clip.
    - The approach follows [AInVFX Paint a Plate](https://github.com/AInVFX/ainvfx-paintaplate) (Apache-2.0),
      which multiplies the plate by a smooth light ratio. Here it's done with ffmpeg rather than generative
      models, so it's instant but doesn't know the scene's shapes.
  - **Finish:** vignette, blur, sharpen and film grain.
  - **Presets:** Golden hour, Moonlight, Noir, Neon side light, Candle flicker, Light sweep and Film look.
  - **Live preview** on the program monitor, close to the render. The render is exact, and grain and sharpening
    show only there.
  - **Sharing and switching:** Copy, Paste, Apply to selected, a quick Fx on/off on the clip menu, and the ✨
    badge on clips. Undo covers each edit session.
  - `project.json`: `clips[].fx`.
- **Render options:**
  - **Add timestamp** to the file name ("My cut 2026-11-15 14.03.27").
  - **Burn the timecode** into the picture.

### Fixed
- **Copied clips shared effects.** Split, copied, pasted and duplicated clips shared one settings object in the
  page, so editing one changed the other until reload. They're now independent copies.
- **Stray playhead saves.** Switching projects could save a pending playhead change into the newly opened
  timeline.

## [0.12.0] - 2026-11-15

### Added
- **Render options.** The ⬇ Render… button (and **Ctrl+E**) opens a dialog. Your choices are remembered per
  project.
  - **File:** a file name, and where to save it: outputs or any bookmarked folder. An existing file gets a
    number added rather than being overwritten.
  - **Format:** MP4 H.264, MP4 H.264 on NVIDIA NVENC, MP4 H.265, WebM VP9 + Opus, MOV ProRes 422 HQ, or sound
    only as WAV or MP3. Only formats your ffmpeg can write are offered.
  - **Range:** the whole timeline or In–Out.
  - **Picture:** resolution (same as the first clip, 4K to 480p by short side, 1920×1080, vertical, square or
    custom), frame rate, quality, and encoding speed.
  - **Sound:** include it or not; loudness (as in the Mixer, off, −14, −16 or −23 LUFS); bitrate; sample rate;
    stereo or mono.
  - **FCPXML** export is also in the dialog.
- **Activity console** (the top bar's Activity chip, **Log** on a queue item, or **Ctrl+Shift+A**).
  - **What it shows:** everything the studio is doing and has just done, with a progress bar, status, elapsed
    time, time left (from the recent progress rate), the estimated finish time, the file, and a timestamped log.
  - **Logs:** generations log the workflow, inputs, ComfyUI job and queue position, each node as it runs,
    sampling steps, downloads and errors. Renders log each ffmpeg stage with its speed and time.
  - **Actions:** Cancel, Show result, Copy log, Clear finished.
  - **While busy:** the chip shows the running job, its percentage and the time left.
  - **Storage:** items keep their last 300 log lines (`log` in `data/history.json`) and stream them as `log`
    events.

### Changed
- **The results gallery moved to the top section**, left of the viewer. The **🗂 Gallery** button (left of
  Result) or **Alt+G** shows or hides it. The width is adjustable and both are remembered. The timeline now uses
  the full width, and layouts include whether the gallery is shown.
- Opening a project no longer marks it unsaved when auto-save is off. Only real changes do.

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
