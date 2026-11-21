# Changelog

All notable changes to Bob Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The current version lives in
`app/__init__.py` and is shown in the app's top bar and in `/api/status`.

## [0.140.0] - 2026-11-21

### Added
- **Depth for a camera move's photo and filled views.** In an empty 3D scene, a render that starts from a photo
  painted it, and every view Qwen filled, onto the flat floor and a far dome, so the people, tables and walls in them
  stretched and smeared as the camera turned. Each picture now goes through Depth Anything 3 first
  (`POST /api/scenes/relief`, kept per picture) and is laid on its own depth mesh along its camera's rays. The photo's
  depth is scaled by the stand-ins (they stand where it has them) or the nearest of the floor; each filled view's by
  the depth already laid down. The people and objects found in the photo are left out of its mesh: their stand-ins
  carry them.

### Changed
- **Filling what the photo can't see keeps to the place.** Indoors (a restaurant, a room…), Qwen continues the same
  room's walls, floor and ceiling, never sky or a view outside; the outdoor wording opened a candlelit restaurant
  onto a terrace with a skyline. Qwen also gets the photo with its people and objects taken out, as the room to
  continue, and the stand-ins' places in each view are magenta, so it paints the room behind them (given the photo
  itself, or bits of her in a view, it drew a second Kristen behind her). What Qwen leaves magenta is filled again.

## [0.139.2] - 2026-11-21

### Fixed
- **Lips keep up with the words when the camera moves.** A 3D scene render holds every pixel to its camera guide for
  the first sampling steps, and the guide's face is the still first-frame photo with the mouth shut, so the lips
  started late and lagged the words. Each speaker's head (from the shot's lines) is now left free in the guide's
  mask: the camera move is still followed, and the mouth moves with the words from the start.
- **A close-up start no longer loses the person.** 0.139.1 took a person cut off by the bottom of the frame for one
  whose feet were hidden, and stretched their face down over their whole stand-in, so a pull-back from a close-up
  lost them. That case is left as it was before.

## [0.139.1] - 2026-11-21

### Fixed
- **A seated person no longer disappears when the camera moves in.** When a 3D scene's render starts from a photo
  and the camera moves, each person is found in the photo and their stand-in is moved to match, judged by where
  their feet touch the floor. For someone sitting behind a table the feet are hidden, so the table's edge was taken
  for them and the person was placed metres back and cut out of the room: a push-in ended on an empty seat. A person
  whose feet are hidden now stays where the scene puts them and still carries their look from the photo.

## [0.139.0] - 2026-11-20

