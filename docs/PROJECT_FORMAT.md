# Project file format (`bob.project/2`)

Each project is a folder under `projects/` (or `BOB_PROJECTS_DIR`) that holds a
`project.json`. The app validates it with the models in
[`app/projectfile.py`](../app/projectfile.py); [`project.schema.json`](project.schema.json)
is the JSON Schema generated from them (`python -m app.projectfile`).

Experiment mode uses the same format, stored in `data/experiment/project.json`
with the id `experiment`.

```jsonc
{
  "schema": "bob.project/2",      // format id; older files are upgraded when loaded
  "id": "c0fe065ef9fe",           // stable id: results point here, so renaming or moving is safe
  "name": "Night Drive",
  "created": 1794745798.95,       // Unix seconds
  "modified": 1794745979.86,
  "app_version": "0.7.0",         // the Bob Studio version that last saved it
  "notes": "Rainy alley, two cars.",
  "thumb": "outputs/2026-11-15/35af3b43106d_00001_.png",

  "settings": { … },              // the studio form, saved as you work
  "config":   { … },              // per-project preferences
  "library":  { … },              // media, tags, ratings and virtual folders
  "timeline": { … }               // the edit: tracks, clips, markers (added in 0.8.0)
}
```

## `settings`: the studio form

Saved automatically, a moment after any change. Unknown keys are kept, so newer
versions can add fields without breaking older files.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `video` \| `image` \| `audio` | What the Model step is making |
| `engine` | object | Model per kind, e.g. `{"video": "h3ref", "image": "klein", "audio": "h3"}` |
| `prompt`, `lyrics` | string | Prompt text; lyrics for Music 3 |
| `aspect`, `quality` | string | e.g. `"16:9"`, `"draft"` |
| `seconds` | number | Requested length (H3 snaps to its 17k+5 frame grid) |
| `seed`, `steps` | number or string | `-1` / `""` mean random / automatic |
| `batch` | 1–4 | Takes per run |
| `turbo`, `enhance`, `fidelity` | boolean | Turbo LoRA, FLUX prompt upsampler, max reference detail |
| `refs` | `[{ref, url, desc?}]` | H3 Reference pictures, in `<Picture N>` order; `desc` is the picture's description from ⋯ › Describe with AI |
| `audios` | `[{ref, url}]` | H3 Reference sounds (voices to clone; a sound file or a video's soundtrack), in `<Audio N>` order, up to 3 |
| `loras` | `[{name, strength}]` | LoRAs on the model, applied in order after the model (and H3's turbo LoRA). `name` is as ComfyUI lists it under `models/loras`; strength −4…4 |
| `enhance_after` (request only) | object or `null` | Settings › After generating: the Enhance chain to run on the result when it's done |
| `shots` | object or `null` | The Shots step (video): `{v: 2, mode: "each"\|"multi", style, soundscape, music, idea, ideaShots, ideaSeconds, creativity, subjectsOn, autoMatch, autoTimeline, list}` (`autoMatch`: rewrite the shots to fit when the look, sound or music changes; default on) (`autoTimeline`: put each finished video on the timeline; default on) (`subjectsOn`: put the reference pictures' definitions, `refs[].desc`, at the top of every shot prompt as `<Picture N>: …`); each shot is `{id, title, notes, brief (the one-line idea for ✨), seconds, framing, angle ("low angle", "overhead"… or ""), setting, action, position (where the camera stands, or ""), camera, dialogue, voice ("<Audio N>" or ""), speaker ("<Picture N>" who says the line, H3 Reference, or ""), raw + rawOn (its own prompt)}`. Shots have no frames, picture choice or settings of their own: the Inputs step's first frame starts shot 1 and its last frame ends the last shot, every shot uses all the reference pictures, and the Settings step applies to every shot (older `first_frame`, `last_frame`, `refs` and `over` keys are dropped on open). A file without `v: 2` is upgraded on open: shots that were on are kept; otherwise the Prompt step's text becomes shot 1's own prompt |
| `clean_audio` | bool | Clean the sounds and keep their best 6–10 s of speech (the `H3RefAudioPrep` node, when installed) |
| `frames` | `{first_frame, last_frame}` | Keyframes, each `{ref, url}` or `null` |

## `config`: preferences

```jsonc
"config": {
  "gallery": {                     // the Inputs media gallery
    "source": "library",           // library | results | uploads | vf:<folder id> | bm:<bookmark id>
    "thumb_size": 132,             // 72–320 px
    "sort": "added",               // added | name | modified | kind
    "descending": true,
    "kind": "all"                  // all | image | video | audio
  },
  "writer": { "backend": null, "model": null, "dialogue": false, "shots": null },
  "autosave": true,                // Project settings: false = save with Ctrl+S or the Save button
  "autosave_delay": 0.7,           // seconds after the last change (0.2–300)
  "defaults": {}                   // settings to reset to (reserved)
}
```

## `library`: media, tags and virtual folders

The library collects references to files; it never moves or copies them.

```jsonc
"library": {
  "media": [{
    "id": "4f1c2a9b7d10",
    "ref": "outputs/2026-11-15/35af3b43106d_00001_.png",
    "kind": "image",               // image | video | audio
    "name": "35af3b43106d_00001_.png",
    "added": 1794746000.0,
    "source": "output",            // upload | output | bookmark | other
    "tags": ["Night", "cars"],     // case-insensitive, unique, 40 characters max
    "rating": 0,                   // 0–5
    "note": ""
  }],
  "tags": [{ "name": "Night", "color": "" }],   // colour: "#rrggbb" or "" for automatic
  "virtual_folders": [{
    "id": "a1b2c3d4e5f6",
    "name": "Night cars",
    "tags": ["Night", "cars"],
    "match": "all",                // all = every tag, any = at least one
    "kinds": [],                   // limit to these kinds; empty = all
    "created": 1794746100.0
  }]
}
```

`rating` is also how studio results are rated in the Results bin: rating or tagging a result adds
its file to the library.

## `timeline`: the edit

Saved as you work (or with Ctrl+S when auto-save is off). Times are seconds on the frame grid (`1/fps`).

```jsonc
"timeline": {
  "fps": 24,
  "tracks": [                      // top to bottom; an upper video track covers the ones below
    { "id": "…", "kind": "video", "name": "V1", "muted": false, "solo": false, "locked": false, "hidden": false,
      "volume": 1, "pan": 0, "height": 56 },
    { "id": "…", "kind": "audio", "name": "A1", "muted": false, "solo": false, "locked": false, "hidden": false,
      "volume": 1, "pan": 0, "height": 44 }    // volume 0–2 (×), pan −1 left … 1 right; any solo = only soloed tracks heard
  ],
  "clips": [{
    "id": "…", "track": "<track id>", "ref": "outputs/2026-11-15/b20789d2c88a_00001_.mp4",
    "kind": "video",               // video | image (a held still) | audio
    "name": "Rainy alley",
    "start": 2.5,                  // where it begins on the timeline
    "trim_in": 0.25,               // first second of the source used
    "trim_out": 2.0,               // last second used (exclusive); length = trim_out − trim_in
    "source_duration": 2.333,      // null for stills
    "volume": 1, "color": "",       // volume 0–2 (× the source; 0.5 ≈ −6 dB)
    "pan": 0, "muted": false,       // the clip's own sound: pan −1…1, mute
    "fade_in": 0, "fade_out": 0.5,  // seconds of sound fade at the start / end (transitions add their crossfade)
    "vol_keys": [                   // volume keyframes (they replace "volume"); t = source time
      { "t": 0.0, "v": 0.0, "ease": "linear" }, { "t": 1.5, "v": 1.0, "ease": "linear" }
    ],
    "cam": null,                    // camera clips only (kind "camera" on the Camera track), see below
    "fx": {                         // Video Fx (null = none); pictures on video tracks only
      "enabled": true,
      "exposure": 0, "contrast": 1, "saturation": 1,   // stops, ×, ×
      "temperature": 0, "tint": 0,  // −100…100: cooler/warmer, green/magenta
      "look": "none",               // none | bw | sepia
      "vignette": 0, "blur": 0, "sharpen": 0, "grain": 0,
      "lights": [{                  // up to 4
        "mode": "relight",          // relight (brightens what's there) | glow (adds light) | shade (darkens)
        "x": 0.2, "y": 0.3,         // position as a fraction of the picture
        "x2": 0.8, "y2": 0.3,       // optional: where it travels to by the clip's end
        "radius": 0.35,             // × the picture's shorter side
        "intensity": 1, "color": "#ffd890", "flicker": 0
      }],
      "keys": [{                    // keyframes (optional): the animatable settings at moments of the clip
        "t": 0.25,                  // source time: seconds into the file (stays put when trimming/splitting)
        "ease": "smooth",           // to the next key: smooth | linear | hold
        "values": { "exposure": 1.5, "contrast": 1, "saturation": 1, "temperature": 0, "tint": 0, "vignette": 0, "blur": 0 },
        "lights": [{ "x": 0.2, "y": 0.3, "radius": 0.35, "intensity": 1, "flicker": 0, "color": "#ffd890" }]
      }]
    },
    "job": "b20789d2c88a",         // the studio result it came from
    "link": "9c1e…",               // clips with the same link move, trim, split and delete together
    "audio_off": true              // a video whose sound is on its linked audio clip instead
  }],
  "transitions": [{                // two clips on one track overlap; the overlap is the transition
    "id": "…", "track": "<track id>",
    "a": "<outgoing clip id>", "b": "<incoming clip id>",
    "type": "fade"                 // ffmpeg xfade name: fade, fadeblack, fadewhite, dissolve, wipeleft…, slideleft…,
                                   // smoothleft…, coverleft/right, circleopen/close, radial, zoomin, pixelize,
                                   // hblur, squeezeh, horzopen. Audio tracks always crossfade.
  }],
  "link_audio": true,              // adding a video with sound also puts its sound on an audio track
  "link_audio_track": "free",      // free = the existing audio tracks (first free one) | own = an audio track of its own per video ("new", the old default, reads as free)
  "master": { "volume": 1, "loudness": -14, "limiter": true },  // loudness: null or −36…−6 LUFS (two-pass loudnorm)
  "markers": [{ "id": "…", "t": 0.5, "label": "Marker 1", "color": "" }],
  "playhead": 1.21, "zoom": 60,    // pixels per second
  "range_in": 0.5, "range_out": 3.0, // In/Out: Render can export just this range
  "snap": true,
  "render": {                      // the Render dialog's last choices (free-form; all optional)
    "filename": "My cut", "folder": "",          // "" = outputs/<date>; else outputs or a bookmarked folder
    "format": "mp4-h264",          // mp4-h264 | mp4-h264-nvenc | mp4-h265 | webm-vp9 | mov-prores | wav | mp3
    "size": "s1080",               // original | s2160…s480 (short side) | 1920x1080 | 1080x1920 | 1080x1080 | custom
    "fps": "", "quality": "high", "speed": "balanced", "range": "all",
    "audio": true, "audio_bitrate": 192, "sample_rate": 48000, "channels": 2, "loudness": "mixer",
    "timestamp": false,            // add "YYYY-MM-DD HH.MM.SS" to the file name
    "burn_timecode": false          // draw the timecode on the picture
  }
}
```

### Camera track

A track with `"kind": "camera"` (one, at the top) holds camera clips (`"kind": "camera"`, `"ref": ""`). Each has a
`cam` move that applies to the finished picture under it, as if it were a flat card in 3D:

```jsonc
"cam": {
  "enabled": true,
  "pan": 0, "tilt": 0, "roll": 0,   // degrees: turn, look up/down, rotate
  "zoom": 1,                        // focal length ×
  "dolly": 0,                       // toward the picture (0.5 = half way), negative = back
  "truck": 0, "pedestal": 0,        // sideways / up, in picture widths / heights
  "orbit": 0,                       // degrees around the picture's centre
  "shake": 0,                       // handheld, 0–1
  "fill": "black",                  // black | blur: what shows where the move uncovers the frame
  "keys": [{ "t": 0, "ease": "smooth", "pan": -12, "tilt": 0, "roll": 0, "zoom": 1, "dolly": 0, "truck": 0, "pedestal": 0, "orbit": 0 }],
  "reshoot": { "prompt": "", "references": [], "guides": 3, "quality": "draft", "seed": -1 },
  "depth": {                        // optional: Analyse depth (Depth Anything 3)
    "ref": "data/uploads/depth/<id>/depth.mp4",  // near = bright, 12 fps, smoothed over time
    "t0": 2.5,                      // timeline time of its first frame
    "sig": "k3x9a",                 // what was under the move (the page warns when it changed)
    "amount": 0.25                  // relief depth × the picture's width
  }
}
```

With `depth`, the render adds parallax first: from the depth and the camera's travel it builds displacement maps
(plane + parallax: a point standing h out of the card moves by −P·h/D for sideways travel P and away from the centre
by (x − W/2)·dz·h/D² for travel dz toward it) and `displace`s the picture, then the perspective warp does the
rotations. Big moves with a strong relief stretch at depth edges; the AI reshoot handles those.
`POST /api/timeline/depth {project, clip, sig}` runs the analysis (`app/depth.py`).

Rendering projects the card's corners through the camera each frame and maps the picture onto them with ffmpeg
`perspective` (sampled every 3 frames; long moves put the graph in a file). **AI reshoot**
(`POST /api/timeline/reshoot`) renders the picture under the move, warps it to the camera at evenly spaced guide
frames, masks what the move uncovers, has FLUX Klein fill those areas (the frame and reference pictures as
references), then MiniMax H3 makes the shot from the filled guides (first and last frames, guides between).
Guide frames are kept in `data/uploads/reshoot/`.

A transition's length is the overlap (`a.end − b.start`), and each clip uses its own frames, so no spare footage
is needed.

Rendering (`POST /api/timeline/render`, `app/render.py`) uses ffmpeg. `GET /api/timeline/formats` lists the
formats this ffmpeg can write and the places a render can be saved:
- **Picture:** at each moment the uppermost visible video track wins, and gaps are black.
- **Sound:** every clip with sound on an unmuted (and, when anything is soloed, soloed) track is mixed in: clip ×
  track volume, pan, its fades, and crossfades at transitions. Linked sound clips on other tracks crossfade with
  their videos' transition. Then the master: volume, loudness normalisation (measured first, then applied), and a
  limiter at −0.5 dBFS.
- **Result:** the file comes back as a studio result in the same project, with a step-by-step log (shown in the
  Activity console). An existing file is never overwritten: a number is added to the name.

`GET /api/timeline/fcpxml?project=<id>` exports the same timeline as FCPXML 1.9 for DaVinci Resolve.
- **Tracks:** the bottom video track becomes the storyline, and the other tracks become lanes.
- **Transitions:** on the storyline, a transition becomes a cut in the middle of the overlap plus a Cross Dissolve
  spanning it. On other tracks, overlaps become cuts.
- **Video Fx:** a clip's effects run on its own picture before it's placed: grade (ffmpeg `eq`, `colorchannelmixer`,
  `colortemperature`), lights as soft masks drawn with `geq` at quarter size and blended in RGB
  (relight `A·(1+I·B)`, glow `A+I·B`, shade `A·(1−d·B)`, the ratio idea from AInVFX Paint a Plate, Apache-2.0),
  then `vignette`, `gblur`, `unsharp` and `noise`. FCPXML doesn't carry them.
  With keyframes, contrast, saturation, the vignette and lights become frame expressions of time, and exposure,
  tint, temperature and blur are sent as per-frame `sendcmd` commands. Before the first key and after the last,
  values hold.
- **Linked sound:** a video whose sound moved to a linked clip is exported at −96 dB, so the sound isn't doubled.
  Muted clips are too. Pan, fades and the master aren't exported; set them in Resolve's mixer.

### Versions

Every project keeps its previous `project.json` files in `<project>/.history/` (Experiment: `data/experiment/.history/`).

- **Automatic versions:** kept at most every N minutes while the project changes, plus one each time the app starts
  (`project-…-startup.json`, skipped when nothing changed). Only the last N are kept. Both limits come from the app
  settings (`data/settings.json`, `projects.version_minutes` and `projects.versions_keep`; defaults 1 minute and 30).
- **Named versions:** `.history/labels.json` maps a version file to its name. Named versions are never pruned;
  **Save a version** makes one (`POST /api/projects/{id}/versions` `{label}`). `PUT`/`DELETE
  /api/projects/{id}/versions/{file}` names, renames or deletes a version.
- **Listing and restoring:** **Versions…** lists them newest first, each with what changed since the one before
  (`GET /api/projects/{id}/history`; the first row, `file: null`, is the current state). It can restore one
  (`POST /api/projects/{id}/restore`). The state being replaced is first kept as a named version, "Before going back
  to …".
- **File names:** `project-YYYYMMDD-HHMMSS[-tag][-n].json`. The tag is `startup` or `before-restore`; `n` counts the
  versions kept in the same second. Versions are ordered by when they were kept (the file's modified time).

### Duplicating

`POST /api/projects/copy {id, name, folder?, timeline, library, results}` makes a new project folder next to the
original (or in `folder`). The new folder gets the original's files except `project.json`, `.history/` and other
dot-files, and a new `project.json`:
- **Identity:** a new `id`, `name` set to the folder's name (`Name (2)` when the name is taken), and fresh
  `created` and `modified` times.
- **Settings, config, notes and thumbnail:** always copied.
- **Timeline and library:** copied when asked, otherwise empty.

With `results`, each finished result of the original gets a copy of its record in the new project, with a new id
and `copied_from` set to the original result's id. The copies point at the same output files. Deleting a result
"with files" keeps any file another result still uses. Experiment (`id: "experiment"`) can be copied too; its
results are the ones that have no project.

### Media refs

A `ref` names a file the app is allowed to read:

- `data/uploads/<file>`: pictures you uploaded or imported,
- `outputs/<date>/<file>`: generated results,
- an absolute path with forward slashes, e.g. `D:/Pictures/cast/anna.jpg`, inside a
  **bookmarked folder**.

Anything else is refused. Bookmarks are app-wide, like Explorer's Quick access, and
are stored in `data/library.json`. Tags and virtual folders belong to a project.

### Waveforms

`GET /api/media/peaks?path=<ref>` returns `{rate, seconds, peak[], rms[]}`: per bucket (100 a second, 25 for files
over 10 minutes) the peak and RMS level, 0–255. It's cached in `data/thumbs/` as `*.peaks.json`, and audio clips
on the timeline are drawn from it.

### Thumbnails

Thumbnails are made on first view and cached in `data/thumbs/` as WebP: pictures
with Pillow, video frames and audio waveforms with ffmpeg (`BOB_FFMPEG` to point at
it). The cache key includes the file's size and modified time, and the URL carries
the modified time, so browsers keep them indefinitely and an edited file gets a new
one.

## Migration

| From | What happens |
|---|---|
| `bob.project/2` from 0.14 | No change needed: `vol_keys` is empty and `cam` is `null`. |
| `bob.project/2` from 0.13 | No change needed: `fx.keys` is empty. |
| `bob.project/2` from 0.11–0.12 | No change needed: `clips[].fx` is `null` (no effects). |
| `bob.project/2` from 0.10 | No change needed: mixing fields default to neutral (volume 1, pan 0, no fades, no solo), `master` has no loudness target and the limiter on, `link_audio_track` is `"free"`, and auto-save is on. |
| `bob.project/2` from 0.8–0.9 | No change needed: `transitions` (empty) and `link_audio: true` are added on load. |
| `bob.project/2` from 0.7.0 | No change needed: `timeline` is added with one video and one audio track the first time the project loads. |
| `"version": 1` (0.6.0) | `schema` is set, and `config` and `library` are added with defaults. Pictures already used as inputs (`settings.refs` and `settings.frames`) become the first library items. |

The upgrade is written back the next time the project saves.
