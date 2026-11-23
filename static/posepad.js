/* 🤸 The pose editor: a big window for a Person in a 3D scene (scene3d.js), opened from its right-click menu or its
   panel (🤸 Edit pose…). The mannequin stands in its own 3D view with a dot on each joint:
     - drag a hand or a foot and the arm or leg follows it (the elbow or knee bends the way it already does),
     - drag an elbow or a knee to swing the upper arm or thigh (the forearm or shin keeps its bend),
     - drag the head to turn and nod it, the chest to bend and twist the body,
     - click a joint (shoulder, elbow, hip, knee, head, chest) for its X, Y and Z rings: drag a ring to turn it about
       that axis (the figure's own: X across, Y up, Z forward),
     - drag anywhere else to turn the view; the wheel zooms. ↶ Undo and ↷ Redo (Ctrl+Z, Ctrl+Y) step through changes.
   Beside it, sliders for the selected part (head, body, each arm and leg, the hands), Mirror and Reset, its name and the
   words the photo and video models are told (made from the pose when left empty). On the left the pose library: the
   presets and the poses you saved (data/v2/poses.json, every project). Apply keys it on the Person at the playhead.

   🎬 Movements (the other tab): short runs of poses (sit down, jump, wave, bow, turn around…), each step with how far
   the person rises (a share of their height) and turns. One plays in the view, looping; its length is a slider, and
   🎬 Add keys it on the Person from the playhead (Scene3D addMovement). The Person's own keyed poses can be saved as a
   movement (data/v2/moves.json, every project).

   ⬆ Import (poseimport.js): a BVH, a glTF animation or OpenPose keypoints, as a pose (one frame) or a movement to play,
   add, save, or take a moment of as a pose.

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

  /* The movements: steps { f (0 to 1 through it), pose (a preset's name or a pose), lift, turn }. Their in-between
     poses have names and words, as the photo and video models are told about them ("crouching, then sitting"). */
  const same = a => ({ R: a, L: a });
  const CROUCH = { label: "Crouching", says: "crouching", spine: [28, 0, 0], arms: same([[0.1, -0.75, 0.65], [0.05, -0.3, 0.95]]), legs: same([[0.05, -0.5, 0.86], [0, -0.88, -0.48]]) };
  const TUCK = { label: "Jumping", says: "in the air, jumping", spine: [8, 0, 0], arms: same([[0.35, 0.9, 0.25], [0.15, 1, 0.1]]), legs: same([[0.05, -0.35, 0.94], [0, -0.95, -0.3]]) };
  const WAVE2 = { label: "Waving", says: "waving with the right hand", arms: { R: [[1, 0.25, 0.1], [-0.45, 0.9, 0.15]] }, hands: { R: "open", L: "relaxed" } };
  const WAVE1 = { label: "Waving", says: "waving with the right hand", arms: { R: [[1, 0.25, 0.1], [0.35, 1, 0.15]] }, hands: { R: "open", L: "relaxed" } };
  const BOW = { label: "Bowing", says: "bowing", spine: [55, 0, 0], head: [0, 15, 0] };
  const NOD_D = { label: "Nodding", says: "nodding", head: [0, 22, 0] }, NOD_U = { label: "Nodding", says: "nodding", head: [0, -6, 0] };
  const SHAKE_L = { label: "Shaking their head", says: "shaking their head", head: [35, 0, 0] }, SHAKE_R = { label: "Shaking their head", says: "shaking their head", head: [-35, 0, 0] };
  const LOOK_L = { label: "Looking left", says: "looking to their left", head: [60, 0, 0], spine: [0, 0, 15] }, LOOK_R = { label: "Looking right", says: "looking to their right", head: [-60, 0, 0], spine: [0, 0, -15] };
  const CLAP_IN = { label: "Clapping", says: "clapping", arms: same([[0.15, -0.6, 0.8], [-0.8, 0.05, 0.6]]), hands: same("open") };
  const CLAP_OUT = { label: "Clapping", says: "clapping", arms: same([[0.2, -0.6, 0.78], [0.25, 0.05, 0.97]]), hands: same("open") };
  const STRETCH = { label: "Stretching", says: "stretching with both arms up", spine: [-10, 0, 0], head: [0, -15, 0], arms: same([[0.3, 1, 0.05], [0.1, 1, 0]]), hands: same("open") };
  const st = (f, pose, x = {}) => ({ f, pose, ...x });
  const MOVES = [
    { id: "sit", name: "Sit down", seconds: 1.6, steps: [st(0, "standing"), st(0.5, CROUCH), st(1, "sitting")] },
    { id: "stand", name: "Stand up", seconds: 1.6, steps: [st(0, "sitting"), st(0.5, CROUCH), st(1, "standing")] },
    { id: "wave", name: "Wave hello", seconds: 2.4, steps: [st(0, "standing"), st(0.2, WAVE1), st(0.36, WAVE2), st(0.52, WAVE1), st(0.68, WAVE2), st(0.84, WAVE1), st(1, "standing")] },
    { id: "jump", name: "Jump", seconds: 1.3, steps: [st(0, "standing", { lift: 0 }), st(0.28, CROUCH, { lift: 0 }), st(0.5, TUCK, { lift: 0.25 }), st(0.72, CROUCH, { lift: 0 }), st(1, "standing", { lift: 0 })] },
    { id: "bow", name: "Bow", seconds: 2.2, steps: [st(0, "standing"), st(0.35, BOW), st(0.65, BOW), st(1, "standing")] },
    { id: "turn", name: "Turn around", seconds: 1.6, steps: [st(0, "standing", { turn: 0 }), st(0.5, "walking", { turn: 90 }), st(1, "standing", { turn: 180 })] },
    { id: "nod", name: "Nod yes", seconds: 1.2, steps: [st(0, "standing"), st(0.25, NOD_D), st(0.5, NOD_U), st(0.75, NOD_D), st(1, "standing")] },
    { id: "shake", name: "Shake head no", seconds: 1.4, steps: [st(0, "standing"), st(0.25, SHAKE_L), st(0.5, SHAKE_R), st(0.75, SHAKE_L), st(1, "standing")] },
    { id: "look", name: "Look around", seconds: 3, steps: [st(0, "standing"), st(0.25, LOOK_L), st(0.45, LOOK_L), st(0.7, LOOK_R), st(0.85, LOOK_R), st(1, "standing")] },
    { id: "point", name: "Point", seconds: 1.6, steps: [st(0, "standing"), st(0.4, "pointing"), st(1, "pointing")] },
    { id: "clap", name: "Clap", seconds: 1.8, steps: [st(0, "standing"), st(0.15, CLAP_OUT), st(0.3, CLAP_IN), st(0.45, CLAP_OUT), st(0.6, CLAP_IN), st(0.75, CLAP_OUT), st(1, "standing")] },
    { id: "kneel", name: "Kneel down", seconds: 2, steps: [st(0, "standing"), st(0.45, CROUCH), st(1, "kneeling")] },
    { id: "stretch", name: "Stretch", seconds: 2.4, steps: [st(0, "standing"), st(0.45, STRETCH), st(0.65, STRETCH), st(1, "standing")] },
  ];
  let moves = null;  // the saved movements [{ id, name, seconds, steps }]
  async function loadMoves() {
    try { moves = (await api("/api/v2/moves")).moves || []; } catch { moves = []; }
    moves.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  // a movement's pose at f (0 to 1): its steps' poses blended as the scene does, and how far up and turned
  function moveAt(kit, m, f) {
    const S = m.steps, pose = x => kit.completePose(typeof x.pose === "string" ? kit.POSES[x.pose] || kit.POSES.standing : x.pose);
    let i = 0; while (i < S.length - 1 && S[i + 1].f <= f) i++;
    const a = S[i], b = S[Math.min(i + 1, S.length - 1)], u0 = b.f > a.f ? clamp((f - a.f) / (b.f - a.f), 0, 1) : 0, u = a.lin ? u0 : u0 * u0 * (3 - 2 * u0);
    const lerp = (x, y) => (+x || 0) + ((+y || 0) - (+x || 0)) * u;
    return { pose: kit.mixPose(pose(a), pose(b), u), lift: lerp(a.lift, b.lift), turn: lerp(a.turn, b.turn) };
  }
  const stepName = (kit, x) => typeof x.pose === "string" ? kit.POSES[x.pose]?.label || x.pose : x.pose?.label || "Custom pose";

  function open(o) {
    const kit = Scene3D.poseKit, G = Model3D.gl;
    css();
    let def = kit.completePose(o.def), preset = o.preset || null, mineId = null, part = "armR", mesh = null;
    const cam = { yaw: 28, pitch: 8, dist: 3.7 };
    const box = document.createElement("div");
    box.className = "pp";
    const who = html(o.who || "Person"), keyed = o.keyed;
    box.innerHTML = `<div class="pp-lib"><div class="pp-tabs" role="tablist"><button type="button" class="chip-btn" role="tab" data-tab="poses">🧍 Poses</button><button type="button" class="chip-btn" role="tab" data-tab="moves">🎬 Movements</button></div>
        <button type="button" class="btn sm pp-imp" data-a="import" title="A BVH (motion capture), a glTF animation (.glb) or OpenPose keypoints (.json): one frame comes in as a pose, more as a movement">⬆ Import…</button>
        <input type="file" class="pp-file" accept=".bvh,.glb,.gltf,.bin,.json,.fbx" multiple hidden>
        <div class="pp-libposes"><h4>Poses</h4><div class="pp-grid" data-g="pre"></div><h4>Saved <span class="opt">every project</span></h4><div class="pp-grid" data-g="mine"><p class="hint">Loading…</p></div></div>
        <div class="pp-libmoves" hidden><h4>Movements</h4><div class="pp-grid" data-g="mvpre"></div><h4>Saved <span class="opt">every project</span></h4><div class="pp-grid" data-g="mvmine"><p class="hint">Loading…</p></div></div></div>
      <div class="pp-view"><canvas class="pp-gl"></canvas><canvas class="pp-ov" tabindex="0" aria-label="The pose: drag a joint's dot to move it, elsewhere to turn the view"></canvas>
        <p class="hint pp-tip"></p></div>
      <div class="pp-side"><div class="pp-moveside" hidden>
        <h4 class="pp-mvname">Pick a movement on the left</h4><p class="hint pp-mvsteps"></p>
        <label class="pp-sl"><span>Length</span><input type="range" data-len min="0.3" max="10" step="0.1" value="1.6"><output></output></label>
        <p class="hint pp-room"></p>
        <div class="pp-row"><button type="button" class="btn sm" data-a="play">⏸ Pause</button><span class="hint pp-mvt"></span></div>
        <div class="pp-row"><button type="button" class="btn sm ghost" data-a="moment" title="Pause where you want it, then take that moment into the pose editor">🤸 This moment as a pose</button></div>
        <div class="pp-imported" hidden><div class="field pp-anim" hidden><label for="pp-anim">Animation</label><select id="pp-anim"></select></div>
          <p class="hint pp-impnote"></p>
          <div class="field"><label for="pp-impname">Name</label><input id="pp-impname" maxlength="60"></div>
          <button type="button" class="btn sm" data-a="saveimp" title="Keep it in the movement library, for every project">💾 Save to the library</button></div>
        <hr class="pp-hr">
        <div class="field"><label for="pp-mvnew">${who}'s keyed poses as a movement</label><input id="pp-mvnew" maxlength="60" placeholder="My movement"${keyed ? "" : " disabled"}></div>
        <button type="button" class="btn sm" data-a="savemove"${keyed ? "" : " disabled"}>💾 Save as a movement</button>
        <p class="hint">${keyed ? `${keyed.steps.length} poses over ${keyed.seconds.toFixed(2)} s (with how far ${who} rises and turns), kept for every project.`
          : `Key two or more poses on ${who} (🤸 Edit pose at different times) to keep them as a movement.`}</p></div>
        <div class="pp-poseside"><div class="pp-parts">${PARTS.map(([k, t]) => `<button type="button" class="chip-btn" data-part="${k}">${t}</button>`).join("")}</div>
        <div class="pp-ctl"></div>
        <div class="pp-row"><button type="button" class="btn sm ghost" data-a="undo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button><button type="button" class="btn sm ghost" data-a="redo" title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
          <button type="button" class="btn sm" data-a="mirror" title="Swap left and right">⇋ Mirror</button><button type="button" class="btn sm ghost" data-a="reset" title="Back to standing">↺ Standing</button></div>
        <div class="field"><label for="pp-name">Name</label><input id="pp-name" maxlength="60" placeholder="Custom pose"></div>
        <div class="field"><label for="pp-says">Described as <span class="opt">what the photo and video models are told</span></label><textarea id="pp-says" rows="3" maxlength="200"></textarea></div>
        <button type="button" class="btn sm" data-a="save" title="Keep it in the pose library, for every project">💾 Save to the library</button></div></div>`;
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
    let mode = "poses", mv = null, sec = 1.6, playing = true, t0 = performance.now(), pausedAt = 0;
    const mvMeshes = new Map();  // the playing movement's mesh at each 60th of it
    const ro = new ResizeObserver(() => redraw());
    const win = WM.open({ id: "posepad", title: `🤸 Pose · ${o.who || "Person"}`, content: box, footer: foot, width: 1080, height: 700, minWidth: 760, minHeight: 520, modal: true,
      onClose: () => { ro.disconnect(); cancelAnimationFrame(raf); if (mesh) gpu?.drop(mesh); dropMoveMeshes(); gl?.getExtension("WEBGL_lose_context")?.loseContext(); } });
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
    // a pose's mesh; dy stands it on the floor (its lowest point), as the scene does
    function meshOf(d) {
      const { P, N, I } = kit.shapeOf("figure", d);
      let lo = Infinity; for (let i = 1; i < P.length; i += 3) lo = Math.min(lo, P[i]);
      const m = gpu.upload([{ pos: new Float32Array(P), nrm: new Float32Array(N), uv: null, col: null, idx: new Uint32Array(I), base, tex: null, ao: null }]);
      m.dy = -lo;
      return m;
    }
    const floorY = () => mesh?.dy || 0, lifted = p => [p[0], p[1] + floorY(), p[2]];
    const MT = (y, turn = 0) => { const c = Math.cos(turn * rad), s = Math.sin(turn * rad); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, y, 0, 1]; };
    function dropMoveMeshes() { for (const m of mvMeshes.values()) gpu?.drop(m); mvMeshes.clear(); }
    function rebuild() { if (!gpu) return; if (mesh) gpu.drop(mesh); mesh = meshOf(def); redraw(); }
    function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); }
    function paint(now = performance.now()) {
      const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(view.clientWidth * dpr), H = Math.round(view.clientHeight * dpr);
      for (const c of [cv, ov]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const C = camera(), x = ov.getContext("2d");
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
      if (mode === "moves") return paintMove(C, W, H, now);
      if (gpu && mesh) {
        gpu.begin(W, H, G.themeBg(view));
        gpu.draw(mesh, { VP: C.VP, M: MT(floorY()), eye: C.eye, key: [0.45, 0.9, 0.7], look: 0 });
        gpu.lines(GRID, C.VP, [0.5, 0.5, 0.5, 0.45]);
      }
      // the joints' dots and the bones between them
      const cs = getComputedStyle(box), acc = cs.getPropertyValue("--accent").trim() || "#4f8cff";
      const hs = handles(C);
      x.lineWidth = 1.5; x.strokeStyle = "rgba(120,120,120,0.55)";
      const J = kit.figureJoints(def), seg = (a, b) => { const p = toScreen(C, lifted(a)), q = toScreen(C, lifted(b)); x.beginPath(); x.moveTo(...p); x.lineTo(...q); x.stroke(); };
      seg(J.head, J.neck); seg(J.neck, J.chest); seg(J.chest, J.waist);
      for (const sd of ["R", "L"]) { const a = J.arms[sd], l = J.legs[sd]; seg(J.neck, a.sh); seg(a.sh, a.el); seg(a.el, a.wr); seg(J.waist, l.hp); seg(l.hp, l.kn); seg(l.kn, l.an); }
      for (const h of hs) {
        const on = h.part === part || (part === "hands" && h.kind === "hand"), picked = sameJ(h, selJ);
        x.beginPath(); x.arc(h.s[0], h.s[1], picked ? 8 : on ? 7 : 5.5, 0, 2 * Math.PI);
        x.fillStyle = on || picked ? acc : "rgba(255,255,255,0.9)"; x.fill(); x.lineWidth = picked ? 3 : 2; x.strokeStyle = on || picked ? "#fff" : "rgba(0,0,0,0.6)"; x.stroke();
      }
      drawRings(C, x);
    }
    // the movement playing, looping (a moment's hold at its end)
    function paintMove(C, W, H, now) {
      if (!gpu) return;
      gpu.begin(W, H, G.themeBg(view));
      if (mv) {
        const ph = playing ? ((now - t0) / 1000) % (sec + 0.7) : pausedAt, f = clamp(ph / sec, 0, 1), q = Math.round(f * 60) / 60;
        let m = mvMeshes.get(q);
        if (!m) { const A = moveAt(kit, mv, q); m = meshOf(A.pose); m.lift = A.lift; m.turn = A.turn; mvMeshes.set(q, m); }
        gpu.draw(m, { VP: C.VP, M: MT(m.dy + m.lift * 1.74, m.turn), eye: C.eye, key: [0.45, 0.9, 0.7], look: 0 });
        $(".pp-mvt").textContent = `${Math.min(ph, sec).toFixed(2)} / ${sec.toFixed(2)} s`;
        if (playing) raf = requestAnimationFrame(paint);
      }
      gpu.lines(GRID, C.VP, [0.5, 0.5, 0.5, 0.45]);
    }
    // the dots: { part, kind, p (3D), s (on screen) }; none while a movement plays
    function handles(C = camera()) {
      if (mode === "moves") return [];
      const J = kit.figureJoints(def), out = [{ part: "head", kind: "head", p: J.head }, { part: "body", kind: "chest", p: J.chest }];
      for (const sd of ["R", "L"]) {
        out.push({ part: `arm${sd}`, kind: "sh", sd, p: J.arms[sd].sh }, { part: `arm${sd}`, kind: "elbow", sd, p: J.arms[sd].el }, { part: `arm${sd}`, kind: "hand", sd, p: J.arms[sd].wr },
          { part: `leg${sd}`, kind: "hp", sd, p: J.legs[sd].hp }, { part: `leg${sd}`, kind: "knee", sd, p: J.legs[sd].kn }, { part: `leg${sd}`, kind: "foot", sd, p: J.legs[sd].an });
      }
      for (const h of out) { h.p = lifted(h.p); h.s = toScreen(C, h.p); }
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
      if (t.hasAttribute("data-len")) { sec = +t.value; t0 = performance.now(); return moveInfo(); }
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
      if (t.dataset.k != null) remember();
      else if (t.dataset.hand) { def.hands[t.dataset.hand] = t.value; changed(); remember(); }
      else if (t.hasAttribute("data-kneel")) { const { g, sd } = limbOf(part), L = def[g][sd]; L.length = 2; if (t.checked) L.push("back"); changed(); remember(); }
      else if (t === nameEl || t === saysEl) { preset = null; if (t === nameEl) autoName = false; }
    });
    box.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.part) return setPart(b.dataset.part);
      if (b.dataset.pre) return loadPose(kit.POSES[b.dataset.pre], b.dataset.pre);
      if (b.dataset.mine) { const p = lib?.find(x => x.id === b.dataset.mine); if (p) loadPose(p.pose, null, p); return; }
      if (b.dataset.del) return delMine(b.dataset.del);
      if (b.dataset.tab) return setMode(b.dataset.tab);
      if (b.dataset.mv) return pickMove(MOVES.find(m => m.id === b.dataset.mv));
      if (b.dataset.mvmine) return pickMove(moves?.find(m => m.id === b.dataset.mvmine));
      if (b.dataset.delmv) return delMove(b.dataset.delmv);
      const a = b.dataset.a;
      if (a === "play") {
        const now = performance.now();
        if (playing) pausedAt = ((now - t0) / 1000) % (sec + 0.7); else t0 = now - pausedAt * 1000;
        playing = !playing; b.textContent = playing ? "⏸ Pause" : "▶ Play"; return redraw();
      }
      if (a === "savemove") return saveMove();
      if (a === "import") return $(".pp-file").click();
      if (a === "saveimp") return saveImported();
      if (a === "moment") {
        if (!mv) return;
        const ph = playing ? ((performance.now() - t0) / 1000) % (sec + 0.7) : pausedAt, f = clamp(ph / sec, 0, 1), name = `${mv.name} at ${(f * sec).toFixed(2)} s`;
        loadPose(moveAt(kit, mv, f).pose); nameEl.value = name; autoName = false; setMode("poses");
        return;
      }
      if (a === "undo") return undo();
      if (a === "redo") return redo();
      if (a === "mirror") {
        const m = def;
        def = { arms: { R: m.arms.L, L: m.arms.R }, legs: { R: m.legs.L, L: m.legs.R }, spine: [m.spine[0], -m.spine[1], -m.spine[2]], head: [-m.head[0], m.head[1], -m.head[2]], hands: { R: m.hands.L, L: m.hands.R } };
        if (/^(arm|leg)[RL]$/.test(part)) part = part.slice(0, 3) + (part[3] === "R" ? "L" : "R");
        setPart(part); changed(true); remember();
      }
      if (a === "reset") { def = kit.completePose(kit.POSES.standing); changed(true); remember(); }
      if (a === "save") saveMine();
    });
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="apply"]').onclick = () => {
      if (mode === "moves") {
        if (!mv) return;
        if (o.onMove?.({ name: mv.name, steps: mv.steps }, sec)) win.close();
        return;
      }
      const label = nameEl.value.trim(), says = saysEl.value.trim();
      o.onApply?.({ preset, def: { ...def, label: label || "Custom pose", says } });
      win.close();
    };

    /* ---- dragging in the view: a joint's dot (move it), its rings (turn it), or the view (turn it) */
    let drag = null, selJ = null, hoverRing = -1;  // selJ: the joint clicked { kind, sd }, whose rings show
    const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], AXIS_COL = ["#e5484d", "#46a758", "#3e63dd"], AXIS_NAME = ["X", "Y", "Z"];
    const RING = { head: 0.16, chest: 0.24, sh: 0.13, elbow: 0.11, hp: 0.15, knee: 0.12 };  // the joints that turn: their rings' radius (m)
    const sameJ = (a, b) => !!a && !!b && a.kind === b.kind && a.sd === b.sd;
    const at = e => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function rayTo(C, m, Q) {  // the point under the mouse on the plane through Q facing the view
      const th = Math.tan(FOV / 2), nx = m[0] / C.W * 2 - 1, ny = 1 - m[1] / C.H * 2;
      const d = norm(add(C.f, add(mul(C.r, nx * th * C.W / C.H), mul(C.u, ny * th))));
      const k = dot(sub(Q, C.eye), C.f) / (dot(d, C.f) || 1e-6);
      return add(C.eye, mul(d, k));
    }
    // the selected joint's rings on screen: [{ axis, pts, c (its centre) }]
    function rings(C = camera()) {
      if (!selJ || !RING[selJ.kind] || mode === "moves") return [];
      const h = handles(C).find(x => sameJ(x, selJ)); if (!h) return [];
      // its size on the figure, but never under 48 px on screen (zoomed out, or a small joint)
      const ppm = Math.hypot(...sub(toScreen(C, add(h.p, mul(C.r, 0.1))), h.s).slice(0, 2)) / 0.1 || 1, r = Math.max(RING[selJ.kind], 48 / ppm);
      return AXES.map((_, k) => {
        const e1 = AXES[(k + 1) % 3], e2 = AXES[(k + 2) % 3], pts = [];
        for (let i = 0; i <= 48; i++) { const t = i / 48 * 2 * Math.PI; pts.push(toScreen(C, add(h.p, add(mul(e1, r * Math.cos(t)), mul(e2, r * Math.sin(t)))))); }
        return { axis: k, pts, c: h.s };
      });
    }
    const segDist = (m, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], u = clamp(((m[0] - a[0]) * vx + (m[1] - a[1]) * vy) / (vx * vx + vy * vy || 1), 0, 1); return Math.hypot(m[0] - a[0] - u * vx, m[1] - a[1] - u * vy); };
    function ringAt(m, C) {
      let best = -1, bd = 7;
      for (const R of rings(C)) for (let i = 1; i < R.pts.length; i++) { const d = segDist(m, R.pts[i - 1], R.pts[i]); if (d < bd) { bd = d; best = R.axis; } }
      return best;
    }
    function drawRings(C, x) {
      for (const R of rings(C)) {
        const on = (drag?.ring ? drag.axis : hoverRing) === R.axis;
        x.beginPath(); R.pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])));
        x.lineWidth = on ? 4 : 2.5; x.strokeStyle = AXIS_COL[R.axis]; x.globalAlpha = on ? 1 : 0.8; x.stroke(); x.globalAlpha = 1;
      }
      if (drag?.ring) {  // how far it's turned, by the mouse
        const t = `${AXIS_NAME[drag.axis]} ${drag.turn >= 0 ? "+" : ""}${Math.round(drag.turn)}°`;
        x.font = "600 12px system-ui, sans-serif"; x.lineWidth = 3; x.strokeStyle = "rgba(0,0,0,0.75)"; x.fillStyle = "#fff";
        x.strokeText(t, drag.now[0] + 14, drag.now[1] - 10); x.fillText(t, drag.now[0] + 14, drag.now[1] - 10);
      }
    }
    // v turned by th (radians) about the unit axis a
    const turnAbout = (v, a, th) => { const c = Math.cos(th), s2 = Math.sin(th); return norm(add(add(mul(v, c), mul(cross(a, v), s2)), mul(a, dot(a, v) * (1 - c)))); };
    /* The pose d0 with joint j turned by deg about the figure's axis k (X across, Y up, Z forward). A shoulder or hip
       turns its whole arm or leg, an elbow or knee the forearm or shin; the head and chest change their angles
       (head [turn, nod, tilt], spine [bend, lean, twist]: X nods or bends, Y turns or twists, Z tilts or leans). */
    const ANG = { head: { g: "head", map: [[1, 1], [0, 1], [2, -1]], lim: [[-80, 80], [-40, 60], [-40, 40]] },
      chest: { g: "spine", map: [[0, 1], [2, 1], [1, -1]], lim: [[-30, 90], [-40, 40], [-60, 60]] } };
    function turnJoint(d0, j, k, turn) {
      const d = JSON.parse(JSON.stringify(d0));
      if (ANG[j.kind]) {
        const A = ANG[j.kind], [i, sg] = A.map[k];
        d[A.g][i] = clamp(d0[A.g][i] + sg * turn, ...A.lim[i]);
        return d;
      }
      const arm = j.kind === "sh" || j.kind === "elbow", g = arm ? "arms" : "legs", sx = sideX(j.sd), L = d[g][j.sd];
      const S = arm ? kit.figureJoints(d0).S : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const toBody = v => app3(S, flipX(v, sx)), fromBody = v => flipX(app3(tr(S), v), sx), R = v => turnAbout(v, AXES[k], turn * rad);
      const whole = j.kind === "sh" || j.kind === "hp";
      d[g][j.sd] = [whole ? fromBody(R(toBody(L[0]))) : L[0], fromBody(R(toBody(L[1]))), ...(L[2] ? [L[2]] : [])];
      return d;
    }
    ov.addEventListener("pointerdown", e => {
      const m = at(e), C = camera();
      ov.setPointerCapture(e.pointerId);
      const k = ringAt(m, C);
      if (k >= 0) {
        const c = rings(C)[0].c;
        drag = { ring: true, axis: k, j: { ...selJ }, c, a0: Math.atan2(m[1] - c[1], m[0] - c[0]), acc: 0, m, now: m, turn: 0, facing: dot(AXES[k], C.f), def0: JSON.parse(JSON.stringify(def)) };
        return;
      }
      const h = handles(C).map(x => ({ ...x, d: Math.hypot(x.s[0] - m[0], x.s[1] - m[1]) })).filter(x => x.d < 14).sort((a, b) => a.d - b.d)[0];
      if (h) {
        selJ = { kind: h.kind, sd: h.sd };
        if (h.part !== part && !(part === "hands" && h.kind === "hand")) setPart(h.part);
        drag = { h, Q: h.p, m, def0: JSON.parse(JSON.stringify(def)) };
        redraw();
      } else drag = { orbit: true, m, yaw: cam.yaw, pitch: cam.pitch };
    });
    ov.addEventListener("pointermove", e => {
      const m = at(e);
      if (!drag) {
        const C = camera(), k = ringAt(m, C);
        if (k !== hoverRing) { hoverRing = k; redraw(); }
        ov.style.cursor = k >= 0 || handles(C).some(x => Math.hypot(x.s[0] - m[0], x.s[1] - m[1]) < 14) ? "grab" : "default";
        return;
      }
      const mx = m[0] - drag.m[0], my = m[1] - drag.m[1];
      if (drag.orbit) { cam.yaw = drag.yaw - mx * 0.4; cam.pitch = clamp(drag.pitch + my * 0.3, -20, 80); return redraw(); }
      if (drag.ring) {
        // round the joint on screen; a ring seen edge on turns with the mouse going sideways
        const a = Math.atan2(m[1] - drag.c[1], m[0] - drag.c[0]);
        let da = a - drag.a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        drag.acc += da; drag.a0 = a; drag.now = m;
        drag.turn = Math.abs(drag.facing) > 0.15 ? drag.acc * deg * Math.sign(drag.facing) : mx * 0.5;
        def = turnJoint(drag.def0, drag.j, drag.axis, drag.turn);
        return changed(true);
      }
      const h = drag.h, C = camera(), face = Math.cos(cam.yaw * rad) >= 0 ? 1 : -1;
      if (h.kind === "sh" || h.kind === "hp") return;  // a shoulder or hip turns by its rings
      if (h.kind === "head") { def.head[0] = clamp(drag.def0.head[0] + mx * 0.4 * face, -80, 80); def.head[1] = clamp(drag.def0.head[1] + my * 0.4, -40, 60); return changed(true); }
      if (h.kind === "chest") { def.spine[2] = clamp(drag.def0.spine[2] + mx * 0.3 * face, -60, 60); def.spine[0] = clamp(drag.def0.spine[0] + my * 0.3, -30, 90); return changed(true); }
      const p = rayTo(C, m, drag.Q), sd = h.sd, sx = sideX(sd), arm = h.kind === "elbow" || h.kind === "hand";
      const J = kit.figureJoints(def), S = arm ? J.S : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const local = q => add(kit.WAIST, app3(tr(S), sub(q, kit.WAIST)));  // the body's frame (the upper body unturned)
      const g = arm ? "arms" : "legs", L = def[g][sd], root = arm ? [sx * 0.2, 1.41, 0] : [sx * 0.09, 0.9, 0], lens = arm ? kit.ARM : kit.LEG;
      const u0 = flipX(L[0], sx), l0 = flipX(L[1], sx), t = local([p[0], p[1] - floorY(), p[2]]);
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
    const end = () => { const was = drag; drag = null; if (was && !was.orbit) remember(); redraw(); };
    ov.addEventListener("pointerup", end); ov.addEventListener("pointercancel", end);
    ov.addEventListener("wheel", e => { e.preventDefault(); cam.dist = clamp(cam.dist * (e.deltaY > 0 ? 1.1 : 1 / 1.1), 1.2, 8); redraw(); }, { passive: false });
    ov.addEventListener("contextmenu", e => e.preventDefault());

    /* ---- undo and redo: the pose after each change (a drag, a slider let go, a preset, Mirror…) */
    const hist = { past: [], future: [] };
    let kept = JSON.stringify(def);
    function remember() {
      const now = JSON.stringify(def); if (now === kept) return;
      hist.past.push(kept); if (hist.past.length > 100) hist.past.shift();
      hist.future = []; kept = now; histBtns();
    }
    function stepTo(json) {
      def = JSON.parse(json); kept = json; preset = null;
      saysEl.placeholder = kit.describePose(def) || "standing";
      rebuild(); fillCtl(); histBtns();
    }
    function undo() { if (!hist.past.length) return; hist.future.push(kept); stepTo(hist.past.pop()); }
    function redo() { if (!hist.future.length) return; hist.past.push(kept); stepTo(hist.future.pop()); }
    function histBtns() { box.querySelector('[data-a="undo"]').disabled = !hist.past.length; box.querySelector('[data-a="redo"]').disabled = !hist.future.length; }
    // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, except while typing in the name or the words
    box.closest(".wm-win")?.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || mode !== "poses") return;
      if (e.target.matches?.("input:not([type=range]):not([type=checkbox]), textarea")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    });

    /* ---- the library */
    function loadPose(p, presetName = null, mine = null) {
      def = kit.completePose(p);
      preset = presetName; mineId = mine?.id || null;
      nameEl.value = mine?.name || (presetName ? kit.POSES[presetName]?.label || "" : "");
      autoName = !!presetName;
      saysEl.value = mine ? mine.says || "" : "";
      saysEl.placeholder = kit.describePose(def) || "standing";
      rebuild(); fillCtl(); remember();
    }
    function thumb(p) {
      const key = JSON.stringify(kit.completePose(p));
      if (thumbs.has(key)) return thumbs.get(key);
      if (!gpu) return "";
      const W = 72, H = 96, m = meshOf(p), eye = [1.15, 1.25, 2.9], T = [0, 0.86, 0];
      const VP = G.mul4(G.perspective(32 * rad, W / H, 0.05, 50), G.lookAt(eye, T, [0, 1, 0]));
      const px = gpu.capture(W, H, draw => draw(m, { VP, M: MT(m.dy), eye, key: [0.45, 0.9, 0.7], look: 0 }));
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
    // a movement's card shows it halfway through
    const mvCard = (m, attr, del = "") => { const A = moveAt(kit, m, 0.5);
      return card(attr, `${m.name} · ${(+m.seconds).toFixed(1)} s`, A.pose, del); };
    function drawMoves() {
      $('[data-g="mvpre"]').innerHTML = MOVES.map(m => mvCard(m, `data-mv="${m.id}"`)).join("");
      $('[data-g="mvmine"]').innerHTML = moves?.length ? moves.map(m => mvCard(m, `data-mvmine="${html(m.id)}"`, `<button type="button" class="pp-del" data-delmv="${html(m.id)}" aria-label="Delete ${html(m.name)}" title="Delete">✕</button>`)).join("")
        : `<p class="hint">${moves ? "None yet: key poses on a Person, then 💾 Save as a movement." : "Loading…"}</p>`;
      box.querySelectorAll("[data-mv], [data-mvmine]").forEach(b => b.classList.toggle("on", !!mv && (b.dataset.mv || b.dataset.mvmine) === mv.id));
    }
    function setMode(m) {
      mode = m;
      box.querySelectorAll("[data-tab]").forEach(b => { b.classList.toggle("on", b.dataset.tab === m); b.setAttribute("aria-selected", String(b.dataset.tab === m)); });
      $(".pp-libposes").hidden = $(".pp-poseside").hidden = m !== "poses";
      $(".pp-libmoves").hidden = $(".pp-moveside").hidden = m !== "moves";
      $(".pp-tip").textContent = m === "moves" ? "Drag to turn the view; the wheel zooms." : "Drag a dot: hands and feet pull the arm or leg, elbows and knees swing it. Click a joint for its X, Y, Z rings and drag one to turn it. Drag elsewhere to turn the view.";
      if (m === "moves" && !moves) loadMoves().then(() => { if (box.isConnected) drawMoves(); });
      if (m === "moves") drawMoves();
      footInfo(); t0 = performance.now(); redraw();
    }
    function pickMove(m) {
      if (!m) return;
      mv = { ...m, steps: [...m.steps].sort((a, b) => a.f - b.f) };
      sec = clamp(+m.seconds || 1.6, 0.3, 10); t0 = performance.now(); playing = true; $('[data-a="play"]').textContent = "⏸ Pause";
      dropMoveMeshes();
      $('[data-len]').value = String(sec);
      $(".pp-mvname").textContent = m.name;
      $(".pp-imported").hidden = !m.imported;
      const names = mv.steps.map(x => stepName(kit, x)).filter((n, i, a) => i === 0 || n !== a[i - 1]);
      $(".pp-mvsteps").textContent = names.join(" → ");
      moveInfo(); drawMoves(); footInfo(); redraw();
    }
    function moveInfo() {
      $('[data-len]').nextElementSibling.textContent = `${sec.toFixed(1)} s`;
      const room = +o.room || 0;
      $(".pp-room").textContent = !mv ? "" : sec > room + 1e-6 ? `Only ${room.toFixed(2)} s are left in the shot after the playhead: it's cut short there.` : `From ${(+o.at || 0).toFixed(2)} to ${((+o.at || 0) + sec).toFixed(2)} s.`;
    }
    function footInfo() {
      const ap = foot.querySelector('[data-a="apply"]'), h = foot.querySelector(".hint"), t = (+o.at || 0).toFixed(2);
      if (mode === "moves") { ap.textContent = `🎬 Add at ${t} s`; ap.disabled = !mv; h.textContent = `${o.who || "Person"} does it from ${t} s: its poses are keyed, and keys already inside it lose theirs.`; }
      else { ap.textContent = "🤸 Apply"; ap.disabled = false; h.textContent = `${o.who || "Person"} at ${t} s: applying it keys the pose there.`; }
    }
    async function saveMove() {
      if (!keyed) return;
      const name = $("#pp-mvnew").value.trim() || "My movement", id = uid();
      try {
        await api(`/api/v2/moves/${id}`, { method: "PUT", body: JSON.stringify({ id, name, seconds: keyed.seconds, steps: keyed.steps }) });
        await loadMoves(); drawMoves(); pickMove(moves.find(m => m.id === id));
        Media.toast(`“${name}” is in the movement library.`);
      } catch (err) { Media.toast(`Save: ${err.message}`); }
    }
    async function delMove(id) {
      const m = moves?.find(x => x.id === id); if (!m || !confirm(`Delete the movement “${m.name}” from the library?`)) return;
      try { await api(`/api/v2/moves/${id}`, { method: "DELETE" }); if (mv?.id === id) { mv = null; $(".pp-mvname").textContent = "Pick a movement on the left"; $(".pp-mvsteps").textContent = ""; moveInfo(); footInfo(); } await loadMoves(); drawMoves(); }
      catch (err) { Media.toast(`Delete: ${err.message}`); }
    }
    $(".pp-file").addEventListener("change", async e => {
      const files = [...e.target.files]; e.target.value = "";
      if (!files.length) return;
      try { took(await PoseImport.read(files)); } catch (err) { Media.toast(`Import: ${err.message}`, 9000); }
    });
    $("#pp-anim").addEventListener("change", e => { if (mv?.take) { try { took({ ...mv.take(+e.target.value), anims: mv.anims, take: mv.take }, +e.target.value); } catch (err) { Media.toast(`Import: ${err.message}`); } } });
    // an import: a pose goes into the editor, a movement plays (to add, save, or take a moment of)
    function took(r, animIdx = 0) {
      if (r.kind === "pose") {
        loadPose(r.def); nameEl.value = r.name; autoName = false; setMode("poses");
        return Media.toast(`${r.name}: imported as a pose. Adjust it if it needs it, then Apply or Save.`);
      }
      setMode("moves");
      pickMove({ ...r, id: "import", imported: true });
      $("#pp-impname").value = r.name;
      const sel = $("#pp-anim");
      $(".pp-anim").hidden = !(r.anims?.length > 1);
      if (r.anims?.length > 1) { sel.innerHTML = r.anims.map((n, k) => `<option value="${k}">${html(n)}</option>`).join(""); sel.value = String(animIdx); }
      $(".pp-impnote").textContent = `Imported: ${r.steps.length} steps over ${r.seconds.toFixed(2)} s${r.cut ? ` (the first 60 s of ${r.cut.toFixed(1)} s)` : ""}. It doesn't travel: give ${o.who || "the Person"} a path for that.`;
    }
    async function saveImported() {
      if (!mv?.imported) return;
      const name = $("#pp-impname").value.trim() || mv.name || "Imported movement", id = uid();
      try {
        await api(`/api/v2/moves/${id}`, { method: "PUT", body: JSON.stringify({ id, name, seconds: mv.seconds, steps: mv.steps }) });
        await loadMoves(); pickMove(moves.find(m => m.id === id));
        Media.toast(`“${name}” is in the movement library.`);
      } catch (err) { Media.toast(`Save: ${err.message}`); }
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
    setMode(o.tab === "moves" ? "moves" : "poses");
    histBtns();
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
.pp-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
.pp-imp { width: 100%; margin-bottom: 8px; }
.pp-tabs .chip-btn.on, .pp-card > button.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
.pp-moveside h4 { margin: 2px 0 4px; }
.pp-hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
@media (max-width: 820px) { .pp { grid-template-columns: 1fr; grid-template-rows: auto minmax(280px, 50vh) auto; overflow: auto; } }
`;
    document.head.appendChild(st);
  }

  return { open };
})();
