/* Animate objects (motion layers): cut objects out of a picture, move them along paths, and have H3 render it.
   The method of PxTicks' h3-motion, rebuilt for this studio (server side: app/motion.py, workflows.build_motion):
   1. Objects: AI select (SAM 3.1) by a word or a click makes a layer per object (its mask, white on black).
   2. Empty background: Erase (the image editor's edit model) removes every object at once: the "plate".
   3. Path: each layer has keys (time, move, size, flip); drag the object in the picture at the playhead to key it.
      Between keys the object follows a smooth curve (Catmull-Rom); size eases in a straight line; flip switches.
   4. Generate: the page sends every frame's move, size and flip (the preview draws the same numbers); the server
      draws the rough animation and its mask, and H3 renders from the picture with Time-to-Move holding the objects
      to their paths for the first steps, then letting H3 redraw them so they belong in the shot. */
"use strict";

const Motion = (() => {
  const COLORS = ["#ff5a5f", "#3fb6ff", "#ffc53d", "#5be37d", "#c58bff", "#ff8f3d"];
  const FPS = 24;
  let m = null;  // the open window's state

  const $ = (sel, root = m?.root) => root?.querySelector(sel);
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't load " + src)); i.src = src; });
  const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
  const blobOf = c => new Promise(res => c.toBlob(res, "image/png"));
  async function upload(blob, name) {
    const fd = new FormData(); fd.append("file", blob, name);
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return (await r.json()).ref;
  }
  const frames = () => window.H3Prompt.h3Length(+m.seconds || 3);
  const dur = () => (frames() - 1) / FPS;

  /* ---------------------------------------------------------------- the path of a layer */
  // keys: [{t, x, y, s, f}] by time; x, y: the move as a share of the picture's width and height; s: size; f: flipped.
  function at(lay, t) {
    const K = lay.keys;
    if (t <= K[0].t || K.length === 1) return { ...K[0] };
    if (t >= K.at(-1).t) return { ...K.at(-1) };
    let i = 0; while (K[i + 1].t < t) i++;
    const a = K[i], b = K[i + 1], u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    const p0 = K[i - 1] || a, p3 = K[i + 2] || b;
    const cr = (q0, q1, q2, q3) => 0.5 * ((2 * q1) + (-q0 + q2) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u * u + (-q0 + 3 * q1 - 3 * q2 + q3) * u * u * u);
    return { t, x: cr(p0.x, a.x, b.x, p3.x), y: cr(p0.y, a.y, b.y, p3.y), s: a.s + (b.s - a.s) * u, f: a.f };
  }
  function keyAt(lay, t, make) {
    const near = lay.keys.find(k => Math.abs(k.t - t) < 0.5 / FPS);
    if (near || !make) return near;
    const k = { ...at(lay, t), t };
    lay.keys.push(k); lay.keys.sort((p, q) => p.t - q.t);
    return k;
  }

  /* ---------------------------------------------------------------- drawing */
  function view() {
    const c = m.canvas, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const k = Math.min(W / m.pic.width, H / m.pic.height);
    return { k, ox: (W - m.pic.width * k) / 2, oy: (H - m.pic.height * k) / 2 };
  }
  // A layer's box on screen at time t (for drawing and for picking it up).
  function placed(lay, t, v) {
    const p = at(lay, t), [x0, y0, x1, y1] = lay.box, iw = m.pic.width, ih = m.pic.height;
    const cx = (x0 + x1) / 2 + p.x * iw, cy = (y0 + y1) / 2 + p.y * ih, w = (x1 - x0) * p.s, h = (y1 - y0) * p.s;
    return { p, x: v.ox + (cx - w / 2) * v.k, y: v.oy + (cy - h / 2) * v.k, w: w * v.k, h: h * v.k };
  }
  function draw() {
    if (!m?.canvas) return;
    const v = view(), g = m.canvas.getContext("2d");
    g.clearRect(0, 0, m.canvas.width, m.canvas.height);
    const bg = m.plateImg && m.showPlate ? m.plateImg : m.pic;
    g.drawImage(bg, v.ox, v.oy, m.pic.width * v.k, m.pic.height * v.k);
    if (!m.plateImg) { g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(v.ox, v.oy, m.pic.width * v.k, m.pic.height * v.k); }
    m.layers.forEach((lay, i) => {
      const b = placed(lay, m.t, v);
      g.save();
      if (b.p.f) { g.translate(b.x + b.w, b.y); g.scale(-1, 1); g.drawImage(lay.cut, 0, 0, b.w, b.h); }
      else g.drawImage(lay.cut, b.x, b.y, b.w, b.h);
      g.restore();
      if (i === m.sel && !m.playing) {
        g.strokeStyle = lay.color; g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(b.x, b.y, b.w, b.h); g.setLineDash([]);
        // the path, as dots every few frames
        g.fillStyle = lay.color;
        for (let f = 0; f < frames(); f += 3) { const q = placed(lay, f / FPS, v); g.fillRect(q.x + q.w / 2 - 1.5, q.y + q.h / 2 - 1.5, 3, 3); }
        for (const k of lay.keys) { const q = placed(lay, k.t, v); g.beginPath(); g.arc(q.x + q.w / 2, q.y + q.h / 2, 5, 0, Math.PI * 2); g.fill(); }
      }
    });
    $(".mo-time").textContent = `${m.t.toFixed(2)} s / ${dur().toFixed(2)} s`;
    $(".mo-scrub").max = String(dur()); $(".mo-scrub").value = String(m.t);
  }

  /* ---------------------------------------------------------------- the side panel */
  function renderSide() {
    const lay = m.layers[m.sel];
    $(".mo-layers").innerHTML = m.layers.length ? m.layers.map((l, i) => `
      <li class="${i === m.sel ? "sel" : ""}" data-i="${i}"><span class="mo-sw" style="background:${l.color}"></span>
        <span class="mo-name">${esc(l.name)}</span><span class="mo-k">${l.keys.length} key${l.keys.length > 1 ? "s" : ""}</span>
        <button type="button" class="set-x" data-act="del-layer" data-i="${i}" title="Remove this object" aria-label="Remove ${esc(l.name)}">×</button></li>`).join("")
      : `<li class="mo-none">No objects yet: find one by name, or Pick and click it.</li>`;
    $(".mo-pick").classList.toggle("on", !!m.picking);
    $(".mo-plate-st").textContent = m.plateBusy ? "Erasing the objects…" : m.plateRef ? (m.plateStale ? "The objects changed: make it again." : "Ready.")
      : m.layers.length ? "Not made yet." : "Add objects first.";
    $('[data-act="plate"]').disabled = !m.layers.length || m.plateBusy;
    $('[data-act="plate"]').textContent = m.plateRef ? "↻ Make it again" : "Make empty background";
    $("#mo-showplate").disabled = !m.plateImg;
    const path = $(".mo-path");
    path.hidden = !lay;
    if (lay) {
      const k = keyAt(lay, m.t, false), cur = at(lay, m.t);
      $(".mo-path-h").textContent = `Path of ${lay.name}`;
      $(".mo-keys").innerHTML = lay.keys.map((q, j) => `<button type="button" class="chip-btn${Math.abs(q.t - m.t) < 0.5 / FPS ? " on" : ""}" data-key="${j}" title="Go to this key">${q.t.toFixed(2)} s</button>${j ? `<button type="button" class="set-x" data-act="del-key" data-key="${j}" title="Remove this key" aria-label="Remove the key at ${q.t.toFixed(2)} s">×</button>` : ""}`).join(" ");
      $("#mo-scale").value = String(cur.s); $(".mo-scale-v").textContent = `${Math.round(cur.s * 100)}%`;
      $("#mo-flip").checked = !!cur.f;
      $(".mo-keyhint").textContent = k ? `Key at ${k.t.toFixed(2)} s: drag the object, or change its size and flip.` : `No key at ${m.t.toFixed(2)} s: dragging the object or changing its size adds one.`;
    }
    const ok = m.layers.length && m.plateRef && !m.plateStale && !m.plateBusy;
    $('[data-act="generate"]').disabled = !ok || m.busy;
    $(".mo-foot-st").textContent = m.busy ? m.busy : !m.layers.length ? "Add an object to move." : !m.plateRef || m.plateStale ? "Make the empty background, then Generate." : "Ready to generate.";
  }
  const refresh = () => { renderSide(); draw(); };

  /* ---------------------------------------------------------------- objects */
  async function addLayer(body, name) {
    m.busy = "Finding the object…"; renderSide();
    try {
      const r = await api("/api/edit/select", { method: "POST", body: JSON.stringify({ source: m.ref, ...body }) });
      const mi = await loadImg(r.url + `?t=${Date.now()}`);
      const W = m.pic.width, H = m.pic.height, mc = mk(W, H), g = mc.getContext("2d");
      g.drawImage(mi, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H), px = d.data;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, on = px[o] >= 128;
        px[o + 3] = on ? 255 : 0;
        if (on) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) throw new Error("Nothing was found there: try another word, or click right on the object");
      g.putImageData(d, 0, 0);
      const box = [x0, y0, x1 + 1, y1 + 1], cut = mk(box[2] - x0, box[3] - y0), cg = cut.getContext("2d");
      cg.drawImage(mc, x0, y0, cut.width, cut.height, 0, 0, cut.width, cut.height);
      cg.globalCompositeOperation = "source-in";
      cg.drawImage(m.pic, x0, y0, cut.width, cut.height, 0, 0, cut.width, cut.height);
      m.layers.push({ name: name || `Object ${m.layers.length + 1}`, color: COLORS[m.layers.length % COLORS.length], mask: r.mask, maskImg: mi,
        box, cut, keys: [{ t: 0, x: 0, y: 0, s: 1, f: false }] });
      m.sel = m.layers.length - 1;
      if (m.plateRef) m.plateStale = true;
    } catch (e) { Media.toast(`Couldn't select it: ${e.message}`); }
    finally { m.busy = ""; refresh(); }
  }

  // Erase every object at once (the editor's Erase): the background the objects move over.
  async function makePlate() {
    const W = m.pic.width, H = m.pic.height, c = mk(W, H), g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    g.filter = "blur(5px)";  // a little wider than the objects, so their outline and soft edge go too
    for (const l of m.layers) g.drawImage(l.maskImg, 0, 0, W, H);
    g.filter = "none";
    const d = g.getImageData(0, 0, W, H), px = d.data;
    for (let o = 0; o < px.length; o += 4) { const v = px[o] > 8 ? 255 : 0; px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255; }
    g.putImageData(d, 0, 0);
    m.plateBusy = true; refresh();
    try {
      const mask = await upload(await blobOf(c), "motion_mask.png");
      const names = m.layers.map(l => l.name).join(", ");
      const r = await api("/api/generate", { method: "POST", body: JSON.stringify({ kind: "image", engine: "imgedit", edit_op: "erase",
        source: m.ref, edit_mask: mask, prompt: names, seed: -1, batch: 1, edit_model: "qwen", project: m.project }) });
      const it = r.items?.[0]; if (!it) throw new Error("The studio didn't start the erase");
      for (const x of r.items) state.items.set(x.id, x);
      renderGallery?.();
      const done = await waitFor(it.id);
      if (done.status !== "done") throw new Error(done.error || done.status);
      const f = done.files[0];
      m.plateImg = await loadImg(f.url + `?t=${Date.now()}`); m.plateRef = f.path; m.plateStale = false; m.showPlate = true;
      $("#mo-showplate").checked = true;
    } catch (e) { Media.toast(`Couldn't make the empty background: ${e.message}`); }
    finally { m.plateBusy = false; if (m) refresh(); }
  }
  function waitFor(id) {
    return new Promise(res => {
      const tick = () => {
        if (!m) return res({ status: "cancelled" });
        const it = state.items.get(id);
        if (it && ["done", "failed", "cancelled"].includes(it.status)) return res(it);
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  /* ---------------------------------------------------------------- generate */
  async function generate() {
    const n = frames(), iw = m.pic.width, ih = m.pic.height;
    const layers = m.layers.map(l => ({ mask: l.mask,
      frames: Array.from({ length: n }, (_, f) => { const p = at(l, f / FPS); return [+p.x.toFixed(5), +p.y.toFixed(5), +p.s.toFixed(4), p.f ? 1 : 0]; }) }));
    const names = m.layers.map(l => l.name);
    const what = m.prompt.trim() || `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} move${names.length > 1 ? "" : "s"} through the scene.`;
    const prompt = `integrated_multimodal_description: [Shot 1] ${what.replace(/\s+/g, " ")} The camera holds a static shot.\n\noverall_soundscape: Natural sound of the scene.\n\nnon_diegetic_music: N/A`;
    m.busy = "Sending to H3…"; renderSide();
    try {
      await submit({ kind: "video", engine: "motion", prompt, seconds: n / FPS, aspect: "16:9", quality: m.quality, seed: -1, batch: 1, turbo: true,
        first_frame: m.ref, motion_plate: m.plateRef, motion_layers: layers, motion_hold: m.hold, project: m.project });
      Media.toast("Animate objects: queued. The video shows up in the gallery when it's done.");
    } finally { if (m) { m.busy = ""; renderSide(); } }
    void iw; void ih;
  }

  /* ---------------------------------------------------------------- playback and dragging */
  function play() {
    if (m.playing) { m.playing = false; refresh(); return; }
    if (m.t >= dur() - 1e-3) m.t = 0;
    m.playing = true; const t0 = performance.now() - m.t * 1000;
    const step = now => { if (!m?.playing) return; m.t = Math.min(dur(), (now - t0) / 1000); draw(); if (m.t >= dur()) { m.playing = false; refresh(); } else requestAnimationFrame(step); };
    requestAnimationFrame(step); refresh();
  }
  function hit(e) {
    const r = m.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, v = view();
    for (let i = m.layers.length - 1; i >= 0; i--) { const b = placed(m.layers[i], m.t, v); if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i; }
    return -1;
  }
  function onDown(e) {
    if (m.busy || m.playing) return;
    const r = m.canvas.getBoundingClientRect(), v = view();
    const px = (e.clientX - r.left - v.ox) / v.k, py = (e.clientY - r.top - v.oy) / v.k;
    if (m.picking) {
      if (px < 0 || py < 0 || px > m.pic.width || py > m.pic.height) return;
      m.picking = false;
      addLayer({ positive: [{ x: Math.round(px), y: Math.round(py) }] });
      return;
    }
    const i = hit(e); if (i < 0) return;
    m.sel = i; const lay = m.layers[i];
    const k = keyAt(lay, m.t, true), sx = e.clientX, sy = e.clientY, kx = k.x, ky = k.y;
    const move = ev => { k.x = kx + (ev.clientX - sx) / v.k / m.pic.width; k.y = ky + (ev.clientY - sy) / v.k / m.pic.height; draw(); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); refresh(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    refresh();
  }

  /* ---------------------------------------------------------------- open */
  async function open(src) {
    if (m?.win) m.win.close();
    const pic = await loadImg(src.url);
    const root = document.createElement("div");
    root.className = "mo";
    root.innerHTML = `
      <div class="mo-stage">
        <canvas class="mo-canvas" aria-label="The picture: drag an object to move it at the playhead"></canvas>
        <div class="mo-transport">
          <button type="button" class="btn sm" data-act="play" title="Play the rough animation (Space)">▶</button>
          <input type="range" class="mo-scrub" min="0" step="${1 / FPS}" value="0" aria-label="Time">
          <span class="mo-time"></span>
        </div>
      </div>
      <aside class="mo-side">
        <section><h3>Objects</h3>
          <div class="mo-find"><input id="mo-word" placeholder="the red car" aria-label="Find an object by name">
            <button type="button" class="btn sm" data-act="find">Find</button>
            <button type="button" class="btn sm mo-pick" data-act="pick" title="Then click the object in the picture">Pick</button></div>
          <ul class="mo-layers"></ul></section>
        <section><h3>Empty background</h3>
          <p class="hint">The picture with every object erased, for them to move over (an edit with the Erase model).</p>
          <div class="mo-row"><button type="button" class="btn sm" data-act="plate">Make empty background</button><span class="mo-plate-st hint"></span></div>
          <label class="check"><input type="checkbox" id="mo-showplate"> Show it in the preview</label></section>
        <section class="mo-path" hidden><h3 class="mo-path-h"></h3>
          <p class="hint mo-keyhint"></p>
          <div class="mo-keys"></div>
          <div class="field"><label for="mo-scale">Size <span class="mo-scale-v"></span></label><input type="range" id="mo-scale" min="0.2" max="3" step="0.01"></div>
          <label class="check"><input type="checkbox" id="mo-flip"> Flipped</label></section>
        <section><h3>Shot</h3>
          <div class="row2"><div class="field"><label for="mo-sec">Length</label><div class="sm-sec"><input type="number" id="mo-sec" min="2" max="10" step="0.5" value="3"> s</div></div>
            <div class="field"><label for="mo-q">Quality</label><select id="mo-q"><option value="draft">Draft</option><option value="standard">Standard</option><option value="full">Full</option></select></div></div>
          <div class="field"><label for="mo-what">What happens <span class="opt">optional</span></label>
            <textarea id="mo-what" rows="3" placeholder="The red car drives off to the right, its wheels spinning."></textarea></div>
          <div class="field"><label for="mo-hold">Follow the path</label><select id="mo-hold" title="How long the objects are held to their paths before H3 is free to redraw them">
            <option value="loose">Loosely (more natural, may wander)</option><option value="normal" selected>Normally</option><option value="tight">Tightly (may look pasted on)</option></select></div></section>
      </aside>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="mo-foot-st hint"></span><button type="button" class="btn primary" data-act="generate">Generate</button>`;
    const win = WM.open({ id: "motion", title: `Animate objects · ${src.name || src.ref.split("/").pop()}`, content: root, footer: foot,
      width: 1100, height: 720, minWidth: 760, minHeight: 520, onClose: () => { m = null; } });
    m = { win, root: win.el, canvas: root.querySelector(".mo-canvas"), pic, ref: src.ref, project: state.project?.id ?? null,
      layers: [], sel: -1, t: 0, seconds: 3, quality: "draft", hold: "normal", prompt: "", plateRef: "", plateImg: null, showPlate: false };
    const all = [root, foot];
    const on = (ev, fn) => all.forEach(el => el.addEventListener(ev, fn));
    on("click", e => {
      const b = e.target.closest("[data-act],[data-key],.mo-layers li[data-i]"); if (!b) return;
      const a = b.dataset.act;
      if (a === "play") return play();
      if (a === "find") { const w = $("#mo-word").value.trim(); if (w) addLayer({ text: w }, w.replace(/^(the|a|an)\s+/i, "")); return; }
      if (a === "pick") { m.picking = !m.picking; return refresh(); }
      if (a === "plate") return makePlate();
      if (a === "generate") return generate();
      if (a === "del-layer") { m.layers.splice(+b.dataset.i, 1); m.sel = Math.min(m.sel, m.layers.length - 1); if (m.plateRef) m.plateStale = true; return refresh(); }
      if (a === "del-key") { m.layers[m.sel].keys.splice(+b.dataset.key, 1); return refresh(); }
      if (b.dataset.key != null) { m.t = m.layers[m.sel].keys[+b.dataset.key].t; return refresh(); }
      if (b.dataset.i != null) { m.sel = +b.dataset.i; return refresh(); }
    });
    on("input", e => {
      const id = e.target.id, lay = m.layers[m.sel];
      if (e.target.classList.contains("mo-scrub")) { m.t = Math.round(+e.target.value * FPS) / FPS; m.playing = false; return refresh(); }
      if (id === "mo-scale" && lay) { keyAt(lay, m.t, true).s = +e.target.value; return refresh(); }
      if (id === "mo-flip" && lay) { keyAt(lay, m.t, true).f = e.target.checked; return refresh(); }
      if (id === "mo-showplate") { m.showPlate = e.target.checked; return draw(); }
      if (id === "mo-sec") { m.seconds = Math.max(2, Math.min(10, +e.target.value || 3)); m.t = Math.min(m.t, dur()); return refresh(); }
      if (id === "mo-q") m.quality = e.target.value;
      if (id === "mo-hold") m.hold = e.target.value;
      if (id === "mo-what") m.prompt = e.target.value;
    });
    root.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "mo-word") { e.preventDefault(); root.querySelector('[data-act="find"]').click(); } });
    m.canvas.addEventListener("pointerdown", onDown);
    new ResizeObserver(() => m && draw()).observe(m.canvas);
    refresh();
  }

  return { open, _state: () => m };
})();
