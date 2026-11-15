/* A small WebGL 3D viewport for the Camera window, Blender style.

   The scene: the finished picture as a card at the origin (raised into a relief when depth has
   been analysed), a floor grid, and the shot camera as an object with its frustum, the patch of
   the card it sees, and its path over the clip. You orbit / pan / zoom the view, and drag the
   camera to move, rotate or orbit it. "Look through" shows the shot from the camera itself,
   relief and all, so parallax can be judged before rendering.

   World units are the picture's pixels, x right, y down, z away from the resting camera; the
   card lies in z = 0 and the resting camera sits at z = -D (D = the picture's longer side), as in
   app/camera.py. No libraries: plain WebGL 1. */
"use strict";

const Viewport3D = (() => {
  const rad = Math.PI / 180;
  const ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const mul3 = (a, b) => a.map((row, i) => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  const app3 = (m, v) => [0, 1, 2].map(i => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

  /* Shot camera from its parameters (same maths as app/camera.py). */
  function pose(p, W, H) {
    const D = Math.max(W, H);
    const R = mul3(mul3(mul3(ry(p.orbit * rad), ry(p.pan * rad)), rx(p.tilt * rad)), rz(p.roll * rad));
    const p0 = [p.truck * W, -p.pedestal * H, -D * (1 - p.dolly)], o = p.orbit * rad;
    const pos = [Math.cos(o) * p0[0] + Math.sin(o) * p0[2], p0[1], -Math.sin(o) * p0[0] + Math.cos(o) * p0[2]];
    return { R, pos, F: D * p.zoom, D };
  }
  // The inverse for positions: truck / pedestal / dolly that put the camera at `pos` (orbit kept).
  function placeAt(pos, orbit, W, H) {
    const D = Math.max(W, H), o = -orbit * rad;
    const p0 = [Math.cos(o) * pos[0] + Math.sin(o) * pos[2], pos[1], -Math.sin(o) * pos[0] + Math.cos(o) * pos[2]];
    return { truck: p0[0] / W, pedestal: -p0[1] / H, dolly: 1 + p0[2] / D };
  }

  /* 4×4 matrices, column-major for WebGL. */
  function perspective(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
  }
  // View matrix of a camera with rotation R (columns: right, down, forward) at pos.
  function viewOf(R, pos) {
    // camera coords c = Rᵀ(x − pos); GL wants y up, looking down −z: flip y and z.
    const Rt = [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
    const t = app3(Rt, scale(pos, -1));
    const m = [[Rt[0][0], Rt[0][1], Rt[0][2], t[0]], [-Rt[1][0], -Rt[1][1], -Rt[1][2], -t[1]], [-Rt[2][0], -Rt[2][1], -Rt[2][2], -t[2]], [0, 0, 0, 1]];
    return new Float32Array([m[0][0], m[1][0], m[2][0], 0, m[0][1], m[1][1], m[2][1], 0, m[0][2], m[1][2], m[2][2], 0, m[0][3], m[1][3], m[2][3], 1]);
  }
  function mul4(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
    }
    return o;
  }
  function project(m, v, w, h) {
    const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
    const ww = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
    if (ww <= 1e-6) return null;
    return [(x / ww * 0.5 + 0.5) * w, (1 - (y / ww * 0.5 + 0.5)) * h];
  }

  const VS_MESH = `attribute vec3 p; attribute vec2 uv; uniform mat4 m; varying vec2 v; varying float s;
    void main(){ v = uv; s = clamp(1.0 + p.z * 0.0, 0.0, 1.0); gl_Position = m * vec4(p, 1.0); }`;
  // The picture, with the clip's Fx lights and vignette applied in picture space, as the render does
  // (app/render.py fx_filters): relight c·(1+I·g·rgb), glow c+I·g·rgb, shade c·(1−d·g), with a
  // Gaussian g of radius × the shorter side; vignette cos⁴ of the angle × distance from the centre.
  const FS_MESH = `precision mediump float; varying vec2 v; uniform sampler2D t; uniform float has; uniform float a;
    uniform float nl; uniform vec4 lp[4]; uniform vec4 lc[4]; uniform vec2 asp; uniform float vig;
    void main(){
      vec4 c = has > 0.5 ? texture2D(t, v) : vec4(0.32, 0.34, 0.4, 1.0);
      vec3 col = c.rgb;
      float sh = min(asp.x, asp.y);
      for (int i = 0; i < 4; i++) {
        if (float(i) >= nl) break;
        vec2 d = (v - lp[i].xy) * asp;
        float s = lp[i].z * sh;
        float g = exp(-dot(d, d) / (2.0 * s * s));
        float I = lp[i].w;
        if (lc[i].w < 0.5) col = min(vec3(1.0), col * (1.0 + I * g * lc[i].rgb));
        else if (lc[i].w < 1.5) col = min(vec3(1.0), col + I * g * lc[i].rgb);
        else col = col * (1.0 - min(1.0, I * 0.7) * g);
      }
      if (vig > 0.0) {
        vec2 d = (v - 0.5) * asp;
        float r = length(d) / length(asp * 0.5);
        float f = cos(min(1.5707, vig * r));
        col *= f * f * f * f;
      }
      gl_FragColor = vec4(col, a);
    }`;
  const VS_LINE = `attribute vec3 p; attribute vec4 c; uniform mat4 m; varying vec4 vc; void main(){ vc = c; gl_Position = m * vec4(p, 1.0); }`;
  const FS_LINE = `precision mediump float; varying vec4 vc; void main(){ gl_FragColor = vc; }`;

  function create(canvas, host) {
    const gl = canvas.getContext("webgl", { antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) { canvas.replaceWith(Object.assign(document.createElement("p"), { className: "hint", textContent: "This browser has no WebGL, so there's no 3D view." })); return null; }
    const prog = (vs, fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s);
      }
      gl.linkProgram(p); return p;
    };
    const P_MESH = prog(VS_MESH, FS_MESH), P_LINE = prog(VS_LINE, FS_LINE);
    const meshBuf = gl.createBuffer(), meshIdx = gl.createBuffer(), lineBuf = gl.createBuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    let hasTex = false, meshCount = 0, meshKey = "";
    const depthCanvas = document.createElement("canvas"), dctx = depthCanvas.getContext("2d", { willReadFrequently: true });
    let depthData = null;  // {w, h, px}
    const view = { yaw: -38, pitch: 18, dist: 2.4, target: [0, 0, -0.45], look: false, mode: "move" };
    let raf = 0, dead = false;

    function size() {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return { w, h, dpr };
    }
    function editorCam(sc) {
      const D = Math.max(sc.W, sc.H);
      const R = mul3(ry(view.yaw * rad), rx(-view.pitch * rad));  // looking slightly down at the scene
      const fwd = app3(R, [0, 0, 1]), target = scale(view.target, D);
      const pos = add(target, scale(fwd, -view.dist * D));
      return { R, pos, D, target };
    }
    function matrices(sc, w, h) {
      if (view.look) {
        const c = pose(sc.cam, sc.W, sc.H);
        const fovy = 2 * Math.atan(sc.H / 2 / c.F);
        return { M: mul4(perspective(fovy, sc.W / sc.H, c.D * 0.01, c.D * 30), viewOf(c.R, c.pos)), shot: c };
      }
      const e = editorCam(sc);
      return { M: mul4(perspective(45 * rad, w / h, e.D * 0.01, e.D * 40), viewOf(e.R, e.pos)), ed: e };
    }

    function buildMesh(sc) {
      const amount = sc.depth ? sc.amount : 0;
      const key = `${sc.W}x${sc.H}|${amount}|${depthData?.stamp || 0}`;
      if (key === meshKey) return;
      meshKey = key;
      const nx = 64, ny = Math.max(8, Math.round(64 * sc.H / sc.W));
      const v = new Float32Array((nx + 1) * (ny + 1) * 5);
      let i = 0;
      for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
        const u = x / nx, t = y / ny;
        let z = 0;
        if (depthData && amount > 0) {
          const dx = Math.min(depthData.w - 1, Math.round(u * (depthData.w - 1))), dy = Math.min(depthData.h - 1, Math.round(t * (depthData.h - 1)));
          z = -amount * (depthData.px[(dy * depthData.w + dx) * 4] / 255 - 0.5) * sc.W;
        }
        v.set([(u - 0.5) * sc.W, (t - 0.5) * sc.H, z, u, t], i); i += 5;
      }
      const idx = new Uint16Array(nx * ny * 6);
      let k = 0;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const a = y * (nx + 1) + x, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.set([a, c, b, b, c, d], k); k += 6;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf); gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
      meshCount = idx.length;
    }
    function updateTexture(el) {
      const ready = el.tagName === "VIDEO" ? el.readyState >= 2 && el.videoWidth : el.complete && el.naturalWidth;
      if (!ready) {  // mid-seek or still loading: keep the last picture and redraw once the frame is there
        if (!el.dataset.vpWait) {
          el.dataset.vpWait = "1";
          const go = () => { delete el.dataset.vpWait; ["seeked", "loadeddata", "load"].forEach(ev => el.removeEventListener(ev, go)); schedule(); };
          ["seeked", "loadeddata", "load"].forEach(ev => el.addEventListener(ev, go));
        }
        return;
      }
      try {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
        hasTex = true;
      } catch { hasTex = false; }
    }
    function readDepth(el) {
      if (!el || (el.readyState ?? 4) < 2) return;
      depthCanvas.width = 96; depthCanvas.height = Math.max(8, Math.round(96 * (el.videoHeight || el.naturalHeight || 9) / (el.videoWidth || el.naturalWidth || 16)));
      dctx.drawImage(el, 0, 0, depthCanvas.width, depthCanvas.height);
      depthData = { w: depthCanvas.width, h: depthCanvas.height, px: dctx.getImageData(0, 0, depthCanvas.width, depthCanvas.height).data, stamp: performance.now() };
    }

    function lines(sc, ctx) {
      const out = [];
      const L = (a, b, c) => out.push(...a, ...c, ...b, ...c);
      const D = Math.max(sc.W, sc.H);
      // floor grid below the picture
      const fy = sc.H / 2 + D * 0.08, step = D / 4;
      for (let i = -8; i <= 8; i++) {
        const col = i === 0 ? [0.55, 0.58, 0.66, 0.55] : [0.4, 0.42, 0.5, 0.28];
        L([i * step, fy, -3 * D], [i * step, fy, 2 * D], col);
      }
      for (let j = -12; j <= 8; j++) L([-2 * D, fy, j * step], [2 * D, fy, j * step], j === 0 ? [0.55, 0.58, 0.66, 0.55] : [0.4, 0.42, 0.5, 0.28]);
      // card outline
      const cw = sc.W / 2, ch = sc.H / 2, card = [0.9, 0.9, 0.95, 0.6];
      L([-cw, -ch, 0], [cw, -ch, 0], card); L([cw, -ch, 0], [cw, ch, 0], card); L([cw, ch, 0], [-cw, ch, 0], card); L([-cw, ch, 0], [-cw, -ch, 0], card);
      if (ctx.look) return out;
      // camera path and keys
      const path = sc.path || [];
      for (let i = 1; i < path.length; i++) L(path[i - 1], path[i], [0.65, 0.55, 0.98, 0.9]);
      for (const k of sc.keys || []) { const s = D * 0.015; L(add(k, [-s, 0, 0]), add(k, [s, 0, 0]), [0.96, 0.73, 0.26, 1]); L(add(k, [0, -s, 0]), add(k, [0, s, 0]), [0.96, 0.73, 0.26, 1]); }
      // the shot camera: body, frustum, and the patch of the card it sees
      const c = pose(sc.cam, sc.W, sc.H), sel = host.hot ? [1, 0.84, 0.35, 1] : [0.98, 0.62, 0.25, 1];
      const d = D * 0.28, corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => app3(c.R, [sx * sc.W / 2 / c.F, sy * sc.H / 2 / c.F, 1]));
      const near = corners.map(v => add(c.pos, scale(v, d)));
      for (let i = 0; i < 4; i++) { L(c.pos, near[i], sel); L(near[i], near[(i + 1) % 4], sel); }
      const up = add(c.pos, app3(c.R, [0, -sc.H / 2 / c.F * d * 1.35, d]));  // the "up" tick on top of the frustum
      L(near[0], up, sel); L(near[1], up, sel);
      const hits = corners.map(v => (v[2] > 1e-6 && -c.pos[2] / v[2] > 0 ? add(c.pos, scale(v, -c.pos[2] / v[2])) : null));
      if (hits.every(Boolean)) for (let i = 0; i < 4; i++) L(hits[i], hits[(i + 1) % 4], [1, 0.9, 0.3, 0.95]);
      const b = D * 0.03;  // body box
      const box = [[-b, -b, -b * 1.6], [b, -b, -b * 1.6], [b, b, -b * 1.6], [-b, b, -b * 1.6], [-b, -b, 0], [b, -b, 0], [b, b, 0], [-b, b, 0]].map(v => add(c.pos, app3(c.R, v)));
      for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) L(box[i], box[j], sel);
      return out;
    }

    function draw() {
      raf = 0;
      if (dead) return;
      const sc = host.scene();
      if (!sc) return;
      const { w, h } = size();
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.07, 0.075, 0.09, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      let vx = 0, vy = 0, vw = w, vh = h;
      if (view.look) {  // letterbox to the picture's shape
        const k = Math.min(w / sc.W, h / sc.H); vw = Math.round(sc.W * k); vh = Math.round(sc.H * k); vx = (w - vw) >> 1; vy = (h - vh) >> 1;
        gl.viewport(vx, vy, vw, vh); gl.enable(gl.SCISSOR_TEST); gl.scissor(vx, vy, vw, vh);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
      }
      const { M } = matrices(sc, vw, vh);
      host.lastM = M; host.lastSize = { w, h, vx, vy, vw, vh, dpr: Math.min(2, devicePixelRatio || 1) };
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // picture card
      if (sc.colorEl) updateTexture(sc.colorEl); else hasTex = false;
      buildMesh(sc);
      gl.useProgram(P_MESH);
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshIdx);
      const ap = gl.getAttribLocation(P_MESH, "p"), au = gl.getAttribLocation(P_MESH, "uv");
      gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(au); gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 20, 12);
      gl.uniformMatrix4fv(gl.getUniformLocation(P_MESH, "m"), false, M);
      gl.uniform1f(gl.getUniformLocation(P_MESH, "has"), hasTex ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(P_MESH, "a"), 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(gl.getUniformLocation(P_MESH, "t"), 0);
      // Fx lights and vignette of the clip under the camera
      const fx = sc.fx || {}, ls = (fx.lights || []).slice(0, 4);
      const lpv = new Float32Array(16), lcv = new Float32Array(16);
      ls.forEach((l, i) => { lpv.set([l.x, l.y, Math.max(0.005, l.radius), l.intensity], i * 4); lcv.set([l.rgb[0], l.rgb[1], l.rgb[2], { relight: 0, glow: 1, shade: 2 }[l.mode] ?? 0], i * 4); });
      gl.uniform1f(gl.getUniformLocation(P_MESH, "nl"), ls.length);
      gl.uniform4fv(gl.getUniformLocation(P_MESH, "lp"), lpv);
      gl.uniform4fv(gl.getUniformLocation(P_MESH, "lc"), lcv);
      gl.uniform2f(gl.getUniformLocation(P_MESH, "asp"), fx.picW || sc.W, fx.picH || sc.H);
      gl.uniform1f(gl.getUniformLocation(P_MESH, "vig"), fx.vignette > 1e-3 ? 0.15 + 0.85 * fx.vignette : 0);
      gl.drawElements(gl.TRIANGLES, meshCount, gl.UNSIGNED_SHORT, 0);
      gl.disableVertexAttribArray(au);
      // lines
      const data = new Float32Array(lines(sc, { look: view.look }));
      gl.useProgram(P_LINE);
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      const lp = gl.getAttribLocation(P_LINE, "p"), lc = gl.getAttribLocation(P_LINE, "c");
      gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 4, gl.FLOAT, false, 28, 12);
      gl.uniformMatrix4fv(gl.getUniformLocation(P_LINE, "m"), false, M);
      gl.drawArrays(gl.LINES, 0, data.length / 7);
      gl.disableVertexAttribArray(lc);
      if (host.playing?.()) schedule();
    }
    function schedule() { if (!raf && !dead) raf = requestAnimationFrame(draw); }

    /* ---- interaction */
    function camScreen(sc) {
      if (!host.lastM || view.look) return null;
      const s = host.lastSize, c = pose(sc.cam, sc.W, sc.H);
      const p = project(host.lastM, c.pos, s.vw, s.vh);
      return p && [p[0] / s.dpr, p[1] / s.dpr];
    }
    let drag = null;
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("pointerdown", e => {
      const sc = host.scene(); if (!sc) return;
      canvas.focus();
      const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const cs = camScreen(sc);
      const onCam = cs && Math.hypot(cs[0] - mx, cs[1] - my) < 22 && e.button === 0;
      drag = { x: e.clientX, y: e.clientY, onCam, btn: e.button, shift: e.shiftKey, start: sc.cam, ed: view.look ? null : editorCam(sc), view: { ...view, target: [...view.target] } };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", e => {
      const sc = host.scene(); if (!sc) return;
      if (!drag) {
        const r = canvas.getBoundingClientRect(), cs = camScreen(sc);
        const hot = !!cs && Math.hypot(cs[0] - (e.clientX - r.left), cs[1] - (e.clientY - r.top)) < 22;
        if (hot !== !!host.hot) { host.hot = hot; canvas.style.cursor = hot ? "grab" : "default"; schedule(); }
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, D = Math.max(sc.W, sc.H), p0 = drag.start;
      if (drag.onCam || (view.look && drag.btn === 0)) {
        // manipulate the shot camera
        const mode = view.look ? (e.shiftKey ? "move" : "rotate") : view.mode;
        if (mode === "rotate") {
          const ch = e.shiftKey && !view.look ? { roll: p0.roll + dx * 0.3 } : { pan: p0.pan + dx * 0.25, tilt: p0.tilt - dy * 0.25 };
          host.change(ch);
        } else if (mode === "orbit") {
          host.change({ orbit: p0.orbit + dx * 0.3, ...(e.shiftKey ? {} : { pedestal: p0.pedestal - dy * 0.002 }) });
        } else {
          const c0 = pose(p0, sc.W, sc.H);
          let pos;
          if (view.look) {  // move in the camera's own plane
            pos = add(c0.pos, add(scale(app3(c0.R, [1, 0, 0]), -dx * D / 600), scale(app3(c0.R, [0, 1, 0]), -dy * D / 600)));
          } else {
            const ed = drag.ed, fwd = app3(ed.R, [0, 0, 1]);
            const depth = Math.max(D * 0.1, (c0.pos[0] - ed.pos[0]) * fwd[0] + (c0.pos[1] - ed.pos[1]) * fwd[1] + (c0.pos[2] - ed.pos[2]) * fwd[2]);
            const s = host.lastSize, fpx = (s.vh / s.dpr) / 2 / Math.tan(22.5 * rad), k = depth / fpx;
            pos = e.shiftKey ? add(c0.pos, scale(fwd, -dy * k))  // Shift: toward / away from you
              : add(c0.pos, add(scale(app3(ed.R, [1, 0, 0]), dx * k), scale(app3(ed.R, [0, 1, 0]), dy * k)));
          }
          host.change(placeAt(pos, p0.orbit, sc.W, sc.H));
        }
      } else if (!view.look) {
        // navigate the view: drag = orbit, right / Shift+drag = pan
        if (drag.btn === 2 || drag.btn === 1 || drag.shift) {
          const ed = drag.ed, k = drag.view.dist / 500;
          const right = app3(ed.R, [1, 0, 0]), down = app3(ed.R, [0, 1, 0]);
          view.target = add(drag.view.target, add(scale(right, -dx * k), scale(down, -dy * k)));
        } else {
          view.yaw = drag.view.yaw + dx * 0.35;
          view.pitch = Math.max(-85, Math.min(85, drag.view.pitch + dy * 0.35));
        }
        schedule();
      }
    });
    const end = () => { if (drag?.onCam || view.look) host.commit?.(); drag = null; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const sc = host.scene(); if (!sc) return;
      if (host.hot || view.look) host.change({ zoom: Math.max(0.3, Math.min(5, sc.cam.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06))) }), host.commit?.();
      else { view.dist = Math.max(0.3, Math.min(12, view.dist * (e.deltaY < 0 ? 0.9 : 1.1))); schedule(); }
    }, { passive: false });
    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", e => {
      const k = e.key.toLowerCase();
      if (k === "g") setMode("move"); else if (k === "r") setMode("rotate"); else if (k === "o") setMode("orbit");
      else if (k === "c") setLook(!view.look); else if (k === "f" || k === "home") reset(); else return;
      e.preventDefault(); e.stopPropagation();
    });
    const ro = new ResizeObserver(() => schedule()); ro.observe(canvas);

    function setMode(m) { view.mode = m; host.modeChanged?.(m); schedule(); }
    function setLook(on) { view.look = on; host.lookChanged?.(on); schedule(); }
    function reset() { Object.assign(view, { yaw: -38, pitch: 18, dist: 2.4, target: [0, 0, -0.45] }); schedule(); }
    return {
      draw: schedule, setMode, setLook, reset, readDepth: el => { readDepth(el); schedule(); },
      clearDepth: () => { depthData = null; meshKey = ""; schedule(); },
      get mode() { return view.mode; }, get look() { return view.look; },
      destroy() { dead = true; ro.disconnect(); cancelAnimationFrame(raf); },
    };
  }
  return { create, pose, placeAt };
})();
