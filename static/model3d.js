/* Make 3D: a textured 3D model (GLB) of the object in a picture (TRELLIS.2 in ComfyUI, app/model3d.py), the list
   of models made so far, and a small Blender-style viewer for one: orbit (drag), pan (right-drag or Shift+drag),
   zoom (wheel), F or double-click to frame it; Texture / Clay / Wireframe looks; download the .glb for Blender.

   The viewer reads the GLB itself (no libraries: WebGL 2): every mesh primitive with its node transforms, the base
   colour texture or vertex colours, and the ambient occlusion map. glTF is Y up, metres; the model is framed on
   load and stands on a floor grid. */
"use strict";

const Model3D = (() => {
  const rad = Math.PI / 180;
  let list = null;   // the open "3D models" window
  let pollT = 0;

  /* ---------------------------------------------------------------- making one */
  function start(src) {
    const cap = state.caps?.editor || {};
    if (cap.make3d === false) return Media.toast("Make 3D needs the TRELLIS.2 models in ComfyUI (see the README).");
    const box = document.createElement("div");
    box.className = "m3-make";
    box.innerHTML = `<p class="hint">TRELLIS.2 makes a textured 3D model of ${src.mask ? "this object" : "the main object in the picture (its background is taken out first)"}. It takes a few minutes; the result opens in a 3D viewer and downloads as a .glb for Blender.</p>
      <div class="field"><label for="m3-name">Name</label><input id="m3-name" maxlength="120" value="${esc(src.name || "3D model")}"></div>
      <div class="field"><label for="m3-q">Detail</label><select id="m3-q">
        <option value="standard" selected>Standard (200k faces, 2K texture)</option><option value="high">High (700k faces, 4K texture, slower)</option></select></div>
      <p class="hint">The back and hidden sides are made up by the model, so a picture showing the object whole, from a slight angle, works best.</p>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span></span><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="go">🧊 Make 3D</button>`;
    const win = WM.open({ id: "make3d", title: `Make 3D · ${src.name || src.ref.split("/").pop()}`, content: box, footer: foot, width: 480, height: 360, modal: true });
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = async e => {
      e.target.disabled = true;
      try {
        await api("/api/make3d", { method: "POST", body: JSON.stringify({
          source: src.ref, mask: src.mask || null, name: box.querySelector("#m3-name").value.trim() || "3D model",
          quality: box.querySelector("#m3-q").value, project: state.project?.id ?? null }) });
        win.close();
        Media.toast("Making the 3D model: it shows in 🧊 3D models when it's ready.");
        openList();
      } catch (err) { e.target.disabled = false; Media.toast(`Make 3D: ${err.message}`); }
    };
  }

  /* ---------------------------------------------------------------- the list */
  const ago = s => { const d = Date.now() / 1000 - s; return d < 90 ? "just now" : d < 5400 ? `${Math.round(d / 60)} min ago` : d < 129600 ? `${Math.round(d / 3600)} h ago` : new Date(s * 1000).toLocaleDateString(); };
  const mb = n => n ? `${(n / 1048576).toFixed(1)} MB` : "";

  async function refreshList() {
    if (!list) return;
    clearTimeout(pollT);
    let items = [];
    try { items = (await api("/api/models3d")).models || []; } catch (e) { list.grid.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    if (!list) return;
    list.items = items;
    list.grid.innerHTML = items.length ? items.map((m, i) => `
      <figure class="m3-card ${m.status}" data-i="${i}" tabindex="0" title="${m.status === "done" ? "Open in the 3D viewer" : esc(m.error || "")}">
        <div class="m3-thumb">${m.thumb_url ? `<img src="${esc(m.thumb_url)}" alt="">` : m.status === "running" ? "" : "🧊"}
          ${m.status === "running" ? `<span class="m3-busy">Making… ${Math.round(Date.now() / 1000 - m.created)} s</span>` : ""}
          ${m.status === "failed" ? `<span class="m3-fail">Failed</span>` : ""}</div>
        <figcaption><b>${esc(m.name)}</b><span class="hint">${m.status === "done" ? `${ago(m.finished)} · ${mb(m.size)}${m.seconds ? ` · ${Math.round(m.seconds)} s` : ""}` : m.status === "failed" ? esc((m.error || "").slice(0, 90)) : `${m.quality} detail`}</span></figcaption>
        <button type="button" class="m3-more" data-more="${i}" aria-label="More for ${esc(m.name)}">⋯</button>
      </figure>`).join("")
      : `<p class="hint m3-empty">No 3D models yet. Right-click a picture in the results (or an object in 🎬 Animate objects) and choose 🧊 Make 3D.</p>`;
    if (items.some(m => m.status === "running")) pollT = setTimeout(refreshList, 3000);
  }

  function openList() {
    if (list?.win?.el?.isConnected) { refreshList(); return list.win.focus?.(); }
    const box = document.createElement("div");
    box.className = "m3-list";
    box.innerHTML = `<div class="m3-grid"></div>`;
    const win = WM.open({ id: "models3d", title: "🧊 3D models", content: box, width: 760, height: 520, minWidth: 420, minHeight: 300,
      onClose: () => { clearTimeout(pollT); list = null; } });
    list = { win, grid: box.querySelector(".m3-grid"), items: [] };
    const openAt = i => { const m = list.items[i]; if (m?.status === "done") view(m); };
    box.addEventListener("click", e => {
      const more = e.target.closest("[data-more]");
      if (more) { const r = more.getBoundingClientRect(); return itemMenu(list.items[+more.dataset.more], r.left, r.bottom + 4); }
      const c = e.target.closest(".m3-card"); if (c) openAt(+c.dataset.i);
    });
    box.addEventListener("keydown", e => { const c = e.target.closest(".m3-card"); if (c && e.key === "Enter") openAt(+c.dataset.i); });
    box.addEventListener("contextmenu", e => { const c = e.target.closest(".m3-card"); if (!c) return; e.preventDefault(); itemMenu(list.items[+c.dataset.i], e.clientX, e.clientY); });
    refreshList();
  }

  // On this PC: the .glb in the app Windows opens it with (Blender, 3D Viewer...), or in Explorer.
  async function openOnPc(m, how) {
    try { await api(`/api/models3d/${m.id}/open`, { method: "POST", body: JSON.stringify({ how }) }); }
    catch (e) { Media.toast(e.message); }
  }

  function download(m) { const a = document.createElement("a"); a.href = m.glb_url; a.download = `${m.name.replace(/[\\/:*?"<>|]+/g, "_") || m.id}.glb`; a.click(); }

  function itemMenu(m, x, y) {
    if (!m) return;
    Media.menu(x, y, [
      m.status === "done" && ["🧊 Open in the 3D viewer", () => view(m)],
      m.status === "done" && ["🖥 Open in your 3D app (Blender…)", () => openOnPc(m, "app")],
      m.status === "done" && ["📂 Show in folder", () => openOnPc(m, "folder")],
      m.status === "done" && ["⬇ Download .glb (for Blender)", () => download(m)],
      m.status !== "running" && ["↻ Make again (a new seed)", async () => {
        try { await api("/api/make3d", { method: "POST", body: JSON.stringify({ source: m.source, mask: m.mask, name: m.name, quality: m.quality, project: m.project }) }); refreshList(); }
        catch (e) { Media.toast(e.message); } }],
      ["✎ Rename…", async () => {
        const n = prompt("Name", m.name); if (!n || n.trim() === m.name) return;
        try { await api(`/api/models3d/${m.id}`, { method: "PATCH", body: JSON.stringify({ name: n.trim() }) }); refreshList(); } catch (e) { Media.toast(e.message); }
      }],
      [m.status === "running" ? "✕ Stop and delete" : "🗑 Delete…", async () => {
        if (!confirm(`Delete “${m.name}”${m.status === "done" ? " and its .glb file" : ""}?`)) return;
        try { await api(`/api/models3d/${m.id}`, { method: "DELETE" }); refreshList(); } catch (e) { Media.toast(e.message); }
      }],
    ].filter(Boolean));
  }

  /* ---------------------------------------------------------------- reading a GLB */
  const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  async function parseGLB(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error("Not a GLB file");
    let off = 12, json = null, bin = null;
    while (off < buf.byteLength) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
      else if (type === 0x004E4942) bin = new Uint8Array(buf, off + 8, len);
      off += 8 + len;
    }
    if (!json) throw new Error("The GLB has no scene");
    const accessor = i => {
      const a = json.accessors[i], bv = json.bufferViews[a.bufferView], T = COMP[a.componentType], n = NCOMP[a.type];
      const start = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || 0, size = T.BYTES_PER_ELEMENT * n;
      let out;
      if (!stride || stride === size) out = new T(bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * size));
      else {  // interleaved: copy element by element
        out = new T(a.count * n);
        const src = new DataView(bin.buffer, bin.byteOffset + start);
        const get = { 5126: "getFloat32", 5125: "getUint32", 5123: "getUint16", 5122: "getInt16", 5121: "getUint8", 5120: "getInt8" }[a.componentType];
        for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = src[get](k * stride + c * T.BYTES_PER_ELEMENT, true);
      }
      if (a.normalized && T !== Float32Array) { const f = new Float32Array(out.length), d = { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType]; for (let k = 0; k < out.length; k++) f[k] = out[k] / d; return { data: f, n }; }
      return { data: T === Float32Array ? out : Float32Array.from(out), n, raw: out };
    };
    const images = await Promise.all((json.images || []).map(async im => {
      if (im.bufferView == null) return null;
      const bv = json.bufferViews[im.bufferView];
      const blob = new Blob([bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)], { type: im.mimeType || "image/png" });
      try { return await createImageBitmap(blob, { imageOrientation: "none" }); } catch { return null; }
    }));
    const texImage = t => t && json.textures?.[t.index] ? images[json.textures[t.index].source] || null : null;
    // node transforms
    const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const local = nd => {
      if (nd.matrix) return nd.matrix.slice();
      const [x, y, z, w] = nd.rotation || [0, 0, 0, 1], [sx, sy, sz] = nd.scale || [1, 1, 1], [tx, ty, tz] = nd.translation || [0, 0, 0];
      return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
        2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
    };
    const prims = [];
    const visit = (ni, parent) => {
      const nd = json.nodes[ni], M = mul4(parent, local(nd));
      if (nd.mesh != null) for (const p of json.meshes[nd.mesh].primitives) {
        if (p.mode != null && p.mode !== 4) continue;  // triangles only
        const at = p.attributes, mat = json.materials?.[p.material] || {}, pbr = mat.pbrMetallicRoughness || {};
        const pos = accessor(at.POSITION);
        // bake the node transform into the positions and normals
        const P = pos.data, nrm = at.NORMAL != null ? accessor(at.NORMAL).data : null;
        for (let k = 0; k < P.length; k += 3) {
          const x = P[k], y = P[k + 1], z = P[k + 2];
          P[k] = M[0] * x + M[4] * y + M[8] * z + M[12]; P[k + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; P[k + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
          if (nrm) { const a = nrm[k], b = nrm[k + 1], c = nrm[k + 2]; nrm[k] = M[0] * a + M[4] * b + M[8] * c; nrm[k + 1] = M[1] * a + M[5] * b + M[9] * c; nrm[k + 2] = M[2] * a + M[6] * b + M[10] * c; }
        }
        const idx = p.indices != null ? accessor(p.indices).raw : null;
        prims.push({ pos: P, nrm, uv: at.TEXCOORD_0 != null ? accessor(at.TEXCOORD_0).data : null,
          col: at.COLOR_0 != null ? accessor(at.COLOR_0) : null, idx: idx ? Uint32Array.from(idx) : null,
          base: pbr.baseColorFactor || [1, 1, 1, 1], tex: texImage(pbr.baseColorTexture), ao: texImage(mat.occlusionTexture),
          doubleSided: !!mat.doubleSided });
      }
      for (const c of nd.children || []) visit(c, M);
    };
    const scene = json.scenes?.[json.scene || 0];
    for (const ni of scene ? scene.nodes : json.nodes.map((_, i) => i)) visit(ni, ident());
    return prims;
  }

  /* ---------------------------------------------------------------- matrices (column-major) */
  function mul4(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function perspective(fovy, aspect, n, f) { const t = 1 / Math.tan(fovy / 2); return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
  function lookAt(eye, at, up) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], nrm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = nrm(sub(eye, at)), x = nrm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }

  /* ---------------------------------------------------------------- the viewer */
  // The canvas clears to the theme's page background (CSS --bg), as an rgb triple in 0..1.
  function themeBg(el) {
    const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || [14, 15, 18];
    return c.slice(0, 3).map(x => +x / 255);
  }
  const VS = `#version 300 es
    in vec3 aPos; in vec3 aNrm; in vec2 aUv; in vec4 aCol;
    uniform mat4 uMVP; out vec3 vNrm; out vec2 vUv; out vec4 vCol; out vec3 vPos;
    void main() { vNrm = aNrm; vUv = aUv; vCol = aCol; vPos = aPos; gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const FS = `#version 300 es
    precision highp float;
    in vec3 vNrm; in vec2 vUv; in vec4 vCol; in vec3 vPos; out vec4 o;
    uniform sampler2D uTex; uniform sampler2D uAo; uniform int uHasTex; uniform int uHasAo; uniform int uMode;
    uniform vec4 uBase; uniform vec3 uEye; uniform vec3 uKey;
    void main() {
      vec3 n = normalize(vNrm);
      if (length(vNrm) < 0.01) n = normalize(cross(dFdx(vPos), dFdy(vPos)));
      vec3 v = normalize(uEye - vPos);
      if (dot(n, v) < 0.0) n = -n;  // inside faces still lit
      vec4 c = uBase * vCol;
      if (uHasTex == 1 && uMode == 0) c *= texture(uTex, vUv);
      if (uMode == 1) c = vec4(0.78, 0.78, 0.8, 1.0);
      float ao = (uHasAo == 1) ? texture(uAo, vUv).r : 1.0;
      vec3 l = normalize(uKey);
      float diff = max(dot(n, l), 0.0), hemi = 0.5 + 0.5 * n.y, rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
      float spec = (uMode == 1) ? pow(max(dot(n, normalize(l + v)), 0.0), 40.0) * 0.25 : 0.0;
      vec3 lit = c.rgb * (0.3 * hemi + 0.2 + 0.62 * diff) * mix(1.0, ao, 0.8) + vec3(spec) + rim * 0.06;
      o = vec4(lit, 1.0);
    }`;
  const LVS = `#version 300 es
    in vec3 aPos; uniform mat4 uMVP; void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const LFS = `#version 300 es
    precision mediump float; uniform vec4 uColor; out vec4 o; void main() { o = uColor; }`;

  function program(gl, vs, fs) {
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  async function view(m) {
    const box = document.createElement("div");
    box.className = "m3-view";
    box.innerHTML = `<canvas class="m3-canvas" tabindex="0" aria-label="3D view of ${esc(m.name)}: drag to orbit, right-drag to pan, wheel to zoom, F to frame"></canvas>
      <div class="m3-hud hint">Loading…</div>
      <div class="m3-bar">
        <div class="m3-seg" role="group" aria-label="Look">
          <button type="button" class="btn sm on" data-look="0">Texture</button><button type="button" class="btn sm" data-look="1">Clay</button><button type="button" class="btn sm" data-look="2">Wireframe</button></div>
        <label class="check"><input type="checkbox" data-opt="grid" checked> Floor grid</label>
        <label class="check"><input type="checkbox" data-opt="spin"> Turntable</label>
        <span class="m3-help hint">Drag: orbit · Right-drag: pan · Wheel: zoom · F: frame</span>
      </div>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint">${esc(m.model || "TRELLIS.2")} · ${esc(m.quality || "")} detail · seed ${m.seed ?? "?"}</span>
      <button type="button" class="btn ghost" data-a="shot">📷 Save picture of this view</button>
      <button type="button" class="btn ghost" data-a="folder" title="Show the .glb file in Explorer">📂 Show in folder</button>
      <button type="button" class="btn" data-a="app" title="Open the .glb in the app Windows uses for it (Blender, 3D Viewer…)">🖥 Open in 3D app</button>
      <button type="button" class="btn primary" data-a="dl">⬇ Download .glb</button>`;
    let ro = null;
    const v = { m, raf: 0, look: 0, grid: true, spin: false, yaw: 35, pitch: 18, dist: 3, target: [0, 0, 0], radius: 1, floor: 0, prims: [], dirty: true };
    const win = WM.open({ id: `m3v-${m.id}`, title: `🧊 ${m.name}`, content: box, footer: foot, width: 900, height: 680, minWidth: 480, minHeight: 380,
      onClose: () => { cancelAnimationFrame(v.raf); v.closed = true; ro?.disconnect(); } });
    const cv = box.querySelector(".m3-canvas"), hud = box.querySelector(".m3-hud");
    foot.querySelector('[data-a="dl"]').onclick = () => download(m);
    foot.querySelector('[data-a="app"]').onclick = () => openOnPc(m, "app");
    foot.querySelector('[data-a="folder"]').onclick = () => openOnPc(m, "folder");
    foot.querySelector('[data-a="shot"]').onclick = () => { draw(); cv.toBlob(b => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${m.name}_view.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }); };
    box.querySelector(".m3-seg").onclick = e => { const b = e.target.closest("[data-look]"); if (!b) return; v.look = +b.dataset.look; box.querySelectorAll("[data-look]").forEach(x => x.classList.toggle("on", x === b)); v.dirty = true; };
    box.querySelector(".m3-bar").onchange = e => { const k = e.target.dataset.opt; if (k) { v[k] = e.target.checked; v.dirty = true; } };

    const gl = cv.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true });
    if (!gl) { hud.textContent = "This browser has no WebGL 2, so the model can't be shown here. Download the .glb to open it in Blender."; return; }
    const prog = program(gl, VS, FS), lprog = program(gl, LVS, LFS);
    const U = n => gl.getUniformLocation(prog, n);
    ro = new ResizeObserver(() => { v.dirty = true; });
    ro.observe(cv);

    try {
      const buf = await (await fetch(m.glb_url)).arrayBuffer();
      if (v.closed) return;
      const prims = await parseGLB(buf);
      if (!prims.length) throw new Error("The model has no triangles");
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], tris = 0;
      for (const p of prims) {
        for (let k = 0; k < p.pos.length; k += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p.pos[k + c]); hi[c] = Math.max(hi[c], p.pos[k + c]); }
        const nv = p.pos.length / 3, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const attr = (name, data, n) => { const loc = gl.getAttribLocation(prog, name); if (loc < 0) return; const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0); };
        const fixed = (name, vals) => { const loc = gl.getAttribLocation(prog, name); if (loc >= 0) { gl.disableVertexAttribArray(loc); gl["vertexAttrib" + vals.length + "f"](loc, ...vals); } };
        attr("aPos", p.pos, 3);
        p.nrm ? attr("aNrm", p.nrm, 3) : fixed("aNrm", [0, 0, 0]);
        p.uv ? attr("aUv", p.uv, 2) : fixed("aUv", [0, 0]);
        if (p.col) attr("aCol", p.col.data, p.col.n); else fixed("aCol", [1, 1, 1, 1]);
        p.fixedCol = !p.col;
        const idx = p.idx || Uint32Array.from({ length: nv }, (_, i) => i);
        const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        p.count = idx.length; tris += idx.length / 3;
        // wireframe: each triangle's three edges
        const lines = new Uint32Array(idx.length * 2);
        for (let k = 0; k < idx.length; k += 3) { const a = idx[k], b = idx[k + 1], c = idx[k + 2]; lines.set([a, b, b, c, c, a], k * 2); }
        p.lvao = gl.createVertexArray(); gl.bindVertexArray(p.lvao);
        const lb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lb); gl.bufferData(gl.ARRAY_BUFFER, p.pos, gl.STATIC_DRAW);
        const ll = gl.getAttribLocation(lprog, "aPos"); gl.enableVertexAttribArray(ll); gl.vertexAttribPointer(ll, 3, gl.FLOAT, false, 0, 0);
        const lib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STATIC_DRAW);
        p.lcount = lines.length;
        gl.bindVertexArray(null);
        p.vao = vao;
        const tex = img => { if (!img) return null; const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); return t; };
        p.gtex = tex(p.tex); p.gao = tex(p.ao);
        delete p.pos; delete p.nrm; delete p.uv; delete p.idx;  // on the GPU now
      }
      v.prims = prims;
      v.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      v.radius = Math.max(1e-6, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
      v.floor = lo[1]; v.home = v.target.slice(); v.dist = v.radius * 2.6;
      // floor grid: 10 x 10 cells around the model
      const s = Math.pow(10, Math.floor(Math.log10(v.radius * 2))) / 2 || 0.1, n = 10, g = [];
      for (let i = -n; i <= n; i++) g.push(v.target[0] + i * s, v.floor, v.target[2] - n * s, v.target[0] + i * s, v.floor, v.target[2] + n * s, v.target[0] - n * s, v.floor, v.target[2] + i * s, v.target[0] + n * s, v.floor, v.target[2] + i * s);
      v.gvao = gl.createVertexArray(); gl.bindVertexArray(v.gvao);
      const gb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g), gl.STATIC_DRAW);
      const gloc = gl.getAttribLocation(lprog, "aPos"); gl.enableVertexAttribArray(gloc); gl.vertexAttribPointer(gloc, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null); v.gcount = g.length / 3;
      const sz = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map(x => x.toFixed(2)).join(" × ");
      hud.textContent = `${Math.round(tris).toLocaleString()} triangles · ${sz} units${prims.some(p => p.gtex) ? "" : " · no texture"}`;
    } catch (e) { hud.textContent = `Couldn't show the model: ${e.message}`; return; }

    function eye() {
      const y = v.yaw * rad, p = v.pitch * rad;
      return [v.target[0] + v.dist * Math.cos(p) * Math.sin(y), v.target[1] + v.dist * Math.sin(p), v.target[2] + v.dist * Math.cos(p) * Math.cos(y)];
    }
    function draw() {
      const dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      gl.viewport(0, 0, W, H);
      const bg = themeBg(cv), dark = bg[0] + bg[1] + bg[2] < 1.5;
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const e = eye(), MVP = mul4(perspective(40 * rad, W / H, v.radius * 0.01, v.radius * 100), lookAt(e, v.target, [0, 1, 0]));
      // key light from the upper left of the view
      const y = (v.yaw - 40) * rad, key = [Math.sin(y) * 0.7, 0.8, Math.cos(y) * 0.7];
      if (v.look !== 2) {
        gl.useProgram(prog);
        gl.uniformMatrix4fv(U("uMVP"), false, MVP); gl.uniform3fv(U("uEye"), e); gl.uniform3fv(U("uKey"), key); gl.uniform1i(U("uMode"), v.look);
        gl.uniform1i(U("uTex"), 0); gl.uniform1i(U("uAo"), 1);
        for (const p of v.prims) {
          gl.uniform4fv(U("uBase"), p.base); gl.uniform1i(U("uHasTex"), p.gtex ? 1 : 0); gl.uniform1i(U("uHasAo"), p.gao ? 1 : 0);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, p.gtex); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, p.gao);
          gl.bindVertexArray(p.vao); gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
        }
      }
      gl.useProgram(lprog);
      gl.uniformMatrix4fv(gl.getUniformLocation(lprog, "uMVP"), false, MVP);
      if (v.look === 2) {
        gl.uniform4fv(gl.getUniformLocation(lprog, "uColor"), dark ? [0.75, 0.8, 0.9, 1] : [0.2, 0.25, 0.35, 1]);
        for (const p of v.prims) { gl.bindVertexArray(p.lvao); gl.drawElements(gl.LINES, p.lcount, gl.UNSIGNED_INT, 0); }
      }
      if (v.grid) {
        gl.uniform4fv(gl.getUniformLocation(lprog, "uColor"), dark ? [0.35, 0.37, 0.42, 1] : [0.62, 0.64, 0.68, 1]);
        gl.bindVertexArray(v.gvao); gl.drawArrays(gl.LINES, 0, v.gcount);
      }
      gl.bindVertexArray(null);
    }
    function loop() {
      if (v.closed) return;
      if (v.spin) { v.yaw = (v.yaw + 0.4) % 360; v.dirty = true; }
      if (v.dirty) { v.dirty = false; draw(); }
      v.raf = requestAnimationFrame(loop);
    }
    function frame() { v.target = v.home.slice(); v.dist = v.radius * 2.6; v.dirty = true; }

    // orbit / pan / zoom
    let drag = null;
    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointerdown", e => { cv.focus(); cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }; });
    cv.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const k = v.dist * 0.0018, y = v.yaw * rad, p = v.pitch * rad;
        const right = [Math.cos(y), 0, -Math.sin(y)], up = [-Math.sin(p) * Math.sin(y), Math.cos(p), -Math.sin(p) * Math.cos(y)];
        for (let c = 0; c < 3; c++) v.target[c] += (-dx * right[c] + dy * up[c]) * k;
      } else { v.yaw -= dx * 0.4; v.pitch = Math.max(-89, Math.min(89, v.pitch + dy * 0.4)); }
      v.dirty = true;
    });
    cv.addEventListener("pointerup", () => { drag = null; });
    cv.addEventListener("wheel", e => { e.preventDefault(); v.dist = Math.max(v.radius * 0.2, Math.min(v.radius * 30, v.dist * Math.exp(e.deltaY * 0.0012))); v.dirty = true; }, { passive: false });
    cv.addEventListener("dblclick", frame);
    cv.addEventListener("keydown", e => {
      if (e.key === "f" || e.key === "F") frame();
      else if (e.key === "ArrowLeft") v.yaw += 10; else if (e.key === "ArrowRight") v.yaw -= 10;
      else if (e.key === "ArrowUp") v.pitch = Math.min(89, v.pitch + 10); else if (e.key === "ArrowDown") v.pitch = Math.max(-89, v.pitch - 10);
      else return;
      e.preventDefault(); v.dirty = true;
    });
    loop();
    v.draw = draw;
    if (win.el) win.el.__m3 = v;  // for tests
  }

  /* ---------------------------------------------------------------- shared drawing, for 3D scenes (scene3d.js)
     Many meshes, each with its own model matrix; the background is drawn unlit (its texture is the picture). */
  const SVS = `#version 300 es
    in vec3 aPos; in vec3 aNrm; in vec2 aUv; in vec4 aCol;
    uniform mat4 uVP; uniform mat4 uM; uniform mat4 uVP0; uniform mat4 uM0;
    out vec3 vNrm; out vec2 vUv; out vec4 vCol; out vec3 vPos; out vec4 vP0;
    void main() { vec4 w = uM * vec4(aPos, 1.0); vPos = w.xyz; vNrm = mat3(uM) * aNrm; vUv = aUv; vCol = aCol; gl_Position = uVP * w;
      vP0 = uVP0 * uM0 * vec4(aPos, 1.0); }`;
  const SFS = `#version 300 es
    precision highp float;
    in vec3 vNrm; in vec2 vUv; in vec4 vCol; in vec3 vPos; in vec4 vP0; out vec4 o;
    uniform sampler2D uTex; uniform sampler2D uAo; uniform int uHasTex; uniform int uHasAo; uniform int uMode; uniform int uUnlit;
    uniform vec4 uBase; uniform vec3 uEye; uniform vec3 uKey; uniform vec3 uTint; uniform vec4 uSolid;
    // projection mapping: the photo seen from its camera (uVP0, the point's pose then uM0); uDepth0 is what that camera
    // saw first (its depth), so surfaces it couldn't see get nothing (holes: see-through, or black in a mask)
    uniform int uProj; uniform int uProjMask; uniform sampler2D uPhoto; uniform sampler2D uDepth0; uniform vec2 uNF;
    // fitting the photo: uCut is where the moving objects really are in it (r: as found, g: grown a little). A moving
    // object found there (uFit.x > 0) takes the photo from where it really is (n0 * uFit.xy + uFit.zw) and only what's
    // found; everything else leaves those spots as holes, so no copy of it stays behind.
    uniform int uHasCut; uniform sampler2D uCut; uniform vec4 uFit;
    // depth out (a 3D scene's Save depth map): the distance along the camera's forward axis (xyz) over w, as a 24-bit
    // number in RGB; 0 is left for "nothing here" (the sky)
    uniform vec4 uDepthOut;
    float lin(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - z * (uNF.y - uNF.x)); }
    void main() {
      if (uDepthOut.w > 0.0) {
        float v = floor(clamp(dot(vPos - uEye, uDepthOut.xyz) / uDepthOut.w, 0.0, 1.0) * 16777214.0) + 1.0;
        o = vec4(floor(v / 65536.0), mod(floor(v / 256.0), 256.0), mod(v, 256.0), 255.0) / 255.0;
        return;
      }
      if (uProj == 1) {
        vec4 hole = uProjMask == 1 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(0.0);
        if (vP0.w <= 0.0) { o = hole; return; }
        vec3 n0 = vP0.xyz / vP0.w;
        vec2 q = n0.xy;
        if (uHasCut == 1 && uFit.x > 0.0) {
          // a moving object found in the photo: every side of it takes the photo of it there (its back the colours of
          // its front: the camera saw no more of it), so as it turns while it moves it stays itself, not a hole
          q = n0.xy * uFit.xy + uFit.zw;
          // not it: nothing here at all (what's behind shows through), as its stand-in or card isn't its real shape
          if (abs(q.x) > 1.0 || abs(q.y) > 1.0 || textureLod(uCut, vec2(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5), 0.0).r < 0.5) discard;
        } else {
          if (abs(n0.x) > 1.0 || abs(n0.y) > 1.0) { o = hole; return; }
          // what that camera saw there: the farthest of the texel and its neighbours, so ground seen almost edge on
          // (one texel spans metres of it, far out towards the horizon) isn't torn into thin unseen stripes
          vec2 uv0 = n0.xy * 0.5 + 0.5, tx = 1.0 / vec2(textureSize(uDepth0, 0));
          float seen = max(lin(texture(uDepth0, uv0).r), max(
            max(lin(texture(uDepth0, uv0 + vec2(tx.x, 0.0)).r), lin(texture(uDepth0, uv0 - vec2(tx.x, 0.0)).r)),
            max(lin(texture(uDepth0, uv0 + vec2(0.0, tx.y)).r), lin(texture(uDepth0, uv0 - vec2(0.0, tx.y)).r))));
          float here = lin(n0.z * 0.5 + 0.5);
          if (here > seen * 1.01 + 0.02) { o = hole; return; }
          if (uHasCut == 1 && textureLod(uCut, vec2(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5), 0.0).g > 0.5) { o = hole; return; }
        }
        o = uProjMask == 1 ? vec4(1.0) : vec4(texture(uPhoto, vec2(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5)).rgb, 1.0);
        return;
      }
      if (uSolid.a > 0.5) { o = vec4(uSolid.rgb, 1.0); return; }  // one flat colour (a mask)
      vec4 c = uBase * vCol;
      if (uHasTex == 1 && uMode == 0) c *= texture(uTex, vUv);
      if (uUnlit == 1) { o = vec4(c.rgb, 1.0); return; }
      vec3 n = normalize(vNrm);
      if (length(vNrm) < 0.01) n = normalize(cross(dFdx(vPos), dFdy(vPos)));
      vec3 v = normalize(uEye - vPos);
      if (dot(n, v) < 0.0) n = -n;
      if (uMode == 1) c = vec4(0.78, 0.78, 0.8, 1.0);
      float ao = (uHasAo == 1) ? texture(uAo, vUv).r : 1.0;
      vec3 l = normalize(uKey);
      float diff = max(dot(n, l), 0.0), hemi = 0.5 + 0.5 * n.y, rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
      vec3 lit = c.rgb * (0.3 * hemi + 0.2 + 0.62 * diff) * mix(1.0, ao, 0.8) + rim * 0.06 + uTint;
      o = vec4(lit, 1.0);
    }`;

  function gpu(gl) {
    const prog = program(gl, SVS, SFS), lprog = program(gl, LVS, LFS);
    const U = n => gl.getUniformLocation(prog, n);
    const tex = img => {
      if (!img) return null;
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    // prims (from parseGLB) -> GPU parts and the local bounding box. Keeps the CPU arrays only when keep is set.
    function upload(prims, keep = false) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      const parts = [];
      let tris = 0;
      for (const p of prims) {
        for (let k = 0; k < p.pos.length; k += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p.pos[k + c]); hi[c] = Math.max(hi[c], p.pos[k + c]); }
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const bufs = [];
        const attr = (name, data, n) => { const loc = gl.getAttribLocation(prog, name); if (loc < 0) return; const b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0); };
        const fixed = (name, vals) => { const loc = gl.getAttribLocation(prog, name); if (loc >= 0) { gl.disableVertexAttribArray(loc); gl["vertexAttrib" + vals.length + "f"](loc, ...vals); } };
        attr("aPos", p.pos, 3);
        p.nrm ? attr("aNrm", p.nrm, 3) : fixed("aNrm", [0, 0, 0]);
        p.uv ? attr("aUv", p.uv, 2) : fixed("aUv", [0, 0]);
        p.col ? attr("aCol", p.col.data, p.col.n) : fixed("aCol", [1, 1, 1, 1]);
        const idx = p.idx || Uint32Array.from({ length: p.pos.length / 3 }, (_, i) => i);
        const ib = gl.createBuffer(); bufs.push(ib); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        tris += idx.length / 3;
        parts.push({ vao, bufs, count: idx.length, base: p.base, gtex: tex(p.tex), gao: tex(p.ao), fixedCol: !p.col, ownTex: [p.tex && "gtex", p.ao && "gao"].filter(Boolean) });
      }
      if (!keep) for (const p of prims) { delete p.pos; delete p.nrm; delete p.uv; delete p.idx; }
      return { parts, lo, hi, tris };
    }
    function begin(W, H, bg, alpha = 1) {
      gl.viewport(0, 0, W, H);
      gl.clearColor(bg[0], bg[1], bg[2], alpha); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
    }
    // o: { VP, M, eye, key, look (0 texture, 1 clay), unlit, tint }
    function draw(mesh, o) {
      gl.useProgram(prog);
      gl.uniformMatrix4fv(U("uVP"), false, o.VP); gl.uniformMatrix4fv(U("uM"), false, o.M);
      gl.uniform3fv(U("uEye"), o.eye); gl.uniform3fv(U("uKey"), o.key); gl.uniform1i(U("uMode"), o.look || 0);
      gl.uniform1i(U("uUnlit"), o.unlit ? 1 : 0); gl.uniform3fv(U("uTint"), o.tint || [0, 0, 0]);
      gl.uniform4fv(U("uSolid"), o.solid ? [...o.solid, 1] : [0, 0, 0, 0]);
      gl.uniform4fv(U("uDepthOut"), o.depthOut || [0, 0, 0, 0]);
      const P = o.proj;
      gl.uniform1i(U("uProj"), P ? 1 : 0); gl.uniform1i(U("uProjMask"), P?.mask ? 1 : 0);
      gl.uniformMatrix4fv(U("uVP0"), false, P ? P.VP0 : o.VP); gl.uniformMatrix4fv(U("uM0"), false, P ? (o.M0 || o.M) : o.M);
      gl.uniform2fv(U("uNF"), P ? [P.near, P.far] : [0.1, 100]);
      gl.uniform1i(U("uPhoto"), 2); gl.uniform1i(U("uDepth0"), 3);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, P?.photo || null);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, P?.depth || null);
      gl.uniform1i(U("uHasCut"), P?.cut ? 1 : 0); gl.uniform1i(U("uCut"), 4); gl.uniform4fv(U("uFit"), o.fit || [0, 0, 0, 0]);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, P?.cut || null);
      gl.uniform1i(U("uTex"), 0); gl.uniform1i(U("uAo"), 1);
      for (const p of mesh.parts) {
        gl.uniform4fv(U("uBase"), p.base); gl.uniform1i(U("uHasTex"), p.gtex ? 1 : 0); gl.uniform1i(U("uHasAo"), p.gao ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, p.gtex); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, p.gao);
        gl.bindVertexArray(p.vao); gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
    }
    // line segments (x,y,z pairs) in one colour, e.g. a selection box
    function lines(pts, VP, color) {
      gl.useProgram(lprog);
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STREAM_DRAW);
      const loc = gl.getAttribLocation(lprog, "aPos"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(gl.getUniformLocation(lprog, "uMVP"), false, VP); gl.uniform4fv(gl.getUniformLocation(lprog, "uColor"), color);
      gl.drawArrays(gl.LINES, 0, pts.length / 3);
      gl.bindVertexArray(null); gl.deleteBuffer(b); gl.deleteVertexArray(vao);
    }
    // What a camera sees, as depth: run fn(draw) into a W x H depth texture; returns the texture.
    function depthPass(W, H, fn) {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, W, H, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      gl.viewport(0, 0, W, H); gl.enable(gl.DEPTH_TEST); gl.clear(gl.DEPTH_BUFFER_BIT);
      fn(draw);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
      return tex;
    }
    const texture = img => tex(img);
    const free = t => t && gl.deleteTexture(t);
    // Draw fn(draw) into an offscreen W x H picture (no antialiasing, so encoded values stay exact) and read it back:
    // RGBA bytes, bottom row first.
    function capture(W, H, fn) {
      const fb = gl.createFramebuffer(), tx = gl.createTexture(), rb = gl.createRenderbuffer();
      gl.bindTexture(gl.TEXTURE_2D, tx); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
      fn(draw);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb); gl.deleteTexture(tx); gl.deleteRenderbuffer(rb);
      return px;
    }
    // Let go of a mesh made by upload() (its buffers, and textures of its own), e.g. a Person's pose that's no longer shown.
    function drop(mesh) {
      for (const p of mesh?.parts || []) {
        gl.deleteVertexArray(p.vao); (p.bufs || []).forEach(b => gl.deleteBuffer(b));
        for (const k of p.ownTex || []) if (p[k]) gl.deleteTexture(p[k]);
      }
      if (mesh) mesh.parts = [];
    }
    return { upload, begin, draw, lines, depthPass, texture, free, drop, capture };
  }

  return { start, openList, view, download, _parseGLB: parseGLB,
    gl: { parseGLB, gpu, mul4, perspective, lookAt, themeBg } };
})();
