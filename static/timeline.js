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
      transitions: [], link_audio: true };
  }

  /* ------------------------------------------------------------------ history and saving */
  const snapshot = () => JSON.stringify({ tracks: tl.tracks, clips: tl.clips, markers: tl.markers, range_in: tl.range_in, range_out: tl.range_out,
    transitions: tl.transitions });
  function checkpoint() { undoStack.push(snapshot()); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack = []; }
  function restore(s) { Object.assign(tl, JSON.parse(s)); for (const id of [...sel]) if (!clip(id)) sel.delete(id); selTrans = null; }
  function undo() { if (!undoStack.length) return toast("Nothing to undo"); redoStack.push(snapshot()); restore(undoStack.pop()); changed(); }
  function redo() { if (!redoStack.length) return toast("Nothing to redo"); undoStack.push(snapshot()); restore(redoStack.pop()); changed(); }
  function changed() { render(); save(); }
  function save(delay = 700) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, delay);
  }
  async function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!tl) return;
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
        tl.clips.push({ ...c, id: uid(), start: t1, trim_in: q(c.trim_in + (t1 - c.start)) });
        c.trim_out = q(c.trim_in + (t0 - c.start));
      } else if (c.start < t0) c.trim_out = q(c.trim_out - (end(c) - t0));
      else { const d = t1 - c.start; c.trim_in = q(c.trim_in + d); c.start = q(t1); }
    }
  }
  function splitAt(c, t) {
    if (t <= c.start + 1 / fps() / 2 || t >= end(c) - 1 / fps() / 2) return null;
    const right = { ...c, id: uid(), start: q(t), trim_in: q(c.trim_in + (t - c.start)) };
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

  async function probe(ref) {
    if (!probes.has(ref)) probes.set(ref, fetch(`/api/media/probe?path=${encodeURIComponent(ref)}`).then(r => r.ok ? r.json() : null).catch(() => null));
    return probes.get(ref);
  }

  /* Put media on the timeline. opts: {track, at}; default = end of the first fitting track. */
  async function add(m, opts = {}) {
    if (!tl) return;
    const kind = m.kind;
    let tr = opts.track ? track(opts.track) : null;
    const fits = t => t && !t.locked && (t.kind === "video" ? kind !== "audio" : kind !== "image");
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
    if (kind === "video" && tr.kind === "video" && tl.link_audio && info?.has_audio) {
      const a = linkSound(c);
      if (a) sel.add(a.id);
    }
    changed();
    revealTime(end(c));
    return c;
  }

  /* Give a video clip a linked copy on an audio track and silence the video's own sound.
     Picks the first unlocked audio track that's free there, or adds a new one. */
  function linkSound(c) {
    const free = tl.tracks.find(t => t.kind === "audio" && !t.locked && !tl.clips.some(x => x.track === t.id && x.start < end(c) && end(x) > c.start));
    let at = free;
    if (!at) {
      const n = tl.tracks.filter(t => t.kind === "audio").length + 1;
      at = { id: uid(), kind: "audio", name: `A${n}`, muted: false, locked: false, hidden: false, volume: 1, height: 44 };
      tl.tracks.push(at);
    }
    c.link = c.link || uid();
    c.audio_off = true;
    const a = { ...c, id: uid(), track: at.id, audio_off: false };
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

  function copySel() { clipboard = [...sel].map(clip).filter(Boolean).map(c => ({ ...c })); if (clipboard.length) toast(`Copied ${clipboard.length} clip${clipboard.length > 1 ? "s" : ""}`); }
  function paste(at = tl.playhead) {
    if (!clipboard.length) return;
    const base = Math.min(...clipboard.map(c => c.start));
    checkpoint(); sel.clear();
    for (const src of clipboard) {
      if (!track(src.track) || track(src.track).locked) continue;
      const c = { ...src, id: uid(), start: q(at + src.start - base) };
      carve(c.track, c.start, end(c), new Set());
      tl.clips.push(c); sel.add(c.id);
    }
    changed();
  }
  function duplicate() {
    const list = [...sel].map(clip).filter(Boolean);
    if (!list.length) return;
    clipboard = list.map(c => ({ ...c }));
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
    save(1500);
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
    save(1500);
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
    if (tl) save(1000);
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
    const L1 = { v: $("#prog-video"), i: $("#prog-img") }, L2 = { v: $("#prog-video2"), i: $("#prog-img2") };
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
    const vol = (cl, f) => Math.min(1, cl.volume * track(cl.track).volume * f);
    showLayer(L1, c, t, live, look.a, c && !c.audio_off && !track(c.track).muted ? vol(c, pic?.b ? 1 - pic.p : 1) : 0, !!pic?.b && pic.type === "circleclose");
    showLayer(L2, pic?.b || null, t, live, look.b, pic?.b && !pic.b.audio_off && !track(pic.b.track).muted ? vol(pic.b, pic.p) : 0, !(pic?.type === "circleclose"));
    // Audio tracks (and video clips placed on them for their sound).
    const live_ids = new Set();
    for (const a of tl.clips) {
      const tr = track(a.track);
      if (!tr || tr.kind !== "audio" || a.kind === "image" || !(a.start <= t && end(a) > t)) continue;
      live_ids.add(a.id);
      let el = audioEls.get(a.id);
      if (!el) { el = new Audio(); el.preload = "auto"; audioEls.set(a.id, el); }
      if (el.dataset.ref !== a.ref) { el.src = mediaUrl(a.ref); el.dataset.ref = a.ref; }
      el.muted = tr.muted;
      // Crossfade on audio transitions.
      let gain = 1;
      const out = tl.transitions.find(x => x.a === a.id), inn = tl.transitions.find(x => x.b === a.id);
      if (out) { const b = clip(out.b); if (b && t >= b.start) gain *= Math.max(0, (end(a) - t) / (end(a) - b.start)); }
      if (inn) { const p0 = clip(inn.a); if (p0 && t < end(p0)) gain *= Math.max(0, (t - a.start) / (end(p0) - a.start)); }
      el.volume = Math.min(1, a.volume * tr.volume * gain);
      const target = a.trim_in + (t - a.start);
      if (live) { if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target; if (el.paused) el.play().catch(() => {}); }
      else { el.pause(); el.currentTime = target; }
    }
    for (const [id, el] of audioEls) if (!live_ids.has(id)) { el.pause(); if (!clip(id)) audioEls.delete(id); }
  }

  function showLayer(L, c, t, live, look, volume, onTop) {
    const { v, i } = L;
    for (const el of [v, i]) { el.style.opacity = look.opacity; el.style.clipPath = look.clip; el.style.transform = look.transform; el.style.zIndex = onTop ? 2 : 1; }
    if (!c) { v.hidden = true; i.hidden = true; v.pause(); return; }
    if (c.kind === "image") {
      v.hidden = true; v.pause(); i.hidden = false;
      if (i.dataset.ref !== c.ref) { i.src = mediaUrl(c.ref); i.dataset.ref = c.ref; }
      return;
    }
    i.hidden = true; v.hidden = false;
    const target = c.trim_in + (t - c.start);
    v.muted = volume <= 0; v.volume = Math.max(0, volume);
    if (v.dataset.ref !== c.ref) { v.src = mediaUrl(c.ref); v.dataset.ref = c.ref; v.currentTime = target; }
    if (live) {
      if (Math.abs(v.currentTime - target) > 0.2) v.currentTime = target;
      if (v.paused) v.play().catch(() => {});
    } else { v.pause(); if (Math.abs(v.currentTime - target) > 1 / fps() / 2) v.currentTime = target; }
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
      return `<div class="tl-row k-${tr.kind}${tr.locked ? " locked" : ""}${tr.muted ? " muted" : ""}${tr.hidden ? " hidden-track" : ""}" style="--h:${tr.height}px">
        <div class="tl-head" data-track="${tr.id}">
          <span class="tl-tname" title="Double-click to rename">${esc2(tr.name)}</span>
          <span class="tl-tbtns">
            ${tr.kind === "video" ? `<button type="button" data-tact="hidden" class="${tr.hidden ? "off" : ""}" title="${tr.hidden ? "Show" : "Hide"} track">👁</button>` : ""}
            <button type="button" data-tact="muted" class="${tr.muted ? "off" : ""}" title="${tr.muted ? "Unmute" : "Mute"} track">${tr.muted ? "🔇" : "🔊"}</button>
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
      <div class="tl-addrow"><div class="tl-head tl-addhead"><button type="button" class="link" data-act="add-video">＋ Video</button><button type="button" class="link" data-act="add-audio">＋ Audio</button></div><div class="tl-lane tl-dead" style="width:${width}px"></div></div>
      <div class="tl-playhead" style="left:${headW() + tl.playhead * tl.zoom}px"></div>
      <div class="tl-snap" hidden></div>
      ${tl.range_in != null || tl.range_out != null ? `<div class="tl-dim l" style="left:${headW()}px;width:${(tl.range_in ?? 0) * tl.zoom}px"></div>
        <div class="tl-dim r" style="left:${headW() + (tl.range_out ?? total()) * tl.zoom}px;right:0"></div>` : ""}`;
    $(".tl-canvas", root).style.width = `${headW() + width}px`;
    renderBar();
    if (Monitor.mode === "timeline") syncProgram(false);
  }

  function clipHTML(c) {
    const w = Math.max(2, dur(c) * tl.zoom), tr = track(c.track);
    const thumb = `/api/media/thumb?path=${encodeURIComponent(c.ref)}&w=${c.kind === "audio" || tr.kind === "audio" ? 384 : 160}&v=1`;
    const sound = tr.kind === "audio";
    const bg = sound
      ? (c.source_duration ? `background-image:url('${thumb}');background-size:${c.source_duration * tl.zoom}px 100%;background-position:${-c.trim_in * tl.zoom}px 0` : "")
      : `background-image:url('${thumb}');background-size:auto 100%`;
    return `<div class="tl-clip k-${c.kind}${sound ? " snd" : ""}${sel.has(c.id) ? " sel" : ""}${c.link ? " linked" : ""}${c.audio_off ? " silent" : ""}" data-clip="${c.id}" style="left:${c.start * tl.zoom}px;width:${w}px"
      title="${esc2(c.name)}${c.link ? " · linked (Alt+click selects just this one)" : ""}${c.audio_off ? " · sound on its linked audio clip" : ""}">
      <div class="tl-strip" style="${bg}"></div>
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
          const ok = tr && !tr.locked && (tr.kind === "video" ? c.kind !== "audio" : c.kind !== "image");
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
      ["Show in viewer", () => { const it = c.job && state.items.get(c.job); if (it) { select(it.id); Monitor.show("result"); } else Media.toast("The result for this clip isn't in the gallery."); }],
      ["Volume…", async () => {
        const v = await WM.ask({ title: "Clip volume", message: "0 = silent, 100 = as recorded, 200 = twice as loud", input: String(Math.round(c.volume * 100)), ok: "Set" });
        if (v != null && !isNaN(+v)) { checkpoint(); c.volume = Math.max(0, Math.min(2, +v / 100)); changed(); }
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
      ["Track volume…", async () => {
        const v = await WM.ask({ title: `${t.name} volume`, message: "0–200%", input: String(Math.round(t.volume * 100)), ok: "Set" });
        if (v != null && !isNaN(+v)) { checkpoint(); t.volume = Math.max(0, Math.min(2, +v / 100)); changed(); }
      }],
      ["＋ Video track", () => addTrack("video")],
      ["＋ Audio track", () => addTrack("audio")],
      ["Delete track", () => removeTrack(id)],
    ]);
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
  function renderMenu(x, y) {
    const sizes = [["original", "Size of the first clip"], ["1080", "1080p (short side)"], ["720", "720p (short side)"]];
    menu(x, y, [
      ["⬇ Render the whole timeline", () => renderTimeline(false)],
      (tl.range_in != null || tl.range_out != null) && ["⬇ Render the In–Out range", () => renderTimeline(true)],
      ["⇪ Export FCPXML for DaVinci Resolve…", exportFcpxml],
      ...sizes.map(([k, l]) => [`${renderSize === k ? "● " : "○ "}${l}`, () => { renderSize = k; writeUI({ renderSize: k }); }]),
    ].filter(Boolean));
  }
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
    await saveNow();
    const r = await fetch(`/api/timeline/fcpxml?project=${encodeURIComponent(project)}`);
    if (!r.ok) { const j = await r.json().catch(() => ({})); return toast(`Export failed: ${j.detail || r.statusText}`); }
    const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "")?.[1] || "timeline.fcpxml";
    const url = URL.createObjectURL(await r.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Saved ${name}. In DaVinci Resolve: File › Import › Timeline…, then pick the file (media is linked from where it is now).`);
  }

  async function renderTimeline(range) {
    if (!tl.clips.length) return toast("The timeline is empty.");
    await saveNow();
    const info = await probe(tl.clips.find(c => c.kind !== "audio")?.ref || "");
    let width = null, height = null;
    if (renderSize !== "original" && info?.width) {
      const short = +renderSize, s = short / Math.min(info.width, info.height);
      width = Math.round(info.width * s / 2) * 2; height = Math.round(info.height * s / 2) * 2;
    }
    try {
      const r = await fetch("/api/timeline/render", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, range_in: range ? tl.range_in : null, range_out: range ? tl.range_out : null, width, height }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      state.items.set(j.id, j); renderGallery(); renderQueue(); select(j.id); Monitor.show("result");
      toast("Rendering… the video appears in the results bin.");
    } catch (e) { toast(`Render failed: ${e.message}`); }
  }

  /* ------------------------------------------------------------------ shortcuts */
  const SHORTCUTS = [
    ["Playback", [["Space", "Play / pause"], ["K", "Pause"], ["L", "Play"], ["J", "Back 1 second"], ["Home / End", "Start / end"],
      ["← / →", "1 frame"], ["Shift+← / →", "1 second"], ["↑ / ↓", "Previous / next edit point or marker"], ["Ctrl+L", "Loop the In–Out range"]]],
    ["Editing", [["S or Ctrl+B", "Split at the playhead"], ["Ctrl+T", "Add a transition at the nearest cut"],
      ["Double-click a transition", "Change its type or length"], ["Shift (dropping a clip)", "Overlap the clip before as a transition"],
      ["Alt+click", "Select one clip of a linked video/sound pair"], ["Del / Backspace", "Delete"], ["Shift+Del", "Ripple delete (close the gap)"],
      ["Ctrl+C / Ctrl+V", "Copy / paste at the playhead"], ["Ctrl+D", "Duplicate after the selection"], [", / .", "Nudge selection 1 frame"],
      ["Ctrl+A", "Select all"], ["Esc", "Clear the selection"], ["Ctrl+Z", "Undo"], ["Ctrl+Shift+Z / Ctrl+Y", "Redo"], ["Alt (while dragging)", "Don't snap"]]],
    ["Timeline", [["I / O", "Set In / Out"], ["Alt+X", "Clear In and Out"], ["M", "Add a marker"], ["N", "Snapping on / off"],
      ["+ / −", "Zoom in / out"], ["Ctrl+wheel", "Zoom at the pointer"], ["Shift+wheel", "Scroll sideways"], ["F", "Fit the timeline"], ["Shift+F", "Zoom to the selection"],
      ["G", "Use the frame at the playhead as a first frame"], ["Ctrl+E", "Render"], ["T (on the clock)", "Frames / seconds"]]],
    ["Results bin", [["1 – 5", "Rate the selected result"], ["0", "Clear the rating"], ["Shift+T", "Tags…"], ["Enter", "Add to the timeline"], ["← / →", "Previous / next result"]]],
    ["Layout", [["Alt+1 … Alt+4", "Default, Edit, Review, Bin layouts"], ["Alt+5 … Alt+9", "Your saved layouts"], ["?", "This list"]]],
  ];
  function showShortcuts() {
    const box = document.createElement("div");
    box.className = "tl-keys";
    box.innerHTML = SHORTCUTS.map(([g, list]) => `<section><h4>${g}</h4><dl>${list.map(([k, v]) => `<dt>${k.split(" / ").map(x => `<kbd>${esc2(x)}</kbd>`).join(" / ")}</dt><dd>${esc2(v)}</dd>`).join("")}</dl></section>`).join("");
    WM.open({ id: "shortcuts", title: "Keyboard shortcuts", content: box, width: 760, height: 560, minWidth: 340, minHeight: 260 });
  }

  function onKey(e) {
    if (!tl || !root) return;
    const tgt = e.target;
    if (tgt.closest?.("input, textarea, select, [contenteditable]") || WM.top()) return;
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
    if (ctrl && k.toLowerCase() === "e") { handled(); return renderTimeline(tl.range_in != null || tl.range_out != null); }
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
      case "m": case "M": handled(); return addMarker();
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
        <button type="button" class="tl-b wide primary" data-act="render" title="Render to MP4 (Ctrl+E)">⬇ Render</button>
      </div>
      <div class="tl-scroll" tabindex="0" aria-label="Tracks"><div class="tl-canvas"></div></div>`;
    scroller = $(".tl-scroll", root);

    root.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
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
        snap: () => { tl.snap = !tl.snap; save(); renderBar(); }, grab: grabAtPlayhead, undo, redo,
        zoomin: () => zoomStep(1), zoomout: () => zoomStep(-1), fit: () => fit(),
        "add-video": () => addTrack("video"), "add-audio": () => addTrack("audio"),
        keys: showShortcuts, layout: () => Layout.menu(r.left, r.bottom + 4), render: () => renderMenu(r.left, r.bottom + 4),
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
    project = id || "experiment";
    tl = timeline && timeline.tracks?.length ? structuredClone(timeline) : blank();
    tl.transitions = tl.transitions || [];
    if (tl.link_audio == null) tl.link_audio = true;
    selTrans = null;
    sel.clear(); undoStack = []; redoStack = [];
    for (const el of audioEls.values()) el.pause();
    audioEls.clear();
    render();
    if (scroller) scroller.scrollLeft = Math.max(0, tl.playhead * tl.zoom - 100);
  }

  return {
    mount, setProject, add, play, pause, toggle, seek, render, saveNow, showShortcuts, onKey,
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
    $("#meta").hidden = mode === "timeline" || !state.selected;
    $$("#mon-seg button").forEach(b => b.classList.toggle("active", b.dataset.m === mode));
    if (mode === "result") { TL.pause(); $("#prog-video")?.pause(); }
    else { $$("#viewer video, #viewer audio").forEach(m => m.pause()); TL.syncProgram(); }
  },
};

/* ------------------------------------------------------------------ layouts */
const Layout = (() => {
  const PRESETS = [
    { name: "Default", monitor: 0.55, bin: 340 },
    { name: "Edit", monitor: 0.42, bin: 280 },
    { name: "Review", monitor: 0.74, bin: 360 },
    { name: "Bin", monitor: 0.5, bin: 640 },
  ];
  const read = () => { try { return JSON.parse(localStorage.getItem("bob.ui") || "{}") || {}; } catch { return {}; } };
  const write = p => { try { localStorage.setItem("bob.ui", JSON.stringify({ ...read(), ...p })); } catch {} };
  const saved = () => read().layouts || [];

  function current() {
    const css = getComputedStyle(document.documentElement);
    return { monitor: parseFloat(css.getPropertyValue("--mon-frac")) || 0.55, bin: parseFloat(css.getPropertyValue("--bin-w")) || 340,
      side: parseFloat(css.getPropertyValue("--side-w")) || 460, zoom: TL.model?.zoom };
  }
  function setMonitor(f, persist = true) {
    f = Math.max(0.18, Math.min(0.86, f));
    document.documentElement.style.setProperty("--mon-frac", f);
    if (persist) write({ monitor: f });
  }
  function setBin(w, persist = true) {
    const stage = $(".bottom")?.clientWidth || 1000;
    w = Math.round(Math.max(200, Math.min(stage - 320, w)));
    document.documentElement.style.setProperty("--bin-w", w + "px");
    if (persist) write({ binWidth: w });
  }
  function apply(l) {
    if (!l) return;
    setMonitor(l.monitor); setBin(l.bin);
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
      const r = $(".bottom").getBoundingClientRect();
      setBin(e.clientX - r.left, done);
    }, () => setBin(340));
    $("#bin-split").addEventListener("keydown", e => {
      const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bin-w")) || 340;
      if (e.key === "ArrowLeft") { e.preventDefault(); setBin(w - 24); }
      if (e.key === "ArrowRight") { e.preventDefault(); setBin(w + 24); }
    });
  }
  return { init, menu, applyIndex, apply, saveCurrent };
})();
