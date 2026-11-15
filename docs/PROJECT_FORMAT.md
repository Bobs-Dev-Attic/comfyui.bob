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
| `refs` | `[{ref, url}]` | H3 Reference pictures, in `<Picture N>` order |
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
  "link_audio_track": "new",       // new = an audio track of its own per video | free = the first free audio track
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
    "audio": true, "audio_bitrate": 192, "sample_rate": 48000, "channels": 2, "loudness": "mixer"
  }
}
```

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
- **Linked sound:** a video whose sound moved to a linked clip is exported at −96 dB, so the sound isn't doubled.
  Muted clips are too. Pan, fades and the master aren't exported; set them in Resolve's mixer.

### Earlier versions

Every project keeps its previous `project.json` files in `<project>/.history/` (Experiment: `data/experiment/.history/`),
at most one a minute while it changes, plus one each time the app starts (`project-…-startup.json`, skipped when
nothing changed), the last 30. **Earlier versions…** on the Project step lists them and can restore one
(`GET /api/projects/{id}/history`, `POST /api/projects/{id}/restore`). The state being replaced is kept as a version
first.

### Media refs

A `ref` names a file the app is allowed to read:

- `data/uploads/<file>`: pictures you uploaded or imported,
- `outputs/<date>/<file>`: generated results,
- an absolute path with forward slashes, e.g. `D:/Pictures/cast/anna.jpg`, inside a
  **bookmarked folder**.

Anything else is refused. Bookmarks are app-wide, like Explorer's Quick access, and
are stored in `data/library.json`. Tags and virtual folders belong to a project.

### Thumbnails

Thumbnails are made on first view and cached in `data/thumbs/` as WebP: pictures
with Pillow, video frames and audio waveforms with ffmpeg (`BOB_FFMPEG` to point at
it). The cache key includes the file's size and modified time, and the URL carries
the modified time, so browsers keep them indefinitely and an edited file gets a new
one.

## Migration

| From | What happens |
|---|---|
| `bob.project/2` from 0.10 | No change needed: mixing fields default to neutral (volume 1, pan 0, no fades, no solo), `master` has no loudness target and the limiter on, `link_audio_track` is `"new"`, and auto-save is on. |
| `bob.project/2` from 0.8–0.9 | No change needed: `transitions` (empty) and `link_audio: true` are added on load. |
| `bob.project/2` from 0.7.0 | No change needed: `timeline` is added with one video and one audio track the first time the project loads. |
| `"version": 1` (0.6.0) | `schema` is set, and `config` and `library` are added with defaults. Pictures already used as inputs (`settings.refs` and `settings.frames`) become the first library items. |

The upgrade is written back the next time the project saves.
