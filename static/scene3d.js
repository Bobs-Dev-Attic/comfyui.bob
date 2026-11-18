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
   📷 Generate photo draws what the camera frames (the frame on the view) and has the image editor's whole-picture edit
   (Qwen Image Edit 2511 or MiniMax H3 Image) make a photograph of it, keeping the layout. */
"use strict";

const Scene3D = (() => {
  const rad = Math.PI / 180;
  const G = () => Model3D.gl;
  let s = null;        // the open scene window
  let list = null;     // the open scenes list
  let models = [];     // /api/models3d, refreshed while any is being made

  const uid = () => Math.random().toString(36).slice(2, 10);
  const FPS = 24;
  const dur = () => ((window.H3Prompt?.h3Length?.(+s.seconds || 5) ?? Math.round((+s.seconds || 5) * FPS) + 1) - 1) / FPS;
  const near = (a, b) => Math.abs(a - b) < 0.5 / FPS;

  /* ---------------------------------------------------------------- keys */
  const cr = (q0, q1, q2, q3, u) => 0.5 * ((2 * q1) + (-q0 + q2) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u * u + (-q0 + 3 * q1 - 3 * q2 + q3) * u * u * u);
  // Between keys K (sorted by t): fields in `smooth` on a Catmull-Rom curve, the rest in a straight line.
  function interp(K, t, smooth) {
    if (K.length === 1 || t <= K[0].t) return K[0];
    if (t >= K.at(-1).t) return K.at(-1);
    let i = 0; while (K[i + 1].t < t) i++;
    const a = K[i], b = K[i + 1], p0 = K[i - 1] || a, p3 = K[i + 2] || b, u = (t - a.t) / Math.max(1e-6, b.t - a.t), out = { t };
    for (const k of Object.keys(a)) {
      if (k === "t") continue;
      if (Array.isArray(a[k])) out[k] = a[k].map((v, j) => smooth.includes(k) ? cr(p0[k][j], v, b[k][j], p3[k][j], u) : v + (b[k][j] - v) * u);
      else out[k] = smooth.includes(k) ? cr(p0[k], a[k], b[k], p3[k], u) : a[k] + (b[k] - a[k]) * u;
    }
    return out;
  }
  const baseOf = o => ({ pos: o.pos.slice(), yaw: o.yaw || 0, scale: o.scale });
  // An object's pose at time t.
  function poseAt(o, t) { return o.keys?.length ? interp(o.keys, t, ["pos"]) : baseOf(o); }
  // Change an object at the playhead: before it has keys, at 0 s this is its place; otherwise it's keyed there.
  function editPose(o, f) {
    if (!o.keys?.length) {
      if (near(s.t, 0)) { Object.assign(o, f); return; }
      o.keys = [{ t: 0, ...baseOf(o) }];
    }
    let k = o.keys.find(q => near(q.t, s.t));
    if (!k) { const p = poseAt(o, s.t); k = { t: s.t, pos: p.pos.slice(), yaw: p.yaw, scale: p.scale }; o.keys.push(k); o.keys.sort((a, b) => a.t - b.t); }
    Object.assign(k, f);
    Object.assign(o, { pos: o.keys[0].pos.slice(), yaw: o.keys[0].yaw, scale: o.keys[0].scale });
  }
  const camOf = c => ({ yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: c.target.slice() });
  function camAt(t) { const c = interp(s.camKeys, t, ["yaw", "pitch", "dist", "target"]); return { ...camOf(c), dist: Math.max(s.bg.dmed * 0.02, c.dist) }; }
  // The playhead moved: the camera goes back on its path.
  function setTime(t) {
    s.t = Math.max(0, Math.min(dur(), t));
    if (s.camKeys.length && s.bg) { s.cam = camAt(s.t); s.camFree = false; }
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
      open(sc.id);
    } catch (e) { Media.toast(`3D scene: ${e.message}`); }
  }

  /* ---------------------------------------------------------------- the list */
  async function openList() {
    if (list?.win?.el?.isConnected) return refreshList();
    const box = document.createElement("div");
    box.className = "m3-list";
    box.innerHTML = `<div class="s3-listbar"><button type="button" class="btn sm primary" data-new="1" title="A floor and a sky to build a scene from 3D models, with no picture">＋ New empty scene</button></div><div class="m3-grid"></div>`;
    box.querySelector("[data-new]").onclick = () => createEmpty();
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
    if (!list) return;
    try { list.items = (await api("/api/scenes")).scenes || []; } catch (e) { list.grid.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    list.grid.innerHTML = list.items.length ? list.items.map((x, i) => `
      <figure class="m3-card ${x.status}" data-i="${i}" tabindex="0">
        <div class="m3-thumb">${x.plate_url || x.picture_url ? `<img src="${esc(x.plate_url || x.picture_url)}" alt="">` : "🏞"}${x.status === "failed" ? `<span class="m3-fail">Failed</span>` : ""}</div>
        <figcaption><b>${esc(x.name)}</b><span class="hint">${x.objects?.length || 0} object${x.objects?.length === 1 ? "" : "s"}${x.status === "failed" ? ` · ${esc((x.error || "").slice(0, 60))}` : ""}</span></figcaption>
        <button type="button" class="m3-more" data-more="${i}" aria-label="More for ${esc(x.name)}">⋯</button></figure>`).join("")
      : `<p class="hint m3-empty">No 3D scenes yet. Right-click a picture and choose 🏞 3D scene, or use 🏞 Open as a 3D scene in 🎬 Animate objects.</p>`;
  }
  function itemMenu(x, px, py) {
    if (!x) return;
    Media.menu(px, py, [
      x.status === "done" && ["🏞 Open", () => open(x.id)],
      ["✎ Rename…", async () => { const n = prompt("Name", x.name); if (!n?.trim()) return; try { await api(`/api/scenes/${x.id}`, { method: "PATCH", body: JSON.stringify({ name: n.trim() }) }); refreshList(); } catch (e) { Media.toast(e.message); } }],
      ["🗑 Delete…", async () => { if (!confirm(`Delete the scene “${x.name}”? Its 3D models stay in 🧊 3D models.`)) return; try { await api(`/api/scenes/${x.id}`, { method: "DELETE" }); refreshList(); } catch (e) { Media.toast(e.message); } }],
    ].filter(Boolean));
  }

  /* ---------------------------------------------------------------- maths */
  const { mul4, perspective, lookAt } = { mul4: (...a) => G().mul4(...a), perspective: (...a) => G().perspective(...a), lookAt: (...a) => G().lookAt(...a) };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mulv = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const S = k => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
  const RY = a => { const c = Math.cos(a), n = Math.sin(a); return [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 0, 0, 0, 1]; };
  const ID = T(0, 0, 0);

  // An object's model matrix: its anchor (bottom middle of the model's box) at pos, turned and scaled about it.
  function matOf(o, P = poseAt(o, s.t)) {
    const a = o.mesh.anchor;
    return mul4(mul4(mul4(T(...P.pos), RY(P.yaw * rad)), S(P.scale)), T(-a[0], -a[1], -a[2]));
  }

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
      const scale = 1 / Math.max(1e-6, hgt, m.hi[0] - m.lo[0], dep);
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

  /* ---------------------------------------------------------------- saving */
  function save() {
    clearTimeout(s.saveT);
    const id = s.id;
    const objects = s.objs.map(o => ({ id: o.id, name: o.name, model: o.model, mask: o.mask, pos: o.pos, yaw: o.yaw || 0, scale: o.scale, auto_scale: o.auto_scale, hidden: !!o.hidden, keys: o.keys || [] }));
    const body = JSON.stringify({ objects, seconds: +s.seconds || 5, camera_keys: s.camKeys, photos: s.photos,
      ...(s.sc.kind === "empty" ? { aspect: s.sc.aspect, lens: s.sc.lens, backdrop: s.sc.backdrop } : {}) });
    s.saveT = setTimeout(() => api(`/api/scenes/${id}`, { method: "PATCH", body }).catch(e => Media.toast(`Couldn't save the scene: ${e.message}`)), 500);
  }

  /* ---------------------------------------------------------------- the window */
  async function open(id) {
    if (s?.win) s.win.close();
    let sc;
    try { sc = await api(`/api/scenes/${id}`); } catch (e) { return Media.toast(e.message); }
    const root = document.createElement("div");
    root.className = "s3";
    root.innerHTML = `
      <div class="s3-stage"><div class="s3-box"><canvas class="m3-canvas s3-canvas" tabindex="0" aria-label="The 3D scene: drag an object to move it, drag elsewhere to orbit, wheel to zoom"></canvas>
        <div class="m3-hud hint s3-hud">Making the background…</div><div class="s3-frame" aria-hidden="true"></div></div>
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
          <p class="hint s3-bgnote"></p></section>
        <section><h3>Camera</h3>
          <p class="hint s3-camhint"></p>
          <div class="mo-row"><button type="button" class="btn sm" data-act="key-cam" title="Keep this view at the playhead">◆ Key the camera</button>
            <button type="button" class="btn sm ghost" data-act="clear-cam">Clear its keys</button></div>
          <div class="mo-keys s3-camkeys"></div></section>
        <section><h3>Objects</h3><ul class="mo-layers s3-objs"></ul>
          <div class="mo-find"><select class="s3-add" aria-label="A 3D model to add"></select><button type="button" class="btn sm" data-act="add">Add</button></div></section>
        <section class="s3-sel" hidden><h3 class="s3-sel-h"></h3>
          <div class="field"><label for="s3-yaw">Turn <span class="s3-yaw-v"></span></label><input type="range" id="s3-yaw" min="-180" max="180" step="1"></div>
          <div class="field"><label for="s3-size">Size <span class="s3-size-v"></span></label><input type="range" id="s3-size" min="0.2" max="3" step="0.01"></div>
          <div class="mo-row"><button type="button" class="btn sm" data-act="replace" title="Stand it where it was in the picture again">↺ Put back</button>
            <button type="button" class="btn sm ghost" data-act="hide">Hide</button><button type="button" class="btn sm ghost" data-act="remove">Remove</button></div>
          <p class="hint s3-objhint"></p>
          <div class="mo-keys s3-objkeys"></div></section>
      </aside>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint s3-foot">Drag: orbit · Right-drag: pan · Wheel: zoom</span><button type="button" class="btn ghost" data-act="pic" title="Save the view as it is drawn here">💾 Save view</button>
      <button type="button" class="btn" data-act="photo" title="A photograph of what the camera frames, made by the image editor's edit model">📷 Generate photo…</button>
      <button type="button" class="btn primary" data-act="render" title="Make the video with H3, following this scene">🎬 Render video…</button>`;
    const win = WM.open({ id: "scene3d", title: `🏞 ${sc.name}`, content: root, footer: foot, width: 1100, height: 720, minWidth: 720, minHeight: 480,
      onClose: () => { if (s) { cancelAnimationFrame(s.raf); clearTimeout(s.poll); clearTimeout(s.saveT); s.ro?.disconnect(); s.closed = true; } s = null; meshCache.clear(); } });
    const cv = root.querySelector(".s3-canvas"), hud = root.querySelector(".s3-hud");
    const gl = cv.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true });
    s = { id: sc.id, sc, win, root, cv, hud, gl, gpu: gl ? G().gpu(gl) : null, objs: (sc.objects || []).map(o => ({ ...o })), sel: -1, dirty: true,
      cam: { yaw: 0, pitch: 0, dist: 1, target: [0, 0, -1] }, showBg: true, clay: false, bg: null,
      t: 0, seconds: +sc.seconds || 5, camKeys: (sc.camera_keys || []).slice().sort((a, b) => a.t - b.t), camFree: false,
      photos: (sc.photos || []).slice() };
    if (!gl) { hud.textContent = "This browser has no WebGL 2, so the scene can't be shown."; return; }
    s.ro = new ResizeObserver(() => { if (s) s.dirty = true; }); s.ro.observe(cv);
    wire(root, foot);
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
      root.querySelector(".s3-empty").hidden = false;
      root.querySelector(".s3-shotbtn").textContent = "🎥 Start view";
      root.querySelector(".s3-shotbtn").title = "Back to the view the scene starts with";
      root.querySelector(".s3-bglabel").textContent = "Floor and backdrop";
      root.querySelector(".s3-bgnote").textContent = "Add 3D models below; each stands on the floor at 1 m tall. Frame the shot by orbiting (drag), panning (right-drag) and zooming (wheel), then 📷 Generate photo.";
      renderEmpty();
      loop(); loadObjects();
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
    hud.textContent = `Camera ${Math.round(2 * Math.atan(s.bg.t) / rad)}° wide`;
    root.querySelector(".s3-bgnote").textContent = sc.plate ? "The background is the empty background from Animate objects."
      : "The background is the picture itself, so objects that have a 3D model show twice. Make the empty background in 🎬 Animate objects to avoid that.";
    loop();
    loadObjects();
  }

  /* ---------------------------------------------------------------- rendering to video (H3 with Time-to-Move) */
  const shotCam = () => s.bg.empty ? emptyStart() : ({ yaw: 0, pitch: 0, dist: s.bg.dmed, target: [0, 0, -s.bg.dmed] });
  // An empty scene starts at eye height (the origin) looking a little down at the floor 3.5 m ahead.
  function emptyStart() { const ty = s.bg.floor + 0.6, z = 3.5; return { yaw: 0, pitch: Math.atan2(-ty, z) / rad, dist: Math.hypot(z, ty), target: [0, ty, -z] }; }
  // The camera of the render at time t: its path, or (without keys) the picture's own camera.
  const camForRender = t => s.camKeys.length ? camAt(t) : shotCam();
  const camDiff = (a, b) => Math.abs(a.yaw - b.yaw) + Math.abs(a.pitch - b.pitch) + Math.abs(a.dist - b.dist) / s.bg.dmed
    + Math.hypot(...sub(a.target, b.target)) / s.bg.dmed;
  const cameraMoves = () => s.camKeys.length > 1 && s.camKeys.some(k => camDiff(k, s.camKeys[0]) > 1e-3);
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
    const g0 = base.getContext("2d", { willReadFrequently: true }), d = g0.getImageData(0, 0, base.width, base.height);
    for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;  // the tiniest level, opaque: average colours
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
      draw({ size, t, cam: camForRender(t), mask, proj });
      // toDataURL is synchronous: toBlob's callback (and setTimeout) crawl when the tab is in the background
      const url = (mask ? s.cv : fillHoles(s.cv, size[0], size[1])).toDataURL(mask ? "image/png" : "image/jpeg", 0.92), bin = atob(url.slice(url.indexOf(",") + 1));
      const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      fd.append("frame", new Blob([bytes], { type: mask ? "image/png" : "image/jpeg" }), `${String(f).padStart(5, "0")}.${mask ? "png" : "jpg"}`);
      if (f % 8 === 0) { progress(f, n); await new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); }); }
    }
    fd.append("fps", String(FPS));
    const r = await fetch("/api/frames/video", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return (await r.json()).ref;
  }

  const autoTl = () => { try { return localStorage.getItem("bob.sceneAutoTl") !== "0"; } catch { return true; } };
  function renderDialog() {
    if (!s?.bg) return;
    if (!s.objs.some(o => o.mesh && !o.hidden) && !cameraMoves()) return Media.toast("Nothing moves yet: key an object or the camera first.");
    if (!state.caps?.editor?.motion && state.caps?.editor) return Media.toast("Rendering a scene needs H3 and ComfyUI-vlo (vloTimeToMove), as Animate objects does.");
    const moving = s.objs.filter(o => o.mesh && !o.hidden && o.keys?.length > 1).map(o => o.name);
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
    box.innerHTML = `<p class="hint">H3 makes the video from the picture, following this scene's rough animation (Time-to-Move, as in Animate objects):
        ${cameraMoves() ? "the camera move and the objects" : "the objects; the camera holds still"}. ${frameCount()} frames, ${dur().toFixed(2)} s.</p>
      <div class="field"><label for="s3r-what">What happens <span class="opt">optional</span></label>
        <textarea id="s3r-what" rows="3" placeholder="${esc(moving.length ? `${moving.join(" and ")} move${moving.length > 1 ? "" : "s"} across the scene.` : "The scene comes to life.")}"></textarea></div>
      <div class="row2"><div class="field"><label for="s3r-q">Quality</label><select id="s3r-q"><option value="draft">Draft</option><option value="standard" selected>Standard</option><option value="full">Full</option></select></div>
        <div class="field"><label for="s3r-hold">Follow the plan</label><select id="s3r-hold"><option value="loose">Loosely</option><option value="normal" selected>Normally</option><option value="tight">Tightly</option></select></div></div>
      <div class="field"><label for="s3r-first">Start from</label><select id="s3r-first">
        ${noPic ? "" : `<option value="picture">The picture${pic ? " (the scene starts as the picture)" : " (the camera starts elsewhere)"}</option>`}
        ${editModels().length ? `<option value="newphoto">A new photo of the first frame (made first, about a minute, then the video)</option>` : ""}
        ${photos.map(p => `<option value="photo:${p.id}">The photo from ${when(p.it)}${p.match ? " (the first frame)" : " (another view: the video may jump)"}</option>`).join("")}
        <option value="composite">The scene's first frame as drawn (plain)</option></select></div>
      <div class="field s3r-lookf"><label for="s3r-look">How the photo should look <span class="opt">optional</span></label>
        <textarea id="s3r-look" rows="2" placeholder="Soft daylight, shot on 35 mm film.">${esc(lastLook())}</textarea></div>
      <label class="check"><input type="checkbox" id="s3r-tl"${autoTl() ? " checked" : ""}> Add it to the timeline when it's done</label>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint s3r-st"></span><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="go">🎬 Render</button>`;
    const win = WM.open({ id: "scene3d-render", title: `Render · ${s.sc.name}`, content: box, footer: foot, width: 540, height: 560, modal: true });
    const st = foot.querySelector(".s3r-st"), firstSel = box.querySelector("#s3r-first"), holdSel = box.querySelector("#s3r-hold");
    // From a photo, H3 is held to the plain rough animation only loosely, so the photo's look carries through.
    const syncStart = () => {
      const v = firstSel.value, photo = v === "newphoto" || v.startsWith("photo:");
      box.querySelector(".s3r-lookf").hidden = v !== "newphoto";
      if (photo && !holdSel.dataset.touched) holdSel.value = "loose";
      if (!photo && !holdSel.dataset.touched) holdSel.value = "normal";
    };
    firstSel.value = startDefault; syncStart();
    firstSel.onchange = syncStart; holdSel.onchange = () => { holdSel.dataset.touched = "1"; };
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = async e => {
      e.target.disabled = true;
      // the picture's aspect, longest side 960 (the server fits it to the render's size)
      const n = frameCount(), W = Math.round((s.bg.aspect >= 1 ? 960 : 960 * s.bg.aspect) / 2) * 2, H = Math.round(W / s.bg.aspect / 2) * 2;
      const keep = [s.cv.width, s.cv.height];
      let proj = null;
      try {
        const start = firstSel.value;
        // From a photo, the rough animation is the photo painted onto the scene from the camera it was taken from, so
        // H3 starts from something that looks like the photo (not the plain render).
        let photoPath = null;
        if (start === "newphoto") {
          const look = box.querySelector("#s3r-look").value.trim();
          try { localStorage.setItem("bob.scenePhotoLook", look); } catch { /* not kept */ }
          st.textContent = "Making the photo of the first frame (about a minute; keep this open)…";
          const A = s.bg.aspect, PW = Math.round((A >= 1 ? 1280 : 1280 * A) / 8) * 8, PH = Math.round(PW / A / 8) * 8;
          const photo = await makePhoto([PW, PH], 0, camForRender(0), look, editModels()[0][0]);
          const it = await waitItem(photo.id);
          photoPath = (it.files || []).find(f => /^image\//.test(f.content_type || ""))?.path || it.files?.[0]?.path;
          if (it.status !== "done" || !photoPath) throw new Error("The photo didn't come out");
          st.textContent = "Painting the photo onto the scene…";
          proj = await prepareProjection(photoPath, 0, camForRender(0));
        } else if (start.startsWith("photo:")) {
          const p = s.photos.find(x => x.id === start.slice(6)), it = state.items.get(start.slice(6));
          photoPath = it?.files?.[0]?.path;
          if (!p || !photoPath) throw new Error("That photo isn't there anymore");
          st.textContent = "Painting the photo onto the scene…";
          proj = await prepareProjection(photoPath, p.t, p.cam);
        }
        st.textContent = "Drawing the rough animation…";
        const ref = await renderVideo("ref", [W, H], n, (f, N) => { st.textContent = `Drawing the rough animation: frame ${f + 1} of ${N}`; }, proj);
        const mask = await renderVideo("mask", [W, H], n, (f, N) => { st.textContent = `Drawing its mask: frame ${f + 1} of ${N}`; }, proj);
        st.textContent = "Sending to H3…";
        const what = box.querySelector("#s3r-what").value.trim() || box.querySelector("#s3r-what").placeholder;
        const cam = cameraMoves() ? "The camera moves smoothly through the scene." : "The camera holds a static shot.";
        const prompt = `integrated_multimodal_description: [Shot 1] ${what.replace(/\s+/g, " ")} ${cam}\n\noverall_soundscape: Natural sound of the scene.\n\nnon_diegetic_music: N/A`;
        const toTl = box.querySelector("#s3r-tl").checked;
        try { localStorage.setItem("bob.sceneAutoTl", toTl ? "1" : "0"); } catch { /* not kept */ }
        const req = { kind: "video", engine: "motion", prompt, seconds: n / FPS, aspect: "16:9", quality: box.querySelector("#s3r-q").value,
          seed: -1, batch: 1, turbo: true, first_frame: null, motion_video: ref, motion_video_mask: mask,
          motion_hold: holdSel.value, motion_first: "picture", project: s.sc.project };
        if (photoPath) req.first_frame = photoPath;
        else if (start === "picture") req.first_frame = s.sc.picture;
        else if (noPic) req.first_frame = await uploadFrame([W, H], 0, camForRender(0), "scene_first.png");  // as drawn
        else { req.first_frame = s.sc.picture; req.motion_first = "composite"; }
        if (!req.first_frame) throw new Error("That photo isn't there anymore");
        const items = await submit(req);
        if (!items?.length) throw new Error("H3 didn't take it (the reason is on the Generate step)");
        if (toTl) Shots.placeWhenDone(items, s.sc.project);
        win.close();
        Media.toast(`3D scene: queued. ${toTl ? "It goes on the timeline when it's done." : "The video shows up in the gallery when it's done."}`);
      } catch (err) { st.textContent = ""; e.target.disabled = false; Media.toast(`Render: ${err.message}`); }
      finally { freeProjection(proj); if (s) { s.cv.width = keep[0]; s.cv.height = keep[1]; s.dirty = true; } }
    };
  }

  function toShot() { s.cam = shotCam(); s.dirty = true; }
  function eye() { const c = s.cam, y = c.yaw * rad, p = c.pitch * rad; return [c.target[0] + c.dist * Math.cos(p) * Math.sin(y), c.target[1] + c.dist * Math.sin(p), c.target[2] + c.dist * Math.cos(p) * Math.cos(y)]; }
  function frameSize() { const dpr = Math.min(2, window.devicePixelRatio || 1); return [Math.max(1, Math.round(s.cv.clientWidth * dpr)), Math.max(1, Math.round(s.cv.clientHeight * dpr))]; }
  // vertical half-angle: the picture's, widened so its whole width fits a narrower window
  function tanY(W, H) { return Math.max(s.bg.tv, s.bg.t / (W / H)); }
  function viewProj(W, H, cam = s.cam) {
    const e = eyeOf(cam);
    return { e, VP: mul4(perspective(2 * Math.atan(tanY(W, H)), W / H, s.bg.dmed * 0.01, s.bg.dmed * 50), lookAt(e, cam.target, [0, 1, 0])) };
  }
  const eyeOf = c => { const y = c.yaw * rad, p = c.pitch * rad; return [c.target[0] + c.dist * Math.cos(p) * Math.sin(y), c.target[1] + c.dist * Math.sin(p), c.target[2] + c.dist * Math.cos(p) * Math.cos(y)]; };
  // r (rendering a frame): { size: [W, H], t, cam, mask: "all" | "objects" } -- no paths or selection, black behind
  function draw(r = null) {
    const [W, H] = r?.size || frameSize();
    if (s.cv.width !== W || s.cv.height !== H) { s.cv.width = W; s.cv.height = H; }
    const t = r ? r.t : s.t, cam = r?.cam || s.cam;
    const { e, VP } = viewProj(W, H, cam), y = (cam.yaw - 40) * rad, key = [Math.sin(y) * 0.6, 0.85, Math.cos(y) * 0.6 + 0.3];
    if (r?.proj) {  // the photo painted onto the scene from its camera; what that camera couldn't see is a hole
      const P = { ...r.proj, mask: !!r.mask };
      s.gpu.begin(W, H, [0, 0, 0], r.mask ? 1 : 0);
      s.gpu.draw(s.bgMesh, { VP, M: ID, M0: ID, eye: e, key, proj: P });
      s.gpu.draw(P.sphere, { VP, M: ID, M0: ID, eye: e, key, proj: P });
      for (const o of s.objs) {
        if (!o.mesh || !o.pos || o.hidden) continue;
        s.gpu.draw(o.mesh, { VP, M: matOf(o, poseAt(o, t)), M0: matOf(o, poseAt(o, P.t0)), eye: e, key, proj: P });
      }
      return;
    }
    const sky = s.bg.empty ? hexRgb(s.sc.backdrop?.sky || "#c9d3de") : null;
    if (sky && r?.mask) s.gpu.begin(W, H, [0, 0, 0], 1);  // the open sky is H3's to make
    else if (sky) s.gpu.begin(W, H, sky, 1);
    else s.gpu.begin(W, H, r ? [0, 0, 0] : G().themeBg(s.cv), r && !r.mask ? 0 : 1);  // a frame: holes stay see-through, to fill
    if (!r) frameOverlay();
    const white = [1, 1, 1], black = [0, 0, 0];
    if (r?.mask) s.gpu.draw(s.bgMesh, { VP, M: ID, eye: e, key, solid: r.mask === "all" ? white : black });
    else if (s.showBg || r) s.gpu.draw(s.bgMesh, { VP, M: ID, eye: e, key, unlit: true });
    s.objs.forEach((o, i) => {
      if (!o.mesh || !o.pos || o.hidden) return;
      s.gpu.draw(o.mesh, { VP, M: matOf(o, poseAt(o, t)), eye: e, key, look: !r && s.clay ? 1 : 0,
        tint: !r && i === s.sel ? [0.06, 0.04, 0.0] : null, solid: r?.mask ? white : null });
    });
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
    if (s.camKeys.length > 1 && s.camFree) {
      path(t => eyeOf(camAt(t)), [0.48, 0.64, 1, 0.9]);
      // the camera at the playhead: a small frustum
      const c = camAt(s.t), ce = eyeOf(c), f = norm(sub(c.target, ce)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f), L = s.bg.dmed * 0.12;
      const corner = (x, y) => addv(ce, mulv(addv(f, addv(mulv(r, x * s.bg.t), mulv(u, y * s.bg.tv))), L));
      const cs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], fr = [];
      for (let k = 0; k < 4; k++) fr.push(...ce, ...cs[k], ...cs[k], ...cs[(k + 1) % 4]);
      s.gpu.lines(fr, VP, [0.48, 0.64, 1, 1]);
    }
    s.gl.enable(s.gl.DEPTH_TEST);
    if (o?.mesh && o.pos && !o.hidden) {  // the selected object's box
      const M = matOf(o), lo = o.mesh.lo, hi = o.mesh.hi, c = [];
      for (let k = 0; k < 8; k++) c.push([k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]].map((_, j, v) => M[j] * v[0] + M[4 + j] * v[1] + M[8 + j] * v[2] + M[12 + j]));
      const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]], pts = [];
      for (const [a, b] of E) pts.push(...c[a], ...c[b]);
      s.gl.disable(s.gl.DEPTH_TEST); s.gpu.lines(pts, VP, [1, 0.48, 0.27, 0.9]); s.gl.enable(s.gl.DEPTH_TEST);
    }
  }
  function loop() { if (!s || s.closed) return; if (s.dirty) { s.dirty = false; draw(); } s.raf = requestAnimationFrame(loop); }

  // The ray under a point of the canvas (CSS pixels): origin and direction.
  function rayAt(px, py) {
    const W = s.cv.clientWidth, H = s.cv.clientHeight, e = eye(), f = norm(sub(s.cam.target, e)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
    const ty = tanY(W, H), tx = ty * W / H, nx = 2 * px / W - 1, ny = 1 - 2 * py / H;
    return { o: e, d: norm(addv(f, addv(mulv(r, nx * tx), mulv(u, ny * ty)))) };
  }
  // Which object is under the point: the ray against each object's box, in the object's own space.
  function pick(px, py) {
    const { o: ro, d: rd } = rayAt(px, py);
    let best = -1, bt = Infinity;
    s.objs.forEach((o, i) => {
      if (!o.mesh || !o.pos || o.hidden) return;
      const P = poseAt(o, s.t), a = o.mesh.anchor, c = Math.cos(-P.yaw * rad), n = Math.sin(-P.yaw * rad);
      const toLocal = (v, isDir) => { const w = isDir ? v : sub(v, P.pos); const x = c * w[0] - n * w[2], z = n * w[0] + c * w[2]; const k = 1 / P.scale; return isDir ? [x * k, w[1] * k, z * k] : [x * k + a[0], w[1] * k + a[1], z * k + a[2]]; };
      const lo = toLocal(ro, false), ld = toLocal(rd, true);
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
    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointerdown", e => {
      if (!s?.bg) return;
      cv.focus(); cv.setPointerCapture(e.pointerId);
      const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const hit = e.button === 0 ? pick(px, py) : -1;
      if (hit >= 0) {
        if (s.sel !== hit) { s.sel = hit; renderSide(); }
        if (s.playing) stop();
        const o = s.objs[hit], P = poseAt(o, s.t), ray = rayAt(px, py), t = (P.pos[1] - ray.o[1]) / (ray.d[1] || 1e-9);
        const at = addv(ray.o, mulv(ray.d, t));
        drag = { mode: e.shiftKey ? "lift" : "move", y: e.clientY, off: sub(P.pos, at), dist: Math.hypot(...sub(P.pos, eye())) };
      } else { drag = { mode: e.button === 0 && !e.shiftKey ? "orbit" : "pan", x: e.clientX, y: e.clientY }; if (s.camKeys.length) { s.camFree = true; renderCam(); } }
      s.dirty = true;
    });
    cv.addEventListener("pointermove", e => {
      if (!drag) return;
      const r = cv.getBoundingClientRect(), o = s.objs[s.sel];
      if (drag.mode === "move" && o) {
        const ray = rayAt(e.clientX - r.left, e.clientY - r.top), P = poseAt(o, s.t);
        if (Math.abs(ray.d[1]) > 1e-4) {
          const t = (P.pos[1] - ray.o[1]) / ray.d[1];
          if (t > 0 && t < s.bg.dmed * 40) { const at = addv(ray.o, mulv(ray.d, t)); editPose(o, { pos: [at[0] + drag.off[0], P.pos[1], at[2] + drag.off[2]] }); drag.moved = true; }
        }
      } else if (drag.mode === "lift" && o) {
        const k = drag.dist * 2 * tanY(cv.clientWidth, cv.clientHeight) / cv.clientHeight, P = poseAt(o, s.t);
        editPose(o, { pos: [P.pos[0], P.pos[1] - (e.clientY - drag.y) * k, P.pos[2]] }); drag.y = e.clientY; drag.moved = true;
      } else if (drag.mode === "orbit") {
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
    cv.addEventListener("pointerup", () => { if (drag?.moved) { save(); renderSide(); } drag = null; });
    cv.addEventListener("wheel", e => { e.preventDefault(); if (!s?.bg) return; s.cam.dist = Math.max(s.bg.dmed * 0.05, Math.min(s.bg.dmed * 20, s.cam.dist * Math.exp(e.deltaY * 0.0012))); s.dirty = true; }, { passive: false });
    cv.addEventListener("keydown", e => {
      const o = s.objs[s.sel];
      if ((e.key === "Delete" || e.key === "Backspace") && o) { e.preventDefault(); removeSel(); }
      else if (e.key === "Escape") { s.sel = -1; renderSide(); s.dirty = true; }
      else if (e.key === " ") { e.preventDefault(); play(); }
    });
    const all = [root, foot];
    all.forEach(el => el.addEventListener("click", e => {
      const b = e.target.closest("[data-act],[data-i]"); if (!b || !s) return;
      const a = b.dataset.act, o = s.objs[s.sel];
      if (a === "shot") { if (s.bg) toShot(); return; }
      if (a === "pic") { draw(); s.cv.toBlob(bl => { const x = document.createElement("a"); x.href = URL.createObjectURL(bl); x.download = `${s.sc.name}_view.png`; x.click(); setTimeout(() => URL.revokeObjectURL(x.href), 4000); }); return; }
      if (a === "add") return addModel();
      if (a === "render") return renderDialog();
      if (a === "photo") return photoDialog();
      if (a === "bd-pick") return s.root.querySelector(".s3-bdfile").click();
      if (a === "bd-clear") { s.sc.backdrop = { ...s.sc.backdrop, picture: null }; s.sc.backdrop_url = null; return emptyChanged(); }
      if (a === "play") return play();
      if (a === "key-cam") {
        if (!s.bg) return;
        const k = s.camKeys.find(q => near(q.t, s.t));
        if (k) Object.assign(k, camOf(s.cam)); else { s.camKeys.push({ t: s.t, ...camOf(s.cam) }); s.camKeys.sort((p, q) => p.t - q.t); }
        s.camFree = false; save(); renderCam(); s.dirty = true; return;
      }
      if (a === "clear-cam") { s.camKeys = []; s.camFree = false; save(); renderCam(); s.dirty = true; return; }
      if (a === "cam-key") { setTime(s.camKeys[+b.dataset.k].t); renderSide(); return; }
      if (a === "del-cam-key") { s.camKeys.splice(+b.dataset.k, 1); save(); setTime(s.t); renderCam(); return; }
      if (a === "obj-key" && o) { setTime(o.keys[+b.dataset.k].t); renderSide(); return; }
      if (a === "del-obj-key" && o) {
        o.keys.splice(+b.dataset.k, 1);
        if (o.keys.length) Object.assign(o, { pos: o.keys[0].pos.slice(), yaw: o.keys[0].yaw, scale: o.keys[0].scale });
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
      const k = e.target.dataset.opt; if (!k) return;
      s[k] = e.target.checked; s.dirty = true;
    });
    root.addEventListener("input", e => {
      const o = s.objs[s.sel]; if (!o) return;
      if (e.target.id === "s3-yaw") { editPose(o, { yaw: +e.target.value }); root.querySelector(".s3-yaw-v").textContent = `${+e.target.value}°`; }
      if (e.target.id === "s3-size") { editPose(o, { scale: (o.auto_scale || o.scale) * +e.target.value }); root.querySelector(".s3-size-v").textContent = `${Math.round(+e.target.value * 100)}%`; }
      s.dirty = true;
    });
    root.addEventListener("change", e => { if (e.target.id === "s3-yaw" || e.target.id === "s3-size") { save(); renderSide(); } });
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
  async function addModel() {
    const id = s.root.querySelector(".s3-add").value; if (!id) return;
    const md = models.find(x => x.id === id); if (!md) return;
    s.objs.push({ id: uid(), name: md.name, model: md.id, mask: md.source === s.sc.picture ? md.mask : null, pos: null, yaw: 0, scale: null });
    s.sel = s.objs.length - 1;
    await loadObjects();
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

  function renderSide() {
    if (!s) return;
    renderTime(); renderCam();
    const root = s.root;
    const st = o => o.state === "running" ? `<span class="hint">making… </span>` : o.state === "failed" ? `<span class="hint">failed</span>`
      : o.state === "missing" ? `<span class="hint">model deleted</span>` : !o.model ? `<button type="button" class="btn sm" data-act="make3d" data-i="${s.objs.indexOf(o)}">🧊 Make 3D</button>` : o.hidden ? `<span class="hint">hidden</span>` : "";
    root.querySelector(".s3-objs").innerHTML = s.objs.length ? s.objs.map((o, i) => `<li data-i="${i}" class="${i === s.sel ? "sel" : ""}" tabindex="0"><b>${esc(o.name)}</b> ${st(o)}</li>`).join("")
      : `<li class="hint">No objects yet: add a 3D model below.</li>`;
    const opts = models.filter(m => m.status === "done");
    const mine = opts.filter(m => m.source === s.sc.picture), other = opts.filter(m => m.source !== s.sc.picture);
    root.querySelector(".s3-add").innerHTML = `<option value="">Add a 3D model…</option>` +
      (mine.length ? `<optgroup label="Made from this picture">${mine.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</optgroup>` : "") +
      (other.length ? `<optgroup label="Other models">${other.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</optgroup>` : "");
    const o = s.objs[s.sel], sec = root.querySelector(".s3-sel");
    sec.hidden = !o;
    if (o) {
      root.querySelector(".s3-sel-h").textContent = o.name;
      const P = o.pos ? poseAt(o, s.t) : { yaw: 0, scale: o.scale };
      const yaw = Math.round(P.yaw || 0), size = o.auto_scale && P.scale ? P.scale / o.auto_scale : 1;
      const K = o.keys || [];
      root.querySelector(".s3-objhint").textContent = K.length ? `Moving it, turning it or sizing it keys it at ${s.t.toFixed(2)} s.`
        : "Drag it over the ground (Shift+drag: up or down). Move the playhead and drag it again to make it move.";
      root.querySelector(".s3-objkeys").innerHTML = K.map((q, j) => `<button type="button" class="chip-btn${near(q.t, s.t) ? " on" : ""}" data-act="obj-key" data-k="${j}">${q.t.toFixed(2)} s</button><button type="button" class="set-x" data-act="del-obj-key" data-k="${j}" aria-label="Remove the key at ${q.t.toFixed(2)} s">×</button>`).join(" ");
      Object.assign(root.querySelector("#s3-yaw"), { value: String(yaw), disabled: !o.mesh }); root.querySelector(".s3-yaw-v").textContent = `${yaw}°`;
      Object.assign(root.querySelector("#s3-size"), { value: String(size), disabled: !o.mesh }); root.querySelector(".s3-size-v").textContent = `${Math.round(size * 100)}%`;
      root.querySelector('[data-act="hide"]').textContent = o.hidden ? "Show" : "Hide";
    }
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
    R.querySelector("#s3-lens").value = String(Math.round(+sc.lens || 35));
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
    const W = s.cv.clientWidth, H = s.cv.clientHeight, A = s.bg.aspect;
    const fw = W / H > A ? H * A : W, fh = W / H > A ? H : W / A;
    Object.assign(el.style, { left: `${(W - fw) / 2}px`, top: `${(H - fh) / 2}px`, width: `${fw}px`, height: `${fh}px` });
  }

  // One frame of the scene as a picture in data/uploads: [W, H], at time t, through `cam` (holes filled).
  async function uploadFrame(size, t, cam, name) {
    draw({ size, t, cam });
    const c = fillHoles(s.cv, size[0], size[1]);
    const blob = await new Promise(res => c.toBlob(res, "image/png"));
    const fd = new FormData(); fd.append("file", blob, name);
    const r = await fetch("/api/upload", { method: "POST", body: fd }), j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.statusText);
    return j.ref;
  }

  /* ---------------------------------------------------------------- 📷 Generate photo */
  const photoPrompt = look => "Turn this 3D render into a realistic photograph. Keep the composition, the camera angle, and the position, size, "
    + "shape and colour of every object exactly as they are; give the surfaces real materials, light and shadows." + (look ? ` ${look}` : "");
  const lastLook = () => { try { return localStorage.getItem("bob.scenePhotoLook") || ""; } catch { return ""; } };
  const editModels = () => { const ed = state.caps?.editor || {}; return [ed.qwen !== false && ["qwen", "Qwen Image Edit 2511"], ed.h3image && ["h3image", "MiniMax H3 Image"]].filter(Boolean); };
  // A photo of the scene at time t through `cam` (queued with the edit model); it's remembered on the scene.
  async function makePhoto(size, t, cam, look, model) {
    const ref = await uploadFrame(size, t, cam, "scene_view.png");
    const items = await submit({ kind: "image", engine: "imgedit", edit_op: "instruct", source: ref, prompt: photoPrompt(look), edit_model: model,
      seed: -1, batch: 1, project: s.sc.project });
    if (!items?.length) throw new Error("The edit model didn't take it (the reason is on the Generate step)");
    s.photos.push({ id: items[0].id, t, cam: camOf(cam) });
    save();
    return items[0];
  }
  function photoDialog() {
    if (!s?.bg) return;
    const models = editModels();
    if (!models.length) return Media.toast("Generate photo needs an edit model: Qwen Image Edit 2511 or MiniMax H3 Image.");
    const keep = lastLook();
    const box = document.createElement("div");
    box.className = "m3-make";
    box.innerHTML = `<p class="hint">Draws what the camera frames${s.camKeys.length ? ` (at ${s.t.toFixed(2)} s)` : ""} and has the edit model turn it into a photograph,
        keeping where everything is. The photo shows up in the gallery.</p>
      <div class="field"><label for="s3p-look">How it should look <span class="opt">optional</span></label>
        <textarea id="s3p-look" rows="3" placeholder="${s.bg.empty ? "On a sunny beach at golden hour, shot on 35 mm film." : "Soft daylight, shot on 35 mm film."}">${esc(keep)}</textarea></div>
      <div class="field"><label for="s3p-model">Model</label><select id="s3p-model">${models.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint s3p-st"></span><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="go">📷 Generate</button>`;
    const win = WM.open({ id: "scene3d-photo", title: `Photo · ${s.sc.name}`, content: box, footer: foot, width: 500, height: 380, modal: true });
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = async e => {
      e.target.disabled = true;
      const st = foot.querySelector(".s3p-st"), look = box.querySelector("#s3p-look").value.trim();
      try { localStorage.setItem("bob.scenePhotoLook", look); } catch { /* not kept */ }
      const A = s.bg.aspect, W = Math.round((A >= 1 ? 1280 : 1280 * A) / 8) * 8, H = Math.round(W / A / 8) * 8, size0 = [s.cv.width, s.cv.height];
      try {
        st.textContent = "Drawing the view and sending it to the edit model…";
        await makePhoto([W, H], s.t, s.cam, look, box.querySelector("#s3p-model").value);
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
  async function prepareProjection(photoRef, t0, cam) {
    const img = await createImageBitmap(await (await fetch(`/api/media/file?path=${encodeURIComponent(photoRef)}`)).blob());
    const A = s.bg.aspect, near = s.bg.dmed * 0.01, far = s.bg.dmed * 50, e0 = eyeOf(cam);
    const VP0 = mul4(perspective(2 * Math.atan(s.bg.tv), A, near, far), lookAt(e0, cam.target, [0, 1, 0]));
    const sphere = sphereMesh(e0, far * 0.8);
    const W0 = Math.min(2048, img.width), H0 = Math.round(W0 / A);
    const depth = s.gpu.depthPass(W0, H0, d => {
      const o0 = { VP: VP0, eye: e0, key: [0, 1, 0] };
      d(s.bgMesh, { ...o0, M: ID }); d(sphere, { ...o0, M: ID });
      for (const o of s.objs) if (o.mesh && o.pos && !o.hidden) d(o.mesh, { ...o0, M: matOf(o, poseAt(o, t0)) });
    });
    return { VP0, near, far, t0, sphere, depth, photo: s.gpu.texture(img) };
  }
  function freeProjection(P) { if (!P || !s) return; s.gpu.free(P.depth); s.gpu.free(P.photo); }

  /* ---------------------------------------------------------------- time */
  function renderTime() {
    if (!s) return;
    const sc = s.root.querySelector(".s3-scrub"), D = dur();
    sc.max = String(D); sc.value = String(s.t);
    s.root.querySelector(".s3-time").textContent = `${s.t.toFixed(2)} / ${D.toFixed(2)} s`;
    const sec = s.root.querySelector(".s3-sec"); if (document.activeElement !== sec) sec.value = String(s.seconds);
    s.root.querySelector('[data-act="play"]').textContent = s.playing ? "⏸" : "▶";
  }
  function renderCam() {
    if (!s) return;
    const K = s.camKeys;
    s.root.querySelector(".s3-camhint").textContent = !K.length ? "Look around, then ◆ key the view at the playhead; key another view later on for a camera move."
      : s.camFree ? `You've moved the view: ◆ key it at ${s.t.toFixed(2)} s, or move the playhead to go back on the camera's path (blue).`
      : K.length === 1 ? "One key: the camera holds this view. Key another view at another time to move it." : "The camera moves through its keys.";
    s.root.querySelector(".s3-camkeys").innerHTML = K.map((q, j) => `<button type="button" class="chip-btn${near(q.t, s.t) ? " on" : ""}" data-act="cam-key" data-k="${j}">${q.t.toFixed(2)} s</button><button type="button" class="set-x" data-act="del-cam-key" data-k="${j}" aria-label="Remove the camera key at ${q.t.toFixed(2)} s">×</button>`).join(" ");
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

  return { create, createEmpty, open, openList, onItem, resume, _state: () => s, _draw: (r = null) => s && s.bg && draw(r),
    _render: (kind, size, n, proj = null) => renderVideo(kind, size, n, () => {}, proj), _project: (ref, t0, cam) => prepareProjection(ref, t0, cam), _info: () => s && s.bg && { moves: cameraMoves(), picture: startsAsPicture(), frames: frameCount() } };
})();