### Added
- **V2 gets the takes, the words and the retake.** In 0.135–0.137 these were only on the classic page.
  - **Takes:** 1–4 next to Generate shot, each with its own seed. Their words are checked, and the shot uses the take
    that says its lines best; ties go to the newest.
  - **The shot's result** shows its 🗣 words (the score and what was heard) and its takes, best words first. ★ marks
    the take the shot uses unless you pick another; a click picks one, and the pick is kept on the board. The timeline
    and export follow the take in use. New takes start picking by words again.
  - **"Check the words"** and **"🔁 Retake the sound…"** work as on the classic page: all of the sound or some
    stretches ("From here" / "To here" mark them on the shot's video), keep the music and sounds, 1–4 takes. The
    retakes land on the shot.
- Tested in V2: the Render window sizes Lena's line at her voice's measured pace ("about 4.2 s of speech (at their
  voices' pace: Lena 4.5 syllables a second)", against 3.7 s at the default).

## [0.138.0] - 2026-11-20

### Changed
- **Lines are sized at each speaker's own pace.** Before, everyone was assumed to speak at 5.5 syllables a second.
  This follows H3-AudioRetake-studio's speaking rate (MIT).
  - **Where it's used:** the Render window's "Lines: about N s of speech", and the warning (Render window and V2
    Generate) when a shot is much longer than its lines.
  - **How it's measured:** once per voice, from its recording. Whisper's words are counted in syllables and divided
    by the time the voice isn't pausing (ffmpeg's silencedetect), kept within 3–8 syllables a second.
  - **Default:** a speaker without a voice, or a recording with under five words heard, stays at 5.5.
  - **Shown:** the Render window names the measured paces, e.g. "at their voices' pace: Lena 4.5 syllables a second".
  - **Speed:** a measurement takes 2–4 s on the GPU and is cached per file. `POST /api/voice/rate` returns it.

## [0.137.0] - 2026-11-20

### Added
- **A retake keeps the original's music and sounds; only the voice is new.** This is the retake dialog's
  "Keep its music and sounds" option, on by default.
  - **How:** MelBand RoFormer splits the new take into voice and background, and the original's sound the same way.
    The new voice is mixed over the original background. Stretches, crossfades, the untouched picture and the word
    ranking work as before.
  - **Measured on a test retake:** inside the retaken stretch, the background matches the original's at 7.6 dB SNR,
    against −2.8 dB without the option.
  - **Needs** [ComfyUI-MelBandRoFormer](https://github.com/kijai/ComfyUI-MelBandRoFormer) and
    `MelBandRoformer_fp16.safetensors` (435 MB) in `models/diffusion_models`. Without them the retake is refused with
    a message saying what's missing; untick the option to retake without them.

## [0.136.0] - 2026-11-20

### Added
- **🔁 Retake the sound** (a video's details): its sound made again from a prompt by H3 Reference, with the picture
  kept frame for frame. This is the audio-only retake of H3-AudioRetake-studio (MIT), done with nodes most installs
  already have. No new node pack is needed.
  - **What:** all of the sound, or only some stretches (e.g. `1.2-3.4, 5-6`). "From here" and "To here" mark a
    stretch at the video's play position. Outside a stretch the original sound stays, with a short crossfade at each
    edge.
  - **The prompt** starts as the video's own and can be edited: its lines (`<d>…</d>`), voices (the voices it was
    made with, optionally) and sounds.
  - **1–4 takes**, each a result of its own ("Retaken sound"). Each take's words are checked (🗣 Words), so they come
    back ranked best first.
  - **How:** the video and its sound go into one AV latent. `MVEx_AudioMaskToLatent` (MaskVidExperiments custom
    nodes) marks the sound to redo and keeps the whole picture, and H3 Reference voices it. Only the sound comes back
    from ComfyUI. ffmpeg puts it under the original video's picture, which is copied as it is, so it is unchanged
    even after Enhance or at any size or frame rate.
  - **Speed and limit:** about 75 s a take for a 5 s clip at 4 steps. Up to about 15 s per retake.

## [0.135.0] - 2026-11-20

### Added
- **🗣 Words: takes ranked by how well they say their lines.**
  - **When:** once a video whose prompt has spoken lines (`<d>…</d>`) is rendered, Whisper large-v3-turbo hears its
    sound, through faster-whisper and the crt-nodes `CRT_AudioTranscriptBatch` node in ComfyUI, using the language of
    the lines' tag.
  - **Score:** the words are compared with the lines. 100% means they're said as written and nothing else; each word
    left out, changed or added costs one, following H3-AudioRetake-studio's word match (MIT).
  - **Where it shows:** on the result's bar (🗣 92%) and its gallery tile. The result's details have a Words section:
    the lines, what was heard, and the takes of the same prompt, best first, the best marked ★ (also on its tile).
  - **Again by hand:** "🗣 Check the words" in a result's details runs it again, or for a video made before this
    version.
  - **About 2–3 s a take on the GPU.** The model (about 1.6 GB) is fetched into ComfyUI's
    `models/stt/faster-whisper` on first use and freed after each check.
  - **Errors:** a Whisper failure is reported as an error, not scored 0%. A Whisper job that hangs is taken out of
    ComfyUI's queue after 10 minutes of running; time spent waiting behind renders doesn't count.
- **Setup note:** faster-whisper's CTranslate2 is built for CUDA 12. A ComfyUI whose PyTorch is CUDA 13 also needs
  CUDA 12's cuBLAS (`nvidia-cublas-cu12`, its two DLLs next to CTranslate2). The error says so when it's missing.

## [0.134.17] - 2026-11-20

### Fixed
- **A spoken line Rewrite put back goes in its own shot** (H3 and H3 Reference). A line the model left out, or put
  below the sound fields, used to go at the end of the last shot. Now it goes in your own [Shot N] when your text has
  one. Otherwise it goes in the shot that tells what your text tells around the line (the man's "Anyone home?" goes
  in the shot where he knocks, not the one where the girl opens the door), and never before the shot of an earlier
  line or after the shot of a later one.
- A line the model wrote as a bare <d>…</d>, with nobody saying it, gets its speaker from your text ("The man says
  once: …"), or "They say once:" when your text doesn't name one.

## [0.134.16] - 2026-11-20

### Fixed
- **Rewrite gives each spoken line to the person who says it in your text** (H3 and H3 Reference). A small model
  sometimes handed a line to the other person, e.g. "He sits beside her and says once: You came back." for the
  woman's line. The check now looks at who your text has say each line (a woman, a man, a girl… or "she"/"he"). When
  the rewrite's sentence names the other one, its "and says once: …" becomes a sentence of its own with your speaker:
  "He sits beside her. The woman says once: …". Their picture tag and voice go with them ("The woman from
  <Picture 1> says once, in the voice of <Audio 1>: …"). A plain "They say once:" gets the speaker's name too.
  Lines whose speaker your text doesn't name as a woman or a man are left as they are.

## [0.134.15] - 2026-11-20

### Fixed
- **H3 Reference's Rewrite keeps the picture tags again.** Since 0.134.14 its rule to name everyone by their tag came
  after the long shot-list format, and a small local model dropped a <Picture N> tag in 5 rewrites of 12 (1 of 12
  before). The rule now comes first: 0 of 18 in testing. The check also puts back a tag the rewrite dropped when your
  text names it with a noun: your "the woman from <Picture 1>" and the rewrite's "the woman" get the tag back.
- **Rewrite no longer makes up spoken lines.** The "says once" format is asked for only when your prompt has spoken
  words. The check also takes out a line you didn't write, with the sentence that says it (a chef saying "Perfect.").
  A line you wrote in plain quotes still counts as yours.
- A spoken line the model put on its own row below a shot is joined back into that shot.
- When the model wrote [Shot 2] but ran shot 1 into the style line, the style line and [Shot 1] are split apart
  again.

## [0.134.14] - 2026-11-20

### Fixed
- **Rewrite keeps H3's shape** (H3 and H3 Reference): the style line, a blank line, the shots from [Shot 1], a blank
  line, the sound fields.
  - H3 Reference's Rewrite now gets the same shot-list instructions as H3, word for word. With the shorter version, a
    small local model left out the style line and the [Shot 1] tag almost every time; now it writes them nearly always.
  - The finished rewrite is checked too. A missing [Shot 1] tag is added, and a style line run into the shots gets its
    blank line. A missing style line comes from your text when you wrote one; otherwise a short extra call to the model
    writes one for the shots.
- The "only the words inside the dialogue tag are spoken" sentence is taken out of shots that have no spoken line
  (the model sometimes added it to every shot).

## [0.134.13] - 2026-11-20

### Fixed
- **Rewrite keeps your spoken lines as you wrote them** (H3 and H3 Reference). A small local model often mangled
  them: it dropped the [English] tag, turned <d>…</d> into plain quotes, moved the line below the sound fields, or
  left it out altogether (on H3 Reference, every time with the instructions before 0.134.12). The finished rewrite is
  now checked against your text: each line goes back in its shot as <d>[as you wrote it]</d>, and a line left out
  goes at the end of its shot as "They say once: …" (with its voice, when you gave one).
- When a shot ends up with several lines, the "only the words inside the dialogue tags are spoken" sentence follows
  the last of them, once, worded for several lines.

## [0.134.12] - 2026-11-20

### Changed
- **Rewrite says each line once, too**, for H3 and H3 Reference, like the Prompt and Shots steps and V2. Its
  instructions ask for "They say once:" (or "<who> says once:") followed by: only the words inside the dialogue tag
  are spoken, once; before and after them the speaker stays silent with their lips closed. Whatever the model writes,
  the finished rewrite is then checked: a "says" before a spoken line becomes "says once", and a shot with lines gets
  that sentence once (worded for several lines when a shot has more than one).

## [0.134.11] - 2026-11-20

### Changed
- **The Prompt step says each line once, too**, like the Shots step and V2. A shot's line is now "They say once:
  <d>[English] …</d>", followed by: only the words inside the dialogue tag are spoken, once; before and after them
  the speaker stays silent with their lips closed. This applies to both the live preview and the written prompt.

## [0.134.10] - 2026-11-20

### Changed
- **The Shots step says each line once, too**, as V2 does since 0.134.9. A shot's line is now "says once", followed
  by: only the words inside the dialogue tag are spoken, once; before and after them the speaker stays silent with
  their lips closed. This applies to H3 and H3 Reference, one video or one per shot. The Prompt step's own builder is
  unchanged.

## [0.134.9] - 2026-11-20

### Changed
- **H3 says each line once, and nothing more.** This is from H3-AudioRetake-studio's prompt rules. In V2, 3D scene
  renders and text-to-video shots, each line is now "says once". After the lines, the prompt says only the words in
  the dialogue tags are spoken, each line once, and that before, between and after them the speakers stay silent
  with their lips closed. H3 tends to fill a shot's spare time with words of its own, more so with a voice reference.

### Added
- **A warning when a shot is much longer than its lines.**
  - The lines' length is estimated as their syllables at 5.5 a second, plus half a second each.
  - With more than 2.5 s to spare, the Render window and V2's Generate log say that H3 may fill the rest with words
    of its own.
  - The Render window's model settings show the lines' length.
- **How closely H3 keeps to the voices**, beside "Use the speakers' voices" in the Render window:
  - Close to the recording: the voice as recorded (reference).
  - Loosely: its timbre, with more room to act the line (weak_reference).

## [0.134.8] - 2026-11-20

### Fixed
- **A 3D scene render on H3 Reference now tells H3 who is who, and whose voice is whose.** This applies to Render
  video, Quick video and V2's Generate, with the objects' pictures or the speakers' voices.
  - It used to send H3's plain prompt, so nothing said that <Picture 2> is the woman or that <Audio 1> is her voice.
    H3 had to guess, and the voice and lines often came out wrong.
  - It's now in H3 Reference's full form, as the Shots step writes it:
    - **subject_definitions:** each picture's subject, and each voice with whose it is and their speaker ID.
    - **summary**
    - **retention_analysis:** each subject's look and each voice kept.
    - **The description**, where a pictured object is its <Subject N> (where it is in the frame) and each line is
      spoken by its <Subject N> (S1), in its <Audio N>.
- **Lines get a speaker ID** (S1, S2… in order of first speaking) on plain H3 too. Someone already named is called by
  a short name ("the young woman"), not the whole description again.
- **The subject's words no longer break mid-sentence** ("…blonde hair. from <Picture 2> (…hair. in the middle…)").
  A description ending in a full stop is trimmed, and someone from a picture is described once.

## [0.134.7] - 2026-11-20

### Fixed
- **A push in (or a dolly or zoom towards a person) no longer tears them apart** in a 3D scene render from a photo.
  - The cause: the person in the photo was painted onto their stand-in figure. The figure's shape isn't theirs (hands
    on hips are wider, a dress is fuller), so close up the photo took the figure's shape. A dress opened up, an arm
    slid off and the face went blank, and H3 followed it.
  - Now someone the camera only comes closer to, seen from about the way the photo saw them all through (the view of
    them turns less than 18°), is painted on a flat card standing at their front, facing the photo's camera.
  - The card carries exactly what the photo has of them, at any distance, and goes where they go.
  - For an orbit, which turns the view of them more than that, the stand-in is kept as before.
- **No more thin horizontal stripes across the frame** in a render from a photo.
  - The cause: far out, just below the horizon, the ground is seen almost edge on, so one pixel of the photo
    camera's depth spans metres of it. Thin bands of it then counted as unseen, and became holes in the rough
    animation and its mask.
  - Each point is now checked against the farthest of that depth pixel and its neighbours.
- What the photo has outside a found object's shape, on its stand-in or card, is now left out (what's behind shows),
  where it used to cover what's behind with a hole.

## [0.134.6] - 2026-11-20

### Added
- **Quick photo and Generate photo in V2 send the objects' LoRAs**, as Render video does.
  - When the shot's library objects have LoRAs, the photo window has a "Use the objects' LoRAs" option, on by
    default. The review lists the LoRAs with their strengths.
  - Render video's photo of the first frame (new or quick) gets them too.
- **The edit models take LoRAs** (the AI edit's instruct step, which the scene photo uses).
  - On Qwen Image Edit they go after the Lightning LoRA; on MOSS-Image Edit, after its edit LoRA; on MiniMax H3
    Image, on the model.
  - A LoRA made for a different model than the one picked may do nothing or spoil the photo.

## [0.134.5] - 2026-11-20

### Added
- **Render video in V2 sends the objects' LoRAs**, as Generate does.
  - When the library objects in the shot have LoRAs, a new option, "Use the objects' LoRAs", is on.
  - Each LoRA goes once, up to 8, at the strength set in the object library.
  - The review lists them with their strengths.
  - Untick it to render without them.

## [0.134.4] - 2026-11-20

### Added
- **Render video in V2 sends the speakers' voices**, as Generate does.
  - When the shot's speakers have library voices and H3 Reference is installed, a new option, "Use the speakers'
    voices (H3 Reference)", is on. Each voice goes as <Audio N>, and each line says which voice it's spoken in.
  - The render then runs on H3 Reference's model, with the same motion.
  - The review shows the model, the voices among the pictures, and the lines with their voices.
  - Untick it, and H3 picks the voices.

## [0.134.3] - 2026-11-20

### Fixed
- **Render video in V2 now includes the shot's dialogue and sound.**
  - The shot's lines go into the prompt after What happens, as V2's Generate sends them.
  - Its background sound and music fill the soundscape and music fields. The music field stays N/A when the project's
    soundtrack is on.
  - The window's "H3 reads" line, the review and the request all show them.
  - The voice references (H3 Reference's audio) still go only with Generate.

## [0.134.2] - 2026-11-20

### Fixed
- **In V2, the photo's look starts from the shot's setting.** In Generate photo, Quick photo and Render video (the
  new or quick photo of the first frame), "How the photo should look" is filled in from the open shot's setting, as
  V2's Generate already uses it. Without a setting it's the last look you wrote, as before. It's still yours to edit.

## [0.134.1] - 2026-11-20

### Fixed
- **Render video (and Quick video) in V2 now starts from the shot's What happens.** The window's What happens field
  is filled in from the open shot's, so the prompt matches the shot instead of a generic line. It's still yours to
  edit before rendering.

## [0.134.0] - 2026-11-20

### Added
- **Levels in 🎬 Render video, from rough to final.** At the top of the window, pick one:
  - **🧊 Sketch:** the scene's 3D objects as drawn, Draft, 4 steps. It tests the motion and is the fastest.
  - **🟫 Rough:** a small, quick photo of the first frame (0.4 MP on Qwen, about 20 s), then a Draft video. It
    tests the look.
  - **🎬 Final:** a full photo of the first frame (or the scene's picture), the Qwen fill and detail view,
    Standard quality and the turbo's full steps.
  - A level only sets the options under it, which you can still change one by one. Changing one by hand makes it
    your own mix. The last level you rendered with is remembered.
- **Speed** beside Quality: Fastest (4 steps), Normal (the turbo's own), Finer (12 steps) or Best (no turbo, 20
  steps, slow). The model settings in the review show the steps it will take.
- **A quick photo as the start:** "Start from" has a new choice, a quick, small photo of the first frame.

### Changed
- **⚡ Quick video now opens the Render window on Sketch** instead of sending straight away, so you see its
  settings and the whole prompt first, and can step it up to Rough or Final.
- A shot made from a render keeps the render's speed (its steps and turbo) when Generate on the Shots step sends it.

## [0.133.0] - 2026-11-20

### Fixed
- **A push in no longer smears the bottom of the picture** (a 3D scene render from a photo, with the Qwen fill on).
  - The cause: coming in close magnifies the photo, about twice for a push in. The ground in front turned into smeared
    streaks as the photo's pixels stretched, and H3 followed the blur.
  - The fix: where the camera move magnifies the photo most (over 1.4×), the render now draws that view and has Qwen
    redraw it sharp, keeping every shape, colour and place. It's painted on from that camera and fades in over the
    photo's background as the camera comes close.
  - The objects still come from the photo, so a person isn't redrawn by Qwen. It adds about half a minute before the
    video.

### Added
- **🎬 Render video shows what will be sent, before it's sent**, like the photo window:
  - **Model settings:** H3 or H3 Reference, how closely it follows the rough animation, the quality and the size it
    will come out at, the length in frames and seconds, the steps, the seed, and what's made before it (the photo of
    the first frame, the Qwen fill and detail view).
  - **The pictures it gets:** the first frame, the rough animation and its mask, and the objects' pictures on H3
    Reference.
  - **The whole prompt,** editable: Render sends it as it is, and ↻ Rebuild puts the built one back.

## [0.132.0] - 2026-11-20

### Added
- **🔁 Loop** in the scene's play controls: playing goes round again from the start instead of stopping. Remembered
  in this browser.
- **The photo window shows what will be sent, before it's sent** (📷 Generate photo, and ⚡ Quick photo, which now
  opens the same window instead of starting at once):
  - **Model settings:** the model, its steps and CFG, the size it works at (0.4 MP for the quick one), the picture's
    size, the seed, and the camera and time it's taken from (with the aperture when there's one).
  - **The pictures it gets,** in order: the render (and who's pasted into it), the depth map, and each object's
    picture, as the prompt names them.
  - **The whole prompt,** exactly as the model gets it, look and depth-of-field line included. It can be edited:
    Generate then sends it as it is, and ↻ Rebuild puts the built one back.
  - Then 📷 Generate (or ⚡ Generate the quick photo).

## [0.131.0] - 2026-11-20

### Added
- **Objects ease between their keys,** as the camera does. Each key says how the object gets to the next one: steady,
  ease in, ease out, or ease in and out. In V2, right-click an object's key on the timeline to set it. Eased keys show
  in orange. The 3D view, the scene renders and the "face where it's going" turn all follow it.
- **Markers on V2's timeline.** Add one with 🚩 (or M) at the play line, or by right-clicking the ruler. Each shows as
  a flag with a dashed line down the layers. Drag one to move it, click it to go there, double-click to name it,
  right-click to go to, name or delete it. They're kept with the project's shots.
- **The play line scrubs.** Press and drag along the ruler to move the open shot's time; letting go over another shot
  opens it there. While the scene plays, the line follows it frame by frame.
- **The mouse wheel zooms the timeline** about the point under the cursor. Shift+wheel scrolls it sideways.
- **Seconds or frames.** The s / f button switches the ruler, the shots' lengths, the total and the markers between
  seconds and frames (24 a second).

## [0.130.0] - 2026-11-20

### Added
- **V2: edit objects' keys on the timeline.** Under 🎥 Camera, each object in the open shot has a row (↳ its name),
  with its keys (◆) where they fall in the shot and a line where it moves:
  - **Drag a key** to retime it, snapped to frames. The object keeps its place, turn and size at that key, now at the
    new time.
  - **Click** the row or a key to select the object and go to that moment.
  - **Double-click** the row to key the object there, where it is (so a move starts or ends there). Then move, turn or
    size it with its gizmo or its details.
  - **Right-click a key** to go to it or delete it (with two keys left, deleting one leaves the object still).
    Right-click the row to key it there or open its details.
  - Each edit is saved, and ↶ Undo in the scene takes it back.

## [0.129.0] - 2026-11-20

### Added
- **V2: edit the camera on the timeline.** The 🎥 Camera layer edits the open shot's camera keys:
  - **Drag a key** (◆) to retime it. It snaps to frames, and the camera's path follows.
  - **Click a key** to select the camera and go to that moment.
  - **Double-click** the layer to add a key there. The camera's path doesn't change; the key is there to change it,
    with its arrows and rings or its details.
  - **Right-click a key** to go to it, set how the camera gets to the next key (steady, ease in, ease out, ease in and
    out), or delete it. Right-click empty space to key the camera there or open its details.
  - Each edit is saved, and ↶ Undo in the scene takes it back. Another shot's camera opens that shot first.
- **A playhead** runs across the timeline's layers at the open shot's time, and a click on the ruler moves it there
  (opening that shot).

## [0.128.0] - 2026-11-20

### Changed
- **📷 Generate photo and 🎬 Render video are in the 🏞 Scene menu** (V2 and the classic 3D scene window). The
  footer only has the hint now.
- **The position box is part of the side panel.** A selected object's (or the camera's) X, Y, Z, and the camera's pan,
  tilt, roll, lens, focus, aperture and shake, sit in its details instead of floating over the 3D view. In V2 they come
  right under its name and lines.

### Added
- **⚡ Quick photo and ⚡ Quick video** in the Scene menu, rough tests of an idea.
  - **Quick photo:** what the camera sees at the playhead, small (0.4 MP), on Qwen Image Edit's 4 steps. Its own work
    takes a few seconds, but the first one after another model (H3) was loaded waits for Qwen to load, a few minutes.
  - **Quick video:** a Draft on H3 at 4 steps (half the usual turbo steps), with no photo first and no gap fill. When
    the camera holds still, it starts from the scene's picture or a photo of its first frame that matches (a quick
    photo at 0 s will do). When the camera moves, it starts from the scene as drawn, a test of the motion.
- **Play controls:** ⏮ start, ⏴ a frame back, ▶ play, ⏵ a frame on, ⏭ end, and a Frame field to type the exact frame
  (of how many). Keys: Home, End, comma and full stop.

## [0.127.0] - 2026-11-20

### Changed
- **The 3D scene builder has a menu bar: 🏞 Scene, Edit and Add** (in V2 and the classic window).
  - **Scene:** save as a template, save the view, and the three depth-map exports.
  - **Edit:** undo, redo, and for the selected object: turn 90° left or right, set it down on the ground, duplicate,
    delete. What doesn't apply is greyed out.
  - **Add:** the shapes, a person and your 3D models.
  - The "Drag to" tools are gone. Dragging an object moves it (Shift: up or down), and its gizmo now has the rotation
    rings as well as the arrows. Size and stretch are in its properties, and G, R and S still grab, turn and scale from
    the keyboard.
  - The footer keeps 📷 Generate photo and 🎬 Render video.
- **Shot templates carry the shot.** A shot's words (setting, what happens, dialogue, sound, music, quality, its
  transition) are kept with its scene. A template made from it, listed in every project's ＋ New shot, starts new
  shots with them as well as the set and the camera.
- **V2's timeline, rebuilt.** It has a ruler and four layers:
  - 🎥 **Camera:** each shot's camera keys where they fall in the part used, with a line where it moves and the eased
    ones marked. Click to select that shot's camera.
  - 🎞 **Video:** the shots with thumbnails, sized by the part used, transitions as striped overlaps. Drag to reorder.
  - 🗣 **Sound:** each shot's dialogue lines and background sound.
  - 🎵 **Music:** the soundtrack, with its player.

  It folds away (▾), its height drags from its top edge (or ↑ ↓ on the grip), and it zooms (− Fit ＋).
- **A log while something is being made.** When a shot, a photo, a gap fill, a soundtrack or an export starts, the
  timeline gives way to the **Log**. Each job shows its steps and the studio's own log lines, with progress and elapsed
  time, and the jobs it ran (photo → gap fill → video). The timeline comes back a few seconds after everything is done,
  and either can be picked at any time.
- The shared menus take separators and greyed-out items.

## [0.126.0] - 2026-11-20

### Changed
- **V2's right-hand column follows the selection.**
  - Picking a shot in the list, or clicking empty space in the scene, shows the **Shot** details.
  - Selecting an object or the camera in the viewport shows **its** details there: the scene builder's own properties,
    with the selected thing's section first.
  - The 3D viewport takes the whole middle column.
  - Below 1180 px the same details open as a drawer from the top bar's button, which names what's selected
    (📝 Shot, 🧱 Box, 🎥 Camera).
- **Object details** start with its name (renaming it updates `{Name}` and the speakers in the shot's words) and its
  **lines in this shot**. ＋ Line adds one it says; the lines stay in the shot's dialogue, in order. Then its library
  entry (Edit…) or 💾 Save to the library (its shape, what it is and its picture).
- **Camera details** start with a camera move to apply at a framing, and 💾 Save this camera.
- **A new empty shot has a cube and a camera on it.** The camera is shown as an object in the scene, to select and
  move.

## [0.125.2] - 2026-11-20

### Fixed
- **V2 fits narrower windows.**
  - **Below 1400 px:** the side columns are slimmer, and so is the scene builder's own panel inside the viewport.
  - **Below 1180 px:** the library becomes a rail of icons (🎞 🧱 🎥), each opening its tab as a drawer over the
    viewport. The shot panel is a drawer opened from 📝 Shot in the top bar. A click in the viewport, Esc or picking
    a shot closes them, so the 3D viewport keeps nearly the whole width.
  - **Below 720 px:** the scene's properties go under the viewport.
  - The library tabs no longer wrap their labels.

## [0.125.1] - 2026-11-20

### Fixed
- **A person no longer appears twice in a photo of a 3D scene** (📷 Generate photo, a scene render's photo of its
  first frame, and V2). A Person with a picture is pasted into the render in the mannequin's place, and the same
  picture was also sent to the edit model as a reference. The model then drew that person a second time, as the
  picture shows them, beside the one pasted in. Now a pasted person's picture isn't sent. The edit model is told
  they were pasted in from a photo, to keep their face, hair and clothes, and that they appear once. Other objects'
  pictures still go along, and since pasted people no longer take up the edit model's picture slots, more of them fit.

## [0.125.0] - 2026-11-20

### Added
- **V2: composing and export (phase 5).**
  - **On the timeline,** in each shot's panel: where its video starts and ends (a trim), and how it joins the next
    shot. That's a cut, or a transition with a length: cross dissolve, dip to black or white, wipe, slide, smooth,
    circle, zoom or blur. The timeline sizes each shot by the part used and marks a transition with ⧖. The total
    allows for the overlaps.
  - **⬇ Export** renders the shots' latest videos as one, in order, trimmed and joined as set. The soundtrack goes
    under them at its own level, fading out at the end, and the shots' own sound at theirs. The format is MP4 (H.264
    or H.265), WebM or ProRes. A shot with no video yet is left out, and the dialog says so.
  - It's rendered as the classic timeline is (`app/render.py`, `/api/v2/export`) and shows up as a studio result in the
    project. The timeline bar shows its progress, then a link to the video.

## [0.124.0] - 2026-11-20

### Added
- **V2: sound (phase 4).**
  - **Dialogue lines:** a shot has any number of lines, in order, each said by one of its objects or by "Someone".
    A speaker named once is then called by what it is ("The young woman says"), not described all over again.
  - **Voices:** an object in the library can have a voice recording, 6 to 10 s of clear speech, cleaned up and its
    best part kept. When it has a line, the shot is spoken with it on H3 Reference (`<Audio N>`, up to 3 voices), and
    the Model box says so.
  - **Soundtrack:** 🎵 Soundtrack on the timeline makes one piece of music for the whole timeline with MiniMax Music 3,
    as long as the shots together, from a description and optional lyrics. It plays in a lane under the shots. While
    it's on, the shots are made without their own music and each shot's Music field is set aside.
  - Each shot's background sound and music go into H3's own sound fields, as before.
- **A 3D scene render can speak with reference voices.** The scene render (H3 with Time-to-Move) takes up to 3 voice
  recordings and then runs on H3 Reference, even with no object pictures.

## [0.123.0] - 2026-11-20

### Added
- **V2: the camera library (phase 3).** A 🎥 Cameras tab next to 🎞 Shots and 🧱 Objects.
  - **21 ready-made moves:** locked off, push in, pull back, orbit 360°, half orbit, arc left and right, track left and
    right, crane up and down, pan left and right, tilt up, low angle, top down, handheld, follow, zoom in, dolly zoom,
    and push in with a rack focus.
  - Each move is worked out round the shot's subject (the selected object, else the first person, else the first
    object) and over the shot's length. It starts from the side the camera is on now, at a **framing** (close-up,
    medium, wide, extreme wide) and **speed** (smooth, eased in and out, or steady).
  - Moves set what they need besides the path: the lens for a zoom or dolly zoom, focus keys and an aperture for the
    rack focus, the shake and its style for handheld and follow. Follow walks after a subject that has a path.
  - **Click a camera or drag it onto the viewport.** It replaces the shot's camera keys, and ↶ Undo in the scene
    takes it back.
  - **💾 Save** keeps a shot's own camera (its keys, lens, focus, shake and aperture) under Your cameras, relative to
    its subject. On another shot it fits that shot's subject and length the same way: a taller subject puts it further
    off. Saved cameras are shared by every project (`/api/v2/cameras`).

