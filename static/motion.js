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
  // keys: [{t, x, y, s, f, r, v}] by time; x, y: the move as a share of the picture's width and height; s: size;
  // f: flipped left to right; r: turned, in degrees clockwise; v: flipped upside down. Size and turn ease in a straight
  // line between keys; the flips switch at a key.
  const full = k => ({ r: 0, v: false, f: false, s: 1, x: 0, y: 0, ...k });
  function at(lay, t) {
    const K = lay.keys;
    if (t <= K[0].t || K.length === 1) return full(K[0]);
    if (t >= K.at(-1).t) return full(K.at(-1));
    let i = 0; while (K[i + 1].t < t) i++;
    const a = full(K[i]), b = full(K[i + 1]), u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    const p0 = K[i - 1] || a, p3 = K[i + 2] || b;
    const cr = (q0, q1, q2, q3) => 0.5 * ((2 * q1) + (-q0 + q2) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u * u + (-q0 + 3 * q1 - 3 * q2 + q3) * u * u * u);
    return { t, x: cr(p0.x, a.x, b.x, p3.x), y: cr(p0.y, a.y, b.y, p3.y), s: a.s + (b.s - a.s) * u, f: a.f, r: a.r + (b.r - a.r) * u, v: a.v };
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
  // A layer on screen at time t: its centre, size (before the turn) and pose (for drawing and for picking it up).
  function placed(lay, t, v) {
    const p = at(lay, t), [x0, y0, x1, y1] = lay.box, iw = m.pic.width, ih = m.pic.height;
    const cx = (x0 + x1) / 2 + p.x * iw, cy = (y0 + y1) / 2 + p.y * ih, w = (x1 - x0) * p.s, h = (y1 - y0) * p.s;
    return { p, cx: v.ox + cx * v.k, cy: v.oy + cy * v.k, w: w * v.k, h: h * v.k, x: v.ox + (cx - w / 2) * v.k, y: v.oy + (cy - h / 2) * v.k };
  }
  // A screen point in the layer's own frame (before its turn, flips and size), relative to its centre, in screen px.
  function local(b, sx, sy) {
    const a = -b.p.r * Math.PI / 180, dx = sx - b.cx, dy = sy - b.cy;
    let lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (b.p.f) lx = -lx;
    if (b.p.v) ly = -ly;
    return [lx, ly];
  }
  function drawLayer(g, lay, b) {
    g.save();
    g.translate(b.cx, b.cy); g.rotate(b.p.r * Math.PI / 180); g.scale(b.p.f ? -1 : 1, b.p.v ? -1 : 1);
    g.drawImage(lay.show || lay.cut, -b.w / 2, -b.h / 2, b.w, b.h);
    g.restore();
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
      drawLayer(g, lay, b);
      if (i === m.sel && !m.playing) {
        g.save(); g.translate(b.cx, b.cy); g.rotate(b.p.r * Math.PI / 180);
        g.strokeStyle = lay.color; g.lineWidth = 2; g.setLineDash(m.erasing ? [2, 3] : [6, 4]); g.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h); g.setLineDash([]);
        g.restore();
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
    const sel = $("#mo-track");
    if (sel && sel.dataset.n !== String(m.tracks.length)) {
      sel.dataset.n = String(m.tracks.length);
      sel.innerHTML = m.tracks.length ? m.tracks.map(tr => `<option value="${esc(tr.id)}">${esc(tr.name)} · ${tr.duration.toFixed(1)} s</option>`).join("")
        : `<option value="">No tracked paths yet</option>`;
    }
    if (sel) { sel.disabled = !m.tracks.length; $('[data-act="apply-track"]').disabled = !m.tracks.length; }
    if (lay) {
      const k = keyAt(lay, m.t, false), cur = at(lay, m.t);
      $(".mo-path-h").textContent = `Path of ${lay.name}`;
      $(".mo-keys").innerHTML = lay.keys.map((q, j) => `<button type="button" class="chip-btn${Math.abs(q.t - m.t) < 0.5 / FPS ? " on" : ""}" data-key="${j}" title="Go to this key">${q.t.toFixed(2)} s</button>${j ? `<button type="button" class="set-x" data-act="del-key" data-key="${j}" title="Remove this key" aria-label="Remove the key at ${q.t.toFixed(2)} s">×</button>` : ""}`).join(" ");
      $("#mo-scale").value = String(cur.s); $(".mo-scale-v").textContent = `${Math.round(cur.s * 100)}%`;
      $("#mo-rot").value = String(Math.round(cur.r)); $(".mo-rot-v").textContent = `${Math.round(cur.r)}°`;
      $("#mo-flip").checked = !!cur.f; $("#mo-flipv").checked = !!cur.v;
      $(".mo-keyhint").textContent = k ? `Key at ${k.t.toFixed(2)} s: drag the object, or right-click it for size, turn, flip, erase and colour.`
        : `No key at ${m.t.toFixed(2)} s: dragging the object or changing it adds one. Right-click it for more.`;
    }
    const ok = m.layers.length && m.plateRef && !m.plateStale && !m.plateBusy;
    $('[data-act="generate"]').disabled = !ok || m.busy;
    const verb = m.onUse ? "Use for this shot" : "Generate";
    $(".mo-erase-bar").hidden = !m.erasing;
    if (m.erasing) $(".mo-erase-name").textContent = m.layers[m.erasing.i]?.name || "";
    $(".mo-foot-st").textContent = m.busy ? m.busy : !m.layers.length ? "Add an object to move." : !m.plateRef || m.plateStale ? `Make the empty background, then ${verb}.`
      : m.onUse ? "Ready: the shot renders with these objects and paths." : "Ready to generate.";
  }
  const refresh = () => { renderSide(); draw(); };

  /* ---------------------------------------------------------------- objects */
  // A layer from its mask (white = the object): the cut-out and where it sits. null if the mask is empty.
  function layerFrom(mi, mask, name, keys) {
      const W = m.pic.width, H = m.pic.height, mc = mk(W, H), g = mc.getContext("2d");
      g.drawImage(mi, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H), px = d.data;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, on = px[o] >= 128;
        px[o + 3] = on ? 255 : 0;
        if (on) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) return null;
      g.putImageData(d, 0, 0);
      const box = [x0, y0, x1 + 1, y1 + 1], cut = mk(box[2] - x0, box[3] - y0), cg = cut.getContext("2d");
      cg.drawImage(mc, x0, y0, cut.width, cut.height, 0, 0, cut.width, cut.height);
      cg.globalCompositeOperation = "source-in";
      cg.drawImage(m.pic, x0, y0, cut.width, cut.height, 0, 0, cut.width, cut.height);
      const maskCanvas = mk(W, H), mg = maskCanvas.getContext("2d");  // opaque white on black, for Erase parts
      mg.fillStyle = "#000"; mg.fillRect(0, 0, W, H); mg.drawImage(mi, 0, 0, W, H);
      return { name: name || `Object ${m.layers.length + 1}`, color: COLORS[m.layers.length % COLORS.length], mask, maskImg: mi, maskCanvas,
        box, cut, show: null, adj: { hue: 0, sat: 1, bri: 1 }, edited: false, maskDirty: false,
        keys: keys?.length ? structuredClone(keys) : [{ t: 0, x: 0, y: 0, s: 1, f: false, r: 0, v: false }] };
  }

  /* ---------------------------------------------------------------- colour (the server's motion.recolor, same steps) */
  const adjDefault = a => !a || (Math.abs(a.hue || 0) < 0.5 && Math.abs((a.sat ?? 1) - 1) < 1e-3 && Math.abs((a.bri ?? 1) - 1) < 1e-3);
  function recolor(lay) {
    const a = lay.adj;
    if (adjDefault(a)) { lay.show = null; return; }
    const c = mk(lay.cut.width, lay.cut.height), g = c.getContext("2d");
    g.drawImage(lay.cut, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data, shift = Math.round((a.hue || 0) / 360 * 256) / 256;
    for (let o = 0; o < px.length; o += 4) {
      if (!px[o + 3]) continue;
      let r = px[o] / 255, gg = px[o + 1] / 255, b = px[o + 2] / 255;
      if (shift) {  // HSV hue turn, as PIL's HSV mode
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dv = mx - mn;
        let h = 0;
        if (dv) h = mx === r ? ((gg - b) / dv) / 6 : mx === gg ? ((b - r) / dv + 2) / 6 : ((r - gg) / dv + 4) / 6;
        h = ((h + shift) % 1 + 1) % 1;
        const s = mx ? dv / mx : 0, v = mx, i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        [r, gg, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
      }
      if (Math.abs((a.sat ?? 1) - 1) >= 1e-3) {  // PIL ImageEnhance.Color: blend with the grey
        const L = 0.299 * r + 0.587 * gg + 0.114 * b, k = a.sat;
        r = L + (r - L) * k; gg = L + (gg - L) * k; b = L + (b - L) * k;
      }
      const br = a.bri ?? 1;  // PIL ImageEnhance.Brightness: a factor
      px[o] = Math.max(0, Math.min(255, Math.round(r * br * 255)));
      px[o + 1] = Math.max(0, Math.min(255, Math.round(gg * br * 255)));
      px[o + 2] = Math.max(0, Math.min(255, Math.round(b * br * 255)));
    }
    g.putImageData(d, 0, 0);
    lay.show = c;
  }

  /* ---------------------------------------------------------------- the object menu (right-click) */
  function closeMenu() { m?.root.querySelector(".mo-menu")?.remove(); }
  function openMenu(i, x, y) {
    closeMenu();
    m.sel = i; refresh();
    const lay = m.layers[i], cur = at(lay, m.t), a = lay.adj;
    const el = document.createElement("div");
    el.className = "mo-menu"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", `${lay.name}: tools`);
    const slider = (key, label, min, max, step, val, fmt) => `<label class="mo-ms"><span>${label}</span>
      <input type="range" data-mm="${key}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt(val)}</output></label>`;
    el.innerHTML = `<div class="mo-mh"><b>${esc(lay.name)}</b> <span class="hint">at ${m.t.toFixed(2)} s</span></div>
      ${slider("s", "Size", 0.2, 3, 0.01, cur.s, v => `${Math.round(v * 100)}%`)}
      ${slider("r", "Turn", -180, 180, 1, Math.round(cur.r), v => `${Math.round(v)}°`)}
      <div class="mo-mrow"><button type="button" class="btn sm" data-mm="rot-90" title="Turn left 90°">↺ 90°</button><button type="button" class="btn sm" data-mm="rot+90" title="Turn right 90°">↻ 90°</button>
        <button type="button" class="btn sm" data-mm="flip-h">⇋ Flip</button><button type="button" class="btn sm" data-mm="flip-v">⇵ Upside down</button></div>
      <p class="hint mo-mnote">Size, turn and flips are keyed at the playhead.</p>
      <div class="mo-mh2">Colour <span class="hint">the whole object</span></div>
      ${slider("hue", "Hue", -180, 180, 1, a.hue, v => `${Math.round(v)}°`)}
      ${slider("sat", "Saturation", 0, 2, 0.01, a.sat, v => `${Math.round(v * 100)}%`)}
      ${slider("bri", "Brightness", 0.2, 2, 0.01, a.bri, v => `${Math.round(v * 100)}%`)}
      <div class="mo-mrow"><button type="button" class="btn sm ghost" data-mm="color-reset">Reset colour</button></div>
      <div class="mo-mrow mo-msep"><button type="button" class="btn sm" data-mm="erase">✎ Erase parts…</button>
        <button type="button" class="btn sm" data-mm="make3d" title="A textured 3D model of this object (TRELLIS.2)">🧊 Make 3D…</button>
        <button type="button" class="btn sm ghost" data-mm="remove">🗑 Remove object</button></div>`;
    m.root.appendChild(el);
    const W = el.offsetWidth, H = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - W - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - H - 8))}px`;
    el.addEventListener("input", e => {
      const k = e.target.dataset.mm, val = +e.target.value; if (!k) return;
      e.target.nextElementSibling.textContent = k === "s" || k === "sat" || k === "bri" ? `${Math.round(val * 100)}%` : `${Math.round(val)}°`;
      if (k === "s" || k === "r") keyAt(lay, m.t, true)[k] = val;
      else { lay.adj[k] = val; recolor(lay); }
      refresh();
    });
    el.addEventListener("click", e => {
      const k = e.target.closest("[data-mm]")?.dataset.mm; if (!k || e.target.type === "range") return;
      if (k === "rot-90" || k === "rot+90") {
        const key = keyAt(lay, m.t, true); key.r = Math.max(-180, Math.min(180, Math.round((key.r || 0) + (k === "rot+90" ? 90 : -90))));
        if (Math.abs(key.r) === 180 && k === "rot+90") key.r = 180;
        el.querySelector('[data-mm="r"]').value = String(key.r); el.querySelector('[data-mm="r"]').nextElementSibling.textContent = `${key.r}°`;
      }
      if (k === "flip-h") { const key = keyAt(lay, m.t, true); key.f = !full(key).f; }
      if (k === "flip-v") { const key = keyAt(lay, m.t, true); key.v = !full(key).v; }
      if (k === "color-reset") {
        lay.adj = { hue: 0, sat: 1, bri: 1 }; recolor(lay);
        for (const [n, v] of [["hue", 0], ["sat", 1], ["bri", 1]]) { const s = el.querySelector(`[data-mm="${n}"]`); s.value = String(v); s.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      if (k === "erase") { closeMenu(); startErase(i); return; }
      if (k === "make3d") {
        closeMenu();
        saveMasks().then(() => Model3D.start({ ref: m.ref, url: m.url, mask: lay.mask, name: lay.name }))
          .catch(err => Media.toast(`Couldn't save the object: ${err.message}`));
        return;
      }
      if (k === "remove") { closeMenu(); m.layers.splice(i, 1); m.sel = Math.min(m.sel, m.layers.length - 1); if (m.plateRef) m.plateStale = true; }
      refresh();
    });
  }

  /* ---------------------------------------------------------------- Erase parts: a brush that takes bits out of an object */
  function startErase(i) { m.erasing = { i, size: m.erasing?.size || 24 }; m.picking = false; refresh(); }
  function stopErase() { if (m.erasing) rebuild(m.erasing.i); m.erasing = null; refresh(); }
  // After Erase parts, the object is made again from its edited mask, as the server will (its box may be smaller).
  function rebuild(i) {
    const lay = m.layers[i]; if (!lay?.maskDirty) return;
    const nl = layerFrom(lay.maskCanvas, lay.mask, lay.name, lay.keys);
    if (!nl) { m.layers.splice(i, 1); m.sel = Math.min(m.sel, m.layers.length - 1); Media.toast(`${lay.name} was erased completely, so it's gone.`); return; }
    Object.assign(lay, { box: nl.box, cut: nl.cut, maskImg: nl.maskImg, maskCanvas: nl.maskCanvas });
    recolor(lay);
  }
  function eraseAt(lay, sx, sy) {
    const v = view(), b = placed(lay, m.t, v), [lx, ly] = local(b, sx, sy);
    const sc = v.k * b.p.s, R = m.erasing.size / 2 / sc;  // the brush in picture pixels
    const [x0, y0, x1, y1] = lay.box, px = lx / sc + (x1 - x0) / 2, py = ly / sc + (y1 - y0) / 2;
    const cg = lay.cut.getContext("2d");
    cg.save(); cg.globalCompositeOperation = "destination-out"; cg.beginPath(); cg.arc(px, py, R, 0, Math.PI * 2); cg.fill(); cg.restore();
    const mg = lay.maskCanvas.getContext("2d");
    mg.fillStyle = "#000"; mg.beginPath(); mg.arc(x0 + px, y0 + py, R, 0, Math.PI * 2); mg.fill();
    lay.edited = lay.maskDirty = true;
    recolor(lay);
  }
  async function addLayer(body, name) {
    m.busy = "Finding the object…"; renderSide();
    try {
      const r = await api("/api/edit/select", { method: "POST", body: JSON.stringify({ source: m.ref, ...body }) });
      const lay = layerFrom(await loadImg(r.url + `?t=${Date.now()}`), r.mask, name);
      if (!lay) throw new Error("Nothing was found there: try another word, or click right on the object");
      m.layers.push(lay);
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

  /* ---------------------------------------------------------------- plans (a shot's motion, Shots step) */
  // What a shot keeps: the picture, its empty background, each object's mask and keys, and how tightly to follow.
  // Masks changed with Erase parts go up as new pictures before a render or a shot keeps them.
  async function saveMasks() {
    if (m.erasing) stopErase();
    for (const l of m.layers) if (l.maskDirty) { l.mask = await upload(await blobOf(l.maskCanvas), "motion_object.png"); l.maskDirty = false; }
  }
  const planOf = () => ({ picture: { ref: m.ref, url: m.url, name: m.name }, plate: m.plateRef, hold: m.hold,
    layers: m.layers.map(l => ({ name: l.name, mask: l.mask, keys: structuredClone(l.keys), adj: { ...l.adj }, edited: !!l.edited })) });
  // The request's layers for `seconds` of a plan: each object's move, size, flips and turn in every frame, and colour.
  function layerFrames(plan, seconds) {
    const n = window.H3Prompt.h3Length(+seconds || 3);
    return plan.layers.map(l => ({ mask: l.mask, adjust: adjDefault(l.adj) ? null : { ...l.adj },
      frames: Array.from({ length: n }, (_, f) => { const p = at(l, f / FPS); return [+p.x.toFixed(5), +p.y.toFixed(5), +p.s.toFixed(4), p.f ? 1 : 0, +p.r.toFixed(2), p.v ? 1 : 0]; }) }));
  }
  /* H3 starts from the picture, unless an object is already changed at the start (moved, sized, turned, flipped,
     recoloured or partly erased): then from the rough animation's own first frame, so the two agree. */
  function firstOf(plan) {
    const changed = plan.layers.some(l => {
      const p = at(l, 0);
      return l.edited || !adjDefault(l.adj) || Math.abs(p.x) > 1e-4 || Math.abs(p.y) > 1e-4 || Math.abs(p.s - 1) > 1e-3 || Math.abs(p.r) > 0.05 || p.f || p.v;
    });
    return changed ? "composite" : "picture";
  }
  async function use() {
    m.busy = "Saving…"; renderSide();
    try { await saveMasks(); } catch (e) { Media.toast(`Couldn't save an erased object: ${e.message}`); m.busy = ""; return renderSide(); }
    const plan = planOf(), cb = m.onUse;
    cb?.(plan);  // first: closing the window may reopen the shot, which should show the plan
    m?.win.close();
  }

  /* ---------------------------------------------------------------- generate */
  async function generate() {
    if (m.onUse) return use();
    const n = frames(), iw = m.pic.width, ih = m.pic.height;
    try { await saveMasks(); } catch (e) { return Media.toast(`Couldn't save an erased object: ${e.message}`); }
    const plan = planOf(), layers = layerFrames(plan, m.seconds);
    const names = m.layers.map(l => l.name);
    const what = m.prompt.trim() || `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} move${names.length > 1 ? "" : "s"} through the scene.`;
    const prompt = `integrated_multimodal_description: [Shot 1] ${what.replace(/\s+/g, " ")} The camera holds a static shot.\n\noverall_soundscape: Natural sound of the scene.\n\nnon_diegetic_music: N/A`;
    m.busy = "Sending to H3…"; renderSide();
    try {
      await submit({ kind: "video", engine: "motion", prompt, seconds: n / FPS, aspect: "16:9", quality: m.quality, seed: -1, batch: 1, turbo: true,
        first_frame: m.ref, motion_plate: m.plateRef, motion_layers: layers, motion_hold: m.hold, motion_first: firstOf(plan), project: m.project });
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
    for (let i = m.layers.length - 1; i >= 0; i--) {
      const b = placed(m.layers[i], m.t, v), [lx, ly] = local(b, x, y);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return i;
    }
    return -1;
  }
  function onDown(e) {
    if (m.busy || m.playing || e.button === 2) return;
    closeMenu();
    if (m.erasing) {
      const lay = m.layers[m.erasing.i]; if (!lay) return stopErase();
      const r = m.canvas.getBoundingClientRect(), paint = ev => { eraseAt(lay, ev.clientX - r.left, ev.clientY - r.top); draw(); };
      paint(e);
      const up = () => { window.removeEventListener("pointermove", paint); window.removeEventListener("pointerup", up); refresh(); };
      window.addEventListener("pointermove", paint); window.addEventListener("pointerup", up);
      return;
    }
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
  /* A path tracked in a video becomes the selected object's path: its moves (shares of that video's frame, so
     shares of this picture's) and size, keyed in the same curve. The shot gets as long as the path, up to 10 s. */
  function applyTrack(id) {
    const tr = m.tracks.find(x => x.id === id), lay = m.layers[m.sel];
    if (!tr || !lay) return;
    const flip = !!lay.keys[0]?.f;
    lay.keys = tr.keys.filter(k => k.t <= 10 + 1e-6).map(k => ({ t: k.t, x: k.x, y: k.y, s: Math.max(0.05, k.s), f: flip }));
    if (!lay.keys.length || lay.keys[0].t > 0) lay.keys.unshift({ t: 0, x: 0, y: 0, s: 1, f: flip });
    const want = Math.max(2, Math.min(10, Math.ceil(tr.duration * 2) / 2));
    if (want !== m.seconds) { m.seconds = want; $("#mo-sec").value = String(want); }
    m.t = 0;
    Media.toast(`${lay.name} now follows “${tr.name}” (${lay.keys.length} keys, ${tr.duration.toFixed(1)} s). Drag or change keys to adjust it.`);
    refresh();
  }
  async function loadTracks() {
    try { m.tracks = (await api("/api/tracks")).tracks || []; } catch { m.tracks = []; }
    if (m) renderSide();
  }

  /* The picture as a 3D scene (scene3d.js): its objects, with any 3D models already made from them, over the empty
     background when there is one. */
  async function openScene() {
    try { await saveMasks(); } catch (e) { return Media.toast(`Couldn't save an object: ${e.message}`); }
    let made = [];
    try { made = (await api("/api/models3d")).models || []; } catch { /* none */ }
    const objects = m.layers.map(l => {
      const md = made.find(x => x.source === m.ref && x.mask === l.mask && x.status !== "failed");
      return { name: l.name, mask: l.mask, model: md?.id || null };
    });
    Scene3D.create({ ref: m.ref, url: m.url, name: m.name.replace(/\.[^.]+$/, ""), plate: m.plateRef && !m.plateStale ? m.plateRef : null, objects });
  }

  /* opts (the Shots step): plan = a shot's saved plan to reopen; seconds = the shot's length; onUse(plan) = save it
     to the shot instead of generating (the shot's own text, length and settings make the video). */
  async function open(src, opts = {}) {
    if (m?.win) m.win.close();
    const pic = await loadImg(src.url);
    const shot = !!opts.onUse;
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
        <div class="mo-erase-bar" hidden>✎ Erasing parts of <b class="mo-erase-name"></b>: paint over what to take out.
          <label>Brush <input type="range" id="mo-brush" min="6" max="80" step="1" value="24"></label>
          <button type="button" class="btn sm primary" data-act="erase-done">Done</button></div>
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
        <section><h3>3D</h3>
          <p class="hint">The picture in depth with its objects as 3D models, seen through its own camera. Make the empty background first so they don't show twice.</p>
          <div class="mo-row"><button type="button" class="btn sm" data-act="scene3d">🏞 Open as a 3D scene</button></div></section>
        <section class="mo-path" hidden><h3 class="mo-path-h"></h3>
          <p class="hint mo-keyhint"></p>
          <div class="mo-keys"></div>
          <div class="field"><label for="mo-scale">Size <span class="mo-scale-v"></span></label><input type="range" id="mo-scale" min="0.2" max="3" step="0.01"></div>
          <div class="field"><label for="mo-rot">Turn <span class="mo-rot-v"></span></label><input type="range" id="mo-rot" min="-180" max="180" step="1"></div>
          <label class="check"><input type="checkbox" id="mo-flip"> Flipped</label> <label class="check"><input type="checkbox" id="mo-flipv"> Upside down</label>
          <div class="field mo-track"><label for="mo-track">Use a tracked path <span class="opt">from 🎯 Track an object, on a video</span></label>
            <div class="mo-find"><select id="mo-track"></select><button type="button" class="btn sm" data-act="apply-track">Use</button></div></div></section>
        <section${shot ? " hidden" : ""}><h3>Shot</h3>
          <div class="row2"><div class="field"><label for="mo-sec">Length</label><div class="sm-sec"><input type="number" id="mo-sec" min="2" max="10" step="0.5" value="3"> s</div></div>
            <div class="field"><label for="mo-q">Quality</label><select id="mo-q"><option value="draft">Draft</option><option value="standard">Standard</option><option value="full">Full</option></select></div></div>
          <div class="field"><label for="mo-what">What happens <span class="opt">optional</span></label>
            <textarea id="mo-what" rows="3" placeholder="The red car drives off to the right, its wheels spinning."></textarea></div>
          <div class="field"><label for="mo-hold">Follow the path</label><select id="mo-hold" title="How long the objects are held to their paths before H3 is free to redraw them">
            <option value="loose">Loosely (more natural, may wander)</option><option value="normal" selected>Normally</option><option value="tight">Tightly (may look pasted on)</option></select></div></section>
        ${shot ? `<section><h3>This shot</h3><p class="hint">The shot's own text, length (${(+opts.seconds || 3).toFixed(1)} s) and settings make the video; here are its objects and their paths.</p>
          <div class="field"><label for="mo-hold2">Follow the path</label><select id="mo-hold2">
            <option value="loose">Loosely (more natural, may wander)</option><option value="normal">Normally</option><option value="tight">Tightly (may look pasted on)</option></select></div></section>` : ""}
      </aside>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="mo-foot-st hint"></span><button type="button" class="btn primary" data-act="generate">${shot ? "Use for this shot" : "Generate"}</button>`;
    const win = WM.open({ id: "motion", title: `Animate objects · ${src.name || src.ref.split("/").pop()}`, content: root, footer: foot,
      width: 1100, height: 720, minWidth: 760, minHeight: 520, onClose: () => { m = null; opts.onClose?.(); } });
    m = { win, root: win.el, canvas: root.querySelector(".mo-canvas"), pic, ref: src.ref, url: src.url, name: src.name || src.ref.split("/").pop(),
      project: state.project?.id ?? null, onUse: opts.onUse || null,
      layers: [], tracks: [], sel: -1, t: 0, seconds: shot ? Math.max(1, +opts.seconds || 3) : 3, quality: "draft", hold: "normal", prompt: "", plateRef: "", plateImg: null, showPlate: false };
    const all = [root, foot];
    const on = (ev, fn) => all.forEach(el => el.addEventListener(ev, fn));
    on("click", e => {
      const b = e.target.closest("[data-act],[data-key],.mo-layers li[data-i]"); if (!b) return;
      const a = b.dataset.act;
      if (a === "play") return play();
      if (a === "find") { const w = $("#mo-word").value.trim(); if (w) addLayer({ text: w }, w.replace(/^(the|a|an)\s+/i, "")); return; }
      if (a === "pick") { m.picking = !m.picking; return refresh(); }
      if (a === "plate") return makePlate();
      if (a === "scene3d") return openScene();
      if (a === "generate") return generate();
      if (a === "del-layer") { m.layers.splice(+b.dataset.i, 1); m.sel = Math.min(m.sel, m.layers.length - 1); if (m.plateRef) m.plateStale = true; return refresh(); }
      if (a === "del-key") { m.layers[m.sel].keys.splice(+b.dataset.key, 1); return refresh(); }
      if (a === "apply-track") return applyTrack($("#mo-track").value);
      if (a === "erase-done") return stopErase();
      if (b.dataset.key != null) { m.t = m.layers[m.sel].keys[+b.dataset.key].t; return refresh(); }
      if (b.dataset.i != null) { m.sel = +b.dataset.i; return refresh(); }
    });
    on("input", e => {
      const id = e.target.id, lay = m.layers[m.sel];
      if (e.target.classList.contains("mo-scrub")) { m.t = Math.round(+e.target.value * FPS) / FPS; m.playing = false; return refresh(); }
      if (id === "mo-scale" && lay) { keyAt(lay, m.t, true).s = +e.target.value; return refresh(); }
      if (id === "mo-flip" && lay) { keyAt(lay, m.t, true).f = e.target.checked; return refresh(); }
      if (id === "mo-flipv" && lay) { keyAt(lay, m.t, true).v = e.target.checked; return refresh(); }
      if (id === "mo-rot" && lay) { keyAt(lay, m.t, true).r = +e.target.value; return refresh(); }
      if (id === "mo-brush" && m.erasing) { m.erasing.size = +e.target.value; return; }
      if (id === "mo-showplate") { m.showPlate = e.target.checked; return draw(); }
      if (id === "mo-sec") { m.seconds = Math.max(2, Math.min(10, +e.target.value || 3)); m.t = Math.min(m.t, dur()); return refresh(); }
      if (id === "mo-q") m.quality = e.target.value;
      if (id === "mo-hold" || id === "mo-hold2") m.hold = e.target.value;
      if (id === "mo-what") m.prompt = e.target.value;
    });
    root.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "mo-word") { e.preventDefault(); root.querySelector('[data-act="find"]').click(); } });
    m.canvas.addEventListener("pointerdown", onDown);
    m.canvas.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (m.busy || m.playing) return;
      const i = hit(e);
      if (i >= 0) openMenu(i, e.clientX, e.clientY); else closeMenu();
    });
    m.root.addEventListener("pointerdown", e => { if (!e.target.closest(".mo-menu, .mo-canvas")) closeMenu(); });
    m.root.addEventListener("keydown", e => { if (e.key === "Escape" && (m.root.querySelector(".mo-menu") || m.erasing)) { e.stopPropagation(); closeMenu(); stopErase(); } }, true);
    new ResizeObserver(() => m && draw()).observe(m.canvas);
    if (shot) { const h = root.querySelector("#mo-hold2"); if (h) h.value = opts.plan?.hold || "normal"; m.hold = opts.plan?.hold || "normal"; }
    refresh();
    loadTracks();
    if (opts.plan) await restore(opts.plan);
  }
  // Reopen a shot's plan: its objects (from their masks) with their keys, and its empty background.
  async function restore(plan) {
    m.busy = "Loading the shot's objects…"; renderSide();
    try {
      for (const l of plan.layers || []) {
        const lay = layerFrom(await loadImg(mediaUrl(l.mask)), l.mask, l.name, l.keys);
        if (lay) { lay.adj = { hue: 0, sat: 1, bri: 1, ...(l.adj || {}) }; lay.edited = !!l.edited; recolor(lay); m.layers.push(lay); }
      }
      m.sel = m.layers.length ? 0 : -1;
      if (plan.plate) { m.plateImg = await loadImg(mediaUrl(plan.plate)); m.plateRef = plan.plate; m.showPlate = true; $("#mo-showplate").checked = true; }
    } catch (e) { Media.toast(`Couldn't load all of the shot's objects: ${e.message}`); }
    finally { if (m) { m.busy = ""; refresh(); } }
  }

  return { open, layerFrames, firstOf, _state: () => m };
})();
