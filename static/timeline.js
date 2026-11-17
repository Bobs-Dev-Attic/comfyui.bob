/* Multi-track timeline for the studio's bottom panel.

   Model (saved in project.json → timeline, see app/projectfile.py):
     tracks [{id, kind: video|audio, name, muted, locked, hidden, volume, height}]   upper video covers lower
     clips  [{id, track, ref, kind, name, start, trim_in, trim_out, source_duration, volume, job}]
     markers [{id, t, label}], playhead, zoom (px/s), range_in/out, snap, fps
   Times are seconds, kept on the frame grid. Dropping or moving onto other clips overwrites them
   (they are trimmed or split), like DaVinci. Playback is driven by a clock: the uppermost visible
   video clip is the picture, audio-track clips play alongside.

   Ideas from EDITS-WITH-AI (Apache-2.0), Imagination Studio (Apache-2.0) and the Sonder Editor
   docs (GPL-3.0: ideas only, no code). */
"use strict";

const TL = (() => {
  const UNDO_MAX = 200, SNAP_PX = 9;
  // Track header width comes from CSS (--head-w), so phones can use narrower headers.
  const headW = () => parseFloat(root ? getComputedStyle(root).getPropertyValue("--head-w") : "") || 148;
  const ZOOMS = [2, 4, 8, 12, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1200];
  let tl = null, project = "experiment", root = null, scroller = null;
  const sel = new Set();
  let undoStack = [], redoStack = [], saveTimer = null, clipboard = [];
  let playing = false, clock = null, raf = 0, showSeconds = false, loop = false, renderSize = "original", selTrans = null;
  const audioEls = new Map();
  const probes = new Map();

  const uid = () => Math.random().toString(16).slice(2, 14);
  const fps = () => tl?.fps || 24;
  const q = t => Math.max(0, Math.round(t * fps()) / fps());  // snap to the frame grid
  const dur = c => c.trim_out - c.trim_in;
  const end = c => c.start + dur(c);
  const track = id => tl.tracks.find(t => t.id === id);
  const clip = id => tl.clips.find(c => c.id === id);
  const total = () => Math.max(0, ...tl.clips.map(end));
  const esc2 = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function tc(t) {
    if (showSeconds) return `${t.toFixed(2)}s`;
    const f = Math.round(t * fps()), F = fps();
    const s = Math.floor(f / F), m = Math.floor(s / 60), h = Math.floor(m / 60);
    const p = n => String(n).padStart(2, "0");
    return `${h ? p(h) + ":" : ""}${p(m % 60)}:${p(s % 60)}:${p(f % F)}`;
  }

  function blank() {
    return { fps: 24, tracks: [{ id: uid(), kind: "video", name: "V1", muted: false, locked: false, hidden: false, volume: 1, height: 56 },
      { id: uid(), kind: "audio", name: "A1", muted: false, locked: false, hidden: false, volume: 1, height: 44 }],
      clips: [], markers: [], playhead: 0, zoom: 60, range_in: null, range_out: null, snap: true, render: {},
      transitions: [], link_audio: true, link_audio_track: "new", master: { volume: 1, loudness: null, limiter: true } };
  }

  /* ------------------------------------------------------------------ history and saving */
  const snapshot = () => JSON.stringify({ tracks: tl.tracks, clips: tl.clips, markers: tl.markers, range_in: tl.range_in, range_out: tl.range_out,
    transitions: tl.transitions, master: tl.master });
  function checkpoint() { undoStack.push(snapshot()); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = []; }
  function restore(s) { Object.assign(tl, JSON.parse(s)); for (const id of [...sel]) if (!clip(id)) sel.delete(id); selTrans = null; }
  function undo() { if (!undoStack.length) return toast("Nothing to undo"); redoStack.push(snapshot()); restore(undoStack.pop()); changed(); }
  function redo() { if (!redoStack.length) return toast("Nothing to redo"); undoStack.push(snapshot()); restore(redoStack.pop()); changed(); }
  function changed() { render(); save(); refreshMixer(); }
  // Auto-save lives in shell.js (Project settings). `soft` saves (playhead, zoom) don't count as unsaved changes.
  const auto = () => (typeof Autosave === "undefined" ? { enabled: true, delay: 0.7, mark() {}, dirty: new Set(), render() {} } : Autosave);
  function save(delay, soft = false) {
    clearTimeout(saveTimer);
    if (!auto().enabled) { if (!soft) auto().mark("timeline"); return; }
    saveTimer = setTimeout(saveNow, delay ?? auto().delay * 1000);
  }
  async function saveNow(force = false) {
    clearTimeout(saveTimer); saveTimer = null;
    if (!tl) return;
    if (!force && !auto().enabled) return;
    auto().dirty.delete("timeline"); auto().render();
    try {
      await fetch(`/api/projects/${project}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeline: tl }) })
        .then(r => { if (!r.ok) return r.json().then(j => { throw new Error(j.detail || r.statusText); }); });
    } catch (e) { toast(`Timeline not saved: ${e.message}`); }
  }

  /* ------------------------------------------------------------------ editing primitives */
  // Clear [t0, t1) on a track for incoming clips: trim, split or remove what's there.
  function carve(trackId, t0, t1, keep) {
    for (const c of [...tl.clips]) {
      if (c.track !== trackId || keep.has(c.id) || transPair(c, keep) || c.start >= t1 || end(c) <= t0) continue;
      if (c.start >= t0 && end(c) <= t1) { tl.clips.splice(tl.clips.indexOf(c), 1); sel.delete(c.id); }
      else if (c.start < t0 && end(c) > t1) {
        tl.clips.push({ ...structuredClone(c), id: uid(), start: t1, trim_in: q(c.trim_in + (t1 - c.start)) });
        c.trim_out = q(c.trim_in + (t0 - c.start));
      } else if (c.start < t0) c.trim_out = q(c.trim_out - (end(c) - t0));
      else { const d = t1 - c.start; c.trim_in = q(c.trim_in + d); c.start = q(t1); }
    }
  }
  function splitAt(c, t) {
    if (t <= c.start + 1 / fps() / 2 || t >= end(c) - 1 / fps() / 2) return null;
    const right = { ...structuredClone(c), id: uid(), start: q(t), trim_in: q(c.trim_in + (t - c.start)) };
    c.trim_out = q(c.trim_in + (t - c.start));
    tl.clips.push(right);
    return right;
  }
  function editable(c) { const t = track(c.track); return t && !t.locked; }

  /* ---- linked clips: a video and its sound (same `link` id) are edited as one */
  const grp = c => (c.link ? tl.clips.filter(x => x.link === c.link) : [c]);
  const withGroups = list => [...new Set(list.flatMap(c => grp(c)))];

  /* ---- transitions: two clips on one track overlap; the overlap is the transition */
  const transOf = id => tl.transitions.find(t => t.a === id || t.b === id);
  const transBetween = (a, b) => tl.transitions.find(t => t.a === a.id && t.b === b.id);
  function transPair(c, keep) { return tl.transitions.some(t => (t.a === c.id && keep.has(t.b)) || (t.b === c.id && keep.has(t.a))); }
  function sanitize() {
    tl.transitions = tl.transitions.filter(t => {
      const a = clip(t.a), b = clip(t.b);
      return a && b && a.track === t.track && b.track === t.track && a.start < b.start - 1e-6 && b.start < end(a) - 1e-6 && end(b) > end(a) + 1e-6;
    });
    if (selTrans && !tl.transitions.some(t => t.id === selTrans)) selTrans = null;
  }
  // After clips moved: clear their space on each track, drop transitions that no longer overlap, clear again.
  function settle(moved) {
    const keep = new Set(moved.map(m => m.id));
    for (const m of moved) carve(m.track, m.start, end(m), keep);
    sanitize();
    for (const m of moved) carve(m.track, m.start, end(m), keep);
    sanitize();
  }

  const probeInfo = new Map();  // ref → probe result, once known (sync access for drawing)
  async function probe(ref) {
    if (!probes.has(ref)) probes.set(ref, fetch(`/api/media/probe?path=${encodeURIComponent(ref)}`).then(r => r.ok ? r.json() : null)
      .then(j => { if (j) probeInfo.set(ref, j); return j; }).catch(() => null));
    return probes.get(ref);
  }

  /* Put media on the timeline. opts: {track, at}; default = end of the first fitting track. */
  async function add(m, opts = {}) {
    if (!tl) return;
    const kind = m.kind;
    let tr = opts.track ? track(opts.track) : null;
    const fits = t => t && !t.locked && t.kind !== "camera" && (t.kind === "video" ? kind !== "audio" : kind !== "image");
    if (!fits(tr)) tr = tl.tracks.find(t => fits(t) && t.kind === (kind === "audio" ? "audio" : "video")) || tl.tracks.find(fits);
    if (!tr) return toast(kind === "image" ? "Pictures go on a video track; add one with ＋ Track." : "No unlocked track fits this file.");
    let length = 3, sd = null, info = null;
    if (kind !== "image") {
      info = await probe(m.ref);
      if (!info?.duration) return toast(`Can't read the length of ${m.name || m.ref}`);
      if (tr.kind === "audio" && kind === "video" && !info.has_audio) return toast("That clip has no sound for an audio track.");
      length = sd = info.duration;
    }
    const at = q(opts.at ?? Math.max(0, ...tl.clips.filter(c => c.track === tr.id).map(end)));
    checkpoint();
    const c = { id: uid(), track: tr.id, ref: m.ref, kind, name: m.name || m.ref.split("/").pop(), start: at, trim_in: 0,
      trim_out: q(length) || 1 / fps(), source_duration: sd, volume: 1, color: "", job: m.job || null, link: null, audio_off: false };
    carve(tr.id, c.start, end(c), new Set());
    tl.clips.push(c);
    sel.clear(); sel.add(c.id);
    // A video with sound also puts its sound on an audio track (linked), like an editing app.
    if (opts.noSound) c.audio_off = true;
    else if (kind === "video" && tr.kind === "video" && tl.link_audio && info?.has_audio) {
      const a = linkSound(c);
      if (a) sel.add(a.id);
    }
    changed();
    revealTime(end(c));
    return c;
  }

  /* Give a video clip a linked copy on an audio track and silence the video's own sound.
     Project settings › "Sound goes on": "new" = an audio track of its own (an empty one, or a new
     A# track), so each video's sound can be mixed separately; "free" = the first audio track
     that's free at that time. */
  function linkSound(c) {
    const ok = t => t.kind === "audio" && !t.locked;
    const at0 = tl.link_audio_track === "free"
      ? tl.tracks.find(t => ok(t) && !tl.clips.some(x => x.track === t.id && x.start < end(c) && end(x) > c.start))
      : tl.tracks.find(t => ok(t) && !tl.clips.some(x => x.track === t.id));
    let at = at0;
    if (!at) {
      let n = tl.tracks.filter(t => t.kind === "audio").length + 1;
      while (tl.tracks.some(t => t.name === `A${n}`)) n++;
      at = { id: uid(), kind: "audio", name: `A${n}`, muted: false, solo: false, locked: false, hidden: false, volume: 1, pan: 0, height: 44 };
      tl.tracks.push(at);
    }
    c.link = c.link || uid();
    c.audio_off = true;
    const a = { ...structuredClone(c), id: uid(), track: at.id, audio_off: false, fx: null };
    tl.clips.push(a);
    return a;
  }
  function detachSound(c) {
    checkpoint();
    const a = linkSound(c);
    if (a) { sel.add(a.id); toast(`Sound moved to ${track(a.track).name}, linked to the clip.`); }
    changed();
  }
  function unlink(c) {
    checkpoint();
    for (const x of grp(c)) x.link = null;   // the video stays silent; its sound clip is now independent
    sel.clear(); sel.add(c.id);
    changed();
  }
  function linkPair(list) {
    const v = list.find(x => track(x.track).kind === "video" && x.kind === "video"), a = list.find(x => track(x.track).kind === "audio");
    if (!v || !a || v.ref !== a.ref) return toast("Select one video clip and one audio clip of the same file to link them.");
    checkpoint();
    const id = uid();
    v.link = a.link = id; v.audio_off = true;
    a.start = v.start; a.trim_in = v.trim_in; a.trim_out = v.trim_out;
    changed();
  }

  /* ---- transition engine. Making or lengthening a transition pulls the incoming clip (and
     everything after it on its track, and the linked partners of those clips) left, so the two
     clips overlap; each clip plays its own frames. Shortening or deleting does the reverse. */
  const TRANSITIONS = [["fade", "Cross dissolve"], ["fadeblack", "Dip to black"], ["fadewhite", "Dip to white"], ["dissolve", "Pixel dissolve"],
    ["wipeleft", "Wipe left"], ["wiperight", "Wipe right"], ["wipeup", "Wipe up"], ["wipedown", "Wipe down"],
    ["slideleft", "Slide left"], ["slideright", "Slide right"], ["slideup", "Slide up"], ["slidedown", "Slide down"],
    ["smoothleft", "Smooth left"], ["smoothright", "Smooth right"], ["coverleft", "Push left"], ["coverright", "Push right"],
    ["circleopen", "Circle open"], ["circleclose", "Circle close"], ["radial", "Radial"], ["zoomin", "Zoom in"],
    ["pixelize", "Pixelate"], ["hblur", "Blur"], ["squeezeh", "Squeeze"], ["horzopen", "Barn door"]];
  const transLabel = t => track(t.track)?.kind === "audio" ? "Crossfade" : (TRANSITIONS.find(x => x[0] === t.type)?.[1] || t.type);
  let lastType = "fade";

  function rippleFrom(c, delta) {
    // Shift c and every clip after it on its track, plus the same on the tracks of c's linked partners.
    const plan = new Map();
    for (const x of grp(c)) plan.set(x.track, Math.min(plan.get(x.track) ?? Infinity, x.start));
    for (const [trackId, from] of plan) for (const o of tl.clips) if (o.track === trackId && o.start >= from - 1e-6) o.start = q(Math.max(0, o.start + delta));
  }
  function partnerOn(c, trackId) { return grp(c).find(x => x !== c && x.track === trackId); }
  function linkPartnerTransitions(a, b, type) {
    // When two linked videos get a transition, their sound clips (if on the same track) crossfade too.
    for (const pa of grp(a)) {
      if (pa === a) continue;
      const pb = partnerOn(b, pa.track);
      if (pb && pb.start < end(pa) - 1e-6 && !transBetween(pa, pb)) tl.transitions.push({ id: uid(), track: pa.track, a: pa.id, b: pb.id, type: "fade" });
    }
  }
  function findCut() {
    // The cut nearest the playhead between two touching clips on one track (preferring the selection).
    const half = 1 / fps() / 2, cuts = [];
    for (const b of tl.clips) {
      if (!editable(b) || transOf(b.id)?.b === b.id) continue;
      const a = tl.clips.find(x => x.track === b.track && x !== b && Math.abs(end(x) - b.start) < half && !(transOf(x.id)?.a === x.id));
      if (a && editable(a) && track(b.track).kind === "video") cuts.push({ a, b, dist: Math.abs(b.start - tl.playhead) - (sel.has(a.id) || sel.has(b.id) ? 1e6 : 0) });
    }
    return cuts.sort((x, y) => x.dist - y.dist)[0] || null;
  }
  function addTransition(type = lastType, length = 1) {
    const cut = findCut();
    if (!cut) return toast("Put two clips end to end on a video track, then add a transition at the cut (Ctrl+T).");
    const { a, b } = cut;
    const d = q(Math.max(2 / fps(), Math.min(length, dur(a) / 2, dur(b) / 2)));
    checkpoint();
    rippleFrom(b, -d);
    const t = { id: uid(), track: b.track, a: a.id, b: b.id, type };
    tl.transitions.push(t);
    linkPartnerTransitions(a, b, type);
    sanitize();
    selTrans = t.id; sel.clear();
    changed();
    toast(`${transLabel(t)} added (${d.toFixed(2)}s). Later clips on the track moved left to make the overlap.`);
    return t;
  }
  function transLength(t) { const a = clip(t.a), b = clip(t.b); return a && b ? end(a) - b.start : 0; }
  function setTransitionLength(t, length) {
    const a = clip(t.a), b = clip(t.b);
    const max = Math.min(dur(a), dur(b)) - 1 / fps();
    const d = q(Math.max(1 / fps(), Math.min(max, length)));
    checkpoint();
    rippleFrom(b, -(d - transLength(t)));
    sanitize();
    changed();
  }
  function removeTransition(t) {
    const b = clip(t.b);
    checkpoint();
    const d = transLength(t);
    tl.transitions = tl.transitions.filter(x => x !== t);
    for (const x of grp(b)) {  // the sound crossfade belongs to the same cut
      const o = tl.transitions.find(y => y.b === x.id);
      if (o) tl.transitions = tl.transitions.filter(y => y !== o);
    }
    if (b) rippleFrom(b, d);
    sanitize(); selTrans = null;
    changed();
  }
  function setTransitionType(t, type) {
    checkpoint(); t.type = type; lastType = type; changed();
  }

  function splitSelection() {
    const t = tl.playhead;
    let targets = [...sel].map(clip).filter(c => c && editable(c) && c.start < t && end(c) > t);
    if (!targets.length) targets = tl.clips.filter(c => editable(c) && c.start < t && end(c) > t);
    if (!targets.length) return toast("No clip under the playhead");
    checkpoint();
    targets = withGroups(targets).filter(c => editable(c) && c.start < t && end(c) > t);
    const relink = new Map();
    for (const c of targets) {
      const r = splitAt(c, t);
      if (!r) continue;
      if (c.link) { if (!relink.has(c.link)) relink.set(c.link, uid()); r.link = relink.get(c.link); }
      for (const tr of tl.transitions) if (tr.a === c.id) tr.a = r.id;  // the outgoing side is now the right half
      if (sel.has(c.id)) sel.add(r.id);
    }
    sanitize();
    changed();
  }

  function deleteSelection(ripple) {
    const gone = [...sel].map(clip).filter(c => c && editable(c));
    if (!gone.length) return;
    checkpoint();
    for (const c of gone.sort((a, b) => b.start - a.start)) {
      tl.clips.splice(tl.clips.indexOf(c), 1);
      if (ripple) for (const o of tl.clips) if (o.track === c.track && o.start >= end(c) - 1e-6) o.start = q(o.start - dur(c));
    }
    sel.clear();
    sanitize();
    changed();
  }

  function copySel() { clipboard = [...sel].map(clip).filter(Boolean).map(c => structuredClone(c)); if (clipboard.length) toast(`Copied ${clipboard.length} clip${clipboard.length > 1 ? "s" : ""}`); }
  function paste(at = tl.playhead) {
    if (!clipboard.length) return;
    const base = Math.min(...clipboard.map(c => c.start));
    checkpoint(); sel.clear();
    for (const src of clipboard) {
      if (!track(src.track) || track(src.track).locked) continue;
      const c = { ...structuredClone(src), id: uid(), start: q(at + src.start - base) };
      carve(c.track, c.start, end(c), new Set());
      tl.clips.push(c); sel.add(c.id);
    }
    changed();
  }
  function duplicate() {
    const list = [...sel].map(clip).filter(Boolean);
    if (!list.length) return;
    clipboard = list.map(c => structuredClone(c));
    paste(Math.max(...list.map(end)));  // right after the selection
  }

  function nudge(frames) {
    const list = [...sel].map(clip).filter(c => c && editable(c));
    if (!list.length) return false;
    checkpoint();
    const d = frames / fps();
    const shift = Math.max(d, -Math.min(...list.map(c => c.start)));
    for (const c of list) c.start = q(c.start + shift);
    for (const c of list) carve(c.track, c.start, end(c), new Set(list.map(x => x.id)));
    changed();
    return true;
  }

  function addTrack(kind) {
    if (kind === "camera") {
      const have = tl.tracks.find(t => t.kind === "camera");
      if (have) { toast("There's already a Camera track: double-click it to add a camera move."); return have; }
      checkpoint();
      const t = { id: uid(), kind: "camera", name: "Camera", muted: false, locked: false, hidden: false, volume: 1, height: 36 };
      tl.tracks.unshift(t);  // the camera looks at everything below it
      changed();
      return t;
    }
    checkpoint();
    const n = tl.tracks.filter(t => t.kind === kind).length + 1;
    const t = { id: uid(), kind, name: `${kind === "video" ? "V" : "A"}${n}`, muted: false, locked: false, hidden: false, volume: 1, height: kind === "video" ? 56 : 44 };
    if (kind === "video") tl.tracks.unshift(t); else tl.tracks.push(t);  // new video goes on top, audio at the bottom
    changed();
  }
  async function removeTrack(id) {
    const t = track(id), n = tl.clips.filter(c => c.track === id).length;
    if (tl.tracks.filter(x => x.kind === t.kind).length === 1 && t.kind === "video") return toast("Keep at least one video track.");
    if (n && !await WM.ask({ title: "Delete track", message: `Delete ${t.name} and its ${n} clip${n > 1 ? "s" : ""}?`, ok: "Delete", danger: true })) return;
    checkpoint();
    tl.tracks = tl.tracks.filter(x => x.id !== id);
    tl.clips = tl.clips.filter(c => c.track !== id);
    changed();
  }

  function addMarker() {
    checkpoint();
    tl.markers.push({ id: uid(), t: q(tl.playhead), label: `Marker ${tl.markers.length + 1}`, color: "" });
    changed();
  }
  function setRange(which) {
    checkpoint();
    if (which === "in") tl.range_in = q(tl.playhead);
    if (which === "out") tl.range_out = q(tl.playhead);
    if (which === "clear") { tl.range_in = null; tl.range_out = null; }
    if (tl.range_in != null && tl.range_out != null && tl.range_out <= tl.range_in) [tl.range_in, tl.range_out] = [tl.range_out, tl.range_in];
    changed();
  }

  /* ------------------------------------------------------------------ playhead, zoom */
  function editPoints() {
    const pts = new Set([0]);
    for (const c of tl.clips) { pts.add(c.start); pts.add(end(c)); }
    for (const m of tl.markers) pts.add(m.t);
    return [...pts].sort((a, b) => a - b);
  }
  function seek(t, { reveal = true } = {}) {
    tl.playhead = q(Math.max(0, t));
    if (playing) clock = { wall: performance.now(), t: tl.playhead };
    drawPlayhead();
    syncProgram(false);
    if (reveal) revealTime(tl.playhead);
    save(1500, true);
  }
  /* Step the playhead by one frame (or one second): pauses playback and shows the timeline. */
  function frameStep(dir, second = false) {
    if (!tl) return;
    if (playing) pause();
    Monitor.show("timeline");
    seek(tl.playhead + dir * (second ? 1 : 1 / fps()));
  }

  function jumpEdit(dir) {
    const pts = editPoints(), t = tl.playhead, e = 1 / fps() / 2;
    const next = dir > 0 ? pts.find(p => p > t + e) : [...pts].reverse().find(p => p < t - e);
    if (next != null) seek(next);
  }
  function setZoom(z, anchorTime = null) {
    const old = tl.zoom;
    tl.zoom = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
    if (!scroller) return;
    const at = anchorTime ?? tl.playhead;
    const px = at * old - scroller.scrollLeft;
    render();
    scroller.scrollLeft = at * tl.zoom - px;
    save(1500, true);
  }
  const zoomStep = dir => setZoom(dir > 0 ? (ZOOMS.find(z => z > tl.zoom) ?? tl.zoom) : ([...ZOOMS].reverse().find(z => z < tl.zoom) ?? tl.zoom));
  function fit(t0 = 0, t1 = total() || 10) {
    const w = (scroller?.clientWidth || 800) - headW() - 30;
    setZoom(Math.max(ZOOMS[0], Math.min(1200, w / Math.max(0.5, t1 - t0))), t0);
    if (scroller) scroller.scrollLeft = t0 * tl.zoom;
  }
  function revealTime(t) {
    if (!scroller) return;
    const x = t * tl.zoom, left = scroller.scrollLeft, w = scroller.clientWidth - headW();
    if (x < left + 20) scroller.scrollLeft = Math.max(0, x - 40);
    else if (x > left + w - 30) scroller.scrollLeft = x - w + 60;
  }

  /* ------------------------------------------------------------------ sound: what the mix does at time t
     Same rules as the render (app/render.py): clip × track volume, pan, the clip's fades, crossfades at
     transitions (also on linked sound clips on other tracks), mute and solo. */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const transLen = x => { const a = clip(x.a), b = clip(x.b); return a && b ? Math.max(0, end(a) - b.start) : 0; };
  function fadesOf(c) {
    let fin = c.fade_in || 0, fout = c.fade_out || 0;
    const o = tl.transitions.find(x => x.a === c.id), i = tl.transitions.find(x => x.b === c.id);
    if (o) fout = Math.max(fout, transLen(o));
    if (i) fin = Math.max(fin, transLen(i));
    if (c.link) for (const p of tl.clips) {
      if (p === c || p.link !== c.link) continue;
      const po = tl.transitions.find(x => x.a === p.id), pi = tl.transitions.find(x => x.b === p.id);
      if (po && !o && clip(po.b)?.link) fout = Math.max(fout, transLen(po));
      if (pi && !i && clip(pi.a)?.link) fin = Math.max(fin, transLen(pi));
    }
    return [fin, fout];
  }
  // The clip's own volume at timeline time t: its volume keyframes (source time) or its volume.
  function volAt(c, t) {
    const keys = c.vol_keys;
    if (!keys?.length) return c.volume ?? 1;
    const s = (c.kind === "image" ? 0 : c.trim_in) + (t - c.start);
    return interp([...keys].sort((a, b) => a.t - b.t), s, k => k.v, 1);
  }
  function soundGain(c, t) {
    const tr = c && track(c.track);
    if (!tr || tr.muted || c.muted || c.kind === "image" || (tr.kind === "video" && c.audio_off)) return 0;
    if (tl.tracks.some(x => x.solo) && !tr.solo) return 0;
    const [fin, fout] = fadesOf(c), L = dur(c), x = t - c.start;
    let g = volAt(c, t) * (tr.volume ?? 1);
    if (fin > 1e-6 && x < fin) g *= clamp(x / fin, 0, 1);
    if (fout > 1e-6 && L - x < fout) g *= clamp((L - x) / fout, 0, 1);
    return g;
  }
  const panOf = c => clamp((c.pan || 0) + (track(c.track)?.pan || 0), -1, 1);

  /* Preview through Web Audio so pan, gains above 100 % and the master strip are heard. The context
     starts on the first Play (browsers need a click first); before that, element volume is used. */
  const Mix = (() => {
    let ctx = null, master = null, limiter = null, analyser = null;
    const routes = new WeakMap();
    function start() {
      if (!ctx) {
        try {
          ctx = new AudioContext();
          master = ctx.createGain(); limiter = ctx.createDynamicsCompressor(); analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          master.connect(limiter); limiter.connect(analyser); analyser.connect(ctx.destination);
        } catch { ctx = null; }
      }
      if (ctx?.state === "suspended") ctx.resume().catch(() => {});
      applyMaster();
    }
    function applyMaster() {
      if (!ctx || !tl) return;
      const m = tl.master || {};
      master.gain.value = m.volume ?? 1;
      const on = m.limiter !== false;  // a brick-wall-ish limiter at -1 dBFS, like the render's
      limiter.threshold.value = on ? -1 : 0; limiter.knee.value = 0; limiter.ratio.value = on ? 20 : 1;
      limiter.attack.value = 0.002; limiter.release.value = 0.08;
    }
    function route(el) {
      if (!ctx) return null;
      let n = routes.get(el);
      if (n) return n;
      try {
        const src = ctx.createMediaElementSource(el), g = ctx.createGain(), p = ctx.createStereoPanner();
        src.connect(g); g.connect(p); p.connect(master);
        n = { g, p }; routes.set(el, n);
      } catch { return null; }
      return n;
    }
    function out(el, gain, pan) {
      const n = route(el);
      if (n) { el.muted = false; el.volume = 1; n.g.gain.value = gain; n.p.pan.value = pan; }
      else { el.muted = gain <= 0; el.volume = clamp(gain * (tl?.master?.volume ?? 1), 0, 1); }
    }
    // Peak level of the mix in dBFS (-Infinity when silent or not started).
    const buf = new Float32Array(2048);
    function peak() {
      if (!analyser || !playing) return -Infinity;
      analyser.getFloatTimeDomainData(buf);
      let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v));
      return m > 0 ? 20 * Math.log10(m) : -Infinity;
    }
    return { start, applyMaster, out, peak, get live() { return !!ctx; } };
  })();

  /* ------------------------------------------------------------------ playback (program monitor) */
  function topClipAt(t) { return picAt(t)?.a || null; }
  // What the program shows at t: the uppermost visible video track with a clip there; if two clips
  // of that track overlap (a transition), both, with the progress p from 0 to 1.
  function picAt(t) {
    for (const tr of tl.tracks) {
      if (tr.kind !== "video" || tr.hidden) continue;
      const here = tl.clips.filter(c => c.track === tr.id && c.kind !== "audio" && c.start <= t && end(c) > t).sort((x, y) => x.start - y.start);
      if (!here.length) continue;
      if (here.length > 1) {
        const tt = transBetween(here[0], here[1]);
        if (tt) return { a: here[0], b: here[1], p: Math.min(1, Math.max(0, (t - here[1].start) / (end(here[0]) - here[1].start))), type: tt.type };
        return { a: here[here.length - 1] };
      }
      return { a: here[0] };
    }
    return null;
  }
  function stopTime() { return tl.range_out != null && tl.playhead < tl.range_out ? tl.range_out : total(); }

  function play() {
    if (!tl.clips.length) return toast("Add clips to the timeline first: drag results from the bin.");
    if (tl.playhead >= stopTime() - 1 / fps()) tl.playhead = tl.range_in ?? 0;
    Mix.start();
    playing = true; clock = { wall: performance.now(), t: tl.playhead };
    Monitor.show("timeline");
    root.classList.add("playing");
    tick();
  }
  function pause() {
    playing = false; cancelAnimationFrame(raf);
    root?.classList.remove("playing");
    $("#prog-video")?.pause(); $("#prog-video2")?.pause();
    for (const a of audioEls.values()) a.pause();
    if (tl) save(1000, true);
    renderBar();
  }
  const toggle = () => (playing ? pause() : play());
  function tick() {
    if (!playing) return;
    const t = clock.t + (performance.now() - clock.wall) / 1000;
    const stop = stopTime();
    if (t >= stop) {
      if (loop && tl.range_in != null && tl.range_out != null) { clock = { wall: performance.now(), t: tl.range_in }; tl.playhead = tl.range_in; }
      else { tl.playhead = q(stop); drawPlayhead(); syncProgram(false); return pause(); }
    } else tl.playhead = t;
    drawPlayhead();
    revealTime(tl.playhead);
    syncProgram(true);
    raf = requestAnimationFrame(tick);
  }

  function syncProgram(live) {
    if (!tl || Monitor.mode !== "timeline") return;
    const t = tl.playhead, pic = picAt(t), c = pic?.a || null;
    $("#prog-tc").textContent = tc(t);
    $("#prog-name").textContent = pic?.b ? `${c.name} → ${pic.b.name} · ${TRANSITIONS.find(x => x[0] === pic.type)?.[1] || pic.type}`
      : c ? c.name : (tl.clips.length ? "— gap —" : "Empty timeline");
    const prog = $("#program");
    prog.classList.toggle("white", !!pic?.b && pic.type === "fadewhite");
    const L1 = { v: $("#prog-video"), i: $("#prog-img"), fx: fxLayer(1) }, L2 = { v: $("#prog-video2"), i: $("#prog-img2"), fx: fxLayer(2) };
    const look = { a: { opacity: 1, clip: "none", transform: "none" }, b: { opacity: 1, clip: "none", transform: "none" } };
    if (pic?.b) {
      const p = pic.p, k = pic.type, pc = `${(1 - p) * 100}%`;
      if (k === "fadeblack" || k === "fadewhite") { look.a.opacity = Math.max(0, 1 - 2 * p); look.b.opacity = Math.max(0, 2 * p - 1); }
      else if (k === "wipeleft") look.b.clip = `inset(0 0 0 ${pc})`;
      else if (k === "wiperight") look.b.clip = `inset(0 ${pc} 0 0)`;
      else if (k === "wipeup") look.b.clip = `inset(${pc} 0 0 0)`;
      else if (k === "wipedown") look.b.clip = `inset(0 0 ${pc} 0)`;
      else if (k === "slideleft" || k === "coverleft" || k === "smoothleft") look.b.transform = `translateX(${pc})`;
      else if (k === "slideright" || k === "coverright" || k === "smoothright") look.b.transform = `translateX(-${pc})`;
      else if (k === "slideup") look.b.transform = `translateY(${pc})`;
      else if (k === "slidedown") look.b.transform = `translateY(-${pc})`;
      else if (k === "circleopen") look.b.clip = `circle(${p * 75}% at 50% 50%)`;
      else if (k === "circleclose") { look.a.clip = `circle(${(1 - p) * 75}% at 50% 50%)`; }
      else look.b.opacity = p;  // dissolve-like types preview as a dissolve; the render is exact
    }
    showLayer(L1, c, t, live, look.a, !!pic?.b && pic.type === "circleclose");
    showLayer(L2, pic?.b || null, t, live, look.b, !(pic?.type === "circleclose"));
    applyCamera(t);
    camEdit?.refresh?.();
    // Audio tracks (and video clips placed on them for their sound).
    const live_ids = new Set();
    for (const a of tl.clips) {
      const tr = track(a.track);
      if (!tr || tr.kind !== "audio" || a.kind === "image" || !(a.start <= t && end(a) > t)) continue;
      live_ids.add(a.id);
      let el = audioEls.get(a.id);
      if (!el) { el = new Audio(); el.preload = "auto"; audioEls.set(a.id, el); }
      if (el.dataset.ref !== a.ref) { el.src = mediaUrl(a.ref); el.dataset.ref = a.ref; }
      Mix.out(el, soundGain(a, t), panOf(a));
      const target = a.trim_in + (t - a.start);
      if (live) { if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target; if (el.paused) el.play().catch(() => {}); }
      else { el.pause(); el.currentTime = target; }
    }
    for (const [id, el] of audioEls) if (!live_ids.has(id)) { el.pause(); if (!clip(id)) audioEls.delete(id); }
  }

  function showLayer(L, c, t, live, look, onTop) {
    const { v, i } = L;
    for (const el of [v, i, L.fx]) { el.style.opacity = look.opacity; el.style.clipPath = look.clip; el.style.transform = look.transform; el.style.zIndex = onTop ? 2 : 1; }
    paintFx(L, c, t);
    if (!c) { v.hidden = true; i.hidden = true; v.pause(); return; }
    if (c.kind === "image") {
      v.hidden = true; v.pause(); i.hidden = false;
      if (i.dataset.ref !== c.ref) { i.src = mediaUrl(c.ref); i.dataset.ref = c.ref; }
      return;
    }
    i.hidden = true; v.hidden = false;
    const target = c.trim_in + (t - c.start);
    Mix.out(v, soundGain(c, t), panOf(c));
    if (v.dataset.ref !== c.ref) { v.src = mediaUrl(c.ref); v.dataset.ref = c.ref; v.currentTime = target; }
    if (live) {
      if (Math.abs(v.currentTime - target) > 0.2) v.currentTime = target;
      if (v.paused) v.play().catch(() => {});
    } else { v.pause(); if (Math.abs(v.currentTime - target) > 1 / fps() / 2) v.currentTime = target; }
  }

  /* ------------------------------------------------------------------ Video Fx: live preview
     The render (app/render.py) is exact; the preview is close: CSS filters for the grade, and
     blended gradients for lights, temperature, tint and the vignette. Grain and sharpening only
     show in the render. */
  const FX_DEFAULT = { enabled: true, exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, look: "none", vignette: 0, blur: 0, sharpen: 0, grain: 0, lights: [] };
  const LIGHT_DEFAULT = { mode: "relight", x: 0.5, y: 0.35, x2: null, y2: null, radius: 0.35, intensity: 1, color: "#ffd890", flicker: 0 };
  const fxOn = c => !!(c?.fx && c.fx.enabled !== false);
  const FX_ANIM = ["exposure", "contrast", "saturation", "temperature", "tint", "vignette", "blur"];
  const LIGHT_ANIM = ["x", "y", "radius", "intensity", "flicker", "color"];
  // Keyframes are in source time (seconds into the file), like the render, so they stay put when trimming.
  const srcTime = (c, t) => (c.kind === "image" ? 0 : c.trim_in) + (t - c.start);
  const toHex = rgb => "#" + rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
  function ease(u, e) { return e === "hold" ? 0 : e === "linear" ? u : u * u * (3 - 2 * u); }
  function interp(keys, s, get, base) {
    const pts = keys.map(k => [k.t, get(k) ?? base, k.ease || "smooth"]);
    if (!pts.length) return base;
    if (s <= pts[0][0]) return pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, v0, e] = pts[i], [t1, v1] = pts[i + 1];
      if (s < t1) {
        const u = ease((s - t0) / Math.max(1e-9, t1 - t0), e);
        return typeof v0 === "string" ? toHex(rgbOf(v0).map((a, j) => a + (rgbOf(v1)[j] - a) * u)) : v0 + (v1 - v0) * u;
      }
    }
    return pts[pts.length - 1][1];
  }
  // The clip's effective effects at source time s (keyframes applied).
  function fxAt(c, s) {
    const fx = { ...FX_DEFAULT, ...c.fx, lights: (c.fx?.lights || []).map(l => ({ ...LIGHT_DEFAULT, ...l })) };
    const keys = [...(c.fx?.keys || [])].sort((a, b) => a.t - b.t);
    if (!keys.length) return fx;
    for (const k of FX_ANIM) fx[k] = interp(keys, s, key => key.values?.[k], fx[k]);
    fx.lights.forEach((lt, i) => {
      for (const k of LIGHT_ANIM) lt[k] = interp(keys, s, key => key.lights?.[i]?.[k], lt[k]);
      lt.x2 = null; lt.y2 = null;  // with keyframes, the keys move the light
    });
    return fx;
  }
  function fxLayer(n) {
    let el = document.getElementById(`prog-fx${n}`);
    if (!el) {
      el = document.createElement("div");
      el.id = `prog-fx${n}`; el.className = "prog-fx"; el.hidden = true;
      ($("#prog-cam") || $("#program")).appendChild(el);
    }
    return el;
  }
  // Where the picture of clip c sits inside the program monitor (object-fit: contain).
  function picRect(c, el) {
    const box = $("#program").getBoundingClientRect();
    const info = probeInfo.get(c.ref) || {};
    let w = info.width || el?.videoWidth || el?.naturalWidth, h = info.height || el?.videoHeight || el?.naturalHeight;
    if (!w || !h) { w = 16; h = 9; probe(c.ref); }
    const k = Math.min(box.width / w, box.height / h);
    return { left: (box.width - w * k) / 2, top: (box.height - h * k) / 2, width: w * k, height: h * k, box };
  }
  const rgbOf = hex => { const n = parseInt((hex || "#ffffff").slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  function lightAt(lt, c, t) {
    const p = clamp((t - c.start) / Math.max(1e-3, dur(c)), 0, 1);
    const x = lt.x + ((lt.x2 ?? lt.x) - lt.x) * p, y = lt.y + ((lt.y2 ?? lt.y) - lt.y) * p;
    const T = t - c.start;
    const flick = lt.flicker > 0 ? 1 - lt.flicker * 0.6 * 0.5 * (1 + Math.sin(T * 13.1) * Math.sin(T * 5.3 + 1)) : 1;
    return { x, y, flick };
  }
  // A clip's Fx lights and vignette at time t, for the 3D renderer's shader.
  function fxForGL(c, t) {
    if (!c || !fxOn(c)) return null;
    const fx = fxAt(c, srcTime(c, t));
    const info = probeInfo.get(c.ref) || {};
    const lights = (fx.lights || []).filter(l => l.intensity > 0).map(l0 => {
      const lt = { ...LIGHT_DEFAULT, ...l0 }, at = lightAt(lt, c, t), rgb = lt.mode === "shade" ? [1, 1, 1] : rgbOf(lt.color).map(v => v / 255);
      return { mode: lt.mode, x: at.x, y: at.y, radius: lt.radius, intensity: lt.intensity * at.flick, rgb };
    });
    return { lights, vignette: fx.vignette || 0, picW: info.width, picH: info.height };
  }
  function paintFx(L, c, t) {
    const media = [L.v, L.i];
    const ov = L.fx;
    if (!c || !fxOn(c)) { for (const m of media) m.style.filter = ""; ov.hidden = true; return; }
    const fx = fxAt(c, srcTime(c, t));
    const el = c.kind === "image" ? L.i : L.v;
    const r = picRect(c, el);
    const px = r.height / 1080;
    const f = [];
    if (fx.exposure) f.push(`brightness(${(2 ** fx.exposure).toFixed(3)})`);
    if (fx.contrast !== 1) f.push(`contrast(${fx.contrast})`);
    if (fx.saturation !== 1) f.push(`saturate(${fx.saturation})`);
    if (fx.look === "bw") f.push("grayscale(1)");
    if (fx.look === "sepia") f.push("sepia(1)");
    if (fx.blur > 0) f.push(`blur(${(fx.blur * px).toFixed(2)}px)`);
    for (const m of media) m.style.filter = f.join(" ");
    Object.assign(ov.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const layers = [];
    if (fx.temperature) {
      const warm = fx.temperature > 0, a = Math.abs(fx.temperature) / 100 * 0.55;
      layers.push(`<i style="background:rgba(${warm ? "255,136,32" : "48,128,255"},${a.toFixed(3)});mix-blend-mode:soft-light"></i>`);
    }
    if (fx.tint) layers.push(`<i style="background:rgba(${fx.tint > 0 ? "255,0,200" : "0,220,60"},${(Math.abs(fx.tint) / 100 * 0.35).toFixed(3)});mix-blend-mode:soft-light"></i>`);
    const short = Math.min(r.width, r.height);
    for (const lt0 of fx.lights || []) {
      const lt = { ...LIGHT_DEFAULT, ...lt0 };
      if (!(lt.intensity > 0)) continue;
      const { x, y, flick } = lightAt(lt, c, t);
      const sig = lt.radius * short, [R, G, B] = lt.mode === "shade" ? [0, 0, 0] : rgbOf(lt.color);
      const peak = clamp((lt.mode === "shade" ? Math.min(1, lt.intensity * 0.7) : lt.mode === "glow" ? lt.intensity * 0.9 : lt.intensity * 0.55) * flick, 0, 1);
      const stops = [0, 0.5, 1, 1.5, 2, 2.6].map(k => `rgba(${R},${G},${B},${(peak * Math.exp(-k * k / 2)).toFixed(3)}) ${(k * sig).toFixed(1)}px`).join(",");
      const blend = lt.mode === "shade" ? "multiply" : lt.mode === "glow" ? "screen" : "color-dodge";
      layers.push(`<i style="background:radial-gradient(circle at ${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%,${stops},transparent ${(2.7 * sig).toFixed(1)}px);mix-blend-mode:${blend}"></i>`);
    }
    if (fx.vignette > 0) layers.push(`<i style="background:radial-gradient(ellipse at center,transparent ${(62 - 30 * fx.vignette).toFixed(0)}%,rgba(0,0,0,${(0.25 + 0.6 * fx.vignette).toFixed(2)}) 100%)"></i>`);
    const html = layers.join("");
    if (ov.dataset.html !== html) { ov.innerHTML = html; ov.dataset.html = html; }
    ov.hidden = !layers.length;
    drawFxHandles();
  }

  /* ---- light handles on the viewer while the Fx window is open: drag ● to place a light, ○ to set where it travels */
  let fxEdit = null;  // {clipId, win, onChange}
  function drawFxHandles() {
    let hl = document.getElementById("prog-fx-handles");
    const c = fxEdit && clip(fxEdit.clipId);
    if (!c || Monitor.mode !== "timeline") { if (hl) hl.hidden = true; return; }
    if (!hl) {
      hl = document.createElement("div");
      hl.id = "prog-fx-handles"; hl.className = "prog-fx-handles";
      $("#program").appendChild(hl);
      hl.addEventListener("pointerdown", fxHandleDown);
    }
    const r = picRect(c, c.kind === "image" ? $("#prog-img") : $("#prog-video"));
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const visible = c.start <= tl.playhead && end(c) > tl.playhead;
    const lights = fxAt(c, srcTime(c, tl.playhead)).lights;
    const keyed = !!c.fx?.keys?.length;
    fxEdit.refresh?.();
    const html = (visible ? "" : `<span class="fxh-note">Move the playhead into “${esc2(c.name)}” to see it</span>`) + lights.map((lt0, i) => {
      const lt = { ...LIGHT_DEFAULT, ...lt0 };
      const moving = !keyed && lt.x2 != null;
      const now = lightAt(lt, c, tl.playhead);
      const col = lt.mode === "shade" ? "#222" : lt.color;
      return `${moving ? `<svg class="fxh-path"><line x1="${lt.x * 100}%" y1="${lt.y * 100}%" x2="${lt.x2 * 100}%" y2="${lt.y2 * 100}%"/></svg>
          <b class="fxh end" data-li="${i}" data-pt="end" style="left:${lt.x2 * 100}%;top:${lt.y2 * 100}%" title="Light ${i + 1}: where it ends up"></b>` : ""}
        <b class="fxh" data-li="${i}" data-pt="start" style="left:${lt.x * 100}%;top:${lt.y * 100}%;--c:${col}" title="Light ${i + 1} (${lt.mode}): drag to place${moving ? "; it starts here" : keyed ? " (sets a keyframe at the playhead)" : ""}"><span>${i + 1}</span></b>
        ${moving ? `<i class="fxh-now" style="left:${now.x * 100}%;top:${now.y * 100}%"></i>` : ""}`;
    }).join("");
    if (hl.dataset.html !== html) { hl.innerHTML = html; hl.dataset.html = html; }
    hl.hidden = false;
  }
  function fxHandleDown(e) {
    const h = e.target.closest(".fxh");
    const c = fxEdit && clip(fxEdit.clipId);
    if (!h || !c) return;
    e.preventDefault(); e.stopPropagation();
    const li = +h.dataset.li, lt = c.fx.lights[li], hl = e.currentTarget, kx = h.dataset.pt === "end" ? "x2" : "x", ky = h.dataset.pt === "end" ? "y2" : "y";
    h.setPointerCapture(e.pointerId);
    const mv = ev => {
      const r = hl.getBoundingClientRect();
      const x = +clamp((ev.clientX - r.left) / r.width, -0.5, 1.5).toFixed(4), y = +clamp((ev.clientY - r.top) / r.height, -0.5, 1.5).toFixed(4);
      if (c.fx.keys?.length) { const k = keyAt(c, true); k.lights[li].x = x; k.lights[li].y = y; }
      else { lt[kx] = x; lt[ky] = y; }
      syncProgram(false); fxEdit.onChange?.();
    };
    const up = () => { h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", up); };
    h.addEventListener("pointermove", mv); h.addEventListener("pointerup", up);
  }

  /* ---- keyframes: a key holds every animatable setting at one moment */
  function snapKey(c, s) {
    const v = fxAt(c, s);
    return { t: +s.toFixed(4), ease: "smooth", values: Object.fromEntries(FX_ANIM.map(k => [k, +(+v[k]).toFixed(4)])),
      lights: v.lights.map(lt => Object.fromEntries(LIGHT_ANIM.map(k => [k, k === "color" ? lt.color : +(+lt[k]).toFixed(4)]))) };
  }
  // The key at the playhead (within half a frame), made from the current values when `create`.
  function keyAt(c, create = false) {
    const s = srcTime(c, tl.playhead), keys = c.fx.keys || (c.fx.keys = []);
    let k = keys.find(x => Math.abs(x.t - s) < 0.5 / fps());
    if (!k && create) { k = snapKey(c, s); keys.push(k); keys.sort((a, b) => a.t - b.t); }
    if (k) while (k.lights.length < c.fx.lights.length) k.lights.push({});
    return k;
  }

  /* ---- the Video Fx window */
  const FX_PRESETS = {
    "Golden hour": { exposure: 0.15, contrast: 1.08, saturation: 1.15, temperature: 45, lights: [{ mode: "relight", x: 0.15, y: 0.25, radius: 0.6, intensity: 1.2, color: "#ffb060" }], vignette: 0.25 },
    "Moonlight": { exposure: -0.8, contrast: 1.15, saturation: 0.6, temperature: -55, lights: [{ mode: "relight", x: 0.8, y: 0.1, radius: 0.5, intensity: 0.9, color: "#9ec4ff" }], vignette: 0.5 },
    "Noir": { look: "bw", contrast: 1.45, exposure: -0.2, lights: [{ mode: "relight", x: 0.35, y: 0.3, radius: 0.3, intensity: 1.4, color: "#ffffff" }, { mode: "shade", x: 0.85, y: 0.6, radius: 0.5, intensity: 1 }], vignette: 0.7, grain: 0.35 },
    "Neon side light": { contrast: 1.1, saturation: 1.2, lights: [{ mode: "relight", x: -0.05, y: 0.45, radius: 0.45, intensity: 1.8, color: "#ff3cc8" }, { mode: "relight", x: 1.05, y: 0.45, radius: 0.45, intensity: 1.6, color: "#2ee6ff" }] },
    "Candle flicker": { exposure: -0.6, temperature: 55, lights: [{ mode: "relight", x: 0.5, y: 0.75, radius: 0.45, intensity: 1.6, color: "#ff9a40", flicker: 0.7 }], vignette: 0.55 },
    "Light sweep": { lights: [{ mode: "glow", x: -0.1, y: 0.3, x2: 1.1, y2: 0.3, radius: 0.25, intensity: 0.8, color: "#fff2d0" }] },
    "Film look": { contrast: 1.12, saturation: 0.9, temperature: 12, tint: 6, vignette: 0.35, grain: 0.4, sharpen: 0.3 },
  };
  let fxClipboard = null;
  function fxTargets(c) { return c && (c.kind === "video" || c.kind === "image") && track(c.track)?.kind === "video"; }
  function fxDialog(c) {
    if (!fxTargets(c)) return toast("Video Fx work on pictures and videos on a video track.");
    if (fxEdit?.win) fxEdit.win.close();
    const before = snapshot();
    if (!c.fx) c.fx = structuredClone(FX_DEFAULT);
    c.fx = { ...structuredClone(FX_DEFAULT), ...c.fx, lights: (c.fx.lights || []).map(l => ({ ...LIGHT_DEFAULT, ...l })) };
    if (!(c.start <= tl.playhead && end(c) > tl.playhead)) seek(c.start + Math.min(dur(c) / 2, 1));
    Monitor.show("timeline");
    probe(c.ref);
    const form = document.createElement("div");
    form.className = "wm-form fxd";
    const sl = (k, label, min, max, step, fmt) => `<div class="field fxs"><label for="fx-${k}">${label} <span class="opt" data-out="${k}"></span></label>
      <input id="fx-${k}" data-k="${k}" type="range" min="${min}" max="${max}" step="${step}" data-fmt="${fmt || ""}"></div>`;
    form.innerHTML = `
      <div class="fx-top"><label class="check"><input type="checkbox" data-k="enabled"> Effects on <span class="hint inline">(off: compare with the original)</span></label></div>
      <fieldset class="fx-keyset"><legend>Keyframes</legend>
        <div class="fx-keys">
          <button type="button" class="btn sm" data-ka="prev" title="Previous keyframe">◀◆</button>
          <div class="fxk-bar" title="Click to move the playhead; drag a ◆ to move that keyframe"></div>
          <button type="button" class="btn sm" data-ka="next" title="Next keyframe">◆▶</button>
        </div>
        <div class="fx-keybtns">
          <button type="button" class="btn sm" data-ka="add">◆ Add keyframe</button>
          <button type="button" class="btn sm" data-ka="del">Delete keyframe</button>
          <label class="fx-ease">Ease to next <select data-ka="ease"><option value="smooth">Smooth</option><option value="linear">Linear</option><option value="hold">Hold</option></select></label>
          <button type="button" class="btn sm ghost danger" data-ka="clear">Remove all</button>
        </div>
        <p class="hint fxk-hint"></p>
      </fieldset>
      <div class="fx-presets">${Object.keys(FX_PRESETS).map(n => `<button type="button" class="btn sm" data-preset="${esc2(n)}">${esc2(n)}</button>`).join("")}</div>
      <fieldset><legend>Grade</legend><div class="row2">
        ${sl("exposure", "Exposure", -3, 3, 0.05, "ev")}${sl("contrast", "Contrast", 0.2, 3, 0.01, "x")}
        ${sl("saturation", "Saturation", 0, 3, 0.01, "x")}${sl("temperature", "Temperature", -100, 100, 1, "temp")}
        ${sl("tint", "Tint", -100, 100, 1, "tint")}
        <div class="field"><label for="fx-look">Look</label><select id="fx-look" data-k="look"><option value="none">Colour</option><option value="bw">Black and white</option><option value="sepia">Sepia</option></select></div>
      </div></fieldset>
      <fieldset><legend>Lights <span class="hint inline">— drag the numbered dots on the viewer to place them</span></legend>
        <div class="fx-lights"></div>
        <button type="button" class="btn sm" data-a="add-light">＋ Add light</button>
        <p class="hint">Relight brightens what's there, keeping its texture (light falling on the scene). Glow adds light on top
          (a lamp, a haze). Shade darkens (a shadow). A moving light travels from ● to ○ over the clip.</p>
      </fieldset>
      <fieldset><legend>Finish</legend><div class="row2">
        ${sl("vignette", "Vignette", 0, 1, 0.01, "pct")}${sl("blur", "Blur", 0, 20, 0.1, "px")}
        ${sl("sharpen", "Sharpen", 0, 2, 0.01, "x")}${sl("grain", "Film grain", 0, 1, 0.01, "pct")}
      </div><p class="hint">Grain and sharpening show in the render only; the preview of everything else is close, the render is exact.</p></fieldset>`;
    let fxEdit_refresh = () => {};
    const fmtv = (v, f) => f === "ev" ? `${v > 0 ? "+" : ""}${(+v).toFixed(2)} stops` : f === "x" ? `${(+v).toFixed(2)}×` : f === "pct" ? `${Math.round(v * 100)}%`
      : f === "px" ? `${(+v).toFixed(1)} px` : f === "temp" ? (+v === 0 ? "neutral" : `${+v > 0 ? "warmer" : "cooler"} ${Math.abs(v)}`)
      : f === "tint" ? (+v === 0 ? "neutral" : `${+v > 0 ? "magenta" : "green"} ${Math.abs(v)}`) : String(v);
    const now = () => fxAt(c, srcTime(c, tl.playhead));
    const keyed = () => !!c.fx.keys?.length;
    const fill = () => {
      const v = now();
      for (const inp of form.querySelectorAll("[data-k]")) {
        const k = inp.dataset.k, val = FX_ANIM.includes(k) ? v[k] : c.fx[k];
        if (inp.type === "checkbox") inp.checked = val !== false; else inp.value = val;
        const o = form.querySelector(`[data-out="${k}"]`); if (o) o.textContent = fmtv(+(+val).toFixed(2) || val, inp.dataset.fmt);
      }
      renderLights(); renderKeys();
    };
    // The keyframe bar: the clip's length in source time, a ◆ per key and the playhead.
    const renderKeys = () => {
      const bar = form.querySelector(".fxk-bar"), s0 = srcTime(c, c.start), L = dur(c), s = srcTime(c, tl.playhead);
      const keys = c.fx.keys || [], at = keys.find(x => Math.abs(x.t - s) < 0.5 / fps());
      bar.innerHTML = keys.map((k, i) => { const p = (k.t - s0) / L; return p < -0.001 || p > 1.001 ? "" :
        `<b class="fxk${k === at ? " on" : ""}" data-ki="${i}" style="left:${p * 100}%" title="Keyframe at ${tc(c.start + k.t - s0)} · ${k.ease || "smooth"}"></b>`; }).join("")
        + `<i class="fxk-ph" style="left:${clamp((s - s0) / L, 0, 1) * 100}%"></i>`;
      form.querySelector('[data-ka="del"]').disabled = !at;
      const easeSel = form.querySelector('[data-ka="ease"]');
      easeSel.disabled = !at; easeSel.value = at?.ease || "smooth";
      form.querySelector('[data-ka="clear"]').disabled = !keys.length;
      form.querySelector(".fxk-hint").textContent = keys.length
        ? `${keys.length} keyframe${keys.length > 1 ? "s" : ""}. Changing a setting (or dragging a light) sets a keyframe at the playhead${at ? " — you're on one" : ""}. Grain, sharpen, look and light kinds stay the same over the clip.`
        : "Add a keyframe to make the settings change over the clip: set one at the start, move the playhead, change things (that adds another).";
    };
    let lastPh = null, lastFill = 0;
    fxEdit_refresh = () => {
      if (tl.playhead === lastPh) return;
      if (playing && performance.now() - lastFill < 250) return;  // keep playback smooth
      lastPh = tl.playhead; lastFill = performance.now();
      if (form.contains(document.activeElement) && document.activeElement.matches("input[type=range]") && document.activeElement.matches(":active")) return;
      fill();
    };
    const renderLights = () => {
      const box = form.querySelector(".fx-lights");
      const vl = now().lights;
      box.innerHTML = c.fx.lights.map((lt0, i) => { const lt = { ...lt0, ...vl[i], mode: lt0.mode }; return `
        <div class="fx-light" data-li="${i}">
          <span class="fx-ln" style="--c:${lt.mode === "shade" ? "#222" : lt.color}">${i + 1}</span>
          <select data-lk="mode" aria-label="Light ${i + 1} kind"><option value="relight"${lt.mode === "relight" ? " selected" : ""}>Relight</option><option value="glow"${lt.mode === "glow" ? " selected" : ""}>Glow</option><option value="shade"${lt.mode === "shade" ? " selected" : ""}>Shade</option></select>
          <input type="color" data-lk="color" value="${lt.color}" aria-label="Colour"${lt.mode === "shade" ? " disabled" : ""}>
          <label>Strength <input type="range" data-lk="intensity" min="0" max="4" step="0.05" value="${lt.intensity}"></label>
          <label>Size <input type="range" data-lk="radius" min="0.03" max="1.5" step="0.01" value="${lt.radius}"></label>
          <label>Flicker <input type="range" data-lk="flicker" min="0" max="1" step="0.01" value="${lt.flicker}"></label>
          <label class="check" title="${keyed() ? "With keyframes, move the light with keys instead" : "Travel from ● to ○ over the clip"}"><input type="checkbox" data-lk="moves"${lt0.x2 != null && !keyed() ? " checked" : ""}${keyed() ? " disabled" : ""}> Moves</label>
          <button type="button" class="btn sm ghost danger" data-a="del-light" title="Remove this light">✕</button>
        </div>`; }).join("") || `<p class="hint">No lights yet.</p>`;
      form.querySelector('[data-a="add-light"]').disabled = c.fx.lights.length >= 4;
    };
    const live = () => { if (!playing) syncProgram(false); drawFxHandles(); mainDepth.vp?.draw(); };
    form.addEventListener("input", e => {
      const k = e.target.dataset.k, lk = e.target.dataset.lk;
      if (k) {
        const val = e.target.type === "checkbox" ? e.target.checked : e.target.type === "range" ? +e.target.value : e.target.value;
        if (keyed() && FX_ANIM.includes(k)) { keyAt(c, true).values[k] = val; renderKeys(); }
        else c.fx[k] = val;
        const o = form.querySelector(`[data-out="${k}"]`); if (o) o.textContent = fmtv(val, e.target.dataset.fmt);
      } else if (lk) {
        const li = +e.target.closest("[data-li]").dataset.li, lt = c.fx.lights[li];
        const val = e.target.type === "range" ? +e.target.value : e.target.value;
        if (lk === "moves") { if (e.target.checked) { lt.x2 = clamp(lt.x + 0.4, -0.5, 1.5); lt.y2 = lt.y; } else { lt.x2 = null; lt.y2 = null; } }
        else if (keyed() && LIGHT_ANIM.includes(lk)) { keyAt(c, true).lights[li][lk] = val; renderKeys(); }
        else lt[lk] = val;
        if (lk === "mode" || lk === "color") renderLights();
      }
      live();
    });
    form.addEventListener("change", e => { if (e.target.dataset.k === "look") { c.fx.look = e.target.value; live(); } });
    // keyframe buttons and the bar
    form.addEventListener("click", e => {
      const ka = e.target.closest("[data-ka]")?.dataset.ka;
      if (!ka || ka === "ease") return;
      const s0 = srcTime(c, c.start), keys = (c.fx.keys ||= []);
      const toKey = k => seek(c.start + (k.t - s0));
      const s = srcTime(c, tl.playhead), eps = 0.5 / fps();
      if (ka === "add") { keyAt(c, true); }
      if (ka === "del") { const k = keyAt(c); if (k) keys.splice(keys.indexOf(k), 1); }
      if (ka === "clear") { if (keys.length) { const v = now(); for (const k2 of FX_ANIM) c.fx[k2] = v[k2]; c.fx.lights.forEach((lt, i) => Object.assign(lt, Object.fromEntries(LIGHT_ANIM.map(k2 => [k2, v.lights[i][k2]])))); } c.fx.keys = []; }
      if (ka === "prev") { const k = [...keys].reverse().find(x => x.t < s - eps); if (k) toKey(k); }
      if (ka === "next") { const k = keys.find(x => x.t > s + eps); if (k) toKey(k); }
      lastPh = null; fill(); live();
    });
    form.addEventListener("change", e => {
      if (e.target.dataset.ka === "ease") { const k = keyAt(c); if (k) { k.ease = e.target.value; live(); } }
    });
    form.querySelector(".fxk-bar").addEventListener("pointerdown", e => {
      const bar = e.currentTarget, r = bar.getBoundingClientRect(), s0 = srcTime(c, c.start), L = dur(c);
      const toS = x => s0 + clamp((x - r.left) / r.width, 0, 1) * L;
      const dia = e.target.closest(".fxk");
      if (!dia) { seek(c.start + (toS(e.clientX) - s0)); lastPh = null; fill(); return; }
      e.preventDefault();
      const k = c.fx.keys[+dia.dataset.ki];
      seek(c.start + (k.t - s0));
      bar.setPointerCapture(e.pointerId);
      const mv = ev => { k.t = +(Math.round(toS(ev.clientX) * fps()) / fps()).toFixed(4); c.fx.keys.sort((a, b) => a.t - b.t); seek(c.start + (k.t - s0)); lastPh = null; fill(); };
      const up = () => { bar.removeEventListener("pointermove", mv); bar.removeEventListener("pointerup", up); };
      bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", up);
    });
    form.addEventListener("click", e => {
      const p = e.target.closest("[data-preset]");
      if (p) { c.fx = { ...structuredClone(FX_DEFAULT), ...structuredClone(FX_PRESETS[p.dataset.preset]), keys: [] }; c.fx.lights = c.fx.lights.map(l => ({ ...LIGHT_DEFAULT, ...l })); fill(); live(); return; }
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "add-light" && c.fx.lights.length < 4) { c.fx.lights.push({ ...LIGHT_DEFAULT, x: [0.3, 0.7, 0.5, 0.2][c.fx.lights.length] }); renderLights(); live(); }
      if (a === "del-light") {
        const li = +e.target.closest("[data-li]").dataset.li;
        c.fx.lights.splice(li, 1);
        for (const k of c.fx.keys || []) k.lights.splice(li, 1);  // keys hold lights by position
        renderLights(); live();
      }
    });
    const foot = document.createElement("div");
    foot.innerHTML = `<button type="button" class="btn sm" data-f="copy">Copy</button><button type="button" class="btn sm" data-f="paste"${fxClipboard ? "" : " disabled"}>Paste</button>
      <button type="button" class="btn sm" data-f="all" title="Give every selected picture clip these effects">Apply to selected</button>
      <span class="wm-foot-gap"></span><button type="button" class="btn sm danger" data-f="reset">Remove effects</button><button type="button" class="btn sm primary" data-f="done">Done</button>`;
    let committed = false;
    const commit = () => {
      if (committed) return; committed = true;
      if (c.fx && !c.fx.keys?.length && !Object.keys(FX_DEFAULT).some(k => k !== "enabled" && JSON.stringify(c.fx[k]) !== JSON.stringify(FX_DEFAULT[k]))) c.fx = null;  // nothing set
      if (snapshot() !== before) { undoStack.push(before); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = []; }
      fxEdit = null; drawFxHandles(); changed();
    };
    const w = WM.open({ id: "fx", title: `Video Fx · ${c.name}`, content: form, footer: foot, width: 600, height: 720, minWidth: 340, minHeight: 320, modal: false, onClose: commit });
    fxEdit = { clipId: c.id, win: w, onChange: null, refresh: () => fxEdit_refresh() };
    foot.addEventListener("click", e => {
      const f = e.target.closest("[data-f]")?.dataset.f;
      if (f === "copy") { fxClipboard = structuredClone(c.fx); foot.querySelector('[data-f="paste"]').disabled = false; toast("Effects copied: paste them in another clip's Video Fx window, or right-click › Paste Fx."); }
      if (f === "paste" && fxClipboard) { c.fx = structuredClone(fxClipboard); fill(); live(); }
      if (f === "all") {
        const others = [...sel].map(clip).filter(x => x && x !== c && fxTargets(x));
        for (const x of others) x.fx = structuredClone(c.fx);
        toast(others.length ? `Applied to ${others.length} more clip${others.length > 1 ? "s" : ""}.` : "Select other picture clips first (Ctrl+click).");
      }
      if (f === "reset") { c.fx = { ...structuredClone(FX_DEFAULT), keys: [] }; fill(); live(); }
      if (f === "done") w.close();
    });
    fill(); live();
  }

  /* ------------------------------------------------------------------ Camera track
     A camera move looks at the finished picture as a flat card in 3D (ideas from Reshoot 4D,
     AGPL-3.0: ideas only). Same maths as app/camera.py: keep the two in step. */
  const CAM_PARAMS = ["pan", "tilt", "roll", "zoom", "dolly", "truck", "pedestal", "orbit"];
  const CAM_DEFAULT = { enabled: true, pan: 0, tilt: 0, roll: 0, zoom: 1, dolly: 0, truck: 0, pedestal: 0, orbit: 0, shake: 0, fill: "black", keys: [],
    reshoot: { prompt: "", references: [], guides: 3, quality: "draft", seed: -1 } };
  const camClips = () => { const ids = new Set(tl.tracks.filter(t => t.kind === "camera" && !t.hidden).map(t => t.id)); return tl.clips.filter(c => ids.has(c.track) && c.kind === "camera" && c.cam && c.cam.enabled !== false); };
  function camParamsAt(move, s, local) {
    const m = { ...CAM_DEFAULT, ...move };
    const keys = [...(m.keys || [])].sort((a, b) => a.t - b.t);
    const p = {};
    for (const k of CAM_PARAMS) p[k] = keys.length ? interp(keys, s, key => key[k], m[k]) : m[k];
    const sh = m.shake || 0;
    if (sh > 0) {
      const t = local;
      p.pan += sh * 1.2 * (Math.sin(t * 1.9) + 0.5 * Math.sin(t * 4.3 + 1));
      p.tilt += sh * 0.9 * (Math.sin(t * 2.3 + 2) + 0.5 * Math.sin(t * 5.1));
      p.roll += sh * 0.6 * Math.sin(t * 1.3 + 0.5);
    }
    return p;
  }
  function camCorners(p, W, H) {
    const D = Math.max(W, H), F = D * p.zoom, rad = Math.PI / 180;
    const ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
    const rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
    const rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
    const mul = (a, b) => a.map((row, i) => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
    const R = mul(mul(mul(ry(p.orbit * rad), ry(p.pan * rad)), rx(p.tilt * rad)), rz(p.roll * rad));
    const p0 = [p.truck * W, -p.pedestal * H, -D * (1 - p.dolly)], o = p.orbit * rad;
    const pos = [Math.cos(o) * p0[0] + Math.sin(o) * p0[2], p0[1], -Math.sin(o) * p0[0] + Math.cos(o) * p0[2]];
    return [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]].map(([X, Y]) => {
      const v = [X - pos[0], Y - pos[1], -pos[2]];
      const xc = [0, 1, 2].map(i => R[0][i] * v[0] + R[1][i] * v[1] + R[2][i] * v[2]);
      const z = Math.max(xc[2], D * 0.05);
      return [F * xc[0] / z + W / 2, F * xc[1] / z + H / 2];
    });
  }
  // CSS matrix3d that maps the rect (rx, ry, rw, rh) onto the quad q = [TL, TR, BL, BR].
  function quadMatrix(rx, ry, rw, rh, q) {
    const [[x0, y0], [x1, y1], [x3, y3], [x2, y2]] = q;  // Heckbert order: TL, TR, BR, BL
    const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    let a, b, c, d, e, f, g, h;
    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) { a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0; }
    else {
      const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
      g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
      a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
    }
    // compose with u = (x - rx)/rw, v = (y - ry)/rh
    const m = [[a / rw, b / rh, c - a * rx / rw - b * ry / rh], [d / rw, e / rh, f - d * rx / rw - e * ry / rh], [g / rw, h / rh, 1 - g * rx / rw - h * ry / rh]];
    return `matrix3d(${m[0][0]},${m[1][0]},0,${m[2][0]},${m[0][1]},${m[1][1]},0,${m[2][1]},0,0,1,0,${m[0][2]},${m[1][2]},0,${m[2][2]})`;
  }
  function canvasClip() {
    const vids = new Set(tl.tracks.filter(t => t.kind === "video").map(t => t.id));
    return [...tl.clips].sort((a, b) => a.start - b.start).find(c => vids.has(c.track) && (c.kind === "video" || c.kind === "image"));
  }
  /* Parallax in the program monitor: inside a camera move with depth, the shot is drawn by the
     3D renderer (viewport3d.js, the same as the Camera window's Look through) over the flat layers. */
  const mainDepth = { vp: null, canvas: null, video: null, clipId: null };
  function depthViewer(c, t) {
    const on = !!(c?.cam?.depth && c.cam.depth.amount > 1e-3 && typeof Viewport3D !== "undefined");
    if (!on) {
      if (mainDepth.canvas) mainDepth.canvas.hidden = true;
      mainDepth.video?.pause();
      return false;
    }
    if (!mainDepth.canvas) {
      const cv = document.createElement("canvas");
      cv.className = "prog-depth"; cv.setAttribute("aria-hidden", "true");
      $("#program").insertBefore(cv, $(".prog-hud", $("#program")));
      const v = document.createElement("video");
      v.muted = true; v.preload = "auto"; v.playsInline = true;
      v.addEventListener("seeked", () => mainDepth.vp?.readDepth(v));
      v.addEventListener("loadeddata", () => { syncDepthVideo(clip(mainDepth.clipId), tl.playhead); mainDepth.vp?.readDepth(v); });
      Object.assign(mainDepth, { canvas: cv, video: v });
      mainDepth.vp = Viewport3D.create(cv, {
        scene() {
          const cc = clip(mainDepth.clipId);
          if (!cc?.cam) return null;
          const b = canvasClip(), i = b && probeInfo.get(b.ref);
          const pic = picAt(tl.playhead)?.a;
          return { W: i?.width || 1280, H: i?.height || 720, cam: camParamsAt(cc.cam, srcTime(cc, tl.playhead), tl.playhead - cc.start), path: [], keys: [],
            colorEl: pic ? (pic.kind === "image" ? $("#prog-img") : $("#prog-video")) : null, depth: true, amount: cc.cam.depth.amount,
            fx: fxForGL(pic, tl.playhead) };
        },
        change() {}, playing: () => playing,
      });
      mainDepth.vp?.setLook(true);
      cv.tabIndex = -1;  // display only: not focusable, no pointer events
    }
    if (mainDepth.clipId !== c.id || mainDepth.video.dataset.ref !== c.cam.depth.ref) {
      mainDepth.clipId = c.id;
      if (mainDepth.video.dataset.ref !== c.cam.depth.ref) { mainDepth.video.dataset.ref = c.cam.depth.ref; mainDepth.video.src = mediaUrl(c.cam.depth.ref); }
    }
    mainDepth.canvas.hidden = false;
    mainDepth.canvas.style.filter = $("#prog-video").style.filter || "";  // the Video Fx grade, as on the layer
    syncDepthVideo(c, t);
    mainDepth.vp?.draw();
    return true;
  }
  function syncDepthVideo(c, t) {
    const v = mainDepth.video, d = c?.cam?.depth;
    if (!v || !d || v.readyState < 1) return;
    const want = Math.max(0, Math.min(t - d.t0, (v.duration || 1e9) - 0.02));
    if (playing) {
      if (Math.abs(v.currentTime - want) > 0.2) v.currentTime = want;
      if (v.paused) v.play().catch(() => {});
      mainDepth.vp?.readDepth(v);  // follow the relief while playing
    } else {
      v.pause();
      if (Math.abs(v.currentTime - want) > 0.03) v.currentTime = want; else mainDepth.vp?.readDepth(v);
    }
  }
  function applyCamera(t) {
    const el = $("#prog-cam");
    if (!el) return;
    const c = camClips().find(x => x.start <= t && end(x) > t);
    depthViewer(c, t);
    if (!c) { el.style.transform = ""; return; }
    const base = canvasClip();
    const r = base ? picRect(base, $("#prog-video")) : (() => { const b = $("#program").getBoundingClientRect(); return { left: 0, top: 0, width: b.width, height: b.height }; })();
    const local = t - c.start, q = camCorners(camParamsAt(c.cam, c.trim_in + local, local), r.width, r.height).map(([x, y]) => [x + r.left, y + r.top]);
    el.style.transform = quadMatrix(r.left, r.top, r.width, r.height, q);
  }
  function camSummary(c) {
    const ks = c.cam?.keys?.length || 0;
    return c.cam?.enabled === false ? "off" : ks ? `${ks} key${ks > 1 ? "s" : ""}` : "static";
  }
  async function addCameraMove(at = tl.playhead) {
    let tr = tl.tracks.find(t => t.kind === "camera");
    if (!tr) tr = addTrack("camera");
    if (tr.locked) return toast("The Camera track is locked.");
    checkpoint();
    const len = Math.max(1, Math.min(4, (total() || 4) - at)) || 4;
    const c = { id: uid(), track: tr.id, ref: "", kind: "camera", name: "Camera move", start: q(at), trim_in: 0, trim_out: q(len), source_duration: null,
      volume: 1, color: "", job: null, link: null, audio_off: true, cam: structuredClone(CAM_DEFAULT) };
    carve(tr.id, c.start, end(c), new Set());
    tl.clips.push(c); sel.clear(); sel.add(c.id);
    changed();
    cameraDialog(c);
  }

  const CAM_PRESETS = {
    "Push in": [{ dolly: 0 }, { dolly: 0.3 }],
    "Pull out": [{ dolly: 0.3 }, { dolly: 0 }],
    "Pan right": [{ pan: -12 }, { pan: 12 }],
    "Pan left": [{ pan: 12 }, { pan: -12 }],
    "Tilt up": [{ tilt: -8 }, { tilt: 8 }],
    "Orbit left": [{ orbit: 15, dolly: 0.1 }, { orbit: -15, dolly: 0.1 }],
    "Orbit right": [{ orbit: -15, dolly: 0.1 }, { orbit: 15, dolly: 0.1 }],
    "Crane up": [{ pedestal: -0.15, tilt: 4 }, { pedestal: 0.15, tilt: -4 }],
    "Dutch tilt": [{ roll: 0 }, { roll: 12, dolly: 0.1 }],
    "Dolly zoom": [{ dolly: 0, zoom: 1 }, { dolly: 0.4, zoom: 0.62 }],
    "Handheld": null,
  };
  let camEdit = null;
  function cameraDialog(c) {
    if (!c?.cam) return;
    camEdit?.win?.close();
    const before = snapshot();
    c.cam = { ...structuredClone(CAM_DEFAULT), ...c.cam, reshoot: { ...CAM_DEFAULT.reshoot, ...(c.cam.reshoot || {}) } };
    if (!(c.start <= tl.playhead && end(c) > tl.playhead)) seek(c.start);
    Monitor.show("timeline");
    const SL = [["pan", "Pan", -80, 80, 0.5, "°", "turn left / right"], ["tilt", "Tilt", -60, 60, 0.5, "°", "look down / up"],
      ["roll", "Roll", -180, 180, 0.5, "°", "rotate the frame"], ["zoom", "Zoom", 0.3, 5, 0.01, "×", "focal length"],
      ["dolly", "Dolly", -2, 0.9, 0.01, "", "move toward (+) / away (−)"], ["truck", "Truck", -2, 2, 0.01, "", "move right (+) / left (−)"],
      ["pedestal", "Crane", -2, 2, 0.01, "", "move up (+) / down (−)"], ["orbit", "Orbit", -80, 80, 0.5, "°", "circle the subject"]];
    const form = document.createElement("div");
    form.className = "wm-form camd";
    form.innerHTML = `
      <div class="fx-top"><label class="check"><input type="checkbox" data-c="enabled"> Camera move on</label>
        <span class="hint inline">The camera looks at everything below the Camera track as a picture in 3D.</span></div>
      <div class="cam3d">
        <div class="cam3d-bar">
          <span class="seg sm cam3d-modes" role="group" aria-label="Camera tool">
            <button type="button" data-vm="move" title="Drag the camera to move it; Shift: toward / away from you (G)">✥ Move</button>
            <button type="button" data-vm="rotate" title="Drag the camera to turn it; Shift: roll (R)">⟳ Rotate</button>
            <button type="button" data-vm="orbit" title="Drag the camera around the picture; up/down: crane (O)">◎ Orbit</button>
          </span>
          <button type="button" class="btn sm" data-v="look" title="See the shot through the camera, with depth (C)">🎥 Look through</button>
          <button type="button" class="btn sm" data-v="reset" title="Frame the scene (F)">⤢</button>
          <span class="cam3d-gap"></span>
          <span class="cam3d-depth"></span>
        </div>
        <canvas class="cam3d-canvas" aria-label="3D view: the picture and the camera"></canvas>
        <p class="hint cam3d-hint">Drag the orange camera to move it, empty space to look around (right-drag or Shift to pan, wheel to zoom;
          wheel over the camera changes its zoom). With keyframes, every change sets one at the playhead.</p>
      </div>
      <div class="fx-presets">${Object.keys(CAM_PRESETS).map(n => `<button type="button" class="btn sm" data-cpreset="${esc2(n)}">${esc2(n)}</button>`).join("")}</div>
      <fieldset><legend>Keyframes</legend>
        <div class="fx-keys"><button type="button" class="btn sm" data-ck="prev">◀◆</button><div class="fxk-bar" title="Click to move the playhead; drag a ◆ to retime it"></div><button type="button" class="btn sm" data-ck="next">◆▶</button></div>
        <div class="fx-keybtns"><button type="button" class="btn sm" data-ck="add">◆ Add keyframe</button><button type="button" class="btn sm" data-ck="del">Delete keyframe</button>
          <label class="fx-ease">Ease to next <select data-ck="ease"><option value="smooth">Smooth</option><option value="linear">Linear</option><option value="hold">Hold</option></select></label>
          <button type="button" class="btn sm ghost danger" data-ck="clear">Remove all</button></div>
        <p class="hint camk-hint"></p>
      </fieldset>
      <fieldset><legend>Camera</legend><div class="row2">
        ${SL.map(([k, l, mn, mx, st, u, tip]) => `<div class="field fxs"><label for="cam-${k}" title="${tip}">${l} <span class="opt" data-cout="${k}"></span></label>
          <input id="cam-${k}" data-cp="${k}" data-u="${u}" type="range" min="${mn}" max="${mx}" step="${st}"></div>`).join("")}
        <div class="field fxs"><label for="cam-shake">Handheld shake <span class="opt" data-cout="shake"></span></label><input id="cam-shake" data-c="shake" type="range" min="0" max="1" step="0.01"></div>
        <div class="field"><label for="cam-fill">Where the move uncovers the frame</label><select id="cam-fill" data-c="fill"><option value="black">Black</option><option value="blur">Blurred picture</option></select></div>
      </div><p class="hint">Double-click a slider to reset it. The render is exact; it has no depth, so for real parallax and new surroundings use the AI reshoot below.</p></fieldset>
      <fieldset class="cam-ai"><legend>AI reshoot</legend>
        <p class="hint">Makes guide frames along this move, has FLUX Klein fill in what the camera newly sees (from your words and
          reference pictures), then MiniMax H3 regenerates the shot. The result goes on a new track above, and this move is turned off.</p>
        <div class="field"><label for="cam-prompt">Describe the scene and what's around it</label>
          <textarea id="cam-prompt" rows="3" maxlength="4000" placeholder="A rainy back alley at night: brick walls, fire escapes, neon signs further down, puddles on the ground"></textarea></div>
        <div class="field"><label>References <span class="opt">drag pictures here from the gallery or Media</span></label>
          <div class="cam-refs" tabindex="0"></div>
          <button type="button" class="link" data-ai="inputs">Use the Inputs step's reference pictures</button></div>
        <div class="row2">
          <div class="field"><label for="cam-guides">Guide frames</label><select id="cam-guides">${[2, 3, 4, 5, 6].map(n => `<option>${n}</option>`).join("")}</select></div>
          <div class="field"><label for="cam-quality">Quality</label><select id="cam-quality"><option value="draft">Draft (fast)</option><option value="standard">Standard</option><option value="full">Full</option></select></div>
        </div>
        <button type="button" class="btn primary" data-ai="go">🎬 Reshoot with AI</button>
      </fieldset>`;
    const keyed = () => !!c.cam.keys?.length;
    const now = () => camParamsAt({ ...c.cam, shake: 0 }, srcTime(c, tl.playhead), tl.playhead - c.start);
    const fmt = (k, v) => { const u = SL.find(x => x[0] === k)?.[5] ?? ""; return k === "shake" ? `${Math.round(v * 100)}%` : `${(+v).toFixed(u === "°" ? 1 : 2)}${u}`; };
    const keyAtCam = (create = false) => {
      const s = srcTime(c, tl.playhead), keys = c.cam.keys;
      let k = keys.find(x => Math.abs(x.t - s) < 0.5 / fps());
      if (!k && create) { const v = now(); k = { t: +s.toFixed(4), ease: "smooth", ...Object.fromEntries(CAM_PARAMS.map(p => [p, +(+v[p]).toFixed(4)])) }; keys.push(k); keys.sort((a, b) => a.t - b.t); }
      return k;
    };
    const renderRefs = () => {
      const box = form.querySelector(".cam-refs"), refs = c.cam.reshoot.references;
      box.innerHTML = refs.map((r, i) => `<span class="cam-ref"><img src="/api/media/thumb?path=${encodeURIComponent(r)}&w=96" alt=""><button type="button" data-rx="${i}" title="Remove">×</button></span>`).join("")
        || `<span class="hint">No reference pictures (optional).</span>`;
    };
    const renderKeys = () => {
      const bar = form.querySelector(".fxk-bar"), s0 = srcTime(c, c.start), L = dur(c), s = srcTime(c, tl.playhead), keys = c.cam.keys;
      const at = keys.find(x => Math.abs(x.t - s) < 0.5 / fps());
      bar.innerHTML = keys.map((k, i) => { const p = (k.t - s0) / L; return p < -0.001 || p > 1.001 ? "" : `<b class="fxk${k === at ? " on" : ""}" data-ki="${i}" style="left:${p * 100}%"></b>`; }).join("")
        + `<i class="fxk-ph" style="left:${clamp((s - s0) / L, 0, 1) * 100}%"></i>`;
      form.querySelector('[data-ck="del"]').disabled = !at;
      const es = form.querySelector('[data-ck="ease"]'); es.disabled = !at; es.value = at?.ease || "smooth";
      form.querySelector('[data-ck="clear"]').disabled = !keys.length;
      form.querySelector(".camk-hint").textContent = keys.length
        ? `${keys.length} keyframe${keys.length > 1 ? "s" : ""}: moving a slider sets a keyframe at the playhead${at ? " (you're on one)" : ""}.`
        : "Add a keyframe at the start, move the playhead, change the camera: that adds another, and the camera travels between them. Or pick a preset.";
    };
    const fill = () => {
      const v = now();
      for (const inp of form.querySelectorAll("[data-cp]")) { const k = inp.dataset.cp; inp.value = v[k]; form.querySelector(`[data-cout="${k}"]`).textContent = fmt(k, v[k]); }
      form.querySelector('[data-c="enabled"]').checked = c.cam.enabled !== false;
      form.querySelector('[data-c="shake"]').value = c.cam.shake; form.querySelector('[data-cout="shake"]').textContent = fmt("shake", c.cam.shake);
      form.querySelector('[data-c="fill"]').value = c.cam.fill;
      form.querySelector("#cam-prompt").value = c.cam.reshoot.prompt || "";
      form.querySelector("#cam-guides").value = c.cam.reshoot.guides || 3;
      form.querySelector("#cam-quality").value = c.cam.reshoot.quality || "draft";
      renderKeys(); renderRefs();
    };
    const live = () => { if (!playing) syncProgram(false); render(); };
    form.addEventListener("input", e => {
      const k = e.target.dataset.cp, ck = e.target.dataset.c;
      if (k) {
        const v = +e.target.value;
        if (keyed()) keyAtCam(true)[k] = v; else c.cam[k] = v;
        form.querySelector(`[data-cout="${k}"]`).textContent = fmt(k, v);
        renderKeys();
      } else if (ck === "enabled") c.cam.enabled = e.target.checked;
      else if (ck === "shake") { c.cam.shake = +e.target.value; form.querySelector('[data-cout="shake"]').textContent = fmt("shake", c.cam.shake); }
      else if (ck === "fill") c.cam.fill = e.target.value;
      else if (e.target.id === "cam-prompt") c.cam.reshoot.prompt = e.target.value;
      else if (e.target.id === "cam-guides") c.cam.reshoot.guides = +e.target.value;
      else if (e.target.id === "cam-quality") c.cam.reshoot.quality = e.target.value;
      if (!playing) syncProgram(false);
    });
    form.addEventListener("change", e => {
      if (e.target.dataset.ck === "ease") { const k = keyAtCam(); if (k) k.ease = e.target.value; live(); }
      if (["cam-guides", "cam-quality", "cam-fill"].includes(e.target.id)) e.target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    form.addEventListener("dblclick", e => {
      const k = e.target.dataset?.cp; if (!k) return;
      const v = k === "zoom" ? 1 : 0; e.target.value = v; e.target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    form.addEventListener("click", async e => {
      const pr = e.target.closest("[data-cpreset]")?.dataset.cpreset;
      if (pr) {
        const ps = CAM_PRESETS[pr];
        if (!ps) { c.cam.shake = 0.5; }
        else {
          const s0 = srcTime(c, c.start), s1 = s0 + dur(c);
          const full = o => ({ ...Object.fromEntries(CAM_PARAMS.map(p => [p, CAM_DEFAULT[p]])), ...o });
          c.cam.keys = [{ t: +s0.toFixed(4), ease: "smooth", ...full(ps[0]) }, { t: +s1.toFixed(4), ease: "smooth", ...full(ps[1]) }];
        }
        fill(); live(); return;
      }
      const ck = e.target.closest("[data-ck]")?.dataset.ck;
      if (ck && ck !== "ease") {
        const s0 = srcTime(c, c.start), keys = c.cam.keys, s = srcTime(c, tl.playhead), eps = 0.5 / fps();
        if (ck === "add") keyAtCam(true);
        if (ck === "del") { const k = keyAtCam(); if (k) keys.splice(keys.indexOf(k), 1); }
        if (ck === "clear") { if (keys.length) { const v = now(); for (const p of CAM_PARAMS) c.cam[p] = v[p]; } c.cam.keys = []; }
        if (ck === "prev") { const k = [...keys].reverse().find(x => x.t < s - eps); if (k) seek(c.start + k.t - s0); }
        if (ck === "next") { const k = keys.find(x => x.t > s + eps); if (k) seek(c.start + k.t - s0); }
        fill(); live(); return;
      }
      const rx = e.target.closest("[data-rx]");
      if (rx) { c.cam.reshoot.references.splice(+rx.dataset.rx, 1); renderRefs(); return; }
      const ai = e.target.closest("[data-ai]")?.dataset.ai;
      if (ai === "inputs") {
        const add = (typeof state !== "undefined" ? state.refs || [] : []).map(r => r.ref).filter(r => !c.cam.reshoot.references.includes(r));
        c.cam.reshoot.references = [...c.cam.reshoot.references, ...add].slice(0, 6);
        renderRefs(); if (!add.length) toast("The Inputs step has no reference pictures (H3 Reference).");
      }
      if (ai === "go") reshoot(c, e.target);
    });
    const refBox = form.querySelector(".cam-refs");
    refBox.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("text/x-bob-ref")) { e.preventDefault(); refBox.classList.add("drop"); } });
    refBox.addEventListener("dragleave", () => refBox.classList.remove("drop"));
    refBox.addEventListener("drop", e => {
      e.preventDefault(); refBox.classList.remove("drop");
      const ref = e.dataTransfer.getData("text/x-bob-ref");
      const kind = e.dataTransfer.getData("text/x-bob-kind") || (/\.(png|jpe?g|webp|bmp)$/i.test(ref) ? "image" : "");
      if (!ref || kind !== "image") return toast("References are pictures.");
      if (c.cam.reshoot.references.length >= 6) return toast("Up to 6 reference pictures.");
      if (!c.cam.reshoot.references.includes(ref)) c.cam.reshoot.references.push(ref);
      renderRefs();
    });
    form.querySelector(".fxk-bar").addEventListener("pointerdown", e => {
      const bar = e.currentTarget, r = bar.getBoundingClientRect(), s0 = srcTime(c, c.start), L = dur(c);
      const toS = x => s0 + clamp((x - r.left) / r.width, 0, 1) * L;
      const dia = e.target.closest(".fxk");
      if (!dia) { seek(c.start + toS(e.clientX) - s0); fill(); return; }
      e.preventDefault();
      const k = c.cam.keys[+dia.dataset.ki];
      bar.setPointerCapture(e.pointerId);
      const mv = ev => { k.t = +(Math.round(toS(ev.clientX) * fps()) / fps()).toFixed(4); c.cam.keys.sort((a, b) => a.t - b.t); seek(c.start + k.t - s0); fill(); };
      const up = () => { bar.removeEventListener("pointermove", mv); bar.removeEventListener("pointerup", up); render(); };
      bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", up);
    });
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm primary" data-a="done">Done</button>`;
    let committed = false;
    const commit = () => {
      if (committed) return; committed = true;
      if (snapshot() !== before) { undoStack.push(before); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = []; }
      camEdit = null; changed();
    };
    const w = WM.open({ id: "camera", title: `Camera · ${c.name}`, content: form, footer: foot, width: 780, height: 900, minWidth: 340, minHeight: 320, modal: false,
      onClose: () => { vp?.destroy(); dv.removeAttribute("src"); dv.load(); commit(); } });
    foot.querySelector('[data-a="done"]').onclick = () => w.close();

    /* ---- the 3D view */
    const LIM = { pan: [-80, 80], tilt: [-60, 60], roll: [-180, 180], zoom: [0.3, 5], dolly: [-2, 0.9], truck: [-2, 2], pedestal: [-2, 2], orbit: [-80, 80] };
    const dv = document.createElement("video");  // the depth video, for the relief
    dv.muted = true; dv.preload = "auto"; dv.playsInline = true;
    const sceneSize = () => { const b = canvasClip(), i = b && probeInfo.get(b.ref); if (b && !i) probe(b.ref).then(() => vp?.draw()); return [i?.width || 1280, i?.height || 720]; };
    const host = {
      scene() {
        if (!clip(c.id)) return null;
        const [W, H] = sceneSize(), still = { ...c.cam, shake: 0 };
        const at = l => Viewport3D.pose(camParamsAt(still, c.trim_in + l, l), W, H).pos;
        const n = 40, path = c.cam.keys.length ? Array.from({ length: n + 1 }, (_, i) => at(dur(c) * i / n)) : [];
        const keys = c.cam.keys.map(k => at(k.t - c.trim_in));
        const pic = picAt(tl.playhead)?.a;
        const colorEl = pic ? (pic.kind === "image" ? $("#prog-img") : $("#prog-video")) : null;
        return { W, H, cam: camParamsAt(still, srcTime(c, tl.playhead), tl.playhead - c.start), path, keys, colorEl,
          depth: !!c.cam.depth, amount: c.cam.depth?.amount ?? 0, fx: fxForGL(pic, tl.playhead) };
      },
      change(ch) {
        const k = keyed() ? keyAtCam(true) : c.cam;
        for (const [p, v] of Object.entries(ch)) if (LIM[p]) k[p] = +clamp(v, LIM[p][0], LIM[p][1]).toFixed(4);
        for (const inp of form.querySelectorAll("[data-cp]")) { const p = inp.dataset.cp, v = now()[p]; inp.value = v; form.querySelector(`[data-cout="${p}"]`).textContent = fmt(p, v); }
        renderKeys();
        if (!playing) syncProgram(false);
        vp?.draw();
      },
      commit() { render(); },
      playing: () => playing,
      modeChanged: m => form.querySelectorAll("[data-vm]").forEach(b => b.classList.toggle("active", b.dataset.vm === m)),
      lookChanged: on => form.querySelector('[data-v="look"]').classList.toggle("active", on),
    };
    const vp = Viewport3D.create(form.querySelector(".cam3d-canvas"), host);
    host.modeChanged("move");
    form.querySelector(".cam3d-bar").addEventListener("click", e => {
      const m = e.target.closest("[data-vm]")?.dataset.vm; if (m) return vp?.setMode(m);
      const v = e.target.closest("[data-v]")?.dataset.v;
      if (v === "look") vp?.setLook(!vp.look);
      if (v === "reset") vp?.reset();
      if (e.target.closest("[data-depth]")) analyseDepth(c, e.target.closest("[data-depth]"));
    });
    form.querySelector(".cam3d-bar").addEventListener("input", e => {
      if (e.target.dataset.damount == null || !c.cam.depth) return;
      c.cam.depth.amount = +e.target.value;
      form.querySelector(".cam3d-amt").textContent = `${Math.round(c.cam.depth.amount * 100)}%`;
      vp?.draw();
    });
    const seekDepth = () => {
      const d = c.cam.depth;
      if (!d) return;
      const t = Math.max(0, tl.playhead - d.t0);
      if (dv.readyState >= 1 && Math.abs(dv.currentTime - t) > 0.04) dv.currentTime = Math.min(t, (dv.duration || t + 1) - 0.01);
    };
    dv.addEventListener("seeked", () => vp?.readDepth(dv));
    dv.addEventListener("loadeddata", () => { seekDepth(); vp?.readDepth(dv); });
    const renderDepth = () => {
      const box = form.querySelector(".cam3d-depth"), d = c.cam.depth;
      const stale = d && d.sig !== pictureSig(c);
      box.innerHTML = d
        ? `<span class="hint inline${stale ? " warn" : ""}" title="${stale ? "The picture under the move changed since its depth was analysed" : "Depth Anything 3"}">${stale ? "⚠ Depth is out of date" : "Depth"}</span>
           <input type="range" data-damount min="0" max="1" step="0.01" value="${d.amount}" title="How far the picture stands out in depth (parallax)"><span class="cam3d-amt">${Math.round(d.amount * 100)}%</span>
           <button type="button" class="btn sm" data-depth title="Analyse the depth again">↻</button>`
        : `<button type="button" class="btn sm" data-depth title="Depth Anything 3 estimates how far everything is, for the 3D view and parallax in the render">🧊 Analyse depth</button>`;
      if (d && !dv.src.endsWith(encodeURIComponent(d.ref)) && dv.dataset.ref !== d.ref) { dv.dataset.ref = d.ref; dv.src = mediaUrl(d.ref); }
      if (!d) vp?.clearDepth();
    };
    let lastPh = null;
    camEdit = { clipId: c.id, win: w, renderDepth,
      refresh: () => { if (tl.playhead !== lastPh) { lastPh = tl.playhead; if (!playing) fill(); seekDepth(); } vp?.draw(); } };
    fill(); renderDepth(); live();
  }

  /* ---- depth analysis (Depth Anything 3 in ComfyUI, app/depth.py) */
  // What's under a camera move, so a depth analysis can tell when it's out of date.
  function pictureSig(c) {
    const vids = new Set(tl.tracks.filter(t => t.kind === "video" && !t.hidden).map(t => t.id));
    const parts = tl.clips.filter(x => vids.has(x.track) && x.start < end(c) && end(x) > c.start)
      .map(x => `${x.track}|${x.ref}|${x.start.toFixed(3)}|${x.trim_in.toFixed(3)}|${x.trim_out.toFixed(3)}|${JSON.stringify(x.fx || null)}`).sort();
    parts.push(`${c.start.toFixed(3)}|${end(c).toFixed(3)}`);
    let h = 5381; for (const ch of parts.join("#")) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    return h.toString(36);
  }
  const pendingDepth = new Map();  // item id → {clip, project}
  async function analyseDepth(c, btn) {
    if (!tl.clips.some(x => track(x.track)?.kind === "video" && x.start < end(c) && end(x) > c.start)) return toast("There's no picture under this camera move.");
    btn.disabled = true;
    try {
      await saveNow(true);
      const r = await fetch("/api/timeline/depth", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, clip: c.id, sig: pictureSig(c) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : j.detail?.[0]?.msg || r.statusText);
      pendingDepth.set(j.id, { clip: c.id, project });
      Activity.onEvent({ type: "item", item: j }); Activity.show(j.id);
      toast("Analysing depth with Depth Anything 3… the 3D view updates when it's done.");
    } catch (e) { toast(`Depth analysis failed: ${e.message}`); }
    finally { btn.disabled = false; }
  }

  /* ---- AI reshoot: start it, then put the result on the timeline when it's done */
  const pendingReshoots = new Map();  // item id → {clip, start, seconds, project}
  async function reshoot(c, btn) {
    if (!c.cam.reshoot.prompt?.trim()) return toast("Describe the scene first: the model uses it to fill in what the camera now sees.");
    if (!tl.clips.some(x => track(x.track)?.kind === "video")) return toast("There's no picture under the camera move.");
    btn.disabled = true;
    const job = Activity.task("Preparing the reshoot (guide frames)");
    try {
      await saveNow(true);
      const r = await fetch("/api/timeline/reshoot", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, clip: c.id, prompt: c.cam.reshoot.prompt, references: c.cam.reshoot.references,
          guides: c.cam.reshoot.guides, quality: c.cam.reshoot.quality, seed: c.cam.reshoot.seed ?? -1 }) });
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : j.detail?.[0]?.msg || r.statusText);
      job.done("Guide frames ready: the reshoot is running.");
      for (const it of j.items) {
        pendingReshoots.set(it.id, { clip: c.id, start: j.start, seconds: j.seconds, project });
        state.items.set(it.id, it); Activity.onEvent({ type: "item", item: it });
      }
      try { localStorage.setItem("bob.reshoots", JSON.stringify([...pendingReshoots])); } catch {}
      renderGallery(); renderQueue();
      Activity.show(j.items[0]?.id);
      toast("Reshooting… the new shot goes on the timeline when it's done.");
    } catch (e) { job.fail(e); toast(`Reshoot failed: ${e.message}`); }
    finally { btn.disabled = false; }
  }
  async function onItem(it) {
    if (it.engine === "depth" && ["done", "failed"].includes(it.status)) {
      const pd = pendingDepth.get(it.id);
      pendingDepth.delete(it.id);
      const cam = clip(it.params?.camera_clip);
      if (it.status !== "done" || !cam?.cam || (pd && pd.project !== project) || !it.files?.[0]) return;
      checkpoint();
      cam.cam.depth = { ref: it.files[0].path, t0: it.params.start ?? cam.start, sig: it.params.sig || "", amount: cam.cam.depth?.amount ?? 0.25 };
      changed();
      if (camEdit?.clipId === cam.id) camEdit.renderDepth?.();
      toast("Depth is ready: the 3D view shows the relief, and the render adds parallax.");
      return;
    }
    if (!pendingReshoots.size) { try { for (const [k, v] of JSON.parse(localStorage.getItem("bob.reshoots") || "[]")) pendingReshoots.set(k, v); } catch {} }
    const p = pendingReshoots.get(it.id);
    if (!p || !["done", "failed", "cancelled"].includes(it.status)) return;
    pendingReshoots.delete(it.id);
    try { localStorage.setItem("bob.reshoots", JSON.stringify([...pendingReshoots])); } catch {}
    if (it.status !== "done" || p.project !== project || !tl) return;
    const f = it.files?.find(x => /^video\//.test(x.content_type || "")) || it.files?.[0];
    if (!f) return;
    checkpoint();
    const n = tl.tracks.filter(t => t.kind === "video").length + 1;
    const tr = { id: uid(), kind: "video", name: `V${n} Reshoot`, muted: false, locked: false, hidden: false, volume: 1, height: 56 };
    const camIdx = tl.tracks.findIndex(t => t.kind === "camera");
    tl.tracks.splice(camIdx + 1, 0, tr);  // just under the Camera track: on top of the picture
    const cam = clip(p.clip);
    if (cam?.cam) cam.cam.enabled = false;  // the reshoot already has the move
    changed();
    const added = await add({ ref: f.path, kind: "video", name: `Reshoot · ${cam?.name || "camera move"}`, job: it.id }, { track: tr.id, at: p.start, noSound: true });
    if (added && p.seconds && dur(added) > p.seconds + 1e-3) { added.trim_out = q(added.trim_in + p.seconds); changed(); }
    toast("The reshoot is on the timeline (its own track); the camera move is now off. Undo (Ctrl+Z) to go back.");
  }

  /* ------------------------------------------------------------------ waveform graphs on audio tracks
     Peak (light) and RMS (solid) levels from /api/media/peaks, scaled by what the mix does to the
     clip (clip × track volume, fades, crossfades), so the graph shows what you'll hear; red where it
     would go over full scale. The yellow line is the volume envelope (middle = 100 %, top = 200 %). */
  const peaksCache = new Map();
  function peaksOf(ref) {
    if (!peaksCache.has(ref)) {
      peaksCache.set(ref, fetch(`/api/media/peaks?path=${encodeURIComponent(ref)}`).then(r => r.ok ? r.json() : null).catch(() => null)
        .then(j => { peaksCache.set(ref, j || { rate: 1, peak: [], rms: [] }); render(); return j; }));
    }
    const v = peaksCache.get(ref);
    return v instanceof Promise ? null : v;
  }
  function envGain(c, t) {
    const tr = track(c.track);
    const [fin, fout] = fadesOf(c), L = dur(c), x = t - c.start;
    let g = volAt(c, t) * (tr?.volume ?? 1);
    if (fin > 1e-6 && x < fin) g *= clamp(x / fin, 0, 1);
    if (fout > 1e-6 && L - x < fout) g *= clamp((L - x) / fout, 0, 1);
    return g;
  }
  let waveColor = null;
  function drawWave(c, cv) {
    if (!cv || !tl) return;
    const pk = peaksOf(c.ref);
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(1, Math.round(dur(c) * tl.zoom)), H = Math.max(8, cv.parentElement.clientHeight || 30);
    const scale = Math.min(dpr, 16000 / W);  // canvases have a size limit; very long clips draw coarser
    cv.width = Math.max(1, Math.round(W * scale)); cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d");
    g.clearRect(0, 0, cv.width, cv.height);
    if (!pk) return;
    waveColor = waveColor || getComputedStyle(root).getPropertyValue("--audio").trim() || "#3ccfc0";
    const tr = track(c.track), quiet = c.muted || tr?.muted || (tl.tracks.some(x => x.solo) && !tr?.solo);
    const mid = cv.height / 2, amp = cv.height / 2 - 1, n = cv.width, rate = pk.rate || 100;
    const levels = (arr, s0, s1) => { let m = 0, a = Math.floor(s0 * rate), b = Math.max(a + 1, Math.ceil(s1 * rate)); for (let i = a; i < b && i < arr.length; i++) if (arr[i] > m) m = arr[i]; return m / 255; };
    const col = quiet ? "rgba(160,160,170," : null;
    for (const [arr, alpha] of [[pk.peak, 0.45], [pk.rms, 0.95]]) {
      g.fillStyle = col ? col + alpha * 0.6 + ")" : waveColor;
      g.globalAlpha = col ? 1 : alpha;
      for (let x = 0; x < n; x++) {
        const t0 = x / scale / tl.zoom, t1 = (x + 1) / scale / tl.zoom;
        const v = levels(arr, c.trim_in + t0, c.trim_in + t1) * envGain(c, c.start + t0);
        if (v <= 0.002) continue;
        const h = Math.min(1, v) * amp;
        g.fillRect(x, mid - h, 1, h * 2);
        if (v >= 1 && arr === pk.peak) { g.save(); g.globalAlpha = 1; g.fillStyle = "#ff4d5a"; g.fillRect(x, 0, 1, 2 * dpr); g.fillRect(x, cv.height - 2 * dpr, 1, 2 * dpr); g.restore(); }
      }
    }
    g.globalAlpha = 1;
    // Volume envelope: middle = 100 %, top = 200 %.
    g.strokeStyle = "rgba(245,185,66,.9)"; g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    for (let x = 0; x <= n; x += Math.max(1, Math.round(2 * dpr))) {
      const y = cv.height - clamp(envGain(c, c.start + x / scale / tl.zoom) / 2, 0, 1) * (cv.height - 2) - 1;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    // Volume keyframes: dots on the line (drag to move, double-click to delete; click the line to add).
    const s0 = c.kind === "image" ? 0 : c.trim_in;
    g.fillStyle = "#f5b942"; g.strokeStyle = "#000"; g.lineWidth = dpr;
    for (const k of c.vol_keys || []) {
      const x = (k.t - s0) * tl.zoom * scale;
      if (x < -4 || x > n + 4) continue;
      const y = cv.height - clamp(k.v * (tr?.volume ?? 1) / 2, 0, 1) * (cv.height - 2) - 1;
      g.beginPath(); g.arc(x, y, 3.5 * dpr, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
  // Volume line hit-testing on an audio clip's graph: a key dot, the line, or nothing.
  function volHit(c, cv, clientX, clientY) {
    const r = cv.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
    const tr = track(c.track), s0 = c.kind === "image" ? 0 : c.trim_in;
    const yOf = v => r.height - clamp(v * (tr?.volume ?? 1) / 2, 0, 1) * (r.height - 2) - 1;
    const keys = c.vol_keys || [];
    const ki = keys.findIndex(k => Math.hypot((k.t - s0) * tl.zoom - x, yOf(k.v) - y) <= 7);
    if (ki >= 0) return { key: ki };
    const t = c.start + x / tl.zoom;
    if (Math.abs(yOf(volAt(c, t)) - y) <= 5) return { line: true, s: s0 + x / tl.zoom };
    return null;
  }
  function dragVolume(e, c, cv, hit) {
    if (!editable(c)) return toast("That track is locked.");
    e.preventDefault(); e.stopPropagation();
    const before = snapshot(), tr = track(c.track), s0 = c.kind === "image" ? 0 : c.trim_in;
    c.vol_keys = c.vol_keys || [];
    let k;
    if (hit.line) {
      if (!c.vol_keys.length) {  // the first point: pin the current level at both ends so only this part moves
        c.vol_keys.push({ t: +s0.toFixed(4), v: c.volume ?? 1, ease: "linear" }, { t: +(s0 + dur(c)).toFixed(4), v: c.volume ?? 1, ease: "linear" });
      }
      k = { t: +hit.s.toFixed(4), v: +volAt(c, c.start + (hit.s - s0)).toFixed(4), ease: "linear" };
      c.vol_keys.push(k);
    } else k = c.vol_keys[hit.key];
    c.vol_keys.sort((a, b) => a.t - b.t);
    const r = cv.getBoundingClientRect();
    const mv = ev => {
      const s = s0 + clamp((ev.clientX - r.left) / tl.zoom, 0, dur(c));
      k.t = +(Math.round(s * fps()) / fps()).toFixed(4);
      k.v = +clamp((r.height - 1 - (ev.clientY - r.top)) / (r.height - 2) * 2 / (tr?.volume || 1), 0, 2).toFixed(4);
      c.vol_keys.sort((a, b) => a.t - b.t);
      drawWave(c, cv);
      const el = cv.closest(".tl-clip"); if (el) $(".tl-cdur", el).textContent = dbText(k.v);
      if (!playing) syncProgram(false);
    };
    const up = () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      undoStack.push(before); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = [];
      changed();
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
    mv(e);
  }
  function drawWaves() {
    if (!root) return;
    for (const cv of $$(".tl-wave", root)) { const c = clip(cv.dataset.wave); if (c) drawWave(c, cv); }
  }

  /* ------------------------------------------------------------------ render */
  function rulerStep() {
    const steps = [1 / fps(), 2 / fps(), 6 / fps(), 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return steps.find(s => s * tl.zoom >= 64) || 600;
  }

  function render() {
    if (!root || !tl) return;
    const width = Math.max((total() + 20) * tl.zoom, (scroller?.clientWidth || 800) - headW() + 200);
    const step = rulerStep(), minor = step / 4;
    let ticks = "";
    for (let t = 0; t * tl.zoom <= width; t += minor) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ticks += `<i class="${major ? "mj" : "mn"}" style="left:${t * tl.zoom}px">${major ? `<span>${tc(t)}</span>` : ""}</i>`;
    }
    const range = tl.range_in != null || tl.range_out != null
      ? `<div class="tl-range" style="left:${(tl.range_in ?? 0) * tl.zoom}px;width:${((tl.range_out ?? total()) - (tl.range_in ?? 0)) * tl.zoom}px"></div>` : "";
    const markers = tl.markers.map(m => `<b class="tl-marker" data-marker="${m.id}" style="left:${m.t * tl.zoom}px" title="${esc2(m.label)} · ${tc(m.t)}"><span>${esc2(m.label)}</span></b>`).join("");

    const rows = tl.tracks.map(tr => {
      const clips = tl.clips.filter(c => c.track === tr.id).map(clipHTML).join("") + tl.transitions.filter(t => t.track === tr.id).map(t => {
        const b = clip(t.b), d = transLength(t);
        if (!b || d <= 0) return "";
        return `<div class="tl-trans${t.id === selTrans ? " sel" : ""}${tr.kind === "audio" ? " snd" : ""}" data-trans="${t.id}" style="left:${b.start * tl.zoom}px;width:${d * tl.zoom}px"
          title="${esc2(transLabel(t))} · ${d.toFixed(2)}s — double-click to change"><span>${tr.kind === "audio" ? "◇" : "⧓"}</span></div>`;
      }).join("");
      return `<div class="tl-row k-${tr.kind}${tr.locked ? " locked" : ""}${tr.muted || (tl.tracks.some(x => x.solo) && !tr.solo) ? " muted" : ""}${tr.hidden ? " hidden-track" : ""}" style="--h:${tr.height}px">
        <div class="tl-head" data-track="${tr.id}">
          <span class="tl-tname" title="Double-click to rename">${esc2(tr.name)}</span>
          <span class="tl-tbtns">
            ${tr.kind !== "audio" ? `<button type="button" data-tact="hidden" class="${tr.hidden ? "off" : ""}" title="${tr.kind === "camera" ? (tr.hidden ? "Turn the camera moves on" : "Turn all camera moves off") : (tr.hidden ? "Show" : "Hide") + " track"}">👁</button>` : ""}
            ${tr.kind === "camera" ? `<button type="button" data-cam-add title="Add a camera move at the playhead">＋</button>` : `<button type="button" data-tact="muted" class="${tr.muted ? "off" : ""}" title="${tr.muted ? "Unmute" : "Mute"} track">${tr.muted ? "🔇" : "🔊"}</button>
            <button type="button" data-tact="solo" class="tl-solo${tr.solo ? " on" : ""}" title="${tr.solo ? "Unsolo" : "Solo: hear only soloed tracks"}">S</button>`}
            <button type="button" data-tact="locked" class="${tr.locked ? "on" : ""}" title="${tr.locked ? "Unlock" : "Lock"} track">${tr.locked ? "🔒" : "🔓"}</button>
          </span></div>
        <div class="tl-lane" data-track="${tr.id}">${clips}</div></div>`;
    }).join("");

    $(".tl-canvas", root).innerHTML = `
      <div class="tl-row tl-rulerrow"><div class="tl-head tl-corner"><span class="tl-tc" title="Click: frames or seconds">${tc(tl.playhead)}</span></div>
        <div class="tl-ruler" style="width:${width}px">${range}${ticks}${markers}
          ${tl.range_in != null ? `<b class="tl-io in" style="left:${tl.range_in * tl.zoom}px" title="In ${tc(tl.range_in)}">I</b>` : ""}
          ${tl.range_out != null ? `<b class="tl-io out" style="left:${tl.range_out * tl.zoom}px" title="Out ${tc(tl.range_out)}">O</b>` : ""}</div></div>
      ${rows}
      <div class="tl-addrow"><div class="tl-head tl-addhead"><button type="button" class="link" data-act="add-video">＋ Video</button><button type="button" class="link" data-act="add-audio">＋ Audio</button><button type="button" class="link" data-act="add-camera">＋ Camera</button></div><div class="tl-lane tl-dead" style="width:${width}px"></div></div>
      <div class="tl-playhead" style="left:${headW() + tl.playhead * tl.zoom}px"></div>
      <div class="tl-snap" hidden></div>
      ${tl.range_in != null || tl.range_out != null ? `<div class="tl-dim l" style="left:${headW()}px;width:${(tl.range_in ?? 0) * tl.zoom}px"></div>
        <div class="tl-dim r" style="left:${headW() + (tl.range_out ?? total()) * tl.zoom}px;right:0"></div>` : ""}`;
    $(".tl-canvas", root).style.width = `${headW() + width}px`;
    drawWaves();
    renderBar();
    if (Monitor.mode === "timeline") syncProgram(false);
  }

  function clipHTML(c) {
    const w = Math.max(2, dur(c) * tl.zoom), tr = track(c.track);
    if (c.kind === "camera") {
      const s0 = srcTime(c, c.start);
      const keys = (c.cam?.keys || []).map(k => { const p = (k.t - s0) * tl.zoom; return p < -1 || p > w + 1 ? "" : `<i class="tl-key" style="left:${p}px"></i>`; }).join("");
      return `<div class="tl-clip k-camera${sel.has(c.id) ? " sel" : ""}${c.cam?.enabled === false ? " cam-off" : ""}" data-clip="${c.id}" style="left:${c.start * tl.zoom}px;width:${w}px"
        title="${esc2(c.name)} · ${camSummary(c)} — double-click to edit the camera">
        <div class="tl-strip"></div><span class="tl-cname">🎥 ${esc2(c.name)}</span><span class="tl-cdur">${camSummary(c)}</span>${keys}
        <i class="tl-trim l" data-trim="l"></i><i class="tl-trim r" data-trim="r"></i></div>`;
    }
    const thumb = `/api/media/thumb?path=${encodeURIComponent(c.ref)}&w=${c.kind === "audio" || tr.kind === "audio" ? 384 : 160}&v=1`;
    const sound = tr.kind === "audio";
    const bg = sound ? "" : `background-image:url('${thumb}');background-size:auto 100%`;
    const hasSnd = c.kind !== "image" && (sound || !c.audio_off);
    const fi = c.fade_in || 0, fo = c.fade_out || 0, vol = c.volume ?? 1;
    const db = vol <= 0 ? "silent" : `${vol >= 1 ? "+" : ""}${(20 * Math.log10(vol)).toFixed(1)} dB`;
    const mix = hasSnd ? [Math.abs(vol - 1) > 1e-3 && db, Math.abs(c.pan || 0) > 1e-3 && `pan ${c.pan < 0 ? "L" : "R"}${Math.round(Math.abs(c.pan) * 100)}`,
      fi > 0 && `fade in ${fi.toFixed(2)}s`, fo > 0 && `fade out ${fo.toFixed(2)}s`, c.muted && "muted"].filter(Boolean).join(" · ") : "";
    const fades = hasSnd ? `<i class="tl-fade in" style="width:${fi * tl.zoom}px"></i><i class="tl-fade out" style="width:${fo * tl.zoom}px"></i>
      <b class="tl-fh in" data-fade="in" style="left:${fi * tl.zoom}px" title="Drag: fade in"></b><b class="tl-fh out" data-fade="out" style="right:${fo * tl.zoom}px" title="Drag: fade out"></b>` : "";
    return `<div class="tl-clip k-${c.kind}${sound ? " snd" : ""}${sel.has(c.id) ? " sel" : ""}${c.link ? " linked" : ""}${c.audio_off ? " silent" : ""}${c.muted ? " cmuted" : ""}${fxOn(c) ? " has-fx" : ""}" data-clip="${c.id}" style="left:${c.start * tl.zoom}px;width:${w}px"
      title="${esc2(c.name)}${c.link ? " · linked (Alt+click selects just this one)" : ""}${c.audio_off ? " · sound on its linked audio clip" : ""}${mix ? " · " + esc2(mix) : ""}">
      <div class="tl-strip" style="${bg}">${sound && c.kind !== "image" ? `<canvas class="tl-wave" data-wave="${c.id}"></canvas>` : ""}</div>${fades}${fxOn(c) && c.fx.keys?.length ? c.fx.keys.map(k => {
        const p = (k.t - srcTime(c, c.start)) * tl.zoom;
        return p < -1 || p > w + 1 ? "" : `<i class="tl-key" style="left:${p}px" title="Fx keyframe"></i>`; }).join("") : ""}
      <span class="tl-cname">${esc2(c.name)}</span><span class="tl-cdur">${dur(c).toFixed(2)}s</span>
      <i class="tl-trim l" data-trim="l"></i><i class="tl-trim r" data-trim="r"></i></div>`;
  }

  function drawPlayhead() {
    if (!root) return;
    const ph = $(".tl-playhead", root);
    if (ph) ph.style.left = `${headW() + tl.playhead * tl.zoom}px`;
    const t = $(".tl-tc", root); if (t) t.textContent = tc(tl.playhead);
    const big = $(".tl-time", root); if (big) big.textContent = `${tc(tl.playhead)} / ${tc(total())}`;
  }

  function renderBar() {
    const b = root && $(".tl-bar", root);
    if (!b || !tl) return;
    $('[data-act="play"]', b).textContent = playing ? "⏸" : "▶";
    $('[data-act="play"]', b).title = playing ? "Pause (Space / K)" : "Play (Space / L)";
    $('[data-act="snap"]', b).classList.toggle("on", tl.snap);
    $('[data-act="linkaudio"]', b).classList.toggle("on", tl.link_audio !== false);
    $('[data-act="loop"]', b).classList.toggle("on", loop);
    $('[data-act="undo"]', b).disabled = !undoStack.length;
    $('[data-act="redo"]', b).disabled = !redoStack.length;
    $(".tl-zoom", b).value = Math.log(tl.zoom);
    drawPlayhead();
  }

  /* ------------------------------------------------------------------ pointer interaction */
  function timeAt(clientX) { const lane = $(".tl-ruler", root).getBoundingClientRect(); return Math.max(0, (clientX - lane.left) / tl.zoom); }

  function snapTargets(exclude) {
    const pts = [0, tl.playhead, ...tl.markers.map(m => m.t)];
    if (tl.range_in != null) pts.push(tl.range_in);
    if (tl.range_out != null) pts.push(tl.range_out);
    for (const c of tl.clips) if (!exclude.has(c.id)) pts.push(c.start, end(c));
    return pts;
  }
  function snapTo(times, targets, alt) {
    // Returns the shift (seconds) that lands the nearest of `times` on a target, or 0.
    if (!tl.snap || alt) return { d: 0, at: null };
    let best = { d: 0, at: null, dist: SNAP_PX / tl.zoom };
    for (const t of times) for (const p of targets) { const dd = Math.abs(p - t); if (dd < best.dist) best = { d: p - t, at: p, dist: dd }; }
    return best;
  }
  function showSnap(at) {
    const s = $(".tl-snap", root); if (!s) return;
    s.hidden = at == null;
    if (at != null) s.style.left = `${headW() + at * tl.zoom}px`;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const clipEl = e.target.closest(".tl-clip"), marker = e.target.closest(".tl-marker");
    const ruler = e.target.closest(".tl-ruler"), lane = e.target.closest(".tl-lane");
    if (marker) return dragMarker(e, marker.dataset.marker);
    const transEl = e.target.closest(".tl-trans");
    if (transEl) { selTrans = transEl.dataset.trans; sel.clear(); render(); return; }
    if (clipEl && e.target.closest(".tl-fh")) return dragFade(e, clipEl.dataset.clip, e.target.closest(".tl-fh").dataset.fade);
    const wave = e.target.closest(".tl-wave");
    if (clipEl && wave && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const c = clip(clipEl.dataset.clip), hit = c && volHit(c, wave, e.clientX, e.clientY);
      if (hit) { sel.clear(); for (const g of grp(c)) sel.add(g.id); return dragVolume(e, c, wave, hit); }
    }
    if (clipEl) return dragClip(e, clipEl.dataset.clip, e.target.dataset.trim || null);
    if (ruler || lane) {
      if (lane && !e.shiftKey && !e.ctrlKey) { sel.clear(); render(); }
      Monitor.show("timeline");
      const was = playing; if (was) pause();
      seek(timeAt(e.clientX), { reveal: false });
      const mv = ev => seek(timeAt(ev.clientX), { reveal: false });
      const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (was) play(); };
      addEventListener("pointermove", mv); addEventListener("pointerup", up);
    }
  }

  function dragClip(e, id, trim) {
    const c = clip(id);
    if (!c) return;
    const group = e.altKey ? [c] : grp(c);  // linked clips select together; Alt+click picks just one
    selTrans = null;
    if (e.ctrlKey || e.metaKey) { const on = sel.has(id); for (const g of group) on ? sel.delete(g.id) : sel.add(g.id); render(); return; }
    if (!sel.has(id)) { sel.clear(); for (const g of group) sel.add(g.id); }
    const moving = [...sel].map(clip).filter(x => x && editable(x));
    if (!moving.includes(c)) { render(); return toast("That track is locked."); }
    const before = snapshot(), x0 = e.clientX, orig = new Map(moving.map(m => [m.id, { ...m }]));
    // Linked partners that were in step with c follow its trims.
    const partners = moving.filter(m => m !== c && m.link && m.link === c.link && Math.abs(m.start - c.start) < 1e-6 && Math.abs(dur(m) - dur(c)) < 1e-6);
    const followPartners = () => { for (const pp of partners) { pp.start = c.start; pp.trim_in = c.trim_in; pp.trim_out = c.trim_out; } };
    let shiftAtEnd = false;
    const exclude = new Set(moving.map(m => m.id)), targets = snapTargets(exclude);
    let moved = false;
    root.classList.add("dragging");
    const mv = ev => {
      const dx = (ev.clientX - x0) / tl.zoom;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      if (trim) {
        const o = orig.get(id), f = 1 / fps();
        if (trim === "l") {
          let d = dx; const s = snapTo([o.start + d], targets, ev.altKey); d += s.d;
          d = Math.max(d, -o.start, c.kind === "image" ? -Infinity : -o.trim_in);
          d = Math.min(d, dur(o) - f);
          c.start = q(o.start + d);
          if (c.kind === "image") { c.trim_in = 0; c.trim_out = q(dur(o) - d); }  // a still just gets shorter or longer
          else c.trim_in = q(o.trim_in + d);
          followPartners();
          showSnap(s.at);
        } else {
          let d = dx; const s = snapTo([end(o) + d], targets, ev.altKey); d += s.d;
          d = Math.max(d, f - dur(o));
          if (c.source_duration) d = Math.min(d, c.source_duration - o.trim_out);
          c.trim_out = q(o.trim_out + d);
          followPartners();
          showSnap(s.at);
        }
        for (const x of [c, ...partners]) {
          const el = $(`[data-clip="${x.id}"]`, root);
          if (!el) continue;
          el.style.left = `${x.start * tl.zoom}px`; el.style.width = `${dur(x) * tl.zoom}px`;
          $(".tl-cdur", el).textContent = `${dur(x).toFixed(2)}s`;
        }
        ghost(c);
      } else {
        let d = dx;
        const edges = moving.flatMap(m => { const o = orig.get(m.id); return [o.start + d, o.start + d + dur(o)]; });
        const s = snapTo(edges, targets, ev.altKey); d += s.d;
        d = Math.max(d, -Math.min(...moving.map(m => orig.get(m.id).start)));
        for (const m of moving) m.start = q(orig.get(m.id).start + d);
        // Follow the pointer to another track of the same kind (when no other moving clip shares that kind).
        shiftAtEnd = ev.shiftKey;
        if (!moving.some(m => m !== c && track(m.track).kind === track(c.track).kind)) {
          const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".tl-lane[data-track]");
          const tr = lane && track(lane.dataset.track);
          const ok = tr && !tr.locked && (c.kind === "camera" ? tr.kind === "camera" : tr.kind !== "camera" && (tr.kind === "video" ? c.kind !== "audio" : c.kind !== "image"));
          if (ok && tr.id !== c.track) { c.track = tr.id; render(); }
        }
        for (const m of moving) { const el = $(`[data-clip="${m.id}"]`, root); if (el) el.style.left = `${m.start * tl.zoom}px`; }
        showSnap(s.at);
      }
    };
    const up = () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      root.classList.remove("dragging"); showSnap(null); $(".tl-ghost", root)?.remove();
      if (moved) {
        undoStack.push(before); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = [];
        // Shift held at the drop: overlapping the end of the clip before makes a transition instead of overwriting it.
        if (shiftAtEnd && !trim) for (const m of moving) {
          if (track(m.track).kind !== "video") continue;
          const a = tl.clips.find(x => x.track === m.track && !exclude.has(x.id) && x.start < m.start && m.start < end(x) && end(m) > end(x));
          if (a && !transBetween(a, m)) { tl.transitions.push({ id: uid(), track: m.track, a: a.id, b: m.id, type: lastType }); linkPartnerTransitions(a, m, lastType); }
        }
        settle(moving);
        changed();
      } else render();
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  }

  // Drag the little handle at a clip's top corner to set its sound fade-in / fade-out.
  function dragFade(e, id, which) {
    const c = clip(id);
    if (!c || !editable(c)) return toast("That track is locked.");
    e.stopPropagation();
    const before = snapshot(), x0 = e.clientX, key = which === "in" ? "fade_in" : "fade_out", other = which === "in" ? "fade_out" : "fade_in";
    const o = c[key] || 0, el = $(`[data-clip="${id}"]`, root);
    let moved = false;
    const mv = ev => {
      const d = (ev.clientX - x0) / tl.zoom;
      moved = moved || Math.abs(ev.clientX - x0) > 2;
      c[key] = q(clamp(which === "in" ? o + d : o - d, 0, Math.max(0, dur(c) - (c[other] || 0))));
      $(`.tl-fade.${which}`, el).style.width = `${c[key] * tl.zoom}px`;
      $(`.tl-fh.${which}`, el).style[which === "in" ? "left" : "right"] = `${c[key] * tl.zoom}px`;
      $(".tl-cdur", el).textContent = `fade ${which} ${c[key].toFixed(2)}s`;
      drawWave(c, $(".tl-wave", el));
    };
    const up = () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      if (moved) { undoStack.push(before); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = []; changed(); }
      else render();
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  }

  function ghost(c) {
    // While trimming, show the whole source as a dotted outline (EDITS-WITH-AI idea).
    if (!c.source_duration) return;
    const lane = $(`.tl-lane[data-track="${c.track}"]`, root);
    let g = $(".tl-ghost", root);
    if (!g) { g = document.createElement("div"); g.className = "tl-ghost"; lane.appendChild(g); }
    const s0 = c.start - c.trim_in;
    g.style.left = `${s0 * tl.zoom}px`; g.style.width = `${c.source_duration * tl.zoom}px`;
  }

  function dragMarker(e, id) {
    const m = tl.markers.find(x => x.id === id), x0 = e.clientX, t0 = m.t, before = snapshot();
    let moved = false;
    const mv = ev => { moved = true; m.t = q(Math.max(0, t0 + (ev.clientX - x0) / tl.zoom)); render(); };
    const up = () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      if (moved) { undoStack.push(before); redoStack = []; save(); } else seek(m.t);
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  }

  /* ------------------------------------------------------------------ menus */
  function clipMenu(x, y, id) {
    const c = clip(id);
    if (!sel.has(id)) { sel.clear(); sel.add(id); render(); }
    const isVid = c.kind === "video";
    menu(x, y, [
      ["Split at playhead (S)", splitSelection],
      ["Duplicate (Ctrl+D)", duplicate],
      ["Copy (Ctrl+C)", copySel],
      track(c.track).kind === "video" && ["⧓ Add transition at the nearest cut (Ctrl+T)", () => addTransition()],
      c.link && ["Unlink video and sound", () => unlink(c)],
      !c.link && isVid && track(c.track).kind === "video" && !c.audio_off && ["Detach sound to an audio track", () => detachSound(c)],
      sel.size === 2 && !c.link && ["Link the two selected clips", () => linkPair([...sel].map(clip))],
      isVid && ["Continue from this clip's last frame", () => grabFrame(c, c.trim_out - 1 / fps())],
      isVid && ["Use the frame at the playhead", () => grabAtPlayhead()],
      c.kind !== "camera" && ["Show in viewer", () => { const it = c.job && state.items.get(c.job); if (it) { select(it.id); Monitor.show("result"); } else Media.toast("The result for this clip isn't in the gallery."); }],
      c.kind === "camera" && ["🎥 Camera… (move, keyframes, AI reshoot)", () => cameraDialog(c)],
      c.kind === "camera" && [c.cam?.enabled === false ? "Turn this camera move on" : "Turn this camera move off", () => { checkpoint(); c.cam.enabled = c.cam.enabled === false; changed(); }],
      fxTargets(c) && ["✨ Video Fx… (light, grade, vignette) (Shift+E)", () => fxDialog(c)],
      fxTargets(c) && fxClipboard && ["Paste Fx", () => { checkpoint(); for (const x of [...sel].map(clip).filter(fxTargets)) x.fx = structuredClone(fxClipboard); changed(); }],
      fxTargets(c) && c.fx && ["Copy Fx", () => { fxClipboard = structuredClone(c.fx); toast("Effects copied."); }],
      fxTargets(c) && c.fx && [c.fx.enabled === false ? "Turn Fx on" : "Turn Fx off", () => { checkpoint(); c.fx.enabled = c.fx.enabled === false; changed(); }],
      c.kind !== "image" && c.kind !== "camera" && ["🔉 Sound… (volume, pan, fades, mute)", () => soundDialog(c)],
      c.vol_keys?.length && ["Remove volume keyframes", () => { checkpoint(); c.vol_keys = []; changed(); }],
      c.kind !== "image" && c.kind !== "camera" && [soundTargets(c).every(x => x.muted) ? "Unmute clip sound" : "Mute clip sound", () => {
        checkpoint(); const m = !soundTargets(c).every(x => x.muted); for (const x of soundTargets(c)) x.muted = m; changed();
      }],
      ["Delete (Del)", () => deleteSelection(false)],
      ["Ripple delete (Shift+Del)", () => deleteSelection(true)],
    ].filter(Boolean));
  }
  function transMenu(x, y, id) {
    const t = tl.transitions.find(k => k.id === id);
    if (!t) return;
    selTrans = id; render();
    const audio = track(t.track).kind === "audio";
    menu(x, y, [
      ...(audio ? [] : TRANSITIONS.slice(0, 10).map(([k, l]) => [`${t.type === k ? "● " : "○ "}${l}`, () => setTransitionType(t, k)])),
      ["More types and length…", () => transitionDialog(t)],
      ["Delete transition (Del)", () => removeTransition(t)],
    ]);
  }
  function transitionDialog(t) {
    const audio = track(t.track).kind === "audio";
    const form = document.createElement("div");
    form.className = "wm-form";
    form.innerHTML = `
      ${audio ? `<p class="hint">Sound transitions are crossfades.</p>` : `<div class="field"><label for="tr-type">Type</label>
        <select id="tr-type">${TRANSITIONS.map(([k, l]) => `<option value="${k}"${k === t.type ? " selected" : ""}>${l}</option>`).join("")}</select></div>`}
      <div class="field"><label for="tr-len">Length <span class="opt" id="tr-frames"></span></label>
        <input id="tr-len" type="number" min="${(1 / fps()).toFixed(3)}" step="${(1 / fps()).toFixed(4)}" value="${transLength(t).toFixed(3)}"></div>
      <p class="hint">Longer pulls the next clip (and what follows it on the track) to the left; shorter pushes them right.
        The preview shows wipes, slides, circles and dips; other types preview as a dissolve and render exactly.</p>`;
    const frames = () => { const v = +form.querySelector("#tr-len").value || 0; form.querySelector("#tr-frames").textContent = `${Math.round(v * fps())} frames`; };
    form.querySelector("#tr-len").addEventListener("input", frames); frames();
    const foot = document.createElement("div");
    foot.innerHTML = `<button type="button" class="btn sm danger" data-a="del">Delete</button><span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="ok">Apply</button>`;
    const w = WM.open({ id: "transition", title: audio ? "Crossfade" : "Transition", content: form, footer: foot, width: 420, height: 330, minWidth: 320, minHeight: 260 });
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="del"]').onclick = () => { w.close(); removeTransition(t); };
    foot.querySelector('[data-a="ok"]').onclick = () => {
      const type = form.querySelector("#tr-type")?.value;
      if (type && type !== t.type) { t.type = type; lastType = type; }
      setTransitionLength(t, +form.querySelector("#tr-len").value || transLength(t));
      w.close();
    };
  }
  function trackMenu(x, y, id) {
    const t = track(id);
    menu(x, y, [
      ["Rename…", () => renameTrack(id)],
      ["Height: small", () => { t.height = t.kind === "video" ? 40 : 32; changed(); }],
      ["Height: medium", () => { t.height = t.kind === "video" ? 56 : 44; changed(); }],
      ["Height: large", () => { t.height = t.kind === "video" ? 96 : 72; changed(); }],
      ["🎚 Mixer… (volume, pan, solo)", mixer],
      ["＋ Video track", () => addTrack("video")],
      ["＋ Audio track", () => addTrack("audio")],
      ["Delete track", () => removeTrack(id)],
    ]);
  }
  /* ------------------------------------------------------------------ sound dialog and mixer */
  const toDb = v => (v <= 1e-4 ? -60 : clamp(20 * Math.log10(v), -60, 6));
  const fromDb = d => (d <= -59.9 ? 0 : clamp(10 ** (d / 20), 0, 2));
  const dbText = v => (v <= 1e-4 ? "−∞ dB" : `${v >= 1 ? "+" : "−"}${Math.abs(20 * Math.log10(v)).toFixed(1)} dB`);
  const panText = p => (Math.abs(p) < 0.005 ? "C" : `${p < 0 ? "L" : "R"}${Math.round(Math.abs(p) * 100)}`);
  // A silent video clip's sound lives on its linked audio clips: edit those.
  function soundTargets(c) {
    if (track(c.track)?.kind === "video" && c.audio_off && c.link) {
      const p = tl.clips.filter(x => x.link === c.link && x !== c && track(x.track)?.kind === "audio");
      if (p.length) return p;
    }
    return [c];
  }
  function soundDialog(c) {
    const targets = soundTargets(c), s = targets[0], L = dur(s);
    const form = document.createElement("div");
    form.className = "wm-form tl-sound";
    form.innerHTML = `
      ${targets[0] !== c ? `<p class="hint">This video's sound is on ${esc2(targets.map(x => track(x.track).name).join(", "))}, linked to it: changes go there.</p>` : ""}
      <div class="field"><label for="sd-vol">Volume <span class="opt" id="sd-vol-t"></span></label>
        <input id="sd-vol" type="range" min="-60" max="6" step="0.5" value="${toDb(s.volume ?? 1)}"></div>
      <div class="field"><label for="sd-pan">Pan <span class="opt" id="sd-pan-t"></span></label>
        <input id="sd-pan" type="range" min="-100" max="100" step="1" value="${Math.round((s.pan || 0) * 100)}"></div>
      <div class="row2">
        <div class="field"><label for="sd-fi">Fade in (s)</label><input id="sd-fi" type="number" min="0" max="${L.toFixed(2)}" step="0.05" value="${(s.fade_in || 0).toFixed(2)}"></div>
        <div class="field"><label for="sd-fo">Fade out (s)</label><input id="sd-fo" type="number" min="0" max="${L.toFixed(2)}" step="0.05" value="${(s.fade_out || 0).toFixed(2)}"></div></div>
      <label class="check"><input type="checkbox" id="sd-mute"${s.muted ? " checked" : ""}> Mute this clip's sound</label>
      ${s.vol_keys?.length ? `<p class="hint">Volume keyframes: ${s.vol_keys.length} (they set the volume over the clip, so the slider above is ignored).
        <button type="button" class="link" id="sd-clear-keys">Remove them</button></p>` : `<p class="hint">Tip: click the yellow volume line on the clip to add volume keyframes and drag them.</p>`}
      <p class="hint">Transitions add their own crossfade on top of these fades. Double-click a slider to reset it.</p>`;
    const vol = form.querySelector("#sd-vol"), pan = form.querySelector("#sd-pan");
    const show = () => { form.querySelector("#sd-vol-t").textContent = dbText(fromDb(+vol.value)); form.querySelector("#sd-pan-t").textContent = panText(+pan.value / 100); };
    vol.ondblclick = () => { vol.value = 0; show(); }; pan.ondblclick = () => { pan.value = 0; show(); };
    form.addEventListener("input", show); show();
    form.querySelector("#sd-clear-keys")?.addEventListener("click", () => { checkpoint(); for (const x of targets) x.vol_keys = []; w.close(); changed(); });
    const foot = document.createElement("div");
    foot.innerHTML = `<button type="button" class="btn sm" data-a="mixer">🎚 Mixer…</button><span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="ok">Apply</button>`;
    const w = WM.open({ id: "clip-sound", title: `Sound · ${c.name}`, content: form, footer: foot, width: 440, height: 430, minWidth: 320, minHeight: 300 });
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="mixer"]').onclick = () => { w.close(); mixer(); };
    foot.querySelector('[data-a="ok"]').onclick = () => {
      checkpoint();
      for (const x of targets) {
        const Lx = dur(x);
        x.volume = fromDb(+vol.value); x.pan = clamp(+pan.value / 100, -1, 1);
        x.fade_in = q(clamp(+form.querySelector("#sd-fi").value || 0, 0, Lx));
        x.fade_out = q(clamp(+form.querySelector("#sd-fo").value || 0, 0, Lx - x.fade_in));
        x.muted = form.querySelector("#sd-mute").checked;
      }
      w.close(); changed();
    };
  }

  // Mixer: a strip per track (mute, solo, pan, volume) and the master (volume, loudness, limiter, meter).
  let mixWin = null, mixRaf = 0;
  function mixer() {
    if (!tl) return;
    if (mixWin) { mixWin.focus?.(); return; }
    const box = document.createElement("div");
    box.className = "tl-mixer";
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="hint">Preview plays through this mix; loudness is applied when rendering.</span><span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="reset">Reset all</button>`;
    mixWin = WM.open({ id: "mixer", title: "Mixer", content: box, footer: foot, width: 620, height: 420, minWidth: 340, minHeight: 240, modal: false,
      onClose: () => { mixWin = null; cancelAnimationFrame(mixRaf); } });
    let before = null;
    box.addEventListener("pointerdown", () => { before = snapshot(); });
    box.addEventListener("keydown", () => { before = before || snapshot(); });
    const commit = () => { if (before) { undoStack.push(before); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = []; before = null; } save(); };
    box.addEventListener("input", e => {
      const f = e.target, id = f.closest("[data-strip]")?.dataset.strip;
      if (id === "master") {
        if (f.dataset.k === "vol") tl.master.volume = fromDb(+f.value);
        if (f.dataset.k === "loud") tl.master.loudness = f.value === "" ? null : +f.value;
        if (f.dataset.k === "lim") tl.master.limiter = f.checked;
        Mix.applyMaster();
      } else if (id) {
        const t = track(id);
        if (f.dataset.k === "vol") t.volume = fromDb(+f.value);
        if (f.dataset.k === "pan") t.pan = clamp(+f.value / 100, -1, 1);
      }
      updateReadouts();
      if (!playing) syncProgram(false);
    });
    box.addEventListener("change", () => { commit(); });
    box.addEventListener("dblclick", e => {
      const f = e.target.closest("input[type=range]"), id = f?.closest("[data-strip]")?.dataset.strip;
      if (!f) return;
      before = snapshot();
      if (id === "master") { tl.master.volume = 1; Mix.applyMaster(); }
      else { const t = track(id); if (f.dataset.k === "vol") t.volume = 1; else t.pan = 0; }
      commit(); refreshMixer(); render();
    });
    box.addEventListener("click", e => {
      const b = e.target.closest("[data-tog]"), id = b?.closest("[data-strip]")?.dataset.strip;
      if (!b || !id) return;
      checkpoint(); const t = track(id); t[b.dataset.tog] = !t[b.dataset.tog]; changed();
    });
    foot.querySelector('[data-a="reset"]').onclick = () => {
      checkpoint();
      for (const t of tl.tracks) Object.assign(t, { volume: 1, pan: 0, muted: false, solo: false });
      tl.master = { volume: 1, loudness: null, limiter: true };
      Mix.applyMaster(); changed();
    };
    refreshMixer();
    const meter = () => {
      const el = mixWin && $(".mx-meter i", box);
      if (!el) return;
      const p = Mix.peak(), pct = p === -Infinity ? 0 : clamp((p + 60) / 60, 0, 1) * 100;
      el.style.width = `${pct}%`;
      el.classList.toggle("hot", p > -1);
      $(".mx-peak", box).textContent = p === -Infinity ? (playing ? "—" : "Play to see the level") : `${p.toFixed(1)} dBFS`;
      mixRaf = requestAnimationFrame(meter);
    };
    meter();
  }
  function updateReadouts() {
    const box = mixWin && $(".tl-mixer");
    if (!box) return;
    for (const s of $$("[data-strip]", box)) {
      const id = s.dataset.strip, t = id === "master" ? tl.master : track(id);
      if (!t) continue;
      const v = $(".mx-db", s); if (v) v.textContent = dbText(t.volume ?? 1);
      const p = $(".mx-pan-t", s); if (p) p.textContent = panText(t.pan || 0);
    }
  }
  function refreshMixer() {
    const box = mixWin && $(".tl-mixer");
    if (!box || !tl) return;
    if (!tl.master) tl.master = { volume: 1, loudness: null, limiter: true };
    const soloing = tl.tracks.some(t => t.solo);
    const LOUD = [["", "Off"], ["-14", "−14 LUFS (YouTube, Spotify)"], ["-16", "−16 LUFS (podcasts, Apple)"], ["-23", "−23 LUFS (broadcast, EBU R128)"]];
    box.innerHTML = tl.tracks.filter(t => t.kind !== "camera").map(t => `
      <div class="mx-strip k-${t.kind}${t.muted || (soloing && !t.solo) ? " quiet" : ""}" data-strip="${t.id}">
        <span class="mx-name" title="${t.kind === "video" ? "Sound of the video clips on this track" : "Audio track"}">${esc2(t.name)}</span>
        <button type="button" data-tog="muted" class="mx-b${t.muted ? " on mute" : ""}" title="Mute">M</button>
        <button type="button" data-tog="solo" class="mx-b${t.solo ? " on solo" : ""}" title="Solo">S</button>
        <label class="mx-pan" title="Pan (double-click: centre)"><input type="range" data-k="pan" min="-100" max="100" step="1" value="${Math.round((t.pan || 0) * 100)}"><span class="mx-pan-t"></span></label>
        <label class="mx-vol" title="Volume (double-click: 0 dB)"><input type="range" data-k="vol" min="-60" max="6" step="0.5" value="${toDb(t.volume ?? 1)}"><span class="mx-db"></span></label>
      </div>`).join("") + `
      <div class="mx-strip mx-master" data-strip="master">
        <span class="mx-name">Master</span>
        <label class="mx-vol" title="Master volume (double-click: 0 dB)"><input type="range" data-k="vol" min="-60" max="6" step="0.5" value="${toDb(tl.master.volume ?? 1)}"><span class="mx-db"></span></label>
        <label class="mx-loud">Loudness <select data-k="loud">${LOUD.map(([v, l]) => `<option value="${v}"${String(tl.master.loudness ?? "") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="check mx-lim"><input type="checkbox" data-k="lim"${tl.master.limiter !== false ? " checked" : ""}> Limiter (peaks under −0.5 dB)</label>
        <div class="mx-meter" title="Peak level of the preview"><i></i></div><span class="mx-peak"></span>
      </div>`;
    updateReadouts();
  }
  function setLinkAudio(on, where) {
    tl.link_audio = !!on; tl.link_audio_track = where === "free" ? "free" : "new";
    save(); renderBar();
  }

  async function renameTrack(id) {
    const t = track(id);
    const n = await WM.ask({ title: "Rename track", message: "Track name", input: t.name, ok: "Rename" });
    if (n) { checkpoint(); t.name = n.slice(0, 24); changed(); }
  }
  function markerMenu(x, y, id) {
    const m = tl.markers.find(k => k.id === id);
    menu(x, y, [
      ["Go to marker", () => seek(m.t)],
      ["Rename…", async () => { const n = await WM.ask({ title: "Marker", message: tc(m.t), input: m.label, ok: "Save" }); if (n != null) { checkpoint(); m.label = n.slice(0, 60); changed(); } }],
      ["Delete marker", () => { checkpoint(); tl.markers = tl.markers.filter(k => k.id !== id); changed(); }],
    ]);
  }
  /* Render options: file name, where, format, size, frame rate, quality, sound. Remembered per project
     in timeline.render. */
  const SIZES = [["original", "Same as the first clip"], ["s2160", "2160p · 4K (short side)"], ["s1440", "1440p (short side)"],
    ["s1080", "1080p (short side)"], ["s720", "720p (short side)"], ["s480", "480p (short side)"],
    ["1920x1080", "1920 × 1080 · landscape"], ["1080x1920", "1080 × 1920 · vertical"], ["1080x1080", "1080 × 1080 · square"], ["custom", "Custom…"]];
  let renderInfo = null;
  async function renderDialog() {
    if (!tl.clips.length) return toast("The timeline is empty: drag results onto it first.");
    if (!renderInfo) { try { renderInfo = await (await fetch("/api/timeline/formats")).json(); } catch { renderInfo = { formats: [{ id: "mp4-h264", label: "MP4 · H.264", video: true }], places: [{ name: "Studio results (outputs)", path: "" }] }; } }
    const r = { format: "mp4-h264", size: "original", fps: "", quality: "high", speed: "balanced", audio: true, audio_bitrate: 192, sample_rate: 48000,
      channels: 2, loudness: "mixer", folder: "", filename: "", range: tl.range_in != null || tl.range_out != null ? "inout" : "all", ...(tl.render || {}) };
    if (r.size === "original" && renderSize !== "original" && !tl.render?.size) r.size = "s" + renderSize;  // the old menu's choice
    const first = await probe(tl.clips.find(c => c.kind !== "audio")?.ref || "");
    const projName = (typeof state !== "undefined" && state.project?.name) || "Experiment";
    const opt = (v, l, cur) => `<option value="${esc2(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc2(l)}</option>`;
    const hasRange = tl.range_in != null || tl.range_out != null;
    const masterLoud = tl.master?.loudness;
    const form = document.createElement("div");
    form.className = "wm-form rd";
    form.innerHTML = `
      <div class="row2">
        <div class="field"><label for="rd-name">File name</label><input id="rd-name" maxlength="120" placeholder="${esc2(projName)} cut" value="${esc2(r.filename || "")}"></div>
        <div class="field"><label for="rd-folder">Save to</label><select id="rd-folder">${renderInfo.places.map(p => opt(p.path, p.name + (p.path ? ` — ${p.path}` : ""), r.folder)).join("")}</select></div>
      </div>
      <div class="rd-checks">
        <label class="check"><input type="checkbox" id="rd-stamp"${r.timestamp ? " checked" : ""}> Add timestamp to the file name</label>
        <label class="check"><input type="checkbox" id="rd-burn"${r.burn_timecode ? " checked" : ""}> Burn the timecode into the picture</label>
      </div>
      <p class="hint" id="rd-where"></p>
      <div class="row2">
        <div class="field"><label for="rd-format">Format</label><select id="rd-format">${renderInfo.formats.map(f => opt(f.id, f.label, r.format)).join("")}</select></div>
        <div class="field"><label for="rd-range">Range</label><select id="rd-range">${opt("all", `Whole timeline · ${total().toFixed(2)} s`, r.range)}${hasRange ? opt("inout", `In–Out · ${((tl.range_out ?? total()) - (tl.range_in ?? 0)).toFixed(2)} s`, r.range) : ""}</select></div>
      </div>
      <fieldset class="rd-pic"><legend>Picture</legend>
        <div class="row2">
          <div class="field"><label for="rd-size">Resolution <span class="opt" id="rd-dims"></span></label><select id="rd-size">${SIZES.map(([v, l]) => opt(v, l, r.size)).join("")}</select></div>
          <div class="field"><label for="rd-fps">Frame rate</label><select id="rd-fps">${opt("", `Timeline (${fps()} fps)`, r.fps)}${[23.976, 24, 25, 29.97, 30, 50, 60].map(v => opt(v, `${v} fps`, r.fps)).join("")}</select></div>
        </div>
        <div class="row2" id="rd-custom" hidden>
          <div class="field"><label for="rd-w">Width</label><input id="rd-w" type="number" min="64" max="7680" step="2" value="${r.width || first?.width || 1920}"></div>
          <div class="field"><label for="rd-h">Height</label><input id="rd-h" type="number" min="64" max="4320" step="2" value="${r.height || first?.height || 1080}"></div>
        </div>
        <div class="row2">
          <div class="field"><label for="rd-quality">Quality</label><select id="rd-quality">${opt("high", "High (bigger file)", r.quality)}${opt("medium", "Medium", r.quality)}${opt("small", "Small file", r.quality)}</select></div>
          <div class="field"><label for="rd-speed">Encoding speed</label><select id="rd-speed">${opt("fast", "Fast", r.speed)}${opt("balanced", "Balanced", r.speed)}${opt("best", "Best compression (slow)", r.speed)}</select></div>
        </div>
      </fieldset>
      <fieldset class="rd-snd"><legend>Sound</legend>
        <label class="check" id="rd-audio-row"><input type="checkbox" id="rd-audio"${r.audio !== false ? " checked" : ""}> Include sound</label>
        <div class="row2">
          <div class="field"><label for="rd-loud">Loudness</label><select id="rd-loud">${opt("mixer", `As in the Mixer (${masterLoud == null ? "off" : masterLoud + " LUFS"})`, r.loudness)}${opt("off", "Off", r.loudness)}${opt("-14", "−14 LUFS (YouTube, Spotify)", r.loudness)}${opt("-16", "−16 LUFS (podcasts, Apple)", r.loudness)}${opt("-23", "−23 LUFS (broadcast)", r.loudness)}</select></div>
          <div class="field"><label for="rd-abr">Bitrate</label><select id="rd-abr">${[128, 192, 256, 320].map(v => opt(v, `${v} kbps`, r.audio_bitrate)).join("")}</select></div>
        </div>
        <div class="row2">
          <div class="field"><label for="rd-rate">Sample rate</label><select id="rd-rate">${opt(48000, "48 kHz (video)", r.sample_rate)}${opt(44100, "44.1 kHz (music)", r.sample_rate)}</select></div>
          <div class="field"><label for="rd-ch">Channels</label><select id="rd-ch">${opt(2, "Stereo", r.channels)}${opt(1, "Mono", r.channels)}</select></div>
        </div>
        <p class="hint">Volume, pan, fades, solo and the limiter come from the timeline and the 🎚 Mixer.</p>
      </fieldset>`;
    const $f = s => form.querySelector(s);
    const dims = () => {
      const s = $f("#rd-size").value;
      $f("#rd-custom").hidden = s !== "custom";
      let w = first?.width, h = first?.height;
      if (s === "custom") { w = +$f("#rd-w").value; h = +$f("#rd-h").value; }
      else if (/^\d+x\d+$/.test(s)) [w, h] = s.split("x").map(Number);
      else if (s.startsWith("s") && w && h) { const k = +s.slice(1) / Math.min(w, h); w = Math.round(w * k / 2) * 2; h = Math.round(h * k / 2) * 2; }
      return s === "original" ? [null, null, w, h] : [w, h, w, h];
    };
    const sync = () => {
      const f = renderInfo.formats.find(x => x.id === $f("#rd-format").value) || {};
      const [, , w, h] = dims();
      $f("#rd-dims").textContent = w && h ? `${w} × ${h}` : "";
      $f(".rd-pic").disabled = f.video === false;
      $f("#rd-audio").disabled = f.video === false;
      if (f.video === false) $f("#rd-audio").checked = true;
      const noSnd = !$f("#rd-audio").checked;
      for (const id of ["#rd-loud", "#rd-abr", "#rd-rate", "#rd-ch"]) $f(id).disabled = noSnd;
      $f("#rd-abr").disabled = noSnd || /wav|prores/.test(f.id || "");
      const place = renderInfo.places.find(p => p.path === $f("#rd-folder").value);
      const d = new Date(), p2 = n => String(n).padStart(2, "0");
      const stamp = $f("#rd-stamp").checked ? ` ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}` : "";
      $f("#rd-burn").disabled = f.video === false;
      const name = ($f("#rd-name").value.trim() || `${projName} cut`).replace(/[<>:"/\\|?*]+/g, "_") + stamp;
      $f("#rd-where").textContent = `→ ${place?.path ? place.path : "outputs/<today>"}/${name}${f.ext || ".mp4"} · shows up in the results gallery. A file that exists isn't overwritten: a number is added.`;
    };
    form.addEventListener("input", sync); form.addEventListener("change", sync); sync();
    const foot = document.createElement("div");
    foot.innerHTML = `<button type="button" class="btn sm" data-a="fcpxml" title="Export the timeline for DaVinci Resolve or Final Cut Pro">⇪ FCPXML…</button><span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="ok">⬇ Render</button>`;
    const w = WM.open({ id: "render", title: "Render options", content: form, footer: foot, width: 640, height: 700, minWidth: 340, minHeight: 360 });
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="fcpxml"]').onclick = () => { w.close(); exportFcpxml(); };
    foot.querySelector('[data-a="ok"]').onclick = async () => {
      const [W, H] = dims();
      const o = {
        filename: $f("#rd-name").value.trim() || `${projName} cut`, folder: $f("#rd-folder").value, format: $f("#rd-format").value,
        size: $f("#rd-size").value, width: $f("#rd-size").value === "custom" ? W : undefined, height: $f("#rd-size").value === "custom" ? H : undefined,
        fps: $f("#rd-fps").value, quality: $f("#rd-quality").value, speed: $f("#rd-speed").value, audio: $f("#rd-audio").checked,
        audio_bitrate: +$f("#rd-abr").value, sample_rate: +$f("#rd-rate").value, channels: +$f("#rd-ch").value, loudness: $f("#rd-loud").value,
        range: $f("#rd-range").value, timestamp: $f("#rd-stamp").checked, burn_timecode: $f("#rd-burn").checked,
      };
      tl.render = { ...o, filename: $f("#rd-name").value.trim() };  // remembered (the default name stays a default)
      w.close();
      await renderTimeline(o, W, H);
    };
  }
  function renderMenu() { return renderDialog(); }
  function menu(x, y, items) {
    document.querySelector(".ex-menu")?.remove();
    const m = document.createElement("div");
    m.className = "ex-menu"; m.setAttribute("role", "menu");
    m.innerHTML = items.map(([l], i) => `<button type="button" role="menuitem" data-i="${i}">${esc2(l)}</button>`).join("");
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    Object.assign(m.style, { left: Math.min(x, innerWidth - r.width - 8) + "px", top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px", zIndex: 100000 });
    const close = () => { m.remove(); document.removeEventListener("pointerdown", out, true); };
    const out = ev => { if (!m.contains(ev.target)) close(); };
    m.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) { close(); items[+b.dataset.i][1](); } });
    m.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } });
    setTimeout(() => document.addEventListener("pointerdown", out, true));
    m.querySelector("button")?.focus();
  }

  /* ------------------------------------------------------------------ frames, render */
  async function grabFrame(c, srcT) {
    try {
      const r = await fetch("/api/media/frame", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: c.ref, t: Math.max(0, srcT) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      state.kind = "video"; state.engine.video = "h3"; renderForm();
      setFrame("first_frame", j.ref, j.url);
      showStep("inputs");
      toast("Frame set as the first frame: write what happens next and generate to continue the shot.");
    } catch (e) { toast(e.message); }
  }
  function grabAtPlayhead() {
    const c = topClipAt(tl.playhead);
    if (!c) return toast("No picture at the playhead");
    grabFrame(c, c.kind === "image" ? 0 : c.trim_in + (tl.playhead - c.start));
  }
  /* Download the timeline as FCPXML 1.9. Media is referenced in place, so the file must be
     imported on this PC (or wherever the same paths exist). */
  async function exportFcpxml() {
    if (!tl.clips.length) return toast("The timeline is empty.");
    const job = Activity.task("Export FCPXML");
    job.log("Saving the timeline"); job.progress(0.2);
    await saveNow(true);
    job.log(`Building FCPXML 1.9: ${tl.clips.length} clips, ${tl.tracks.length} tracks, ${tl.transitions.length} transitions`); job.progress(0.5);
    const r = await fetch(`/api/timeline/fcpxml?project=${encodeURIComponent(project)}`);
    if (!r.ok) { const j = await r.json().catch(() => ({})); job.fail(j.detail || r.statusText); return toast(`Export failed: ${j.detail || r.statusText}`); }
    job.done(`Downloaded ${/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "")?.[1] || "timeline.fcpxml"}`);
    const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "")?.[1] || "timeline.fcpxml";
    const url = URL.createObjectURL(await r.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Saved ${name}. In DaVinci Resolve: File › Import › Timeline…, then pick the file (media is linked from where it is now).`);
  }

  async function renderTimeline(o, width = null, height = null) {
    if (!tl.clips.length) return toast("The timeline is empty.");
    await saveNow(true);
    const range = o.range === "inout";
    const body = { project, range_in: range ? tl.range_in : null, range_out: range ? tl.range_out : null, width, height,
      filename: o.filename, folder: o.folder, format: o.format, fps: o.fps ? +o.fps : null, quality: o.quality, speed: o.speed,
      audio: o.audio, audio_bitrate: o.audio_bitrate, sample_rate: o.sample_rate, channels: o.channels, loudness: o.loudness,
      timestamp: !!o.timestamp, burn_timecode: !!o.burn_timecode };
    try {
      const r = await fetch("/api/timeline/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : (j.detail?.[0]?.msg || r.statusText));
      state.items.set(j.id, j); Activity.onEvent({ type: "item", item: j }); renderGallery(); renderQueue(); select(j.id); Monitor.show("result");
      Activity.show(j.id);
      toast("Rendering… progress and the log are in the Activity console; the file appears in the results gallery.");
    } catch (e) { toast(`Render failed: ${e.message}`); }
  }

  /* ------------------------------------------------------------------ shortcuts */
  const SHORTCUTS = [
    ["Playback", [["Space", "Play / pause"], ["K", "Pause"], ["L", "Play"], ["J", "Back 1 second"], ["Home / End", "Start / end"],
      ["← / →", "1 frame"], ["Shift+← / →", "1 second"], ["↑ / ↓", "Previous / next edit point or marker"], ["Ctrl+L", "Loop the In–Out range"]]],
    ["Editing", [["S or Ctrl+B", "Split at the playhead"], ["Ctrl+T", "Add a transition at the nearest cut"],
      ["Double-click a transition", "Change its type or length"], ["Shift (dropping a clip)", "Overlap the clip before as a transition"],
      ["Alt+click", "Select one clip of a linked video/sound pair"], ["Drag the dot at a clip's top corner", "Fade the sound in / out"],
      ["Right-click a clip › Sound…", "Volume, pan, fades, mute"], ["Shift+E", "Video Fx for the selected clip"],
      ["◆ in the Video Fx window", "Keyframes: settings change over the clip"],
      ["Click the yellow line on an audio clip", "Add a volume keyframe (drag it; double-click to delete)"],
      ["Shift+C", "Camera move (adds a Camera track if needed)"], ["Double-click the Camera track", "Add a camera move there"], ["Del / Backspace", "Delete"], ["Shift+Del", "Ripple delete (close the gap)"],
      ["Ctrl+C / Ctrl+V", "Copy / paste at the playhead"], ["Ctrl+D", "Duplicate after the selection"], [", / .", "Nudge selection 1 frame"],
      ["Ctrl+A", "Select all"], ["Esc", "Clear the selection"], ["Ctrl+Z", "Undo"], ["Ctrl+Shift+Z / Ctrl+Y", "Redo"], ["Alt (while dragging)", "Don't snap"]]],
    ["Timeline", [["I / O", "Set In / Out"], ["Alt+X", "Clear In and Out"], ["M", "Add a marker"], ["N", "Snapping on / off"],
      ["+ / −", "Zoom in / out"], ["Ctrl+wheel", "Zoom at the pointer"], ["Shift+wheel", "Scroll sideways"], ["F", "Fit the timeline"], ["Shift+F", "Zoom to the selection"],
      ["Shift+M", "Mixer"], ["S (track header button)", "Solo the track"], ["Ctrl+S", "Save the project (when auto-save is off)"],
      ["G", "Use the frame at the playhead as a first frame"], ["Ctrl+E", "Render options…"], ["Ctrl+Shift+A", "Activity console (logs, time left)"], ["T (on the clock)", "Frames / seconds"]]],
    ["Results bin", [["1 – 5", "Rate the selected result"], ["0", "Clear the rating"], ["Shift+T", "Tags…"], ["Enter", "Add to the timeline"], ["← / →", "Previous / next result"]]],
    ["Layout", [["Alt+G", "Show / hide the results gallery"], ["Alt+I", "Show / hide the result's details and controls over the viewer"], ["Alt+W", "Prompt tab: switch between the prompt and the Shot writer"], ["Alt+1 … Alt+4", "Default, Edit, Review, Bin layouts"], ["Alt+5 … Alt+9", "Your saved layouts"], ["?", "This list"]]],
  ];
  function showShortcuts() {
    const box = document.createElement("div");
    box.className = "tl-keys";
    box.innerHTML = SHORTCUTS.map(([g, list]) => `<section><h4>${g}</h4><dl>${list.map(([k, v]) => `<dt>${k.split(" / ").map(x => `<kbd>${esc2(x)}</kbd>`).join(" / ")}</dt><dd>${esc2(v)}</dd>`).join("")}</dl></section>`).join("");
    WM.open({ id: "shortcuts", title: "Keyboard shortcuts", content: box, width: 760, height: 560, minWidth: 340, minHeight: 260 });
  }

  function onKey(e) {
    if (!tl || !root) return;
    if (typeof Editor !== "undefined" && Editor.isOpen()) return;  // the image editor covers the timeline
    const tgt = e.target;
    if (tgt.closest?.("input, textarea, select, [contenteditable], .wm-win") || document.querySelector(".wm-backdrop")) return;
    if (tgt.closest?.(".side") && !tgt.closest?.(".steps")) return;  // the side panel keeps its keys
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const inBin = tgt.closest?.("#bin");
    if (inBin && Bin.onKey(e)) return;
    const f = 1 / fps();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === " ") { handled(); return toggle(); }
    if (ctrl && k.toLowerCase() === "z" && !e.shiftKey) { handled(); return undo(); }
    if (ctrl && (k.toLowerCase() === "y" || (k.toLowerCase() === "z" && e.shiftKey))) { handled(); return redo(); }
    if (ctrl && k.toLowerCase() === "b") { handled(); return splitSelection(); }
    if (ctrl && k.toLowerCase() === "t") { handled(); return addTransition(); }
    if (ctrl && k.toLowerCase() === "c") { handled(); return copySel(); }
    if (ctrl && k.toLowerCase() === "v") { handled(); return paste(); }
    if (ctrl && k.toLowerCase() === "d") { handled(); return duplicate(); }
    if (ctrl && k.toLowerCase() === "a") { handled(); tl.clips.forEach(c => sel.add(c.id)); return render(); }
    if (ctrl && k.toLowerCase() === "l") { handled(); loop = !loop; toast(loop ? "Loop In–Out on" : "Loop off"); return renderBar(); }
    if (ctrl && k.toLowerCase() === "e") { handled(); return renderDialog(); }
    if (e.altKey && /^[1-9]$/.test(k)) { handled(); return Layout.applyIndex(+k - 1); }
    if (e.altKey && k.toLowerCase() === "x") { handled(); return setRange("clear"); }
    if (ctrl || e.altKey) return;
    switch (k) {
      case "k": case "K": handled(); return pause();
      case "l": case "L": handled(); return play();
      case "j": case "J": handled(); return seek(tl.playhead - 1);
      case "s": case "S": handled(); return splitSelection();
      case "Delete": case "Backspace": {
        handled();
        const t = selTrans && tl.transitions.find(x => x.id === selTrans);
        return t ? removeTransition(t) : deleteSelection(e.shiftKey);
      }
      case "ArrowLeft": handled(); return seek(tl.playhead - (e.shiftKey ? 1 : f));
      case "ArrowRight": handled(); return seek(tl.playhead + (e.shiftKey ? 1 : f));
      case "ArrowUp": handled(); return jumpEdit(-1);
      case "ArrowDown": handled(); return jumpEdit(1);
      case "Home": handled(); return seek(0);
      case "End": handled(); return seek(total());
      case "i": case "I": handled(); return setRange("in");
      case "o": case "O": handled(); return setRange("out");
      case "C": if (e.shiftKey) { handled(); const c = [...sel].map(clip).find(x => x?.kind === "camera"); return c ? cameraDialog(c) : addCameraMove(); } return;
      case "E": if (e.shiftKey) { handled(); const c = [...sel].map(clip).find(fxTargets) || topClipAt(tl.playhead); return c ? fxDialog(c) : toast("Select a picture clip first."); } return;
      case "M": if (e.shiftKey) { handled(); return mixer(); } // fall through
      case "m": handled(); return addMarker();
      case "n": case "N": handled(); tl.snap = !tl.snap; toast(tl.snap ? "Snapping on" : "Snapping off"); save(); return renderBar();
      case "+": case "=": handled(); return zoomStep(1);
      case "-": case "_": handled(); return zoomStep(-1);
      case "f": handled(); return fit();
      case "F": handled(); { const s = [...sel].map(clip).filter(Boolean); return s.length ? fit(Math.min(...s.map(c => c.start)), Math.max(...s.map(end))) : fit(); }
      case "g": case "G": handled(); return grabAtPlayhead();
      case ",": handled(); return nudge(-1);
      case ".": handled(); return nudge(1);
      case "Escape": if (sel.size) { handled(); sel.clear(); render(); } return;
      case "?": handled(); return showShortcuts();
    }
  }

  /* ------------------------------------------------------------------ mount */
  const toast = m => Media.toast(m);
  function writeUI(patch) { try { localStorage.setItem("bob.ui", JSON.stringify({ ...JSON.parse(localStorage.getItem("bob.ui") || "{}"), ...patch })); } catch {} }
  function readUI() { try { return JSON.parse(localStorage.getItem("bob.ui") || "{}") || {}; } catch { return {}; } }

  function mount(el) {
    root = el;
    renderSize = readUI().renderSize || "original";
    root.innerHTML = `
      <div class="tl-bar" role="toolbar" aria-label="Timeline">
        <span class="tl-grp">
          <button type="button" class="tl-b" data-act="start" title="Start (Home)">⏮</button>
          <button type="button" class="tl-b" data-act="prev" title="Previous edit (↑)">⇤</button>
          <button type="button" class="tl-b" data-act="frame-back" title="Back 1 frame (←); hold to repeat, Shift = 1 second">◀︎|</button>
          <button type="button" class="tl-b tl-play" data-act="play">▶</button>
          <button type="button" class="tl-b" data-act="frame-fwd" title="Forward 1 frame (→); hold to repeat, Shift = 1 second">|▶︎</button>
          <button type="button" class="tl-b" data-act="next" title="Next edit (↓)">⇥</button>
          <button type="button" class="tl-b" data-act="end" title="End (End)">⏭</button>
          <button type="button" class="tl-b" data-act="loop" title="Loop the In–Out range (Ctrl+L)">🔁</button>
        </span>
        <span class="tl-time" title="Click: frames or seconds">00:00:00 / 00:00:00</span>
        <span class="tl-grp">
          <button type="button" class="tl-b" data-act="split" title="Split at the playhead (S, Ctrl+B)">✂</button>
          <button type="button" class="tl-b" data-act="trans" title="Add a transition at the nearest cut (Ctrl+T); right-click a transition to change it">⧓</button>
          <button type="button" class="tl-b" data-act="linkaudio" title="Linked audio: a video with sound also puts its sound on an audio track">🔗</button>
          <button type="button" class="tl-b" data-act="fx" title="Video Fx for the selected clip: lights, grade, vignette (Shift+E)">✨</button>
          <button type="button" class="tl-b" data-act="camera" title="Camera move: pan, tilt, roll, dolly, orbit, zoom; AI reshoot (Shift+C)">🎥</button>
          <button type="button" class="tl-b" data-act="mixer" title="Mixer: volume, pan, solo, master loudness (Shift+M)">🎚</button>
          <button type="button" class="tl-b" data-act="snap" title="Snapping (N); hold Alt while dragging to skip">🧲</button>
          <button type="button" class="tl-b" data-act="marker" title="Add a marker (M)">⚑</button>
          <button type="button" class="tl-b" data-act="in" title="Set In (I)">[</button>
          <button type="button" class="tl-b" data-act="out" title="Set Out (O)">]</button>
          <button type="button" class="tl-b" data-act="grab" title="Use the frame at the playhead as the next shot's first frame (G)">🎞</button>
        </span>
        <span class="tl-grp">
          <button type="button" class="tl-b" data-act="undo" title="Undo (Ctrl+Z)">↶</button>
          <button type="button" class="tl-b" data-act="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        </span>
        <span class="tl-grp tl-zoomgrp">
          <button type="button" class="tl-b" data-act="zoomout" title="Zoom out (−)">−</button>
          <input type="range" class="tl-zoom" min="${Math.log(ZOOMS[0])}" max="${Math.log(ZOOMS[ZOOMS.length - 1])}" step="0.01" aria-label="Zoom">
          <button type="button" class="tl-b" data-act="zoomin" title="Zoom in (+)">+</button>
          <button type="button" class="tl-b" data-act="fit" title="Fit (F)">⤢</button>
        </span>
        <span class="tl-gap"></span>
        <button type="button" class="tl-b wide" data-act="layout" title="Layouts (Alt+1…9)">▦ Layout</button>
        <button type="button" class="tl-b wide" data-act="keys" title="Keyboard shortcuts (?)">⌨</button>
        <button type="button" class="tl-b wide primary" data-act="render" title="Render options: file, format, size, sound (Ctrl+E)">⬇ Render…</button>
      </div>
      <div class="tl-scroll" tabindex="0" aria-label="Tracks"><div class="tl-canvas"></div></div>`;
    scroller = $(".tl-scroll", root);

    root.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (e.target.closest("[data-cam-add]")) return addCameraMove();
      const tact = e.target.closest("[data-tact]");
      if (tact) {
        const t = track(tact.closest("[data-track]").dataset.track), key = tact.dataset.tact;
        checkpoint(); t[key] = !t[key]; changed(); return;
      }
      if (e.target.closest(".tl-tc, .tl-time")) { showSeconds = !showSeconds; return render(); }
      if (!act) return;
      if (act === "frame-back" || act === "frame-fwd") {
        // Mouse presses are handled on pointerdown (with hold-to-repeat); this is for Enter/Space.
        if (e.detail === 0) frameStep(act === "frame-fwd" ? 1 : -1, e.shiftKey);
        return;
      }
      const r = e.target.closest("[data-act]").getBoundingClientRect();
      ({
        start: () => seek(0), end: () => seek(total()), prev: () => jumpEdit(-1), next: () => jumpEdit(1), play: toggle,
        loop: () => { loop = !loop; renderBar(); }, split: splitSelection, trans: () => addTransition(),
        linkaudio: () => { tl.link_audio = !tl.link_audio; save(); renderBar(); toast(tl.link_audio ? "Linked audio on: new videos bring their sound onto an audio track." : "Linked audio off: new videos keep their sound inside the clip."); }, marker: addMarker, in: () => setRange("in"), out: () => setRange("out"),
        snap: () => { tl.snap = !tl.snap; save(); renderBar(); }, grab: grabAtPlayhead, undo, redo, mixer,
        fx: () => { const c = [...sel].map(clip).find(fxTargets) || topClipAt(tl.playhead); return c ? fxDialog(c) : toast("Select a picture clip first."); },
        zoomin: () => zoomStep(1), zoomout: () => zoomStep(-1), fit: () => fit(),
        "add-video": () => addTrack("video"), "add-audio": () => addTrack("audio"), "add-camera": () => addCameraMove(),
        camera: () => { const c = [...sel].map(clip).find(x => x?.kind === "camera"); return c ? cameraDialog(c) : addCameraMove(); },
        keys: showShortcuts, layout: () => Layout.menu(r.left, r.bottom + 4), render: () => renderDialog(),
      })[act]?.();
    });
    $(".tl-zoom", root).addEventListener("input", e => setZoom(Math.exp(+e.target.value)));
    // Frame-step buttons: one step on press, then repeat while held (like a jog button).
    $$(".tl-bar [data-act='frame-back'], .tl-bar [data-act='frame-fwd']", root).forEach(btn => {
      let delay = 0, rep = 0;
      const stop = () => { clearTimeout(delay); clearInterval(rep); };
      btn.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const dir = btn.dataset.act === "frame-fwd" ? 1 : -1, big = e.shiftKey;
        frameStep(dir, big);
        delay = setTimeout(() => { rep = setInterval(() => frameStep(dir, big), big ? 250 : 70); }, 380);
      });
      ["pointerup", "pointerleave", "pointercancel", "blur"].forEach(ev => btn.addEventListener(ev, stop));
    });
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("dblclick", e => {
      const head = e.target.closest(".tl-head[data-track] .tl-tname");
      if (head) return renameTrack(head.closest("[data-track]").dataset.track);
      const mk = e.target.closest(".tl-marker"); if (mk) return markerMenu(e.clientX, e.clientY, mk.dataset.marker);
      const tr = e.target.closest(".tl-trans"); if (tr) { const t = tl.transitions.find(x => x.id === tr.dataset.trans); if (t) return transitionDialog(t); }
      const c = e.target.closest(".tl-clip");
      const wv = e.target.closest(".tl-wave");
      if (c && wv) {
        const cl = clip(c.dataset.clip), hit = volHit(cl, wv, e.clientX, e.clientY);
        if (hit?.key != null) { checkpoint(); cl.vol_keys.splice(hit.key, 1); changed(); return; }
      }
      if (c && clip(c.dataset.clip)?.kind === "camera") return cameraDialog(clip(c.dataset.clip));
      const lane = e.target.closest(".tl-lane[data-track]");
      if (!c && lane && track(lane.dataset.track)?.kind === "camera") return addCameraMove(q(timeAt(e.clientX)));
      if (c) { const cl = clip(c.dataset.clip); seek(cl.start); Monitor.show("timeline"); }
    });
    root.addEventListener("contextmenu", e => {
      const trn = e.target.closest(".tl-trans");
      if (trn) { e.preventDefault(); return transMenu(e.clientX, e.clientY, trn.dataset.trans); }
      const c = e.target.closest(".tl-clip"), h = e.target.closest(".tl-head[data-track]"), mk = e.target.closest(".tl-marker");
      if (c) { e.preventDefault(); return clipMenu(e.clientX, e.clientY, c.dataset.clip); }
      if (h) { e.preventDefault(); return trackMenu(e.clientX, e.clientY, h.dataset.track); }
      if (mk) { e.preventDefault(); return markerMenu(e.clientX, e.clientY, mk.dataset.marker); }
    });
    scroller.addEventListener("wheel", e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(tl.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeAt(e.clientX)); }
      else if (e.shiftKey) { e.preventDefault(); scroller.scrollLeft += e.deltaY; }
    }, { passive: false });

    // Drops from the results bin, the media gallery, or the desktop.
    scroller.addEventListener("dragover", e => {
      if (!e.dataTransfer.types.includes("text/x-bob-ref")) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "copy";
      const lane = e.target.closest(".tl-lane[data-track]");
      $$(".tl-lane.drop", root).forEach(l => l !== lane && l.classList.remove("drop"));
      lane?.classList.add("drop");
      showSnap(q(timeAt(e.clientX)));
    });
    scroller.addEventListener("dragleave", e => { if (!scroller.contains(e.relatedTarget)) { $$(".tl-lane.drop", root).forEach(l => l.classList.remove("drop")); showSnap(null); } });
    scroller.addEventListener("drop", e => {
      const ref = e.dataTransfer.getData("text/x-bob-ref");
      if (!ref) return;
      e.preventDefault(); showSnap(null);
      $$(".tl-lane.drop", root).forEach(l => l.classList.remove("drop"));
      const lane = e.target.closest(".tl-lane[data-track]");
      const kind = e.dataTransfer.getData("text/x-bob-kind") || (/\.(mp4|webm|mov|mkv)$/i.test(ref) ? "video" : /\.(mp3|wav|flac|ogg|m4a)$/i.test(ref) ? "audio" : "image");
      let at = timeAt(e.clientX);
      const s = snapTo([at], snapTargets(new Set()), e.altKey); at += s.d;
      add({ ref, kind, name: e.dataTransfer.getData("text/x-bob-name") || ref.split("/").pop(), job: e.dataTransfer.getData("text/x-bob-job") || null },
        { track: lane?.dataset.track, at: lane ? at : undefined });
    });
    addEventListener("keydown", onKey, true);
    new ResizeObserver(() => render()).observe(scroller);
  }

  async function setProject(id, timeline) {
    if (saveTimer) await saveNow();
    pause();
    clearTimeout(saveTimer); saveTimer = null;  // pause() queued a playhead save of the old timeline: never let it hit the new one
    project = id || "experiment";
    tl = timeline && timeline.tracks?.length ? structuredClone(timeline) : blank();
    tl.transitions = tl.transitions || [];
    if (tl.link_audio == null) tl.link_audio = true;
    if (!tl.link_audio_track) tl.link_audio_track = "new";
    if (!tl.master) tl.master = { volume: 1, loudness: null, limiter: true };
    Mix.applyMaster();
    selTrans = null;
    sel.clear(); undoStack = []; redoStack = [];
    for (const el of audioEls.values()) el.pause();
    audioEls.clear();
    render(); refreshMixer();
    if (scroller) scroller.scrollLeft = Math.max(0, tl.playhead * tl.zoom - 100);
  }

  return {
    mount, setProject, add, play, pause, toggle, seek, render, saveNow, showShortcuts,
    // The project was deleted: forget it without saving (setProject would flush a pending save into the trash).
    detach: () => { clearTimeout(saveTimer); saveTimer = null; pause(); clearTimeout(saveTimer); saveTimer = null; tl = null; }, onKey, mixer, setLinkAudio, soundDialog: id => soundDialog(clip(id)),
    cameraDialog: id => cameraDialog(clip(id)), addCameraMove, onItem,
    fxDialog: id => fxDialog(clip(id)),
    get playing() { return playing; }, get model() { return tl; }, setZoom, fit,
    syncProgram: () => syncProgram(false), clipsForJob: job => tl ? tl.clips.filter(c => c.job === job && !(c.link && track(c.track)?.kind === "audio")).length : 0,
  };
})();

/* ------------------------------------------------------------------ monitor: result or timeline */
const Monitor = {
  mode: "result",
  show(mode) {
    this.mode = mode;
    $("#program").hidden = mode !== "timeline";
    $("#viewer").hidden = mode === "timeline";
    if (typeof Info !== "undefined") Info.sync();
    $$("#mon-seg button").forEach(b => b.classList.toggle("active", b.dataset.m === mode));
    if (mode === "result") { TL.pause(); $("#prog-video")?.pause(); }
    else { $$("#viewer video, #viewer audio").forEach(m => m.pause()); TL.syncProgram(); }
  },
};

/* ------------------------------------------------------------------ layouts */
const Layout = (() => {
  const PRESETS = [
    { name: "Default", monitor: 0.55, bin: 340, gallery: true },
    { name: "Edit", monitor: 0.42, bin: 280, gallery: true },
    { name: "Review", monitor: 0.74, bin: 360, gallery: false },
    { name: "Bin", monitor: 0.62, bin: 640, gallery: true },
  ];
  const read = () => { try { return JSON.parse(localStorage.getItem("bob.ui") || "{}") || {}; } catch { return {}; } };
  const write = p => { try { localStorage.setItem("bob.ui", JSON.stringify({ ...read(), ...p })); } catch {} };
  const saved = () => read().layouts || [];

  function current() {
    const css = getComputedStyle(document.documentElement);
    return { monitor: parseFloat(css.getPropertyValue("--mon-frac")) || 0.55, bin: parseFloat(css.getPropertyValue("--bin-w")) || 340,
      side: parseFloat(css.getPropertyValue("--side-w")) || 460, zoom: TL.model?.zoom, gallery: !$("#top").classList.contains("no-gallery") };
  }
  function setMonitor(f, persist = true) {
    f = Math.max(0.18, Math.min(0.86, f));
    document.documentElement.style.setProperty("--mon-frac", f);
    if (persist) write({ monitor: f });
  }
  // The results gallery sits left of the viewer in the top section; the button left of "Result" shows or hides it.
  function setGallery(on, persist = true) {
    $("#top").classList.toggle("no-gallery", !on);
    $("#btn-gallery").setAttribute("aria-pressed", String(!!on));
    if (persist) write({ gallery: !!on });
    layoutTop();
  }
  function layoutTop() {
    const top = $("#top"); if (!top) return;
    const g = !top.classList.contains("no-gallery");
    top.style.gridTemplateColumns = [g && "var(--bin-w, 340px)", g && "10px", "minmax(0, 1fr)"].filter(Boolean).join(" ");
  }
  function setBin(w, persist = true) {
    const stage = $(".top")?.clientWidth || 1000;
    w = Math.round(Math.max(200, Math.min(stage - 320, w)));
    document.documentElement.style.setProperty("--bin-w", w + "px");
    if (persist) write({ binWidth: w });
  }
  function apply(l) {
    if (!l) return;
    setMonitor(l.monitor); setBin(l.bin);
    if (l.gallery != null) setGallery(l.gallery);
    if (l.side) setSideWidth(l.side);
    if (l.zoom) TL.setZoom(l.zoom);
    write({ layout: l.name });
    Media.toast(`Layout: ${l.name}`);
  }
  const all = () => [...PRESETS, ...saved()];
  function applyIndex(i) { apply(all()[i]); }
  async function saveCurrent() {
    const name = await WM.ask({ title: "Save layout", message: "Name this layout (panel sizes, side width, zoom)", input: `Layout ${saved().length + 1}`, ok: "Save" });
    if (!name) return;
    const list = saved().filter(l => l.name !== name);
    list.push({ name: name.slice(0, 40), ...current() });
    write({ layouts: list.slice(-5), layout: name });
    Media.toast(`Saved layout “${name}”`);
  }
  async function remove(name) { write({ layouts: saved().filter(l => l.name !== name) }); }
  function menu(x, y) {
    const cur = read().layout;
    const items = [
      ...all().map((l, i) => [`${cur === l.name ? "● " : "○ "}${l.name}${i < 9 ? `  (Alt+${i + 1})` : ""}`, () => apply(l)]),
      ["Save current layout…", saveCurrent],
      ...saved().map(l => [`Delete “${l.name}”`, () => remove(l.name)]),
    ];
    document.querySelector(".ex-menu")?.remove();
    const m = document.createElement("div");
    m.className = "ex-menu"; m.setAttribute("role", "menu");
    m.innerHTML = items.map(([l], i) => `<button type="button" role="menuitem" data-i="${i}">${esc(l)}</button>`).join("");
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    Object.assign(m.style, { left: Math.min(x, innerWidth - r.width - 8) + "px", top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px", zIndex: 100000 });
    const close = () => { m.remove(); document.removeEventListener("pointerdown", out, true); };
    const out = ev => { if (!m.contains(ev.target)) close(); };
    m.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) { close(); items[+b.dataset.i][1](); } });
    setTimeout(() => document.addEventListener("pointerdown", out, true));
  }

  function splitter(el, axis, onMove, onReset) {
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add("drag");
      document.body.classList.add(axis === "y" ? "resizing-y" : "resizing");
      const mv = ev => onMove(ev, false);
      const up = ev => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); el.classList.remove("drag");
        document.body.classList.remove("resizing", "resizing-y"); onMove(ev, true); };
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
    });
    el.addEventListener("dblclick", onReset);
  }

  function init() {
    const ui = read();
    setMonitor(ui.monitor ?? 0.55, false);
    setBin(ui.binWidth ?? 340, false);
    setGallery(ui.gallery ?? true, false);
    // Alt+W: the Prompt tab's Prompt / Shot writer switch (the writer lives in the Prompt tab now).
    addEventListener("keydown", e => {
      if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "w") { e.preventDefault(); Prompts.toggleWriter(); }
    });
    $("#btn-gallery").addEventListener("click", () => setGallery($("#top").classList.contains("no-gallery")));
    addEventListener("keydown", e => {
      if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "g" && !e.target.closest?.("input, textarea, select")) { e.preventDefault(); setGallery($("#top").classList.contains("no-gallery")); }
    });
    const stage = $(".stage");
    splitter($("#stage-split"), "y", (e, done) => {
      const r = stage.getBoundingClientRect();
      setMonitor((e.clientY - r.top) / r.height, done);
    }, () => setMonitor(0.55));
    $("#stage-split").addEventListener("keydown", e => {
      const f = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mon-frac")) || 0.55;
      if (e.key === "ArrowUp") { e.preventDefault(); setMonitor(f - 0.04); }
      if (e.key === "ArrowDown") { e.preventDefault(); setMonitor(f + 0.04); }
    });
    splitter($("#bin-split"), "x", (e, done) => {
      const r = $(".top").getBoundingClientRect();
      setBin(e.clientX - r.left, done);
    }, () => setBin(340));
    $("#bin-split").addEventListener("keydown", e => {
      const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bin-w")) || 340;
      if (e.key === "ArrowLeft") { e.preventDefault(); setBin(w - 24); }
      if (e.key === "ArrowRight") { e.preventDefault(); setBin(w + 24); }
    });
  }
  return { init, menu, applyIndex, apply, saveCurrent, setGallery };
})();
