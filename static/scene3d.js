/* 3D scenes: a picture's background as a depth surface (Depth Anything 3, made on the server: app/model3d.py) with
   3D models (Make 3D) standing in it where their objects were, seen through the picture's own camera.

   The background GLB comes skewed (see build_scene_background), so it is rebuilt here: every vertex keeps its UV
   (its place in the picture) and its depth (-Z), and goes back out along the picture camera's ray. That camera sits
   at the origin looking down -Z (Y up), its field of view read from the mesh. An object is placed by its mask: its
   foot (the bottom middle of the mask) stands on the background just below it, and its height in the picture sets
   its size. Drag an object to move it over the ground, Shift+drag to raise it; drag elsewhere to orbit, right-drag
   to pan, wheel to zoom; 🎥 goes back to the picture's camera. */
"use strict";

const Scene3D = (() => {
  const rad = Math.PI / 180;
  const G = () => Model3D.gl;
  let s = null;        // the open scene window
  let list = null;     // the open scenes list
  let models = [];     // /api/models3d, refreshed while any is being made

  const uid = () => Math.random().toString(36).slice(2, 10);

  /* ---------------------------------------------------------------- starting one */
  // src: { ref, url, name, plate?, objects?: [{ name, mask, model? }] }
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
    box.innerHTML = `<div class="m3-grid"></div>`;
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
        <div class="m3-thumb"><img src="${esc(x.plate_url || x.picture_url || "")}" alt="">${x.status === "failed" ? `<span class="m3-fail">Failed</span>` : ""}</div>
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
  function matOf(o) {
    const a = o.mesh.anchor;
    return mul4(mul4(mul4(T(...o.pos), RY(o.yaw * rad)), S(o.scale)), T(-a[0], -a[1], -a[2]));
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
  async function place(o) {
    const bg = s.bg, m = o.mesh, hgt = Math.max(1e-6, m.hi[1] - m.lo[1]), dep = (m.hi[2] - m.lo[2]);
    let info = null;
    if (o.mask) { try { info = await maskInfo(o.mask); } catch { info = null; } }
    const footUV = info ? [info.foot[0], Math.min(1, info.foot[1] + 0.012)] : [0.5, 0.8];
    const G0 = pointAt(bg, ...footUV), d = Math.max(1e-6, -G0[2]);
    const hPic = info ? (info.y1 - info.y0) : 0.3;
    o.scale = o.auto_scale = (hPic * 2 * bg.tv * d) / hgt;
    // the model's front faces +Z (the camera); push it back so its front edge stands at the foot
    const back = norm([G0[0], 0, G0[2]]);
    o.pos = addv(G0, mulv(back, dep * o.scale / 2));
    o.yaw = 0;
  }

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
    const objects = s.objs.map(o => ({ id: o.id, name: o.name, model: o.model, mask: o.mask, pos: o.pos, yaw: o.yaw || 0, scale: o.scale, auto_scale: o.auto_scale, hidden: !!o.hidden }));
    s.saveT = setTimeout(() => api(`/api/scenes/${id}`, { method: "PATCH", body: JSON.stringify({ objects }) }).catch(e => Media.toast(`Couldn't save the scene: ${e.message}`)), 500);
  }

  /* ---------------------------------------------------------------- the window */
  async function open(id) {
    if (s?.win) s.win.close();
    let sc;
    try { sc = await api(`/api/scenes/${id}`); } catch (e) { return Media.toast(e.message); }
    const root = document.createElement("div");
    root.className = "s3";
    root.innerHTML = `
      <div class="s3-stage"><canvas class="m3-canvas s3-canvas" tabindex="0" aria-label="The 3D scene: drag an object to move it, drag elsewhere to orbit, wheel to zoom"></canvas>
        <div class="m3-hud hint s3-hud">Making the background…</div></div>
      <aside class="mo-side s3-side">
        <section><h3>View</h3>
          <div class="mo-row"><button type="button" class="btn sm" data-act="shot" title="Look through the picture's own camera">🎥 Picture's camera</button></div>
          <label class="check"><input type="checkbox" data-opt="showBg" checked> Background</label>
          <label class="check"><input type="checkbox" data-opt="clay"> Clay (models without colour)</label>
          <p class="hint s3-bgnote"></p></section>
        <section><h3>Objects</h3><ul class="mo-layers s3-objs"></ul>
          <div class="mo-find"><select class="s3-add" aria-label="A 3D model to add"></select><button type="button" class="btn sm" data-act="add">Add</button></div></section>
        <section class="s3-sel" hidden><h3 class="s3-sel-h"></h3>
          <div class="field"><label for="s3-yaw">Turn <span class="s3-yaw-v"></span></label><input type="range" id="s3-yaw" min="-180" max="180" step="1"></div>
          <div class="field"><label for="s3-size">Size <span class="s3-size-v"></span></label><input type="range" id="s3-size" min="0.2" max="3" step="0.01"></div>
          <div class="mo-row"><button type="button" class="btn sm" data-act="replace" title="Stand it where it was in the picture again">↺ Put back</button>
            <button type="button" class="btn sm ghost" data-act="hide">Hide</button><button type="button" class="btn sm ghost" data-act="remove">Remove</button></div>
          <p class="hint">Drag it over the ground; Shift+drag raises or lowers it.</p></section>
      </aside>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint s3-foot">Drag: orbit · Right-drag: pan · Wheel: zoom</span><button type="button" class="btn ghost" data-act="pic">📷 Save picture of this view</button>`;
    const win = WM.open({ id: "scene3d", title: `🏞 ${sc.name}`, content: root, footer: foot, width: 1100, height: 720, minWidth: 720, minHeight: 480,
      onClose: () => { if (s) { cancelAnimationFrame(s.raf); clearTimeout(s.poll); clearTimeout(s.saveT); s.ro?.disconnect(); s.closed = true; } s = null; meshCache.clear(); } });
    const cv = root.querySelector(".s3-canvas"), hud = root.querySelector(".s3-hud");
    const gl = cv.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true });
    s = { id: sc.id, sc, win, root, cv, hud, gl, gpu: gl ? G().gpu(gl) : null, objs: (sc.objects || []).map(o => ({ ...o })), sel: -1, dirty: true,
      cam: { yaw: 0, pitch: 0, dist: 1, target: [0, 0, -1] }, showBg: true, clay: false, bg: null };
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
    try {
      const prims = await G().parseGLB(await (await fetch(sc.bg_url)).arrayBuffer());
      const p = prims[0], img = p.tex;
      if (!p?.uv || !img) throw new Error("The background has no picture on it");
      s.bg = rebuildBackground(p, img.width, img.height);
      s.bgMesh = s.gpu.upload(prims);
    } catch (e) { hud.textContent = `Couldn't show the background: ${e.message}`; return; }
    if (!s) return;
    toShot();
    hud.textContent = `Camera ${Math.round(2 * Math.atan(s.bg.t) / rad)}° wide`;
    root.querySelector(".s3-bgnote").textContent = sc.plate ? "The background is the empty background from Animate objects."
      : "The background is the picture itself, so objects that have a 3D model show twice. Make the empty background in 🎬 Animate objects to avoid that.";
    loop();
    loadObjects();
  }

  function toShot() { const d = s.bg.dmed; s.cam = { yaw: 0, pitch: 0, dist: d, target: [0, 0, -d] }; s.dirty = true; }
  function eye() { const c = s.cam, y = c.yaw * rad, p = c.pitch * rad; return [c.target[0] + c.dist * Math.cos(p) * Math.sin(y), c.target[1] + c.dist * Math.sin(p), c.target[2] + c.dist * Math.cos(p) * Math.cos(y)]; }
  function frameSize() { const dpr = Math.min(2, window.devicePixelRatio || 1); return [Math.max(1, Math.round(s.cv.clientWidth * dpr)), Math.max(1, Math.round(s.cv.clientHeight * dpr))]; }
  // vertical half-angle: the picture's, widened so its whole width fits a narrower window
  function tanY(W, H) { return Math.max(s.bg.tv, s.bg.t / (W / H)); }
  function viewProj(W, H) {
    const e = eye();
    return { e, VP: mul4(perspective(2 * Math.atan(tanY(W, H)), W / H, s.bg.dmed * 0.01, s.bg.dmed * 50), lookAt(e, s.cam.target, [0, 1, 0])) };
  }
  function draw() {
    const [W, H] = frameSize();
    if (s.cv.width !== W || s.cv.height !== H) { s.cv.width = W; s.cv.height = H; }
    const { e, VP } = viewProj(W, H), y = (s.cam.yaw - 40) * rad, key = [Math.sin(y) * 0.6, 0.85, Math.cos(y) * 0.6 + 0.3];
    s.gpu.begin(W, H, G().themeBg(s.cv));
    if (s.showBg) s.gpu.draw(s.bgMesh, { VP, M: ID, eye: e, key, unlit: true });
    s.objs.forEach((o, i) => {
      if (!o.mesh || !o.pos || o.hidden) return;
      s.gpu.draw(o.mesh, { VP, M: matOf(o), eye: e, key, look: s.clay ? 1 : 0, tint: i === s.sel ? [0.06, 0.04, 0.0] : null });
    });
    const o = s.objs[s.sel];
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
      const a = o.mesh.anchor, c = Math.cos(-o.yaw * rad), n = Math.sin(-o.yaw * rad);
      const toLocal = (v, isDir) => { const w = isDir ? v : sub(v, o.pos); const x = c * w[0] - n * w[2], z = n * w[0] + c * w[2]; const k = 1 / o.scale; return isDir ? [x * k, w[1] * k, z * k] : [x * k + a[0], w[1] * k + a[1], z * k + a[2]]; };
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
        const o = s.objs[hit], ray = rayAt(px, py), t = (o.pos[1] - ray.o[1]) / (ray.d[1] || 1e-9);
        const at = addv(ray.o, mulv(ray.d, t));
        drag = { mode: e.shiftKey ? "lift" : "move", y: e.clientY, off: sub(o.pos, at), dist: Math.hypot(...sub(o.pos, eye())) };
      } else drag = { mode: e.button === 0 && !e.shiftKey ? "orbit" : "pan", x: e.clientX, y: e.clientY };
      s.dirty = true;
    });
    cv.addEventListener("pointermove", e => {
      if (!drag) return;
      const r = cv.getBoundingClientRect(), o = s.objs[s.sel];
      if (drag.mode === "move" && o) {
        const ray = rayAt(e.clientX - r.left, e.clientY - r.top);
        if (Math.abs(ray.d[1]) > 1e-4) {
          const t = (o.pos[1] - ray.o[1]) / ray.d[1];
          if (t > 0 && t < s.bg.dmed * 40) { const at = addv(ray.o, mulv(ray.d, t)); o.pos = [at[0] + drag.off[0], o.pos[1], at[2] + drag.off[2]]; }
        }
      } else if (drag.mode === "lift" && o) {
        const k = drag.dist * 2 * tanY(cv.clientWidth, cv.clientHeight) / cv.clientHeight;
        o.pos = [o.pos[0], o.pos[1] - (e.clientY - drag.y) * k, o.pos[2]]; drag.y = e.clientY;
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
    cv.addEventListener("pointerup", () => { if (drag && (drag.mode === "move" || drag.mode === "lift")) save(); drag = null; });
    cv.addEventListener("wheel", e => { e.preventDefault(); if (!s?.bg) return; s.cam.dist = Math.max(s.bg.dmed * 0.05, Math.min(s.bg.dmed * 20, s.cam.dist * Math.exp(e.deltaY * 0.0012))); s.dirty = true; }, { passive: false });
    cv.addEventListener("keydown", e => {
      const o = s.objs[s.sel];
      if ((e.key === "Delete" || e.key === "Backspace") && o) { e.preventDefault(); removeSel(); }
      else if (e.key === "Escape") { s.sel = -1; renderSide(); s.dirty = true; }
    });
    const all = [root, foot];
    all.forEach(el => el.addEventListener("click", e => {
      const b = e.target.closest("[data-act],[data-i]"); if (!b || !s) return;
      const a = b.dataset.act, o = s.objs[s.sel];
      if (a === "shot") { if (s.bg) toShot(); return; }
      if (a === "pic") { draw(); s.cv.toBlob(bl => { const x = document.createElement("a"); x.href = URL.createObjectURL(bl); x.download = `${s.sc.name}_view.png`; x.click(); setTimeout(() => URL.revokeObjectURL(x.href), 4000); }); return; }
      if (a === "add") return addModel();
      if (a === "make3d") return make3d(+b.dataset.i);
      if (a === "replace" && o?.mesh) { place(o).then(() => { save(); renderSide(); s.dirty = true; }); return; }
      if (a === "hide" && o) { o.hidden = !o.hidden; save(); renderSide(); s.dirty = true; return; }
      if (a === "remove") return removeSel();
      if (b.dataset.i != null && !a) { s.sel = +b.dataset.i; renderSide(); s.dirty = true; }
    }));
    root.addEventListener("change", e => {
      const k = e.target.dataset.opt; if (!k) return;
      s[k] = e.target.checked; s.dirty = true;
    });
    root.addEventListener("input", e => {
      const o = s.objs[s.sel]; if (!o) return;
      if (e.target.id === "s3-yaw") { o.yaw = +e.target.value; root.querySelector(".s3-yaw-v").textContent = `${o.yaw}°`; }
      if (e.target.id === "s3-size") { o.scale = (o.auto_scale || o.scale) * +e.target.value; root.querySelector(".s3-size-v").textContent = `${Math.round(+e.target.value * 100)}%`; }
      s.dirty = true;
    });
    root.addEventListener("change", e => { if (e.target.id === "s3-yaw" || e.target.id === "s3-size") save(); });
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
      const yaw = Math.round(o.yaw || 0), size = o.auto_scale && o.scale ? o.scale / o.auto_scale : 1;
      Object.assign(root.querySelector("#s3-yaw"), { value: String(yaw), disabled: !o.mesh }); root.querySelector(".s3-yaw-v").textContent = `${yaw}°`;
      Object.assign(root.querySelector("#s3-size"), { value: String(size), disabled: !o.mesh }); root.querySelector(".s3-size-v").textContent = `${Math.round(size * 100)}%`;
      root.querySelector('[data-act="hide"]').textContent = o.hidden ? "Show" : "Hide";
    }
  }

  return { create, open, openList, _state: () => s, _draw: () => s && s.bg && draw() };
})();