## [0.122.0] - 2026-11-20

### Added
- **V2: the object library (phase 2).** A 🧱 Objects tab next to 🎞 Shots holds people, props and 3D models to use
  in any project's shots.
  - Each object has a name (`{Name}` in a shot's text), a stand-in (a person, a shape or one of your 3D models), what it
    is, up to 9 reference pictures and up to 4 MiniMax H3 LoRAs with their strengths.
  - **Drag an object onto the 3D viewport** and it stands where you drop it, on the ground under the cursor. ＋ on an
    object puts it in front of the camera. Double-click an object to edit it.
  - In the scene, an object keeps its name, what it is and its first picture. A shot with pictured objects is made on
    H3 Reference, which keeps their look. The LoRAs of the library objects in a shot go with it to H3, and the shot's
    Model box says so.
  - The library is kept by the studio (`data/v2/objects.json`, `/api/v2/objects`). A scene's objects remember the
    entry they came from.

## [0.121.0] - 2026-11-20

### Added
- **Bob Studio V2 (phase 1)** at `/v2`, a shot-focused studio where the 3D scene is the main tool. The classic page stays
  at `/`, with a V2 ↗ link in its top bar (and Classic ↗ back).
  - **Shots** on the left: each one is a 3D scene. ＋ New shot starts one as an empty set (a floor and a sky) or as a
    copy of one of your scene templates.
  - **The 3D viewport** in the middle is the scene builder, drawn in the page: place objects and models, move them,
    key the camera (lens, focus, shake, crane), with its outliner and properties beside it.
  - **The shot panel** on the right holds the setting and environment, what happens (click an object's name to put
    it in), a line of dialogue and who says it, background sound, music and quality.
  - **The model is chosen for you**, with the reasons shown:
    - nothing in the set and a still camera → MiniMax H3 from the words;
    - objects or a camera move → the scene's render (H3 with Time-to-Move), starting from a photo of the first frame
      made with the setting, with the Qwen gap fill for what the camera move reveals;
    - objects with pictures → H3 Reference.
    Dialogue, background sound and music go into H3's own sound fields.
  - **The timeline** along the bottom has the shots in order, sized by length. Drag one to reorder it.
    🎬 Generate all makes every shot in order.
  - A project's V2 shots are kept apart from its classic settings (`data/v2/<project>.json`, `/api/v2/board`).
  - The scene builder can draw in a page element (`Scene3D.mount`). It also renders with its usual choices for a
    shot (`Scene3D.autoRender`), which the classic Shots step now uses too.

## [0.120.0] - 2026-11-20

### Added
- **Qwen fills in what the photo can't see** before a 3D scene renders a camera move from a photo. In a big move (a
  360° orbit, a long pan), much of each frame is something the photo never showed, and H3 used to invent it as it
  went, so the place changed as the camera came round. Now the scene finds the moment along the move that's about
  half covered by what it knows and draws that view with a wide lens. The objects are left out, and the photo is cut
  back from around them, so no streaks of a person lie on the ground. Qwen Image Edit paints the place into the
  rest, keeping the ground near the camera open and tall things in the distance. That view is then painted onto the
  scene like the photo. It repeats from the new edge until the whole move is mostly covered, up to 6 views (a full
  orbit takes about 5). The render follows them under the photo, each only near its own angle, so H3 sees the same
  surroundings all the way round.
  - **Fill what the photo can't see with Qwen first**, in the Render window, shows when the video starts from a photo
    and the camera moves. It's on by default and remembered, and Generate on the Shots step follows it. Each view
    takes about half a minute, and the filled views show up in the gallery.

