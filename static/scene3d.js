/* 3D scenes: a picture's background as a depth surface (Depth Anything 3, made on the server: app/model3d.py) with
   3D models (Make 3D) standing in it where their objects were, seen through the picture's own camera.

   The background GLB comes skewed (see build_scene_background), so it is rebuilt here: every vertex keeps its UV
   (its place in the picture) and its depth (-Z), and goes back out along the picture camera's ray. That camera sits
   at the origin looking down -Z (Y up), its field of view read from the mesh. An object is placed by its mask: its
   foot (the bottom middle of the mask) stands on the background just below it, and its height in the picture sets
   its size. Drag an object to move it over the ground, Shift+drag to raise it; drag elsewhere to orbit, right-drag
   to pan, wheel to zoom; 🎥 goes back to the picture's camera.

   Keyframes (as in Animate objects: the H3 frame grid at 24 fps): moving, turning or sizing an object at the playhead
   keys it there, and its path runs through its keys (position on a smooth curve, turn and size in a straight line).
   The camera is keyed on purpose (◆ Key the camera): orbiting to look around doesn't change its path; scrubbing or
   playing puts the view back on it.

   An empty scene (☰ › 3D scenes › New empty scene) has no picture: a floor 1.6 units (metres) under the camera with a
   1 m grid, a sky colour and, if chosen, a picture far behind as a backdrop; its lens and shape (aspect) are set here.
   The tool bar adds primitive shapes (cube, sphere, cylinder, cone, plane, ring), made here with a colour and a size,
   and picks what dragging an object does (move, raise, rotate, resize). Right-click an object for its menu (move,
   raise, rotate or resize it following the mouse until a click, turn it 90°, size it up or down, set it down on the
   ground, duplicate, rename, hide, delete); right-click the ground to add a shape there. Keys: G move, L raise,
   R rotate, S resize (then X, Y or Z: along that axis only), Shift+D duplicate, Del delete, Esc cancel, Ctrl+Z undo,
   Ctrl+Y (or Ctrl+Shift+Z) redo.
   The selected object shows a gizmo for the tool, as in Blender: arrows to move it along X, Y or Z (the scene's axes),
   rings to turn it about each axis (gimbal: Y is upright, X turns with it, Z with both), and handles to stretch it
   along its own axes (the middle ball sizes all of it). Ctrl while dragging one snaps (0.1 m, 15°, 10%).
   📷 Generate photo draws what the camera frames (the frame on the view) and has the image editor's whole-picture edit
   (Qwen Image Edit 2511 or MiniMax H3 Image) make a photograph of it, keeping the layout.
   The models only see pictures, so each object is told to them by what they can see: "the red cube on the left", with
   what it Becomes (a field per object: "a wooden crate"). In 🎬 Render's text, {Name} stands for an object and is sent
   as that description, e.g. "the wooden crate (the red cube on the left)". An object can also have a Picture (cut from
   the scene's picture, a file, or dropped from the gallery): 🎬 Render can then run on H3 Reference, with the first
   frame as <Picture 1> and the objects' pictures as <Picture 2>..., so {Dog} is sent as "the golden retriever from
   <Picture 2> (the red cube on the left)". */
"use strict";

