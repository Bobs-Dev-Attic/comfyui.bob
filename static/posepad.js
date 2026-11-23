/* 🤸 The pose editor: a big window for a Person in a 3D scene (scene3d.js), opened from its right-click menu or its
   panel (🤸 Edit pose…). The mannequin stands in its own 3D view with a dot on each joint:
     - drag a hand or a foot and the arm or leg follows it (the elbow or knee bends the way it already does),
     - drag an elbow or a knee to swing the upper arm or thigh (the forearm or shin keeps its bend),
     - drag the head to turn and nod it, the chest to bend and twist the body,
     - drag anywhere else to turn the view; the wheel zooms.
   Beside it, sliders for the selected part (head, body, each arm and leg, the hands), Mirror and Reset, its name and the
   words the photo and video models are told (made from the pose when left empty). On the left the pose library: the
   presets and the poses you saved (data/v2/poses.json, every project). Apply keys it on the Person at the playhead.

   The pose: arms and legs a direction for each bone, x pointing out from the body (scene3d.js POSES), the spine
   [bend, lean, twist] and head [turn, nod, tilt] in degrees (+ forward, to their left, down), hands relaxed, open or
   fist. Drawn with the scene's own mannequin (Scene3D.poseKit) and Model3D's WebGL helpers; no libraries. */
"use strict";