## [0.119.1] - 2026-11-20

### Fixed
- **A big camera move from a photo no longer leaves black where the photo couldn't see** (3D scene render, H3). In a
  360° orbit, half of every frame is behind what the photo shows. Those gaps were filled from a blur of the photo,
  which ran out and went black, and H3 kept the black. In an empty scene, the gaps now show the scene's own sky and
  floor under the photo, so H3 carries the place on round the back. In a scene from a picture, a gap bigger than the
  blur takes the picture's average colour instead of black.

## [0.119.0] - 2026-11-20

### Added
- **3D scene templates.** ☆ Save as template, at the foot of a scene's window, keeps the scene as a template.
  ⋯ › ⭐ Save as a template does the same from a scene's card. ⭐ From a template…, in the Shots step's 3D scenes
  panel and in All scenes…, starts a new scene as a copy of one in the open project. The copy has the template's
  background, objects (with what each becomes), camera path and lens, length, framing, backdrop and effects. Change it
  as you like; the template stays as it is. Templates show ⭐ on their cards and are offered in every project. Pressing
  ⭐ Template again stops it being one.

## [0.118.1] - 2026-11-20

### Changed
- **The photo of a 3D scene for an H3 Image shot follows the Settings step's Aspect and Quality.** It used to take
  the scene's own shape at 1280 px on the long side. Now it has the picture shape you chose and H3 Image's size for
  the quality: Draft 1 MP, Standard 2, High 4, XL 8, Max 16. The shot camera keeps everything it frames, and in a
  different shape it sees a little wider or taller to fill the picture. With another edit model (Qwen Image Edit,
  MOSS Edit) the photo keeps that model's own size.

## [0.118.0] - 2026-11-20

### Added
- **MiniMax H3 Image has the Inputs and Shots steps**, with 3D scenes, as H3 video has. The Shots step takes the place
  of the Prompt step, and Generate makes one picture per shot.
  - **Inputs** holds its reference pictures (1 to 9), called `<Picture 1>`, `<Picture 2>`… in the shots.
  - **A shot** has a framing, an angle, a camera position, where it is (place and light), and who and what is there.
    Its prompt follows H3 Image's order: the look, the framing, the subject, the place, the camera. Length, camera
    move, spoken line, sound and music are left out, since a picture has none. "Write the prompt myself" works as
    for video, and ✨ Write and 🪄 Enhance write the fields (with the reference pictures in view).
  - **Several shots** make one picture each, with one seed so they look alike. A single shot keeps its takes.
  - **A shot mapped to a 3D scene** (＋ New scene from this shot, Use a scene…, or the 🏞 3D scenes panel) becomes a
    photo of that scene: what its shot camera sees at 0 s, turned into a photograph by the edit model (MiniMax H3
    Image when it's there). It keeps where everything is, and the shot's text and the look say how it looks. Its
    `<Picture N>` tags become the objects that have those pictures (a Person without one takes it), and those
    pictures go along.
  - Reuse on an H3 Image result brings its prompt back as a shot.
- **MOSS Edit has the Inputs step** for its pictures (the photo to edit, then up to 3 references).

### Fixed
- H3 Image's and MOSS Edit's pictures were on the Inputs step, which only showed for video, so there was no step to
  add them on.

## [0.117.0] - 2026-11-19

### Added
- **🔎 Score** for a finished picture or video, in the Result window's details: five checks, each 0 to 100 with its
  reasons, and an overall score. Weights: prompt 35 %, identity 20 %, camera 20 %, quality 15 %, settings 10 %; a check
  that doesn't apply is left out.
  - **Prompt**: the vision model breaks the prompt it was made with into 6 to 12 yes/no checks (who, how they look,
    what they do, the place, light, framing, camera, style). It then answers each from 4 frames, with a reason. Sound and
    speech are left out, since frames can't show them.
  - **Reference identity**: each reference picture's face against the faces in 12 frames (InsightFace ArcFace):
    average and worst frame. It notes when the faces are too small to compare well.
  - **Camera**: a 3D scene render is compared with the camera move it was given: how much of its outline the video
    keeps, and whether the video moves the same way (direction and size). Any other video is tracked for its camera
    move (static, left, right, up, down, in, out, roll) and checked against what the prompt says the camera does.
  - **Visual quality**: the vision model rates composition, lighting, sharpness and realism, and lists only defects it
    can point to (where, and in which frame). Each kind of defect costs points once.
  - **Settings**: size, aspect, length, frame rate and sound against the request.
  - The score shows as a chip in the Result window's bar (green, amber, red) and as a scorecard with every check, kept
    with the result. 🔎 Score again redoes it.
  - It uses the Prompt writer's vision model (Settings; for example qwen3-vl). Frames, faces and motion are measured in
    ComfyUI's own Python (OpenCV, PyAV, InsightFace with buffalo_l), so nothing new is installed. It takes about half a
    minute.

## [0.116.2] - 2026-11-19

### Fixed
- **A camera move started from a photo no longer leaves a ghost** (3D scene render, H3 and H3 Reference). The photo is
  painted back onto the scene so H3 starts from it. Only objects that moved were cut out of it, so a still object's
  real shape in the photo (a coat wider than the mannequin, its shadow) stayed painted on the ground behind it. As the
  camera moved, that paint slid off as a see-through second person, which H3 copied. Now, when the camera moves,
  every object in the photo is found (SAM 3) and cut out, and the gaps the move opens are left for H3.
- **No glow round people after a camera move.** The gaps a camera move opens were filled from the colours next to them,
  a person's included, and H3 kept that as a coloured halo. They're now filled from the background alone.

## [0.116.1] - 2026-11-19

### Fixed
- **📷 Generate photo goes through the shot camera** whenever the camera is an object in the scene, even while you look
  at it from outside. Before, from outside, it photographed your outside view, and its object list and text described
  that view. 🌫 Save depth map does the same.
- **Where an object is, as the photo and video models are told, follows what shows in the frame.** It was judged by the
  object's centre, so an object whose centre was just above the frame (only its lower part, or nothing, showing) was
  told as "in the middle", and the edit model added one there. Now it's the visible part of the object's outline:
  left, middle or right, and at the top or bottom, with "partly out of frame" when most of it is cut off. An object
  that doesn't show isn't listed.

## [0.116.0] - 2026-11-19

### Added
- **🏗 Crane move…** (Camera section): the shot camera rides a crane (jib) arm round a pivot behind it, starting at the
  playhead.
  - Settings: the arm's length; the length of the move; the boom from and to (degrees up from level, so the camera
    rises or lowers); a swing round the pivot (+ to the left); whether the camera keeps looking at the same point or
    keeps facing along the arm; and the speed (eases in and out, or steady).
  - It writes camera keys every quarter second along the arc, replacing the keys in that time (↶ Undo takes it back).
    Lens, roll, focus (kept on what it looks at) and shake carry on from the camera at the playhead.
  - From outside, while the move plays, the rig is drawn: the post, the arm to the camera and its counterweight.
  - A run of many keys now shows a faint camera at only its first and last key.

