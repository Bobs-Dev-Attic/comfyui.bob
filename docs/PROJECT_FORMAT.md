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

Saved as you work. Times are seconds on the frame grid (`1/fps`).

```jsonc
"timeline": {
  "fps": 24,
  "tracks": [                      // top to bottom; an upper video track covers the ones below
    { "id": "…", "kind": "video", "name": "V1", "muted": false, "locked": false, "hidden": false, "volume": 1, "height": 56 },
    { "id": "…", "kind": "audio", "name": "A1", "muted": false, "locked": false, "hidden": false, "volume": 1, "height": 44 }
  ],
  "clips": [{
    "id": "…", "track": "<track id>", "ref": "outputs/2026-11-15/b20789d2c88a_00001_.mp4",
    "kind": "video",               // video | image (a held still) | audio
    "name": "Rainy alley",
    "start": 2.5,                  // where it begins on the timeline
    "trim_in": 0.25,               // first second of the source used
    "trim_out": 2.0,               // last second used (exclusive); length = trim_out − trim_in
    "source_duration": 2.333,      // null for stills
    "volume": 1, "color": "",
    "job": "b20789d2c88a"          // the studio result it came from
  }],
  "markers": [{ "id": "…", "t": 0.5, "label": "Marker 1", "color": "" }],
  "playhead": 1.21, "zoom": 60,    // pixels per second
  "range_in": 0.5, "range_out": 3.0, // In/Out: Render can export just this range
  "snap": true,
  "render": {}                     // export settings (reserved: width, height, crf)
}
```

Rendering (`POST /api/timeline/render`, `app/render.py`) uses ffmpeg:
- **Picture:** at each moment the uppermost visible video track wins, and gaps are black.
- **Sound:** every clip on an unmuted track that has sound is mixed in, at its clip and track volume.
- **Result:** the MP4 comes back as a studio result in the same project.

`GET /api/timeline/fcpxml?project=<id>` exports the same timeline as FCPXML 1.9 for DaVinci Resolve. The bottom
video track becomes the storyline, and the other tracks become lanes.

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
| `bob.project/2` from 0.7.0 | No change needed: `timeline` is added with one video and one audio track the first time the project loads. |
| `"version": 1` (0.6.0) | `schema` is set, and `config` and `library` are added with defaults. Pictures already used as inputs (`settings.refs` and `settings.frames`) become the first library items. |

The upgrade is written back the next time the project saves.