const PosePad = (() => {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = a => Math.hypot(a[0], a[1], a[2]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = v => { const l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const tr = M => [0, 1, 2].map(i => [M[0][i], M[1][i], M[2][i]]);
  const app3 = (M, p) => [0, 1, 2].map(i => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2]);
  const uid = () => Math.random().toString(16).slice(2, 10);
  const html = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hexRgb = h => /^#[0-9a-f]{6}$/i.test(h || "") ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255) : [0.79, 0.77, 0.73];
  const sideX = sd => sd === "R" ? -1 : 1;
  const flipX = (v, sx) => norm([v[0] * sx, v[1], v[2]]);  // a bone's direction: the pose's (x out) <-> the body's
  const FOV = 35 * rad, TARGET = [0, 0.92, 0];

  let lib = null;  // the saved poses [{ id, name, says, pose }]
  const thumbs = new Map();
  async function loadLib() {
    try { lib = (await api("/api/v2/poses")).poses || []; } catch { lib = []; }
    lib.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  /* ---------------------------------------------------------------- a limb in angles (for its sliders)
     The upper bone: lift (0 hanging down, 90 level, 180 straight up) and swing (0 out to the side, 90 forward, -90
     back). The lower one: how far it bends from the upper (0 straight) and which way (0 forward, 90 in, -90 out,
     180 back), about the upper bone. */
  function perp(u) {  // two directions across u: r0 (forward as far as it can be) and r1 (inward)
    const ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const r0 = norm(sub(ref, mul(u, dot(ref, u))));
    return [r0, cross(u, r0)];
  }
  const fromLift = (lift, swing) => { const t = lift * rad, p = swing * rad; return [Math.sin(t) * Math.cos(p), -Math.cos(t), Math.sin(t) * Math.sin(p)]; };
  function anglesOf([a, b]) {
    const u = norm(a), l = norm(b), [r0, r1] = perp(u);
    const bend = Math.acos(clamp(dot(u, l), -1, 1)) * deg, w = sub(l, mul(u, dot(u, l)));
    return { lift: Math.acos(clamp(-u[1], -1, 1)) * deg, swing: Math.atan2(u[2], u[0]) * deg, bend, dir: len(w) < 1e-4 ? 0 : Math.atan2(dot(w, r1), dot(w, r0)) * deg };
  }
  const lowerOf = (u, bend, dir) => { const [r0, r1] = perp(u), b = bend * rad, d = dir * rad;
    return norm(add(mul(u, Math.cos(b)), mul(add(mul(r0, Math.cos(d)), mul(r1, Math.sin(d))), Math.sin(b)))); };
  // v turned the way that takes a to b (the shortest turn): a forearm following its upper arm
  function carry(v, a, b) {
    const k0 = cross(a, b), s = len(k0), c = dot(a, b);
    if (s < 1e-6) return v.slice();
    const k = mul(k0, 1 / s);
    return norm(add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c))));
  }
  // two bones from root to reach t (lengths L), bending towards pole: [upper, lower] directions
  function reach(root, t, L, pole) {
    const d = sub(t, root), dn = norm(d), dist = clamp(len(d), Math.abs(L[0] - L[1]) + 1e-3, L[0] + L[1] - 1e-3);
    const a = Math.acos(clamp((L[0] * L[0] + dist * dist - L[1] * L[1]) / (2 * L[0] * dist), -1, 1));
    let b = sub(pole, mul(dn, dot(pole, dn)));
    if (len(b) < 1e-4) b = perp(dn)[0];
    b = norm(b);
    const u = norm(add(mul(dn, Math.cos(a)), mul(b, Math.sin(a))));
    return [u, norm(sub(add(root, mul(dn, dist)), add(root, mul(u, L[0]))))];
  }

  /* ---------------------------------------------------------------- the window */
  const SLIDERS = {
    head: [["head", 0, "Turn", -80, 80, "+ to their left"], ["head", 1, "Nod", -40, 60, "+ down"], ["head", 2, "Tilt", -40, 40, "+ to their left shoulder"]],
    body: [["spine", 0, "Bend", -30, 90, "+ forward"], ["spine", 1, "Lean", -40, 40, "+ to their left"], ["spine", 2, "Twist", -60, 60, "+ to their left"]],
  };
  const LIMB = [["lift", "Lift", 0, 180, "0 hanging down, 90 level, 180 up"], ["swing", "Swing", -180, 180, "0 out to the side, 90 forward, -90 back"],
    ["bend", "Bend", 0, 160, "0 straight"], ["dir", "Bend towards", -180, 180, "0 forward, 90 in, -90 out, 180 back"]];
  const PARTS = [["head", "🙂 Head"], ["body", "🧍 Body"], ["armR", "💪 Right arm"], ["armL", "💪 Left arm"], ["legR", "🦵 Right leg"], ["legL", "🦵 Left leg"], ["hands", "✋ Hands"]];

  function open(o) {
    const kit = Scene3D.poseKit, G = Model3D.gl;
    css();
    let def = kit.completePose(o.def), preset = o.preset || null, mineId = null, part = "armR", mesh = null;
    const cam = { yaw: 28, pitch: 8, dist: 3.7 };
    const box = document.createElement("div");
    box.className = "pp";
    box.innerHTML = `<div class="pp-lib"><h4>Poses</h4><div class="pp-grid" data-g="pre"></div><h4>Saved <span class="opt">every project</span></h4><div class="pp-grid" data-g="mine"><p class="hint">Loading…</p></div></div>
      <div class="pp-view"><canvas class="pp-gl"></canvas><canvas class="pp-ov" tabindex="0" aria-label="The pose: drag a joint's dot to move it, elsewhere to turn the view"></canvas>
        <p class="hint pp-tip">Drag a dot: hands and feet pull the arm or leg, elbows and knees swing it, the head turns, the chest bends. Drag elsewhere to turn the view; the wheel zooms.</p></div>
      <div class="pp-side"><div class="pp-parts">${PARTS.map(([k, t]) => `<button type="button" class="chip-btn" data-part="${k}">${t}</button>`).join("")}</div>
        <div class="pp-ctl"></div>
        <div class="pp-row"><button type="button" class="btn sm" data-a="mirror" title="Swap left and right">⇋ Mirror</button><button type="button" class="btn sm ghost" data-a="reset" title="Back to standing">↺ Standing</button></div>
        <div class="field"><label for="pp-name">Name</label><input id="pp-name" maxlength="60" placeholder="Custom pose"></div>
        <div class="field"><label for="pp-says">Described as <span class="opt">what the photo and video models are told</span></label><textarea id="pp-says" rows="3" maxlength="200"></textarea></div>
        <button type="button" class="btn sm" data-a="save" title="Keep it in the pose library, for every project">💾 Save to the library</button></div>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="hint">${html(o.who || "Person")} at ${(+o.at || 0).toFixed(2)} s: applying it keys the pose there.</span><span class="wm-foot-gap"></span>
      <button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="apply">🤸 Apply</button>`;
    const $ = q => box.querySelector(q);
    const nameEl = $("#pp-name"), saysEl = $("#pp-says");
    nameEl.value = o.def?.label || (preset ? kit.POSES[preset]?.label || "" : "");
    let autoName = !!preset && !o.def?.label;
    saysEl.value = o.def?.says || "";

    const view = $(".pp-view"), cv = $(".pp-gl"), ov = $(".pp-ov");
    const gl = cv.getContext("webgl2", { antialias: true });
    const gpu = gl ? G.gpu(gl) : null;
    if (!gl) view.insertAdjacentHTML("beforeend", `<p class="hint">This browser has no WebGL 2, so the pose can't be shown; the sliders still work.</p>`);
    const base = [...hexRgb(o.color), 1];
    let raf = 0;
    const ro = new ResizeObserver(() => redraw());
    const win = WM.open({ id: "posepad", title: `🤸 Pose · ${o.who || "Person"}`, content: box, footer: foot, width: 1080, height: 700, minWidth: 760, minHeight: 520, modal: true,
      onClose: () => { ro.disconnect(); cancelAnimationFrame(raf); if (mesh) gpu?.drop(mesh); gl?.getExtension("WEBGL_lose_context")?.loseContext(); } });
    ro.observe(view);

    /* ---- drawing */
    function camera() {
      const W = cv.clientWidth || 1, H = cv.clientHeight || 1, y = cam.yaw * rad, p = cam.pitch * rad;
      const eye = add(TARGET, mul([Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)], cam.dist));
      const f = norm(sub(TARGET, eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
      const VP = G.mul4(G.perspective(FOV, W / H, 0.05, 50), G.lookAt(eye, TARGET, [0, 1, 0]));
      return { W, H, eye, f, r, u, VP };
    }
    const toScreen = (C, p) => { const M = C.VP, x = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], y = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], w = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15];
      return [(x / w * 0.5 + 0.5) * C.W, (0.5 - y / w * 0.5) * C.H]; };
    const GRID = (() => { const g = []; for (let i = -6; i <= 6; i++) { const a = i * 0.25; g.push(a, 0, -1.5, a, 0, 1.5, -1.5, 0, a, 1.5, 0, a); } return g; })();
    function meshOf(d) {
      const { P, N, I } = kit.shapeOf("figure", d);
      return gpu.upload([{ pos: new Float32Array(P), nrm: new Float32Array(N), uv: null, col: null, idx: new Uint32Array(I), base, tex: null, ao: null }]);
    }
    function rebuild() { if (!gpu) return; if (mesh) gpu.drop(mesh); mesh = meshOf(def); redraw(); }
    function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); }
    function paint() {
      const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(view.clientWidth * dpr), H = Math.round(view.clientHeight * dpr);
      for (const c of [cv, ov]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const C = camera();
      if (gpu && mesh) {
        gpu.begin(W, H, G.themeBg(view));
        gpu.draw(mesh, { VP: C.VP, M: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], eye: C.eye, key: [0.45, 0.9, 0.7], look: 0 });
        gpu.lines(GRID, C.VP, [0.5, 0.5, 0.5, 0.45]);
      }
      // the joints' dots and the bones between them
      const x = ov.getContext("2d"), cs = getComputedStyle(box), acc = cs.getPropertyValue("--accent").trim() || "#4f8cff";
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
      const hs = handles(C);
      x.lineWidth = 1.5; x.strokeStyle = "rgba(120,120,120,0.55)";
      const J = kit.figureJoints(def), seg = (a, b) => { const p = toScreen(C, a), q = toScreen(C, b); x.beginPath(); x.moveTo(...p); x.lineTo(...q); x.stroke(); };
      seg(J.head, J.neck); seg(J.neck, J.chest); seg(J.chest, J.waist);
      for (const sd of ["R", "L"]) { const a = J.arms[sd], l = J.legs[sd]; seg(J.neck, a.sh); seg(a.sh, a.el); seg(a.el, a.wr); seg(J.waist, l.hp); seg(l.hp, l.kn); seg(l.kn, l.an); }
      for (const h of hs) {
        const on = h.part === part || (part === "hands" && h.kind === "hand");
        x.beginPath(); x.arc(h.s[0], h.s[1], on ? 7 : 5.5, 0, 2 * Math.PI);
        x.fillStyle = on ? acc : "rgba(255,255,255,0.9)"; x.fill(); x.lineWidth = 2; x.strokeStyle = on ? "#fff" : "rgba(0,0,0,0.6)"; x.stroke();
      }
    }
    // the dots: { part, kind, p (3D), s (on screen) }
    function handles(C = camera()) {
      const J = kit.figureJoints(def), out = [{ part: "head", kind: "head", p: J.head }, { part: "body", kind: "chest", p: J.chest }];
      for (const sd of ["R", "L"]) {
        out.push({ part: `arm${sd}`, kind: "elbow", sd, p: J.arms[sd].el }, { part: `arm${sd}`, kind: "hand", sd, p: J.arms[sd].wr },
          { part: `leg${sd}`, kind: "knee", sd, p: J.legs[sd].kn }, { part: `leg${sd}`, kind: "foot", sd, p: J.legs[sd].an });
      }
      for (const h of out) h.s = toScreen(C, h.p);
      return out;
    }

    /* ---- changing it */
    function changed(redrawCtl = false) {
      preset = null;
      if (autoName) { nameEl.value = ""; autoName = false; }  // a preset's name, now it's something else
      saysEl.placeholder = kit.describePose(def) || "standing";
      rebuild();
      if (redrawCtl) fillCtl();
    }
    function setPart(k) {
      part = k;
      box.querySelectorAll("[data-part]").forEach(b => b.classList.toggle("on", b.dataset.part === k));
      const ctl = $(".pp-ctl"), sl = (key, label, min, max, tip) => `<label class="pp-sl" title="${html(tip)}"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="1"><output></output></label>`;
      if (SLIDERS[k]) ctl.innerHTML = SLIDERS[k].map(([g, j, label, min, max, tip]) => sl(`${g}.${j}`, label, min, max, tip)).join("");
      else if (k === "hands") ctl.innerHTML = ["R", "L"].map(sd => `<div class="field"><label>${sd === "R" ? "Right" : "Left"} hand</label><select data-hand="${sd}">${kit.HANDS.map(h => `<option value="${h}">${h[0].toUpperCase() + h.slice(1)}</option>`).join("")}</select></div>`).join("");
      else {
        const leg = k.startsWith("leg");
        ctl.innerHTML = `<p class="pp-h">${leg ? "Thigh" : "Upper arm"}</p>${LIMB.slice(0, 2).map(([key, label, min, max, tip]) => sl(key, label, min, leg && key === "lift" ? 150 : max, tip)).join("")}
          <p class="pp-h">${leg ? "Knee" : "Elbow"}</p>${LIMB.slice(2).map(([key, label, min, max, tip]) => sl(key, label, min, max, tip)).join("")}
          ${leg ? `<label class="check"><input type="checkbox" data-kneel> Foot behind (kneeling on this knee)</label>` : ""}`;
      }
      fillCtl(); redraw();
    }
    const limbOf = k => ({ g: k.startsWith("leg") ? "legs" : "arms", sd: k.slice(-1) });
    function fillCtl() {
      const ctl = $(".pp-ctl"), set = (el, v) => { if (el && el !== document.activeElement) { el.value = String(Math.round(v)); el.nextElementSibling.textContent = `${Math.round(v)}°`; } };
      if (SLIDERS[part]) for (const el of ctl.querySelectorAll("[data-k]")) { const [g, j] = el.dataset.k.split("."); set(el, def[g][+j]); }
      else if (part === "hands") ctl.querySelectorAll("[data-hand]").forEach(el => { el.value = def.hands[el.dataset.hand]; });
      else {
        const { g, sd } = limbOf(part), A = anglesOf(def[g][sd]);
        for (const el of ctl.querySelectorAll("[data-k]")) set(el, A[el.dataset.k]);
        const kn = ctl.querySelector("[data-kneel]"); if (kn) kn.checked = def[g][sd][2] === "back";
      }
    }
    box.addEventListener("input", e => {
      const t = e.target;
      if (t.dataset.k == null) return;
      t.nextElementSibling.textContent = `${t.value}°`;
      if (SLIDERS[part]) { const [g, j] = t.dataset.k.split("."); def[g][+j] = +t.value; return changed(); }
      const { g, sd } = limbOf(part), L = def[g][sd], v = k => +$(`.pp-ctl [data-k="${k}"]`).value;
      const u0 = norm(L[0]);
      if (t.dataset.k === "lift" || t.dataset.k === "swing") { const u = norm(fromLift(v("lift"), v("swing"))); L[1] = carry(norm(L[1]), u0, u); L[0] = u; }
      else L[1] = lowerOf(u0, v("bend"), v("dir"));
      changed();
    });
    box.addEventListener("change", e => {
      const t = e.target;
      if (t.dataset.hand) { def.hands[t.dataset.hand] = t.value; changed(); }
      else if (t.hasAttribute("data-kneel")) { const { g, sd } = limbOf(part), L = def[g][sd]; L.length = 2; if (t.checked) L.push("back"); changed(); }
      else if (t === nameEl || t === saysEl) { preset = null; if (t === nameEl) autoName = false; }
    });
    box.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.part) return setPart(b.dataset.part);
      if (b.dataset.pre) return loadPose(kit.POSES[b.dataset.pre], b.dataset.pre);
      if (b.dataset.mine) { const p = lib?.find(x => x.id === b.dataset.mine); if (p) loadPose(p.pose, null, p); return; }
      if (b.dataset.del) return delMine(b.dataset.del);
      const a = b.dataset.a;
      if (a === "mirror") {
        const m = def;
        def = { arms: { R: m.arms.L, L: m.arms.R }, legs: { R: m.legs.L, L: m.legs.R }, spine: [m.spine[0], -m.spine[1], -m.spine[2]], head: [-m.head[0], m.head[1], -m.head[2]], hands: { R: m.hands.L, L: m.hands.R } };
        if (/^(arm|leg)[RL]$/.test(part)) part = part.slice(0, 3) + (part[3] === "R" ? "L" : "R");
        setPart(part); changed(true);
      }
      if (a === "reset") { def = kit.completePose(kit.POSES.standing); changed(true); }
      if (a === "save") saveMine();
    });
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="apply"]').onclick = () => {
      const label = nameEl.value.trim(), says = saysEl.value.trim();
      o.onApply?.({ preset, def: { ...def, label: label || "Custom pose", says } });
      win.close();
    };

    /* ---- dragging in the view */
    let drag = null;
    const at = e => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function rayTo(C, m, Q) {  // the point under the mouse on the plane through Q facing the view
      const th = Math.tan(FOV / 2), nx = m[0] / C.W * 2 - 1, ny = 1 - m[1] / C.H * 2;
      const d = norm(add(C.f, add(mul(C.r, nx * th * C.W / C.H), mul(C.u, ny * th))));
      const k = dot(sub(Q, C.eye), C.f) / (dot(d, C.f) || 1e-6);
      return add(C.eye, mul(d, k));
    }
    ov.addEventListener("pointerdown", e => {
      const m = at(e), C = camera(), h = handles(C).map(x => ({ ...x, d: Math.hypot(x.s[0] - m[0], x.s[1] - m[1]) })).filter(x => x.d < 14).sort((a, b) => a.d - b.d)[0];
      ov.setPointerCapture(e.pointerId);
      if (h) { if (h.part !== part && !(part === "hands" && h.kind === "hand")) setPart(h.part); drag = { h, Q: h.p, m, def0: JSON.parse(JSON.stringify(def)) }; }
      else drag = { orbit: true, m, yaw: cam.yaw, pitch: cam.pitch };
    });
    ov.addEventListener("pointermove", e => {
      if (!drag) { const m = at(e), near = handles().some(x => Math.hypot(x.s[0] - m[0], x.s[1] - m[1]) < 14); ov.style.cursor = near ? "grab" : "default"; return; }
      const m = at(e), dx = m[0] - drag.m[0], dy = m[1] - drag.m[1];
      if (drag.orbit) { cam.yaw = drag.yaw - dx * 0.4; cam.pitch = clamp(drag.pitch + dy * 0.3, -20, 80); return redraw(); }
      const h = drag.h, C = camera(), face = Math.cos(cam.yaw * rad) >= 0 ? 1 : -1;
      if (h.kind === "head") { def.head[0] = clamp(drag.def0.head[0] + dx * 0.4 * face, -80, 80); def.head[1] = clamp(drag.def0.head[1] + dy * 0.4, -40, 60); return changed(true); }
      if (h.kind === "chest") { def.spine[2] = clamp(drag.def0.spine[2] + dx * 0.3 * face, -60, 60); def.spine[0] = clamp(drag.def0.spine[0] + dy * 0.3, -30, 90); return changed(true); }
      const p = rayTo(C, m, drag.Q), sd = h.sd, sx = sideX(sd), arm = h.kind === "elbow" || h.kind === "hand";
      const J = kit.figureJoints(def), S = arm ? J.S : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const local = q => add(kit.WAIST, app3(tr(S), sub(q, kit.WAIST)));  // the body's frame (the upper body unturned)
      const g = arm ? "arms" : "legs", L = def[g][sd], root = arm ? [sx * 0.2, 1.41, 0] : [sx * 0.09, 0.9, 0], lens = arm ? kit.ARM : kit.LEG;
      const u0 = flipX(L[0], sx), l0 = flipX(L[1], sx), t = local(p);
      let u, l;
      if (h.kind === "elbow" || h.kind === "knee") { u = norm(sub(t, root)); l = carry(l0, u0, u); }
      else {
        // the elbow or knee bends the way it does now, or (nearly straight) the natural way: elbows back and out, knees forward
        const el = mul(u0, lens[0]), wr = add(el, mul(l0, lens[1]));  // from the root
        const pole = dot(u0, l0) < 0.985 ? sub(el, mul(wr, 0.5)) : arm ? [sx * 0.4, -0.5, -1] : [0, 0, 1];
        [u, l] = reach(root, t, lens, pole);
      }
      def[g][sd] = [flipX(u, sx), flipX(l, sx), ...(L[2] ? [L[2]] : [])];
      changed(true);
    });
    const end = () => { drag = null; };
    ov.addEventListener("pointerup", end); ov.addEventListener("pointercancel", end);
    ov.addEventListener("wheel", e => { e.preventDefault(); cam.dist = clamp(cam.dist * (e.deltaY > 0 ? 1.1 : 1 / 1.1), 1.2, 8); redraw(); }, { passive: false });
    ov.addEventListener("contextmenu", e => e.preventDefault());

    /* ---- the library */
    function loadPose(p, presetName = null, mine = null) {
      def = kit.completePose(p);
      preset = presetName; mineId = mine?.id || null;
      nameEl.value = mine?.name || (presetName ? kit.POSES[presetName]?.label || "" : "");
      autoName = !!presetName;
      saysEl.value = mine ? mine.says || "" : "";
      saysEl.placeholder = kit.describePose(def) || "standing";
      rebuild(); fillCtl();
    }
    function thumb(p) {
      const key = JSON.stringify(kit.completePose(p));
      if (thumbs.has(key)) return thumbs.get(key);
      if (!gpu) return "";
      const W = 72, H = 96, m = meshOf(p), eye = [1.15, 1.25, 2.9], T = [0, 0.86, 0];
      const VP = G.mul4(G.perspective(32 * rad, W / H, 0.05, 50), G.lookAt(eye, T, [0, 1, 0]));
      const px = gpu.capture(W, H, draw => draw(m, { VP, M: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], eye, key: [0.45, 0.9, 0.7], look: 0 }));
      gpu.drop(m);
      const c = Object.assign(document.createElement("canvas"), { width: W, height: H }), x = c.getContext("2d"), img = x.createImageData(W, H);
      for (let r = 0; r < H; r++) img.data.set(px.subarray((H - 1 - r) * W * 4, (H - r) * W * 4), r * W * 4);
      x.putImageData(img, 0, 0);
      const url = c.toDataURL();
      thumbs.set(key, url);
      redraw();
      return url;
    }
    const card = (attr, name, p, del = "") => `<div class="pp-card"><button type="button" ${attr} title="${html(name)}">${(() => { const u = thumb(p); return u ? `<img src="${u}" alt="">` : ""; })()}<span>${html(name)}</span></button>${del}</div>`;
    function drawLib() {
      $('[data-g="pre"]').innerHTML = Object.entries(kit.POSES).map(([k, p]) => card(`data-pre="${k}"`, p.label, p)).join("");
      $('[data-g="mine"]').innerHTML = lib?.length ? lib.map(p => card(`data-mine="${html(p.id)}"`, p.name, p.pose, `<button type="button" class="pp-del" data-del="${html(p.id)}" aria-label="Delete ${html(p.name)}" title="Delete">✕</button>`)).join("")
        : `<p class="hint">${lib ? "None yet: pose the figure and 💾 Save to the library." : "Loading…"}</p>`;
    }
    async function saveMine() {
      const name = nameEl.value.trim() || "My pose", old = mineId && lib?.find(x => x.id === mineId);
      const id = old && old.name === name ? old.id : uid();
      const pose = JSON.parse(JSON.stringify(def));
      try {
        await api(`/api/v2/poses/${id}`, { method: "PUT", body: JSON.stringify({ id, name, says: saysEl.value.trim(), pose }) });
        mineId = id; nameEl.value = name;
        await loadLib(); drawLib();
        Media.toast(`“${name}” is in the pose library.`);
      } catch (err) { Media.toast(`Save: ${err.message}`); }
    }
    async function delMine(id) {
      const p = lib?.find(x => x.id === id); if (!p || !confirm(`Delete the pose “${p.name}” from the library?`)) return;
      try { await api(`/api/v2/poses/${id}`, { method: "DELETE" }); if (mineId === id) mineId = null; await loadLib(); drawLib(); }
      catch (err) { Media.toast(`Delete: ${err.message}`); }
    }

    saysEl.placeholder = kit.describePose(def) || "standing";
    setPart(part);
    rebuild();
    drawLib();
    loadLib().then(() => { if (box.isConnected) drawLib(); });
    return win;
  }

  let styled = false;
  function css() {
    if (styled) return; styled = true;
    const st = document.createElement("style");
    st.textContent = `
.pp { display: grid; grid-template-columns: 200px 1fr 270px; gap: 12px; height: 100%; min-height: 0; }
.pp-lib, .pp-side { overflow: auto; min-height: 0; }
.pp-lib h4 { margin: 4px 0 6px; font-size: 12px; }
.pp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 6px; margin-bottom: 10px; }
.pp-card { position: relative; }
.pp-card > button:first-child { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); color: var(--text); cursor: pointer; font-size: 11px; }
.pp-card > button:first-child:hover, .pp-card > button:first-child:focus-visible { border-color: var(--accent); }
.pp-card img { width: 72px; height: 96px; object-fit: contain; }
.pp-card span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-del { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; font-size: 10px; line-height: 1; opacity: 0; }
.pp-card:hover .pp-del, .pp-card:focus-within .pp-del { opacity: 1; }
@media (hover: none) { .pp-del { opacity: 1; } }
.pp-view { position: relative; min-height: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--bg); }
.pp-view canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.pp-ov { touch-action: none; outline: none; }
.pp-tip { position: absolute; left: 8px; right: 8px; bottom: 6px; margin: 0; pointer-events: none; }
.pp-parts { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.pp-parts .chip-btn.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
.pp-ctl { min-height: 150px; }
.pp-h { margin: 6px 0 2px; font-size: 12px; font-weight: 600; }
.pp-sl { display: grid; grid-template-columns: 86px 1fr 40px; align-items: center; gap: 6px; font-size: 12px; margin: 2px 0; }
.pp-sl output { text-align: right; font-variant-numeric: tabular-nums; }
.pp-row { display: flex; gap: 6px; margin: 10px 0; }
.pp-side textarea { width: 100%; resize: vertical; }
@media (max-width: 820px) { .pp { grid-template-columns: 1fr; grid-template-rows: auto minmax(280px, 50vh) auto; overflow: auto; } }
`;
    document.head.appendChild(st);
  }

  return { open };
})();