## [0.115.0] - 2026-11-19

### Added
- **Camera shake** for the shot camera, in the floating box:
  - **Shake**: an amount from 0 to 100 %, keyed with the camera. A key without one keeps the amount before it, so key
    0 % and 60 % to make it start shaking, or ramp it down.
  - **Style**, for the whole camera:
    - Handheld: a gentle sway.
    - Walking: bobs and sways with each step.
    - Vehicle: a fast vibration.
    - Earthquake: violent.
  - The shake is smooth, natural-looking noise that turns the camera a little about its eye and moves it a little, on
    top of its path. The keys and the gimbal stay on the smooth path, so editing never bakes the shake in.
  - You see it when you look through the camera, in the corner preview and on the camera drawn from outside, as you
    scrub or play. The 🎬 Render draws it, so H3 follows it, and H3 is told ("The camera is handheld, with a natural
    slight shake."). A shake alone counts as a camera move. Key chips and the preview's label show the amount.

## [0.114.0] - 2026-11-19

### Added
- **Depth of field blur in the view.** With an aperture set on the shot camera, what it sees is blurred by its depth of
  field: in the view while you look through the camera, and in the 📺 corner preview from outside. It follows the focus
  distance (rack focus too), lens and aperture as you scrub or play, computed per pixel from the scene's depth (a thin
  lens). A sharp subject keeps clean edges against a blurred background.
  - View › **Depth of field blur** turns it off. Renders, photos and what H3 follows stay sharp: H3 and the photo are
    told the depth of field instead. 💾 Save view saves the view as drawn, blur included.

## [0.113.0] - 2026-11-19

### Fixed
- **A shot mapped to a 3D scene now follows the scene's camera when you press Generate.** Before, Generate made the shot
  from its text alone ("The camera holds a static shot") unless you had used the scene's 🎬 Render › Goes to the shot.
  Now Generate first draws the scene into the shot when it isn't there yet, or when the scene has changed since. It
  opens the scene, draws the camera move and what H3 follows, and makes the first picture (a photo of the first frame
  when there's no matching one, about a minute). It uses the shot's What happens and quality, then sends the video
  in order with the other shots.
- A shot's `<Picture N>` reference pictures go into the scene. A Person in the scene without a picture takes the
  shot's reference, so a render on H3 Reference keeps that person's look. The Render window says when it did that.

### Added
- **Focus distance and depth of field for the shot camera**, in the floating box:
  - **Focus**: the distance in focus, keyed with the camera. Change it between keys for a rack focus; a key without one
    keeps the focus before it. **⌖ On…** focuses on one of the objects the camera sees.
  - **Aperture**: Off (everything sharp) or f/1.4 to f/16, for the scene's camera. The box shows what's sharp (from …
    to …) and what's in focus.
  - From outside, the plane in focus is drawn in yellow, with faint near and far limits. The preview's label shows the
    aperture and focus distance.
  - H3 and the photo of the first frame are told the depth of field: what's in sharp focus and that the rest is softly
    blurred, or that the focus pulls from one thing to another.

## [0.112.0] - 2026-11-19

### Added
- **Easing for camera keys.** Each camera key sets how the camera gets to the next key: **Steady** (the same speed all
  the way, as before), **Ease in** (starts slowly), **Ease out** (slows into the next key) or **Ease in and out**.
  - Move the playhead to a key (click its chip) and choose under the keys in the Camera section. The chip shows it
    (0.00 s · 35 mm · ease in-out).
  - It shapes the whole move, turn, zoom and roll on that stretch, and the camera still reaches every key at the time
    it was keyed.
  - The dolly path's dots each second show it: they bunch up where the camera is slow. The view, the preview, 🎬 Render
    and 📷 Generate photo all follow it.

## [0.111.0] - 2026-11-19

### Added
- **Dolly path preview for the shot camera.** Seen from outside, a moving camera's path shows a dot at each whole
  second (so you can see where it speeds up or slows down) and a faint camera at each key, besides the camera at the
  playhead.
- **📺 Preview what it sees** (Camera, on by default with the camera as an object): a small picture in the corner of
  the view shows what the shot camera sees at the playhead, in the shot's shape. It follows the dolly move, zoom and
  roll as you scrub or ▶ play, and its label gives the time, lens and roll. Your own view stays outside.

## [0.110.0] - 2026-11-19

### Added
- **Roll for the shot camera.** Its gimbal has a third, smaller ring about the way the camera looks, and the floating
  box has **Roll** next to Pan and Tilt, in degrees (+ leans the top of the frame to the right, up to ±180). Ctrl snaps
  it to 5°. Roll is keyed with the camera like the rest, so rolling between keys makes a Dutch-angle move. The view
  through the camera, its drawn frame, 🎬 Render and 📷 Generate photo all follow it. A roll alone counts as a camera move.
- Stepping outside the camera (orbiting, panning or zooming after 👁 Look through it) gives a level view at the scene's
  lens, not the camera's roll and zoom.

### Fixed
- Dragging the camera's gimbal between keys could lose a keyed lens (the new key took the scene's lens).

## [0.109.0] - 2026-11-19

### Added
- **Zooms: the lens is keyed with the camera.** The floating box's Lens now sets the shot camera's focal length at the
  playhead and keys it there. Key a different lens at another time and the camera zooms between them, in the view, the
  drawn camera frame, the 🎬 Render and 📷 Generate photo. Keys without a lens use the scene's: View › Lens in an empty
  scene, the picture's own in a picture scene. A zoom from a key without a lens eases out of the scene's lens and back.
  - Camera keys show their lens (0.00 s · 35 mm). A zoom alone counts as a camera move for the render.
  - Picture scenes can zoom too: a longer lens than the picture's pushes in on it. A wider one is allowed, but the box
    warns that the picture's edges are empty there.

### Changed
- The floating box's Lens no longer changes the scene's lens (View › Lens does that); it keys the camera's.

## [0.108.0] - 2026-11-19

### Added
- **Lens in the floating position box** while the shot camera is selected: its focal length in mm (on a 36 mm wide
  frame) with how wide it sees. Type any value from 10 to 300 mm, or pick 18, 24, 28, 35, 50, 85, 135 or 200 from its
  list. In an empty scene it is the scene's lens (the same as View › Lens, which then shows a typed value too), so it
  changes the frame and the render, and undo takes it back. A picture scene shows the picture's own lens, estimated from
  it, and keeps it (the field is read-only there).

## [0.107.0] - 2026-11-19

### Added
- **The shot camera as an object in the scene builder.** When a scene is mapped to a shot, it opens looking at the
  shot camera from outside, behind and above it. The camera is drawn as a frame (what it sees), a body and an up mark,
  with its path when it moves. Camera › **The camera as an object** turns it on for any scene.
  - Click the camera (or 🎥 Select it) for its own gimbal. The X, Y and Z arrows move it; the rings **pan** it (about Y)
    and **tilt** it (about its own sideways axis), turning it about its eye. Ctrl snaps the position, and the angles to
    5°. Each change keys the camera at the playhead (the first change makes its first key). ◆ Key the camera keys it
    as it is there.
  - **👁 Look through it** shows what it sees; orbiting, panning or zooming steps back outside, and **↩ Outside**
    goes back behind it. From outside, moving the playhead keeps your view while the camera moves along its path.
- **A floating position box** over the 3D view while an object or the camera is selected. It shows X, Y and Z at the
  playhead (metres in an empty scene), plus Pan and Tilt for the camera, and you can type values (Enter to apply). A
  typed value keys the object or camera there as a drag would. Drag the box by its top: it remembers where you put it.
  × hides it until you select something else.

## [0.106.0] - 2026-11-19

### Added
- **Shots are mapped to 3D scenes, with their inputs.** On the Shots step (H3, H3 Reference, one video per shot), a
  shot can have its own 3D scene:
  - **＋ New scene from this shot…** in the shot's Edit window (or 🏞 New 3D scene from this shot in its ⋯ menu, or
    🎞 For a shot… on the 3D scenes panel). The scene starts from the shot's own picture (the keyframe it starts or
    ends on, or a reference picture its text names), another Inputs picture, or none. It takes the shot's length,
    and an empty scene takes the project's picture shape. It's named after the shot and opens at once.
  - **Use a scene…** maps one of the project's scenes to the shot; the panel's ⋯ menu also has For shot N and Not for
    shot N any more. A scene belongs to one shot.
  - The scene's **🎬 Render** then goes to its shot by default, with the shot's What happens filled in. The shot's
    `<Picture N>` tags become the objects that have those pictures, so each reference picture maps to an object.
  - An object's Picture has **📥 Inputs…**, which picks a keyframe or reference picture from the Inputs step.
  - The shot list shows a dim 🏞 on a shot whose scene isn't rendered in yet, and warns that it renders from text
    until it is. The panel shows **→ Shot N** on each mapped scene. Unlink in the Edit window leaves the scene;
    deleting a scene unlinks it.

## [0.105.0] - 2026-11-19

### Added
- **A 3D scene's render can go into a shot.** The scene's 🎬 Render window has a **Goes to** list: render it now (the
  gallery, as before), one of the Shots step's shots, or a new shot. The shot keeps what the render drew (the rough
  animation, its mask and the first picture: the scene's picture, a photo, or its first frame as drawn), and Generate
  on the Shots step sends it in order with the other shots, onto the timeline.
  - In the shot list it shows 🏞 with the scene's first picture. Its Edit window has a 🏞 3D scene section: the text H3
    reads (editable), 🏞 Open the scene, and Remove. Its length is the scene's; the other fields aren't used. The shot
    list's sound and music, and the Settings step, still apply.
  - It renders only in "One video per shot" (putting a scene in a shot switches the list to it), starts with a cut,
    and doesn't take the last frame of the shot before.

## [0.104.0] - 2026-11-19