const Scene3D = (() => {
  const rad = Math.PI / 180;
  const G = () => Model3D.gl;
  let s = null;        // the open scene window
  let list = null;     // the open scenes list
  let models = [];     // /api/models3d, refreshed while any is being made
  let startModal = () => {}, endModal = () => {};  // set by wire(): an object following the mouse

  const uid = () => Math.random().toString(36).slice(2, 10);
  const FPS = 24;
  const dur = () => ((window.H3Prompt?.h3Length?.(+s.seconds || 5) ?? Math.round((+s.seconds || 5) * FPS) + 1) - 1) / FPS;
  const near = (a, b) => Math.abs(a - b) < 0.5 / FPS;

  /* ---------------------------------------------------------------- keys */
  const cr = (q0, q1, q2, q3, u) => 0.5 * ((2 * q1) + (-q0 + q2) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u * u + (-q0 + 3 * q1 - 3 * q2 + q3) * u * u * u);
  // Between keys K (sorted by t): fields in `smooth` on a Catmull-Rom curve, the rest in a straight line.
  const same = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, j) => Math.abs(v - y[j]) < 1e-6);
  function interp(K, t, smooth) {
    if (K.length === 1 || t <= K[0].t) return K[0];
    if (t >= K.at(-1).t) return K.at(-1);
    let i = 0; while (K[i + 1].t < t) i++;
    const a = K[i], b = K[i + 1], p0 = K[i - 1] || a, p3 = K[i + 2] || b, u = (t - a.t) / Math.max(1e-6, b.t - a.t), out = { t };
    for (const k of Object.keys(a)) {
      if (k === "t") continue;
      if (typeof a[k] === "string" || typeof b[k] !== typeof a[k]) { out[k] = u < 0.5 || b[k] === undefined ? a[k] : b[k]; continue; }
      if (Array.isArray(a[k]) && smooth.includes(k)) {
        // A hold (two keys in the same place) stays put, and the path eases into and out of it: no overshoot past a
        // stop and back (which also turned a "face where it's going" object round when it stopped).
        if (same(a[k], b[k])) { out[k] = a[k].slice(); continue; }
        const q0 = same(p0[k], a[k]) ? b : p0, q3 = same(p3[k], b[k]) ? a : p3;
        out[k] = a[k].map((v, j) => cr(q0[k][j], v, b[k][j], q3[k][j], u));
      } else if (Array.isArray(a[k])) out[k] = a[k].map((v, j) => v + (b[k][j] - v) * u);
      else out[k] = smooth.includes(k) ? cr(p0[k], a[k], b[k], p3[k], u) : a[k] + (b[k] - a[k]) * u;
    }
    return out;
  }
  const baseOf = o => ({ pos: o.pos.slice(), yaw: o.yaw || 0, pitch: o.pitch || 0, roll: o.roll || 0, scale: o.scale,
    ...(o.prim === "figure" ? { pose: o.pose || "standing" } : {}) });
  const normKeys = K => (K || []).map(k => ({ pitch: 0, roll: 0, ...k }));
  // An object's pose at time t.
  function poseAt(o, t) {
    const P = o.keys?.length ? { ...interp(o.keys, t, ["pos"]) } : baseOf(o);  // a copy: before the first key interp gives the key itself
    if (o.face) P.heading = headingAt(o, t);
    return P;
  }
  /* Face where it's going: while an object moves over the ground, it turns (about Y) to face the way it goes; stopped,
     it keeps the heading it last moved with. Its own Y rotation is added on top (0 = facing straight ahead). Shown and
     rendered only: keys keep the object's own rotation. Yaw 0 faces +Z, so the heading of a step (dx, dz) is atan2. */
  function headingAt(o, t) {
    const K = o.keys; if (!K || K.length < 2) return 0;
    const at = tt => interp(K, Math.max(K[0].t, Math.min(K.at(-1).t, tt)), ["pos"]).pos, h = 1 / 48;
    const dirAt = tt => { const a = at(tt - h), b = at(tt + h); return [b[0] - a[0], b[2] - a[2]]; };
    const H = o.mesh ? (o.mesh.hi[1] - o.mesh.lo[1]) * (o.stretch?.[1] || 1) * (interp(K, t, ["pos"]).scale || 1) : 1;
    const moving = d => Math.hypot(d[0], d[1]) > 0.004 * Math.max(0.05, H);  // over about a tenth of its height a second
    let d = dirAt(t);
    // stopped (or before it starts): the heading it last moved with, else the one it's about to move with
    for (let k = 1; !moving(d) && k <= 240; k++) {
      const back = t - k / 24, fwd = t + k / 24;
      if (back >= K[0].t) { d = dirAt(back); if (moving(d)) break; }
      if (fwd <= K.at(-1).t) d = dirAt(fwd);
      if (back < K[0].t && fwd > K.at(-1).t) break;
    }
    return moving(d) ? Math.atan2(d[0], d[1]) / rad : 0;
  }
  // Change an object at the playhead: before it has keys, at 0 s this is its place; otherwise it's keyed there.
  function editPose(o, f) {
    if (!o.keys?.length) {
      if (near(s.t, 0)) { Object.assign(o, f); return; }
      o.keys = [{ t: 0, ...baseOf(o) }];
    }
    let k = o.keys.find(q => near(q.t, s.t));
    if (!k) { const p = poseAt(o, s.t); k = { t: s.t, pos: p.pos.slice(), yaw: p.yaw, pitch: p.pitch || 0, roll: p.roll || 0, scale: p.scale }; o.keys.push(k); o.keys.sort((a, b) => a.t - b.t); }
    Object.assign(k, f);
    fromFirstKey(o);
  }
  function fromFirstKey(o) { const k = o.keys[0]; Object.assign(o, { pos: k.pos.slice(), yaw: k.yaw, pitch: k.pitch || 0, roll: k.roll || 0, scale: k.scale, ...(k.pose ? { pose: k.pose } : {}) }); }
  // A camera: an orbit (yaw, pitch, dist about target) and, keyed for a zoom, its lens (mm on a 36 mm wide frame).
  const camOf = c => ({ yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: c.target.slice(), ...(c.lens ? { lens: c.lens } : {}), ...(c.roll ? { roll: c.roll } : {}), ...(c.focus ? { focus: c.focus } : {}), ...(typeof c.shake === "number" ? { shake: c.shake } : {}) });
  // A camera's axes: forward, right and up, turned by its roll (degrees about forward; + leans the top to the right).
  function axesOf(c) {
    const f = norm(sub(c.target, eyeOf(c))), r0 = norm(cross(f, [0, 1, 0])), u0 = cross(r0, f), a = (c.roll || 0) * rad, co = Math.cos(a), si = Math.sin(a);
    return { f, r: addv(mulv(r0, co), mulv(u0, -si)), u: addv(mulv(u0, co), mulv(r0, si)) };
  }
  function camAt(t) {
    // keys without a lens have the scene's (so a zoom eases from it and back)
    const lens = s.camKeys.some(k => k.lens), roll = s.camKeys.some(k => k.roll), focus = s.camKeys.some(k => k.focus), shake = s.camKeys.some(k => typeof k.shake === "number");
    // a key without a focus distance keeps the one before it (or, before any, the first keyed one): focus pulls only
    // between keys that set it
    let held = s.camKeys.find(k => k.focus)?.focus, sh = s.camKeys.find(k => typeof k.shake === "number")?.shake;
    const K = lens || roll || focus || shake ? s.camKeys.map(k => { if (k.focus) held = k.focus; if (typeof k.shake === "number") sh = k.shake;
      return { ...k, ...(lens ? { lens: k.lens || baseLens() } : {}), ...(roll ? { roll: k.roll || 0 } : {}), ...(focus ? { focus: k.focus || held } : {}),
        ...(shake ? { shake: sh } : {}) }; }) : s.camKeys;
    const c = interp(K, easeT(t), ["yaw", "pitch", "dist", "target"]);
    return { ...camOf(c), dist: Math.max(s.bg.dmed * 0.02, c.dist) };
  }
  /* Easing: each camera key says how the camera gets to the next key (its `ease`): steady (none), or slow at the start,
     the end, or both. It bends time within that stretch only, so the camera still passes every key when it was keyed. */
  const EASES = {
    in: { label: "Ease in: starts slowly, then speeds up", short: "ease in", f: u => u * u * u },
    out: { label: "Ease out: slows down into the next key", short: "ease out", f: u => 1 - (1 - u) ** 3 },
    inout: { label: "Ease in and out: starts and stops gently", short: "ease in-out", f: u => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2 },
  };
  function easeT(t) {
    const K = s.camKeys;
    if (K.length < 2 || t <= K[0].t || t >= K.at(-1).t) return t;
    let i = 0; while (K[i + 1].t < t) i++;
    const a = K[i], b = K[i + 1], e = EASES[a.ease]?.f; if (!e) return t;
    return a.t + e((t - a.t) / Math.max(1e-6, b.t - a.t)) * (b.t - a.t);
  }
  /* Camera shake: an amount keyed with the camera (0 to 100 %, held from the key before) and the scene camera's style.
     It's smooth noise (a few sine waves per axis at unrelated rates) that turns the camera a little about its eye and
     moves it a little, on top of its path: never stored in the keys, drawn in the view, the preview and the render (so
     H3 follows it), and told to H3. */
  const SHAKES = {
    handheld: { label: "Handheld", f: 0.7, rot: [0.8, 0.6, 0.5], pos: [0.012, 0.01], says: "The camera is handheld, with a natural slight shake." },
    walking: { label: "Walking", f: 1.8, rot: [0.6, 1.0, 0.9], pos: [0.012, 0.03], bob: true, says: "The handheld camera bobs and sways with the operator's steps." },
    vehicle: { label: "Vehicle", f: 7, rot: [0.25, 0.35, 0.2], pos: [0.006, 0.008], says: "The camera vibrates as if it is mounted on a moving vehicle." },
    impact: { label: "Earthquake", f: 3, rot: [2.2, 2.2, 1.6], pos: [0.04, 0.04], says: "The camera shakes violently." },
  };
  const shakeStyle = () => SHAKES[s.sc.fx?.shake_style] ? s.sc.fx.shake_style : "handheld";
  // smooth noise in about -1..1 for channel i at time t (seconds)
  const wobble = (t, i, f) => 0.55 * Math.sin(2 * Math.PI * f * t + i * 1.9) + 0.3 * Math.sin(2 * Math.PI * f * 2.31 * t + i * 4.1 + 1)
    + 0.15 * Math.sin(2 * Math.PI * f * 5.17 * t + i * 2.7 + 2);
  function withShake(c, t) {
    const a = (typeof c.shake === "number" ? c.shake : 0) / 100;
    if (!(a > 0) || !s?.bg) return c;
    const st = SHAKES[shakeStyle()], k = st.f;
    const n = [0, 1, 2, 3, 4].map(i => wobble(t, i, k));
    let up = st.pos[1] * n[4];
    if (st.bob) up = st.pos[1] * (0.5 - Math.abs(Math.sin(Math.PI * k * t))) + st.pos[1] * 0.3 * n[4];  // a step every half cycle
    const turned = turnCam(c, c.yaw + a * st.rot[0] * n[0], c.pitch + a * st.rot[1] * n[1]);
    turned.roll = (c.roll || 0) + a * st.rot[2] * n[2];
    const { r: rr, u } = axesOf({ ...turned, roll: 0 }), d = addv(mulv(rr, a * st.pos[0] * n[3]), mulv(u, a * up));
    return { ...turned, target: addv(turned.target, d) };
  }
  const shakes = () => s.camKeys.some(k => (k.shake || 0) > 0);

  /* Depth of field: the scene's aperture (s.sc.dof.fstop; none = everything sharp) and the camera's focus distance (keyed:
     a rack focus between keys; unkeyed, where it looks). Shown from outside as the plane in focus with the near and far
     limits of what's sharp; H3 and the photo are told what's in focus and how soft the rest is. */
  const FSTOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
  const fstop = () => +s.sc.dof?.fstop || 0;
  const focusOf = c => c.focus || c.dist;
  // near and far limits of acceptable sharpness (scene units as metres; a 0.03 mm circle of confusion on a 36 mm frame)
  function dofRange(c) {
    const N = fstop(); if (!N) return null;
    const f = c.lens || baseLens(), F = focusOf(c), Hf = f * f / (N * 0.03) / 1000;
    return { near: F * Hf / (Hf + F), far: F < Hf ? F * Hf / (Hf - F) : Infinity, F };
  }
  // what's in focus at time t: the shown object nearest the focus distance, or the distance
  function focusSubject(t, c = camForRender(t)) {
    const F = focusOf(c), { f } = axesOf(c), E = eyeOf(c);
    const list = cast(t, c, true, true).filter(x => !x.off).map(x => ({ x, z: dot3(sub(poseAt(x.o, t).pos, E), f) })).filter(q => q.z > 0);
    const best = list.sort((a, b) => Math.abs(a.z - F) - Math.abs(b.z - F))[0];
    return best && Math.abs(best.z - F) < Math.max(0.6, F * 0.3) ? `the ${best.x.becomes ? bare(best.x.becomes) : best.x.looks}` : `whatever is ${F.toFixed(1)} m from the camera`;
  }
  // the sentence for H3 (video: over the whole length, with a rack focus) or a photo (at time t)
  function dofLine(video = true, t = 0) {
    const N = fstop(); if (!N || !s.bg) return "";
    const how = N <= 2 ? "a very shallow depth of field" : N <= 4 ? "a shallow depth of field" : N <= 8 ? "a moderate depth of field" : "";
    if (!how) return "Deep focus: everything is sharp.";
    // a rack focus only when the focus distance itself changes (not when things move through a steady focus)
    const F0 = focusOf(camForRender(video ? 0 : t)), F1 = focusOf(camForRender(dur())), pull = video && Math.abs(F1 - F0) > 0.05 * F0;
    const a = focusSubject(video ? 0 : t), b = pull ? focusSubject(dur()) : a;
    return a === b ? `Shot with ${how}: ${a} is in sharp focus and what's nearer or farther is softly blurred.`
      : `Shot with ${how}: the focus pulls from ${a} to ${b}; what's out of focus is softly blurred.`;
  }
  // The scene's own lens, from its frame: an empty scene's (View › Lens), or the picture's (estimated from it).
  const baseLens = () => 18 / Math.max(s.bg.t, s.bg.tv);
  // What a camera sees: the half-angle tangents across and up, narrowed or widened by its keyed lens.
  function fovOf(c) { const k = c?.lens ? baseLens() / c.lens : 1; return { t: s.bg.t * k, tv: s.bg.tv * k }; }
  // The playhead moved: the camera goes back on its path.
  function setTime(t) {
    s.t = Math.max(0, Math.min(dur(), t));
    if (s.camKeys.length && s.bg && !(s.camObj && s.camFree)) { s.cam = withShake(camAt(s.t), s.t); s.camFree = false; }
    s.dirty = true; renderTime();
  }

  /* ---------------------------------------------------------------- starting one */
  // src: { ref, url, name, plate?, objects?: [{ name, mask, model? }] }
  async function createEmpty() {
    try {
      const sc = await api("/api/scenes", { method: "POST", body: JSON.stringify({ picture: null, name: "Empty scene", project: state.project?.id ?? null }) });
      refreshList(); open(sc.id);
    } catch (e) { Media.toast(`3D scene: ${e.message}`); }
  }
  async function create(src) {
    const cap = state.caps?.editor || {};
    if (cap.scene3d === false) return Media.toast("3D scenes need ComfyUI's Depth Anything 3 nodes and depth_anything_3_base.");
    try {
      const sc = await api("/api/scenes", { method: "POST", body: JSON.stringify({
        picture: src.ref, plate: src.plate || null, name: src.name || "3D scene", project: state.project?.id ?? null,
        objects: (src.objects || []).map(o => ({ id: uid(), name: o.name || "Object", mask: o.mask || null, model: o.model || null })) }) });
      refreshPanel();
      open(sc.id);
    } catch (e) { Media.toast(`3D scene: ${e.message}`); }
  }

  // A scene for a shot on the Shots step (shots.js): a picture in depth or none, the shot's length and, empty, the
  // project's picture shape. Opens it; returns the new scene (or null).
  async function createFor({ picture = null, name = "3D scene", seconds = 5 }) {
    if (picture && state.caps?.editor?.scene3d === false) { Media.toast("3D scenes need ComfyUI's Depth Anything 3 nodes and depth_anything_3_base."); return null; }
    const asp = document.getElementById("aspect")?.value;
    try {
      const sc = await api("/api/scenes", { method: "POST", body: JSON.stringify({ picture, name, project: state.project?.id ?? null,
        seconds: Math.max(1, Math.min(10, +seconds || 5)), aspect: ["16:9", "9:16", "1:1", "4:3", "21:9"].includes(asp) ? asp : null }) });
      refreshPanel(); open(sc.id);
      return sc;
    } catch (e) { Media.toast(`3D scene: ${e.message}`); return null; }
  }
  /* Templates: a scene saved as one is listed in every project (the 3D scenes panel's ⭐ From a template…, and All
     scenes…), and a new scene from it is a copy (its background, objects, camera path, length and effects) in the open
     project, to change as you like; the template stays as it is. */
  const templates = async () => { try { return ((await api("/api/scenes")).scenes || []).filter(x => x.template && x.status === "done"); } catch { return []; } };
  async function setTemplate(id, on) {
    try {
      const sc = await api(`/api/scenes/${id}`, { method: "PATCH", body: JSON.stringify({ template: on }) });
      if (s?.id === id) { s.sc.template = sc.template; syncTplBtn(); }
      refreshList();
      Media.toast(on ? `“${sc.name}” is a template: ⭐ From a template… in the 3D scenes panel starts a new scene from it.` : `“${sc.name}” isn't a template any more.`);
    } catch (e) { Media.toast(`Template: ${e.message}`); }
  }
  async function fromTemplate(x) {
    try {
      const sc = await api(`/api/scenes/${x.id}/copy`, { method: "POST", body: JSON.stringify({ name: x.name, project: state.project?.id ?? null }) });
      refreshList(); open(sc.id);
      Media.toast(`A new scene from the template “${x.name}”: change it as you like; the template stays as it is.`);
      return sc;
    } catch (e) { Media.toast(`Template: ${e.message}`); return null; }
  }
  async function templateMenu(px, py) {
    const list = await templates();
    if (!list.length) return Media.toast("No templates yet: open a scene and press ⭐ Save as template, or use ⋯ › ⭐ Save as a template on one.");
    Media.menu(px, py, list.map(x => [`⭐ ${x.name}${x.seconds ? ` · ${(+x.seconds).toFixed(0)} s` : ""}`, () => fromTemplate(x)]));
  }
  const syncTplBtn = () => {
    const b = s?.foot?.querySelector('[data-act="tpl"]');
    if (b) { b.textContent = s.sc.template ? "⭐ Template" : "☆ Save as template"; b.title = s.sc.template ? "This scene is a template (click to stop): new scenes can start from it" : "Keep this scene as a template: new scenes in any project can start from a copy of it"; }
  };
  // This project's finished scenes.
  async function projectScenes() {
    const proj = state.project?.id ?? null;
    try { return ((await api("/api/scenes")).scenes || []).filter(x => (x.project ?? null) === proj && x.status === "done"); } catch { return []; }
  }

  /* ---------------------------------------------------------------- the list */
  async function openList() {
    if (list?.win?.el?.isConnected) return refreshList();
    const box = document.createElement("div");
    box.className = "m3-list";
    box.innerHTML = `<div class="s3-listbar"><button type="button" class="btn sm primary" data-new="1" title="A floor and a sky to build a scene from 3D models, with no picture">＋ New empty scene</button>
      <button type="button" class="btn sm" data-tpl="1" title="A new scene, a copy of one of your templates">⭐ From a template…</button></div><div class="m3-grid"></div>`;
    box.querySelector("[data-new]").onclick = () => createEmpty();
    box.querySelector("[data-tpl]").onclick = e => { const r = e.currentTarget.getBoundingClientRect(); templateMenu(r.left, r.bottom + 4); };
    const win = WM.open({ id: "scenes3d", title: "🏞 3D scenes", content: box, width: 760, height: 520, minWidth: 420, minHeight: 300, onClose: () => { list = null; } });
    list = { win, grid: box.querySelector(".m3-grid"), items: [] };
    box.addEventListener("click", e => {
      const more = e.target.closest("[data-more]");
      if (more) { const r = more.getBoundingClientRect(); return itemMenu(list.items[+more.dataset.more], r.left, r.bottom + 4); }
      const c = e.target.closest(".m3-card"); if (c && list.items[+c.dataset.i]?.status === "done") open(list.items[+c.dataset.i].id);
    });
    box.addEventListener("contextmenu", e => { const c = e.target.closest(".m3-card"); if (!c) return; e.preventDefault(); itemMenu(list.items[+c.dataset.i], e.clientX, e.clientY); });
    refreshList();
  }
  async function refreshList() {
    refreshPanel();
    if (!list) return;
    try { list.items = (await api("/api/scenes")).scenes || []; } catch (e) { list.grid.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    list.grid.innerHTML = list.items.length ? list.items.map((x, i) => `
      <figure class="m3-card ${x.status}" data-i="${i}" tabindex="0">
        <div class="m3-thumb">${x.plate_url || x.picture_url ? `<img src="${esc(x.plate_url || x.picture_url)}" alt="">` : "🏞"}${x.status === "failed" ? `<span class="m3-fail">Failed</span>` : ""}</div>
        <figcaption><b>${x.template ? "⭐ " : ""}${esc(x.name)}</b><span class="hint">${x.template ? "template · " : ""}${x.objects?.length || 0} object${x.objects?.length === 1 ? "" : "s"}${x.status === "failed" ? ` · ${esc((x.error || "").slice(0, 60))}` : ""}</span></figcaption>
        <button type="button" class="m3-more" data-more="${i}" aria-label="More for ${esc(x.name)}">⋯</button></figure>`).join("")
      : `<p class="hint m3-empty">No 3D scenes yet. Right-click a picture and choose 🏞 3D scene, or use 🏞 Open as a 3D scene in 🎬 Animate objects.</p>`;
  }
  function itemMenu(x, px, py, shots = false) {
    if (!x) return;
    // on the Shots step: which shot it's for
    const sh = shots && typeof Shots !== "undefined" && Shots.each() ? Shots.shotOfScene(x.id) : null;
    const shotItems = shots && sh === null && typeof Shots !== "undefined" && Shots.each() && x.status === "done"
      ? state.shots.list.map((y, i) => [`🎞 For shot ${i + 1}${y.title ? `: ${y.title}` : ""}`, () => Shots.linkScene(i, x)]) : [];
    Media.menu(px, py, [
      x.status === "done" && ["🏞 Open", () => open(x.id)],
      x.status === "done" && x.template && ["＋ New scene from this template", () => fromTemplate(x)],
      ...shotItems,
      x.status === "done" && [x.template ? "☆ Not a template any more" : "⭐ Save as a template", () => setTemplate(x.id, !x.template)],
      sh && [`✕ Not for shot ${sh.i + 1} any more`, () => Shots.unlinkScene(x.id)],
      ["✎ Rename…", async () => { const n = prompt("Name", x.name); if (!n?.trim()) return; try { await api(`/api/scenes/${x.id}`, { method: "PATCH", body: JSON.stringify({ name: n.trim() }) }); refreshList(); } catch (e) { Media.toast(e.message); } }],
      ["🗑 Delete…", async () => { if (!confirm(`Delete the scene “${x.name}”? Its 3D models stay in 🧊 3D models.`)) return; try { await api(`/api/scenes/${x.id}`, { method: "DELETE" }); if (typeof Shots !== "undefined") Shots.unlinkScene(x.id); refreshList(); } catch (e) { Media.toast(e.message); } }],
    ].filter(Boolean));
  }

  /* ---------------------------------------------------------------- the Shots step's panel
     For the models a scene renders with (H3, H3 Reference): this project's scenes, a new empty one, or one from an
     Inputs picture. Opening one shows the builder in its own window, as from the ☰ menu. */
  let panelTimer = 0, panelWired = false, panelFetched = 0;
  const panelFits = () => (state.kind === "video" && ["h3", "h3ref"].includes(state.engine.video)) || (state.kind === "image" && state.engine.image === "h3image");
  async function refreshPanel(force = true) {
    const box = document.getElementById("shots-scenes");
    if (!box) return;
    box.hidden = !panelFits();
    if (box.hidden) return;
    if (!panelWired) wirePanel(box);
    const cap = state.caps?.editor || {}, pics = inputPictures();
    const pb = box.querySelector('[data-s3p="picture"]');
    pb.disabled = cap.scene3d === false || !pics.length;
    pb.title = cap.scene3d === false ? "Needs ComfyUI's Depth Anything 3 nodes and depth_anything_3_base"
      : pics.length ? "One of the Inputs step's pictures (a keyframe or a reference) in depth, to stand 3D models in" : "Add a keyframe or reference picture in the Inputs step first";
    const sb = box.querySelector('[data-s3p="shot"]');
    if (sb) sb.disabled = !(typeof Shots !== "undefined" && Shots.each());
    if (sb) sb.title = sb.disabled ? "In “One video per shot”: a scene for one of the shots"
      : Shots.isImage() ? "A scene for one of the shots, from its inputs (its picture and text); Generate makes that shot's picture from its shot camera"
      : "A scene for one of the shots, from its inputs (its picture, length and text); its 🎬 Render goes to that shot";
    if (!force && Date.now() - panelFetched < 5000) return;  // Shots.render runs on every edit
    panelFetched = Date.now();
    let all;
    try { all = (await api("/api/scenes")).scenes || []; } catch { return; }
    const proj = state.project?.id ?? null, mine = all.filter(x => (x.project ?? null) === proj);
    box._items = mine;
    const grid = box.querySelector(".s3p-grid"), others = all.length - mine.length;
    box.querySelector(".s3p-sum").textContent = mine.length ? ` · ${mine.length}` : "";
    grid.innerHTML = mine.length ? mine.map((x, i) => `
      <figure class="m3-card ${x.status}" data-i="${i}" tabindex="0" title="${x.status === "done" ? "Open this scene" : x.status === "failed" ? esc(x.error || "Failed") : "Being made…"}">
        <div class="m3-thumb">${x.plate_url || x.picture_url || x.backdrop_url ? `<img src="${esc(x.plate_url || x.picture_url || x.backdrop_url)}" alt="">` : "🏞"}${x.status === "failed" ? `<span class="m3-fail">Failed</span>` : ""}</div>
        <figcaption><b>${x.template ? "⭐ " : ""}${esc(x.name)}</b><span class="hint">${(() => { const sh = typeof Shots !== "undefined" && Shots.shotOfScene(x.id); return sh ? `<span class="s3p-shot" title="${esc(sh.label)}: its 🎬 Render goes there">→ Shot ${sh.i + 1}</span> · ` : ""; })()}${x.status === "done" ? `${x.objects?.length || 0} object${x.objects?.length === 1 ? "" : "s"}` : x.status === "failed" ? "failed" : "making the depth…"}</span></figcaption>
        <button type="button" class="m3-more" data-more="${i}" aria-label="More for ${esc(x.name)}">⋯</button></figure>`).join("")
      : `<p class="hint m3-empty">No 3D scenes in this project yet${others ? ` (${others} in other projects: All scenes…)` : ""}.</p>`;
    clearTimeout(panelTimer);
    if (mine.some(x => !["done", "failed"].includes(x.status))) panelTimer = setTimeout(() => { if (!box.hidden && box.open) refreshPanel(); }, 4000);
  }
  // The Inputs step's pictures: the keyframes and the reference pictures.
  function inputPictures() {
    const f = state.frames || {};
    return [[f.first_frame, "First frame"], [f.last_frame, "Last frame"], ...(state.refs || []).map((r, i) => [r, `Picture ${i + 1}`])]
      .filter(([r]) => r?.ref && r.url).map(([r, label]) => ({ ref: r.ref, url: r.url, label, name: r.ref.split("/").pop().replace(/\.[^.]+$/, "") }));
  }
  function wirePanel(box) {
    panelWired = true;
    box.addEventListener("toggle", () => { if (box.open) refreshPanel(); });
    box.addEventListener("click", e => {
      const act = e.target.closest("[data-s3p]")?.dataset.s3p;
      if (act === "new") return createEmpty();
      if (act === "all") return openList();
      if (act === "tpl") { const r = e.target.closest("[data-s3p]").getBoundingClientRect(); return templateMenu(r.left, r.bottom + 4); }
      if (act === "picture") {
        const r = e.target.closest("[data-s3p]").getBoundingClientRect();
        return Media.menu(r.left, r.bottom + 4, inputPictures().map(p => [`🖼 ${p.label}: ${p.name}`, () => create(p)]));
      }
      if (act === "shot") {  // pick the shot; its Edit window has the choice of picture
        const r = e.target.closest("[data-s3p]").getBoundingClientRect();
        return Media.menu(r.left, r.bottom + 4, state.shots.list.map((x, i) => [`🎞 Shot ${i + 1}${x.title ? `: ${x.title}` : ""}${x.sceneLink ? " (has a scene)" : ""}`, () => Shots.openModal(i)]));
      }
      const more = e.target.closest("[data-more]");
      if (more) { const r = more.getBoundingClientRect(); return itemMenu(box._items?.[+more.dataset.more], r.left, r.bottom + 4, true); }
      const c = e.target.closest(".m3-card"), x = c && box._items?.[+c.dataset.i];
      if (x?.status === "done") open(x.id);
    });
    box.addEventListener("keydown", e => {
      const c = e.target.closest?.(".m3-card"), x = c && box._items?.[+c.dataset.i];
      if (x?.status === "done" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(x.id); }
    });
    box.addEventListener("contextmenu", e => { const c = e.target.closest(".m3-card"); if (!c) return; e.preventDefault(); itemMenu(box._items?.[+c.dataset.i], e.clientX, e.clientY, true); });
  }

  /* ---------------------------------------------------------------- maths */
  const { mul4, perspective, lookAt } = { mul4: (...a) => G().mul4(...a), perspective: (...a) => G().perspective(...a), lookAt: (...a) => G().lookAt(...a) };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mulv = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const S = k => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
  const RY = a => { const c = Math.cos(a), n = Math.sin(a); return [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 0, 0, 0, 1]; };
  const RX = a => { const c = Math.cos(a), n = Math.sin(a); return [1, 0, 0, 0, 0, c, n, 0, 0, -n, c, 0, 0, 0, 0, 1]; };
  const RZ = a => { const c = Math.cos(a), n = Math.sin(a); return [c, n, 0, 0, -n, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
  const SV = v => [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1];
  const ID = T(0, 0, 0);
  const xf = (M, v, w) => [0, 1, 2].map(j => M[j] * v[0] + M[4 + j] * v[1] + M[8 + j] * v[2] + M[12 + j] * w);
  const colOf = (M, j) => [M[j * 4], M[j * 4 + 1], M[j * 4 + 2]];
  function inv4(m) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    const d = 1 / det;
    return [(a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
      (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
      (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
      (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d];
  }
  // An object's turn: yaw about Y, then pitch about X, then roll about Z (Blender's gimbal axes).
  const rotOf = P => mul4(mul4(RY(((P.yaw || 0) + (P.heading || 0)) * rad), RX((P.pitch || 0) * rad)), RZ((P.roll || 0) * rad));
  // An object's model matrix: pos is the bottom middle of its box (when upright); it turns, sizes and stretches about
  // the middle of its box.
  function matOf(o, P = poseAt(o, s.t)) {
    const lo = o.mesh.lo, hi = o.mesh.hi, st = o.stretch || [1, 1, 1];
    const pv = o.mesh.pivot, c = [pv ? pv[0] : (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, pv ? pv[2] : (lo[2] + hi[2]) / 2], hc = (hi[1] - lo[1]) / 2 * st[1] * P.scale;
    return mul4(mul4(mul4(mul4(T(P.pos[0], P.pos[1] + hc, P.pos[2]), rotOf(P)), S(P.scale)), SV(st)), T(-c[0], -c[1], -c[2]));
  }
  const boxCorners = (o, M = matOf(o)) => { const lo = o.mesh.lo, hi = o.mesh.hi, c = []; for (let k = 0; k < 8; k++) c.push(xf(M, [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]], 1)); return c; };

  /* ---------------------------------------------------------------- the background: rebuilt from UV and depth */
  function rebuildBackground(p, W, H) {
    const P = p.pos, UV = p.uv, n = P.length / 3;
    // field of view: u = cx + sx * (x / depth) over all vertices (least squares); tan(hfov / 2) = cx / sx
    let su = 0, sr = 0, srr = 0, sur = 0;
    for (let i = 0; i < n; i++) { const d = -P[i * 3 + 2]; if (d <= 0) continue; const r = P[i * 3] / d, u = UV[i * 2]; su += u; sr += r; srr += r * r; sur += u * r; }
    const sx = (n * sur - sr * su) / (n * srr - sr * sr), cx = (su - sx * sr) / n;
    let t = cx / sx;
    if (!isFinite(t) || t <= 0.05 || t > 6) t = Math.tan(30 * rad);  // no usable camera: ~60° wide
    const tv = t * H / W;
    const out = new Float32Array(P.length), depths = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = Math.max(1e-6, -P[i * 3 + 2]), u = UV[i * 2], v = UV[i * 2 + 1];
      out[i * 3] = (u - 0.5) * 2 * t * d; out[i * 3 + 1] = -(v - 0.5) * 2 * tv * d; out[i * 3 + 2] = -d;
      depths[i] = d;
    }
    p.pos = out;
    // a coarse UV grid -> nearest vertex, for "what's at this point of the picture"
    const gw = 160, gh = Math.max(1, Math.round(gw * H / W)), grid = new Int32Array(gw * gh).fill(-1);
    for (let i = 0; i < n; i++) { const gx = Math.min(gw - 1, Math.round(UV[i * 2] * (gw - 1))), gy = Math.min(gh - 1, Math.round(UV[i * 2 + 1] * (gh - 1))); grid[gy * gw + gx] = i; }
    const sorted = Float32Array.from(depths).sort();
    return { t, tv, aspect: W / H, dmed: sorted[Math.floor(sorted.length / 2)] || 1, pos: out, uv: UV.slice(), gw, gh, grid };
  }
  // The background point seen at picture point (u, v) in 0..1, searching outwards for the nearest vertex.
  function pointAt(bg, u, v) {
    if (bg.empty) {  // the floor along the camera's ray (the camera looks straight ahead from the origin)
      const d = [(u - 0.5) * 2 * bg.t, -(v - 0.5) * 2 * bg.tv, -1];
      if (d[1] >= -1e-3) return [0, bg.floor, -bg.dmed];
      return mulv(d, Math.min(bg.floor / d[1], 60));
    }
    const gx = Math.round(Math.max(0, Math.min(1, u)) * (bg.gw - 1)), gy = Math.round(Math.max(0, Math.min(1, v)) * (bg.gh - 1));
    for (let r = 0; r < 24; r++) {
      let best = -1, bd = Infinity;
      for (let y = gy - r; y <= gy + r; y++) for (let x = gx - r; x <= gx + r; x++) {
        if (x < 0 || y < 0 || x >= bg.gw || y >= bg.gh) continue;
        const i = bg.grid[y * bg.gw + x]; if (i < 0) continue;
        const du = bg.uv[i * 2] - u, dv = bg.uv[i * 2 + 1] - v, dd = du * du + dv * dv;
        if (dd < bd) { bd = dd; best = i; }
      }
      if (best >= 0) return [bg.pos[best * 3], bg.pos[best * 3 + 1], bg.pos[best * 3 + 2]];
    }
    return [0, 0, -bg.dmed];
  }

  // Where an object's mask is in the picture: box and foot, in 0..1.
  async function maskInfo(ref) {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't read the object's mask")); i.src = `/api/media/file?path=${encodeURIComponent(ref)}`; });
    const k = Math.min(1, 512 / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    // the foot: the middle of the mask's lowest few rows
    let sx = 0, cnt = 0;
    const band = Math.max(1, Math.round((y1 - y0) * 0.04));
    for (let y = y1 - band; y <= y1; y++) for (let x = x0; x <= x1; x++) if (d[(y * w + x) * 4] > 127) { sx += x; cnt++; }
    return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, foot: [(sx / Math.max(1, cnt) + 0.5) / w, (y1 + 1) / h] };
  }

  // Stand an object where its mask is (or, without one, in the middle of the view).
  // The pose that stands an object where its mask is (or, without one, in the middle of the view).
  async function placement(o) {
    const bg = s.bg, m = o.mesh, hgt = Math.max(1e-6, m.hi[1] - m.lo[1]), dep = (m.hi[2] - m.lo[2]);
    if (bg.empty && !o.mask) {  // a model's longest side is 1 unit: 1 m, on the floor in front, beside the others
      const n = s.objs.filter(x => x !== o && x.pos).length, side = n % 2 ? 1 : -1;
      const scale = o.prim ? 1 : 1 / Math.max(1e-6, hgt, m.hi[0] - m.lo[0], dep);
      return { pos: [n ? side * Math.ceil(n / 2) * 1.2 : 0, bg.floor, -3.5], yaw: 0, scale };
    }
    let info = null;
    if (o.mask) { try { info = await maskInfo(o.mask); } catch { info = null; } }
    const footUV = info ? [info.foot[0], Math.min(1, info.foot[1] + 0.012)] : [0.5, 0.8];
    const G0 = pointAt(bg, ...footUV), d = Math.max(1e-6, -G0[2]);
    const hPic = info ? (info.y1 - info.y0) : 0.3;
    // sized to fit the object's box in the picture: its height, and its width too (a model that came out flatter or
    // wider than the object would otherwise be blown up by its height alone)
    const wPic = info ? (info.x1 - info.x0) : 0.3, wid = Math.max(1e-6, m.hi[0] - m.lo[0]);
    const scale = Math.min((hPic * 2 * bg.tv * d) / hgt, (wPic * 2 * bg.t * d) / wid);
    // the model's front faces +Z (the camera); push it back so its front edge stands at the foot
    const back = norm([G0[0], 0, G0[2]]);
    return { pos: addv(G0, mulv(back, dep * scale / 2)), yaw: 0, scale };
  }
  async function place(o) { const p = await placement(o); Object.assign(o, p, { auto_scale: p.scale }); }

  /* ---------------------------------------------------------------- loading models */
  async function refreshModels() { try { models = (await api("/api/models3d")).models || []; } catch { /* keep the old list */ } }
  const meshCache = new Map();
  async function meshOf(model) {
    if (meshCache.has(model.id)) return meshCache.get(model.id);
    const pr = (async () => {
      const prims = await G().parseGLB(await (await fetch(model.glb_url)).arrayBuffer());
      const mesh = s.gpu.upload(prims);
      mesh.anchor = [(mesh.lo[0] + mesh.hi[0]) / 2, mesh.lo[1], (mesh.lo[2] + mesh.hi[2]) / 2];
      return mesh;
    })();
    meshCache.set(model.id, pr);
    try { return await pr; } catch (e) { meshCache.delete(model.id); throw e; }
  }
  async function loadObjects() {
    await refreshModels();
    for (const o of s.objs) {
      if (o.prim) {
        if (!o.mesh) { o.mesh = primMesh(o); o.state = "ok"; }
        if (!o.pos || !o.scale) { await place(o); save(); }
        s.dirty = true; continue;
      }
      if (o.mesh || !o.model) continue;
      const md = models.find(x => x.id === o.model);
      if (!md) { o.state = "missing"; continue; }
      if (md.status !== "done") { o.state = md.status; continue; }
      try {
        o.mesh = await meshOf(md); o.state = "ok";
        if (!o.pos || !o.scale) { await place(o); save(); }
      } catch (e) { o.state = "failed"; o.err = e.message; }
      s.dirty = true;
    }
    renderSide();
    clearTimeout(s.poll);
    if (s.objs.some(o => o.state === "running")) s.poll = setTimeout(() => s && loadObjects(), 4000);
  }

  /* ---------------------------------------------------------------- primitive shapes */
  const PRIMS = {
    cube: { label: "Cube", icon: "▢", dims: [1, 1, 1] },
    sphere: { label: "Sphere", icon: "◯", dims: [1, 1, 1] },
    cylinder: { label: "Cylinder", icon: "⌭", dims: [0.6, 1.2, 0.6] },
    cone: { label: "Cone", icon: "△", dims: [0.8, 1.2, 0.8] },
    plane: { label: "Plane", icon: "▱", dims: [2, 0, 2] },
    torus: { label: "Ring", icon: "◎", dims: [1, 0.3, 1] },
    // a standing person (a mannequin) facing the camera (+Z), 1.74 m tall: a stand-in for someone in a photo or video
    figure: { label: "Person", icon: "🧍", dims: [0.67, 1.74, 0.29] },
  };
  const PRIM_COLOR = "#c9c4ba";
  /* The Person's poses: for each side (R, L), the direction of the upper arm and forearm, and of the thigh and shin
     ("back": the foot lies behind, as when kneeling). x points out from the body, y up, z forward. `says` is how the
     photo and video models are told about it. */
  const POSES = {
    standing: { label: "Standing", says: "", arms: { R: [[0.12, -1, 0], [0.08, -1, 0.08]], L: [[0.12, -1, 0], [0.08, -1, 0.08]] },
      legs: { R: [[0.02, -1, 0.02], [0, -1, -0.02]], L: [[0.02, -1, 0.02], [0, -1, -0.02]] } },
    walking: { label: "Walking", says: "walking",
      arms: { R: [[0.08, -1, 0.35], [0.05, -0.8, 0.6]], L: [[0.08, -1, -0.35], [0.05, -1, 0.1]] },
      legs: { R: [[0.02, -1, -0.3], [0, -1, -0.45]], L: [[0.02, -1, 0.4], [0, -1, 0.05]] } },
    running: { label: "Running", says: "running",
      arms: { R: [[0.1, -0.6, 0.8], [0, 0.8, 0.6]], L: [[0.1, -0.7, -0.7], [0, -0.9, 0.4]] },
      legs: { R: [[0.03, -1, -0.35], [0, -0.3, -1]], L: [[0.03, -0.6, 0.8], [0, -1, 0.05]] } },
    sitting: { label: "Sitting", says: "sitting", arms: { R: [[0.1, -1, 0.25], [0.05, -0.25, 1]], L: [[0.1, -1, 0.25], [0.05, -0.25, 1]] },
      legs: { R: [[0.06, 0, 1], [0, -1, 0.05]], L: [[0.06, 0, 1], [0, -1, 0.05]] } },
    kneeling: { label: "Kneeling", says: "kneeling", legs: { R: [[0.03, -1, 0.15], [0, -0.1, -1], "back"], L: [[0.03, -1, 0.15], [0, -0.1, -1], "back"] } },
    waving: { label: "Waving", says: "waving with the right hand", arms: { R: [[1, 0.25, 0.1], [0.1, 1, 0.15]], L: [[0.12, -1, 0], [0.08, -1, 0.08]] } },
    pointing: { label: "Pointing", says: "pointing ahead with the right arm", arms: { R: [[0.12, 0.05, 1], [0.1, 0.05, 1]], L: [[0.12, -1, 0], [0.08, -1, 0.08]] } },
    arms_up: { label: "Arms raised", says: "with both arms raised", arms: { R: [[0.35, 1, 0.05], [0.15, 1, 0]], L: [[0.35, 1, 0.05], [0.15, 1, 0]] } },
    hips: { label: "Hands on hips", says: "with hands on hips", arms: { R: [[0.75, -0.65, -0.15], [-0.75, -0.45, 0.25]], L: [[0.75, -0.65, -0.15], [-0.75, -0.45, 0.25]] } },
    tpose: { label: "T-pose", says: "with arms out to the sides", arms: { R: [[1, 0, 0], [1, 0, 0]], L: [[1, 0, 0], [1, 0, 0]] } },
  };
  // A shape's own size (its box before stretching), e.g. a Person sitting is shorter and deeper than standing.
  const NAT = new Map();
  function natDims(kind, pose) {
    const id = `${kind}|${pose}`;
    if (NAT.has(id)) return NAT.get(id).slice();
    const { P } = shapeOf(kind, pose), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], P[i + c]); hi[c] = Math.max(hi[c], P[i + c]); }
    const d = [0, 1, 2].map(c => +(hi[c] - lo[c]).toFixed(3));
    NAT.set(id, d);
    return d.slice();
  }
  /* Poses in motion: a Person's keys can carry a pose; between two of them the arms and legs blend (each bone's
     direction, eased in and out), and the person's mesh is rebuilt for the frame (kept in a small cache). */
  function fullPose(name) {
    const p = POSES[name] || POSES.standing, st = POSES.standing, a = p.arms || st.arms, l = p.legs || st.legs;
    return { arms: { R: a.R, L: a.L }, legs: { R: l.R, L: l.L } };
  }
  function blendPose(na, nb, u) { return mixPose(fullPose(na), fullPose(nb), u); }
  function mixPose(A, B, u) {
    const out = { arms: {}, legs: {} };
    for (const g of ["arms", "legs"]) for (const side of ["R", "L"]) {
      const x = A[g][side], y = B[g][side];
      out[g][side] = [0, 1].map(i => { const p = norm(x[i]), q = norm(y[i]); return norm([0, 1, 2].map(c => p[c] + (q[c] - p[c]) * u)); });
      const flag = u < 0.5 ? x[2] : y[2]; if (flag) out[g][side].push(flag);
    }
    return out;
  }
  // A Person's pose at time t: { name } on or past a key, or { a, b, u } between two keys with different poses.
  function postureAt(o, t) {
    const K = (o.keys || []).filter(k => k.pose);
    if (!K.length) return { name: o.pose || "standing" };
    if (t <= K[0].t) return { name: K[0].pose };
    if (t >= K.at(-1).t) return { name: K.at(-1).pose };
    let i = 0; while (K[i + 1].t < t) i++;
    const a = K[i], b = K[i + 1];
    if (a.pose === b.pose) return { name: a.pose };
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return { a: a.pose, b: b.pose, u: u * u * (3 - 2 * u) };
  }
  const postureName = ps => ps.name || (ps.u < 0.5 ? ps.a : ps.b);
  /* Walk cycle: while a Person moves along its path, its legs and arms swing in a gait whose phase follows the distance
     it has covered (one cycle, two steps, is about 0.8 of its height walking, 1.45 running), so its feet keep pace;
     when it stops it eases back into its keyed pose. In each side's bones the angle is forward from straight down. */
  const GAITS = {
    walk: { label: "Walk", says: "walking", stride: 0.8, hip: 24, knee: [6, 38], arm: 0.75, elbow: 18 },
    run: { label: "Run", says: "running", stride: 1.45, hip: 40, knee: [18, 85], arm: 1.1, elbow: 80 },
  };
  const fwd = (deg, out = 0.03) => { const r = deg * rad; return [out, -Math.cos(r), Math.sin(r)]; };
  function gaitPose(kind, phase) {
    const g = GAITS[kind], side = ph => {
      const a = 2 * Math.PI * ph, hip = g.hip * Math.sin(a);
      // the knee bends most as the leg swings forward, and a little as the foot takes the weight
      const knee = g.knee[0] + (g.knee[1] - g.knee[0]) * Math.max(0, Math.sin(a + 1.1)) ** 1.5;
      const arm = -hip * g.arm;  // the arm swings against its own side's leg
      return { leg: [fwd(hip), fwd(hip - knee, 0)], arm: [fwd(arm, 0.1), fwd(arm + g.elbow, 0.06)] };
    };
    const R = side(phase), L = side(phase + 0.5);
    return { arms: { R: R.arm, L: L.arm }, legs: { R: R.leg, L: L.leg } };
  }
  // How far an object has moved along its path by time t (scene units), sampled at 48 steps a second.
  function travelled(o, t) {
    const K = o.keys || []; if (K.length < 2 || t <= K[0].t) return 0;
    let d = 0, prev = poseAt(o, K[0].t).pos;
    const end = Math.min(t, K.at(-1).t), n = Math.max(1, Math.ceil((end - K[0].t) * 48));
    for (let i = 1; i <= n; i++) { const p = poseAt(o, K[0].t + (end - K[0].t) * i / n).pos; d += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); prev = p; }
    return d;
  }
  // The person's height in the scene (its stretch and size included), for the stride and for what counts as moving.
  const figHeight = (o, P = poseAt(o, s.t)) => (o.dims?.[1] || 1.74) * (o.stretch?.[1] || 1) * (P.scale || 1);
  // The gait at time t: { pose, w } with w = how much of it shows (0 standing still, 1 moving at a walk), or null.
  function gaitAt(o, t) {
    const g = GAITS[o.gait]; if (!g || !(o.keys?.length > 1)) return null;
    const H = figHeight(o, poseAt(o, t)), h = 1 / 48, d = travelled(o, t);
    const speed = (travelled(o, t + h) - travelled(o, Math.max(0, t - h))) / (t - Math.max(0, t - h) + h);
    const w = Math.max(0, Math.min(1, speed / (0.25 * H)));
    if (w < 0.02) return null;
    return { phase: (d / (g.stride * H)) % 1, w };
  }
  // The mesh a Person shows at time t (swapped in before drawing); others keep theirs.
  function figureMesh(o, t) {
    if (o.prim !== "figure" || !((o.keys || []).some(k => k.pose) || (o.gait && o.keys?.length > 1))) return;
    const ps = postureAt(o, t), q = ps.name ? null : Math.round(ps.u * 48) / 48, ga = gaitAt(o, t);
    const gq = ga ? [Math.round(ga.phase * 40) / 40, Math.round(ga.w * 10) / 10] : null;
    const id = `${o.pose}|${o.dims}|${o.tilt}|${ps.name || `${ps.a}>${ps.b}@${q}`}${gq ? `|${o.gait}@${gq}` : ""}`;
    if (o._pmKey === id && o.mesh) return;
    o._pm ||= new Map();
    let m = o._pm.get(id);
    if (!m) {
      const base = ps.name ? fullPose(ps.name) : blendPose(ps.a, ps.b, q);
      m = primMesh(o, gq ? mixPose(base, gaitPose(o.gait, gq[0]), gq[1]) : base);
      o._pm.set(id, m);
      for (const [k, old] of o._pm) { if (o._pm.size <= 64) break; if (old !== o.mesh) s.gpu.drop?.(old); o._pm.delete(k); }
    }
    m.parts[0].base = [...hexRgb(o.color || PRIM_COLOR), 1];
    o.mesh = m; o._pmKey = id;
  }
  // A shape's triangles about the origin: positions, normals, indices.
  function shapeOf(kind, pose = "standing") {
    const P = [], N = [], I = [], SEG = 40;
    const v = (p, n) => { P.push(...p); N.push(...n); return P.length / 3 - 1; };
    if (kind === "cube" || kind === "plane") {
      const faces = kind === "plane" ? [[1, 1]] : [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
      for (const [ax, sg] of faces) {
        const n = [0, 0, 0], u = [0, 0, 0], w = [0, 0, 0]; n[ax] = sg; u[(ax + 1) % 3] = 1; w[(ax + 2) % 3] = 1;
        const c = kind === "plane" ? [0, 0, 0] : n.map(x => x * 0.5), pt = (a, b) => c.map((x, j) => x + (u[j] * a + w[j] * b) * 0.5);
        const i = v(pt(-1, -1), n); v(pt(1, -1), n); v(pt(1, 1), n); v(pt(-1, 1), n);
        I.push(i, i + 1, i + 2, i, i + 2, i + 3);
      }
    } else if (kind === "sphere") {
      const R = 20;
      for (let i = 0; i <= R; i++) for (let j = 0; j <= SEG; j++) {
        const th = i / R * Math.PI, ph = j / SEG * 2 * Math.PI, n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
        v(n.map(x => x * 0.5), n);
      }
      for (let i = 0; i < R; i++) for (let j = 0; j < SEG; j++) { const a = i * (SEG + 1) + j, b = a + SEG + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    } else if (kind === "cylinder" || kind === "cone") {
      const rt = kind === "cone" ? 0 : 0.5, b0 = P.length / 3;
      for (let j = 0; j <= SEG; j++) {
        const ph = j / SEG * 2 * Math.PI, c = Math.cos(ph), sn = Math.sin(ph), n = norm([c, 0.5 - rt, sn]);
        v([c * 0.5, -0.5, sn * 0.5], n); v([c * rt, 0.5, sn * rt], n);
      }
      for (let j = 0; j < SEG; j++) { const a = b0 + j * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const cap = (y, r, ny) => {
        const c0 = v([0, y, 0], [0, ny, 0]);
        for (let j = 0; j <= SEG; j++) { const ph = j / SEG * 2 * Math.PI; v([Math.cos(ph) * r, y, Math.sin(ph) * r], [0, ny, 0]); }
        for (let j = 0; j < SEG; j++) I.push(c0, c0 + 1 + j, c0 + 2 + j);
      };
      cap(-0.5, 0.5, -1); if (rt) cap(0.5, rt, 1);
    } else if (kind === "figure") {
      // A mannequin of rounded parts, in metres from the feet up, facing +Z (the small nose shows which way).
      const ell = (c, r, R = 12, S = 18) => {  // an ellipsoid: centre, radii
        const b = P.length / 3;
        for (let i = 0; i <= R; i++) for (let j = 0; j <= S; j++) {
          const th = i / R * Math.PI, ph = j / S * 2 * Math.PI, u = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
          v([c[0] + u[0] * r[0], c[1] + u[1] * r[1], c[2] + u[2] * r[2]], norm([u[0] / r[0], u[1] / r[1], u[2] / r[2]]));
        }
        for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) { const a = b + i * (S + 1) + j, d = a + S + 1; I.push(a, d, a + 1, a + 1, d, d + 1); }
      };
      const limb = (a, b, r, rb = r) => {  // a rounded limb from a to b (radius r at a, rb at b)
        const S = 16, d = norm(sub(b, a)), u = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), w = cross(d, u), b0 = P.length / 3;
        for (let j = 0; j <= S; j++) {
          const ph = j / S * 2 * Math.PI, n = addv(mulv(u, Math.cos(ph)), mulv(w, Math.sin(ph)));
          v(addv(a, mulv(n, r)), n); v(addv(b, mulv(n, rb)), n);
        }
        for (let j = 0; j < S; j++) { const k = b0 + j * 2; I.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
        ell(a, [r, r, r], 8, 16); ell(b, [rb, rb, rb], 8, 16);
      };
      ell([0, 1.62, 0], [0.095, 0.12, 0.105]);                  // head
      ell([0, 1.605, 0.1], [0.022, 0.03, 0.03], 6, 10);          // nose
      limb([0, 1.44, 0], [0, 1.53, 0], 0.05);                    // neck
      ell([0, 1.3, 0], [0.2, 0.17, 0.12]);                       // chest
      ell([0, 1.1, 0], [0.15, 0.14, 0.1]);                       // waist
      ell([0, 0.94, 0], [0.17, 0.1, 0.11]);                      // hips
      // Arms and legs follow the pose: a direction for each bone, x pointing out from the body. The person faces +Z,
      // so their right side is -X and their left +X.
      const P0 = pose && typeof pose === "object" ? pose : POSES[pose] || POSES.standing;
      for (const [side, sx] of [["R", -1], ["L", 1]]) {
        const bone = d => norm([d[0] * sx, d[1], d[2]]);
        const arm = P0.arms?.[side] || POSES.standing.arms.R, leg = P0.legs?.[side] || POSES.standing.legs.R;
        const sh = [sx * 0.2, 1.41, 0], el = addv(sh, mulv(bone(arm[0]), 0.29)), wr = addv(el, mulv(bone(arm[1]), 0.27));
        limb(sh, el, 0.052, 0.045); limb(el, wr, 0.043, 0.035);  // upper arm, forearm
        ell(addv(wr, mulv(bone(arm[1]), 0.055)), [0.042, 0.055, 0.042], 8, 12);  // hand
        const hp = [sx * 0.09, 0.9, 0], kn = addv(hp, mulv(bone(leg[0]), 0.41)), an = addv(kn, mulv(bone(leg[1]), 0.41));
        limb(hp, kn, 0.078, 0.058); limb(kn, an, 0.056, 0.042);  // thigh, shin
        ell(addv(an, leg[2] === "back" ? [0, -0.01, -0.07] : [0, -0.035, 0.06]), [0.05, 0.04, 0.11], 8, 12);  // foot
      }
    } else {  // torus (a ring lying flat)
      const R = 0.35, r = 0.15, M = 20;
      for (let i = 0; i <= SEG; i++) for (let j = 0; j <= M; j++) {
        const a = i / SEG * 2 * Math.PI, b = j / M * 2 * Math.PI, n = [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)];
        v([(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (R + r * Math.cos(b)) * Math.sin(a)], n);
      }
      for (let i = 0; i < SEG; i++) for (let j = 0; j < M; j++) { const a = i * (M + 1) + j, b = a + M + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    }
    return { P, N, I };
  }
  // A primitive object's mesh: its shape stretched to its size (dims), tilted, in its colour; the anchor is the bottom
  // middle of its box, as for a model.
  function primMesh(o, posture = null) {
    const fig = o.prim === "figure", { P, N, I } = shapeOf(o.prim, posture || o.pose), n = P.length / 3, dims = o.dims || PRIMS[o.prim].dims;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], P[i * 3 + c]); hi[c] = Math.max(hi[c], P[i * 3 + c]); }
    // A Person: the size fields are its base pose's box, so a blended or keyed pose keeps the same scale (not stretched to
    // fill that box), and it's drawn about its own pelvis line (x = z = 0) rather than its box's middle.
    if (fig) { const nd = natDims("figure", o.pose || "standing"); for (let c = 0; c < 3; c++) { if (c !== 1) { lo[c] = -nd[c] / 2; hi[c] = nd[c] / 2; } else hi[c] = lo[c] + nd[c]; } }
    const k = [0, 1, 2].map(c => hi[c] - lo[c] > 1e-9 ? Math.max(0.01, dims[c]) / (hi[c] - lo[c]) : 1);
    const [ax, az] = (o.tilt || [0, 0]).map(x => x * rad), cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
    const turn = q => { const y1 = q[1] * cx - q[2] * sx, z1 = q[1] * sx + q[2] * cx; return [q[0] * cz - y1 * sz, q[0] * sz + y1 * cz, z1]; };
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), mid = fig ? [0, (lo[1] + hi[1]) / 2, 0] : [0, 1, 2].map(c => (lo[c] + hi[c]) / 2);
    for (let i = 0; i < n; i++) {
      const p = turn([0, 1, 2].map(c => (P[i * 3 + c] - mid[c]) * k[c]));
      const q = turn(norm([0, 1, 2].map(c => N[i * 3 + c] / k[c])));
      pos.set(p, i * 3); nrm.set(q, i * 3);
    }
    const mesh = s.gpu.upload([{ pos, nrm, uv: null, col: null, idx: new Uint32Array(I), base: [...hexRgb(o.color || PRIM_COLOR), 1], tex: null, ao: null }]);
    mesh.anchor = [(mesh.lo[0] + mesh.hi[0]) / 2, mesh.lo[1], (mesh.lo[2] + mesh.hi[2]) / 2];
    if (fig) { const pv = turn([0, 0, 0]); mesh.pivot = pv; mesh.anchor = [pv[0], mesh.lo[1], pv[2]]; }
    return mesh;
  }
  // Add a shape: in an empty scene at its real size in front of the camera (or at `at`); in a picture, where the
  // background is in the middle of the view, a third of the picture tall.
  async function addPrim(kind, at = null) {
    if (!s?.bg || !PRIMS[kind]) return;
    const d = PRIMS[kind], n = s.objs.filter(o => o.prim === kind).length;
    const o = { id: uid(), name: n ? `${d.label} ${n + 1}` : d.label, model: null, mask: null, prim: kind, color: PRIM_COLOR,
      dims: kind === "figure" ? natDims("figure", "standing") : d.dims.slice(), tilt: [0, 0], pos: null, yaw: 0, scale: null, keys: [],
      ...(kind === "figure" ? { pose: "standing" } : {}) };
    o.mesh = primMesh(o); o.state = "ok";
    s.objs.push(o); s.sel = s.objs.length - 1;
    await place(o);
    if (at) o.pos = at.slice();
    save(); renderSide(); s.dirty = true;
  }
  // Where a ray first meets the background: the floor of an empty scene, or the picture's depth surface (marched:
  // a point is behind the surface once it's deeper than what the picture's camera sees in its direction).
  function surfaceHit(ray) {
    const bg = s.bg;
    if (bg.empty) {
      if (ray.d[1] > -1e-4) return null;
      const t = (bg.floor - ray.o[1]) / ray.d[1];
      return t > 0 && t < 80 ? addv(ray.o, mulv(ray.d, t)) : null;
    }
    const t0 = bg.dmed * 0.002, t1 = bg.dmed * 12, N = 400;
    for (let i = 0; i <= N; i++) {
      const p = addv(ray.o, mulv(ray.d, t0 * Math.pow(t1 / t0, i / N))), d = -p[2];
      if (d <= 1e-6) continue;
      const u = 0.5 + p[0] / d / (2 * bg.t), v = 0.5 - p[1] / d / (2 * bg.tv);
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const q = pointAt(bg, u, v);
      if (d >= -q[2]) return q;
    }
    return null;
  }

  /* ---------------------------------------------------------------- the gizmo (as in Blender) */
  const AXC = [[0.94, 0.27, 0.33], [0.45, 0.8, 0.2], [0.27, 0.55, 0.98]], HOT = [1, 0.84, 0.3];
  const ALIGN = [RZ(-Math.PI / 2), ID, RX(Math.PI / 2)];  // turns +Y onto X, Y, Z
  // Handle meshes, along +Y with length 1 (drawn scaled to a constant size on screen).
  function gizmoMeshes() {
    if (s.giz) return s.giz;
    const geom = parts => {
      const pos = [], nrm = [], idx = [];
      for (const [kind, dims, off] of parts) {
        const { P, N, I } = kind === "ring" ? ringGeom() : shapeOf(kind), b = pos.length / 3;
        for (let i = 0; i < P.length; i += 3) { pos.push(P[i] * dims[0] + off[0], P[i + 1] * dims[1] + off[1], P[i + 2] * dims[2] + off[2]); nrm.push(N[i], N[i + 1], N[i + 2]); }
        idx.push(...I.map(x => x + b));
      }
      return s.gpu.upload([{ pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: null, col: null, idx: new Uint32Array(idx), base: [1, 1, 1, 1], tex: null, ao: null }]);
    };
    s.giz = {
      move: geom([["cylinder", [0.035, 0.78, 0.035], [0, 0.39, 0]], ["cone", [0.13, 0.24, 0.13], [0, 0.88, 0]]]),
      scale: geom([["cylinder", [0.035, 0.84, 0.035], [0, 0.42, 0]], ["cube", [0.13, 0.13, 0.13], [0, 0.9, 0]]]),
      rot: geom([["ring", [1, 1, 1], [0, 0, 0]]]),
      uni: geom([["sphere", [0.16, 0.16, 0.16], [0, 0, 0]]]),
    };
    return s.giz;
  }
  function ringGeom() {  // a thin ring of radius 1 about Y
    const P = [], N = [], I = [], A = 72, B = 8, r = 0.018;
    for (let i = 0; i <= A; i++) for (let j = 0; j <= B; j++) {
      const a = i / A * 2 * Math.PI, b = j / B * 2 * Math.PI, n = [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)];
      P.push((1 + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (1 + r * Math.cos(b)) * Math.sin(a)); N.push(...n);
    }
    for (let i = 0; i < A; i++) for (let j = 0; j < B; j++) { const a = i * (B + 1) + j, b = a + B + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    return { P, N, I };
  }
  // The selected object's gizmo for a tool: its middle, size and handles ({ kind, i, axis, A: turns +Y onto the axis }).
  function gizmoOf(o, mode = s.tool) {
    if (!o?.mesh || !o.pos || o.hidden || s.playing || !s.bg) return null;
    const P = poseAt(o, s.t), M = matOf(o, P), lo = o.mesh.lo, hi = o.mesh.hi;
    const c = xf(M, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], 1);
    const H = s.cv.clientHeight || 1, L = Math.hypot(...sub(c, eye())) * 2 * tanY(s.cv.clientWidth, H) * 80 / H;
    const Ry = RY(((P.yaw || 0) + (P.heading || 0)) * rad), Rx = mul4(Ry, RX((P.pitch || 0) * rad)), R = rotOf(P), hs = [];
    if (mode === "move" || mode === "lift") for (const i of mode === "lift" ? [1] : [0, 1, 2]) hs.push({ kind: "move", i, axis: colOf(ALIGN[i], 1), A: ALIGN[i] });
    if (mode === "rotate") hs.push({ kind: "rot", i: 0, axis: colOf(Ry, 0), A: mul4(Ry, ALIGN[0]) }, { kind: "rot", i: 1, axis: [0, 1, 0], A: ID },
      { kind: "rot", i: 2, axis: colOf(Rx, 2), A: mul4(Rx, ALIGN[2]) });
    if (mode === "scale") { for (const i of [0, 1, 2]) hs.push({ kind: "scale", i, axis: norm(colOf(R, i)), A: mul4(R, ALIGN[i]) }); hs.push({ kind: "uni", i: -1, axis: null, A: ID }); }
    return { c, L, P, hs };
  }
  /* The shot camera as an object (a scene mapped to a shot on the Shots step, or ticked in Camera): seen from outside
     as a frame with a body, it has its own gimbal: X, Y and Z arrows move it, and two rings pan it (about Y) and tilt
     it (about its own sideways axis). A change keys it at the playhead (its first change makes its first key). */
  const CAM = { name: "Shot camera", isCam: true };
  const camShown = () => !!(s?.camObj && s.bg && (s.camFree || camDiff(s.cam, camBase(s.t)) > 1e-3));
  const dirOf = c => eyeOf({ ...c, dist: 1, target: [0, 0, 0] });
  function camGizmo() {
    if (!s.camSel || !camShown() || s.playing) return null;
    const c = camBase(s.t), E = eyeOf(c), H = s.cv.clientHeight || 1;
    const L = Math.hypot(...sub(E, eye())) * 2 * tanY(s.cv.clientWidth, H) * 80 / H, Ry = RY(c.yaw * rad), K = S(1.35);
    const hs = [0, 1, 2].map(i => ({ kind: "move", i, axis: colOf(ALIGN[i], 1), A: ALIGN[i] }));
    hs.push({ kind: "rot", i: 1, axis: [0, 1, 0], A: K, f: "yaw" }, { kind: "rot", i: 0, axis: colOf(Ry, 0), A: mul4(mul4(Ry, ALIGN[0]), K), f: "pitch" });
    // roll: a smaller ring about the way it looks (its local Y is forward)
    const ax = axesOf({ ...c, roll: 0 }), Rf = [...ax.r, 0, ...ax.f, 0, ...ax.u, 0, 0, 0, 0, 1];
    hs.push({ kind: "rot", i: 2, axis: ax.f, A: mul4(Rf, S(0.75)), f: "roll" });
    return { c: E, L, P: camOf(c), hs };
  }
  const curGizmo = mode => s.camSel ? camGizmo() : gizmoOf(s.objs[s.sel], mode);
  // Set the shot camera at the playhead: its key there, or a new key.
  function editCam(c) {
    const q = { yaw: Math.round(c.yaw * 100) / 100, pitch: Math.max(-89, Math.min(89, Math.round(c.pitch * 100) / 100)), dist: c.dist, target: c.target.slice(),
      ...(c.lens ? { lens: Math.round(c.lens * 10) / 10 } : {}), ...(c.roll ? { roll: Math.round(c.roll * 100) / 100 } : {}), ...(c.focus ? { focus: Math.round(c.focus * 1000) / 1000 } : {}), ...(typeof c.shake === "number" ? { shake: Math.max(0, Math.min(100, Math.round(c.shake))) } : {}) };
    if (!q.roll) for (const k of s.camKeys) if (near(k.t, s.t)) delete k.roll;  // back to level
    const k = s.camKeys.find(x => near(x.t, s.t));
    if (k) Object.assign(k, q); else { s.camKeys.push({ t: s.t, ...q }); s.camKeys.sort((a, b) => a.t - b.t); }
    s.dirty = true;
  }
  // Turn the camera about its own eye: pan (yaw) and tilt (pitch).
  function turnCam(c, yaw, pitch) {
    const E = eyeOf(c), n = { ...c, yaw, pitch: Math.max(-89, Math.min(89, pitch)) };
    return { ...n, target: sub(E, mulv(dirOf(n), c.dist)) };
  }
  // A view from outside, behind and above the camera, looking at where it looks.
  function outsideView(c = camBase(s.t)) {
    const E = eyeOf(c), f = mulv(dirOf(c), -1), d = s.bg.dmed;
    return { yaw: c.yaw + 35, pitch: Math.max(-60, Math.min(70, c.pitch + 28)), dist: d * 1.3, target: addv(E, mulv(f, d * 0.35)) };
  }
  // Is the click on the drawn camera? (near its eye or its frame, on screen)
  function pickCam(px, py) {
    if (!camShown()) return false;
    const fr = camFrame(camForRender(s.t)), m = [px, py];
    const pts = fr.map(toScreen);
    for (let k = 0; k + 1 < pts.length; k += 2) if (pts[k] && pts[k + 1] && segDist(m, pts[k], pts[k + 1]) < 8) return true;
    const e0 = toScreen(eyeOf(camForRender(s.t)));
    return !!(e0 && Math.hypot(px - e0[0], py - e0[1]) < 14);
  }
  // The camera drawn as lines: its frame (what it sees, a little way out), a body behind the eye and an up mark.
  function camFrame(c) {
    const ce = eyeOf(c), { f, r, u } = axesOf(c), L = s.bg.dmed * 0.22;
    const at = (x, y, z) => addv(ce, addv(mulv(f, z * L), addv(mulv(r, x * L), mulv(u, y * L))));
    const fv = fovOf(c), corner = (x, y) => at(x * fv.t, y * fv.tv, 1);
    const cs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], out = [];
    for (let k = 0; k < 4; k++) out.push(ce, cs[k], cs[k], cs[(k + 1) % 4]);
    out.push(corner(-0.35, 1.08), corner(0, 1.4), corner(0, 1.4), corner(0.35, 1.08), corner(0.35, 1.08), corner(-0.35, 1.08));  // up
    const b = [[-0.22, -0.16], [0.22, -0.16], [0.22, 0.16], [-0.22, 0.16]];  // the body, a box behind the eye
    for (let k = 0; k < 4; k++) {
      const [x, y] = b[k], [x2, y2] = b[(k + 1) % 4];
      out.push(at(x, y, 0), at(x2, y2, 0), at(x, y, -0.45), at(x2, y2, -0.45), at(x, y, 0), at(x, y, -0.45));
    }
    return out;
  }
  const hkey = h => h && `${h.kind}${h.i}`;
  function drawGizmo(VP, e, key) {
    const g = curGizmo(); if (!g) return;
    const G = gizmoMeshes(), active = hkey(s.modal?.h || s.dragH?.h) || s.hover;
    s.gl.disable(s.gl.DEPTH_TEST);
    for (const h of g.hs) {
      const on = active === hkey(h);
      s.gpu.draw(G[h.kind], { VP, M: mul4(mul4(T(...g.c), h.A), S(g.L)), eye: e, key, solid: on ? HOT : h.i < 0 ? [0.92, 0.92, 0.92] : AXC[h.i] });
    }
    s.gl.enable(s.gl.DEPTH_TEST);
  }
  // A point in the view (CSS pixels), or null behind the camera.
  function toScreen(p) {
    const W = s.cv.clientWidth, H = s.cv.clientHeight, { VP } = viewProj(W, H), x = xf(VP, p, 1), w = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15];
    return w > 1e-6 ? [(x[0] / w + 1) / 2 * W, (1 - x[1] / w) / 2 * H] : null;
  }
  const segDist = (p, a, b) => { const v = [b[0] - a[0], b[1] - a[1]], l = v[0] * v[0] + v[1] * v[1] || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / l)); return Math.hypot(p[0] - a[0] - v[0] * t, p[1] - a[1] - v[1] * t); };
  // The handle under a point of the view.
  function handleAt(px, py, mode) {
    const g = curGizmo(mode); if (!g) return null;
    const m = [px, py], c0 = toScreen(g.c); if (!c0) return null;
    let best = null, bd = Infinity;
    for (const h of g.hs) {
      let d = Infinity;
      if (h.kind === "uni") d = Math.hypot(px - c0[0], py - c0[1]) - 4;
      else if (h.kind === "rot") {
        let prev = null;
        for (let k = 0; k <= 64; k++) { const a = k / 64 * 2 * Math.PI, q = toScreen(addv(g.c, mulv(xf(h.A, [Math.cos(a), 0, Math.sin(a)], 0), g.L))); if (q && prev) d = Math.min(d, segDist(m, prev, q)); prev = q; }
      } else { const tip = toScreen(addv(g.c, mulv(h.axis, g.L))); if (tip) d = segDist(m, c0, tip); }
      if (d < 9 && d < bd) { bd = d; best = h; }
    }
    return best && { ...best, g };
  }
  // Start dragging a handle (or, for a key's axis, following the mouse): what it was, and where the axis points on screen.
  function grabHandle(h, cx, cy, o = s.camSel ? CAM : s.objs[s.sel]) {
    const g = h.g || (o === CAM ? camGizmo() : gizmoOf(o)), c0 = toScreen(g.c), tip = h.axis ? toScreen(addv(g.c, mulv(h.axis, g.L))) : null;
    return { h, o, sx: cx, sy: cy, c0, sv: tip && c0 ? [tip[0] - c0[0], tip[1] - c0[1]] : [1, 0], L: g.L, P0: JSON.parse(JSON.stringify(g.P)), st0: (o.stretch || [1, 1, 1]).slice(),
      a0: null, turned: 0, toEye: h.axis ? Math.sign(dot3(h.axis, sub(eye(), g.c))) || 1 : 1,
      snap: o === CAM ? JSON.stringify(s.camKeys) : JSON.stringify({ pos: o.pos, yaw: o.yaw || 0, pitch: o.pitch || 0, roll: o.roll || 0, scale: o.scale, stretch: o.stretch || null, keys: o.keys || [] }) };
  }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function stepHandle(d, e, px, py) {
    const o = d.o, h = d.h, dx = e.clientX - d.sx, dy = e.clientY - d.sy, snap = e.ctrlKey || e.metaKey;
    const along = () => { const v = d.sv, l = v[0] * v[0] + v[1] * v[1]; return l < 4 ? 0 : (dx * v[0] + dy * v[1]) / l * d.L; };
    if (o === CAM) {  // the shot camera: move its eye, or pan / tilt about it
      const c0 = d.P0;
      if (h.kind === "move") {
        let a = along(); if (snap) { const st = s.bg.empty ? 0.1 : s.bg.dmed * 0.05; a = Math.round(a / st) * st; }
        editCam({ ...c0, target: addv(c0.target, mulv(h.axis, a)) });
      } else {
        const ang = Math.atan2(-(py - d.c0[1]), px - d.c0[0]);
        if (d.a0 != null) { let da = ang - d.a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; d.turned += da; }
        d.a0 = ang;
        let deg = d.turned * d.toEye / rad; if (snap) deg = Math.round(deg / 5) * 5;
        editCam(h.f === "roll" ? { ...c0, roll: Math.max(-180, Math.min(180, (c0.roll || 0) + deg)) }
          : h.f === "yaw" ? turnCam(c0, c0.yaw + deg, c0.pitch) : turnCam(c0, c0.yaw, c0.pitch - deg));
      }
      d.moved = true; s.dirty = true; return;
    }
    if (h.kind === "move") {
      let a = along(); if (snap) { const st = s.bg.empty ? 0.1 : s.bg.dmed * 0.05; a = Math.round(a / st) * st; }
      editPose(o, { pos: addv(d.P0.pos, mulv(h.axis, a)) });
    } else if (h.kind === "rot") {
      const ang = Math.atan2(-(py - d.c0[1]), px - d.c0[0]);
      if (d.a0 != null) { let da = ang - d.a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; d.turned += da; }
      d.a0 = ang;
      const f = ["pitch", "yaw", "roll"][h.i];
      let v = (d.P0[f] || 0) + d.turned * d.toEye / rad; if (snap) v = Math.round(v / 15) * 15;
      editPose(o, { [f]: Math.round(v * 10) / 10 });
    } else if (h.kind === "scale") {
      let k = Math.max(0.05, 1 + along() / d.L); if (snap) k = Math.max(0.1, Math.round(k * 10) / 10);
      const st = d.st0.slice(); st[h.i] = d.st0[h.i] * k; o.stretch = st;
    } else {
      let k = Math.exp((dx - dy) * 0.006); if (snap) k = Math.max(0.1, Math.round(k * 10) / 10);
      editPose(o, { scale: Math.max(1e-5, d.P0.scale * k) });
    }
    d.moved = true; s.dirty = true;
  }
  // A shape's stretch goes into its size (so the side panel shows it), once a drag ends.
  function settleStretch(o) {
    if (!o?.prim || !o.stretch || (o.tilt && (o.tilt[0] || o.tilt[1]))) return;
    const d = o.dims || PRIMS[o.prim].dims;
    o.dims = d.map((x, j) => o.prim === "plane" && j === 1 ? 0 : Math.max(0.01, Math.round(x * o.stretch[j] * 1000) / 1000));
    o.stretch = null; o.mesh = primMesh(o);
  }

  /* ---------------------------------------------------------------- object actions (tool bar, menu, keys) */
  const TOOLS = { move: "✥ Move", lift: "↕ Raise", rotate: "⟳ Rotate", scale: "⤢ Resize" };
  function changed(o) { save(); renderSide(); s.dirty = true; }
  function nudge(o, f) {
    if (!o?.mesh || !o.pos) return;
    const P = poseAt(o, s.t);
    editPose(o, f.yaw != null ? { yaw: P.yaw + f.yaw } : { scale: P.scale * f.k });
    changed(o);
  }
  // Set an object down on whatever is below it (the floor, or the picture's ground).
  function dropDown(o) {
    if (!o?.mesh || !o.pos) return;
    const P = poseAt(o, s.t), up = s.bg.empty ? 0.01 : s.bg.dmed * 0.01, low = Math.min(...boxCorners(o).map(c => c[1]));
    const hit = surfaceHit({ o: [P.pos[0], low + up, P.pos[2]], d: [0, -1, 0] });
    if (!hit) return Media.toast("There's no ground under it.");
    editPose(o, { pos: [P.pos[0], P.pos[1] + hit[1] - low, P.pos[2]] }); changed(o);
  }
  function duplicate(o) {
    if (!o?.mesh || !o.pos) return;
    const P = poseAt(o, s.t), w = (o.mesh.hi[0] - o.mesh.lo[0]) * P.scale * 1.2 || 1, y = s.cam.yaw * rad;
    const off = [Math.cos(y) * w, 0, -Math.sin(y) * w], move = p => addv(p, off);
    const c = { id: uid(), name: `${o.name} copy`, becomes: o.becomes || "", picture: o.picture || null, model: o.model, mask: o.mask, prim: o.prim, ...(o.pose ? { pose: o.pose } : {}), ...(o.gait ? { gait: o.gait } : {}), color: o.color, dims: o.dims?.slice(), tilt: o.tilt?.slice(),
      pos: move(o.pos), yaw: o.yaw || 0, pitch: o.pitch || 0, roll: o.roll || 0, stretch: o.stretch?.slice(), scale: o.scale, auto_scale: o.auto_scale, hidden: false, face: !!o.face,
      keys: (o.keys || []).map(k => ({ ...k, pos: move(k.pos) })), state: "ok" };
    c.mesh = o.prim ? primMesh(c) : o.mesh;
    s.objs.push(c); s.sel = s.objs.length - 1; changed(c);
  }
  function rename(o) { const n = prompt("Name (its label here, and {Name} in a render's text; what it should become goes in Becomes)", o.name); if (!n?.trim()) return; o.name = n.trim().slice(0, 120); changed(o); }
  function select(i) { if (s.sel !== i || s.camSel) { s.sel = i; s.camSel = false; renderSide(); s.dirty = true; } }
  function selectCam() { if (!s.camSel) { s.camSel = true; s.sel = -1; renderSide(); s.dirty = true; } }
  // Show the camera as an object (and look at it from outside), or not.
  function setCamObj(on) {
    s.camObj = !!on; s.camSel = false;
    if (s.bg) { if (s.camObj) { s.cam = outsideView(); s.camFree = true; } else { s.cam = s.camKeys.length ? camAt(s.t) : s.cam; s.camFree = false; } }
    renderSide(); s.dirty = true;
  }
  // A shape's size, tilt and colour are in the side panel: show it.
  function focusShape() { const el = s.root.querySelector(".s3-prim"); el?.scrollIntoView({ block: "nearest" }); el?.querySelector("input")?.focus(); }
  function objMenu(i, x, y, px, py) {
    const o = s.objs[i]; if (!o) return;
    select(i);
    const ok = !!(o.mesh && o.pos);
    Media.menu(x, y, [
      ok && ["✥ Move  (G)", () => startModal("move", px, py)],
      ok && ["↕ Raise or lower  (L)", () => startModal("lift", px, py)],
      ok && ["⟳ Rotate  (R)", () => startModal("rotate", px, py)],
      ok && ["⤢ Resize  (S)", () => startModal("scale", px, py)],
      ok && ["↶ Turn 90° left", () => nudge(o, { yaw: 90 })],
      ok && ["↷ Turn 90° right", () => nudge(o, { yaw: -90 })],
      ok && ["＋ Bigger", () => nudge(o, { k: 1.25 })],
      ok && ["－ Smaller", () => nudge(o, { k: 0.8 })],
      ok && ["⬇ Set it down on the ground", () => dropDown(o)],
      o.prim && ["📐 Size, tilt and colour…", () => focusShape()],
      ok && ["⧉ Duplicate  (Shift+D)", () => duplicate(o)],
      ["✎ Rename…", () => rename(o)],
      [o.hidden ? "👁 Show" : "🙈 Hide", () => { o.hidden = !o.hidden; changed(o); }],
      ["🗑 Delete  (Del)", () => { select(i); removeSel(); }],
    ].filter(Boolean));
  }
  function modelMenu(x, y, at = null) {
    const done = models.filter(m => m.status === "done");
    if (!done.length) return Media.toast("No 3D models yet: right-click a picture and choose 🧊 Make 3D.");
    const mine = done.filter(m => m.source === s.sc.picture), rest = done.filter(m => m.source !== s.sc.picture);
    Media.menu(x, y, [...mine, ...rest].slice(0, 40).map(m => [`🧊 ${m.name}`, () => addModel(m.id, at)]));
  }
  function spaceMenu(x, y, px, py) {
    const at = surfaceHit(rayAt(px, py));
    Media.menu(x, y, [
      ...Object.entries(PRIMS).map(([k, d]) => [`${d.icon} Add a ${d.label.toLowerCase()}${at ? " here" : ""}`, () => addPrim(k, at)]),
      ["🧊 Add a 3D model…", () => modelMenu(x, y, at)],
      [s.bg.empty ? "🎥 Back to the start view" : "🎥 Back to the picture's camera", () => toShot()],
    ]);
  }
  function renderTools() {
    const R = s.root, o = s.objs[s.sel], ok = !!(o?.mesh && o.pos);
    R.querySelectorAll("[data-tool]").forEach(b => { b.classList.toggle("on", b.dataset.tool === s.tool); b.setAttribute("aria-pressed", String(b.dataset.tool === s.tool)); });
    R.querySelectorAll("[data-needsel]").forEach(b => { b.disabled = b.dataset.needsel === "any" ? !o : !ok; });
    R.querySelector('[data-act="undo"]').disabled = !s.hist?.past.length;
    R.querySelector('[data-act="redo"]').disabled = !s.hist?.future.length;
  }

  /* ---------------------------------------------------------------- undo and redo: the whole scene, after each change */
  const sameArr = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  function snapOf() {
    return JSON.stringify({ objects: objectsOut(), cam: s.camKeys, seconds: +s.seconds || 5, dof: s.sc.dof || {}, fx: s.sc.fx || {},
      ...(s.sc.kind === "empty" ? { aspect: s.sc.aspect, lens: s.sc.lens, backdrop: s.sc.backdrop } : {}) });
  }
  function record() {
    const h = s.hist; if (!h || s.restoring) return;
    const now = snapOf(); if (now === h.cur) return;
    h.past.push(h.cur); if (h.past.length > 200) h.past.shift();
    h.cur = now; h.future = [];
    renderTools();
  }
  async function restore(json) {
    const d = JSON.parse(json), old = s.objs, selId = s.objs[s.sel]?.id;
    s.objs = d.objects.map(x => {
      const o = { ...x, keys: normKeys(x.keys) }, p = old.find(q => q.id === x.id);
      if (x.prim) {
        o.mesh = p?.mesh && p.prim === x.prim && (p.pose || "") === (x.pose || "") && sameArr(p.dims, x.dims) && sameArr(p.tilt, x.tilt) ? p.mesh : primMesh(o);
        o.mesh.parts[0].base = [...hexRgb(o.color || PRIM_COLOR), 1]; o.state = "ok";
      } else {
        const q = p?.mesh && p.model === x.model ? p : old.find(z => z.mesh && z.model && z.model === x.model);
        if (q) { o.mesh = q.mesh; o.state = q.state; }
      }
      return o;
    });
    s.camKeys = d.cam; s.seconds = d.seconds; s.sc.dof = d.dof || {}; s.sc.fx = d.fx || {};
    if (s.sc.kind === "empty" && (d.aspect !== s.sc.aspect || d.lens !== s.sc.lens || !sameArr(d.backdrop, s.sc.backdrop))) {
      Object.assign(s.sc, { aspect: d.aspect, lens: d.lens, backdrop: d.backdrop,
        backdrop_url: d.backdrop?.picture ? `/api/media/file?path=${encodeURIComponent(d.backdrop.picture)}` : null });
      await buildEmpty(); renderEmpty();
    }
    s.sel = s.objs.findIndex(o => o.id === selId);
    s.restoring = true; save(); s.restoring = false;
    setTime(Math.min(s.t, dur())); renderSide(); s.dirty = true;
    if (s.objs.some(o => o.model && !o.mesh)) loadObjects();
  }
  async function undo() {
    const h = s?.hist; if (!h?.past.length || s.modal) return;
    h.future.push(h.cur); h.cur = h.past.pop(); await restore(h.cur); renderTools();
  }
  async function redo() {
    const h = s?.hist; if (!h?.future.length || s.modal) return;
    h.past.push(h.cur); h.cur = h.future.pop(); await restore(h.cur); renderTools();
  }

  /* ---------------------------------------------------------------- saving */
  const objectsOut = () => s.objs.map(o => ({ id: o.id, name: o.name, becomes: (o.becomes || "").trim(), picture: o.picture || null, ...(o.lib ? { lib: o.lib } : {}), model: o.model, mask: o.mask, pos: o.pos, yaw: o.yaw || 0, pitch: o.pitch || 0, roll: o.roll || 0,
    stretch: o.stretch || null, scale: o.scale, auto_scale: o.auto_scale, hidden: !!o.hidden, face: !!o.face, keys: o.keys || [],
    ...(o.prim ? { prim: o.prim, color: o.color || PRIM_COLOR, dims: o.dims || PRIMS[o.prim].dims, tilt: o.tilt || [0, 0] } : {}),
    ...(o.prim === "figure" ? { pose: o.pose || "standing", gait: o.gait || null } : {}) }));
  const saveBody = () => JSON.stringify({ objects: objectsOut(), seconds: +s.seconds || 5, camera_keys: s.camKeys, photos: s.photos, dof: s.sc.dof || {}, fx: s.sc.fx || {},
    ...(s.sc.kind === "empty" ? { aspect: s.sc.aspect, lens: s.sc.lens, backdrop: s.sc.backdrop } : {}) });
  function save() {
    clearTimeout(s.saveT);
    record();
    const id = s.id, body = saveBody();
    s.saveT = setTimeout(() => api(`/api/scenes/${id}`, { method: "PATCH", body }).catch(e => Media.toast(`Couldn't save the scene: ${e.message}`)), 500);
  }
  // Save now; the scene's revision (its saved time).
  async function flushSave() { clearTimeout(s.saveT); const sc = await api(`/api/scenes/${s.id}`, { method: "PATCH", body: saveBody() }); return sc.updated || 0; }

  /* ---------------------------------------------------------------- the window */
  /* V2 (static/v2.js): the builder draws in a page element instead of a window. */
  let host = null;
  function mount(el) { host = el; }
  function embed(el, root, foot, onClose) {
    el.replaceChildren(root, foot);
    foot.classList.add("s3-hostfoot");
    const win = { el, body: el, setTitle() {}, focus() {}, close() { if (win.closed) return; win.closed = true; el.replaceChildren(); onClose(); } };
    return win;
  }
  async function open(id) {
    if (s?.win) s.win.close();
    let sc;
    try { sc = await api(`/api/scenes/${id}`); } catch (e) { return Media.toast(e.message); }
    const root = document.createElement("div");
    root.className = "s3";
    root.innerHTML = `
      <div class="s3-stage">
        <div class="s3-tools" role="toolbar" aria-label="Scene tools">
          <div class="s3-tg" role="group" aria-label="History">
            <button type="button" class="s3-tb" data-act="undo" title="Undo (Ctrl+Z)" disabled>↶<span class="s3-tx"> Undo</span></button>
            <button type="button" class="s3-tb" data-act="redo" title="Redo (Ctrl+Y)" disabled>↷<span class="s3-tx"> Redo</span></button></div>
          <div class="s3-tg" role="group" aria-label="Add"><span class="s3-tl">Add</span>
            ${Object.entries(PRIMS).map(([k, d]) => `<button type="button" class="s3-tb" data-act="prim" data-prim="${k}" title="Add a ${d.label.toLowerCase()} (right-click the ground to add it there)"><span aria-hidden="true">${d.icon}</span><span class="s3-tx"> ${d.label}</span></button>`).join("")}
            <button type="button" class="s3-tb" data-act="models" title="Add one of your 3D models (🧊 Make 3D)"><span aria-hidden="true">🧊</span><span class="s3-tx"> Model</span></button></div>
          <div class="s3-tg" role="group" aria-label="Dragging an object"><span class="s3-tl">Drag to</span>
            <button type="button" class="s3-tb" data-tool="move" title="Move: drag an object over the ground, or an arrow along its axis (G)">✥<span class="s3-tx"> Move</span></button>
            <button type="button" class="s3-tb" data-tool="lift" title="Drag an object up or down (L, or Shift+drag)">↕<span class="s3-tx"> Raise</span></button>
            <button type="button" class="s3-tb" data-tool="rotate" title="Rotate: drag an object left or right, or a ring to turn it about that axis (R)">⟳<span class="s3-tx"> Rotate</span></button>
            <button type="button" class="s3-tb" data-tool="scale" title="Resize: drag an object right or up, a handle to stretch it along that axis, or the ball (S)">⤢<span class="s3-tx"> Resize</span></button></div>
          <div class="s3-tg" role="group" aria-label="The selected object">
            <button type="button" class="s3-tb" data-act="turnl" data-needsel="1" title="Turn it 90° left">↺</button>
            <button type="button" class="s3-tb" data-act="turnr" data-needsel="1" title="Turn it 90° right">↻</button>
            <button type="button" class="s3-tb" data-act="floor" data-needsel="1" title="Set it down on the ground">⬇</button>
            <button type="button" class="s3-tb" data-act="dup" data-needsel="1" title="Duplicate it (Shift+D)">⧉</button>
            <button type="button" class="s3-tb" data-act="remove" data-needsel="any" title="Delete it (Del)">🗑</button></div>
        </div>
        <div class="s3-box"><canvas class="m3-canvas s3-canvas" tabindex="0" aria-label="The 3D scene: drag an object to move it, drag elsewhere to orbit, wheel to zoom"></canvas>
        <div class="m3-hud hint s3-hud">Making the background…</div><div class="s3-frame" aria-hidden="true"></div>
        <div class="s3-pip" hidden aria-hidden="true"><span class="s3-pip-l"></span></div>
        <div class="s3-float" role="dialog" aria-label="Position" hidden>
          <div class="s3-float-h" title="Drag to move this box"><b class="s3-float-n"></b><button type="button" class="s3-float-x" aria-label="Close">×</button></div>
          <div class="s3-float-l">Position <span class="opt s3-float-u"></span></div>
          <div class="s3-float-xyz">${["X", "Y", "Z"].map((a, j) => `<label><span class="ax${j}">${a}</span><input type="number" class="s3f-in" data-ax="${j}" step="0.1"></label>`).join("")}</div>
          <div class="s3-float-cam" hidden><div class="s3-float-l">Turn <span class="opt">degrees</span></div>
            <div class="s3-float-xyz"><label><span title="Pan, about Y">Pan</span><input type="number" class="s3f-in" data-ax="yaw" step="1"></label>
              <label><span title="Tilt: up is +, down is −">Tilt</span><input type="number" class="s3f-in" data-ax="pitch" step="1" min="-89" max="89"></label>
              <label><span title="Roll about the way it looks: + leans the top of the frame to the right">Roll</span><input type="number" class="s3f-in" data-ax="roll" step="1" min="-180" max="180"></label></div>
            <div class="s3-float-l">Lens <span class="opt">mm, keyed: key two for a zoom</span></div>
            <div class="s3-float-lens"><label><input type="number" class="s3f-in" data-ax="lens" min="10" max="300" step="1" list="s3-lenses" aria-label="Focal length in mm"> mm</label>
              <span class="hint s3-float-fov"></span></div>
            <div class="s3-float-l">Focus <span class="opt">depth of field</span></div>
            <div class="s3-float-lens"><label><input type="number" class="s3f-in" data-ax="focus" min="0.05" step="0.1" aria-label="Focus distance"> <span class="s3-float-fu">m</span></label>
              <button type="button" class="btn sm ghost s3-focus-on" title="Focus on one of the objects it sees, at the playhead">⌖ On…</button>
              <select class="s3-fstop" aria-label="Aperture" title="The aperture: smaller numbers blur more of what's nearer or farther than the focus; Off keeps everything sharp">
                <option value="">Off</option>${FSTOPS.map(n => `<option value="${n}">f/${n}</option>`).join("")}</select></div>
            <p class="hint s3-float-dof"></p>
            <div class="s3-float-l">Shake <span class="opt">%, keyed</span></div>
            <div class="s3-float-lens"><label><input type="number" class="s3f-in" data-ax="shake" min="0" max="100" step="5" aria-label="Shake amount in percent"> %</label>
              <select class="s3-shakestyle" aria-label="Shake style" title="How it shakes, for the whole camera">${Object.entries(SHAKES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></div>
            <datalist id="s3-lenses">${[18, 24, 28, 35, 50, 85, 135, 200].map(v => `<option value="${v}">`).join("")}</datalist></div>
          <p class="hint s3-float-t"></p>
        </div></div>
        <div class="mo-transport">
          <button type="button" class="btn sm" data-act="play" title="Play (Space)">▶</button>
          <input type="range" class="mo-scrub s3-scrub" min="0" step="${1 / FPS}" value="0" aria-label="Time">
          <span class="mo-time s3-time"></span>
          <label class="s3-len">Length <input type="number" class="s3-sec" min="1" max="10" step="0.5" aria-label="Length in seconds"> s</label></div></div>
      <aside class="mo-side s3-side">
        <section><h3>View</h3>
          <div class="mo-row"><button type="button" class="btn sm s3-shotbtn" data-act="shot" title="Look through the picture's own camera">🎥 Picture's camera</button></div>
          <div class="s3-empty" hidden>
            <div class="row2"><div class="field"><label for="s3-aspect">Shape</label><select id="s3-aspect">
              <option value="16:9">16:9 wide</option><option value="9:16">9:16 tall</option><option value="1:1">1:1 square</option><option value="4:3">4:3</option><option value="21:9">21:9 cinema</option></select></div>
              <div class="field"><label for="s3-lens">Lens</label><select id="s3-lens">
              <option value="18">18 mm (very wide)</option><option value="24">24 mm (wide)</option><option value="35">35 mm</option><option value="50">50 mm (natural)</option><option value="85">85 mm (portrait)</option><option value="135">135 mm (tele)</option></select></div></div>
            <div class="row2"><div class="field"><label for="s3-sky">Sky</label><input type="color" id="s3-sky"></div>
              <div class="field"><label for="s3-floor">Floor</label><input type="color" id="s3-floor"></div></div>
            <div class="field"><label>Backdrop picture <span class="opt">far behind</span></label>
              <div class="mo-row"><button type="button" class="btn sm" data-act="bd-pick">Choose…</button><button type="button" class="btn sm ghost" data-act="bd-clear" hidden>Remove</button><span class="hint s3-bdname"></span></div>
              <input type="file" class="s3-bdfile" accept="image/png,image/jpeg,image/webp" hidden></div>
          </div>
          <label class="check"><input type="checkbox" data-opt="showBg" checked> <span class="s3-bglabel">Background</span></label>
          <label class="check"><input type="checkbox" data-opt="clay"> Clay (models without colour)</label>
          <label class="check" title="With an aperture set (the camera's floating box), what the camera sees is blurred by its depth of field: looking through it, and in the corner preview. Renders and photos aren't blurred; H3 is told instead."><input type="checkbox" data-opt="dofBlur" checked> Depth of field blur</label>
          <p class="hint s3-bgnote"></p></section>
        <section><h3>Camera</h3>
          <p class="hint s3-camhint"></p>
          <div class="mo-row"><button type="button" class="btn sm" data-act="key-cam" title="Keep this view at the playhead">◆ Key the camera</button>
            <button type="button" class="btn sm ghost" data-act="clear-cam">Clear its keys</button></div>
          <div class="mo-row"><button type="button" class="btn sm" data-act="crane" title="Move the camera on a crane arm (a jib): it rises or falls and swings round a pivot, from the playhead on">🏗 Crane move…</button></div>
          <div class="mo-keys s3-camkeys"></div>
          <label class="check" title="See the shot camera from outside, as an object with its own gimbal (arrows move it, rings pan and tilt it)"><input type="checkbox" id="s3-camobj"> <span class="s3-camobj-l">The camera as an object</span></label>
          <div class="mo-row s3-camobj-row" hidden><button type="button" class="btn sm" data-act="cam-sel" title="Select the camera: its gimbal and position show">🎥 Select it</button>
            <button type="button" class="btn sm ghost" data-act="cam-through" title="See what it sees (orbiting then takes you back outside)">👁 Look through it</button>
            <button type="button" class="btn sm ghost" data-act="cam-outside" title="Back outside, behind and above it">↩ Outside</button></div>
          <label class="check s3-pipf" hidden title="From outside, a small picture in the corner shows what the camera sees at the playhead: scrub or ▶ play to preview its dolly move"><input type="checkbox" id="s3-pip"> 📺 Preview what it sees</label></section>
        <section><h3>Objects</h3><ul class="mo-layers s3-objs"></ul>
          <div class="mo-find"><select class="s3-add" aria-label="A 3D model to add"></select><button type="button" class="btn sm" data-act="add">Add</button></div></section>
        <section class="s3-sel" hidden><h3 class="s3-sel-h"></h3>
          <div class="field"><label for="s3-becomes">Becomes <span class="opt">in the photo and the video</span></label>
            <input type="text" id="s3-becomes" maxlength="200" placeholder="a wooden crate, a golden retriever…"
              title="What the photo and the video should make of it. The models only see its shape and colour; this says what it really is."></div>
          <div class="field"><label>Picture <span class="opt">for a render on H3 Reference</span></label>
            <div class="s3-pic"><div class="s3-pic-th" tabindex="0" title="Drop a picture here from the gallery, the media library or your files"></div>
              <div class="s3-pic-btns"><button type="button" class="btn sm" data-act="pic-crop" title="Cut it out of the picture it was made from">✂ From the picture</button>
                <button type="button" class="btn sm" data-act="pic-inputs" title="A keyframe or reference picture from the Inputs step (so a shot's <Picture N> becomes this object)">📥 Inputs…</button>
                <button type="button" class="btn sm" data-act="pic-file">Choose…</button>
                <button type="button" class="btn sm ghost" data-act="pic-clear" title="No picture">Remove</button></div></div>
            <input type="file" class="s3-picfile" accept="image/png,image/jpeg,image/webp" hidden></div>
          <label class="check" title="While it moves, it turns to face the way it goes (stopped, it keeps its last heading). Rotation Y is then added on top: 0 faces straight ahead, 180 backwards."><input type="checkbox" id="s3-face"> Face where it's going</label>
          <div class="field"><label>Rotation <span class="opt">degrees</span></label>
            <div class="s3-dims"><label>X <input type="number" id="s3-rx" step="5"></label><label>Y <input type="number" id="s3-ry" step="5"></label><label>Z <input type="number" id="s3-rz" step="5"></label></div></div>
          <div class="field"><label for="s3-size">Size <span class="s3-size-v"></span></label><input type="range" id="s3-size" min="0.2" max="3" step="0.01"></div>
          <div class="s3-prim" hidden>
            <div class="row2 s3-posef" hidden><div class="field"><label for="s3-pose">Pose</label><select id="s3-pose">${Object.entries(POSES).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("")}</select></div>
              <div class="field"><label for="s3-gait">Walk cycle</label><select id="s3-gait" title="While it moves along its path, it walks or runs, its steps matching how far it goes; stopped, it holds its pose. Tick Face where it's going (above) to have it turn the way it walks.">
                <option value="">Off</option>${Object.entries(GAITS).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join("")}</select></div></div>
            <div class="field"><label for="s3-color">Colour</label><input type="color" id="s3-color"></div>
            <div class="field"><label>Size <span class="opt s3-unit"></span></label>
              <div class="s3-dims"><label>W <input type="number" id="s3-dw" min="0.01" max="500" step="0.1"></label><label>H <input type="number" id="s3-dh" min="0.01" max="500" step="0.1"></label><label>D <input type="number" id="s3-dd" min="0.01" max="500" step="0.1"></label></div></div></div>
          <div class="mo-row"><button type="button" class="btn sm" data-act="replace" title="Stand it where it was in the picture again">↺ Put back</button>
            <button type="button" class="btn sm ghost" data-act="hide">Hide</button><button type="button" class="btn sm ghost" data-act="remove">Remove</button></div>
          <p class="hint s3-objhint"></p>
          <div class="mo-keys s3-objkeys"></div></section>
      </aside>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint s3-foot">Drag: orbit · Right-drag: pan · Wheel: zoom · Right-click: menu</span><button type="button" class="btn ghost" data-act="tpl">☆ Save as template</button><button type="button" class="btn ghost" data-act="pic" title="Save the view as it is drawn here">💾 Save view</button>
      <button type="button" class="btn ghost" data-act="depth" title="A depth map of what the camera frames (near is white, far is black), for a depth ControlNet">🌫 Save depth map…</button>
      <button type="button" class="btn" data-act="photo" title="A photograph of what the camera frames, made by the image editor's edit model">📷 Generate photo…</button>
      <button type="button" class="btn primary" data-act="render" title="Make the video with H3, following this scene">🎬 Render video…</button>`;
    const onClose = () => { if (s) { cancelAnimationFrame(s.raf); clearTimeout(s.poll); clearTimeout(s.saveT); s.ro?.disconnect(); s.closed = true; } s = null; meshCache.clear(); };
    const win = host ? embed(host, root, foot, onClose)
      : WM.open({ id: "scene3d", title: `🏞 ${sc.name}`, content: root, footer: foot, width: 1100, height: 720, minWidth: 720, minHeight: 480, onClose });
    const cv = root.querySelector(".s3-canvas"), hud = root.querySelector(".s3-hud");
    const gl = cv.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true });
    s = { id: sc.id, sc, win, root, cv, hud, gl, gpu: gl ? G().gpu(gl) : null, objs: (sc.objects || []).map(o => ({ ...o, keys: normKeys(o.keys) })), sel: -1, dirty: true, hist: null, hover: null,
      cam: { yaw: 0, pitch: 0, dist: 1, target: [0, 0, -1] }, showBg: true, clay: false, bg: null, tool: "move", modal: null, mouse: null,
      t: 0, seconds: +sc.seconds || 5, camKeys: (sc.camera_keys || []).slice().sort((a, b) => a.t - b.t), camFree: false, camObj: false, camSel: false,
      floatOff: null, dofBlur: true, dofFb: null, dofProg: null, pip: (() => { try { return localStorage.getItem("bob.s3pip") !== "0"; } catch { return true; } })(),
      photos: (sc.photos || []).slice(), foot };
    syncTplBtn();
    if (!gl) { hud.textContent = "This browser has no WebGL 2, so the scene can't be shown."; return; }
    s.ro = new ResizeObserver(() => { if (s) s.dirty = true; }); s.ro.observe(cv);
    wire(root, foot);
    wireFloat(root);
    renderSide();
    // wait for the background
    while (sc.status === "running") {
      await new Promise(r => setTimeout(r, 1000));
      if (!s || s.id !== id) return;
      try { sc = await api(`/api/scenes/${id}`); } catch { /* try again */ }
    }
    if (sc.status !== "done") { hud.textContent = `The background couldn't be made: ${sc.error || "unknown error"}`; return; }
    s.sc = sc;
    if (sc.kind === "empty") {
      await buildEmpty();
      if (!s) return;
      toShot(); setTime(0);
      if (shotLinked() || host) setCamObj(true);  // V2: the camera is an object to select
      root.querySelector(".s3-empty").hidden = false;
      root.querySelector(".s3-shotbtn").textContent = "🎥 Start view";
      root.querySelector(".s3-shotbtn").title = "Back to the view the scene starts with";
      root.querySelector(".s3-bglabel").textContent = "Floor and backdrop";
      root.querySelector(".s3-bgnote").textContent = "Add 3D models below; each stands on the floor at 1 m tall. Frame the shot by orbiting (drag), panning (right-drag) and zooming (wheel), then 📷 Generate photo.";
      renderEmpty();
      loop(); startHistory();
      return;
    }
    try {
      const prims = await G().parseGLB(await (await fetch(sc.bg_url)).arrayBuffer());
      const p = prims[0], img = p.tex;
      if (!p?.uv || !img) throw new Error("The background has no picture on it");
      s.bg = rebuildBackground(p, img.width, img.height);
      s.bgMesh = s.gpu.upload(prims);
    } catch (e) { hud.textContent = `Couldn't show the background: ${e.message}`; return; }
    if (!s) return;
    toShot();
    setTime(0);
    if (shotLinked() || host) setCamObj(true);  // V2: the camera is an object to select
    hud.textContent = `Camera ${Math.round(2 * Math.atan(s.bg.t) / rad)}° wide`;
    root.querySelector(".s3-bgnote").textContent = sc.plate ? "The background is the empty background from Animate objects."
      : "The background is the picture itself, so objects that have a 3D model show twice. Make the empty background in 🎬 Animate objects to avoid that.";
    loop();
    startHistory();
  }
  async function startHistory() {
    await loadObjects();
    if (s && !s.hist) { s.hist = { past: [], future: [], cur: snapOf() }; renderTools(); }
  }

  /* ---------------------------------------------------------------- rendering to video (H3 with Time-to-Move) */
  const shotCam = () => s.bg.empty ? emptyStart() : ({ yaw: 0, pitch: 0, dist: s.bg.dmed, target: [0, 0, -s.bg.dmed] });
  // An empty scene starts at eye height (the origin) looking a little down at the floor 3.5 m ahead.
  function emptyStart() { const ty = s.bg.floor + 0.6, z = 3.5; return { yaw: 0, pitch: Math.atan2(-ty, z) / rad, dist: Math.hypot(z, ty), target: [0, ty, -z] }; }
  // The camera of the render at time t: its path, or (without keys) the picture's own camera.
  const camBase = t => s.camKeys.length ? camAt(t) : shotCam();
  const camForRender = t => withShake(camBase(t), t);
  const camDiff = (a, b) => Math.abs(a.yaw - b.yaw) + Math.abs(a.pitch - b.pitch) + Math.abs(a.dist - b.dist) / s.bg.dmed
    + Math.abs(Math.log((a.lens || baseLens()) / (b.lens || baseLens()))) + Math.abs((a.roll || 0) - (b.roll || 0))
    + Math.hypot(...sub(a.target, b.target)) / s.bg.dmed;
  const cameraMoves = () => shakes() || s.camKeys.length > 1 && s.camKeys.some(k => camDiff(k, s.camKeys[0]) > 1e-3);
  const startsAsPicture = () => camDiff(camForRender(0), shotCam()) < 0.02;
  const frameCount = () => Math.round(dur() * FPS) + 1;

  // Fill the holes of a frame (where nothing was drawn: what a camera move uncovers) with the colours around them, so
  // H3 doesn't start from black there (push-pull: halve until tiny, then build back up, each level under the next).
  function fillHoles(src, W, H) {
    const mk = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });
    const levels = [];
    let prev = src, w = W, h = H;
    while (w > 8 && h > 8) {
      w = Math.ceil(w / 2); h = Math.ceil(h / 2);
      const c = mk(w, h), g = c.getContext("2d");
      g.imageSmoothingQuality = "high"; g.drawImage(prev, 0, 0, w, h);
      levels.push(c); prev = c;
    }
    let base = levels.at(-1) || mk(1, 1);
    const g0 = base.getContext("2d", { willReadFrequently: true }), d = g0.getImageData(0, 0, base.width, base.height), D = d.data;
    // the tiniest level, opaque: each cell its average colour; a cell with nothing in it (a hole bigger than the cell,
    // as half the frame is in a 360° orbit) takes the average of the whole picture, not black
    let r = 0, gg = 0, b = 0, a = 0;
    for (let i = 0; i < D.length; i += 4) { const w = D[i + 3]; r += D[i] * w; gg += D[i + 1] * w; b += D[i + 2] * w; a += w; }
    const avg = a ? [r / a, gg / a, b / a] : [128, 128, 128];
    for (let i = 0; i < D.length; i += 4) {
      const k = D[i + 3] / 255;  // the colours are unpremultiplied: blend what's there with the average by its cover
      for (let j = 0; j < 3; j++) D[i + j] = D[i + j] * k + avg[j] * (1 - k);
      D[i + 3] = 255;
    }
    g0.putImageData(d, 0, 0);
    for (let i = levels.length - 2; i >= -1; i--) {
      const top = i >= 0 ? levels[i] : src, tw = i >= 0 ? top.width : W, th = i >= 0 ? top.height : H;
      const c = mk(tw, th), g = c.getContext("2d");
      g.drawImage(base, 0, 0, tw, th); g.drawImage(top, 0, 0, tw, th);
      base = c;
    }
    return base;
  }

  async function renderVideo(kind, size, n, progress, proj = null) {
    const fd = new FormData();
    const mask = kind === "mask" ? (proj ? "proj" : cameraMoves() ? "all" : "objects") : null;
    for (let f = 0; f < n; f++) {
      if (!s) throw new Error("The scene was closed");
      const t = f / FPS;
      let out = s.cv;
      const gaps = gapLayers(proj, camForRender(t));
      if (mask && gaps.length) {
        // what H3 follows: the photo (objects too) and every filled view's background, together
        out = Object.assign(document.createElement("canvas"), { width: size[0], height: size[1] });
        const og = out.getContext("2d");
        draw({ size, t, cam: camForRender(t), mask, proj }); og.drawImage(s.cv, 0, 0, size[0], size[1]);
        og.globalCompositeOperation = "lighter";
        for (const L of gaps) { draw({ size, t, cam: camForRender(t), mask, proj: L, skip: s.objs }); og.drawImage(s.cv, 0, 0, size[0], size[1]); }
      } else if (mask) draw({ size, t, cam: camForRender(t), mask, proj });
      else if (proj && gaps.length) {
        // the filled views (the one nearest this frame's camera last), then the photo's background over them, then
        // the whole frame from the photo; what none of them saw: the empty scene's own sky and floor, or a blur
        out = Object.assign(document.createElement("canvas"), { width: size[0], height: size[1] });
        const og = out.getContext("2d");
        if (s.bg.empty) { draw({ size, t, cam: camForRender(t), skip: s.objs }); og.drawImage(s.cv, 0, 0, size[0], size[1]); }
        for (const L of [...gaps, proj]) { draw({ size, t, cam: camForRender(t), proj: L, skip: s.objs }); og.drawImage(s.cv, 0, 0, size[0], size[1]); }
        if (!s.bg.empty) out = fillHoles(out, size[0], size[1]);
        draw({ size, t, cam: camForRender(t), proj });
        out.getContext("2d").drawImage(s.cv, 0, 0, size[0], size[1]);
      } else {
        // The holes a camera move opens are filled from the background alone, so an object's colours don't bleed
        // into them (H3 kept that as a glow round a person): the background drawn without the objects, its holes
        // filled, then the whole frame drawn over it.
        draw({ size, t, cam: camForRender(t), proj, skip: s.objs });
        if (proj && s.bg.empty) {
          // an empty scene: what the photo never saw is the scene's own sky and floor (its colours), under the photo, so H3
          // carries the place on round the back of a turn (a blur of the photo's edges went dark over half a 360° orbit)
          out = Object.assign(document.createElement("canvas"), { width: size[0], height: size[1] });
          const og = out.getContext("2d"), photo = Object.assign(document.createElement("canvas"), { width: size[0], height: size[1] });
          photo.getContext("2d").drawImage(s.cv, 0, 0, size[0], size[1]);
          draw({ size, t, cam: camForRender(t), skip: s.objs });
          og.drawImage(s.cv, 0, 0, size[0], size[1]);
          og.drawImage(photo, 0, 0);
        } else out = fillHoles(s.cv, size[0], size[1]);
        draw({ size, t, cam: camForRender(t), proj });
        out.getContext("2d").drawImage(s.cv, 0, 0, size[0], size[1]);
      }
      // toDataURL is synchronous: toBlob's callback (and setTimeout) crawl when the tab is in the background
      const url = out.toDataURL(mask ? "image/png" : "image/jpeg", 0.92), bin = atob(url.slice(url.indexOf(",") + 1));
      const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      fd.append("frame", new Blob([bytes], { type: mask ? "image/png" : "image/jpeg" }), `${String(f).padStart(5, "0")}.${mask ? "png" : "jpg"}`);
      if (f % 8 === 0) { progress(f, n); await new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); }); }
    }
    fd.append("fps", String(FPS));
    const r = await fetch("/api/frames/video", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return (await r.json()).ref;
  }

  // The shots the render can go to: this scene's project's shot list, while it's the one open.
  const toShots = () => typeof Shots !== "undefined" && (state.project?.id ?? null) === (s.sc.project ?? null) ? Shots.targets() : [];
  // The shot this scene is for (made from it or picked for it on the Shots step), while its project is open.
  const forShot = () => toShots().length && Shots.each() ? Shots.shotOfScene(s.sc.id) : null;
  // A shot's text in the scene's words: <Picture N> (the Inputs step's reference N) becomes {the object} that has
  // that picture, or "the subject".
  function fromShot(text) {
    const objs = s.objs.filter(o => o.mesh && o.pos && !o.hidden);
    return String(text || "").replace(/<Picture (\d+)>/g, (_, n) => {
      const ref = state.refs?.[+n - 1]?.ref, o = ref && objs.find(x => x.picture === ref);
      return o ? `{${o.name}}` : "the subject";
    }).trim();
  }
  const autoTl = () => { try { return localStorage.getItem("bob.sceneAutoTl") !== "0"; } catch { return true; } };
  function renderDialog() {
    if (!s?.bg) return;
    if (!s.objs.some(o => o.mesh && !o.hidden) && !cameraMoves()) return Media.toast("Nothing moves yet: key an object or the camera first.");
    if (!state.caps?.editor?.motion && state.caps?.editor) return Media.toast("Rendering a scene needs H3 and ComfyUI-vlo (vloTimeToMove), as Animate objects does.");
    const moving = s.objs.filter(o => o.mesh && !o.hidden && o.keys?.length > 1).map(o => o.name);
    const adopted = forShot() ? adoptShotPictures(forShot().action) : [];
    const noPic = !s.sc.picture, pic = !noPic && startsAsPicture();
    // the scene's photos that are done; one taken at 0 s from where the video's camera starts matches its first frame
    const cam0 = camForRender(0);
    const photos = s.photos.map(p => ({ ...p, it: state.items.get(p.id) })).filter(p => p.it?.status === "done" && p.it.files?.length)
      .map(p => ({ ...p, match: Math.abs(p.t) < 0.5 / FPS && camDiff(p.cam, cam0) < 0.02 })).reverse();
    const best = photos.find(p => p.match);
    const startDefault = pic ? "picture" : best ? `photo:${best.id}` : editModels().length ? "newphoto" : "composite";
    const when = it => new Date((it.finished || it.created) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const box = document.createElement("div");
    box.className = "m3-make";
    box.innerHTML = `${adopted.length ? `<p class="hint">From the shot: ${esc(adopted.join(", "))} (its picture, sent to H3 Reference).</p>` : ""}<p class="hint">H3 makes the video from the picture, following this scene's rough animation (Time-to-Move, as in Animate objects):
        ${cameraMoves() ? "the camera move and the objects" : "the objects; the camera holds still"}. ${frameCount()} frames, ${dur().toFixed(2)} s.</p>
      <div class="field"><label for="s3r-what">What happens <span class="opt">optional</span></label>
        ${tagChips()}
        <textarea id="s3r-what" rows="3" placeholder="${esc(moving.length ? `${moving.map(n => `{${n}}`).join(" and ")} move${moving.length > 1 ? "" : "s"} across the scene.` : "The scene comes to life.")}">${esc(fromShot(forShot()?.action))}</textarea>
        <p class="hint s3-said" aria-live="polite"></p></div>
      ${picObjs().length ? `<label class="check"><input type="checkbox" id="s3r-refs"${refsReady() ? " checked" : " disabled"}> Use the objects' pictures (H3 Reference)</label>
        <p class="hint s3r-refs-h">${refsReady() ? `The first frame is &lt;Picture 1&gt;; ${picObjs().map((o, i) => `${esc(o.name)} is &lt;Picture ${i + 2}&gt;`).join(", ")}. Runs on H3 Reference's model with the same motion.`
          : "Needs H3 Reference's model (ref2va) in ComfyUI: see the Model step."}${s.objs.filter(o => o.mesh && o.pos && !o.hidden && o.picture).length > 8 ? " Only the first 8 pictures are used." : ""}</p>` : ""}
      <div class="row2"><div class="field"><label for="s3r-q">Quality</label><select id="s3r-q"><option value="draft">Draft</option><option value="standard" selected>Standard</option><option value="full">Full</option></select></div>
        <div class="field"><label for="s3r-hold">Follow the plan</label><select id="s3r-hold"><option value="loose">Loosely</option><option value="normal" selected>Normally</option><option value="tight">Tightly</option></select></div></div>
      <div class="field"><label for="s3r-first">Start from</label><select id="s3r-first">
        ${noPic ? "" : `<option value="picture">The picture${pic ? " (the scene starts as the picture)" : " (the camera starts elsewhere)"}</option>`}
        ${editModels().length ? `<option value="newphoto">A new photo of the first frame (made first, about a minute, then the video)</option>` : ""}
        ${photos.map(p => `<option value="photo:${p.id}">The photo from ${when(p.it)}${p.match ? " (the first frame)" : " (another view: the video may jump)"}</option>`).join("")}
        <option value="composite">The scene's first frame as drawn (plain)</option></select></div>
      ${cameraMoves() ? `<label class="check s3r-fillf" title="Where the camera move shows what the photo never saw (the far side of a turn), Qwen paints the place in first, from up to ${MAX_GAPS} views along the move, so H3 follows the same surroundings all the way round"><input type="checkbox" id="s3r-fill"${lastFill() ? " checked" : ""}> Fill what the photo can't see with Qwen first <span class="opt">about half a minute per view</span></label>` : ""}
      <div class="field s3r-lookf"><label for="s3r-look">How the photo should look <span class="opt">optional</span></label>
        <textarea id="s3r-look" rows="2" placeholder="Soft daylight, shot on 35 mm film.">${esc(lastLook())}</textarea></div>
      ${toShots().length ? `<div class="field"><label for="s3r-to">Goes to</label><select id="s3r-to">
        <option value="now">Render it now (the gallery)</option>
        <optgroup label="A shot on the Shots step">${toShots().map(t => `<option value="${t.i}">${esc(t.label)}</option>`).join("")}
        <option value="new">A new shot</option></optgroup></select>
        <p class="hint s3r-to-h" hidden>The shot keeps this render's rough animation, mask and first picture; Generate on the Shots step makes it, in order with the other shots.${forShot() ? ` This scene is for shot ${forShot().i + 1}: What happens is that shot's.` : ""}</p></div>` : ""}
      <label class="check s3r-tlf"><input type="checkbox" id="s3r-tl"${autoTl() ? " checked" : ""}> Add it to the timeline when it's done</label>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint s3r-st"></span><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="go">🎬 Render</button>`;
    const win = WM.open({ id: "scene3d-render", title: `Render · ${s.sc.name}`, content: box, footer: foot, width: 560, height: 660, modal: true });
    const useRefs = () => !!box.querySelector("#s3r-refs")?.checked;
    const fromPhoto = () => { const v = box.querySelector("#s3r-first").value; return v === "newphoto" || v.startsWith("photo:"); };
    wireTags(box, box.querySelector("#s3r-what"), () => videoText(box.querySelector("#s3r-what").value.trim() || box.querySelector("#s3r-what").placeholder, useRefs(), fromPhoto()));
    box.querySelector("#s3r-refs")?.addEventListener("change", () => box.querySelector("#s3r-what").dispatchEvent(new Event("input")));
    const st = foot.querySelector(".s3r-st"), firstSel = box.querySelector("#s3r-first"), holdSel = box.querySelector("#s3r-hold");
    // From a photo, H3 is held to the plain rough animation only loosely, so the photo's look carries through.
    const syncStart = () => {
      const v = firstSel.value, photo = v === "newphoto" || v.startsWith("photo:");
      box.querySelector(".s3r-lookf").hidden = v !== "newphoto";
      const ff = box.querySelector(".s3r-fillf"); if (ff) ff.hidden = !photo;
      if (photo && !holdSel.dataset.touched) holdSel.value = "loose";
      if (!photo && !holdSel.dataset.touched) holdSel.value = "normal";
      box.querySelector("#s3r-what").dispatchEvent(new Event("input"));  // what H3 reads follows the start
    };
    firstSel.value = startDefault; syncStart();
    firstSel.onchange = syncStart; holdSel.onchange = () => { holdSel.dataset.touched = "1"; };
    const toSel = box.querySelector("#s3r-to"), goBtn = foot.querySelector('[data-a="go"]');
    const syncTo = () => {
      const shot = !!toSel && toSel.value !== "now";
      box.querySelector(".s3r-tlf").hidden = shot;
      if (toSel) box.querySelector(".s3r-to-h").hidden = !shot;
      goBtn.textContent = shot ? "🏞 Put in the shot" : "🎬 Render";
    };
    if (toSel) { toSel.onchange = syncTo; const fs = forShot(); if (fs) toSel.value = String(fs.i); }
    syncTo();
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = async e => {
      e.target.disabled = true;
      try {
        const start = firstSel.value, look = box.querySelector("#s3r-look").value.trim();
        if (start === "newphoto") try { localStorage.setItem("bob.scenePhotoLook", look); } catch { /* not kept */ }
        const to = toSel?.value ?? "now";
        const toTl = to === "now" && box.querySelector("#s3r-tl").checked;
        if (to === "now") try { localStorage.setItem("bob.sceneAutoTl", toTl ? "1" : "0"); } catch { /* not kept */ }
        const fill = !!box.querySelector("#s3r-fill")?.checked;
        if (box.querySelector("#s3r-fill")) try { localStorage.setItem("bob.sceneGapFill", fill ? "1" : "0"); } catch { /* not kept */ }
        const r = await buildRender({ start, look, fill, refs: useRefs(), hold: holdSel.value, quality: box.querySelector("#s3r-q").value,
          what: box.querySelector("#s3r-what").value.trim() || box.querySelector("#s3r-what").placeholder }, m => { st.textContent = m; });
        if (to !== "now") {  // into a shot: Generate on the Shots step sends it
          const k = Shots.useScene(to === "new" ? -1 : +to, r.shot);
          win.close();
          Media.toast(`3D scene: it's shot ${k + 1} now. Generate on the Shots step makes it.`);
          return;
        }
        const items = await submit(r.req);
        if (!items?.length) throw new Error("H3 didn't take it (the reason is on the Generate step)");
        if (toTl) Shots.placeWhenDone(items, s.sc.project);
        win.close();
        Media.toast(`3D scene: queued. ${toTl ? "It goes on the timeline when it's done." : "The video shows up in the gallery when it's done."}`);
      } catch (err) { st.textContent = ""; e.target.disabled = false; Media.toast(`Render: ${err.message}`); }
    };
  }

  /* Draw what H3 follows (the rough animation and its mask) and its first picture, and build the request.
     o: { start: "picture" | "newphoto" | "photo:<id>" | "composite", look, refs, hold, quality, what }. Returns
     { req, shot } (shot: what a shot on the Shots step keeps). */
  async function buildRender(o, say = () => {}) {
    // the picture's aspect, longest side 960 (the server fits it to the render's size)
    const n = frameCount(), W = Math.round((s.bg.aspect >= 1 ? 960 : 960 * s.bg.aspect) / 2) * 2, H = Math.round(W / s.bg.aspect / 2) * 2;
    const keep = [s.cv.width, s.cv.height], start = o.start, noPic = !s.sc.picture, fromPhoto = start === "newphoto" || start.startsWith("photo:");
    let proj = null;
    try {
      // From a photo, the rough animation is the photo painted onto the scene from the camera it was taken from, so
      // H3 starts from something that looks like the photo (not the plain render).
      let photoPath = null;
      if (start === "newphoto") {
        say("Making the photo of the first frame (about a minute; keep the scene open)…");
        const A = s.bg.aspect, PW = Math.round((A >= 1 ? 1280 : 1280 * A) / 8) * 8, PH = Math.round(PW / A / 8) * 8;
        const photo = await makePhoto([PW, PH], 0, camForRender(0), o.look || "", editModels()[0][0], o.refs, false, true);
        const it = await waitItem(photo.id);
        photoPath = (it.files || []).find(f => /^image\//.test(f.content_type || ""))?.path || it.files?.[0]?.path;
        if (it.status !== "done" || !photoPath) throw new Error("The photo didn't come out");
        say("Painting the photo onto the scene…");
        proj = await prepareProjection(photoPath, 0, camForRender(0), say);
      } else if (start.startsWith("photo:")) {
        const p = s.photos.find(x => x.id === start.slice(6)), it = state.items.get(start.slice(6));
        photoPath = it?.files?.[0]?.path;
        if (!p || !photoPath) throw new Error("That photo isn't there anymore");
        say("Painting the photo onto the scene…");
        proj = await prepareProjection(photoPath, p.t, p.cam, say);
      }
      if (proj && o.fill !== false && cameraMoves()) {
        try { const k = await fillGaps(proj, o.look || lastLook(), say); if (k) say(`Filled ${k} view${k === 1 ? "" : "s"} the photo couldn't see.`); }
        catch (err) { if (!s) throw err; Media.toast(`Filling the gaps: ${err.message}. Rendering without it.`); for (const g of proj.gaps || []) freeProjection(g.P); proj.gaps = []; }
      }
      say("Drawing the rough animation…");
      const ref = await renderVideo("ref", [W, H], n, (f, N) => say(`Drawing the rough animation: frame ${f + 1} of ${N}`), proj);
      const mask = await renderVideo("mask", [W, H], n, (f, N) => say(`Drawing its mask: frame ${f + 1} of ${N}`), proj);
      say("Sending to H3…");
      const what = videoText(o.what || defaultWhat(), o.refs, fromPhoto).text;
      const glides = s.camKeys.length > 1 && s.camKeys.some(k => camDiff(k, s.camKeys[0]) > 1e-3);
      const cam = [glides ? (shakes() ? "The camera moves through the scene." : "The camera moves smoothly through the scene.") : shakes() ? "" : "The camera holds a static shot.",
        shakes() ? SHAKES[shakeStyle()].says : ""].filter(Boolean).join(" ");
      const prompt = `integrated_multimodal_description: [Shot 1] ${what.replace(/\s+/g, " ")} ${cam}\n\noverall_soundscape: Natural sound of the scene.\n\nnon_diegetic_music: N/A`;
      const req = { kind: "video", engine: "motion", prompt, seconds: n / FPS, aspect: "16:9", quality: o.quality || "standard",
        seed: -1, batch: 1, turbo: true, first_frame: null, motion_video: ref, motion_video_mask: mask,
        motion_hold: o.hold || "normal", motion_first: "picture", project: s.sc.project };
      if (o.refs) req.references = picObjs().map(x => x.picture);
      if (photoPath) req.first_frame = photoPath;
      else if (start === "picture") req.first_frame = s.sc.picture;
      else if (noPic) req.first_frame = await uploadFrame([W, H], 0, camForRender(0), "scene_first.png");  // as drawn
      else { req.first_frame = s.sc.picture; req.motion_first = "composite"; }
      if (!req.first_frame) throw new Error("That photo isn't there anymore");
      const pic = s.photos.find(p => state.items.get(p.id)?.files?.[0]?.path === req.first_frame);
      const thumb = (pic && state.items.get(pic.id)?.files?.[0]?.url) || `/${req.first_frame.replace(/^\/+/, "")}`;  // its first picture
      // the scene as saved now: a later change makes Generate draw it again
      const rev = await flushSave();
      const shot = { id: s.sc.id, name: s.sc.name, thumb, seconds: n / FPS, what, cam, rev,
        req: { motion_video: ref, motion_video_mask: mask, first_frame: req.first_frame, motion_first: req.motion_first,
          motion_hold: req.motion_hold, quality: req.quality, references: req.references || [] } };
      return { req, shot };
    } finally { freeProjection(proj); if (s) { s.cv.width = keep[0]; s.cv.height = keep[1]; s.dirty = true; } }
  }
  // What happens, when nothing is written: whatever moves.
  function defaultWhat() {
    const moving = s.objs.filter(o => o.mesh && !o.hidden && o.keys?.length > 1).map(o => o.name);
    return moving.length ? `${moving.map(n => `{${n}}`).join(" and ")} move${moving.length > 1 ? "" : "s"} across the scene.` : "The scene comes to life.";
  }
  // A shot's <Picture N> (the Inputs step's reference N) that no object has yet goes to a Person without a picture, in
  // order, so the render on H3 Reference sends it and the person keeps that look. Returns what it gave.
  function adoptShotPictures(text) {
    const given = [];
    for (const m of String(text || "").matchAll(/<Picture (\d+)>/g)) {
      const r = state.refs?.[+m[1] - 1]; if (!r?.ref || s.objs.some(o => o.picture === r.ref)) continue;
      const o = s.objs.find(x => x.prim === "figure" && !x.picture && x.mesh && x.pos && !x.hidden); if (!o) continue;
      o.picture = r.ref; given.push(`<Picture ${m[1]}> → ${o.name}`);
    }
    if (given.length) { save(); renderSide(); }
    return given;
  }
  /* Generate on the Shots step, for a shot mapped to this scene whose render isn't in it (or is older than the scene):
     open the scene, draw it with the usual choices (what the Render window would pick), and put it in the shot. */
  async function openReady(id, say) {
    if (!s || s.id !== id || s.closed) { say("Opening the 3D scene…"); open(id); }
    for (let k = 0; k < 900 && !(s && s.id === id && s.bg && s.hist); k++) await new Promise(r => setTimeout(r, 100));
    if (!(s && s.id === id && s.bg)) throw new Error("the scene couldn't be opened");
    for (let k = 0; k < 300 && s.objs.some(o => o.model && !o.mesh && !["failed", "missing"].includes(o.state)); k++) await new Promise(r => setTimeout(r, 100));
  }
  /* Generate on the Shots step for MiniMax H3 Image: a shot mapped to this scene is a photo of what the shot camera
     sees at 0 s, as 📷 Generate photo makes it (the edit model, H3 Image when it's there, keeps where everything is),
     with the shot's text as how it looks. The shot's <Picture N> become the objects that have those pictures (a Person
     without one takes it), and those pictures go along. shot: {text, setting, style}; size: {aspect: "16:9"…, quality} (the Settings step: the photo has
     that shape, at H3 Image's size for that quality; the shot camera sees the wider or taller view it needs). Returns
     the queued item. */
  async function photoForShot(id, shot = {}, say = () => {}, size = {}) {
    await openReady(id, say);
    const models = editModels();
    if (!models.length) throw new Error("a photo of a 3D scene needs an edit model: MiniMax H3 Image, Qwen Image Edit 2511 or MOSS-Image Edit");
    const model = (models.find(m => m[0] === "h3image") || models[0])[0];
    const given = adoptShotPictures(shot.text);
    if (given.length) Media.toast(`3D scene: ${given.join(", ")} (from the shot), so the photo keeps that look.`);
    const look = [fromShot(shot.text), shot.setting, shot.style].map(x => String(x || "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "")).filter(Boolean).join(". ");
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(size.aspect || ""), A = m && +m[1] > 0 && +m[2] > 0 ? +m[1] / +m[2] : s.bg.aspect;
    // drawn at about 2 MP (the people pasted in, the holes filled); the edit model then makes it at the quality's size
    const L = 1600, W = Math.round((A >= 1 ? L : L * A) / 8) * 8, H = Math.round(W / A / 8) * 8, size0 = [s.cv.width, s.cv.height];
    const mp = model === "h3image" ? state.caps?.h3image_quality?.[size.quality] ?? null : null;
    try {
      say("Drawing the shot camera's view and sending it to the edit model…");
      return await makePhoto([W, H], 0, camForRender(0), look, model, true, false, true, mp);
    } finally { if (s) { s.cv.width = size0[0]; s.cv.height = size0[1]; s.dirty = true; } }
  }
  async function renderForShot(id, i, opts = {}, say = () => {}) {
    const sh = Shots.shotOfScene(id);
    const r = await autoRender(id, { text: sh?.action || "", quality: opts.quality }, say);
    Shots.useScene(i, r.shot);
    return r;
  }
  /* Draw a scene's render with the choices its Render window would pick: start from the picture when the scene starts
     as it, else a photo of its first frame that matches (or a new one), else as drawn; the objects' pictures on H3
     Reference when there are any; the Qwen gap fill as last set. o: {text (what happens; <Picture N> and {Object}
     tags), look (how the photo looks), quality, fill}. Returns {req, shot, start, refs}. */
  async function autoRender(id, o = {}, say = () => {}) {
    await openReady(id, say);
    const text = o.text || "";
    const given = adoptShotPictures(text);
    if (given.length) Media.toast(`3D scene: ${given.join(", ")} (from the shot), so H3 Reference keeps that look.`);
    const cam0 = camForRender(0), photos = s.photos.map(p => ({ ...p, it: state.items.get(p.id) })).filter(p => p.it?.status === "done" && p.it.files?.length);
    const best = photos.reverse().find(p => Math.abs(p.t) < 0.5 / FPS && camDiff(p.cam, cam0) < 0.02);
    const start = o.start || (s.sc.picture && startsAsPicture() ? "picture" : best ? `photo:${best.id}` : editModels().length ? "newphoto" : s.sc.picture ? "picture" : "composite");
    const refs = picObjs().length > 0 && refsReady();
    const r = await buildRender({ start, look: o.look ?? lastLook(), fill: o.fill ?? lastFill(), refs, hold: start === "newphoto" || start.startsWith("photo:") ? "loose" : "normal",
      quality: ["draft", "standard", "full"].includes(o.quality) ? o.quality : "standard", what: fromShot(text) || defaultWhat() }, say);
    return { ...r, start, refs };
  }
  // The open scene (V2's viewport), for its panels: its objects, camera and length as the builder has them now.
  const current = () => s && s.bg ? { id: s.id, sc: s.sc, objs: s.objs, camKeys: s.camKeys, seconds: s.seconds, t: s.t, sel: s.sel, camSel: !!s.camSel,
    moves: cameraMoves(), pictures: picObjs().length, refsReady: refsReady(), edit: editModels().map(m => m[0]) } : null;
  /* A crane (jib) move: the camera on an arm of a given length round a pivot behind it. From the playhead, over the
     length of the move, the arm rises or falls (boom, degrees up from level) and swings round (degrees, + to the left),
     while the camera keeps looking at the point it looks at now, or keeps facing along the arm. It's written as camera
     keys every quarter second along the arc (eased in and out, or steady), replacing the keys in that time; lens,
     roll, focus and shake carry on from the camera at the playhead. The rig is kept to draw it from outside. */
  function craneDialog() {
    if (!s?.bg) return;
    const c0 = camBase(s.t), u = s.bg.empty ? "m" : "units", left = Math.max(0.5, dur() - s.t);
    const box = document.createElement("div");
    box.className = "m3-make";
    box.innerHTML = `<p class="hint">From ${s.t.toFixed(2)} s, the camera rides a crane arm round a pivot behind it. Its keys in that time are replaced (↶ Undo takes it back).</p>
      <div class="row2"><div class="field"><label for="cr-len">Arm length <span class="opt">${u}</span></label><input type="number" id="cr-len" min="0.2" step="0.1" value="${(s.bg.empty ? 3 : +(s.bg.dmed * 0.75).toPrecision(2))}"></div>
        <div class="field"><label for="cr-sec">Length of the move <span class="opt">s</span></label><input type="number" id="cr-sec" min="0.5" step="0.5" max="${left.toFixed(2)}" value="${Math.min(left, 3).toFixed(1)}"></div></div>
      <div class="row2"><div class="field"><label for="cr-b0">Boom from <span class="opt">° up</span></label><input type="number" id="cr-b0" min="-60" max="80" step="5" value="0"></div>
        <div class="field"><label for="cr-b1">Boom to <span class="opt">° up</span></label><input type="number" id="cr-b1" min="-60" max="80" step="5" value="30"></div></div>
      <div class="row2"><div class="field"><label for="cr-sw">Swing <span class="opt">°, + to the left</span></label><input type="number" id="cr-sw" min="-180" max="180" step="5" value="0"></div>
        <div class="field"><label for="cr-aim">The camera</label><select id="cr-aim"><option value="point">Keeps looking at the same point</option><option value="arm">Keeps facing along the arm</option></select></div></div>
      <div class="field"><label for="cr-ease">Speed</label><select id="cr-ease"><option value="inout">Eases in and out</option><option value="steady">Steady</option></select></div>
      <p class="hint cr-say"></p>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="grow"></span><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="go">🏗 Make the move</button>`;
    const win = WM.open({ id: "scene3d-crane", title: `Crane move · ${s.sc.name}`, content: box, footer: foot, width: 480, height: 470, modal: true });
    const val = id => +box.querySelector(id).value;
    const say = () => {
      const b0 = val("#cr-b0"), b1 = val("#cr-b1"), sw = val("#cr-sw");
      box.querySelector(".cr-say").textContent = `It ${b1 > b0 ? "rises" : b1 < b0 ? "lowers" : "stays level"}${sw ? ` and swings ${Math.abs(sw)}° to the ${sw > 0 ? "left" : "right"}` : ""}, from ${s.t.toFixed(2)} s to ${(s.t + Math.min(val("#cr-sec"), left)).toFixed(2)} s.`;
    };
    box.addEventListener("input", say); say();
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = () => {
      const L = Math.max(0.05, val("#cr-len")), sec = Math.max(0.25, Math.min(val("#cr-sec"), left));
      craneMove(c0, { L, sec, b0: val("#cr-b0"), b1: val("#cr-b1"), sw: val("#cr-sw"), aim: box.querySelector("#cr-aim").value, ease: box.querySelector("#cr-ease").value });
      win.close();
      Media.toast("Crane move made: scrub or ▶ play to see it; ↶ Undo takes it back.");
    };
  }
  function craneMove(c0, o) {
    const t0 = s.t, t1 = Math.min(dur(), t0 + o.sec), E0 = eyeOf(c0), Y = [0, 1, 0];
    const h = az => [-Math.sin(az * rad), 0, -Math.cos(az * rad)];  // level, turned by az (the camera faces h(yaw))
    const armAt = (b, az) => addv(mulv(h(az), Math.cos(b * rad) * o.L), mulv(Y, Math.sin(b * rad) * o.L));
    const P = sub(E0, armAt(o.b0, c0.yaw)), A = c0.target.slice();  // the pivot behind and below; the point it looks at
    const keep = { ...(c0.lens ? { lens: c0.lens } : {}), ...(c0.roll ? { roll: c0.roll } : {}), ...(typeof c0.shake === "number" ? { shake: c0.shake } : {}) };
    const n = Math.max(2, Math.ceil((t1 - t0) * 4)), keys = [];
    for (let j = 0; j <= n; j++) {
      const u = j / n, e = o.ease === "inout" ? u * u * (3 - 2 * u) : u, t = t0 + (t1 - t0) * u;
      const b = o.b0 + (o.b1 - o.b0) * e, az = c0.yaw + o.sw * e, E = addv(P, armAt(b, az));
      let k;
      if (o.aim === "point") {
        const v = sub(E, A), d = Math.hypot(...v);
        k = { yaw: Math.atan2(v[0], v[2]) / rad, pitch: Math.asin(Math.max(-1, Math.min(1, v[1] / d))) / rad, dist: d, target: A.slice() };
        if (c0.focus) k.focus = d;  // stays on what it looks at
      } else {
        const yaw = c0.yaw + o.sw * e, d = c0.dist;
        k = { yaw, pitch: c0.pitch, dist: d, target: sub(E, mulv(dirOf({ yaw, pitch: c0.pitch }), d)) };
        if (c0.focus) k.focus = c0.focus;
      }
      const prev = keys.length ? keys.at(-1).yaw : c0.yaw;  // no jump round the circle between keys
      k.yaw += Math.round((prev - k.yaw) / 360) * 360;
      keys.push({ t: Math.round(t * 1000) / 1000, ...keep, ...k });
    }
    s.camKeys = [...s.camKeys.filter(k => k.t < t0 - 0.5 / FPS || k.t > t1 + 0.5 / FPS), ...keys].sort((a, b) => a.t - b.t);
    // the move's own easing is in where its keys are; the key before it shouldn't ease into it twice
    s.sc.fx = { ...(s.sc.fx || {}), crane: { pivot: P, L: o.L, t0, t1 } };
    if (s.camObj && !s.camFree) { s.cam = outsideView(); s.camFree = true; }
    save(); renderSide(); s.dirty = true;
  }

  function toShot() { s.cam = shotCam(); s.dirty = true; }
  function eye() { const c = s.cam, y = c.yaw * rad, p = c.pitch * rad; return [c.target[0] + c.dist * Math.cos(p) * Math.sin(y), c.target[1] + c.dist * Math.sin(p), c.target[2] + c.dist * Math.cos(p) * Math.cos(y)]; }
  function frameSize() { const dpr = Math.min(2, window.devicePixelRatio || 1); return [Math.max(1, Math.round(s.cv.clientWidth * dpr)), Math.max(1, Math.round(s.cv.clientHeight * dpr))]; }
  // vertical half-angle: the picture's, widened so its whole width fits a narrower window
  function tanY(W, H, cam = s.cam) { const f = fovOf(cam); return Math.max(f.tv, f.t / (W / H)); }
  function viewProj(W, H, cam = s.cam) {
    const e = eyeOf(cam);
    return { e, VP: mul4(perspective(2 * Math.atan(tanY(W, H, cam)), W / H, s.bg.dmed * 0.01, s.bg.dmed * 50), lookAt(e, cam.target, axesOf(cam).u)) };
  }
  const eyeOf = c => { const y = c.yaw * rad, p = c.pitch * rad; return [c.target[0] + c.dist * Math.cos(p) * Math.sin(y), c.target[1] + c.dist * Math.sin(p), c.target[2] + c.dist * Math.cos(p) * Math.cos(y)]; };
  // r (rendering a frame): { size: [W, H], t, cam, mask: "all" | "objects" } -- no paths or selection, black behind
  function draw(r = null) {
    const [W, H] = r?.size || frameSize();
    if (s.cv.width !== W || s.cv.height !== H) { s.cv.width = W; s.cv.height = H; }
    const t = r ? r.t : s.t, cam = r?.cam || s.cam;
    for (const o of s.objs) figureMesh(o, t);
    const { e, VP } = viewProj(W, H, cam), y = (cam.yaw - 40) * rad, key = [Math.sin(y) * 0.6, 0.85, Math.cos(y) * 0.6 + 0.3];
    if (r?.proj) {  // the photo painted onto the scene from its camera; what that camera couldn't see is a hole
      const P = { ...r.proj, mask: !!r.mask };
      s.gpu.begin(W, H, [0, 0, 0], r.mask ? 1 : 0);
      s.gpu.draw(s.bgMesh, { VP, M: ID, M0: ID, eye: e, key, proj: P });
      s.gpu.draw(P.sphere, { VP, M: ID, M0: ID, eye: e, key, proj: P });
      for (const o of s.objs) {
        if (!o.mesh || !o.pos || o.hidden || r.skip?.includes(o)) continue;
        s.gpu.draw(o.mesh, { VP, M: matOf(o, fitPose(o, t, P)), M0: matOf(o, fitPose(o, P.t0, P)), eye: e, key, proj: P, fit: P.fits?.[o.id] });
      }
      return;
    }
    const sky = s.bg.empty ? hexRgb(s.sc.backdrop?.sky || "#c9d3de") : null;
    // looking through the camera with an aperture: the scene goes through the depth-of-field blur (overlays after stay sharp)
    const blur = !r && s.dofBlur && fstop() > 0 && !(s.camObj && s.camFree);
    if (blur) dofBegin(W, H);
    if (sky && r?.mask) s.gpu.begin(W, H, [0, 0, 0], 1);  // the open sky is H3's to make
    else if (sky) s.gpu.begin(W, H, sky, 1);
    else s.gpu.begin(W, H, r ? [0, 0, 0] : G().themeBg(s.cv), r && !r.mask ? 0 : 1);  // a frame: holes stay see-through, to fill
    if (!r) frameOverlay();
    const white = [1, 1, 1], black = [0, 0, 0];
    if (r?.mask) s.gpu.draw(s.bgMesh, { VP, M: ID, eye: e, key, solid: r.mask === "all" ? white : black });
    else if (s.showBg || r) s.gpu.draw(s.bgMesh, { VP, M: ID, eye: e, key, unlit: true });
    s.objs.forEach((o, i) => {
      if (!o.mesh || !o.pos || o.hidden || r?.skip?.includes(o)) return;
      s.gpu.draw(o.mesh, { VP, M: matOf(o, poseAt(o, t)), eye: e, key, look: !r && s.clay ? 1 : 0,
        tint: !r && i === s.sel ? [0.06, 0.04, 0.0] : null, solid: r?.mask ? white : null });
    });
    if (blur) dofEnd(0, 0, W, H, cam, tanY(W, H, cam));
    if (r) return;
    const o = s.objs[s.sel];
    s.gl.disable(s.gl.DEPTH_TEST);
    const path = (fn, color) => {  // a path over the whole length, sampled every frame
      const pts = [], n = Math.round(dur() * FPS);
      let prev = fn(0);
      for (let f = 1; f <= n; f++) { const q = fn(f / FPS); pts.push(...prev, ...q); prev = q; }
      if (pts.length) s.gpu.lines(pts, VP, color);
    };
    if (o?.mesh && o.keys?.length > 1) path(t => poseAt(o, t).pos, [1, 0.77, 0.24, 0.9]);
    const cr = s.sc.fx?.crane;
    if (camShown() && cr?.pivot && s.t >= cr.t0 - 1e-3 && s.t <= cr.t1 + 1e-3) {  // the crane: its post, arm and counterweight
      const P = cr.pivot, E = eyeOf(camBase(s.t)), arm = norm(sub(E, P)), foot = [P[0], s.bg.empty ? s.bg.floor : P[1] - cr.L * 0.6, P[2]];
      s.gpu.lines([...foot, ...P, ...P, ...E, ...P, ...addv(P, mulv(arm, -cr.L * 0.3))], VP, [0.95, 0.7, 0.3, 0.85]);
    }
    if (camShown()) {  // the shot camera as an object
      if (s.camKeys.length > 1) {  // its dolly path: the line, a dot each second, and a faint camera at each key
        path(t => eyeOf(camAt(t)), [0.48, 0.64, 1, 0.9]);
        const dots = [], d = s.bg.dmed * 0.025;
        for (let k = 0; k <= Math.floor(dur() + 1e-6); k++) {
          const q = eyeOf(camAt(k));
          dots.push([q[0] - d, q[1], q[2]], [q[0] + d, q[1], q[2]], [q[0], q[1] - d, q[2]], [q[0], q[1] + d, q[2]], [q[0], q[1], q[2] - d], [q[0], q[1], q[2] + d]);
        }
        s.gpu.lines(dots.flat(), VP, [0.75, 0.85, 1, 1]);
        // a faint camera at each key (many keys, as a crane move makes: just the first and the last)
        const K = s.camKeys, ghosts = K.length > 6 ? [K[0], K.at(-1)] : K;
        for (const k of ghosts) if (!near(k.t, s.t)) s.gpu.lines(camFrame(camAt(k.t)).flat(), VP, [0.48, 0.64, 1, 0.35]);
      }
      s.gpu.lines(camFrame(camForRender(s.t)).flat(), VP, s.camSel ? [1, 0.6, 0.2, 1] : [0.48, 0.64, 1, 1]);
      const dr = dofRange(camForRender(s.t));
      if (dr) {  // the plane in focus (yellow) and the near and far limits of what's sharp (faint)
        const c = camForRender(s.t), E = eyeOf(c), { f, r: rr, u } = axesOf(c), fv = fovOf(c);
        const rect = z => { const q = (x, y) => addv(E, addv(mulv(f, z), addv(mulv(rr, x * fv.t * z), mulv(u, y * fv.tv * z)))), cs = [q(-1, -1), q(1, -1), q(1, 1), q(-1, 1)], out = [];
          for (let k = 0; k < 4; k++) out.push(...cs[k], ...cs[(k + 1) % 4]); return out; };
        s.gpu.lines(rect(dr.F), VP, [1, 0.85, 0.2, 0.9]);
        const lim = [rect(dr.near), ...(Number.isFinite(dr.far) && dr.far < s.bg.dmed * 30 ? [rect(dr.far)] : [])].flat();
        s.gpu.lines(lim, VP, [1, 0.85, 0.2, 0.3]);
      }
    } else if (s.camKeys.length > 1 && s.camFree) {
      path(t => eyeOf(camAt(t)), [0.48, 0.64, 1, 0.9]);
      // the camera at the playhead: a small frustum
      const c = camAt(s.t), ce = eyeOf(c), { f, r, u } = axesOf(c), L = s.bg.dmed * 0.12;
      const fv = fovOf(c), corner = (x, y) => addv(ce, mulv(addv(f, addv(mulv(r, x * fv.t), mulv(u, y * fv.tv))), L));
      const cs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], fr = [];
      for (let k = 0; k < 4; k++) fr.push(...ce, ...cs[k], ...cs[k], ...cs[(k + 1) % 4]);
      s.gpu.lines(fr, VP, [0.48, 0.64, 1, 1]);
    }
    s.gl.enable(s.gl.DEPTH_TEST);
    if (o?.mesh && o.pos && !o.hidden) {  // the selected object's box
      const c = boxCorners(o);
      const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]], pts = [];
      for (const [a, b] of E) pts.push(...c[a], ...c[b]);
      s.gl.disable(s.gl.DEPTH_TEST); s.gpu.lines(pts, VP, [1, 0.48, 0.27, 0.9]); s.gl.enable(s.gl.DEPTH_TEST);
    }
    drawGizmo(VP, e, key);
    drawPip(W, H);
    syncFloat();
  }
  /* The dolly preview: while you look at the shot camera from outside, a small picture in the corner shows what it
     sees at the playhead (its move, zoom and roll as you scrub or play), at the shot's shape. */
  function drawPip(W, H) {
    const el = s.root.querySelector(".s3-pip"), on = s.pip && camShown();
    if (el && el.hidden === on) el.hidden = !on;
    if (!on) return;
    const gl = s.gl, dpr = W / Math.max(1, s.cv.clientWidth), A = s.bg.aspect;
    let pw = Math.min(s.cv.clientWidth * 0.3, 300), ph = pw / A;
    if (ph > s.cv.clientHeight * 0.38) { ph = s.cv.clientHeight * 0.38; pw = ph * A; }
    const m = 10, x = Math.round(m * dpr), y = Math.round(m * dpr), w = Math.round(pw * dpr), h = Math.round(ph * dpr);
    const c = camForRender(s.t), { e, VP } = viewProj(w, h, c), ky = (c.yaw - 40) * rad, key = [Math.sin(ky) * 0.6, 0.85, Math.cos(ky) * 0.6 + 0.3];
    const sky = s.bg.empty ? hexRgb(s.sc.backdrop?.sky || "#c9d3de") : [0.06, 0.06, 0.07];
    const blur = s.dofBlur && fstop() > 0;
    if (blur) { dofBegin(w, h); s.gpu.begin(w, h, sky, 1); }
    else { gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h); gl.viewport(x, y, w, h); gl.clearColor(sky[0], sky[1], sky[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); }
    s.gpu.draw(s.bgMesh, { VP, M: ID, eye: e, key, unlit: true });
    for (const o of s.objs) if (o.mesh && o.pos && !o.hidden) s.gpu.draw(o.mesh, { VP, M: matOf(o, poseAt(o, s.t)), eye: e, key, look: s.clay ? 1 : 0 });
    if (blur) { gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h); dofEnd(x, y, w, h, c, tanY(w, h, c)); }
    gl.disable(gl.SCISSOR_TEST); gl.viewport(0, 0, W, H);
    Object.assign(el.style, { left: `${m - 1}px`, bottom: `${m - 1}px`, width: `${w / dpr + 2}px`, height: `${h / dpr + 2}px` });
    const lab = `🎥 ${s.t.toFixed(2)} s · ${Math.round(c.lens || baseLens())} mm${c.roll ? ` · roll ${Math.round(c.roll)}°` : ""}${fstop() ? ` · f/${fstop()} @ ${focusOf(c).toFixed(1)} m` : ""}${c.shake ? ` · shake ${Math.round(c.shake)}%` : ""}`;
    const l = el.querySelector(".s3-pip-l"); if (l.textContent !== lab) l.textContent = lab;
  }
  /* The depth-of-field preview: the scene is drawn into a picture with its depth, then each pixel is blurred by its
     circle of confusion (thin lens: aperture f/N, focal length, focus distance), gathered from 48 taps on a spiral.
     A tap behind the pixel counts only as far as the pixel itself is blurred, so a sharp subject doesn't take on the
     blurred background around it. Only for the view: renders, photos and what H3 follows stay sharp. */
  function dofBegin(w, h) {
    const gl = s.gl; let d = s.dofFb;
    if (!d || d.w !== w || d.h !== h) {
      if (d) { gl.deleteFramebuffer(d.fb); gl.deleteTexture(d.col); gl.deleteTexture(d.dep); }
      const tx = (fmt, f, type, filt) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, f, type, null);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filt], [gl.TEXTURE_MAG_FILTER, filt], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        return t; };
      const col = tx(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR), dep = tx(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, col, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dep, 0);
      d = s.dofFb = { fb, col, dep, w, h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb);
  }
  const DOF_VS = "#version 300 es\nout vec2 vUv; void main() { vec2 q = vec2(float((gl_VertexID * 2) & 2), float(gl_VertexID & 2)); vUv = q; gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0); }";
  const DOF_FS = `#version 300 es
    precision highp float;
    uniform sampler2D uCol, uDep; uniform vec2 uPx; uniform float uNear, uFar, uF, uFocal, uAper, uScale, uMax;
    in vec2 vUv; out vec4 outC;
    float lin(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
    float coc(float z) { float zm = max(z, 1e-3) * 1000.0, F = uF * 1000.0; return min(uAper * uFocal * abs(zm - F) / (zm * max(F - uFocal, 1.0)) * uScale, uMax); }
    void main() {
      float z0 = lin(texture(uDep, vUv).r), c0 = coc(z0);
      vec3 acc = texture(uCol, vUv).rgb; float wsum = 1.0;
      for (int i = 1; i < 48; i++) {
        float rr = sqrt(float(i) / 48.0) * uMax, a = float(i) * 2.39996;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * rr * uPx;
        float zt = lin(texture(uDep, uv).r), ct = coc(zt);
        if (zt > z0) ct = min(ct, c0);
        float w = clamp(ct - rr + 1.0, 0.0, 1.0);
        acc += texture(uCol, uv).rgb * w; wsum += w;
      }
      outC = vec4(acc / wsum, 1.0);
    }`;
  function dofProg() {
    if (s.dofProg) return s.dofProg;
    const gl = s.gl, sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, DOF_VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, DOF_FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    s.dofProg = { p, vao: gl.createVertexArray(), u: n => gl.getUniformLocation(p, n) };
    return s.dofProg;
  }
  // draw the blurred picture into the canvas at (x, y, w, h), through camera c (ty: its vertical half-angle's tangent)
  function dofEnd(x, y, w, h, c, ty) {
    const gl = s.gl, d = s.dofFb;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let P; try { P = dofProg(); } catch (e) { s.dofBlur = false; console.warn("DoF preview:", e); return; }
    const f = c.lens || baseLens(), N = fstop();
    gl.viewport(x, y, w, h); gl.disable(gl.DEPTH_TEST); gl.useProgram(P.p); gl.bindVertexArray(P.vao);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, d.col); gl.uniform1i(P.u("uCol"), 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, d.dep); gl.uniform1i(P.u("uDep"), 6);
    gl.uniform2f(P.u("uPx"), 1 / w, 1 / h);
    gl.uniform1f(P.u("uNear"), s.bg.dmed * 0.01); gl.uniform1f(P.u("uFar"), s.bg.dmed * 50);
    gl.uniform1f(P.u("uF"), focusOf(c)); gl.uniform1f(P.u("uFocal"), f); gl.uniform1f(P.u("uAper"), f / N);
    gl.uniform1f(P.u("uScale"), h / (2 * ty * f));  // pixels per millimetre on the sensor
    gl.uniform1f(P.u("uMax"), Math.max(4, Math.min(24, h / 40)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null); gl.enable(gl.DEPTH_TEST); gl.activeTexture(gl.TEXTURE0);
  }
  function loop() { if (!s || s.closed) return; if (s.dirty) { s.dirty = false; draw(); } s.raf = requestAnimationFrame(loop); }

  // The ray under a point of the canvas (CSS pixels): origin and direction.
  function rayAt(px, py) {
    const W = s.cv.clientWidth, H = s.cv.clientHeight, e = eye(), { f, r, u } = axesOf(s.cam);
    const ty = tanY(W, H), tx = ty * W / H, nx = 2 * px / W - 1, ny = 1 - 2 * py / H;
    return { o: e, d: norm(addv(f, addv(mulv(r, nx * tx), mulv(u, ny * ty)))) };
  }
  // Which object is under the point: the ray against each object's box, in the object's own space.
  function pick(px, py) {
    const { o: ro, d: rd } = rayAt(px, py);
    let best = -1, bt = Infinity;
    s.objs.forEach((o, i) => {
      if (!o.mesh || !o.pos || o.hidden) return;
      const Mi = inv4(matOf(o)); if (!Mi) return;
      const lo = xf(Mi, ro, 1), ld = xf(Mi, rd, 0);
      let t0 = -Infinity, t1 = Infinity;
      for (let j = 0; j < 3; j++) {
        if (Math.abs(ld[j]) < 1e-12) { if (lo[j] < o.mesh.lo[j] || lo[j] > o.mesh.hi[j]) return; continue; }
        let ta = (o.mesh.lo[j] - lo[j]) / ld[j], tb = (o.mesh.hi[j] - lo[j]) / ld[j]; if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (t1 >= Math.max(0, t0) && t0 < bt) { bt = t0; best = i; }
    });
    return best;
  }

  function wire(root, foot) {
    const cv = s.cv;
    let drag = null;
    const hint = txt => { const h = foot.querySelector(".s3-foot"); h.textContent = txt || "Drag: orbit · Right-drag: pan · Wheel: zoom · Right-click: menu"; };
    // An object being moved, raised, turned or sized, by a drag or following the mouse (from the menu or G/L/R/S).
    function grab(mode, i, px, py, cx, cy) {
      const o = s.objs[i], P = poseAt(o, s.t), ray = rayAt(px, py), t = (P.pos[1] - ray.o[1]) / (ray.d[1] || 1e-9);
      const at = addv(ray.o, mulv(ray.d, t));
      return { mode, o, x: cx, y: cy, off: Math.abs(ray.d[1]) > 1e-4 && t > 0 ? sub(P.pos, at) : [0, 0, 0], dist: Math.hypot(...sub(P.pos, eye())),
        snap: JSON.stringify({ pos: o.pos, yaw: o.yaw || 0, pitch: o.pitch || 0, roll: o.roll || 0, scale: o.scale, stretch: o.stretch || null, keys: o.keys || [] }) };
    }
    function step(g, e) {
      const r = cv.getBoundingClientRect(), o = g.o, P = poseAt(o, s.t), dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (g.mode === "move") {
        const ray = rayAt(e.clientX - r.left, e.clientY - r.top);
        if (Math.abs(ray.d[1]) > 1e-4) {
          const t = (P.pos[1] - ray.o[1]) / ray.d[1];
          if (t > 0 && t < s.bg.dmed * 40) { const at = addv(ray.o, mulv(ray.d, t)); editPose(o, { pos: [at[0] + g.off[0], P.pos[1], at[2] + g.off[2]] }); g.moved = true; }
        }
      } else if (g.mode === "lift") {
        const k = g.dist * 2 * tanY(cv.clientWidth, cv.clientHeight) / cv.clientHeight;
        editPose(o, { pos: [P.pos[0], P.pos[1] - dy * k, P.pos[2]] }); g.moved = true;
      } else if (g.mode === "rotate") { editPose(o, { yaw: P.yaw + dx * 0.5 }); g.moved = true; }
      else if (g.mode === "scale") { editPose(o, { scale: Math.max(1e-5, P.scale * Math.exp((dx - dy) * 0.006)) }); g.moved = true; }
      g.x = e.clientX; g.y = e.clientY; s.dirty = true;
    }
    startModal = (mode, px, py) => {
      const o = s.objs[s.sel]; if (!o?.mesh || !o.pos) return;
      if (s.playing) stop();
      const r = cv.getBoundingClientRect();
      if (px == null) ({ px, py } = s.mouse || { px: cv.clientWidth / 2, py: cv.clientHeight / 2 });
      s.modal = grab(mode, s.sel, px, py, r.left + px, r.top + py);
      hint(`${TOOLS[mode]} ${o.name}: move the mouse (X, Y or Z: along that axis), then click to keep it (Esc or right-click: cancel)`);
      cv.focus();
    };
    endModal = keep => {
      const g = s.modal; if (!g) return;
      s.modal = null; hint();
      if (keep) { if (g.moved) { settleStretch(g.o); save(); } } else Object.assign(g.o, JSON.parse(g.snap));
      renderSide(); s.dirty = true;
    };
    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointerdown", e => {
      if (!s?.bg) return;
      cv.focus();
      if (s.modal) { e.preventDefault(); endModal(e.button === 0); return; }
      cv.setPointerCapture(e.pointerId);
      const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const hh = e.button === 0 ? handleAt(px, py) : null;
      if (hh) { if (s.playing) stop(); drag = s.dragH = grabHandle(hh, e.clientX, e.clientY); s.dirty = true; return; }
      if (e.button === 0 && pickCam(px, py)) { selectCam(); drag = null; return; }
      const hit = e.button === 0 ? pick(px, py) : -1;
      if (hit >= 0) {
        select(hit);
        if (s.playing) stop();
        drag = grab(e.shiftKey ? "lift" : s.tool, hit, px, py, e.clientX, e.clientY);
      } else drag = { mode: e.button === 0 && !e.shiftKey ? "orbit" : "pan", x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, right: e.button === 2 };
      s.dirty = true;
    });
    cv.addEventListener("pointermove", e => {
      const r = cv.getBoundingClientRect();
      s.mouse = { px: e.clientX - r.left, py: e.clientY - r.top };
      if (s.modal) return s.modal.h ? stepHandle(s.modal, e, s.mouse.px, s.mouse.py) : step(s.modal, e);
      if (drag?.h) return stepHandle(drag, e, s.mouse.px, s.mouse.py);
      if (!drag) {  // hovering: light up the handle under the mouse
        const hv = hkey(handleAt(s.mouse.px, s.mouse.py));
        if (hv !== s.hover) { s.hover = hv; cv.style.cursor = hv ? "pointer" : ""; s.dirty = true; }
        return;
      }
      if (drag.o) return step(drag, e);
      if (!drag.went) {  // a click (or a right-click for the menu) until it moves a little
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
        drag.went = true;
        if (s.camObj && !s.camFree) { delete s.cam.roll; delete s.cam.lens; }  // outside: a level view, at the scene's lens
        if (s.camKeys.length || s.camObj) { s.camFree = true; renderCam(); }
      }
      if (drag.mode === "orbit") {
        s.cam.yaw -= (e.clientX - drag.x) * 0.3; s.cam.pitch = Math.max(-89, Math.min(89, s.cam.pitch + (e.clientY - drag.y) * 0.3));
        drag.x = e.clientX; drag.y = e.clientY;
      } else if (drag.mode === "pan") {
        const k = s.cam.dist * 0.0018, y = s.cam.yaw * rad, p = s.cam.pitch * rad;
        const right = [Math.cos(y), 0, -Math.sin(y)], up = [-Math.sin(p) * Math.sin(y), Math.cos(p), -Math.sin(p) * Math.cos(y)];
        for (let c = 0; c < 3; c++) s.cam.target[c] += (-(e.clientX - drag.x) * right[c] + (e.clientY - drag.y) * up[c]) * k;
        drag.x = e.clientX; drag.y = e.clientY;
      }
      s.dirty = true;
    });
    cv.addEventListener("pointerup", e => {
      const d = drag; drag = null; s.dragH = null;
      if (d?.moved) { if (d.h) settleStretch(d.o); save(); renderSide(); s.dirty = true; }
      if (d?.right && !d.went) {  // a right-click: the object's menu, or the ground's
        const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, hit = pick(px, py);
        if (hit >= 0) objMenu(hit, e.clientX, e.clientY, px, py); else spaceMenu(e.clientX, e.clientY, px, py);
      }
    });
    cv.addEventListener("wheel", e => { e.preventDefault(); if (!s?.bg) return; if (s.camObj && !s.camFree) { delete s.cam.roll; delete s.cam.lens; s.camFree = true; renderCam(); } s.cam.dist = Math.max(s.bg.dmed * 0.05, Math.min(s.bg.dmed * 20, s.cam.dist * Math.exp(e.deltaY * 0.0012))); s.dirty = true; }, { passive: false });
    cv.addEventListener("keydown", e => {
      const o = s.objs[s.sel];
      if (s.modal) {
        const ax = { x: 0, y: 1, z: 2 }[e.key.toLowerCase()];
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endModal(false); }
        else if (e.key === "Enter") { e.preventDefault(); endModal(true); }
        else if (ax != null) {  // along one axis only, as in Blender: G then X
          e.preventDefault();
          const m0 = s.modal, mode = m0.h ? { move: "move", rot: "rotate", scale: "scale", uni: "scale" }[m0.h.kind] : m0.mode;
          const h = gizmoOf(m0.o, mode)?.hs.find(q => q.i === ax); if (!h || mode === "lift") return;
          Object.assign(m0.o, JSON.parse(m0.snap));
          const r = cv.getBoundingClientRect(), mp = s.mouse || { px: cv.clientWidth / 2, py: cv.clientHeight / 2 };
          s.modal = { ...grabHandle(h, r.left + mp.px, r.top + mp.py, m0.o), snap: m0.snap };
          hint(`${TOOLS[mode]} ${m0.o.name} along ${"XYZ"[ax]}: move the mouse, then click to keep it (Esc or right-click: cancel)`);
          s.dirty = true;
        }
        return;
      }
      const k = e.key.toLowerCase(), byKey = { g: "move", l: "lift", r: "rotate", s: "scale" }[k];
      if (byKey && o && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); startModal(byKey); }
      else if (k === "d" && e.shiftKey && o) { e.preventDefault(); duplicate(o); }
      else if ((e.key === "Delete" || e.key === "Backspace") && o) { e.preventDefault(); removeSel(); }
      else if (e.key === "Escape" && (s.sel >= 0 || s.camSel)) { e.stopPropagation(); s.sel = -1; s.camSel = false; renderSide(); s.dirty = true; }
      else if (e.key === " ") { e.preventDefault(); play(); }
    });
    root.querySelector(".s3-objs").addEventListener("contextmenu", e => {
      const li = e.target.closest("[data-i]"); if (!li) return;
      e.preventDefault(); objMenu(+li.dataset.i, e.clientX, e.clientY);
    });
    const all = [root, foot];
    all.forEach(el => el.addEventListener("click", e => {
      const b = e.target.closest("[data-act],[data-tool],[data-i]"); if (!b || !s) return;
      const a = b.dataset.act, o = s.objs[s.sel];
      if (a === "shot") { if (s.bg) toShot(); return; }
      if (a === "cam-sel") { if (s.bg) { if (!camShown()) { s.cam = outsideView(); s.camFree = true; } selectCam(); } return; }
      if (a === "cam-through") { if (s.bg) { s.cam = camForRender(s.t); s.camFree = false; s.camSel = false; renderSide(); s.dirty = true; } return; }
      if (a === "cam-outside") { if (s.bg) { s.cam = outsideView(); s.camFree = true; renderSide(); s.dirty = true; } return; }
      if (a === "pic") { draw(); s.cv.toBlob(bl => { const x = document.createElement("a"); x.href = URL.createObjectURL(bl); x.download = `${s.sc.name}_view.png`; x.click(); setTimeout(() => URL.revokeObjectURL(x.href), 4000); }); return; }
      if (a === "add") return addModel();
      if (a === "undo") return undo();
      if (a === "redo") return redo();
      if (a === "prim") return addPrim(b.dataset.prim);
      if (a === "models") { const r = b.getBoundingClientRect(); return modelMenu(r.left, r.bottom + 4); }
      if (b.dataset.tool) { s.tool = b.dataset.tool; renderTools(); s.dirty = true; return; }
      if (a === "turnl") return nudge(o, { yaw: 90 });
      if (a === "turnr") return nudge(o, { yaw: -90 });
      if (a === "floor") return dropDown(o);
      if (a === "dup") return duplicate(o);
      if (a === "render") return renderDialog();
      if (a === "depth") {
        const r = b.getBoundingClientRect();
        return Media.menu(r.left, r.top - 8, [
          [`This frame${s.camKeys.length ? ` (${s.t.toFixed(2)} s)` : ""}: PNG`, () => saveDepth("frame")],
          [`The whole clip (${frameCount()} frames): video`, () => saveDepth("video")],
          [`The whole clip (${frameCount()} frames): full-size PNGs in a .zip`, () => saveDepth("pngs")],
        ]);
      }
      if (a === "photo") return photoDialog();
      if (a === "tpl") { flushSave().catch(() => {}); return setTemplate(s.id, !s.sc.template); }
      if (a === "bd-pick") return s.root.querySelector(".s3-bdfile").click();
      if (a === "pic-file") return s.root.querySelector(".s3-picfile").click();
      if (a === "pic-inputs" && o) {
        const pics = inputPictures(), r = b.getBoundingClientRect();
        if (!pics.length) return Media.toast("The Inputs step has no keyframes or reference pictures.");
        return Media.menu(r.left, r.bottom + 4, pics.map(p => [`🖼 ${p.label}: ${p.name}`, () => { o.picture = p.ref; save(); renderSide(); }]));
      }
      if (a === "pic-clear" && o) { o.picture = null; save(); renderSide(); return; }
      if (a === "pic-crop" && o) {
        b.disabled = true;
        cropPicture(o).then(ref => { o.picture = ref; save(); renderSide(); }).catch(err => Media.toast(`Picture: ${err.message}`)).finally(() => { b.disabled = false; });
        return;
      }
      if (a === "bd-clear") { s.sc.backdrop = { ...s.sc.backdrop, picture: null }; s.sc.backdrop_url = null; return emptyChanged(); }
      if (a === "play") return play();
      if (a === "key-cam" && s.camObj && s.camFree) {  // from outside: key the camera as it is at the playhead
        if (!s.bg) return;
        editCam(camBase(s.t)); save(); renderCam(); return;
      }
      if (a === "key-cam") {
        if (!s.bg) return;
        const k = s.camKeys.find(q => near(q.t, s.t));
        const v = camOf(s.camFree ? s.cam : camBase(s.t));  // the path's own camera, not its shake
        if (k) Object.assign(k, v); else { s.camKeys.push({ t: s.t, ...v }); s.camKeys.sort((p, q) => p.t - q.t); }
        s.camFree = false; save(); renderCam(); s.dirty = true; return;
      }
      if (a === "crane") return craneDialog();
      if (a === "clear-cam") { s.camKeys = []; s.camFree = false; save(); renderCam(); s.dirty = true; return; }
      if (a === "cam-key") { setTime(s.camKeys[+b.dataset.k].t); renderSide(); s.dirty = true; return; }
      if (a === "del-cam-key") { s.camKeys.splice(+b.dataset.k, 1); save(); setTime(s.t); renderCam(); return; }
      if (a === "obj-key" && o) { setTime(o.keys[+b.dataset.k].t); renderSide(); return; }
      if (a === "del-obj-key" && o) {
        o.keys.splice(+b.dataset.k, 1);
        if (o.keys.length) fromFirstKey(o);
        if (o.keys.length < 2) o.keys = [];
        save(); renderSide(); s.dirty = true; return;
      }
      if (a === "make3d") return make3d(+b.dataset.i);
      if (a === "replace" && o?.mesh) { placement(o).then(p => { o.auto_scale = p.scale; editPose(o, p); save(); renderSide(); s.dirty = true; }); return; }
      if (a === "hide" && o) { o.hidden = !o.hidden; save(); renderSide(); s.dirty = true; return; }
      if (a === "remove") return removeSel();
      if (b.dataset.i != null && !a) { s.sel = +b.dataset.i; renderSide(); s.dirty = true; }
    }));
    root.addEventListener("change", async e => {
      const id = e.target.id;
      if (s.sc.kind === "empty" && ["s3-aspect", "s3-lens", "s3-sky", "s3-floor"].includes(id)) {
        if (id === "s3-aspect") s.sc.aspect = e.target.value;
        if (id === "s3-lens") s.sc.lens = +e.target.value;
        if (id === "s3-sky") s.sc.backdrop = { ...s.sc.backdrop, sky: e.target.value };
        if (id === "s3-floor") s.sc.backdrop = { ...s.sc.backdrop, floor: e.target.value };
        return emptyChanged();
      }
      if (e.target.classList.contains("s3-picfile")) {
        const f = e.target.files[0], o = s.objs[s.sel]; e.target.value = ""; if (!f || !o) return;
        try { o.picture = await uploadBlob(f, f.name); save(); renderSide(); } catch (err) { Media.toast(`Picture: ${err.message}`); }
        return;
      }
      if (e.target.classList.contains("s3-bdfile")) {
        const f = e.target.files[0]; e.target.value = ""; if (!f) return;
        try {
          const fd = new FormData(); fd.append("file", f);
          const r = await fetch("/api/upload", { method: "POST", body: fd }), j = await r.json();
          if (!r.ok) throw new Error(j.detail || r.statusText);
          s.sc.backdrop = { ...s.sc.backdrop, picture: j.ref }; s.sc.backdrop_url = `/api/media/file?path=${encodeURIComponent(j.ref)}`;
          emptyChanged();
        } catch (err) { Media.toast(`Backdrop: ${err.message}`); }
        return;
      }
      const po = s.objs[s.sel];
      if (po?.prim === "figure" && id === "s3-gait") {
        po.gait = e.target.value || null; po._pmKey = null; po.mesh = primMesh(po); figureMesh(po, s.t); return changed(po);
      }
      if (po?.prim === "figure" && id === "s3-pose") {
        // At the playhead, like moving it: a key there once it has keys (or the playhead isn't at the start).
        const before = po.pose || "standing";
        editPose(po, { pose: e.target.value });
        const after = po.pose || "standing";
        if (after !== before) {
          // Its base pose changed its own box (sitting is shorter and deeper): keep any stretch the user gave it.
          const from = natDims("figure", before), to = natDims("figure", after), d = po.dims || from;
          po.dims = [0, 1, 2].map(c => +(to[c] * (from[c] > 1e-6 ? d[c] / from[c] : 1)).toFixed(3));
        }
        po._pmKey = null; po.mesh = primMesh(po); figureMesh(po, s.t); return changed(po);
      }
      if (po?.prim && ["s3-dw", "s3-dh", "s3-dd"].includes(id)) {
        const R = s.root, dim = x => Math.max(0.01, Math.min(500, +R.querySelector(x).value || 0.01));
        po.dims = [dim("#s3-dw"), po.prim === "plane" ? 0 : dim("#s3-dh"), dim("#s3-dd")];
        po.mesh = primMesh(po); return changed(po);
      }
      if (po?.prim && id === "s3-color") return changed(po);
      if (id === "s3-camobj") return setCamObj(e.target.checked);
      if (id === "s3-ease") {
        const k = s.camKeys.find(q => near(q.t, s.t)); if (!k) return;
        if (e.target.value) k.ease = e.target.value; else delete k.ease;
        save(); renderCam(); s.dirty = true; return;
      }
      if (id === "s3-pip") { s.pip = e.target.checked; try { localStorage.setItem("bob.s3pip", s.pip ? "1" : "0"); } catch { /* not kept */ } s.dirty = true; return; }
      const k = e.target.dataset.opt; if (!k) return;
      s[k] = e.target.checked; s.dirty = true;
    });
    root.addEventListener("input", e => {
      const o = s.objs[s.sel]; if (!o) return;
      if (e.target.id === "s3-color" && o.prim) { o.color = e.target.value; o.mesh.parts[0].base = [...hexRgb(o.color), 1]; s.dirty = true; return; }
      if (e.target.id === "s3-becomes") { o.becomes = e.target.value.slice(0, 200); return; }
      const rf = { "s3-rx": "pitch", "s3-ry": "yaw", "s3-rz": "roll" }[e.target.id];
      if (rf && o.mesh && o.pos && e.target.value !== "") editPose(o, { [rf]: +e.target.value });
      if (e.target.id === "s3-size") { editPose(o, { scale: (o.auto_scale || o.scale) * +e.target.value }); root.querySelector(".s3-size-v").textContent = `${Math.round(+e.target.value * 100)}%`; }
      s.dirty = true;
    });
    root.addEventListener("change", e => {
      if (e.target.id === "s3-face") { const o = s.objs[s.sel]; if (o) { o.face = e.target.checked; save(); renderSide(); s.dirty = true; } return; }
      if (["s3-rx", "s3-ry", "s3-rz", "s3-size", "s3-becomes"].includes(e.target.id)) { save(); renderSide(); }
    });
    // An object's picture: dropped from the gallery or the media library (a media ref), or a file from the PC.
    const th = root.querySelector(".s3-pic-th");
    th.addEventListener("dragover", e => { e.preventDefault(); th.classList.add("over"); });
    th.addEventListener("dragleave", () => th.classList.remove("over"));
    th.addEventListener("drop", async e => {
      e.preventDefault(); th.classList.remove("over");
      const o = s.objs[s.sel]; if (!o) return;
      const ref = e.dataTransfer.getData("text/x-bob-ref"), kind = e.dataTransfer.getData("text/x-bob-kind");
      try {
        if (ref) {
          if (kind && kind !== "image" || /\.(mp4|webm|mov|mkv|mp3|wav|flac|ogg|m4a)$/i.test(ref)) throw new Error("Drop a picture");
          o.picture = ref;
        } else if (e.dataTransfer.files[0]) {
          const f = e.dataTransfer.files[0];
          if (!/^image\//.test(f.type)) throw new Error("Drop a picture");
          o.picture = await uploadBlob(f, f.name);
        } else return;
        save(); renderSide();
      } catch (err) { Media.toast(`Picture: ${err.message}`); }
    });
    // undo and redo, anywhere in the scene window but a text field
    root.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.matches("input:not([type=range]):not([type=checkbox]):not([type=color]), textarea")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); redo(); }
    });
    root.querySelector(".s3-scrub").addEventListener("input", e => { if (s.playing) stop(); setTime(+e.target.value); renderSide(); });
    root.querySelector(".s3-sec").addEventListener("change", e => {
      s.seconds = Math.max(1, Math.min(10, +e.target.value || 5)); e.target.value = String(s.seconds);
      const D = dur();  // keys past the new end move to it
      for (const K of [s.camKeys, ...s.objs.map(o => o.keys || [])]) for (const k of K) if (k.t > D) k.t = D;
      save(); setTime(Math.min(s.t, D)); renderSide();
    });
  }

  function removeSel() {
    const o = s.objs[s.sel]; if (!o) return;
    s.objs.splice(s.sel, 1); s.sel = -1; save(); renderSide(); s.dirty = true;
  }
  async function addModel(id = s.root.querySelector(".s3-add").value, at = null) {
    if (!id) return;
    const md = models.find(x => x.id === id); if (!md) return;
    const o = { id: uid(), name: md.name, model: md.id, mask: md.source === s.sc.picture && !at ? md.mask : null, pos: null, yaw: 0, scale: null };
    s.objs.push(o);
    s.sel = s.objs.length - 1;
    await loadObjects();
    if (at && o.pos) { o.pos = at.slice(); save(); s.dirty = true; }
  }
  /* V2's object library: an entry dropped on the viewport at (clientX, clientY), or in front of the camera: its shape
     or 3D model, standing where that point meets the ground, with its name, what it becomes, its first picture (H3
     Reference keeps its look) and the entry it came from (lib: its LoRAs go with the shot). Returns the object. */
  async function addFromLibrary(e, cx = null, cy = null) {
    if (!s?.bg || !e) return null;
    let at = null;
    if (cx != null && cy != null) { const r = s.cv.getBoundingClientRect(); at = surfaceHit(rayAt(cx - r.left, cy - r.top)); }
    const n0 = s.objs.length;
    if (e.kind === "model" && e.model) await addModel(e.model, at); else await addPrim(PRIMS[e.prim] ? e.prim : "figure", at);
    if (s.objs.length === n0) return null;
    const o = s.objs.at(-1), base = String(e.name || "Object").trim().slice(0, 60) || "Object";
    let name = base, k = 2;
    while (s.objs.some(x => x !== o && x.name.toLowerCase() === name.toLowerCase())) name = `${base} ${k++}`;
    o.name = name; o.becomes = String(e.becomes || "").trim(); o.picture = e.pictures?.[0] || null; o.lib = e.id;
    save(); renderSide(); s.dirty = true;
    return o;
  }
  /* ---------------------------------------------------------------- camera moves (V2's camera library)
     Ready-made camera moves, worked out around the shot's subject (the selected object, else the first person, else
     the first object, else what the camera looks at) and over the scene's length. Each writes the camera keys (lens,
     focus and shake included where the move has them), replacing the ones there; ↶ Undo takes it back.
     o: {framing: "close" | "medium" | "wide" | "extreme", speed: "smooth" | "steady"}. A camera saved from a shot
     (cameraOut) is kept relative to its subject, so it fits another scene's subject the same way (applySavedCamera). */
  const FRAMING = { close: { m: 0.62, at: 0.86 }, medium: { m: 1.35, at: 0.7 }, wide: { m: 3.2, at: 0.5 }, extreme: { m: 7, at: 0.45 } };
  function camSubject() {
    const shown = s.objs.filter(o => o.mesh && o.pos && !o.hidden);
    const sel = s.objs[s.sel], o = sel && shown.includes(sel) ? sel : shown.find(x => x.prim === "figure") || shown[0] || null;
    if (!o) { const c = camBase(0); return { o: null, base: [c.target[0], c.target[1] - 1, c.target[2]], h: 1.7, yaw: 0 }; }
    const p = poseAt(o, 0), h = Math.max(0.05, (o.mesh.hi[1] - o.mesh.lo[1]) * (o.stretch?.[1] || 1) * (p.scale ?? 1));
    return { o, base: p.pos.slice(), h, yaw: o.yaw || 0 };
  }
  // A camera at `eye` looking at `target`, as the orbit the keys hold.
  function camFrom(eye, target, extra = {}) {
    const d = sub(eye, target), dist = Math.max(1e-3, Math.hypot(...d));
    return { yaw: Math.atan2(d[0], d[2]) / rad, pitch: Math.asin(Math.max(-1, Math.min(1, d[1] / dist))) / rad, dist, target: target.slice(), ...extra };
  }
  const rotY = (v, deg) => { const a = deg * rad, c = Math.cos(a), si = Math.sin(a); return [v[0] * c + v[2] * si, v[1], -v[0] * si + v[2] * c]; };
  // Keys every `step` seconds from f(u) (u from 0 to 1 over the length), the last at the end.
  const keysOf = (f, T, n) => Array.from({ length: n + 1 }, (_, i) => ({ t: +(T * i / n).toFixed(3), ...f(i / n) }));
  const CAM_MOVES = [
    { id: "static", icon: "📷", name: "Locked off", says: "Holds still on the subject." },
    { id: "push", icon: "⤵", name: "Push in", says: "Moves slowly towards the subject." },
    { id: "pull", icon: "⤴", name: "Pull back", says: "Moves slowly away, showing more of the place." },
    { id: "orbit", icon: "🔄", name: "Orbit 360°", says: "Circles all the way round the subject." },
    { id: "half", icon: "◐", name: "Half orbit", says: "Goes halfway round the subject." },
    { id: "arcl", icon: "↺", name: "Arc left", says: "Curves a little round the subject, to the left." },
    { id: "arcr", icon: "↻", name: "Arc right", says: "Curves a little round the subject, to the right." },
    { id: "truckl", icon: "⇠", name: "Track left", says: "Slides sideways to the left, keeping its direction." },
    { id: "truckr", icon: "⇢", name: "Track right", says: "Slides sideways to the right, keeping its direction." },
    { id: "craneup", icon: "🏗", name: "Crane up", says: "Rises up and looks down on the subject." },
    { id: "cranedown", icon: "⬇", name: "Crane down", says: "Comes down from above to eye level." },
    { id: "panl", icon: "◀", name: "Pan left", says: "Stays put and turns to the left." },
    { id: "panr", icon: "▶", name: "Pan right", says: "Stays put and turns to the right." },
    { id: "tiltup", icon: "▲", name: "Tilt up", says: "Stays put and tilts up from the feet to the face." },
    { id: "low", icon: "🦸", name: "Low angle", says: "Looks up at the subject from near the ground: a hero shot." },
    { id: "top", icon: "⬇️", name: "Top down", says: "Looks straight down from above." },
    { id: "handheld", icon: "🤳", name: "Handheld", says: "Held by hand, with a natural slight shake." },
    { id: "follow", icon: "🚶", name: "Follow", says: "Walks after the subject along its path, handheld." },
    { id: "zoom", icon: "🔍", name: "Zoom in", says: "Stays put and zooms in (a longer lens)." },
    { id: "vertigo", icon: "🌀", name: "Dolly zoom", says: "Pulls back while zooming in: the subject stays, the place stretches." },
    { id: "rack", icon: "🎯", name: "Push in, rack focus", says: "Pushes in while the focus pulls from the background to the subject." },
  ];
  function cameraMove(id, o = {}) {
    if (!s?.bg) return null;
    const F = FRAMING[o.framing] || FRAMING.medium, T = dur(), sub0 = camSubject();
    const tv = fovOf({ lens: baseLens() }).tv, d0 = Math.max(s.bg.dmed * 0.05, sub0.h * F.m / (2 * tv));
    const look = [sub0.base[0], sub0.base[1] + sub0.h * F.at, sub0.base[2]];
    const yaw0 = camBase(0).yaw, pitch0 = 4, ease = o.speed === "steady" ? null : "inout";
    const at = (yaw, pitch, dist, target = look, extra = {}) => ({ yaw, pitch, dist, target: target.slice(), ...extra });
    let keys, fx = null, dof = null;
    switch (id) {
      case "static": keys = [{ t: 0, ...at(yaw0, pitch0, d0) }]; break;
      case "push": keys = [{ t: 0, ...at(yaw0, pitch0, d0 * 1.5) }, { t: T, ...at(yaw0, pitch0, d0 * 0.75) }]; break;
      case "pull": keys = [{ t: 0, ...at(yaw0, pitch0, d0 * 0.75) }, { t: T, ...at(yaw0, pitch0 + 6, d0 * 2.2) }]; break;
      case "orbit": keys = keysOf(u => at(yaw0 + 360 * u, pitch0 + 2, d0), T, 8); break;
      case "half": keys = keysOf(u => at(yaw0 + 180 * u, pitch0 + 2, d0), T, 4); break;
      case "arcl": keys = keysOf(u => at(yaw0 - 50 * u, pitch0, d0), T, 2); break;
      case "arcr": keys = keysOf(u => at(yaw0 + 50 * u, pitch0, d0), T, 2); break;
      case "truckl": case "truckr": {
        const c = at(yaw0, pitch0, d0), r = axesOf(c).r, w = d0 * 0.9 * (id === "truckl" ? -1 : 1);
        const tg = u => addv(look, mulv(r, w * (u - 0.5)));
        keys = keysOf(u => at(yaw0, pitch0, d0, tg(u)), T, 2); break;
      }
      case "craneup": keys = [{ t: 0, ...at(yaw0, 2, d0) }, { t: T, ...at(yaw0, 40, d0 * 1.35) }]; break;
      case "cranedown": keys = [{ t: 0, ...at(yaw0, 40, d0 * 1.35) }, { t: T, ...at(yaw0, 2, d0) }]; break;
      case "panl": case "panr": {
        const e = eyeOf(at(yaw0, pitch0, d0)), f = sub(look, e), sgn = id === "panl" ? 1 : -1;
        keys = keysOf(u => camFrom(e, addv(e, rotY(f, sgn * (-25 + 50 * u)))), T, 2); break;
      }
      case "tiltup": {
        const e = eyeOf(at(yaw0, 0, d0)), lo = [look[0], sub0.base[1] + sub0.h * 0.1, look[2]], hi = [look[0], sub0.base[1] + sub0.h * 0.9, look[2]];
        keys = [{ t: 0, ...camFrom(e, lo) }, { t: T, ...camFrom(e, hi) }]; break;
      }
      case "low": { const e = [0, 0, 0], c = at(yaw0, 0, d0 * 0.9), e0 = eyeOf(c); e[0] = e0[0]; e[2] = e0[2]; e[1] = sub0.base[1] + sub0.h * 0.12;
        keys = [{ t: 0, ...camFrom(e, [look[0], sub0.base[1] + sub0.h * 0.75, look[2]]) }]; break; }
      case "top": keys = [{ t: 0, ...at(yaw0, 82, d0 * 1.4, [look[0], sub0.base[1], look[2]]) }]; break;
      case "handheld": keys = [{ t: 0, ...at(yaw0, pitch0, d0, look, { shake: 35 }) }]; fx = "handheld"; break;
      case "follow": {
        if (!sub0.o?.keys?.length || sub0.o.keys.length < 2) { Media.toast("Follow needs a subject that moves: give it a path first (key it at two times)."); return null; }
        const off = sub(eyeOf(at(yaw0, pitch0 + 4, d0)), look);
        keys = keysOf(u => { const p = poseAt(sub0.o, u * T).pos, tg = [p[0], p[1] + sub0.h * F.at, p[2]]; return { ...camFrom(addv(tg, off), tg), shake: 25 }; }, T, Math.max(2, Math.round(T * 2)));
        fx = "walking"; break;
      }
      case "zoom": { const L = baseLens(); keys = [{ t: 0, ...at(yaw0, pitch0, d0 * 1.6, look, { lens: L }) }, { t: T, ...at(yaw0, pitch0, d0 * 1.6, look, { lens: L * 2.2 }) }]; break; }
      case "vertigo": { const L = baseLens(); keys = [{ t: 0, ...at(yaw0, pitch0, d0, look, { lens: L }) }, { t: T, ...at(yaw0, pitch0, d0 * 2.2, look, { lens: L * 2.2 }) }]; break; }
      case "rack": keys = [{ t: 0, ...at(yaw0, pitch0, d0 * 1.4, look, { focus: d0 * 6 }) }, { t: T * 0.45, ...at(yaw0, pitch0, d0 * 1.1, look, { focus: d0 * 6 }) }, { t: T, ...at(yaw0, pitch0, d0 * 0.85, look, { focus: d0 * 0.85 }) }];
        dof = 2.8; break;
      default: return null;
    }
    return { keys: keys.map((k, i) => ({ ...camOf(k), t: k.t, ...(ease && i < keys.length - 1 && keys.length > 1 ? { ease } : {}) })), fx, dof };
  }
  // Put camera keys on the scene (from a move or a saved camera): one ↶ Undo step.
  function setCameraKeys(r) {
    if (!r?.keys?.length) return false;
    s.camKeys = r.keys.map(k => ({ ...k })).sort((a, b) => a.t - b.t);
    const fx = { ...(s.sc.fx || {}) }; delete fx.crane;
    if (r.fx && SHAKES[r.fx]) fx.shake_style = r.fx;
    s.sc.fx = fx;
    if (r.dof) s.sc.dof = { ...(s.sc.dof || {}), fstop: r.dof };
    s.camFree = false;
    save(); setTime(Math.min(s.t, dur())); renderSide(); s.dirty = true;
    return true;
  }
  const applyCameraMove = (id, o = {}) => setCameraKeys(cameraMove(id, o));
  // The shot's camera, relative to its subject: times as fractions of the length, yaw from the subject's facing,
  // targets as offsets from its feet turned with it; lens, focus, shake, easing, shake style and aperture kept.
  function cameraOut() {
    if (!s?.bg || !s.camKeys.length) return null;
    const S = camSubject(), T = dur() || 1;
    return { keys: s.camKeys.map(k => ({ ...camOf(k), t: +(k.t / T).toFixed(4), yaw: k.yaw - S.yaw, target: rotY(sub(k.target, S.base), -S.yaw), ...(k.ease ? { ease: k.ease } : {}) })),
      fx: s.sc.fx?.shake_style || null, dof: +s.sc.dof?.fstop || null, h: S.h };
  }
  function applySavedCamera(c) {
    if (!s?.bg || !c?.keys?.length) return false;
    const S = camSubject(), T = dur(), k = c.h ? S.h / c.h : 1;  // a bigger subject: the camera stands further off
    return setCameraKeys({ fx: c.fx, dof: c.dof, keys: c.keys.map(x => ({ ...x, t: +(x.t * T).toFixed(3), yaw: x.yaw + S.yaw, dist: x.dist * k,
      target: addv(S.base, rotY(x.target.map(v => v * k), S.yaw)), ...(x.focus ? { focus: x.focus * k } : {}) })) });
  }
  async function make3d(i) {
    const o = s.objs[i]; if (!o?.mask) return;
    try {
      const md = await api("/api/make3d", { method: "POST", body: JSON.stringify({ source: s.sc.picture, mask: o.mask, name: o.name, quality: "standard", project: s.sc.project }) });
      o.model = md.id; o.state = "running"; save();
      Media.toast(`Making ${o.name} in 3D: it stands in the scene when it's ready.`);
      loadObjects();
    } catch (e) { Media.toast(`Make 3D: ${e.message}`); }
  }

  // The shot this scene is for, on the Shots step (shots.js), while its project is open.
  const shotLinked = () => typeof Shots !== "undefined" && (state.project?.id ?? null) === (s.sc.project ?? null) && Shots.shotOfScene ? Shots.shotOfScene(s.sc.id) : null;

  /* ---------------------------------------------------------------- the floating position box
     While an object (or the shot camera) is selected: its X, Y, Z at the playhead (and the camera's pan and tilt),
     to read and type. Drag it by its top; × hides it until something else is selected. */
  // The camera's focal length in mm on a 36 mm wide frame: an empty scene's lens, or the picture's (estimated).
  const floatKey = () => s.camSel ? "cam" : s.objs[s.sel]?.id || null;
  function syncFloat() {
    const box = s.root.querySelector(".s3-float"); if (!box) return;
    const o = s.objs[s.sel], cam = s.camSel && camShown(), key = floatKey();
    const show = !!key && (cam || (o?.mesh && o.pos && !o.hidden)) && s.floatOff !== key;
    if (box.hidden === show) box.hidden = !show;
    if (!show) return;
    let pos, c = null;
    if (cam) { c = camBase(s.t); pos = eyeOf(c); } else pos = poseAt(o, s.t).pos;
    s.root.querySelector(".s3-float-n").textContent = cam ? "🎥 Shot camera" : o.name;
    s.root.querySelector(".s3-float-u").textContent = s.bg.empty ? "metres" : "scene units";
    s.root.querySelector(".s3-float-cam").hidden = !cam;
    if (cam) {
      const fs = s.root.querySelector(".s3-fstop"); if (document.activeElement !== fs) fs.value = fstop() ? String(fstop()) : "";
      const ss = s.root.querySelector(".s3-shakestyle"); if (document.activeElement !== ss) ss.value = shakeStyle();
      s.root.querySelector(".s3-float-fu").textContent = s.bg.empty ? "m" : "units";
      const dr = dofRange(c);
      s.root.querySelector(".s3-float-dof").textContent = dr ? `Sharp from ${dr.near.toFixed(1)} to ${Number.isFinite(dr.far) ? dr.far.toFixed(1) : "∞"}: ${focusSubject(s.t, c)} in focus` : "Aperture off: everything is sharp.";
    }
    const st = s.bg.empty ? 0.1 : +(s.bg.dmed * 0.02).toPrecision(2);
    box.querySelectorAll(".s3f-in").forEach(inp => {
      const ax = inp.dataset.ax, v = ax === "yaw" ? c?.yaw : ax === "pitch" ? (c ? -c.pitch : null) : ax === "lens" ? (c ? Math.round((c.lens || baseLens()) * 10) / 10 : null) : ax === "roll" ? (c ? c.roll || 0 : null) : ax === "focus" ? (c ? Math.round(focusOf(c) * 100) / 100 : null) : ax === "shake" ? (c ? c.shake || 0 : null) : pos[+ax];  // tilt: up is +
      if (ax === "lens") inp.title = `The camera's focal length at the playhead, keyed there: key another at another time to zoom. Unkeyed it's the scene's, ${Math.round(baseLens())} mm${s.bg.empty ? " (View › Lens)" : " (the picture's)"}.`;
      if (v == null) return;
      if (ax.length === 1) inp.step = String(st);
      if (document.activeElement !== inp) { const t = (Math.round(v * 1000) / 1000).toString(); if (inp.value !== t) inp.value = t; }
    });
    if (cam) {
      const fv = fovOf(c), wide = !s.bg.empty && (c.lens || baseLens()) < baseLens() * 0.98, el = s.root.querySelector(".s3-float-fov");
      el.textContent = `${Math.round(2 * Math.atan(fv.t) / rad)}° wide${wide ? " · wider than the picture: its edges are empty" : ""}`;
      el.classList.toggle("warn", wide);
    }
    const keyed = cam ? s.camKeys.some(k => near(k.t, s.t)) : o.keys?.some(k => near(k.t, s.t));
    s.root.querySelector(".s3-float-t").textContent = `At ${s.t.toFixed(2)} s${keyed ? " (a key)" : (cam ? s.camKeys.length : o.keys?.length) ? ": typing keys it here" : ""}`;
  }
  function wireFloat(root) {
    const box = root.querySelector(".s3-float"), stage = root.querySelector(".s3-box");
    let at = null;
    try { at = JSON.parse(localStorage.getItem("bob.s3float") || "null"); } catch { /* not kept */ }
    const place = (x, y) => {
      const W = stage.clientWidth, H = stage.clientHeight, w = box.offsetWidth || 200, h = box.offsetHeight || 120;
      x = Math.max(4, Math.min(W - w - 4, x)); y = Math.max(4, Math.min(H - h - 4, y));
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, right: "auto" });
      return [x, y];
    };
    if (Array.isArray(at)) requestAnimationFrame(() => place(...at));
    const head = box.querySelector(".s3-float-h");
    head.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      e.preventDefault(); head.setPointerCapture(e.pointerId);
      const r = box.getBoundingClientRect(), sr = stage.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = ev => { at = place(ev.clientX - sr.left - dx, ev.clientY - sr.top - dy); };
      const up = () => { head.removeEventListener("pointermove", mv); head.removeEventListener("pointerup", up); try { localStorage.setItem("bob.s3float", JSON.stringify(at)); } catch { /* not kept */ } };
      head.addEventListener("pointermove", mv); head.addEventListener("pointerup", up);
    });
    box.querySelector(".s3-float-x").onclick = () => { s.floatOff = floatKey(); box.hidden = true; };
    box.querySelector(".s3-focus-on").onclick = e => {  // focus on an object: its distance along the camera's view
      if (!s?.bg || !s.camSel) return;
      const c = camBase(s.t), E = eyeOf(c), { f } = axesOf(c), rc = e.target.getBoundingClientRect();
      const list = cast(s.t, c).filter(x => !x.off).map(x => ({ x, z: dot3(sub(poseAt(x.o, s.t).pos, E), f) })).filter(q => q.z > 0.05);
      if (!list.length) return Media.toast("The camera sees no objects here.");
      Media.menu(rc.left, rc.bottom + 4, list.map(q => [`⌖ ${q.x.o.name} (${q.z.toFixed(1)} ${s.bg.empty ? "m" : "units"})`, () => {
        if (!fstop()) { s.sc.dof = { fstop: 2.8 }; Media.toast("Aperture set to f/2.8 so the focus shows; Off keeps everything sharp."); }
        editCam({ ...camBase(s.t), focus: q.z }); save(); renderCam(); s.dirty = true;
      }]));
    };
    ["pointerdown", "wheel", "contextmenu"].forEach(t => box.addEventListener(t, e => e.stopPropagation()));
    box.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.blur(); s.cv.focus(); } });
    box.addEventListener("input", e => e.stopPropagation());
    box.addEventListener("change", async e => {
      e.stopPropagation();
      if (e.target.classList.contains("s3-shakestyle")) { s.sc.fx = { ...(s.sc.fx || {}), shake_style: e.target.value }; save(); s.dirty = true; return; }
      if (e.target.classList.contains("s3-fstop")) { s.sc.dof = e.target.value ? { fstop: +e.target.value } : {}; save(); renderCam(); s.dirty = true; return; }
      const inp = e.target.closest(".s3f-in"); if (!inp || !s?.bg) return;
      const ax = inp.dataset.ax, v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return syncFloat();
      if (s.camSel && ax === "lens") {  // keyed at the playhead: a zoom between keys
        editCam({ ...camBase(s.t), lens: Math.max(10, Math.min(300, v)) }); save(); renderCam(); s.dirty = true; return;
      }
      if (s.camSel) {
        const c = camBase(s.t);
        if (ax === "yaw") editCam(turnCam(c, v, c.pitch));
        else if (ax === "pitch") editCam(turnCam(c, c.yaw, -v));
        else if (ax === "roll") editCam({ ...c, roll: Math.max(-180, Math.min(180, v)) });
        else if (ax === "focus") editCam({ ...c, focus: Math.max(0.05, v) });
        else if (ax === "shake") editCam({ ...c, shake: Math.max(0, Math.min(100, v)) });
        else { const E = eyeOf(c), d = [0, 0, 0]; d[+ax] = v - E[+ax]; editCam({ ...c, target: addv(c.target, d) }); }
        save(); renderCam();
      } else {
        const o = s.objs[s.sel]; if (!o?.mesh || !o.pos) return;
        const p = poseAt(o, s.t).pos.slice(); p[+ax] = v;
        editPose(o, { pos: p }); changed(o);
      }
      s.dirty = true;
    });
  }
  function renderSide() {
    if (!s) return;
    if (s.floatOff && s.floatOff !== floatKey()) s.floatOff = null;
    renderTime(); renderCam();
    const root = s.root;
    const st = o => o.prim ? (o.hidden ? `<span class="hint">hidden</span>` : "") : o.state === "running" ? `<span class="hint">making… </span>` : o.state === "failed" ? `<span class="hint">failed</span>`
      : o.state === "missing" ? `<span class="hint">model deleted</span>` : !o.model ? `<button type="button" class="btn sm" data-act="make3d" data-i="${s.objs.indexOf(o)}">🧊 Make 3D</button>` : o.hidden ? `<span class="hint">hidden</span>` : "";
    root.querySelector(".s3-objs").innerHTML = s.objs.length ? s.objs.map((o, i) => `<li data-i="${i}" class="${i === s.sel ? "sel" : ""}" tabindex="0" title="Right-click for its menu"><b>${o.prim ? `<span aria-hidden="true">${PRIMS[o.prim].icon}</span> ` : ""}${esc(o.name)}</b>${o.becomes ? ` <span class="hint s3-becomes-l">→ ${esc(o.becomes)}</span>` : ""}${o.picture ? ` <span class="s3-hasPic" title="Has a picture for H3 Reference">🖼</span>` : ""} ${st(o)}</li>`).join("")
      : `<li class="hint">No objects yet: add a shape from the tool bar, or a 3D model below.</li>`;
    const opts = models.filter(m => m.status === "done");
    const mine = opts.filter(m => m.source === s.sc.picture), other = opts.filter(m => m.source !== s.sc.picture);
    root.querySelector(".s3-add").innerHTML = `<option value="">Add a 3D model…</option>` +
      (mine.length ? `<optgroup label="Made from this picture">${mine.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</optgroup>` : "") +
      (other.length ? `<optgroup label="Other models">${other.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</optgroup>` : "");
    const o = s.objs[s.sel], sec = root.querySelector(".s3-sel");
    sec.hidden = !o;
    if (o) {
      root.querySelector(".s3-sel-h").textContent = o.name;
      { const b = root.querySelector("#s3-becomes"); if (b !== document.activeElement) b.value = o.becomes || ""; }
      root.querySelector("#s3-face").checked = !!o.face;
      root.querySelector(".s3-pic-th").innerHTML = o.picture ? `<img src="${esc(mediaUrl(o.picture))}" alt="">` : `<span class="hint">None: drop one here</span>`;
      root.querySelector('[data-act="pic-crop"]').hidden = !cropSource(o);
      root.querySelector('[data-act="pic-clear"]').hidden = !o.picture;
      const P = o.pos ? poseAt(o, s.t) : { yaw: 0, scale: o.scale };
      const size = o.auto_scale && P.scale ? P.scale / o.auto_scale : 1;
      const K = o.keys || [];
      root.querySelector(".s3-objhint").textContent = K.length ? `Moving it, turning it or sizing it keys it at ${s.t.toFixed(2)} s.`
        : `Drag it to ${TOOLS[s.tool].slice(2).toLowerCase()} it (Shift+drag: up or down); right-click it for more. Move the playhead and change it again to make it move.`;
      root.querySelector(".s3-objkeys").innerHTML = K.map((q, j) => `<button type="button" class="chip-btn${near(q.t, s.t) ? " on" : ""}" data-act="obj-key" data-k="${j}">${q.t.toFixed(2)} s</button><button type="button" class="set-x" data-act="del-obj-key" data-k="${j}" aria-label="Remove the key at ${q.t.toFixed(2)} s">×</button>`).join(" ");
      [["#s3-rx", "pitch"], ["#s3-ry", "yaw"], ["#s3-rz", "roll"]].forEach(([q, f]) => { const el = root.querySelector(q); if (el !== document.activeElement) el.value = String(Math.round((P[f] || 0) * 10) / 10); el.disabled = !o.mesh || !o.pos; });
      Object.assign(root.querySelector("#s3-size"), { value: String(size), disabled: !o.mesh }); root.querySelector(".s3-size-v").textContent = `${Math.round(size * 100)}%`;
      root.querySelector('[data-act="hide"]').textContent = o.hidden ? "Show" : "Hide";
      root.querySelector('[data-act="replace"]').hidden = !!o.prim;
      const pf = root.querySelector(".s3-prim"); pf.hidden = !o.prim;
      root.querySelector(".s3-posef").hidden = o.prim !== "figure";
      if (o.prim === "figure") { root.querySelector("#s3-pose").value = postureName(postureAt(o, s.t)); root.querySelector("#s3-gait").value = o.gait || ""; }
      if (o.prim) {
        const d = o.dims || PRIMS[o.prim].dims, act = document.activeElement;
        if (act !== root.querySelector("#s3-color")) root.querySelector("#s3-color").value = o.color || PRIM_COLOR;
        [["#s3-dw", 0], ["#s3-dh", 1], ["#s3-dd", 2]].forEach(([q, j]) => { const el = root.querySelector(q); if (el !== act) el.value = String(+d[j].toFixed(3)); el.disabled = o.prim === "plane" && j === 1; });
        root.querySelector(".s3-unit").textContent = s.bg?.empty ? "metres, before Size %" : "scene units, before Size %";
      }
    }
    renderTools();
  }

  /* ---------------------------------------------------------------- empty scenes */
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const ASPECTS = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "21:9": 21 / 9 };
  // An empty scene's camera and background: the lens on the frame's long side (a 36 mm wide sensor), a floor with a
  // 1 m grid 1.6 m under the camera, and the backdrop picture (if any) far behind, filling the view.
  async function buildEmpty() {
    const sc = s.sc, A = ASPECTS[sc.aspect] || 16 / 9, tl = 18 / (+sc.lens || 35);
    const t = A >= 1 ? tl : tl * A, tv = t / A, floor = -1.6;
    s.bg = { empty: true, t, tv, aspect: A, dmed: 4, floor };
    const prims = [];
    // the floor: 80 x 80 m, its texture a grid of 1 m squares
    const N = 80, cz = -N / 2 + 6, c = document.createElement("canvas");
    c.width = c.height = 2048;
    const g = c.getContext("2d"), fl = sc.backdrop?.floor || "#8b9098", [fr, fg, fb] = hexRgb(fl);
    g.fillStyle = fl; g.fillRect(0, 0, 2048, 2048);
    const lum = 0.3 * fr + 0.59 * fg + 0.11 * fb;
    g.strokeStyle = lum > 0.5 ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.18)"; g.lineWidth = 2;
    for (let i = 0; i <= N; i++) { const p = i / N * 2048; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 2048); g.moveTo(0, p); g.lineTo(2048, p); g.stroke(); }
    prims.push({ pos: new Float32Array([-N / 2, floor, cz - N / 2, N / 2, floor, cz - N / 2, N / 2, floor, cz + N / 2, -N / 2, floor, cz + N / 2]),
      nrm: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), col: null,
      idx: new Uint32Array([0, 2, 1, 0, 3, 2]), base: [1, 1, 1, 1], tex: c, ao: null });
    // the backdrop: a card 50 m away, covering the view with room to look around
    const url = sc.backdrop?.picture ? (sc.backdrop_url || `/api/media/file?path=${encodeURIComponent(sc.backdrop.picture)}`) : null;
    if (url) {
      try {
        const img = await createImageBitmap(await (await fetch(url)).blob());
        const D = 50, h = 2 * tv * D * 1.6, w = Math.max(h * img.width / img.height, 2 * t * D * 1.6);
        const hh = w * img.height / img.width, y0 = floor - 1, z = -D;
        prims.push({ pos: new Float32Array([-w / 2, y0, z, w / 2, y0, z, w / 2, y0 + hh, z, -w / 2, y0 + hh, z]), nrm: null,
          uv: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), col: null, idx: new Uint32Array([0, 1, 2, 0, 2, 3]), base: [1, 1, 1, 1], tex: img, ao: null });
      } catch { Media.toast("Couldn't load the backdrop picture."); }
    }
    s.bgMesh = s.gpu.upload(prims);
    s.dirty = true;
  }
  function renderEmpty() {
    const sc = s.sc, R = s.root;
    R.querySelector("#s3-aspect").value = sc.aspect || "16:9";
    const ls = R.querySelector("#s3-lens"), lv = String(Math.round(+sc.lens || 35));
    ls.querySelector("[data-own]")?.remove();
    if (![...ls.options].some(op => op.value === lv)) { const op = new Option(`${lv} mm`, lv); op.dataset.own = "1"; ls.add(op); }  // typed in the floating box
    ls.value = lv;
    R.querySelector("#s3-sky").value = sc.backdrop?.sky || "#c9d3de";
    R.querySelector("#s3-floor").value = sc.backdrop?.floor || "#8b9098";
    const pic = sc.backdrop?.picture;
    R.querySelector(".s3-bdname").textContent = pic ? pic.split("/").pop() : "none";
    R.querySelector('[data-act="bd-clear"]').hidden = !pic;
    s.hud.textContent = `${sc.aspect || "16:9"} · ${Math.round(+sc.lens || 35)} mm · ${Math.round(2 * Math.atan(s.bg.t) / rad)}° wide`;
  }
  async function emptyChanged() {
    await buildEmpty();
    renderEmpty(); save(); s.dirty = true;
  }
  // What the camera frames: the rest of the view is shaded (the window and the frame rarely have the same shape).
  function frameOverlay() {
    const el = s.root.querySelector(".s3-frame"); if (!el || !s.bg) return;
    el.hidden = s.camObj && s.camFree;  // from outside, the frame isn't the shot's
    const W = s.cv.clientWidth, H = s.cv.clientHeight, A = s.bg.aspect;
    const fw = W / H > A ? H * A : W, fh = W / H > A ? H : W / A;
    Object.assign(el.style, { left: `${(W - fw) / 2}px`, top: `${(H - fh) / 2}px`, width: `${fw}px`, height: `${fh}px` });
  }

  // One frame of the scene as a picture in data/uploads: [W, H], at time t, through `cam` (holes filled).
  // `paste`: people pasted over their mannequins (pastePeople), which are then left out of the drawing.
  async function uploadFrame(size, t, cam, name, paste = []) {
    draw({ size, t, cam, skip: paste.map(p => p.o) });
    const c = fillHoles(s.cv, size[0], size[1]);
    if (paste.length) { const g = c.getContext("2d"); for (const p of paste) g.drawImage(p.layer, 0, 0); }
    const blob = await new Promise(res => c.toBlob(res, "image/png"));
    const fd = new FormData(); fd.append("file", blob, name);
    const r = await fetch("/api/upload", { method: "POST", body: fd }), j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.statusText);
    return j.ref;
  }

  /* ---------------------------------------------------------------- objects, as the models can see them */
  // The photo and video models see only the render: an object is "the red cube on the left", not "Cube 2". Each one is
  // described by its colour and shape (or a 3D model's name), where it is in the frame at that moment, and what it
  // Becomes; {Name} in a render's text is sent as that description.
  const COLORS = [["black", [22, 22, 22]], ["dark grey", [72, 72, 72]], ["grey", [128, 128, 128]], ["light grey", [200, 200, 200]],
    ["white", [246, 246, 246]], ["red", [205, 40, 40]], ["dark red", [120, 22, 22]], ["orange", [240, 130, 30]], ["yellow", [236, 212, 50]],
    ["beige", [216, 196, 158]], ["brown", [122, 76, 40]], ["green", [52, 162, 62]], ["dark green", [30, 90, 42]], ["teal", [30, 150, 150]],
    ["light blue", [130, 190, 240]], ["blue", [40, 90, 210]], ["navy", [26, 36, 92]], ["purple", [122, 62, 172]], ["pink", [240, 130, 182]]];
  const colorName = hex => { const c = hexRgb(hex).map(v => v * 255); return COLORS.reduce((b, x) => { const d = Math.hypot(c[0] - x[1][0], c[1] - x[1][1], c[2] - x[1][2]); return d < b[1] ? [x[0], d] : b; }, ["", Infinity])[0]; };
  const SHAPE = { cube: "cube", sphere: "sphere", cylinder: "cylinder", cone: "cone", plane: "flat panel", torus: "ring", figure: "human figure" };
  const ORD = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
  const bare = t => String(t || "").trim().replace(/^(a|an|the|some)\s+/i, "");
  // Where an object is in the frame of `cam` at time t: u, v (0..1 across and down), its distance, or off: out of view.
  /* Where an object is in the frame at time t through cam, by the part of it that's in the picture: its box's corners
     projected, the outline clipped to the frame. u, v: the middle of what shows (0..1 across and down); part: how much
     of its outline shows; off: (almost) nothing shows. So an object mostly above the frame is "at the top", not "in
     the middle" by its centre. */
  function seenAt(o, t, cam) {
    const P = poseAt(o, t), p = P?.pos; if (!p) return null;
    const W = 1000, H = Math.round(W / (s.bg.aspect || 16 / 9)), { VP, e } = viewProj(W, H, cam);
    const d = Math.hypot(p[0] - e[0], p[1] - e[1], p[2] - e[2]);
    const pts = (o.mesh ? boxCorners(o, matOf(o, P)) : [p]).map(q => {
      const x = xf(VP, q, 1), w = VP[3] * q[0] + VP[7] * q[1] + VP[11] * q[2] + VP[15];
      return w > 1e-6 ? [(x[0] / w + 1) / 2, (1 - x[1] / w) / 2] : null;
    }).filter(Boolean);
    if (!pts.length) return { off: true, u: 0.5, v: 0.5, d: Infinity, part: 0 };
    const x0 = Math.min(...pts.map(q => q[0])), x1 = Math.max(...pts.map(q => q[0])), y0 = Math.min(...pts.map(q => q[1])), y1 = Math.max(...pts.map(q => q[1]));
    const cx0 = Math.max(0, x0), cx1 = Math.min(1, x1), cy0 = Math.max(0, y0), cy1 = Math.min(1, y1);
    const shown = Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0), whole = Math.max(1e-9, (x1 - x0) * (y1 - y0));
    const off = shown < 0.002 || pts.length < (o.mesh ? 8 : 1) && shown < 0.01;
    return { u: off ? 0.5 : (cx0 + cx1) / 2, v: off ? 0.5 : (cy0 + cy1) / 2, d, off, part: Math.min(1, shown / whole) };
  }
  // Every shown object as the models see it at time t through cam: { o, looks, where, seen, becomes, off }.
  // photo: the video starts from a photo, where the stand-ins are what they become (a Person a real person), so they're
  // told by that and where they are, never by the grey shape they are in the scene.
  function cast(t, cam, video = false, photo = false) {
    const list = s.objs.filter(o => o.mesh && o.pos && !o.hidden).map(o => ({ o, at: seenAt(o, t, cam) })).filter(x => x.at);
    const ds = list.filter(x => !x.at.off).map(x => x.at.d).sort((a, b) => a - b), med = ds[ds.length >> 1];
    for (const x of list) {
      const a = x.at;
      x.off = a.off;
      x.looks = x.o.prim ? `${colorName(x.o.color || PRIM_COLOR)} ${SHAPE[x.o.prim]}` : bare(x.o.name).replace(/\s+\d+$/, "").toLowerCase();
      const hz = a.u < 0.36 ? "left" : a.u > 0.64 ? "right" : "", vt = a.v < 0.3 ? "top" : a.v > 0.72 ? "bottom" : "";
      x.where = a.off ? "out of view" : vt ? `at the ${vt}${hz ? ` ${hz}` : ""}` : hz ? `on the ${hz}` : "in the middle";
      if (!a.off && a.part < 0.6) x.where += ", partly out of frame";
      if (!a.off && ds.length > 1 && a.d < med * 0.7) x.where += ", in front";
      else if (!a.off && ds.length > 1 && a.d > med * 1.4) x.where += ", at the back";
      x.becomes = (x.o.becomes || "").trim();
      if (photo && (x.becomes || x.o.prim === "figure")) { x.looks = x.becomes ? bare(x.becomes) : "person"; x.photo = true; }
    }
    // Two that would read the same are told apart left to right.
    const groups = new Map();
    for (const x of list) { const k = `${x.looks}|${x.where}`; groups.set(k, [...(groups.get(k) || []), x]); }
    for (const g of groups.values()) if (g.length > 1) g.sort((a, b) => a.at.u - b.at.u).forEach((x, i) => { x.looks = `${ORD[i] || `#${i + 1}`} ${x.looks} from the left`; });
    for (const x of list) {
      let pose = "";
      if (x.o.prim === "figure") {
        const seq = video ? (x.o.keys || []).filter(k => k.pose).map(k => k.pose).filter((p, i, a) => i === 0 || p !== a[i - 1]) : [];
        pose = seq.length > 1 ? seq.map(p => POSES[p]?.says || "standing").join(", then ") : POSES[seq[0] || postureName(postureAt(x.o, t))]?.says || "";
        // walking or running along its path (the video: if it moves at all; a photo: if it's moving then)
        const g = GAITS[x.o.gait], moving = g && (video ? travelled(x.o, x.o.keys?.at(-1)?.t ?? 0) > 0.05 * figHeight(x.o) : !!gaitAt(x.o, t));
        if (moving) pose = [g.says, ...(seq.length > 1 ? seq.filter(p => p !== "standing").map(p => POSES[p]?.says).filter(Boolean) : pose ? [pose] : [])].join(", then ");
      }
      x.pose = pose;
      x.seen = `the ${x.looks}${x.off ? "" : ` ${x.where}`}${pose ? `, ${pose},` : ""}`;
    }
    return list;
  }
  // "the wooden crate (the red cube on the left)", or just what it looks like when it Becomes nothing; with its picture
  // as <Picture k> (a render on H3 Reference), "the wooden crate from <Picture 2> (the red cube on the left)".
  const refOf = (x, k = 0) => x.photo && !k ? `the ${x.looks}${x.off ? "" : ` (${[x.where, x.pose].filter(Boolean).join(", ")})`}` : k ? `the ${x.becomes ? bare(x.becomes) : x.o.name.trim().toLowerCase()} from <Picture ${k}> (${tidy(x.seen)})`
    : x.becomes ? `the ${bare(x.becomes)} (${tidy(x.seen)})` : x.seen;
  // A pose's closing comma before a full stop, semicolon or bracket goes: "…, sitting,." -> "…, sitting."
  const tidy = t => String(t).replace(/,\s*([.;:!?)]|$)/g, "$1").replace(/,\s*,/g, ",");
  // The objects whose pictures go to H3 Reference, in order (<Picture 2>...; the first frame is <Picture 1>).
  const picObjs = () => s.objs.filter(o => o.mesh && o.pos && !o.hidden && o.picture).slice(0, 8);
  const refsReady = () => !!state.caps?.engines?.h3ref?.ready;
  // {Name} -> that object's description; unknown names lose their braces and are reported.
  function expandTags(text, list, picOf = () => 0) {
    const unknown = [];
    const out = String(text || "").replace(/\{([^{}]{1,120})\}/g, (m, n) => {
      const x = list.find(q => q.o.name.trim().toLowerCase() === n.trim().toLowerCase());
      if (!x) { unknown.push(n.trim()); return n.trim(); }
      return refOf(x, picOf(x));
    });
    return { text: out, unknown, used: list.filter(x => new RegExp(`\\{\\s*${x.o.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}`, "i").test(text)) };
  }
  // The photo: every object in view, and what it becomes.
  // With pictures (`pics`, from photoPics), an object with one "becomes the golden retriever from Picture 2".
  // `pasted`: people already pasted into the render from their pictures, in their mannequins' place (pastePeople).
  function photoObjects(t, cam, pics = [], model = "qwen", first = 2, free = false, pasted = []) {
    const list = cast(t, cam).filter(x => !x.off);
    if (!list.length) return "";
    const tag = PIC_TAG[model] || PIC_TAG.qwen;
    const one = x => {
      const k = pics.indexOf(x.o);
      // pasted in from its picture: there's no mannequin in the render any more, only that person, roughly cut out. Their
      // picture isn't sent as well: given it, the edit model drew the person a second time, as the picture shows them.
      if (pasted.includes(x.o)) return `the person ${x.where} is a real person pasted in roughly from a photo: keep them exactly there, at that size, `
        + `${x.pose ? `pose them ${x.pose}` : "keep their pose"}, keep their face, hair and clothes, and blend them into the photo with matching light, colour and shadows; `
        + "they appear only there, once";
      // with a picture, Qwen tends to add what's in it beside the stand-in and keep the stand-in: say it takes its place
      if (k >= 0) return `${x.seen} becomes ${x.becomes ? `the ${bare(x.becomes)} from ${tag(k + first)}` : x.o.prim === "figure" ? `the person in ${tag(k + first)}` : `what is in ${tag(k + first)}`}`
        + `, exactly where it stands and at its size; the ${x.o.prim ? SHAPE[x.o.prim] : "stand-in"} itself is gone`;
      // a Person with nothing said is still a real person: Qwen keeps what it isn't told to change, the mannequin included
      return x.becomes ? `${x.seen} becomes ${x.becomes}` : x.o.prim === "figure" ? `${x.seen} becomes a real person` : x.seen;
    };
    return tidy(` ${free ? "The stand-ins to replace" : "The objects in it"}: ${list.map(one).join("; ")}.`);
  }
  // Generate photo's pictures: the objects in view that have one, as many as the edit model takes besides the render.
  const PHOTO_PICS = { qwen: 2, h3image: 8, mossedit: 3 };  // workflows.EDIT_EXTRA_REFS
  const PIC_TAG = { qwen: k => `Picture ${k}`, h3image: k => `<Picture ${k}>`, mossedit: k => `picture ${k}` };  // how each model names its pictures
  /* Which pictures a photo uses: every Person in view with one is pasted into the render (pastePeople) and needs no
     picture slot; the other objects' pictures go along as the edit model's extra pictures, as many as it takes.
     `pasted`: the people actually pasted (a picture with no whole person in it isn't); by default every pictured Person. */
  function photoPlan(t, cam, model, taken = 0, pasted = null) {
    const inView = cast(t, cam).filter(x => !x.off && x.o.picture).map(x => x.o);
    const paste = pasted ?? inView.filter(o => o.prim === "figure");
    return { paste, sent: inView.filter(o => !paste.includes(o)).slice(0, Math.max(0, (PHOTO_PICS[model] ?? 2) - taken)), all: inView.length };
  }
  // With Qwen, the depth map can go along (Picture 2): it holds the layout in a big restyle, where the render's grey
  // clay look could otherwise stay or the layout wander. Qwen Image Edit reads depth maps as a picture of their own.
  const depthLine = (tag, model) => ` ${tag(2)} is a depth map of ${tag(1)} (near is white, far is black): keep the depth, layout and proportions it shows.`;
  const depthOk = model => model === "qwen";
  const lastDepth = () => { try { return localStorage.getItem("bob.scenePhotoDepth") === "1"; } catch { return false; } };
  // The video's text: tags expanded, and what the other objects are (as the first frame shows them).
  function videoText(what, refs = false, photo = false) {
    const pics = refs ? picObjs() : [], picOf = x => { const i = pics.indexOf(x.o); return i < 0 ? 0 : i + 2; };
    const list = cast(0, camForRender(0), true, photo), r = expandTags(what, list, picOf);
    // from a photo, what an object becomes is already in the first frame
    const rest = list.filter(x => !r.used.includes(x) && (picOf(x) || (x.becomes && !x.off && !x.photo)));
    const cap = t => t[0].toUpperCase() + t.slice(1);
    const extra = rest.map(x => picOf(x) ? `${cap(x.seen)} looks like <Picture ${picOf(x)}>${x.becomes ? `: ${x.becomes}` : ""}.` : `${cap(x.seen)} is ${x.becomes}.`).join(" ");
    let text = r.text.trim();
    if (text) text = cap(text);
    if (text && !/[.!?]$/.test(text)) text += ".";
    return { text: tidy([text, extra, dofLine(true)].filter(Boolean).join(" ")), unknown: r.unknown };
  }
  // The {Name} chips over a text box, and the preview of what the model reads under it.
  function tagChips() {
    const list = s.objs.filter(o => o.mesh && o.pos && !o.hidden);
    return list.length ? `<div class="s3-tags" role="group" aria-label="Insert an object">${list.map(o => `<button type="button" class="chip-btn" data-tag="{${esc(o.name)}}" title="Insert {${esc(o.name)}}: sent as ${esc(o.becomes ? `the ${bare(o.becomes)} (what it looks like and where it is)` : "what it looks like and where it is")}">${o.prim ? `${PRIMS[o.prim].icon} ` : ""}${esc(o.name)}${o.becomes ? ` <small>→ ${esc(o.becomes)}</small>` : ""}</button>`).join("")}</div>` : "";
  }
  function wireTags(box, ta, said) {
    const out = box.querySelector(".s3-said");
    const show = () => {
      const r = said();
      out.innerHTML = `H3 reads: “${esc(r.text)}”${r.unknown.length ? ` <span class="warn">No object called ${r.unknown.map(n => `“${esc(n)}”`).join(", ")}.</span>` : ""}`;
    };
    box.querySelector(".s3-tags")?.addEventListener("mousedown", e => { if (e.target.closest("[data-tag]")) e.preventDefault(); });  // keep the caret
    box.querySelector(".s3-tags")?.addEventListener("click", e => {
      const b = e.target.closest("[data-tag]"); if (!b) return;
      ta.focus(); insertAtCursor(ta, b.dataset.tag); ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    ta.addEventListener("input", show);
    show();
  }

  /* ---------------------------------------------------------------- an object's picture (for H3 Reference) */
  async function uploadBlob(blob, name) {
    const fd = new FormData(); fd.append("file", blob, name);
    const r = await fetch("/api/upload", { method: "POST", body: fd }), j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || r.statusText);
    return j.ref;
  }
  // The picture and mask an object was made from: the scene's own, or its 3D model's.
  function cropSource(o) {
    if (o.mask && s.sc.picture) return [s.sc.picture, o.mask];
    const md = o.model && models.find(x => x.id === o.model);
    return md?.source && md?.mask ? [md.source, md.mask] : null;
  }
  // Cut the object out of that picture by its mask, on white, with a little room around it; uploaded as a PNG.
  async function cropPicture(o) {
    const src = cropSource(o); if (!src) throw new Error("It wasn't made from a picture");
    const load = ref => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Couldn't load the picture")); im.src = mediaUrl(ref); });
    const [pic, msk] = await Promise.all(src.map(load));
    const W = pic.naturalWidth, H = pic.naturalHeight, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(msk, 0, 0, W, H);
    const m = g.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[(y * W + x) * 4] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) throw new Error("Its mask is empty");
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.08);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    g.drawImage(pic, 0, 0, W, H);
    const px = g.getImageData(x0, y0, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = m[((y + y0) * W + x + x0) * 4] / 255;
      for (let c = 0; c < 3; c++) px.data[i + c] = px.data[i + c] * a + 255 * (1 - a);
      px.data[i + 3] = 255;
    }
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    out.getContext("2d").putImageData(px, 0, 0);
    const blob = await new Promise(res => out.toBlob(res, "image/png"));
    return uploadBlob(blob, `${o.name.replace(/[^\w-]+/g, "_").slice(0, 40) || "object"}.png`);
  }

  /* ---------------------------------------------------------------- 🌫 Save depth map */
  // What the camera frames as depth, the way depth ControlNets (MiDaS, Depth Anything) want it: near is white, far is
  // black, scaled as inverse depth between the nearest and farthest things in view; the open sky is black. It's drawn
  // offscreen with each pixel's distance along the camera's forward axis encoded in 24 bits, then read back here.
  // A clip uses one range for all its frames (measured first), so its brightness doesn't flicker.
  function depthDistances([W, H], t, cam) {
    for (const o of s.objs) figureMesh(o, t);
    const { e, VP } = viewProj(W, H, cam), fwd = norm(sub(cam.target, e)), zmax = (s.bg.dmed || 4) * 60;
    const px = s.gpu.capture(W, H, d => {
      const o = { VP, M: ID, eye: e, key: [0, 1, 0], depthOut: [...fwd, zmax] };
      if (s.bgMesh) d(s.bgMesh, o);
      for (const x of s.objs) if (x.mesh && x.pos && !x.hidden) d(x.mesh, { ...o, M: matOf(x, poseAt(x, t)) });
    });
    const z = new Float32Array(W * H);  // top row first; 0 = nothing (sky)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * 4, v = px[i] * 65536 + px[i + 1] * 256 + px[i + 2];
      z[y * W + x] = v ? (v - 1) / 16777214 * zmax : 0;
    }
    return z;
  }
  function depthRange(z) {
    const vals = []; for (let i = 0; i < z.length; i += 7) if (z[i] > 0) vals.push(z[i]);
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return [Math.max(1e-4, vals[Math.floor(vals.length * 0.005)]), vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))]];
  }
  // Distances -> grey levels (one byte a pixel, top row first).
  function depthGray(z, [near, far]) {
    const out = new Uint8Array(z.length), a = 1 / near, b = 1 / Math.max(far, near * 1.001);
    for (let i = 0; i < z.length; i++) out[i] = z[i] > 0 ? Math.round(255 * Math.max(0, Math.min(1, (1 / z[i] - b) / (a - b)))) : 0;
    return out;
  }
  function depthCanvas(z, [W, H], range) {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d"), im = g.createImageData(W, H), v = depthGray(z, range);
    for (let i = 0; i < v.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v[i]; im.data[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0);
    return c;
  }
  /* A plain 8-bit greyscale PNG (one channel, no alpha), which depth ControlNet tools read as is; browsers can only save
     RGBA, so it's written here: rows with PNG's "Up" filter (good for smooth depth), compressed by the browser's own
     zlib (CompressionStream "deflate"). Where there is no CompressionStream, an RGBA PNG from a canvas instead. */
  async function grayPNG(gray, W, H) {
    if (typeof CompressionStream === "undefined") {
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const g = c.getContext("2d"), im = g.createImageData(W, H);
      for (let i = 0; i < gray.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = gray[i]; im.data[i * 4 + 3] = 255; }
      g.putImageData(im, 0, 0);
      return new Uint8Array(await (await new Promise(res => c.toBlob(res, "image/png"))).arrayBuffer());
    }
    const raw = new Uint8Array((W + 1) * H);
    for (let y = 0; y < H; y++) {
      const o = y * (W + 1), r = y * W;
      raw[o] = y ? 2 : 0;  // Up (the first row has nothing above it: None)
      for (let x = 0; x < W; x++) raw[o + 1 + x] = y ? (gray[r + x] - gray[r - W + x]) & 255 : gray[r + x];
    }
    const zdata = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    const chunk = (type, data) => {
      const td = new Uint8Array(4 + data.length); td.set(new TextEncoder().encode(type)); td.set(data, 4);
      const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
      dv.setUint32(0, data.length); out.set(td, 4); dv.setUint32(8 + data.length, crc32(td));
      return out;
    };
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, W); dv.setUint32(4, H); ihdr.set([8, 0, 0, 0, 0], 8);  // 8 bits, greyscale, deflate, no filter type, no interlace
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zdata), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  // A .zip of files stored as they are (PNGs are compressed already): [{name, bytes}] -> Blob.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zipStore(files) {
    const parts = [], dir = [], enc = new TextEncoder();
    const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF,
      dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.bytes), n = f.bytes.length;
      const h = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, dt, 2], [12, dd, 2], [14, crc, 4], [18, n, 4], [22, n, 4], [26, name.length, 2], [28, 0, 2]]
        .forEach(([o, v, w]) => w === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true));
      const c = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, dt, 2], [14, dd, 2], [16, crc, 4], [20, n, 4], [24, n, 4],
        [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]]
        .forEach(([o, v, w]) => w === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true));
      parts.push(h, name, f.bytes); dir.push(c, name);
      off += 30 + name.length + n;
    }
    const size = dir.reduce((a, x) => a + x.byteLength, 0), e = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, off, 4], [20, 0, 2]]
      .forEach(([o, v, w]) => w === 4 ? e.setUint32(o, v, true) : e.setUint16(o, v, true));
    return new Blob([...parts, ...dir, e], { type: "application/zip" });
  }
  // mode: "frame" (this frame, PNG), "video" (the clip, 75% size) or "pngs" (the clip, full-size PNGs in a .zip)
  async function saveDepth(mode) {
    const clip = mode !== "frame";
    if (!s?.bg) return;
    const A = s.bg.aspect, W = Math.round((A >= 1 ? 1280 : 1280 * A) / 8) * 8, H = Math.round(W / A / 8) * 8, size = [W, H];
    const base = (s.sc.name || "scene").replace(/[^\w-]+/g, "_").slice(0, 40) || "scene";
    const save = (href, name) => { const x = document.createElement("a"); x.href = href; x.download = name; x.click(); };
    try {
      if (!clip) {
        const cam = s.camObj || s.camKeys.length ? camForRender(s.t) : s.cam, z = depthDistances(size, s.t, cam), range = depthRange(z);
        if (!range) return Media.toast("Nothing in view to measure.");
        const u = URL.createObjectURL(new Blob([await grayPNG(depthGray(z, range), size[0], size[1])], { type: "image/png" }));
        save(u, `${base}_depth.png`); setTimeout(() => URL.revokeObjectURL(u), 4000);
        return;
      }
      const n = frameCount(), sizeM = [Math.round(W * 0.75 / 2) * 2, Math.round(H * 0.75 / 2) * 2], sizeV = mode === "pngs" ? size : sizeM;
      Media.toast(`Depth map: measuring ${n} frames…`);
      let near = Infinity, far = 0;
      for (let f = 0; f < n; f++) {
        const r = depthRange(depthDistances(sizeM, f / FPS, camForRender(f / FPS)));  // measured smaller: same range
        if (r) { near = Math.min(near, r[0]); far = Math.max(far, r[1]); }
        if (f % 8 === 0) await new Promise(res => setTimeout(res));
        if (!s) return;
      }
      if (!isFinite(near)) return Media.toast("Nothing in view to measure.");
      if (mode === "pngs") {
        const files = [];
        for (let f = 0; f < n; f++) {
          const gray = depthGray(depthDistances(sizeV, f / FPS, camForRender(f / FPS)), [near, far]);
          files.push({ name: `${base}_depth_${String(f).padStart(5, "0")}.png`, bytes: await grayPNG(gray, sizeV[0], sizeV[1]) });
          if (f % 8 === 0) Media.toast(`Depth map: frame ${f + 1} of ${n}…`);
          if (!s) return;
        }
        const u = URL.createObjectURL(zipStore(files));
        save(u, `${base}_depth_png.zip`); setTimeout(() => URL.revokeObjectURL(u), 60000);
        Media.toast(`Depth map saved: ${n} PNGs, ${sizeV[0]}×${sizeV[1]}, ${FPS} fps.`);
        return;
      }
      const fd = new FormData();
      for (let f = 0; f < n; f++) {
        const c = depthCanvas(depthDistances(sizeV, f / FPS, camForRender(f / FPS)), sizeV, [near, far]);
        const url = c.toDataURL("image/png"), bin = atob(url.slice(url.indexOf(",") + 1)), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        fd.append("frame", new Blob([bytes], { type: "image/png" }), `${String(f).padStart(5, "0")}.png`);
        if (f % 8 === 0) { Media.toast(`Depth map: frame ${f + 1} of ${n}…`); await new Promise(res => setTimeout(res)); }
        if (!s) return;
      }
      fd.append("fps", String(FPS));
      const r = await fetch("/api/frames/video", { method: "POST", body: fd }), j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || r.statusText);
      save(mediaUrl(j.ref), `${base}_depth.mp4`);
      Media.toast(`Depth map saved: ${n} frames.`);
    } catch (err) { Media.toast(`Depth map: ${err.message}`); }
    finally { if (s) s.dirty = true; }
  }

  /* ---------------------------------------------------------------- 📷 Generate photo */
  // `free`: something says what the objects are (the look text, a Becomes or a picture), so they're stand-ins that keep
  // only where they are, their size and pose; with nothing said they keep their shape and colour too. `person`: a human
  // figure in view, which is always a real person, never the grey mannequin.
  const photoPrompt = (look, first = "", free = false, person = false) => `Turn ${first ? `${first}, a 3D render,` : "this 3D render"} into a realistic photograph. Keep the composition, the camera angle, `
    + (free ? "and the position, size and pose of every object. The objects are simple 3D stand-ins to replace, not to keep: put the real thing"
      + " the text below says is there in each one's place, at its size (one the text doesn't name becomes a fitting real object of its shape"
      + " and colour), so no mannequin or plain 3D shape is left in the photo"
      : "and the position, size, shape and colour of every object exactly as they are")
    + (person ? `${free ? "; each" : ", except that each"} human figure is a real person, not a mannequin` : "")
    + ". Add no people or large objects that the render doesn't have. Give the surfaces real materials, light and shadows." + (look ? ` ${look[0].toUpperCase()}${look.slice(1)}${/[.!?]$/.test(look) ? "" : "."}` : "");
  // The whole text for a photo at t through cam: `pics` are the objects' pictures, `d` 1 when the depth map goes along.
  // `pasted`: the people pasted into the render (pastePeople); by default every Person with a picture among `pics`.
  function photoText(t, cam, look, model, pics = [], d = 0, pasted = null) {
    const tag = PIC_TAG[model] || PIC_TAG.qwen, seen = cast(t, cam).filter(x => !x.off);
    const said = expandTags(look, cast(t, cam)).text.trim();
    const free = !!said || pics.length > 0 || seen.some(x => x.becomes);
    const person = seen.some(x => x.o.prim === "figure" && !x.becomes && !pics.includes(x.o));
    pasted ??= [];
    return photoPrompt(said, pics.length || d ? tag(1) : "", free, person) + (d ? depthLine(tag, model) : "") + photoObjects(t, cam, pics, model, 2 + d, free, pasted);
  }
  const lastLook = () => { try { return localStorage.getItem("bob.scenePhotoLook") || ""; } catch { return ""; } };
  const lastFill = () => { try { return localStorage.getItem("bob.sceneGapFill") !== "0"; } catch { return true; } };
  const EDIT_NAMES = { qwen: "Qwen Image Edit 2511", h3image: "MiniMax H3 Image", mossedit: "MOSS-Image Edit" };
  const editModels = () => { const ed = state.caps?.editor || {}; return [ed.qwen !== false && ["qwen", "Qwen Image Edit 2511"], ed.h3image && ["h3image", "MiniMax H3 Image"], ed.mossedit && ["mossedit", "MOSS-Image Edit"]].filter(Boolean); };
  // A Person with a picture goes into the render in its mannequin's place before the edit model sees it: only told to
  // put the person from the picture where the mannequin is, the edit model mostly keeps the mannequin as well (beside
  // them, or wearing their clothes). So the person is cut out of the picture (SAM 3), stood on the mannequin's feet as
  // tall as it is standing, and left out wherever something in front of the mannequin covers it; the mannequin isn't
  // drawn. The edit model then poses them as the mannequin was and blends them in.
  const cutouts = new Map();  // picture ref -> the person in it, cropped, on a see-through canvas (null: none found)
  async function cutoutOf(ref) {
    if (cutouts.has(ref)) return cutouts.get(ref);
    const load = async url => createImageBitmap(await (await fetch(url)).blob());
    let out = null;
    try {
      const r = await api("/api/edit/select", { method: "POST", body: JSON.stringify({ source: ref, text: "person", threshold: 0.4 }) });
      const [pic, m] = await Promise.all([load(mediaUrl(ref)), load(r.url)]);
      const W = pic.width, H = pic.height, N = W * H;
      const cv = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = cv.getContext("2d", { willReadFrequently: true });
      g.drawImage(m, 0, 0, W, H);
      const md = g.getImageData(0, 0, W, H).data, a = new Uint8Array(N);
      for (let c = 0; c < N; c++) a[c] = md[c * 4] > 127 ? 1 : 0;
      // the biggest piece, and the smaller ones within its box (a hand apart from the arm), not someone else
      const parts = components(a, W, H).sort((p, q) => q.cells.length - p.cells.length), big = parts[0];
      if (big && big.cells.length > N * 0.01) {
        const one = new Uint8Array(N); for (const c of big.cells) one[c] = 1;
        const bb = boxOf(one, W, H, v => v === 1);
        for (const p of parts.slice(1)) if (p.cells.length > big.cells.length * 0.01) { const x = p.cells[0] % W, y = (p.cells[0] / W) | 0; if (x >= bb.x0 && x < bb.x1 && y >= bb.y0 && y < bb.y1) for (const c of p.cells) one[c] = 1; }
        const b = boxOf(one, W, H, v => v === 1);
        g.clearRect(0, 0, W, H); g.drawImage(pic, 0, 0);
        const px = g.getImageData(0, 0, W, H);
        for (let c = 0; c < N; c++) if (!one[c]) px.data[c * 4 + 3] = 0;
        g.putImageData(px, 0, 0);
        out = Object.assign(document.createElement("canvas"), { width: b.x1 - b.x0, height: b.y1 - b.y0 });
        out.getContext("2d").drawImage(cv, b.x0, b.y0, out.width, out.height, 0, 0, out.width, out.height);
        out.noFeet = b.y1 >= H - 2;  // cut off by the picture's bottom edge (a portrait): there are no feet to stand on
      }
    } catch (err) { if (/SAM 3/.test(err.message)) throw err; console.warn("Cutting out the person:", err); }
    cutouts.set(ref, out);
    return out;
  }
  // The people pasted over their mannequins in a frame of `size` at t through cam: [{ o, layer }] (layer: the frame,
  // see-through but for the person). Without SAM 3, or a picture with no whole person in it: not pasted.
  async function pastePeople(size, t, cam, objs) {
    const [W, H] = size, N = W * H, { e, VP } = viewProj(W, H, cam), out = [];
    const fwd = norm(cam.target.map((v, j) => v - e[j]));
    for (const x of s.objs) figureMesh(x, t);  // a Person in its pose at t
    const toPx = p => { const x = xf(VP, p, 1), w = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15]; return w > 1e-6 ? [(x[0] / w + 1) / 2 * W, (1 - x[1] / w) / 2 * H] : null; };
    const depthOf = x => { const p = poseAt(x, t).pos; return (p[0] - e[0]) * fwd[0] + (p[1] - e[1]) * fwd[1] + (p[2] - e[2]) * fwd[2]; };
    const shown = s.objs.filter(x => x.mesh && x.pos && !x.hidden);
    for (const o of objs) {
      let cut;
      try { cut = await cutoutOf(o.picture); } catch { return out; }  // no SAM 3
      if (!cut || cut.noFeet) continue;
      // its feet on the ground and its head as high as it stands (a Person's position is at its feet)
      const P = poseAt(o, t), pose = o.pose || "standing";
      const tall = (o.dims?.[1] || 1.74) * natDims("figure", "standing")[1] / natDims("figure", pose)[1] * (o.stretch?.[1] || 1) * (P.scale || 1);
      const feet = toPx(P.pos), head = toPx([P.pos[0], P.pos[1] + tall, P.pos[2]]);
      if (!feet || !head || feet[1] - head[1] < 8) continue;
      const h = feet[1] - head[1], w = cut.width * h / cut.height;
      // what covers each pixel (bottom row first): R this mannequin, G another object (1 + its index), B the background;
      // and where this mannequin is when nothing is in front of it
      const all = s.gpu.capture(W, H, d => {
        const o0 = { VP, eye: e, key: [0, 1, 0] };
        if (s.bgMesh) d(s.bgMesh, { ...o0, M: ID, solid: [0, 0, 1] });
        shown.forEach((x, i) => d(x.mesh, { ...o0, M: matOf(x, poseAt(x, t)), solid: x === o ? [1, 0, 0] : [0, (i + 1) / 255, 0] }));
      });
      const alone = s.gpu.capture(W, H, d => d(o.mesh, { VP, eye: e, key: [0, 1, 0], M: matOf(o, P), solid: [1, 0, 0] }));
      const near = depthOf(o), front = shown.map(x => x !== o && depthOf(x) < near);
      const layer = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = layer.getContext("2d", { willReadFrequently: true });
      g.imageSmoothingQuality = "high";
      g.drawImage(cut, feet[0] - w / 2, head[1], w, h);
      const px = g.getImageData(0, 0, W, H), d = px.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = y * W + x; if (!d[c * 4 + 3]) continue;
        const q = ((H - 1 - y) * W + x) * 4, mine = alone[q] > 127;
        // in front of the mannequin where it is (the depth test said so), or nearer than it beside it
        const other = all[q + 1] ? (mine || front[all[q + 1] - 1]) : all[q + 2] > 127 && mine;
        if (other) d[c * 4 + 3] = 0;
      }
      g.putImageData(px, 0, 0);
      out.push({ o, layer });
    }
    return out;
  }
  // A photo of the scene at time t through `cam` (queued with the edit model); it's remembered on the scene.
  // `megapixels`: the size the edit model makes it at (the render's shape); else its own, at the render's size.
  async function makePhoto(size, t, cam, look, model, usePics = false, useDepth = false, dof = false, megapixels = null) {
    if (dof && fstop()) look = [look, dofLine(false, t)].filter(Boolean).join(" ");
    // the depth map, drawn through the same camera at the same size, so it lines up with the render
    let depthRef = null;
    if (useDepth && depthOk(model)) {
      const z = depthDistances(size, t, cam), r = depthRange(z);
      if (r) depthRef = await uploadBlob(new Blob([await grayPNG(depthGray(z, r), size[0], size[1])], { type: "image/png" }), "scene_depth.png");
    }
    const off = depthRef ? 1 : 0;
    const plan = usePics ? photoPlan(t, cam, model, off) : { paste: [], sent: [] };
    const paste = await pastePeople(size, t, cam, plan.paste);
    const pics = usePics ? photoPlan(t, cam, model, off, paste.map(p => p.o)).sent : [];
    const ref = await uploadFrame(size, t, cam, "scene_view.png", paste);
    const prompt = photoText(t, cam, look, model, pics, off, paste.map(p => p.o));
    const refs = [depthRef, ...pics.map(o => o.picture)].filter(Boolean);
    const items = await submit({ kind: "image", engine: "imgedit", edit_op: "instruct", source: ref, prompt, edit_model: model,
      ...(refs.length ? { references: refs } : {}), ...(megapixels ? { edit_megapixels: megapixels } : {}),
      seed: -1, batch: 1, project: s.sc.project });
    if (!items?.length) throw new Error("The edit model didn't take it (the reason is on the Generate step)");
    s.photos.push({ id: items[0].id, t, cam: camOf(cam) });
    save();
    return items[0];
  }
  // The camera a photo or depth map is taken through: the shot camera when it's an object in the scene (even while you
  // look at it from outside), else the view as you see it.
  const shotView = () => s.camObj ? camForRender(s.t) : s.cam;
  function photoDialog() {
    if (!s?.bg) return;
    const models = editModels();
    if (!models.length) return Media.toast("Generate photo needs an edit model: Qwen Image Edit 2511 or MiniMax H3 Image.");
    const pc = shotView(), keep = lastLook(), inView = cast(s.t, pc).filter(x => !x.off);
    const box = document.createElement("div");
    box.className = "m3-make";
    box.innerHTML = `<p class="hint">Draws what ${s.camObj ? "the shot camera sees" : "the camera frames"}${s.camKeys.length ? ` (at ${s.t.toFixed(2)} s)` : ""} and has the edit model turn it into a photograph,
        keeping where everything is. The photo shows up in the gallery.</p>
      <div class="field"><label for="s3p-look">How it should look <span class="opt">optional</span></label>
        <textarea id="s3p-look" rows="3" placeholder="${s.bg.empty ? "On a sunny beach at golden hour, shot on 35 mm film." : "Soft daylight, shot on 35 mm film."}">${esc(keep)}</textarea></div>
      ${inView.length ? `<div class="field"><span class="s3p-lbl">What each object becomes <span class="opt">the edit model keeps an object as it is unless it's told</span></span>
        <div class="s3p-bec">${inView.map(x => `<label class="s3p-row"><span>${x.o.prim ? `${PRIMS[x.o.prim].icon} ` : ""}${esc(x.o.name)}</span>
          <input type="text" maxlength="200" data-oid="${esc(x.o.id)}" value="${esc(x.o.becomes || "")}" placeholder="${x.o.prim === "figure" ? "a real person (say who: a woman in a red coat…)" : x.o.prim ? `keeps its look (a ${SHAPE[x.o.prim]}); say what it is: a pile of trash…` : "keeps its look; say what it is…"}"></label>`).join("")}</div></div>` : ""}
      <div class="field"><label for="s3p-model">Model</label><select id="s3p-model">${models.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
      <label class="check s3p-depthf" title="Sends a depth map of the view along (Qwen only): it holds the layout and shapes when the look changes a lot, e.g. a whole new setting or style"><input type="checkbox" id="s3p-depth"${lastDepth() ? " checked" : ""}> Use the depth map <span class="opt">keeps the layout in a big restyle</span></label>
      ${cast(s.t, pc).some(x => !x.off && x.o.picture) ? `<label class="check"><input type="checkbox" id="s3p-pics" checked> Use the objects' pictures</label>` : ""}
      <p class="hint s3-said"></p>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint s3p-st"></span><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="go">📷 Generate</button>`;
    const win = WM.open({ id: "scene3d-photo", title: `Photo · ${s.sc.name}`, content: box, footer: foot, width: 540, height: 600, modal: true });
    const usePics = () => !!box.querySelector("#s3p-pics")?.checked, model = () => box.querySelector("#s3p-model").value;
    const useDepth = () => depthOk(model()) && !!box.querySelector("#s3p-depth")?.checked;
    // What the edit model is told, and which picture is which (it follows the model: Qwen takes 2 more pictures, H3 Image 8).
    const told = () => {
      const m = model(), d = useDepth() ? 1 : 0, plan = usePics() ? photoPlan(s.t, pc, m, d) : { paste: [], sent: [], all: 0 }, pics = plan.sent, tag = PIC_TAG[m];
      box.querySelector(".s3p-depthf").hidden = !depthOk(m);
      const all = plan.all - plan.paste.length;
      box.querySelector(".s3-said").innerHTML = `It's told: “${esc(photoText(s.t, pc, box.querySelector("#s3p-look").value, m, pics, d, plan.paste))}”`
        + (plan.paste.length ? ` ${esc(plan.paste.map(o => o.name).join(" and "))} ${plan.paste.length === 1 ? "is" : "are"} pasted in from ${plan.paste.length === 1 ? "a picture" : "their pictures"}, so no picture of them is sent as well.` : "")
        + (pics.length ? ` ${pics.map((o, i) => `${esc(o.name)} is ${esc(tag(i + 2 + d))}`).join(", ")}.` : "")
        + (usePics() && all > pics.length ? ` <span class="warn">${EDIT_NAMES[m]} takes ${PHOTO_PICS[m]} picture${PHOTO_PICS[m] === 1 ? "" : "s"} besides the render${d ? ", one of them the depth map" : ""}: ${all - pics.length} object picture${all - pics.length === 1 ? "" : "s"} left out.</span>` : "")
;
    };
    // An object's Becomes, typed here: the same field as on its panel, saved with the scene.
    box.querySelector(".s3p-bec")?.addEventListener("input", e => {
      const o = e.target.dataset.oid && s.objs.find(q => q.id === e.target.dataset.oid); if (!o) return;
      o.becomes = e.target.value.slice(0, 200); told();
    });
    box.querySelector(".s3p-bec")?.addEventListener("change", e => { if (e.target.dataset.oid) { save(); renderSide(); } });
    box.addEventListener("change", told);
    box.querySelector("#s3p-look").addEventListener("input", told);
    told();
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = async e => {
      e.target.disabled = true;
      const st = foot.querySelector(".s3p-st"), look = box.querySelector("#s3p-look").value.trim();
      try { localStorage.setItem("bob.scenePhotoLook", look); } catch { /* not kept */ }
      const A = s.bg.aspect, W = Math.round((A >= 1 ? 1280 : 1280 * A) / 8) * 8, H = Math.round(W / A / 8) * 8, size0 = [s.cv.width, s.cv.height];
      try {
        st.textContent = "Drawing the view and sending it to the edit model…";
        try { localStorage.setItem("bob.scenePhotoDepth", box.querySelector("#s3p-depth")?.checked ? "1" : "0"); } catch { /* not kept */ }
        await makePhoto([W, H], s.t, pc, look, model(), usePics(), useDepth(), s.camObj || !s.camFree);
        win.close();
        Media.toast("3D scene: the photo is being made. It shows up in the gallery.");
      } catch (err) { st.textContent = ""; e.target.disabled = false; Media.toast(`Photo: ${err.message}`); }
      finally { if (s) { s.cv.width = size0[0]; s.cv.height = size0[1]; s.dirty = true; } }
    };
  }

  /* ---------------------------------------------------------------- waiting for a photo */
  const FINAL = ["done", "failed", "cancelled"];
  const waiters = new Map();  // item id -> resolve
  function onItem(it) { const w = waiters.get(it?.id); if (w && FINAL.includes(it.status)) { waiters.delete(it.id); w(it); } }
  function resume() { /* nothing waits across a reload: a photo-started video is made with the scene open */ }
  async function waitItem(id, minutes = 15) {
    const t0 = Date.now();
    const done = new Promise(res => waiters.set(id, res));
    while (Date.now() - t0 < minutes * 60000) {
      const it = state.items.get(id);
      if (it && FINAL.includes(it.status)) { waiters.delete(id); return it; }
      const r = await Promise.race([done, new Promise(res => setTimeout(() => res(null), 2000))]);
      if (r) return r;
      if (!s) { waiters.delete(id); throw new Error("The scene was closed before the photo was done"); }
    }
    waiters.delete(id);
    throw new Error("The photo is taking too long");
  }

  /* ---------------------------------------------------------------- projecting a photo onto the scene */
  // A rough sphere around a point, far out: in a projected frame every pixel then has a surface to carry the photo.
  function sphereMesh(c, R) {
    const pos = [], idx = [], N = 24, M = 48;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= M; j++) {
      const th = i / N * Math.PI, ph = j / M * 2 * Math.PI;
      pos.push(c[0] + R * Math.sin(th) * Math.cos(ph), c[1] + R * Math.cos(th), c[2] + R * Math.sin(th) * Math.sin(ph));
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) { const a = i * (M + 1) + j, b = a + M + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    return s.gpu.upload([{ pos: new Float32Array(pos), nrm: null, uv: null, col: null, idx: new Uint32Array(idx), base: [1, 1, 1, 1], tex: null, ao: null }]);
  }
  // The photo (a media ref) as seen from `cam` at time t0: its texture, that camera's depth, and its projection.
  async function prepareProjection(photoRef, t0, cam, say = () => {}) {
    const img = await createImageBitmap(await (await fetch(`/api/media/file?path=${encodeURIComponent(photoRef)}`)).blob());
    const A = s.bg.aspect, near = s.bg.dmed * 0.01, far = s.bg.dmed * 50, e0 = eyeOf(cam);
    const VP0 = mul4(perspective(2 * Math.atan(fovOf(cam).tv), A, near, far), lookAt(e0, cam.target, axesOf(cam).u));
    const sphere = sphereMesh(e0, far * 0.8);
    const W0 = Math.min(2048, img.width), H0 = Math.round(W0 / A);
    for (const o of s.objs) figureMesh(o, t0);  // a Person in its pose at t0
    const P = { VP0, near, far, t0, sphere };
    try { await fitToPhoto(P, photoRef, e0, say); } catch (err) { console.warn("Fitting the photo:", err); }
    P.depth = s.gpu.depthPass(W0, H0, d => {
      const o0 = { VP: VP0, eye: e0, key: [0, 1, 0] };
      d(s.bgMesh, { ...o0, M: ID }); d(sphere, { ...o0, M: ID });
      for (const o of s.objs) if (o.mesh && o.pos && !o.hidden) d(o.mesh, { ...o0, M: matOf(o, fitPose(o, t0, P)) });
    });
    P.photo = s.gpu.texture(img);
    return P;
  }
  // An object's pose in a video painted from a photo: moved and sized onto where the photo has it (P.moves).
  function fitPose(o, t, P) {
    const q = poseAt(o, t), F = P?.moves?.[o.id];
    if (F) { q.pos = [q.pos[0] + F.d[0], q.pos[1], q.pos[2] + F.d[2]]; q.scale = (q.scale ?? 1) * F.k; }
    return q;
  }
  function freeProjection(P) { if (!P || !s) return; s.gpu.free(P.depth); s.gpu.free(P.photo); s.gpu.free(P.cut); s.gpu.free(P.bgOnly?.cut); for (const g of P.gaps || []) freeProjection(g.P); }
  /* The photo as a background only, for the gap views: everything near an object in it (its stand-in's shape from the
     photo's camera, and what SAM found, grown well round, more downwards for its shadow) is a hole, so the bits of a
     person just outside a mannequin's shape don't lie on the ground as streaks (Qwen drew a second person from one). */
  function bgOnly(P) {
    if (P.bgOnly) return P.bgOnly;
    const W = P.found?.W || 768, H = P.found?.H || Math.round(768 / s.bg.aspect), N = W * H;
    const raw = s.gpu.capture(W, H, d => {
      const o0 = { VP: P.VP0, eye: [0, 0, 0], key: [0, 1, 0] };
      d(s.bgMesh, { ...o0, M: ID, solid: [0, 0, 0] });
      for (const o of s.objs) if (o.mesh && o.pos && !o.hidden) d(o.mesh, { ...o0, M: matOf(o, fitPose(o, P.t0, P)), solid: [1, 1, 1] });
    });
    const a = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = raw[((H - 1 - y) * W + x) * 4] > 127 || P.found?.a[y * W + x] ? 1 : 0;
    const R = Math.round(W * 0.035) + 2, g = grow(a, W, H, R, R, 2 * R), cut = new ImageData(W, H);
    for (let c = 0; c < N; c++) { cut.data[c * 4 + 1] = g[c] * 255; cut.data[c * 4 + 3] = 255; }
    P.bgOnly = { ...P, cut: s.gpu.texture(cut), fits: null, gaps: null, bgOnly: null };
    return P.bgOnly;
  }

  /* ---- Filling the gaps with Qwen. A camera move from a photo shows what the photo never saw (the far side of a
     turn, the ground behind a person who moves). Where the move shows a lot of it, the view there is drawn from what
     the scene has (the photo, and views already filled), background only; what nothing covers is painted magenta,
     and Qwen Image Edit paints the place in there (as Replace does). That view is then painted onto the scene from
     its camera, under the photo, so H3 follows real, consistent surroundings all round rather than inventing them as
     it goes. Views grow out from the photo: each is the moment about half covered (so Qwen has the place to go on from,
     never a blank), until every moment is mostly covered, up to MAX_GAPS (a full orbit takes about five). */
  const MAX_GAPS = 6, GAP_ENOUGH = 0.85, GAP_EDGE = 0.5, GAP_LENS = 16;
  // The filled views for a frame seen through `cam`: the furthest from it first, so the nearest is drawn last (on top).
  const turnApart = (a, b) => { const d = Math.abs(((a.yaw - b.yaw) % 360 + 540) % 360 - 180); return d + Math.abs(a.pitch - b.pitch) + Math.abs(a.dist - b.dist) / s.bg.dmed * 30; };
  // Only views within GAP_REACH of it: seen from much further round, a view painted onto the ground stretches into streaks.
  const GAP_REACH = 75;
  const gapLayers = (P, cam) => !P?.gaps?.length ? [] : P.gaps.filter(g => turnApart(g.cam, cam) < GAP_REACH)
    .sort((a, b) => turnApart(b.cam, cam) - turnApart(a.cam, cam)).map(g => g.P);
  // How much of the frame through `cam` at t the photo and the filled views cover (their background), 0 to 1.
  function coverAt(P, t, cam, W = 192) {
    const H = Math.round(W / s.bg.aspect), c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d", { willReadFrequently: true });
    g.globalCompositeOperation = "lighter";
    for (const L of [bgOnly(P), ...gapLayers(P, cam)]) { draw({ size: [W, H], t, cam, mask: "proj", proj: L, skip: s.objs }); g.drawImage(s.cv, 0, 0, W, H); }
    const d = g.getImageData(0, 0, W, H).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 127) n++;
    return n / (W * H);
  }
  // A background-only projection (a filled view): no objects fitted, and its depth is the background's alone.
  async function prepareBgProjection(photoRef, t0, cam) {
    const img = await createImageBitmap(await (await fetch(`/api/media/file?path=${encodeURIComponent(photoRef)}`)).blob());
    const A = s.bg.aspect, near = s.bg.dmed * 0.01, far = s.bg.dmed * 50, e0 = eyeOf(cam);
    const VP0 = mul4(perspective(2 * Math.atan(fovOf(cam).tv), A, near, far), lookAt(e0, cam.target, axesOf(cam).u));
    const sphere = sphereMesh(e0, far * 0.8), W0 = Math.min(2048, img.width), H0 = Math.round(W0 / A);
    const P = { VP0, near, far, t0, sphere };
    P.depth = s.gpu.depthPass(W0, H0, d => { const o0 = { VP: VP0, eye: e0, key: [0, 1, 0] }; d(s.bgMesh, { ...o0, M: ID }); d(sphere, { ...o0, M: ID }); });
    P.photo = s.gpu.texture(img);
    return P;
  }
  const GAP_TEXT = look => "Replace every solid magenta area with the rest of this place, continuing the ground, the horizon, the sky and "
    + "the surroundings from the rest of the picture, so it is one seamless photograph with the same light, colours, lens and style. "
    + (look ? `The place: ${look.replace(/[.\s]+$/, "")}. ` : "")
    + "Keep the ground near the camera flat and open; put anything tall (plants, rocks, buildings) only in the distance. "
    + "Add no people, animals or large objects. No magenta remains. Keep everything that isn't magenta exactly the same.";
  // Fill the gaps of a camera move from the photo P (adds P.gaps); `look`: how the place looks, in words.
  async function fillGaps(P, look, say = () => {}) {
    const models = editModels(); if (!models.length) return 0;
    const model = (models.find(m => m[0] === "qwen") || models[0])[0];
    P.gaps = P.gaps || [];
    const n = frameCount(), step = Math.max(1, Math.round(FPS / 4)), ts = [];
    for (let f = 0; f < n; f += step) ts.push(f / FPS);
    const A = s.bg.aspect, W = Math.round((A >= 1 ? 1024 : 1024 * A) / 8) * 8, H = Math.round(W / A / 8) * 8;
    for (let k = 0; k < MAX_GAPS; k++) {
      say(`Finding what the photo can't see (view ${k + 1})…`);
      // the moment nearest half covered among those not covered enough: the edge of what's known
      let worst = null;
      for (const t of ts) { const c = coverAt(P, t, camForRender(t)); if (c < GAP_ENOUGH && (!worst || Math.abs(c - GAP_EDGE) < Math.abs(worst.c - GAP_EDGE))) worst = { t, c }; }
      if (!worst) break;
      // the unshaken camera (a steady view to paint from), with a wide lens: each view then covers about 90° of a turn
      const t = worst.t, c0 = camBase(t), cam = { ...c0, lens: Math.min(c0.lens || baseLens(), GAP_LENS) };
      // the view as the scene has it, background only; magenta where nothing covers it
      const view = Object.assign(document.createElement("canvas"), { width: W, height: H }), vg = view.getContext("2d", { willReadFrequently: true });
      vg.fillStyle = "#ff00ff"; vg.fillRect(0, 0, W, H);
      for (const L of [...gapLayers(P, cam), bgOnly(P)]) { draw({ size: [W, H], t, cam, proj: L, skip: s.objs }); vg.drawImage(s.cv, 0, 0, W, H); }
      const px = vg.getImageData(0, 0, W, H), d = px.data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] < 250) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 255; d[i + 3] = 255; }
      vg.putImageData(px, 0, 0);
      const blob = await new Promise(r => view.toBlob(r, "image/png")), fd = new FormData(); fd.append("file", blob, "scene_gap.png");
      const up = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
      say(`Qwen is filling in what the photo can't see, ${Math.round((1 - worst.c) * 100)}% of the view at ${t.toFixed(1)} s (view ${k + 1}, about half a minute)…`);
      const items = await submit({ kind: "image", engine: "imgedit", edit_op: "instruct", source: up.ref, prompt: GAP_TEXT(look), edit_model: model, seed: -1, batch: 1, project: s.sc.project });
      if (!items?.length) throw new Error("Qwen didn't take the view to fill");
      const it = await waitItem(items[0].id);
      const path = (it.files || []).find(f => /^image\//.test(f.content_type || ""))?.path || it.files?.[0]?.path;
      if (it.status !== "done" || !path) throw new Error("Qwen couldn't fill a view");
      P.gaps.push({ t, cam, ref: path, P: await prepareBgProjection(path, t, cam) });
    }
    return P.gaps.length;
  }

  // The edit model seldom puts a moving object exactly on its stand-in, so painting the photo on as it is makes the
  // stand-in walk off with the wrong pixels (H3 then draws the mannequin) and leaves the real thing behind, standing
  // on the ground. So each moving object is looked for in the photo (SAM 3, near its stand-in), and its whole path is
  // moved over the ground and its size changed so it starts where, and as big as, the photo has it (P.moves). It then
  // carries only what was found (P.fits), and what was found, grown a little, is a hole on everything else (P.cut),
  // for H3 to fill in once it has gone. Without SAM 3, or when nothing is found, as before.
  async function fitToPhoto(P, photoRef, e0, say) {
    // the objects that move, and, when the camera moves, every object: as the view turns, what the photo drew of a
    // still object outside its stand-in's shape (a coat wider than a mannequin, its shadow) would stay painted on the
    // ground behind it and slide off as a ghost
    const camMoves = cameraMoves();
    const moving = s.objs.filter(o => o.mesh && o.pos && !o.hidden && (o.keys?.length > 1 || camMoves)).slice(0, 8);
    if (!moving.length) return;
    const A = s.bg.aspect, W = 768, H = Math.round(W / A), N = W * H;
    // which stand-in covers each pixel at t0 (1 + its index; 0: none), top row first; pose(o) is where it is
    const whoAt = pose => {
      const raw = s.gpu.capture(W, H, d => {
        const o0 = { VP: P.VP0, eye: e0, key: [0, 1, 0] }, black = [0, 0, 0];
        d(s.bgMesh, { ...o0, M: ID, solid: black });
        for (const o of s.objs) if (o.mesh && o.pos && !o.hidden) {
          const i = moving.indexOf(o);
          d(o.mesh, { ...o0, M: matOf(o, pose(o)), solid: i < 0 ? black : [(i + 1) / 255, 0, 0] });
        }
      });
      const a = new Uint8Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = raw[((H - 1 - y) * W + x) * 4];
      return a;
    };
    // its silhouette in such a picture: the biggest piece (a stray pixel or two would stretch the box), or null
    const silOf = (a, i) => {
      const me = new Uint8Array(N); for (let c = 0; c < N; c++) me[c] = a[c] === i + 1 ? 1 : 0;
      const big = components(me, W, H).sort((p, q) => q.cells.length - p.cells.length)[0];
      if (!big || big.cells.length < 40) return null;
      me.fill(0); for (const c of big.cells) me[c] = 1;
      return { me, box: boxOf(me, W, H, v => v === 1) };
    };
    const who = whoAt(o => poseAt(o, P.t0)), found_ = {};
    const found = new Uint8Array(N), fits = {}, moves = {}, inv = inv4(P.VP0);
    // the point on the level y = h seen at pixel (x, y), or null
    const ground = (x, y, h) => {
      const at = z => { const v = [x / W * 2 - 1, 1 - y / H * 2, z], w = inv[3] * v[0] + inv[7] * v[1] + inv[11] * v[2] + inv[15]; return xf(inv, v, 1).map(c => c / w); };
      const a = at(-1), b = at(1), u = (h - a[1]) / (b[1] - a[1]);
      return isFinite(u) && u > 0 ? [a[0] + (b[0] - a[0]) * u, h, a[2] + (b[2] - a[2]) * u] : null;
    };
    const img = await createImageBitmap(await (await fetch(`/api/media/file?path=${encodeURIComponent(photoRef)}`)).blob());
    const kx = img.width / W, ky = img.height / H;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    for (const [i, o] of moving.entries()) {
      const sil = silOf(who, i);
      if (!sil) continue;  // not in the photo's view
      const { me, box: sb } = sil;
      say(`Finding ${o.name} in the photo…`);
      const bw = sb.x1 - sb.x0, bh = sb.y1 - sb.y0;
      const bx0 = Math.max(0, sb.x0 - 0.75 * bw), bx1 = Math.min(W, sb.x1 + 0.75 * bw), by0 = Math.max(0, sb.y0 - 0.35 * bh), by1 = Math.min(H, sb.y1 + 0.35 * bh);
      const text = o.prim === "figure" ? "person" : bare(o.becomes) || o.name;
      let r;
      try {
        r = await api("/api/edit/select", { method: "POST", body: JSON.stringify({ source: photoRef, text, threshold: 0.4,
          box: { x: Math.round(bx0 * kx), y: Math.round(by0 * ky), width: Math.round((bx1 - bx0) * kx), height: Math.round((by1 - by0) * ky) } }) });
      } catch (err) { if (/SAM 3/.test(err.message)) return; continue; }  // no SAM 3: no fitting at all
      const m = await createImageBitmap(await (await fetch(r.url)).blob());
      cx.clearRect(0, 0, W, H); cx.drawImage(m, 0, 0, W, H);
      const px = cx.getImageData(0, 0, W, H).data, mine = new Uint8Array(N);
      for (let y = Math.floor(by0); y < by1; y++) for (let x = Math.floor(bx0); x < bx1; x++) mine[y * W + x] = px[(y * W + x) * 4] > 127 ? 1 : 0;
      // SAM may find more than one (another person the edit model added): keep what touches the stand-in, else the biggest
      const parts = components(mine, W, H), touch = parts.filter(p => p.cells.some(c => me[c]));
      const keep = touch.length ? touch : parts.sort((a, b) => b.cells.length - a.cells.length).slice(0, 1);
      if (!keep.length) continue;
      const pick = new Uint8Array(N); for (const p of keep) for (const c of p.cells) pick[c] = 1;
      const pb = boxOf(pick, W, H, v => v === 1), pw = pb.x1 - pb.x0, ph = pb.y1 - pb.y0;
      const area = (pw * ph) / (bw * bh);
      if (area < 0.2 || area > 5) continue;  // not the same thing
      // Where its feet are, on the ground through the photo's camera: at the stand-in's, and at what was found. A side
      // the frame cuts off is no guide, so the other one is lined up; feet out of the frame: left as it is.
      if (sb.y1 >= H - 1 || pb.y1 >= H - 1) continue;
      const ax = sb.x0 <= 1 && sb.x1 < W - 1 ? [sb.x1, pb.x1] : sb.x1 >= W - 1 && sb.x0 > 1 ? [sb.x0, pb.x0] : [(sb.x0 + sb.x1) / 2, (pb.x0 + pb.x1) / 2];
      const p0 = poseAt(o, P.t0), hs = ground(ax[0], sb.y1, p0.pos[1]), hp = ground(ax[1], pb.y1, p0.pos[1]);
      if (!hs || !hp) continue;
      const d = [hp[0] - hs[0], 0, hp[2] - hs[2]], tall = (o.mesh.hi[1] - o.mesh.lo[1]) * (o.stretch?.[1] || 1) * (p0.scale ?? 1);
      if (Math.hypot(d[0], d[2]) > 3 * tall) continue;  // too far to be it
      // as tall as found, allowing for the new distance (a frame edge across either: the size stays)
      const far0 = Math.hypot(...p0.pos.map((v, j) => v - e0[j])), far1 = Math.hypot(...p0.pos.map((v, j) => v + d[j] - e0[j]));
      const k = sb.y0 <= 1 || pb.y0 <= 1 ? 1 : Math.min(2, Math.max(0.5, ph / bh * far1 / far0));
      moves[o.id] = { d, k }; found_[o.id] = { pb, pick };
    }
    if (!Object.keys(moves).length) return;
    // Moved, its shape still isn't the photo's (a mannequin side on, a person facing the camera): every bit of it
    // takes the photo from the same place in what was found (its box onto that box), so it carries only that. A side
    // of it the frame cuts off is taken from its 3D box.
    P.moves = moves;
    const who2 = whoAt(o => fitPose(o, P.t0, P)), px = x => x / W * 2 - 1, py = y => 1 - y / H * 2;
    for (const [i, o] of moving.entries()) {
      const pb = found_[o.id]?.pb, sil = pb && silOf(who2, i);
      if (!sil) { delete moves[o.id]; continue; }
      const b = sil.box, M = matOf(o, fitPose(o, P.t0, P));
      const cs = boxCorners(o, M).map(c => { const v = xf(P.VP0, c, 1), w = P.VP0[3] * c[0] + P.VP0[7] * c[1] + P.VP0[11] * c[2] + P.VP0[15]; return [v[0] / w, v[1] / w]; });
      const x0 = b.x0 <= 1 ? Math.min(...cs.map(c => c[0])) : px(b.x0), x1 = b.x1 >= W - 1 ? Math.max(...cs.map(c => c[0])) : px(b.x1);
      const y1 = b.y0 <= 1 ? Math.max(...cs.map(c => c[1])) : py(b.y0), y0 = b.y1 >= H - 1 ? Math.min(...cs.map(c => c[1])) : py(b.y1);
      const sx = (px(pb.x1) - px(pb.x0)) / (x1 - x0), sy = (py(pb.y0) - py(pb.y1)) / (y1 - y0);
      fits[o.id] = [sx, sy, px(pb.x0) - x0 * sx, py(pb.y1) - y0 * sy];
      const pick = found_[o.id].pick; for (let c = 0; c < N; c++) if (pick[c]) found[c] = 1;
    }
    if (!Object.keys(fits).length) { delete P.moves; return; }
    // r: what was found, its gaps closed (between an arm and the body); g: grown, a bit more downwards (its shadow)
    const R = Math.round(W * 0.012) + 2, r2 = Math.round(R / 2);
    const shut = grow(grow(found, W, H, r2, r2, r2).map(v => 1 - v), W, H, r2, r2, r2).map(v => 1 - v);
    for (let c = 0; c < N; c++) found[c] = shut[c];
    const grown = grow(found, W, H, R, R, 2 * R);
    const cut = new ImageData(W, H);
    for (let c = 0; c < N; c++) { cut.data[c * 4] = found[c] * 255; cut.data[c * 4 + 1] = grown[c] * 255; cut.data[c * 4 + 3] = 255; }
    P.cut = s.gpu.texture(cut); P.fits = fits; P.found = { a: found, W, H };
  }
  // a 0/1 picture grown by rx across, up pixels up and down pixels down (a box)
  function grow(a, W, H, rx, up, down) {
    const row = new Uint8Array(a.length), out = new Uint8Array(a.length);
    for (let y = 0; y < H; y++) {
      let last = -1e9; for (let x = 0; x < W; x++) { if (a[y * W + x]) last = x; row[y * W + x] = x - last <= rx ? 1 : 0; }
      last = 1e9; for (let x = W - 1; x >= 0; x--) { if (a[y * W + x]) last = x; if (last - x <= rx) row[y * W + x] = 1; }
    }
    for (let x = 0; x < W; x++) {
      let last = -1e9; for (let y = 0; y < H; y++) { if (row[y * W + x]) last = y; out[y * W + x] = y - last <= down ? 1 : 0; }
      last = 1e9; for (let y = H - 1; y >= 0; y--) { if (row[y * W + x]) last = y; if (last - y <= up) out[y * W + x] = 1; }
    }
    return out;
  }
  // the box around the pixels where test(v) holds: { x0, y0, x1, y1 (exclusive), n }, or null
  function boxOf(a, W, H, test) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (test(a[y * W + x])) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return n ? { x0, y0, x1: x1 + 1, y1: y1 + 1, n } : null;
  }
  // the connected pieces of a 0/1 picture: [{ cells: [index…] }]
  function components(a, W, H) {
    const seen = new Uint8Array(a.length), out = [];
    for (let c0 = 0; c0 < a.length; c0++) {
      if (!a[c0] || seen[c0]) continue;
      const cells = [c0]; seen[c0] = 1;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k], x = c % W;
        for (const d of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) if (d >= 0 && d < a.length && a[d] && !seen[d]) { seen[d] = 1; cells.push(d); }
      }
      out.push({ cells });
    }
    return out;
  }

  /* ---------------------------------------------------------------- time */
  function renderTime() {
    if (!s) return;
    const sc = s.root.querySelector(".s3-scrub"), D = dur();
    sc.max = String(D); sc.value = String(s.t);
    s.root.querySelector(".s3-time").textContent = `${s.t.toFixed(2)} / ${D.toFixed(2)} s`;
    const sec = s.root.querySelector(".s3-sec"); if (document.activeElement !== sec) sec.value = String(s.seconds);
    s.root.querySelector('[data-act="play"]').textContent = s.playing ? "⏸" : "▶";
  }
  // The camera's keys as chips (time, lens, easing), and the easing of the move from the key at the playhead.
  function camKeysHtml(K) {
    const chips = K.map((q, j) => `<button type="button" class="chip-btn${near(q.t, s.t) ? " on" : ""}" data-act="cam-key" data-k="${j}">${q.t.toFixed(2)} s${q.lens ? ` · ${Math.round(q.lens)} mm` : ""}${q.focus && fstop() ? ` · ⌖ ${q.focus.toFixed(1)}` : ""}${q.shake ? ` · shake ${Math.round(q.shake)}%` : ""}${q.ease && j < K.length - 1 ? ` · ${EASES[q.ease].short}` : ""}</button><button type="button" class="set-x" data-act="del-cam-key" data-k="${j}" aria-label="Remove the camera key at ${q.t.toFixed(2)} s">×</button>`).join(" ");
    const i = K.findIndex(q => near(q.t, s.t));
    const row = i >= 0 && i < K.length - 1 ? `<div class="field s3-ease"><label for="s3-ease">From ${K[i].t.toFixed(2)} s to the next key (${K[i + 1].t.toFixed(2)} s)</label>
      <select id="s3-ease" title="How the camera speeds up and slows down on its way to the next key (move, turn, zoom and roll)">${Object.entries({ "": { label: "Steady: the same speed all the way" }, ...EASES }).map(([v, e]) => `<option value="${v}"${(K[i].ease || "") === v ? " selected" : ""}>${e.label}</option>`).join("")}</select></div>`
      : K.length > 1 ? `<p class="hint s3-ease-h">Move the playhead to a key (click its chip) to choose how the camera eases to the next one.</p>` : "";
    return chips + row;
  }
  function renderCam() {
    if (!s) return;
    const K = s.camKeys, cb = s.root.querySelector("#s3-camobj");
    if (cb) {
      cb.checked = !!s.camObj; s.root.querySelector(".s3-camobj-row").hidden = !s.camObj;
      s.root.querySelector(".s3-pipf").hidden = !s.camObj; s.root.querySelector("#s3-pip").checked = !!s.pip;
      const sh = shotLinked();
      s.root.querySelector(".s3-camobj-l").textContent = sh ? `The camera as an object (shot ${sh.i + 1}'s)` : "The camera as an object";
      s.root.querySelector('[data-act="cam-sel"]').classList.toggle("on", !!s.camSel);
    }
    if (s.camObj) {
      s.root.querySelector(".s3-camhint").textContent = s.camFree
        ? `You're outside the shot camera (the frame${s.camSel ? ", orange: selected" : ", blue"}). Click it, then drag its arrows to move it or its rings to pan and tilt; or type its position. Changes key it at ${s.t.toFixed(2)} s.`
        : "You're looking through the shot camera. Orbit, pan or zoom to step outside it again.";
      s.root.querySelector(".s3-camkeys").innerHTML = camKeysHtml(K);
      return;
    }
    s.root.querySelector(".s3-camhint").textContent = !K.length ? "Look around, then ◆ key the view at the playhead; key another view later on for a camera move."
      : s.camFree ? `You've moved the view: ◆ key it at ${s.t.toFixed(2)} s, or move the playhead to go back on the camera's path (blue).`
      : K.length === 1 ? "One key: the camera holds this view. Key another view at another time to move it." : "The camera moves through its keys.";
    s.root.querySelector(".s3-camkeys").innerHTML = camKeysHtml(K);
  }
  function stop() { s.playing = false; renderTime(); renderSide(); }
  function play() {
    if (!s?.bg) return;
    if (s.playing) return stop();
    if (s.t >= dur() - 1e-3) s.t = 0;
    s.playing = true; const t0 = performance.now() - s.t * 1000;
    const step = now => {
      if (!s?.playing) return;
      setTime(Math.min(dur(), (now - t0) / 1000));
      if (s.t >= dur()) stop(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step); renderTime();
  }

  return { mount, autoRender, current, addFromLibrary, select: i => s?.bg && select(i), selectCam: () => s?.bg && selectCam(),
    rename: (i, name) => { const o = s?.objs[i]; if (!o || !String(name || "").trim()) return; o.name = String(name).trim().slice(0, 120); save(); renderSide(); }, CAM_MOVES, applyCameraMove, cameraOut, applySavedCamera, renderForShot, photoForShot, fromTemplate, setTemplate, create, createEmpty, createFor, projectScenes, inputPictures, open, openList, onItem, resume, refreshPanel, _state: () => s, _poseAt: (o, t) => poseAt(o, t), _addPrim: (k, at) => addPrim(k, at), _menu: (px, py) => { const r = s.cv.getBoundingClientRect(), h = pick(px, py); h >= 0 ? objMenu(h, r.left + px, r.top + py, px, py) : spaceMenu(r.left + px, r.top + py, px, py); }, _draw: (r = null) => s && s.bg && draw(r),
    _render: (kind, size, n, proj = null) => renderVideo(kind, size, n, () => {}, proj), _project: (ref, t0, cam) => prepareProjection(ref, t0, cam), _fill: (P, look, say) => fillGaps(P, look, say), _info: () => s && s.bg && { moves: cameraMoves(), picture: startsAsPicture(), frames: frameCount() } };
})();
