/* ⬆ Importing poses and movements into the pose editor (posepad.js), read in the page (no libraries):
     - BVH motion capture (.bvh): its skeleton and every frame,
     - glTF animations (.glb, or .gltf with its .bin chosen too): a skeleton's nodes over time (Mixamo's, Blender's…),
     - OpenPose / DWPose keypoints (.json): COCO 18 or BODY_25 points, one file a frame or a list of frames (as
       ComfyUI's pose nodes save them); 2D, so each bone's depth is guessed from how short it looks (towards the
       camera), to fix in the editor,
     - FBX can't be read here: Blender converts it (File › Import › FBX, then Export › glTF 2.0 or BVH).
   The skeleton's joints are found by name (Hips, LeftArm, LeftForeArm, LeftHand, LeftUpLeg, LeftLeg, LeftFoot, Neck,
   Head, and the usual other spellings), and each frame becomes the mannequin's pose: the legs from the pelvis, the arms
   and head from the chest, the spine as the chest's turn from the pelvis; how far the feet rose and the pelvis turned
   go with each step of a movement. Gives { kind: "pose", name, def } or { kind: "move", name, seconds, steps, anims }. */
"use strict";

const PoseImport = (() => {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = a => Math.hypot(a[0], a[1], a[2]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = v => { const l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r3 = x => Math.round(x * 1000) / 1000;

  /* ---------------------------------------------------------------- 4x4 matrices, column-major (as glTF) */
  const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function m4(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  const T4 = t => { const m = I4(); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m; };
  function R4(axis, a) {
    const c = Math.cos(a), s = Math.sin(a), m = I4();
    if (axis === "X") { m[5] = c; m[9] = -s; m[6] = s; m[10] = c; }
    else if (axis === "Y") { m[0] = c; m[8] = s; m[2] = -s; m[10] = c; }
    else { m[0] = c; m[4] = -s; m[1] = s; m[5] = c; }
    return m;
  }
  function TRS(t, q, s) {
    const [x, y, z, w] = q, m = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, t[0], t[1], t[2], 1];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= s[c];
    return m;
  }
  const at4 = m => [m[12], m[13], m[14]];

  /* ---------------------------------------------------------------- which joint is which */
  // a joint's side ("L", "R" or "") and its name without the side or a rig's prefix ("mixamorig:LeftArm" -> L, "arm")
  function partOf(raw) {
    const n = String(raw || "").replace(/^.*[:|]/, "");
    let side = "", base = n;
    if (/left/i.test(n)) { side = "L"; base = n.replace(/left/i, ""); }
    else if (/right/i.test(n)) { side = "R"; base = n.replace(/right/i, ""); }
    else {
      const m = n.match(/^([LR])(?=[A-Z_.\s-])|[_.\s-]([LlRr])$|^([lr])[_.\s-]/);
      if (m) { side = (m[1] || m[2] || m[3]).toUpperCase(); base = n.replace(/^[LR](?=[A-Z_.\s-])|[_.\s-][LlRr]$|^[lr][_.\s-]/, ""); }
    }
    return { side, base: base.toLowerCase().replace(/[^a-z0-9]/g, "") };
  }
  // the names each part goes by, in the order they're preferred (a shoulder only when there's no upper arm: in most
  // rigs "Shoulder" is the collarbone)
  const ROLES = {
    up: ["arm", "uparm", "upperarm", "humerus", "shoulder"], el: ["forearm", "lowarm", "lowerarm", "elbow"], wr: ["hand", "wrist"],
    hip: ["upleg", "upperleg", "thigh", "femur", "hip"], kn: ["leg", "lowleg", "lowerleg", "knee", "calf", "shin"], an: ["foot", "ankle"],
  };
  function findJoints(names) {
    const P = names.map(partOf), pick = (side, list) => { for (const b of list) { const i = P.findIndex(p => p.side === side && p.base === b); if (i >= 0) return i; } return -1; };
    const J = { hips: pick("", ["hips", "pelvis", "hip", "root"]), neck: pick("", ["neck", "neck1", "neck01"]), head: pick("", ["head"]) };
    for (const sd of ["L", "R"]) for (const [k, list] of Object.entries(ROLES)) J[k + sd] = pick(sd, list);
    const missing = ["upL", "elL", "wrL", "upR", "elR", "wrR", "hipL", "knL", "anL", "hipR", "knR", "anR"].filter(k => J[k] < 0);
    if (missing.length) throw new Error("Couldn't find the arms and legs in this skeleton: its joints should be named like LeftArm, LeftForeArm, LeftHand, LeftUpLeg, LeftLeg and LeftFoot (Mixamo's names), or upperarm_l, lowerarm_l, hand_l, thigh_l, calf_l, foot_l.");
    return J;
  }
  // the named joints' places in one frame (pos: every joint's place)
  function pointsOf(J, pos) {
    const p = i => pos[i], o = {};
    for (const sd of ["L", "R"]) o[sd] = { sh: p(J["up" + sd]), el: p(J["el" + sd]), wr: p(J["wr" + sd]), hip: p(J["hip" + sd]), kn: p(J["kn" + sd]), an: p(J["an" + sd]) };
    o.hips = J.hips >= 0 ? p(J.hips) : mul(add(o.L.hip, o.R.hip), 0.5);
    o.neck = J.neck >= 0 ? p(J.neck) : mul(add(o.L.sh, o.R.sh), 0.5);
    o.head = J.head >= 0 ? p(J.head) : null;
    return o;
  }

  /* ---------------------------------------------------------------- joints -> the mannequin's pose
     A frame: rows are the axes, x to their left, y up, z forward (the mannequin's own). The pelvis's is upright (its
     hips give left, the world's up gives up); the chest's leans with the spine (its shoulders give left, the pelvis to
     the neck gives up). */
  function frame(x0, yHint) { const x = norm(x0), z = norm(cross(x, yHint)), y = cross(z, x); return [x, y, z]; }
  const into = (F, v) => [dot(F[0], v), dot(F[1], v), dot(F[2], v)];
  // the spine's turn from the pelvis's frame to the chest's, as the mannequin's [bend, lean, twist] (Y, then X, then Z)
  function spineOf(Pf, Cf) {
    const S = [0, 1, 2].map(i => [0, 1, 2].map(j => dot(Pf[i], Cf[j])));
    const a = Math.asin(clamp(-S[1][2], -1, 1)), b = Math.atan2(S[1][0], S[1][1]), c = Math.atan2(S[0][2], S[2][2]);
    return [clamp(a * deg, -30, 90), clamp(-b * deg, -40, 40), clamp(c * deg, -60, 60)];
  }
  function poseOf(pt) {
    const Pf = frame(sub(pt.L.hip, pt.R.hip), [0, 1, 0]), Cf = frame(sub(pt.L.sh, pt.R.sh), sub(pt.neck, pt.hips));
    const limb = (F, a, b, c, sx) => [a, b].map(([p, q]) => { const d = norm(into(F, sub(q, p))); return [r3(d[0] * sx), r3(d[1]), r3(d[2])]; });
    const def = { arms: {}, legs: {}, spine: spineOf(Pf, Cf).map(r3), head: [0, 0, 0], hands: { R: "relaxed", L: "relaxed" } };
    for (const [sd, sx] of [["R", -1], ["L", 1]]) {
      const s = pt[sd];
      def.arms[sd] = limb(Cf, [s.sh, s.el], [s.el, s.wr], null, sx);
      def.legs[sd] = limb(Pf, [s.hip, s.kn], [s.kn, s.an], null, sx);
    }
    if (pt.head) {
      const h = norm(into(Cf, sub(pt.head, pt.neck)));
      def.head = [clamp(pt.turn || 0, -80, 80), clamp(Math.atan2(h[2], h[1]) * deg, -40, 60), clamp(Math.atan2(h[0], h[1]) * deg, -40, 40)].map(r3);
    }
    return { def, facing: Math.atan2(Pf[2][0], Pf[2][2]) * deg, feet: Math.min(pt.L.an[1], pt.R.an[1]), height: pt.head ? pt.head[1] - Math.min(pt.L.an[1], pt.R.an[1]) : null };
  }
  /* frames of points (at fps) -> a pose (one frame) or a movement: up to 40 steps (8 a second), each with how far the
     feet rose (a share of the height) and how far the pelvis turned since the first. Steps between are straight (lin):
     sampled motion shouldn't ease in and out of every one. */
  function fromFrames(name, frames, fps) {
    if (!frames.length) throw new Error("There are no frames in it.");
    if (frames.length === 1) return { kind: "pose", name, def: poseOf(frames[0]).def };
    const total = (frames.length - 1) / fps, seconds = Math.min(60, total);
    const n = clamp(Math.round(seconds * 8) + 1, 2, 40), first = poseOf(frames[0]);
    const H = (first.height || 1.54) * 1.74 / 1.54 || 1;
    let prev = first.facing, turn = 0;
    const steps = [];
    for (let k = 0; k < n; k++) {
      const t = seconds * k / (n - 1), P = poseOf(frames[Math.min(frames.length - 1, Math.round(t * fps))]);
      let d = P.facing - prev; while (d > 180) d -= 360; while (d < -180) d += 360;
      turn += d; prev = P.facing;
      steps.push({ f: r3(k / (n - 1)), pose: { ...P.def, label: name, says: "" }, lift: r3(Math.max(0, (P.feet - first.feet) / H)), turn: r3(turn), lin: true });
    }
    return { kind: "move", name, seconds: r3(seconds), steps, cut: total > 60 + 1e-6 ? total : 0 };
  }

  /* ---------------------------------------------------------------- BVH */
  function readBVH(text, name) {
    const tok = text.split(/\s+/).filter(Boolean);
    let i = 0;
    const want = w => { if ((tok[i++] || "").toUpperCase() !== w.toUpperCase()) throw new Error(`Not a BVH file (expected ${w})`); };
    want("HIERARCHY");
    const joints = [];
    function joint(parent, isEnd = false) {
      const j = { name: isEnd ? `${joints[parent]?.name || "end"}_end` : tok[i++], parent, offset: [0, 0, 0], channels: [] };
      const id = joints.push(j) - 1;
      want("{");
      for (;;) {
        const w = (tok[i++] || "").toUpperCase();
        if (w === "OFFSET") j.offset = [+tok[i++], +tok[i++], +tok[i++]];
        else if (w === "CHANNELS") { const n = +tok[i++]; for (let k = 0; k < n; k++) j.channels.push(tok[i++]); }
        else if (w === "JOINT") joint(id);
        else if (w === "END") { i++; joint(id, true); }
        else if (w === "}") return;
        else throw new Error("The BVH file's skeleton couldn't be read.");
      }
    }
    want("ROOT"); joint(-1);
    want("MOTION"); want("Frames:");
    const nf = +tok[i++]; want("Frame"); want("Time:");
    const dt = +tok[i++] || 1 / 30, nch = joints.reduce((s, j) => s + j.channels.length, 0);
    const J = findJoints(joints.map(j => j.name));
    const fps = 1 / dt, maxF = Math.min(nf, Math.round(60 * fps) + 1), frames = [];
    for (let f = 0; f < maxF; f++) {
      const v = tok.slice(i + f * nch, i + (f + 1) * nch).map(Number);
      if (v.length < nch) break;
      let c = 0;
      const world = joints.map(() => null), pos = [];
      joints.forEach((j, k) => {
        let tr = j.offset.slice(), R = I4();
        for (const ch of j.channels) {
          const x = v[c++], a = ch.toLowerCase();
          if (a === "xposition") tr[0] += x; else if (a === "yposition") tr[1] += x; else if (a === "zposition") tr[2] += x;
          else if (a.endsWith("rotation")) R = m4(R, R4(a[0].toUpperCase(), x * rad));
        }
        world[k] = m4(j.parent >= 0 ? world[j.parent] : I4(), m4(T4(tr), R));
        pos[k] = at4(world[k]);
      });
      frames.push(pointsOf(J, pos));
    }
    return fromFrames(name, frames, fps);
  }

  /* ---------------------------------------------------------------- glTF */
  async function readGLTF(file, all) {
    const buf = await file.arrayBuffer(), dv = new DataView(buf);
    let json, bins = [];
    if (dv.getUint32(0, true) === 0x46546C67) {  // .glb: the JSON chunk, then the binary one
      let o = 12;
      while (o < buf.byteLength) {
        const L = dv.getUint32(o, true), type = dv.getUint32(o + 4, true), body = buf.slice(o + 8, o + 8 + L);
        if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body)); else if (type === 0x004E4942) bins[0] = body;
        o += 8 + L;
      }
    } else json = JSON.parse(new TextDecoder().decode(buf));
    if (!json) throw new Error("Not a glTF file.");
    for (const [k, b] of (json.buffers || []).entries()) {
      if (bins[k]) continue;
      if (b.uri?.startsWith("data:")) bins[k] = await (await fetch(b.uri)).arrayBuffer();
      else if (b.uri) {
        const f = all.find(x => x.name === decodeURIComponent(b.uri.split("/").pop()));
        if (!f) throw new Error(`The .gltf needs its ${b.uri}: choose it too, with the .gltf.`);
        bins[k] = await f.arrayBuffer();
      }
    }
    const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    function read(ai) {
      const a = json.accessors[ai], bv = json.bufferViews[a.bufferView], n = SIZE[a.type], b = bins[bv.buffer];
      const C = { 5126: [Float32Array, 4, 1], 5123: [Uint16Array, 2, 65535], 5121: [Uint8Array, 1, 255], 5122: [Int16Array, 2, 32767], 5120: [Int8Array, 1, 127] }[a.componentType];
      const stride = bv.byteStride || n * C[1], start = (bv.byteOffset || 0) + (a.byteOffset || 0), out = [];
      const view = new DataView(b), get = { 5126: o => view.getFloat32(o, true), 5123: o => view.getUint16(o, true), 5121: o => view.getUint8(o), 5122: o => view.getInt16(o, true), 5120: o => view.getInt8(o) }[a.componentType];
      for (let k = 0; k < a.count; k++) { const row = []; for (let c = 0; c < n; c++) { const x = get(start + k * stride + c * C[1]); row.push(a.componentType === 5126 || !a.normalized ? x : Math.max(x / C[2], -1)); } out.push(row); }
      return out;
    }
    const nodes = json.nodes || [], parent = nodes.map(() => -1);
    nodes.forEach((nd, k) => (nd.children || []).forEach(c => { parent[c] = k; }));
    const J = findJoints(nodes.map(nd => nd.name || ""));
    const anims = (json.animations || []).map((an, k) => ({ name: an.name || `Animation ${k + 1}`, ch: an.channels.map(c => {
      const s = an.samplers[c.sampler], t = read(s.input).map(x => x[0]), v = read(s.output);
      return { node: c.target.node, path: c.target.path, t, v: s.interpolation === "CUBICSPLINE" ? v.filter((_, i) => i % 3 === 1) : v, step: s.interpolation === "STEP" };
    }).filter(c => c.node != null && ["translation", "rotation", "scale"].includes(c.path)) }));
    const order = []; const seen = new Set();
    const visit = k => { if (seen.has(k)) return; seen.add(k); if (parent[k] >= 0) visit(parent[k]); order.push(k); };
    nodes.forEach((_, k) => visit(k));
    function pointsAt(an, t) {
      const trs = nodes.map(nd => ({ t: nd.translation || [0, 0, 0], r: nd.rotation || [0, 0, 0, 1], s: nd.scale || [1, 1, 1] }));
      for (const c of an?.ch || []) {
        const T = c.t; let i = 0; while (i < T.length - 1 && T[i + 1] <= t) i++;
        const j = Math.min(i + 1, T.length - 1), u = c.step || j === i ? 0 : clamp((t - T[i]) / (T[j] - T[i]), 0, 1);
        let val = c.v[i].map((x, q) => x + (c.v[j][q] - x) * u);
        if (c.path === "rotation") {
          if (dot4(c.v[i], c.v[j]) < 0) val = c.v[i].map((x, q) => x + (-c.v[j][q] - x) * u);
          const l = Math.hypot(...val) || 1; val = val.map(x => x / l);
        }
        trs[c.node][c.path[0]] = val;
      }
      const world = [];
      for (const k of order) {
        const nd = nodes[k], local = nd.matrix && !(an?.ch || []).some(c => c.node === k) ? nd.matrix : TRS(trs[k].t, trs[k].r, trs[k].s);
        world[k] = parent[k] >= 0 ? m4(world[parent[k]], local) : local;
      }
      return pointsOf(J, world.map(at4));
    }
    const name = file.name.replace(/\.(glb|gltf)$/i, "");
    if (!anims.length) return { kind: "pose", name, def: poseOf(pointsAt(null, 0)).def };
    const take = k => {
      const an = anims[k], end = Math.max(0, ...an.ch.map(c => c.t.at(-1) || 0)), fps = 30, frames = [];
      for (let f = 0; f <= Math.min(end, 60) * fps; f++) frames.push(pointsAt(an, f / fps));
      return { ...fromFrames(anims.length > 1 ? `${name}: ${an.name}` : name, frames, fps), cut: end > 60 ? end : 0 };
    };
    return { ...take(0), anims: anims.map(a => a.name), take };
  }
  const dot4 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

  /* ---------------------------------------------------------------- OpenPose / DWPose keypoints
     COCO 18: 0 nose, 1 neck, 2-4 right shoulder, elbow, wrist, 5-7 left, 8-10 right hip, knee, ankle, 11-13 left,
     16, 17 ears. BODY_25: the same to 7, then 8 the middle of the hips, 9-11 right hip, knee, ankle, 12-14 left, 17,
     18 ears. The picture's x is to the person's left as they face the camera; its y is down. */
  const KP = {
    18: { nose: 0, neck: 1, R: [2, 3, 4, 8, 9, 10], L: [5, 6, 7, 11, 12, 13], ears: [16, 17] },
    25: { nose: 0, neck: 1, R: [2, 3, 4, 9, 10, 11], L: [5, 6, 7, 12, 13, 14], ears: [17, 18] },
  };
  function keypointFrames(data) {
    const list = Array.isArray(data) ? data : [data], out = [];
    for (const fr of list) {
      const person = fr?.people?.[0]; if (!person) continue;
      let k = person.pose_keypoints_2d || person.pose_keypoints || [];
      const W = +fr.canvas_width || 0, H = +fr.canvas_height || 0;
      const pts = []; for (let i = 0; i + 2 < k.length; i += 3) pts.push([+k[i], +k[i + 1], +k[i + 2]]);
      // ComfyUI's pose nodes may give 0 to 1 of the picture
      if (W && H && pts.every(p => p[0] <= 1.001 && p[1] <= 1.001)) pts.forEach(p => { p[0] *= W; p[1] *= H; });
      out.push(pts);
    }
    return out;
  }
  function liftKeypoints(pts) {
    const M = KP[pts.length >= 25 ? 25 : 18];
    if (!M || pts.length < 18) throw new Error("These keypoints aren't OpenPose's body points (COCO 18 or BODY_25).");
    const ok = i => pts[i] && pts[i][2] > 0.05, P = i => [pts[i][0], -pts[i][1], 0];
    for (const i of [M.neck, M.R[0], M.L[0], M.R[3], M.L[3]]) if (!ok(i)) throw new Error("The shoulders and hips aren't all in these keypoints.");
    // metres a pixel: from the shoulders (0.4 m apart) and the neck to the hips (0.57 m)
    const hipMid = mul(add(P(M.R[3]), P(M.L[3])), 0.5), px = Math.max(len(sub(P(M.R[0]), P(M.L[0]))) / 0.4, len(sub(P(M.neck), hipMid)) / 0.57) || 1;
    const S = v => mul(v, 1 / px);
    const pt = { hips: S(hipMid), neck: S(P(M.neck)) };
    // a bone of length L seen as d on the picture: the rest of it is depth, towards the camera (the person's front)
    const bone = (from, i, L) => { if (!ok(i)) return null; const d = sub(S(P(i)), from); d[2] = Math.sqrt(Math.max(0, L * L - d[0] * d[0] - d[1] * d[1])); return add(from, d); };
    for (const sd of ["R", "L"]) {
      const [sh, el, wr, hp, kn, an] = M[sd], sx = sd === "R" ? -1 : 1;
      const s = { sh: S(P(sh)), hip: S(P(hp)) };
      s.el = bone(s.sh, el, 0.29) || add(s.sh, [0.03 * sx, -0.29, 0]);
      s.wr = (ok(el) && bone(s.el, wr, 0.27)) || add(s.el, [0.02 * sx, -0.27, 0.02]);
      s.kn = bone(s.hip, kn, 0.41) || add(s.hip, [0, -0.41, 0]);
      s.an = (ok(kn) && bone(s.kn, an, 0.41)) || add(s.kn, [0, -0.41, 0]);
      pt[sd] = s;
    }
    // the head: up from the neck, turned by where the nose is between the ears
    pt.head = add(pt.neck, [0, 0.15, 0]);
    const [eR, eL] = M.ears;
    if (ok(M.nose) && ok(eR) && ok(eL)) {
      const a = pts[eR][0], b = pts[eL][0], n = pts[M.nose][0], w = Math.abs(b - a) || 1;
      pt.turn = clamp(((n - (a + b) / 2) / w) * 120, -80, 80);
    }
    return pt;
  }

  /* ---------------------------------------------------------------- reading files */
  async function read(files) {
    const all = [...files];
    const f = all.find(x => /\.(bvh|glb|gltf|fbx)$/i.test(x.name)) || all[0];
    if (!f) throw new Error("No file chosen.");
    const name = f.name.replace(/\.[^.]+$/, "");
    if (/\.fbx$/i.test(f.name)) throw new Error("FBX can't be read here. Open it in Blender (File › Import › FBX), then File › Export › glTF 2.0 (.glb, with its animation) or Motion Capture (.bvh), and import that.");
    if (/\.bvh$/i.test(f.name)) return readBVH(await f.text(), name);
    if (/\.(glb|gltf)$/i.test(f.name)) return readGLTF(f, all);
    // keypoints: one file (a frame, or a list of frames), or several files (a frame each, in name order)
    const jsons = all.filter(x => /\.json$/i.test(x.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!jsons.length) throw new Error("Choose a .bvh, .glb, .gltf or OpenPose .json file.");
    let frames = [];
    for (const j of jsons) {
      let data; try { data = JSON.parse(await j.text()); } catch { throw new Error(`${j.name} isn't JSON.`); }
      frames.push(...keypointFrames(data));
    }
    if (!frames.length) throw new Error("No person's keypoints were found in it.");
    return fromFrames(jsons.length > 1 ? name.replace(/[_-]?\d+(_keypoints)?$/i, "") || name : name, frames.map(liftKeypoints), 30);
  }

  return { read, _poseOf: poseOf, _findJoints: findJoints };
})();