### Added
- **The Shots step has a 🏞 3D scenes panel** for the models a 3D scene renders with (MiniMax H3 and H3 Reference):
  this project's scenes as thumbnails (click one to open the scene builder, ⋯ or right-click to rename or delete),
  **＋ New empty scene**, **From an Inputs picture…** (a keyframe or reference picture in depth) and **All scenes…**.
  Scenes still being made show as such and the panel updates when they're ready.

## [0.103.0] - 2026-11-19

### Added
- **MOSS-Image Edit as an edit model in the image editor**, beside Qwen Image Edit 2511 and MiniMax H3 Image: for
  **Edit the whole picture**, and for **Generate photo** in Animate objects and the 3D scene (up to 3 object
  pictures). It runs like the MOSS Edit model: the edit LoRA, skip-layer guidance, 30 steps at CFG 4, at 1 MP, then
  scaled back to the picture's size. Pick it in the editor's Edit model list or in Settings › AI edits.
  - Not for Erase and Replace with…: those mark the selection with a magenta patch, which MOSS Edit doesn't read
    (in tests it left the ivy it should have erased, and left the patch in a replace). With MOSS picked, those two
    buttons say to pick Qwen Image Edit or H3 Image.

## [0.102.0] - 2026-11-19

### Added
- **MOSS Edit** as an image model: ComfyUI's “MOSS-Image: Image Edit” template. It changes a photo by a short
  instruction and keeps the rest.
  - Add the photo to edit in the Inputs step (Picture 1); the result keeps its shape. Draft, Standard and High are
    0.5, 1 and 1.5 MP (the template uses 1 MP; much smaller makes the model re-frame the subject).
  - Up to 3 more pictures (a garment, a face, a prop) as references; say in the prompt what each is for.
  - Write only the change, as the edit LoRA was trained: “Change only the jacket to a black wool coat. Keep the face,
    pose and background unchanged.” The Prompt tab's live rewrite has a MOSS Edit style that writes it that way.
  - Runs what the LoRA's author ships: the Moss-Image-Edit LoRA on the MOSS checkpoint, skip-layer guidance on layer
    22, 30 steps, CFG 4, euler/normal, both prompts seeing the pictures.
  - Needs ComfyUI 0.43 or later and `moss_image_edit_lora_rank_64_bf16` (297 MB, from
    [Comfy-Org/MOSS-Image](https://huggingface.co/Comfy-Org/MOSS-Image)) in a loras folder, besides MOSS Image's files.

## [0.101.0] - 2026-11-19

### Added
- **MOSS Image layout control with bounding boxes.** With MOSS Image picked, the Prompt step has a **▣ Layout** panel
  under the prompt: a canvas the shape of the picture where you drag to draw boxes, drag a box to move it and its
  corner to resize it.
  - Each box is **Text** (the exact words to draw, one line per line), **Object** or **Character** (a person or
    creature), with a short description such as the typeface and color, or what the thing looks like.
  - Boxes are drawn in order, background first; ↑ and ↓ change the order. The prompt becomes the whole scene's caption.
  - Bob sends MOSS the same JSON layout prompt ComfyUI's “MOSS-Image Layout Prompt” node builds (each box in pixels
    from the canvas centre), so no extra nodes are needed.
  - Enhance prompt is skipped while the layout is on, because it would rewrite the boxes (ComfyUI's layout templates
    leave it off too).
  - The layout is saved with the project and restored by Reuse settings.

## [0.100.0] - 2026-11-19

### Added
- **MOSS Image** as an image model ([OpenMOSS MOSS-Image](https://github.com/OpenMOSS/MOSS-Image), Apache-2.0): an
  open 5B model that draws text inside the picture well (put it in double quotes) and reads long, detailed prompts.
  - Runs as ComfyUI's own “MOSS-Image: Text to Image” template does: 25 steps, CFG 2.5, er_sde, its standard negative
    prompt; Draft, Standard and High are 0.5, 1 and 2 MP. OpenMOSS's slower official settings (50 steps, CFG 3,
    euler) can be picked in Settings › Advanced.
  - Uses the SFT checkpoint when installed, else Base; the Base checkpoint gets the template's skip-layer guidance
    (layer 22). Either can be picked in the Model step's diffusion model list.
  - **Enhance prompt** has MOSS's own Qwen3.5 text encoder turn a short idea into the long caption it was trained
    on, keeping quoted text word for word.
  - The Prompt tab's live rewrite has a MOSS style, and the live view suggests a longer caption when a prompt is
    short.
  - Needs ComfyUI 0.42 or later and three files from [Comfy-Org/MOSS-Image](https://huggingface.co/Comfy-Org/MOSS-Image):
    `moss_image_sft_int8_convrot` (or a Base checkpoint), `qwen3.5_9b_w4a8_gptq` and `flux2-vae_small`.

## [0.99.0] - 2026-11-19

### Added
- **H3 Image: Clean texture** (on by default), from [ComfyUI-H3-Image-EasyFix](https://github.com/PedroMarinhoDev/ComfyUI-H3-Image-EasyFix)
  (Apache-2.0). Plain H3 Image text-to-image often gives skin, fur and stone a grainy, speckled texture; this nudges
  the first step toward cleaner texture (Steering, strength 0.7) and redraws the fine texture on steps 3 to 5
  (Re-Noise Sampler, RNmid, noise 0.95, euler_ancestral), on H3 Image's official 6-step sigmas. It needs the node
  pack in ComfyUI (the switch says so when it's missing) and runs on 6 steps with the default scheduler; a step count
  or scheduler of your own uses the plain sampler.
- **H3 Image: XL · 8 MP and Max · 16 MP** sizes (it's trained for 4 to 20 MP; High was the largest, 4 MP). A 16 MP
  picture takes about 40 s on a 32 GB card.

## [0.98.0] - 2026-11-19

### Added
- **✨ Enhance › FaceRefine** has a **Finish** choice: **Plus** or **Stock**. Plus uses
  [ComfyUI-H3-FaceRefine-Plus](https://github.com/AnniCodex/ComfyUI-H3-FaceRefine-Plus) when it's installed: Stitch
  Plus pastes only the refined face's detail over the shot's own light and colour (antialiased, so it doesn't
  shimmer), Flow Lock pins the new eyes, brows and mouth onto the head so the face stops wobbling, and Tone Match
  brings the colours, lips included, back to the source. A **Lip colour fix** checkbox turns off Tone Match's lip pass.
  Plus is the default; without the pack the option is greyed out and FaceRefine works exactly as before (the stock
  H3 Face Stitch). The same choice is in Settings › Post-Processing, and the time estimate counts the extra passes.

## [0.97.3] - 2026-11-18

### Fixed
- **📷 Generate photo** with a Person that has a picture puts that person in the mannequin's place instead of next
  to it. Told to swap them, Qwen mostly kept the mannequin too (beside the person, or wearing their clothes). Now the
  person is cut out of their picture (SAM 3), stood on the mannequin's feet as tall as it is standing, and pasted into
  the render where the mannequin was, hidden behind anything in front of it; the mannequin isn't drawn. The edit
  model is told to keep them there, pose them as the mannequin was (sitting, walking…) and blend them in. A video
  that starts from a new photo gets the same. Without SAM 3, or a picture with no whole person in it (cut off at the
  feet), it works as before.

## [0.97.2] - 2026-11-18

### Fixed
- **🎬 Render video** from a photo (a new photo of the first frame, or an earlier one) moves the real thing, not the
  stand-in. The edit model seldom puts a person exactly where the mannequin stood, so the mannequin walked off with
  the wrong part of the photo (H3 drew a grey mannequin) and the person in the photo stayed behind, standing on the
  ground or left as a pale copy. Now each moving object is looked for in the photo (SAM 3, the same model as AI
  select, near its stand-in and by what it becomes), its whole path is moved over the ground and its size changed
  so it starts where and as big as the photo has it, and it carries only what was found there, on every side as it
  turns. Where it stood (a little more, for its shadow) is left for H3 to fill in once it has gone. Without SAM 3,
  or when nothing is found near the stand-in, it works as before.
- What H3 reads for a video that starts from a photo names each object by what it becomes and where it is ("the
  woman (on the left, walking)"), not by its stand-in ("the light grey human figure"), which had H3 add a grey
  mannequin to the photo's scene.
- The edit model is told not to add people or large objects the render doesn't have (one test photo came back with
  an extra man).

## [0.97.1] - 2026-11-18

### Fixed
- **📷 Generate photo** turns the scene's objects into what you say they are. Qwen keeps whatever it isn't told to
  change, so text alone ("a woman next to a pile of trash") came back as a woman and a pile of trash *beside* the grey
  mannequin and the grey cone. The window now has a **What each object becomes** field for each object in view (the
  same Becomes as on its panel, saved with the scene), and each one is sent as "the light grey cone on the right
  becomes a large pile of trash". Objects that become something are stand-ins that keep only their place, size and
  pose. A Person with nothing filled in becomes a real person, never the mannequin. The window shows the whole text
  the edit model gets, updated as you type.

## [0.97.0] - 2026-11-18

### Added
- **📷 Generate photo › Use the depth map** (with Qwen Image Edit 2511). A depth map of the view, drawn through the same
  camera at the same size as the render, goes along as Picture 2, and Qwen is told to keep the depth, layout and
  proportions it shows: it holds the scene together when the look changes a lot (a whole new setting or style), where
  the render's grey clay look could otherwise stay or the layout wander. It takes one of Qwen's two extra pictures, so
  one object picture fits beside it; the window says which is which and what's left out. The choice is remembered.
  Hidden for MiniMax H3 Image, which isn't made for depth maps.

## [0.96.0] - 2026-11-18

### Changed
- **Depth map PNGs are plain 8-bit greyscale** (one channel, no alpha), this frame and the full-size sequence alike,
  as depth ControlNet tools expect; the grey levels are unchanged and the files are several times smaller. (A browser
  without CompressionStream still gets the RGBA PNGs from before.)

## [0.95.0] - 2026-11-18

### Added
- **Save depth map › The whole clip: full-size PNGs in a .zip.** Every frame of the clip as its own PNG at full size
  (1280 px on the long side), numbered from 00000 at the scene's 24 fps, with the same brightness range throughout,
  for depth ControlNet workflows that load an image sequence.

## [0.94.0] - 2026-11-18

### Added
- **🌫 Save depth map…** in a 3D scene (next to Save view): this frame as a PNG (1280 px on its long side), or the
  whole clip as a video, through the render's camera. It's the kind depth ControlNets (MiDaS, Depth Anything) expect:
  near is white, far is black, scaled as inverse depth between the nearest and farthest things in view, and the open
  sky is black. Exact, from the scene itself rather than estimated; a clip uses one range for all its frames, so it
  doesn't flicker. Persons appear in their poses and walk cycles.

## [0.93.0] - 2026-11-18

### Added
- **Face where it's going** for any object in a 3D scene (on its panel, above Rotation). While it moves, it turns to
  face the way it goes, following the curve of its path; when it stops it keeps the heading it last moved with.
  Rotation Y is then added on top (0 faces straight ahead, 180 walks backwards) and its keys keep only that. With a
  Person's walk cycle, it walks where it's facing.

### Fixed
- An object that stops (two keys in the same place) no longer drifts past its stop and back: paths ease into and out
  of a hold. A walking Person now stops stepping when it stops.

## [0.92.0] - 2026-11-18

### Added
- **Walk cycle for the Person** in 3D scenes (Walk cycle, next to Pose: Off, Walk or Run). While the person moves along
  its path, its legs and arms swing in a walking or running gait, its steps matching how far it goes (one cycle of two
  steps is about 0.8 of its height walking, 1.45 running), so its feet don't slide; when it stops, it eases back into its
  keyed pose. The photo and video models are told it's walking or running. Turn it to face the way it goes: the walk
  cycle doesn't steer it.

## [0.91.0] - 2026-11-18

### Added
- **A Person's pose can change over time.** Pick a pose with the playhead anywhere but the start (or once it has keys)
  and it's keyed there, like moving it; between two keys the arms and legs move smoothly from one pose to the next
  (standing → sitting → waving). The Pose list shows the pose at the playhead. The video model is told the sequence,
  e.g. “the grey human figure in the middle, standing, then sitting, then waving with the right hand,”.

### Changed
- A Person keeps the same scale whatever its pose, standing on its own centre line, so it doesn't slide when an arm
  goes up; its feet (or knees) stay on the ground.

## [0.90.0] - 2026-11-18

### Added
- **Poses for the Person** in 3D scenes (Pose, on its panel): Standing, Walking, Running, Sitting, Kneeling, Waving,
  Pointing, Arms raised, Hands on hips and T-pose. The person keeps its feet (or knees) on the ground and any stretch
  you gave it; sitting is shorter and deeper than standing, so seat it on a cube. The photo and video models are told
  the pose too, e.g. “the red human figure on the left, sitting”. Waving and pointing use the person's right arm.

## [0.89.0] - 2026-11-18

### Added
- **🧍 Person** in 3D scenes (on the tool bar's Add row and in the right-click menu): a standing mannequin, 1.74 m tall,
  facing the camera, with a small nose so you can tell which way it faces. Like the other shapes it has a colour, a
  size (width, height, depth) and the move, rotate and resize gizmos, and it can be keyed. The photo and video models
  are told about it as, e.g., “the red human figure on the left”; give it a Becomes (“a woman in a yellow raincoat”)
  or a Picture to say who it should be.

## [0.88.0] - 2026-11-18

### Added
- **📷 Generate photo uses the objects' pictures too** (“Use the objects' pictures”, on by default when an object in
  view has one). The render is Picture 1 and the objects' pictures are Picture 2 on: MiniMax H3 Image takes up to 8 of
  them (named <Picture 2>…), Qwen Image Edit 2511 up to 2 (named Picture 2…); the window says which object is which
  picture and which are left out. The edit model is told, e.g., “the red cube on the left becomes the golden retriever
  from <Picture 2>”. A render's “new photo of the first frame” uses them when the render does.

### Fixed
- Generate photo told the edit model to keep every object's shape and colour exactly, which fought against Becomes. When
  an object becomes something, only where it is and its size are kept.

## [0.87.0] - 2026-11-18

### Added
- **A Picture for each object in a 3D scene**, for a render on H3 Reference (on the object's panel; 🖼 in the objects
  list). ✂ From the picture cuts the object out of the picture it was made from, on white. Choose… takes a file, or
  drop one from the gallery, the media library or your PC.
- **🎬 Render can use those pictures**: “Use the objects' pictures (H3 Reference)”. The video then runs on H3
  Reference's model (ref2va) with the same Time-to-Move motion. The first frame is <Picture 1> (held at 0.00 s,
  as keyframes are), and the objects' pictures are <Picture 2> on, up to 8. {Name} is sent as, e.g., “the golden
  retriever from <Picture 2> (the red cube on the left)”, and objects with a picture that the text doesn't mention
  are added as “The blue sphere on the right looks like <Picture 3>.” The window says which object is which picture,
  and the preview shows what H3 reads. It needs H3 Reference installed (see the Model step).

## [0.86.0] - 2026-11-18

### Added
- **Becomes**, for each object in a 3D scene (on its panel, and shown in the objects list): what the photo and the video
  should make of it, e.g. “a wooden crate” or “a golden retriever”. The models only see the render, so this tells them
  what a grey cube really is.
- **The models are told about objects by what they can see.** Each object is described by its colour and shape (or a
  3D model's name), where it is in the frame at that moment (left, middle or right; in front or at the back), and what
  it becomes. Two that would read the same are told apart left to right. 📷 Generate photo sends, e.g., “The objects in
  it: the red cube on the left becomes a golden retriever; the blue sphere on the right.”, and its window shows that line.
- **{Name} in 🎬 Render's text.** Chips over “What happens” insert an object's tag, and it is sent as that object's
  description: “{Dog} runs to {Ball}” becomes “The golden retriever (the red cube on the left) runs to the blue sphere
  on the right.”, so it stays tied to the right shape after you move or rename things. Objects with a Becomes that the
  text doesn't mention are added as “The red cube on the left is a golden retriever.” A preview under the text shows what
  H3 reads and flags a name that matches no object.

## [0.85.0] - 2026-11-18

### Added
- **Undo and redo** in 3D scenes: ↶ Undo and ↷ Redo on the tool bar, Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z). Every
  change to the scene is a step: objects, shapes, camera keys, length, and an empty scene's shape, lens and backdrop.
- **Gizmo on the selected object**, as in Blender, for the tool picked under Drag to. ✥ Move shows red, green and blue
  arrows that move the object along the scene's X, Y and Z axes. ⟳ Rotate shows rings that turn it about each axis.
  The rings use gimbal axes: Y stays upright, X turns with Y, and Z turns with both. ⤢ Resize shows handles that
  stretch the object along its own axes, and a middle ball that sizes the whole object. Hold Ctrl while dragging to
  snap (0.1 m, 15°, 10%). With G, R or S, press X, Y or Z to work along one axis only.
- Objects turn about X and Z as well as Y, and these turns are keyed too. Rotation X, Y and Z replace the Turn slider
  in the side panel. Objects turn about the middle of their box. ⬇ Set it down rests the lowest corner of a turned
  object on the ground.

### Changed
- Stretching a shape changes its width, height or depth. A 3D model keeps its stretch with the scene instead. The
  shape's "Stands" choice is gone: use the rotate rings or the Rotation fields.

## [0.84.0] - 2026-11-18

### Added
- **3D scene tool bar**: **Add** primitive shapes (cube, sphere, cylinder, cone, plane, ring) or one of your 3D models;
  **Drag to** picks what dragging an object does (✥ move, ↕ raise, ⟳ rotate, ⤢ resize); and buttons for the selected
  object (turn 90° left or right, set it down on the ground, duplicate, delete). On a narrow window the buttons show
  only their icons.
- **Right-click menus** in 3D scenes. On an object (in the view or the Objects list): move, raise, rotate or resize it
  following the mouse until a click (Esc or right-click cancels), turn it 90°, make it bigger or smaller, set it down on
  the ground, size/tilt/colour, duplicate, rename, hide, delete. On the ground: add a shape (or a 3D model) right
  there. Keys: G move, L raise, R rotate, S resize, Shift+D duplicate, Del delete.
- A shape's **colour**, **size** (width, height, depth: metres in an empty scene) and **tilt** (upright, tipped forward,
  on its side, upside down) are in the side panel. Shapes are saved with the scene.
- 📷 Generate photo tells the edit model the objects' names, so a cube named "wooden crate" comes out as one.

## [0.83.0] - 2026-11-17

### Added
- **📷 Generate photo…** in Animate objects (the footer, next to 🏞 3D scene): the picture as it is at the playhead
  (the empty background when there is one, each object where you put it, turned, flipped and recoloured), at the
  picture's own size, made into one natural photograph by the image editor's whole-picture edit (Qwen Image Edit 2511
  or MiniMax H3 Image), which blends the objects in (light, shadows, edges) and keeps them where they are. Without an
  empty background it warns that a moved object still shows at its old place.

## [0.82.0] - 2026-11-17

### Added
- **A 3D scene's video can start from a photo** (Render video › Start from):
  - **A new photo of the first frame**: the scene's first frame is turned into a photograph (as 📷 Generate photo does,
    with an optional look), then the video is made from it. The dialog waits for the photo (about a minute) with the
    scene open.
  - **An earlier photo** of the scene, labelled when it was taken from another view than the video starts with.
  - Chosen by default: a photo of the first frame when there is one, else a new photo (or the picture, for a scene
    that starts as its picture). Starting from a photo sets "Follow the plan" to Loosely.
- **Projection mapping** for a photo-started video: the rough animation H3 follows is the photo painted onto the
  scene from the camera it was taken from (floor, background, a far sphere for the rest, and each object in its pose at
  that moment), so it moves with the 3D but looks like the photo; frame 0 is the photo. What that camera couldn't see
  (an object's hidden side, the floor it uncovers) is a hole, filled with the colours around it and left to H3 by the
  mask. Before this, H3 followed the plain render and the video turned back into it after the first frame.
- Photos made in a scene are remembered with the time and camera they were taken from (`photos` on the scene).

### Fixed
- A finished result could be marked failed with "Access is denied … history.json" when another program had the
  history file open at that moment (antivirus, a backup, a script reading it): the save now retries for up to about
  two seconds.

## [0.81.0] - 2026-11-17

### Added
- **Empty 3D scenes** (☰ › New empty 3D scene, or ＋ New empty scene in 🏞 3D scenes): a scene with no picture, to
  build a shot out of 3D models. A floor with a 1 m grid 1.6 m under the camera, a sky colour, and optionally a
  picture far behind as a backdrop; its shape (16:9, 9:16, 1:1, 4:3, 21:9) and lens (18 to 135 mm) are set in the
  View section. 3D models stand on the floor side by side at 1 m tall; move, turn, size and keyframe them as in any
  scene. 🎬 Render video starts H3 from the scene's own first frame.
- **📷 Generate photo…** in any 3D scene: draws what the camera frames (at the playhead) and has the image editor's
  whole-picture edit (Qwen Image Edit 2511, or MiniMax H3 Image) turn it into a photograph that keeps where
  everything is; an optional description sets the look. The photo shows up in the gallery.
- A frame on the scene view shows what the camera captures (the shot's shape), with the rest shaded.

### Changed
- The scene window's "Save picture of this view" is now **💾 Save view**.

## [0.80.0] - 2026-11-17

### Added
- **🧊** buttons on the Inputs step, next to 🏞: on the first and last frame (when there's a picture in them) and on
  each reference picture. Each starts Make 3D for that picture.
- A finished 3D model opens on this PC: **🖥 Open in 3D app** (the app Windows uses for .glb files, such as Blender;
  Windows asks which app when none is set) and **📂 Show in folder** (Explorer, with the file selected), in the 3D
  viewer's footer and in the model's ⋯ menu in 🧊 3D models. Only the studio's own model files, by id.
- API: `POST /api/models3d/{id}/open` with `how` `app` or `folder`.

### Changed
- A reference picture's buttons sit in one row along the top (🧊 🏞 ⋯); its ✨ marker moves down a row.

## [0.79.0] - 2026-11-17

### Added
- **🏞** buttons on the Inputs step: on the first and last frame (when there's a picture in them, next to its ×) and
  on each reference picture (next to its ⋯). Each opens that picture as a 3D scene.

## [0.78.0] - 2026-11-17

### Added
- **🏞 3D scene…** button in the Animate objects window's footer, next to Generate (the side panel's 3D section was
  easy to miss): it opens the picture as a 3D scene with its objects, any 3D models already made from them, and the
  empty background when there is one.

## [0.77.0] - 2026-11-17

### Added
- **🏞 3D scene…** buttons next to 🧊 Make 3D… on a picture in the gallery and on the Media page (selection bar and
  right-click menu): they open the picture as a 3D scene.

## [0.76.0] - 2026-11-17

### Added
- **🧊 Make 3D…** buttons on a picture in the gallery (the result's buttons, next to 🔄 Angles…) and on the Media page
  (the selection bar with one picture selected, and the picture's right-click menu).

## [0.75.1] - 2026-11-17

### Added
- A 3D scene's render can go on the timeline by itself: **Add it to the timeline when it's done** in the Render
  dialog (on by default, remembered), as the Shots step does. It goes at the end of the first video track of the
  scene's project, and survives a page reload while it waits.

### Fixed
- The scene's Render dialog said "queued" even when H3 refused the request; it now keeps the dialog open and says so.

## [0.75.0] - 2026-11-17

### Added
- **🎬 Render video…** in a 3D scene: MiniMax H3 makes the shot from the picture, following the scene (Time-to-Move,
  as Animate objects does).
  - The page draws the scene's rough animation frame by frame along its camera path (or the picture's own camera when
    it has no keys), at the picture's aspect, for the H3 length of the scene; then its mask: the whole rendered view when
    the camera moves (the holes a move opens are left to H3), otherwise only the objects.
  - The holes a camera move opens (nothing drawn there) are filled with the colours around them in the rough
    animation, so H3 doesn't start from black there; the mask still leaves them to H3.
  - Frames are drawn and encoded without timers, so rendering keeps its speed if the tab goes to the background.
  - Start from the picture (chosen when the scene starts as the picture does) or from the scene's first frame.
  - What happens (optional), quality and how tightly to follow the plan, as in Animate objects.
- `POST /api/frames/video`: numbered pictures from the page become a video at 24 fps.
- Request fields `motion_video` and `motion_video_mask` (engine `motion`): a rough animation and its mask drawn
  elsewhere, fitted to the render's size (centre crop) and length (the last frame held) instead of plate and layers.

### Fixed
- A 3D model placed in a scene is sized to fit both the height and the width of its object in the picture. A model that
  came out flatter than the object (TRELLIS.2 sometimes makes a box as a slab) was blown up by its height alone.

## [0.74.0] - 2026-11-17

### Added
- **Keyframes in 3D scenes**: a timeline under the view with play (Space), a scrubber and the scene's length (1 to
  10 s, on the H3 frame grid at 24 fps, as in Animate objects).
  - **Objects**: moving, turning or sizing one at the playhead keys it there (before it has keys, at 0 s this just
    places it). It moves along a smooth curve through its keys, with turn and size changing in a straight line; its path
    shows in yellow when selected. Its keys are listed to jump to or remove.
  - **Camera**: **◆ Key the camera** keeps the current view at the playhead; two or more keys make a camera move
    (an orbit about a point, eased through the keys). Looking around doesn't change the path: when the view is off it,
    the path shows in blue with the camera at the playhead, and moving the playhead puts the view back on it. Clear its
    keys to free it.
  - Keys, the camera path and the length are saved with the scene (`objects[].keys`, `camera_keys`, `seconds`).

## [0.73.0] - 2026-11-17

### Added
- **🏞 3D scenes**: a picture in depth with 3D models standing in it, seen through the picture's own camera.
  - From a picture's menu (results or the Inputs step), or **🏞 Open as a 3D scene** in Animate objects, which brings
    its objects (with any 3D models already made from them) and uses the empty background when there is one.
  - The background becomes a surface with Depth Anything 3, which also estimates the camera. Its mesh comes skewed
    (the camera is in the model's working size), so the page rebuilds it from each point's place in the picture and its
    depth; looking through the picture's camera shows the picture itself.
  - Each object's 3D model stands where the object was: on the ground just under its foot, sized by its height in the
    picture, facing the camera. Objects without a model have a 🧊 Make 3D button; they stand in the scene when ready.
  - Drag to orbit, right-drag to pan, wheel to zoom, 🎥 back to the picture's camera; drag an object over the ground,
    Shift+drag to raise it; Turn, Size, Put back, Hide and Remove in the side panel; add any other 3D model.
  - ☰ › **3D scenes** lists them (open, rename, delete). Scenes are kept in `data/scenes3d.json`.
- API: `POST /api/scenes`, `GET /api/scenes`, `GET` / `PATCH` / `DELETE /api/scenes/{id}`; capability `editor.scene3d`.

## [0.72.0] - 2026-11-17

### Added
- **🧊 Make 3D**: a textured 3D model (GLB) of the object in a picture, with TRELLIS.2 (ComfyUI's "Pixal3D / TRELLIS.2
  image to model" template, its TRELLIS.2 branch: structure, shape upsampled to 1536, texture, then remeshed,
  decimated, UV-unwrapped, with colour, normal and ambient-occlusion maps baked).
  - From a picture's menu in the results or on the Inputs step (the background is taken out with BiRefNet), or from an
    object's right-click menu in Animate objects (that object's mask is used).
  - Detail: Standard (200k faces, 2K texture) or High (700k faces, 4K texture).
  - It's made in the background; ☰ › **3D models** lists the models (making, done or failed), with Open, Download .glb,
    Make again (a new seed), Rename and Delete.
- **3D viewer** for a model (WebGL 2, no libraries; reads the GLB itself): drag to orbit, right-drag or Shift+drag to
  pan, wheel to zoom, F or double-click to frame; Texture, Clay and Wireframe looks, a floor grid, a turntable, and
  Save picture of this view.
- API: `POST /api/make3d`, `GET /api/models3d`, `PATCH` / `DELETE /api/models3d/{id}`; capability `editor.make3d`.

- A model takes about 3 to 10 minutes on a 32 GB card, depending on the object (denser shapes take longer).

### Changed
- The auto-updater also waits while a 3D model is being made.

## [0.71.0] - 2026-11-17

### Added
- **Right-click an object in Animate objects** for its tools:
  - **Size** and **Turn** (−180° to 180°, or ↺ / ↻ 90°), **Flip** and **Upside down**: keyed at the playhead like a
    drag, so they change along the path (size and turn ease between keys, flips switch at a key). The side panel
    has Turn and Upside down too.
  - **Colour** of the whole object: hue, saturation and brightness, with Reset colour.
  - **✎ Erase parts…**: a brush (size on the bar under the picture) that takes bits out of the object, such as
    something SAM picked up by mistake; Done (or Esc) makes the object again from what's left.
  - **🗑 Remove object**.
- The server draws turns, upside-down flips and colour exactly as the preview does (same order and maths), and erased
  parts are left out of the object's mask.
- When an object is already changed at the start (moved, sized, turned, flipped, recoloured or partly erased), H3
  starts from the rough animation's first frame instead of the untouched picture, so the shot opens the way it was
  set up (`motion_first: "composite"`). Shots with objects in motion do the same.
- Request fields: each `motion_layers` frame may add rotation and upside-down flip
  (`[dx, dy, scale, flip, rotation, flip upside down]`), each layer an `adjust` (`hue`, `sat`, `bri`).

## [0.70.0] - 2026-11-17

### Added
- **Objects in motion in Shots** (step 3 of h3-motion's layering technique). In One video per shot, a shot's Edit
  window has an **Objects in motion** section: pick a picture (a reference picture or the first frame on the Inputs
  step) and **🎬 Animate objects…**. The Animate objects window opens in a "Use for this shot" mode: find the objects,
  make the empty background, key their paths (or use a tracked path) and how tightly to follow, then **Use for this
  shot**; the Edit window comes back with the plan (🎬 Edit… reopens it with its objects, keys and background;
  Remove drops it). The shot shows 🎬 in the list.
- Such a shot renders with the Animate objects engine from that picture, its objects on their paths, with the
  shot's own text (its `<Picture N>` tags become those subjects' descriptions in words, since this model takes no
  reference pictures), length, quality and the run's shared seed. It doesn't take reference pictures, voices or the
  last frame of the shot before, so it starts with a cut; the shot after it can still carry on from its last frame
  or continue it without a cut. It takes its turn in a chained run, and the Shots preview shows its exact prompt.
- Saved with the project as the shot's `motion` (docs/PROJECT_FORMAT.md).

## [0.69.0] - 2026-11-17

### Added
- **🎯 Track an object** in a video (a video's menu in the results), step 2 of h3-motion's layering technique.
  - **Pick it:** go to a frame where it's clearly seen and click it (Shift+click marks what isn't it), or type its
    name.
  - **Track:** SAM 3.1 finds it on that frame and follows it frame by frame, up to 15 s (frames are tracked at a
    512 px short side). The studio then measures each frame's mask, drops frames whose size or position jumps off
    the line of its neighbours, fills the gaps, smooths the path (a local quadratic fit) and simplifies it into
    keys. The path shows over the video, with a marker that follows the object as it plays.
  - **Save path:** kept in `data/tracks.json`. In 🎬 Animate objects, pick an object and choose it under
    **Use a tracked path**: the object moves and scales the same way (moves as a share of the frame), on the same
    curve as hand-made keys, and the shot takes the path's length (up to 10 s). Drag keys afterwards to adjust.
  - New endpoints `POST /api/track`, `GET`/`POST /api/tracks`, `DELETE /api/tracks/{id}` (`app/tracking.py`,
    `workflows.build_track`).

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
