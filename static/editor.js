/* Image editor: opens over the stage (the timeline hides) for a generated picture.

   Toolbar: Move · Crop · Resize · Adjust · Select, with Undo / Redo, Fit / 100 %, and
   "Save as new result". Crop, resize, rotate, flip and the color adjustments (brightness,
   contrast, saturation, hue, grayscale, sepia) run here on a canvas. The Select tool paints a
   selection: Rectangle, Square, Ellipse, Circle, Lasso and Magic wand (Shift adds, Alt subtracts,
   both intersect), Brush and Eraser by hand, or AI select, where SAM 3.1 (POST /api/edit/select)
   turns a stroke (or words) into the object's outline. The selection shows as marching ants on an
   overlay canvas. With a selection, the AI edits run as studio
   jobs (engine "imgedit", app/workflows.build_imgedit):
     Erase                   Qwen Image Edit 2511 fills it with the background
     Replace with…           Qwen Image Edit 2511 puts something else there
     Change with a prompt    Krea 2 redraws it, as much as the strength allows
     Remove background       BiRefNet / u2net, to transparent, white or black (no selection needed)
   Each AI result is a result in the gallery and becomes the editor's picture (Undo goes back). */
"use strict";

const Editor = (() => {
  const MAX_HISTORY = 24;
  const ASPECTS = [["free", "Free"], ["orig", "Original"], ["1:1", "1:1"], ["4:3", "4:3"], ["3:2", "3:2"], ["16:9", "16:9"],
    ["3:4", "3:4"], ["2:3", "2:3"], ["9:16", "9:16"]];
  const ADJ = [["brightness", "Brightness", 0, 200, 100, "%"], ["contrast", "Contrast", 0, 200, 100, "%"],
    ["saturate", "Saturation", 0, 300, 100, "%"], ["hue", "Hue", -180, 180, 0, "°"],
    ["grayscale", "Grayscale", 0, 100, 0, "%"], ["sepia", "Sepia", 0, 100, 0, "%"]];
  const svg = d => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
  // [mode, icon, label, tooltip]
  const SEL_MODES = [
    ["rect", svg('<rect x="1.5" y="3.5" width="13" height="9"/>'), "Rectangle", "Drag a rectangle (M)"],
    ["square", svg('<rect x="3" y="3" width="10" height="10"/>'), "Square", "Drag a square"],
    ["lasso", svg('<path d="M8 2.8c3.6 0 6.2 1.6 6.2 3.7S11.6 10 8.4 10C5 10 1.8 8.7 1.8 6.5 1.8 4.4 4.5 2.8 8 2.8zM5.2 9.6c-.9 1.3-.6 2.7.9 3.6"/>'), "Lasso", "Draw around an area freehand (L)"],
    ["ellipse", svg('<ellipse cx="8" cy="8" rx="6.5" ry="4.3"/>'), "Ellipse", "Drag an ellipse (O)"],
    ["circle", svg('<circle cx="8" cy="8" r="5.6"/>'), "Circle", "Drag a circle"],
    ["wand", "🪄", "Magic wand", "Click a color: selects the area of similar color (W)"],
    ["ai", "✨", "AI select", "Paint over an object: AI selects all of it"],
    ["brush", "🖌", "Brush", "Paint the selection by hand (B)"],
    ["erase", "⌫", "Eraser", "Take away from the selection by hand (E)"],
  ];
  const SHAPES = new Set(["rect", "square", "ellipse", "circle"]);
  const COMBINING = new Set([...SHAPES, "lasso", "wand"]);
  const COMBINES = [["new", "New", "Replace the selection"], ["add", "Add", "Add to the selection (or hold Shift)"],
    ["sub", "Subtract", "Take away from the selection (or hold Alt)"], ["int", "Intersect", "Keep only the overlap (or hold Shift + Alt)"]];
  const SEL_HINTS = {
    ai: ["Paint a stroke over the object. Alt + stroke takes it away from the selection.", "Paint over an object · Alt subtracts"],
    brush: ["Paint the area to change. [ and ] change the brush size.", "Paint the selection"],
    erase: ["Paint over the selection to take parts away. [ and ] change the brush size.", "Erase from the selection"],
    shape: ["Drag over the picture. Shift + drag adds, Alt + drag subtracts. A click without dragging deselects (so does Ctrl+D).", "Drag · Shift adds · Alt subtracts"],
    lasso: ["Hold the button and draw around the area; it closes itself when you let go. Shift adds, Alt subtracts.", "Draw around the area · Shift adds · Alt subtracts"],
    feather: "Feather softens the selection's edge over this many pixels, so AI edits blend in. It applies to new selections (not the brush); Feather now softens the current one.",
    wand: ["Click a color to select the area of similar color. A higher tolerance takes in more shades; Contiguous keeps to the touching area. Shift + click adds, Alt + click subtracts.", "Click a color · Shift adds · Alt subtracts"],
  };
  const selHint = m => SEL_HINTS[SHAPES.has(m) ? "shape" : m] || SEL_HINTS.ai;
  let ed = null;  // the open editor's state

  /* ---------------------------------------------------------------- helpers */
  const mk = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });
  const clone = c => { const n = mk(c.width, c.height); n.getContext("2d").drawImage(c, 0, 0); return n; };
  const loadImg = url => new Promise((res, rej) => {
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => res(im); im.onerror = () => rej(new Error("Couldn't load the picture")); im.src = url;
  });
  const canvasBlob = c => new Promise(res => c.toBlob(res, "image/png"));
  const filterCss = a => `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturate}%) hue-rotate(${a.hue}deg) grayscale(${a.grayscale}%) sepia(${a.sepia}%)`;
  const adjDefault = () => Object.fromEntries(ADJ.map(([k, , , , d]) => [k, d]));
  const adjChanged = a => ADJ.some(([k, , , , d]) => a[k] !== d);

  async function upload(blob, name) {
    const fd = new FormData(); fd.append("file", blob, name);
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return (await r.json()).ref;
  }

  /* ---------------------------------------------------------------- open / close */
  async function open(it) {
    const f = it?.files?.[0];
    if (!f || it.kind !== "image") return;
    if (ed) close(true);
    let img;
    try { img = await loadImg(f.url); } catch (e) { Media.toast(e.message); return; }
    const base = mk(img.naturalWidth, img.naturalHeight);
    base.getContext("2d").drawImage(img, 0, 0);
    const stage = document.querySelector(".stage");
    const root = document.getElementById("editor");
    ed = {
      item: it, project: it.project ?? state.project?.id ?? null, root, stage,
      base, ref: f.path, dirty: false,       // ref: a server copy of exactly this picture (null after a local edit)
      mask: mk(base.width, base.height), maskOn: false,
      hist: [], redo: [], tool: "select", zoom: 1, panX: 0, panY: 0,
      crop: null, aspect: "free", adj: adjDefault(), brush: 40, mode: "ai", stroke: null, busy: null,
      combine: "new", tol: 32, contiguous: true, shape: null, maskVer: 0, antsPhase: -1, raf: 0,
      feather: 0, soft: false,  // feather: px of soft edge for new selections; soft: the mask has soft edges
      fields: { bg: "transparent" },  // the side panel's text boxes and choices, kept across redraws
      ops: [],  // what was done, for the saved result's note
    };
    root.innerHTML = template(it);
    stage.classList.add("editing");
    root.hidden = false;
    bind();
    requestAnimationFrame(() => { fit(); setTool("select"); });
    ed.raf = requestAnimationFrame(antsLoop);
  }
  function close(force = false) {
    if (!ed) return;
    if (!force && ed.busy) { Media.toast("An AI edit is still running."); return; }
    if (!force && ed.dirty && !confirm("Close the editor? The changes since your last save are lost.")) return;
    ed.root.hidden = true; ed.root.innerHTML = "";
    ed.stage.classList.remove("editing");
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", draw);
    cancelAnimationFrame(ed.raf);
    ed = null; pixCache = null; edgeKey = "";
  }

  function template(it) {
    const tool = (k, ico, label, tip) => `<button type="button" class="ed-tool" data-tool="${k}" title="${tip}"><span>${ico}</span>${label}</button>`;
    return `
      <div class="ed-bar" role="toolbar" aria-label="Image editor">
        <button type="button" class="btn sm ghost" data-ed="close" title="Close the editor (Esc)">✕ Close</button>
        <span class="ed-title" title="${esc(it.files[0].name)}">✏ Edit picture</span>
        <span class="ed-sep"></span>
        ${tool("move", "✋", "Move", "Pan and zoom (wheel zooms anywhere)")}
        ${tool("crop", "✂", "Crop", "Crop to an area or an aspect ratio")}
        ${tool("resize", "⤢", "Resize", "Change the size, rotate or flip")}
        ${tool("adjust", "🎨", "Adjust", "Brightness, contrast, saturation, hue")}
        ${tool("select", "⬚", "Select + AI", "Select an area (rectangle, ellipse, lasso, magic wand, brush or AI), then erase, replace or change it")}
        <span class="ed-sep"></span>
        <button type="button" class="ex-btn" data-ed="undo" title="Undo (Ctrl+Z)">↶</button>
        <button type="button" class="ex-btn" data-ed="redo" title="Redo (Ctrl+Y)">↷</button>
        <button type="button" class="ex-btn" data-ed="fit" title="Fit to the window (F)">Fit</button>
        <button type="button" class="ex-btn" data-ed="actual" title="Actual pixels (1)">100%</button>
        <span class="ex-gap"></span>
        <button type="button" class="btn sm primary" data-ed="save" title="Save the picture as a new result in the gallery (Ctrl+S)">💾 Save as new result</button>
      </div>
      <div class="ed-body">
        <div class="ed-wrap"><canvas class="ed-view"></canvas><canvas class="ed-over" aria-hidden="true"></canvas>
          <div class="ed-busy" hidden><div class="ed-busy-box"><b class="ed-busy-label"></b>
            <div class="bar"><i></i></div><button type="button" class="btn sm" data-ed="cancel-ai">Cancel</button></div></div>
        </div>
        <aside class="ed-side" aria-label="Tool options"></aside>
      </div>
      <div class="ed-status"><span class="ed-dims"></span><span class="ed-zoom"></span><span class="ed-hint"></span></div>`;
  }

  /* ---------------------------------------------------------------- view */
  const $e = s => ed.root.querySelector(s);
  function viewSize() { const w = $e(".ed-wrap"); return [w.clientWidth, w.clientHeight]; }
  function fit() {
    const [vw, vh] = viewSize();
    ed.zoom = Math.min(1, (vw - 40) / ed.base.width, (vh - 40) / ed.base.height);
    ed.panX = (vw - ed.base.width * ed.zoom) / 2; ed.panY = (vh - ed.base.height * ed.zoom) / 2;
    draw();
  }
  function actual() {
    const [vw, vh] = viewSize();
    ed.zoom = 1; ed.panX = (vw - ed.base.width) / 2; ed.panY = (vh - ed.base.height) / 2; draw();
  }
  function zoomAt(f, cx, cy) {
    const z = Math.max(0.05, Math.min(16, ed.zoom * f));
    ed.panX = cx - (cx - ed.panX) * z / ed.zoom; ed.panY = cy - (cy - ed.panY) * z / ed.zoom; ed.zoom = z; draw();
  }
  const toImg = (x, y) => [(x - ed.panX) / ed.zoom, (y - ed.panY) / ed.zoom];

  let tint = null;  // the selection, colored, at picture size
  function maskChanged() {
    const m = ed.mask, t = tint && tint.width === m.width && tint.height === m.height ? tint : (tint = mk(m.width, m.height));
    const g = t.getContext("2d");
    g.globalCompositeOperation = "copy"; g.drawImage(m, 0, 0);
    g.globalCompositeOperation = "source-in"; g.fillStyle = "rgba(255, 122, 69, .32)"; g.fillRect(0, 0, t.width, t.height);
    g.globalCompositeOperation = "source-over";
    ed.maskOn = hasMask(); ed.maskVer++;
    renderSide(); draw();
  }
  function hasMask() {
    const s = 64, c = mk(s, s), g = c.getContext("2d");
    g.drawImage(ed.mask, 0, 0, s, s);
    const d = g.getImageData(0, 0, s, s).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
    return false;
  }

  let checkerTile = null;
  function checker(g) {
    if (!checkerTile) {
      checkerTile = mk(16, 16); const c = checkerTile.getContext("2d");
      c.fillStyle = "#2b2e35"; c.fillRect(0, 0, 16, 16); c.fillStyle = "#3a3e47"; c.fillRect(0, 0, 8, 8); c.fillRect(8, 8, 8, 8);
    }
    return g.createPattern(checkerTile, "repeat");
  }
  function draw() {
    if (!ed) return;
    const cv = $e(".ed-view"), [vw, vh] = viewSize(), dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(vw * dpr) || cv.height !== Math.round(vh * dpr)) {
      cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr); cv.style.width = vw + "px"; cv.style.height = vh + "px";
    }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, vw, vh);
    g.save();
    g.translate(ed.panX, ed.panY); g.scale(ed.zoom, ed.zoom);
    g.imageSmoothingEnabled = ed.zoom < 2; g.imageSmoothingQuality = "high";
    // A checkerboard under the picture, so transparent areas show as such.
    g.fillStyle = checker(g); g.fillRect(0, 0, ed.base.width, ed.base.height);
    if (ed.tool === "adjust" && adjChanged(ed.adj)) g.filter = filterCss(ed.adj);
    g.drawImage(ed.base, 0, 0);
    g.filter = "none";
    if (ed.maskOn && tint && ed.tool === "select") g.drawImage(tint, 0, 0);
    if (ed.stroke && ed.mode === "ai") {
      g.strokeStyle = "rgba(122, 162, 255, .9)"; g.lineWidth = Math.max(3, ed.brush / 3) ; g.lineCap = g.lineJoin = "round";
      g.beginPath(); ed.stroke.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
    }
    g.restore();
    if (ed.tool === "crop" && ed.crop) drawCrop(g);
    if (ed.tool === "select" && ed.cursor && (ed.mode === "brush" || ed.mode === "erase")) {
      g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 1;
      g.beginPath(); g.arc(ed.cursor[0], ed.cursor[1], ed.brush * ed.zoom / 2, 0, Math.PI * 2); g.stroke();
    }
    $e(".ed-dims").textContent = `${ed.base.width} × ${ed.base.height}`;
    $e(".ed-zoom").textContent = `${Math.round(ed.zoom * 100)}%`;
    $e('[data-ed="undo"]').disabled = !ed.hist.length || !!ed.busy;
    $e('[data-ed="redo"]').disabled = !ed.redo.length || !!ed.busy;
    drawOverlay();
  }

  /* ---------------------------------------------------------------- marching ants
     The selection's outline, on a canvas over the picture: the mask drawn at screen size, minus
     itself shrunk by a pixel, leaves the edge; a moving diagonal black-and-white pattern fills it. */
  let edgeKey = "", edgeS = null, edgeI = null, antsTile = null;
  const stillAnts = () => document.documentElement.dataset.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  function antsPattern() {
    if (antsTile) return antsTile;
    antsTile = mk(8, 8);
    const g = antsTile.getContext("2d"), d = g.createImageData(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4, v = (x + y) % 8 < 4 ? 255 : 0;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255;
    }
    g.putImageData(d, 0, 0);
    return antsTile;
  }
  function edges(W, H, dpr) {
    const key = `${ed.maskVer}|${ed.zoom}|${ed.panX}|${ed.panY}|${W}|${H}`;
    if (key === edgeKey && edgeS) return edgeS;
    edgeKey = key;
    for (const c of [edgeS ||= mk(W, H), edgeI ||= mk(W, H)]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const sg = edgeS.getContext("2d"), ig = edgeI.getContext("2d");
    sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalCompositeOperation = "source-over"; sg.clearRect(0, 0, W, H);
    sg.imageSmoothingEnabled = false;
    sg.setTransform(dpr * ed.zoom, 0, 0, dpr * ed.zoom, dpr * ed.panX, dpr * ed.panY);
    sg.drawImage(ed.soft ? hardMask() : ed.mask, 0, 0);
    sg.setTransform(1, 0, 0, 1, 0, 0);
    ig.globalCompositeOperation = "copy"; ig.drawImage(edgeS, 0, 0);
    ig.globalCompositeOperation = "destination-in";
    const k = Math.max(1, Math.round(dpr));
    for (const [dx, dy] of [[k, 0], [-k, 0], [0, k], [0, -k]]) ig.drawImage(edgeS, dx, dy);
    sg.globalCompositeOperation = "destination-out"; sg.drawImage(edgeI, 0, 0);
    sg.globalCompositeOperation = "source-over";
    return edgeS;
  }
  // A feathered selection's ants run along its half-way line, as in other editors.
  let hardVer = -1, hardC = null;
  function hardMask() {
    if (hardVer === ed.maskVer && hardC) return hardC;
    const m = ed.mask, W = m.width, H = m.height;
    if (!hardC || hardC.width !== W || hardC.height !== H) hardC = mk(W, H);
    const d = m.getContext("2d").getImageData(0, 0, W, H), o = new Uint32Array(d.data.buffer);
    for (let i = 0; i < o.length; i++) o[i] = (o[i] >>> 24) >= 128 ? 0xffffffff : 0;
    hardC.getContext("2d").putImageData(d, 0, 0);
    hardVer = ed.maskVer;
    return hardC;
  }
  const antsNow = () => stillAnts() ? 0 : Math.floor(performance.now() / 110) % 8;
  function drawOverlay() {
    if (!ed) return;
    const ov = $e(".ed-over"), [vw, vh] = viewSize(), dpr = devicePixelRatio || 1;
    const W = Math.round(vw * dpr), H = Math.round(vh * dpr);
    if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; ov.style.width = vw + "px"; ov.style.height = vh + "px"; }
    const g = ov.getContext("2d"), t = ed.antsPhase = antsNow();
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    if (ed.maskOn && ed.tool !== "crop") {
      g.drawImage(edges(W, H, dpr), 0, 0);
      const pat = g.createPattern(antsPattern(), "repeat");
      pat.setTransform(new DOMMatrix([1, 0, 0, 1, t, 0]));
      g.globalCompositeOperation = "source-in"; g.fillStyle = pat; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    }
    if (ed.shape) {  // the shape being drawn
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      tracePath(g, ed.shape, ([x, y]) => [ed.panX + x * ed.zoom, ed.panY + y * ed.zoom]);
      g.lineWidth = 1; g.strokeStyle = "#000"; g.setLineDash([]); g.stroke();
      g.strokeStyle = "#fff"; g.setLineDash([4, 4]); g.lineDashOffset = -t; g.stroke(); g.setLineDash([]);
      if (ed.shape.mode !== "lasso") {
        const b = shapeBox(ed.shape), [sx, sy] = [ed.panX + (b.x + b.w) * ed.zoom, ed.panY + (b.y + b.h) * ed.zoom];
        const label = `${Math.round(b.w)} × ${Math.round(b.h)}`;
        g.font = "11px system-ui, sans-serif";
        const tw = g.measureText(label).width;
        g.fillStyle = "rgba(0,0,0,.7)"; g.fillRect(sx + 6, sy + 6, tw + 10, 18);
        g.fillStyle = "#fff"; g.fillText(label, sx + 11, sy + 19);
      }
    }
  }
  function antsLoop() {
    if (!ed) return;
    if ((ed.maskOn || ed.shape) && antsNow() !== ed.antsPhase) drawOverlay();
    ed.raf = requestAnimationFrame(antsLoop);
  }

  /* ---------------------------------------------------------------- history */
  function snapshot() { return { base: ed.base, ref: ed.ref, mask: clone(ed.mask), dirty: ed.dirty, item: ed.item, soft: ed.soft }; }
  function restore(s) {
    const resized = s.base.width !== ed.base.width || s.base.height !== ed.base.height;
    ed.base = s.base; ed.ref = s.ref; ed.mask = s.mask; ed.dirty = s.dirty; ed.item = s.item; ed.soft = !!s.soft;
    ed.crop = ed.tool === "crop" ? { x: 0, y: 0, w: s.base.width, h: s.base.height } : null;
    maskChanged();
    if (resized) fit();
  }
  // A new picture: remember the old one for Undo. ref: its server copy, if it has one.
  function commit(canvas, { ref = null, item = null, op = "", keepMask = false } = {}) {
    ed.hist.push(snapshot()); if (ed.hist.length > MAX_HISTORY) ed.hist.shift();
    ed.redo = [];
    ed.base = canvas; ed.ref = ref; ed.dirty = !ref || !item; if (item) ed.item = item;
    if (op) ed.ops.push(op);
    if (!keepMask || ed.mask.width !== canvas.width || ed.mask.height !== canvas.height) { ed.mask = mk(canvas.width, canvas.height); ed.soft = false; }
    ed.crop = ed.tool === "crop" ? { x: 0, y: 0, w: canvas.width, h: canvas.height } : null;
    maskChanged();
  }
  function undo() { if (ed.busy || !ed.hist.length) return; ed.redo.push(snapshot()); restore(ed.hist.pop()); }
  function redo() { if (ed.busy || !ed.redo.length) return; ed.hist.push(snapshot()); restore(ed.redo.pop()); }

  /* ---------------------------------------------------------------- tools */
  function setTool(t) {
    if (ed.busy) return;
    ed.tool = t;
    ed.root.querySelectorAll(".ed-tool").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
    if (t === "crop" && !ed.crop) ed.crop = { x: 0, y: 0, w: ed.base.width, h: ed.base.height };
    if (t !== "adjust") ed.adj = adjDefault();
    renderSide(); draw();
    $e(".ed-view").style.cursor = t === "move" ? "grab" : t === "select" ? (ed.mode === "brush" || ed.mode === "erase" ? "none" : "crosshair") : "default";
  }

  function renderSide() {
    if (!ed) return;
    const side = $e(".ed-side"), t = ed.tool, caps = state.caps?.editor || {};
    const fv = k => esc(ed.fields[k] || "");
    const hint = s => { $e(".ed-hint").textContent = s; };
    if (t === "move") {
      side.innerHTML = `<h4>Move</h4><p class="hint">Drag to pan, wheel to zoom at the pointer. In every tool, the wheel zooms and the middle button (or Space + drag) pans.</p>`;
      hint("Drag to pan · wheel to zoom");
    } else if (t === "crop") {
      const c = ed.crop;
      side.innerHTML = `<h4>Crop</h4>
        <label class="ed-l">Aspect ratio<select data-k="aspect">${ASPECTS.map(([v, l]) => `<option value="${v}"${v === ed.aspect ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <p class="ed-val">${Math.round(c.w)} × ${Math.round(c.h)} px</p>
        <div class="ed-row"><button type="button" class="btn sm primary" data-ed="crop-apply">Apply crop</button><button type="button" class="btn sm" data-ed="crop-reset">Reset</button></div>
        <p class="hint">Drag inside the box to move it, its edges and corners to resize. Enter applies.</p>`;
      hint("Drag the box · Enter applies");
    } else if (t === "resize") {
      side.innerHTML = `<h4>Resize</h4>
        <div class="ed-row"><label class="ed-l">Width<input type="number" min="16" max="16384" data-k="rw" value="${ed.base.width}"></label>
        <label class="ed-l">Height<input type="number" min="16" max="16384" data-k="rh" value="${ed.base.height}"></label></div>
        <label class="ed-chk"><input type="checkbox" data-k="lock" checked> Keep the proportions</label>
        <div class="ed-row wrap">${[25, 50, 75, 150, 200].map(p => `<button type="button" class="chip-btn" data-pct="${p}">${p}%</button>`).join("")}</div>
        <button type="button" class="btn sm primary" data-ed="resize-apply">Apply size</button>
        <h4>Rotate and flip</h4>
        <div class="ed-row wrap"><button type="button" class="btn sm" data-ed="rot-l" title="Rotate left">⟲ 90°</button><button type="button" class="btn sm" data-ed="rot-r" title="Rotate right">⟳ 90°</button>
        <button type="button" class="btn sm" data-ed="flip-h">⇋ Flip</button><button type="button" class="btn sm" data-ed="flip-v">⇵ Flip</button></div>`;
      hint("Resampled with high quality");
    } else if (t === "adjust") {
      side.innerHTML = `<h4>Adjust colors</h4>${ADJ.map(([k, l, mn, mx, , u]) => `<label class="ed-l ed-slider">${l} <span class="ed-v" data-v="${k}">${ed.adj[k]}${u}</span>
          <input type="range" min="${mn}" max="${mx}" value="${ed.adj[k]}" data-adj="${k}"></label>`).join("")}
        <div class="ed-row"><button type="button" class="btn sm primary" data-ed="adj-apply"${adjChanged(ed.adj) ? "" : " disabled"}>Apply</button><button type="button" class="btn sm" data-ed="adj-reset">Reset</button></div>
        <p class="hint">Double-click a slider to reset it. The preview is live; Apply bakes it in.</p>`;
      hint("Adjust, then Apply");
    } else if (t === "select") {
      const m = ed.mode, on = ed.maskOn, busy = !!ed.busy;
      const model = editModel(caps), modelName = EDIT_MODELS.find(x => x[0] === model)[2];
      const whole = !!caps[model], sel = whole && caps.crop;
      const dis = (ok, why) => ok ? "" : ` disabled title="${why}"`;
      side.innerHTML = `<h4>Select</h4>
        <div class="ed-selmodes" role="group" aria-label="Selection tool">${SEL_MODES.map(([k, ico, l, tip]) => {
          const off = k === "ai" && !caps.select;
          return `<button type="button" data-mode="${k}" class="${m === k ? "on" : ""}" aria-pressed="${m === k}"${off ? " disabled" : ""} title="${off ? "Needs a SAM 3 checkpoint" : tip}"><span>${ico}</span>${l}</button>`;
        }).join("")}</div>
        ${COMBINING.has(m) ? `<div class="seg sm ed-combine" role="group" aria-label="How a new selection combines with the current one">${COMBINES.map(([k, l, tip]) =>
          `<button type="button" data-combine="${k}" class="${ed.combine === k ? "active" : ""}" title="${tip}">${l}</button>`).join("")}</div>` : ""}
        ${m === "wand" ? `<label class="ed-l ed-slider">Tolerance <span class="ed-v">${ed.tol}</span><input type="range" min="0" max="255" value="${ed.tol}" data-k="tol"></label>
          <label class="ed-chk"><input type="checkbox" data-k="contig"${ed.contiguous ? " checked" : ""}> Contiguous (only the touching area)</label>` : ""}
        ${m !== "brush" && m !== "erase" ? `<label class="ed-l ed-slider" title="${SEL_HINTS.feather}">Feather <span class="ed-v">${ed.feather}px</span><input type="range" min="0" max="100" value="${ed.feather}" data-k="feather" aria-label="Feather: soft edge for new selections, in pixels"></label>` : ""}
        ${["ai", "brush", "erase"].includes(m) ? `<label class="ed-l ed-slider">Brush size <span class="ed-v">${ed.brush}px</span><input type="range" min="4" max="400" value="${ed.brush}" data-k="brush"></label>` : ""}
        <div class="ed-row"><input type="text" data-k="find" value="${fv("find")}" placeholder="…or type what to select" aria-label="Select by words"${dis(caps.select, "Needs a SAM 3 checkpoint")}>
          <button type="button" class="btn sm" data-ed="find"${dis(caps.select, "Needs a SAM 3 checkpoint")}>Find</button></div>
        <div class="ed-row wrap"><button type="button" class="btn sm" data-ed="mask-clear"${dis(on, "Nothing selected")}>Clear</button>
          <button type="button" class="btn sm" data-ed="mask-invert">Invert</button><button type="button" class="btn sm" data-ed="mask-all">All</button>
          <button type="button" class="btn sm" data-ed="mask-feather"${dis(on && ed.feather > 0 && !busy, on ? "Set a Feather amount first" : "Nothing selected")} title="${on && ed.feather > 0 ? `Soften the current selection's edge by ${ed.feather}px` : ""}">Feather now</button></div>
        <p class="hint">${selHint(m)[0]}</p>

        <h4>AI edit ${on ? "" : `<span class="hint inline">(select an area first)</span>`}</h4>
        <label class="ed-l">Edit model<select data-k="edit-model" aria-label="Model for Erase, Replace and whole-picture edits">${EDIT_MODELS.map(([v, l]) =>
          `<option value="${v}"${model === v ? " selected" : ""}${caps[v] ? "" : " disabled"}>${l}${caps[v] ? "" : " (not installed)"}</option>`).join("")}</select></label>
        <div class="ed-ai">
          <button type="button" class="btn sm" data-ai="erase"${dis(on && sel && !busy, on ? `Needs ${modelName}` : "Select an area first")} title="Remove the selection and fill it with the background">🧽 Erase</button>
          <input type="text" data-k="erase-hint" value="${fv("erase-hint")}" placeholder="What is it? e.g. the blue cup (optional)" aria-label="What the selection is">
          <button type="button" class="btn sm" data-ai="replace"${dis(on && sel && !busy, on ? `Needs ${modelName}` : "Select an area first")}>🔁 Replace with…</button>
          <input type="text" data-k="replace" value="${fv("replace")}" placeholder="e.g. a vase of tulips" aria-label="Replace with">
          <button type="button" class="btn sm" data-ai="prompt"${dis(on && caps.inpaint && !busy, on ? "Needs Krea 2" : "Select an area first")}>💬 Change with a prompt</button>
          <textarea data-k="prompt" rows="2" placeholder="Describe how the selected area should look" aria-label="Prompt for the selection">${fv("prompt")}</textarea>
          <label class="ed-l ed-slider">Strength <span class="ed-v">${Math.round((ed.strength ?? 0.7) * 100)}%</span><input type="range" min="10" max="100" value="${Math.round((ed.strength ?? 0.7) * 100)}" data-k="strength"></label>
        </div>
        <h4>Edit the whole picture</h4>
        <div class="ed-ai">
          <textarea data-k="instruct" rows="2" placeholder="e.g. make it night time · turn it into a watercolor" aria-label="Instruction for the whole picture">${fv("instruct")}</textarea>
          <button type="button" class="btn sm" data-ai="instruct"${dis(whole && !busy, `Needs ${modelName}`)} title="No selection needed: the edit model changes the picture as you describe">✍ Edit with ${esc(modelName)}</button>
        </div>
        <h4>Background</h4>
        <div class="ed-row"><button type="button" class="btn sm" data-ai="remove_bg"${dis(caps.remove_bg && !busy, "Needs a background remover in ComfyUI")} title="Uses ${esc(caps.remover || "u2net")}">✂ Remove background</button>
          <select data-k="bg" aria-label="New background">${[["transparent", "Transparent"], ["white", "White"], ["black", "Black"]].map(([v, l]) => `<option value="${v}"${ed.fields.bg === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>`;
      hint(selHint(m)[1]);
    }
  }

  // [key, label in the picker, short name]
  const EDIT_MODELS = [["qwen", "Qwen Image Edit 2511 · fast", "Qwen Image Edit"],
                       ["h3image", "MiniMax H3 Image", "H3 Image"]];
  // The picked edit model, else the remembered one, else the first installed.
  function editModel(caps) {
    let v = ed.fields["edit-model"] || Settings.get("editor.edit_model");
    if (!caps[v]) v = EDIT_MODELS.find(([k]) => caps[k])?.[0] || "qwen";
    return ed.fields["edit-model"] = v;
  }

  /* ---------------------------------------------------------------- crop */
  const HANDLE = 9;
  function cropScreen() { const c = ed.crop; return [ed.panX + c.x * ed.zoom, ed.panY + c.y * ed.zoom, c.w * ed.zoom, c.h * ed.zoom]; }
  function drawCrop(g) {
    const [x, y, w, h] = cropScreen(), [vw, vh] = viewSize();
    g.fillStyle = "rgba(0,0,0,.55)";
    g.beginPath(); g.rect(0, 0, vw, vh); g.rect(x, y, w, h); g.fill("evenodd");
    g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.strokeRect(x, y, w, h);
    g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = 1;
    for (const k of [1, 2]) { g.beginPath(); g.moveTo(x + w * k / 3, y); g.lineTo(x + w * k / 3, y + h); g.moveTo(x, y + h * k / 3); g.lineTo(x + w, y + h * k / 3); g.stroke(); }
    g.fillStyle = "#fff";
    for (const [hx, hy] of cropHandles()) g.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
  }
  function cropHandles() {
    const [x, y, w, h] = cropScreen();
    return [[x, y, "nw"], [x + w / 2, y, "n"], [x + w, y, "ne"], [x + w, y + h / 2, "e"], [x + w, y + h, "se"], [x + w / 2, y + h, "s"], [x, y + h, "sw"], [x, y + h / 2, "w"]];
  }
  function ratio() {
    if (ed.aspect === "free") return 0;
    if (ed.aspect === "orig") return ed.base.width / ed.base.height;
    const [a, b] = ed.aspect.split(":").map(Number); return a / b;
  }
  function fitAspect() {
    const r = ratio(), c = ed.crop, W = ed.base.width, H = ed.base.height;
    if (!r) return;
    let w = c.w, h = w / r;
    if (h > H) { h = H; w = h * r; }
    if (w > W) { w = W; h = w / r; }
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    ed.crop = { x: Math.max(0, Math.min(W - w, cx - w / 2)), y: Math.max(0, Math.min(H - h, cy - h / 2)), w, h };
  }
  function cropDrag(kind, dx, dy, start) {
    const W = ed.base.width, H = ed.base.height, r = ratio(), min = 8;
    let { x, y, w, h } = start;
    if (kind === "move") { x = Math.max(0, Math.min(W - w, x + dx)); y = Math.max(0, Math.min(H - h, y + dy)); }
    else {
      if (kind.includes("w")) { const nx = Math.max(0, Math.min(x + w - min, x + dx)); w += x - nx; x = nx; }
      if (kind.includes("e")) w = Math.max(min, Math.min(W - x, w + dx));
      if (kind.includes("n")) { const ny = Math.max(0, Math.min(y + h - min, y + dy)); h += y - ny; y = ny; }
      if (kind.includes("s")) h = Math.max(min, Math.min(H - y, h + dy));
      if (r) {  // keep the ratio, anchored on the side opposite the dragged one
        if (kind === "n" || kind === "s") { const nw = h * r; if (x + nw > W) { w = W - x; h = w / r; } else w = nw; }
        else { const nh = w / r; if (kind.includes("n")) { const ny = y + h - nh; if (ny < 0) { h = y + h; w = h * r; y = 0; } else { y = ny; h = nh; } } else if (y + nh > H) { h = H - y; w = h * r; } else h = nh; }
      }
    }
    ed.crop = { x, y, w, h };
  }
  function applyCrop() {
    const c = ed.crop, x = Math.round(c.x), y = Math.round(c.y), w = Math.round(c.w), h = Math.round(c.h);
    if (w < 2 || h < 2 || (x === 0 && y === 0 && w === ed.base.width && h === ed.base.height)) return;
    const n = mk(w, h); n.getContext("2d").drawImage(ed.base, x, y, w, h, 0, 0, w, h);
    const m = mk(w, h); m.getContext("2d").drawImage(ed.mask, x, y, w, h, 0, 0, w, h);
    commit(n, { op: `crop ${w}×${h}` }); ed.mask = m; maskChanged();
    ed.crop = { x: 0, y: 0, w, h }; fit(); renderSide();
  }

  /* ---------------------------------------------------------------- resize, rotate, flip, adjust */
  function resample(src, w, h) {
    let cur = src;
    while (cur.width / 2 >= w && cur.height / 2 >= h) {  // halve first: smoother downscales
      const n = mk(Math.round(cur.width / 2), Math.round(cur.height / 2)), g = n.getContext("2d");
      g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, n.width, n.height); cur = n;
    }
    const out = mk(w, h), g = out.getContext("2d");
    g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, w, h);
    return out;
  }
  function applyResize() {
    const w = Math.max(16, Math.min(16384, +$e('[data-k="rw"]').value | 0)), h = Math.max(16, Math.min(16384, +$e('[data-k="rh"]').value | 0));
    if (w === ed.base.width && h === ed.base.height) return;
    commit(resample(ed.base, w, h), { op: `resize ${w}×${h}` }); fit(); renderSide();
  }
  function transform(kind) {
    const b = ed.base, rot = kind.startsWith("rot"), n = mk(rot ? b.height : b.width, rot ? b.width : b.height), g = n.getContext("2d");
    const apply = (c, src) => {
      if (kind === "rot-r") { c.translate(n.width, 0); c.rotate(Math.PI / 2); }
      if (kind === "rot-l") { c.translate(0, n.height); c.rotate(-Math.PI / 2); }
      if (kind === "flip-h") { c.translate(n.width, 0); c.scale(-1, 1); }
      if (kind === "flip-v") { c.translate(0, n.height); c.scale(1, -1); }
      c.drawImage(src, 0, 0);
    };
    apply(g, b);
    const m = mk(n.width, n.height); apply(m.getContext("2d"), ed.mask);
    commit(n, { op: kind.replace("rot-l", "rotate left").replace("rot-r", "rotate right").replace("flip-h", "flip").replace("flip-v", "flip vertically") });
    ed.mask = m; maskChanged(); fit(); renderSide();
  }
  function applyAdjust() {
    if (!adjChanged(ed.adj)) return;
    const n = mk(ed.base.width, ed.base.height), g = n.getContext("2d");
    g.filter = filterCss(ed.adj); g.drawImage(ed.base, 0, 0); g.filter = "none";
    const desc = ADJ.filter(([k, , , , d]) => ed.adj[k] !== d).map(([k, l, , , , u]) => `${l.toLowerCase()} ${ed.adj[k]}${u}`).join(", ");
    commit(n, { op: desc, keepMask: true });
    ed.adj = adjDefault(); renderSide(); draw();
  }

  /* ---------------------------------------------------------------- selection */
  function paint(points, erase) {
    const g = ed.mask.getContext("2d");
    g.save();
    g.globalCompositeOperation = erase ? "destination-out" : "source-over";
    g.strokeStyle = g.fillStyle = "#fff"; g.lineWidth = ed.brush; g.lineCap = g.lineJoin = "round";
    g.beginPath();
    points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
    if (points.length === 1) { g.arc(points[0][0], points[0][1], ed.brush / 2, 0, Math.PI * 2); g.fill(); } else g.stroke();
    g.restore();
  }
  function setMask(fn) { ed.hist.push(snapshot()); ed.redo = []; fn(ed.mask.getContext("2d")); maskChanged(); }
  const MASK_OPS = {
    clear: () => setMask(g => { g.clearRect(0, 0, ed.mask.width, ed.mask.height); ed.soft = false; }),
    all: () => setMask(g => { g.fillStyle = "#fff"; g.fillRect(0, 0, ed.mask.width, ed.mask.height); ed.soft = false; }),
    feather: () => {
      if (!ed.maskOn || !ed.feather) return;
      const s = soften(ed.mask, ed.feather);
      setMask(g => { g.save(); g.globalCompositeOperation = "copy"; g.drawImage(s, 0, 0); g.restore(); ed.soft = true; });
    },
    invert: () => setMask(g => { g.save(); g.globalCompositeOperation = "xor"; g.fillStyle = "#fff"; g.fillRect(0, 0, ed.mask.width, ed.mask.height); g.restore(); }),
  };
  // Modifier keys pick how a new selection combines: Shift adds, Alt subtracts, both intersect.
  const opFrom = e => e.shiftKey && e.altKey ? "int" : e.shiftKey ? "add" : e.altKey ? "sub" : ed.combine;
  /* Feather: blur a selection's edge over r px (a Gaussian, sigma r/2, so the soft band is about r on
     each side). The edge pixels are stretched outward first, so a selection that reaches the picture's
     border stays solid there instead of fading out. */
  function soften(c, r) {
    const W = c.width, H = c.height, p = Math.ceil(r * 1.5) + 2, P = mk(W + 2 * p, H + 2 * p), g = P.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.drawImage(c, p, p);
    g.drawImage(c, 0, 0, W, 1, p, 0, W, p); g.drawImage(c, 0, H - 1, W, 1, p, H + p, W, p);
    g.drawImage(c, 0, 0, 1, H, 0, p, p, H); g.drawImage(c, W - 1, 0, 1, H, W + p, p, p, H);
    for (const [sx, sy, dx, dy] of [[0, 0, 0, 0], [W - 1, 0, W + p, 0], [0, H - 1, 0, H + p], [W - 1, H - 1, W + p, H + p]])
      g.drawImage(c, sx, sy, 1, 1, dx, dy, p, p);
    const out = mk(W, H), og = out.getContext("2d");
    og.filter = `blur(${r / 2}px)`;
    og.drawImage(P, -p, -p);
    og.filter = "none";
    return out;
  }
  // Put a new selection (white on transparent, picture size) together with the current one.
  function combineMask(c, op) {
    if (ed.feather > 0) c = soften(c, ed.feather);
    setMask(g => {
      if (ed.feather > 0) ed.soft = true; else if (op === "new") ed.soft = false;
      g.save();
      if (op === "new") g.clearRect(0, 0, ed.mask.width, ed.mask.height);
      g.globalCompositeOperation = op === "sub" ? "destination-out" : op === "int" ? "destination-in" : "source-over";
      g.drawImage(c, 0, 0);
      g.restore();
    });
  }

  /* Rectangle, square, ellipse, circle (a box from a to b; square and circle keep it even) and lasso. */
  function shapeBox(s) {
    let [x0, y0] = s.a, [x1, y1] = s.b;
    if (s.mode === "square" || s.mode === "circle") {
      const d = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + (x1 < x0 ? -d : d); y1 = y0 + (y1 < y0 ? -d : d);
    }
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  function tracePath(g, s, f) {
    g.beginPath();
    if (s.mode === "lasso") { s.pts.forEach((p, i) => { const [x, y] = f(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); return; }
    const b = shapeBox(s), [x0, y0] = f([b.x, b.y]), [x1, y1] = f([b.x + b.w, b.y + b.h]);
    if (SHAPES.has(s.mode) && (s.mode === "rect" || s.mode === "square")) g.rect(x0, y0, x1 - x0, y1 - y0);
    else g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  }
  function finishShape(op) {
    const s = ed.shape; ed.shape = null;
    if (!s) return;
    const b = shapeBox(s);
    const tiny = s.mode === "lasso" ? s.pts.length < 3 : b.w * ed.zoom < 3 || b.h * ed.zoom < 3;
    if (tiny) {  // a click: deselect, as in other editors
      if (op === "new" && ed.maskOn) MASK_OPS.clear(); else drawOverlay();
      return;
    }
    const c = mk(ed.base.width, ed.base.height), g = c.getContext("2d");
    g.fillStyle = "#fff"; tracePath(g, s, p => p); g.fill();
    combineMask(c, op);
  }

  /* Magic wand: the pixels whose color is within the tolerance of the clicked one (each channel),
     either the area touching it (a scanline flood fill) or anywhere in the picture. */
  let pixCache = null;
  function wand([fx, fy], op) {
    const W = ed.base.width, H = ed.base.height, x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return;
    if (pixCache?.base !== ed.base) pixCache = { base: ed.base, data: ed.base.getContext("2d").getImageData(0, 0, W, H).data };
    const d = pixCache.data, tol = ed.tol, s = (y0 * W + x0) * 4;
    const r = d[s], gr = d[s + 1], b = d[s + 2], a = d[s + 3];
    const near = p => { const i = p * 4; return Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - gr) <= tol && Math.abs(d[i + 2] - b) <= tol && Math.abs(d[i + 3] - a) <= tol; };
    const out = new ImageData(W, H), o = new Uint32Array(out.data.buffer), ON = 0xffffffff;
    if (ed.contiguous) {
      const seen = new Uint8Array(W * H), stack = [x0, y0];
      while (stack.length) {
        const y = stack.pop(), x = stack.pop(), row = y * W;
        if (seen[row + x] || !near(row + x)) continue;
        let l = x, rr = x;
        while (l > 0 && !seen[row + l - 1] && near(row + l - 1)) l--;
        while (rr < W - 1 && !seen[row + rr + 1] && near(row + rr + 1)) rr++;
        for (let i = l; i <= rr; i++) { seen[row + i] = 1; o[row + i] = ON; }
        for (const ny of [y - 1, y + 1]) {
          if (ny < 0 || ny >= H) continue;
          const nrow = ny * W;
          let open = false;
          for (let i = l; i <= rr; i++) {
            const ok = !seen[nrow + i] && near(nrow + i);
            if (ok && !open) { stack.push(i, ny); open = true; } else if (!ok) open = false;
          }
        }
      }
    } else {
      for (let p = 0, n = W * H; p < n; p++) if (near(p)) o[p] = ON;
    }
    const c = mk(W, H); c.getContext("2d").putImageData(out, 0, 0);
    combineMask(c, op);
  }

  // The server needs this exact picture: upload it unless it already has a copy.
  async function sourceRef() {
    if (ed.ref) return ed.ref;
    ed.ref = await upload(await canvasBlob(ed.base), "edit.png");
    return ed.ref;
  }
  async function maskRef() {
    const m = ed.mask, c = mk(m.width, m.height), g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.drawImage(m, 0, 0);
    return upload(await canvasBlob(c), "mask.png");
  }

  async function aiSelect(points, subtract) {
    const pts = []; const step = Math.max(1, Math.floor(points.length / 12));
    for (let i = 0; i < points.length; i += step) pts.push({ x: Math.round(points[i][0]), y: Math.round(points[i][1]) });
    if (points.length > 1) pts.push({ x: Math.round(points.at(-1)[0]), y: Math.round(points.at(-1)[1]) });
    const W = ed.base.width, H = ed.base.height;
    const inside = pts.filter(p => p.x >= 0 && p.y >= 0 && p.x < W && p.y < H);
    if (!inside.length) return;
    await selectWith({ positive: inside }, subtract);
  }
  async function selectWith(body, subtract = false) {
    busy(subtract ? "Taking it out of the selection…" : "AI is selecting…", null);
    try {
      const src = await sourceRef();
      const r = await api("/api/edit/select", { method: "POST", body: JSON.stringify({ source: src, ...body }) });
      const im = await loadImg(r.url);
      // The mask comes as black/white: turn white into selection alpha.
      const t = mk(ed.base.width, ed.base.height), g = t.getContext("2d");
      g.drawImage(im, 0, 0, t.width, t.height);
      const d = g.getImageData(0, 0, t.width, t.height), px = d.data;
      for (let i = 0; i < px.length; i += 4) { const v = px[i]; px[i] = px[i + 1] = px[i + 2] = 255; px[i + 3] = v; }
      g.putImageData(d, 0, 0);
      if (!hasAlpha(t)) { Media.toast("AI didn't find anything there. Try painting over more of it."); return; }
      const f = ed.feather > 0 ? soften(t, ed.feather) : t;
      setMask(mg => { if (ed.feather > 0) ed.soft = true; mg.save(); mg.globalCompositeOperation = subtract ? "destination-out" : "source-over"; mg.drawImage(f, 0, 0); mg.restore(); });
    } catch (e) { Media.toast(`AI select: ${e.message}`); }
    finally { busy(null); }
  }
  const hasAlpha = c => { const s = 48, x = mk(s, s), g = x.getContext("2d"); g.drawImage(c, 0, 0, s, s); const d = g.getImageData(0, 0, s, s).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true; return false; };

  /* ---------------------------------------------------------------- AI edits (studio jobs) */
  async function runAi(op) {
    if (ed.busy) return;
    const val = k => String(ed.fields[k] || "").trim();
    const prompt = op === "erase" ? val("erase-hint") : ["replace", "prompt", "instruct"].includes(op) ? val(op) : "";
    if (["replace", "prompt", "instruct"].includes(op) && !prompt) {
      Media.toast(op === "replace" ? "Say what to put there." : op === "instruct" ? "Say how to change the picture." : "Describe how it should look.");
      $e(`[data-k="${op}"]`)?.focus(); return;
    }
    if (!["remove_bg", "instruct"].includes(op) && !ed.maskOn) { Media.toast("Select an area first."); return; }
    const labels = { erase: "Erasing", replace: "Replacing", prompt: "Changing the selection", instruct: "Editing the picture", remove_bg: "Removing the background" };
    busy(`${labels[op]}…`, 0);
    try {
      const body = { kind: "image", engine: "imgedit", edit_op: op, source: await sourceRef(), prompt, seed: -1, batch: 1,
        edit_strength: ed.strength ?? 0.7, edit_bg: val("bg") || "transparent", edit_model: editModel(state.caps?.editor || {}), project: ed.project };
      if (!["remove_bg", "instruct"].includes(op)) body.edit_mask = await maskRef();
      const r = await api("/api/generate", { method: "POST", body: JSON.stringify(body) });
      const it = r.items?.[0];
      if (!it) throw new Error("The studio didn't start the edit");
      for (const x of r.items) state.items.set(x.id, x);
      renderGallery();
      ed.busy.id = it.id;
      const done = await waitFor(it.id);
      if (done.status !== "done") throw new Error(done.status === "cancelled" ? "Cancelled" : (done.error || "The edit failed"));
      const f = done.files[0], im = await loadImg(f.url + `?t=${Date.now()}`);
      const c = mk(im.naturalWidth, im.naturalHeight); c.getContext("2d").drawImage(im, 0, 0);
      commit(c, { ref: f.path, item: done, op: { erase: "AI erase", replace: `replaced with ${prompt}`, prompt: `AI: ${prompt}`, instruct: `AI edit: ${prompt}`, remove_bg: "background removed" }[op] });
      ed.dirty = false;  // the result is already in the gallery
      Media.toast(`${{ erase: "Erased", replace: "Replaced", prompt: "Changed", instruct: "Edited", remove_bg: "Background removed" }[op]}. It's also in your results; Undo goes back.`);
    } catch (e) { if (e.message !== "Cancelled") Media.toast(e.message); }
    finally { busy(null); }
  }
  function waitFor(id) {
    return new Promise(res => {
      const tick = () => {
        if (!ed) return res({ status: "cancelled" });
        const it = state.items.get(id), p = state.progress.get(id);
        if (it && ["done", "failed", "cancelled"].includes(it.status)) return res(it);
        if (ed.busy) busyProgress(p?.value ?? (it?.status === "running" ? 0.05 : 0), it?.status);
        setTimeout(tick, 400);
      };
      tick();
    });
  }
  function busy(label, value) {
    if (!ed) return;
    ed.busy = label ? { label, id: ed.busy?.id ?? null } : null;
    const box = $e(".ed-busy");
    box.hidden = !label;
    if (label) { $e(".ed-busy-label").textContent = label; busyProgress(value ?? null); $e('[data-ed="cancel-ai"]').hidden = value == null; }
    renderSide(); draw();
  }
  function busyProgress(v, status) {
    const bar = $e(".ed-busy .bar");
    bar.classList.toggle("indeterminate", v == null || status === "queued");
    bar.querySelector("i").style.width = v == null ? "" : `${Math.round(v * 100)}%`;
  }

  /* ---------------------------------------------------------------- save */
  async function save() {
    if (ed.busy) return;
    if (!ed.dirty) { Media.toast(ed.item?.id ? "This picture is already in your results." : "Nothing to save yet: edit the picture first."); return; }
    try {
      const fd = new FormData();
      fd.append("file", await canvasBlob(ed.base), "edit.png");
      fd.append("source", ed.item?.files?.[0]?.path || "");
      fd.append("project", ed.project || "");
      fd.append("note", `Edited: ${ed.ops.map(o => String(o)).join(", ") || "changes"}`.slice(0, 1900));
      const r = await fetch("/api/edit/save", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      const { item } = await r.json();
      state.items.set(item.id, item); renderGallery();
      ed.item = item; ed.ref = item.files[0].path; ed.dirty = false; ed.ops = [];
      Media.toast("Saved as a new result.");
    } catch (e) { Media.toast(`Couldn't save: ${e.message}`); }
  }

  /* ---------------------------------------------------------------- events */
  function bind() {
    const root = ed.root, cv = $e(".ed-view");
    root.addEventListener("click", e => {
      const a = e.target.closest("[data-ed]")?.dataset.ed, t = e.target.closest("[data-tool]")?.dataset.tool;
      const mode = e.target.closest("[data-mode]")?.dataset.mode, ai = e.target.closest("[data-ai]")?.dataset.ai;
      const pct = e.target.closest("[data-pct]")?.dataset.pct, comb = e.target.closest("[data-combine]")?.dataset.combine;
      if (t) return setTool(t);
      if (comb) { ed.combine = comb; renderSide(); return; }
      if (mode) { ed.mode = mode; renderSide(); setTool("select"); return; }
      if (ai) return runAi(ai);
      if (pct) { $e('[data-k="rw"]').value = Math.round(ed.base.width * pct / 100); $e('[data-k="rh"]').value = Math.round(ed.base.height * pct / 100); return; }
      ({
        close: () => close(), undo, redo, fit, actual, save,
        "crop-apply": applyCrop, "crop-reset": () => { ed.crop = { x: 0, y: 0, w: ed.base.width, h: ed.base.height }; ed.aspect = "free"; renderSide(); draw(); },
        "resize-apply": applyResize, "rot-l": () => transform("rot-l"), "rot-r": () => transform("rot-r"),
        "flip-h": () => transform("flip-h"), "flip-v": () => transform("flip-v"),
        "adj-apply": applyAdjust, "adj-reset": () => { ed.adj = adjDefault(); renderSide(); draw(); },
        "mask-clear": MASK_OPS.clear, "mask-all": MASK_OPS.all, "mask-invert": MASK_OPS.invert, "mask-feather": MASK_OPS.feather,
        find: () => { const q = String(ed.fields.find || "").trim(); if (q) selectWith({ text: q }); else Media.toast("Type what to select, e.g. “the cup”."); },
        "cancel-ai": () => { if (ed.busy?.id) cancel(ed.busy.id); },
      })[a]?.();
    });
    root.addEventListener("input", e => {
      const k = e.target.dataset.k, adj = e.target.dataset.adj;
      if (adj) {
        ed.adj[adj] = +e.target.value;
        const u = ADJ.find(x => x[0] === adj)[5];
        $e(`[data-v="${adj}"]`).textContent = `${ed.adj[adj]}${u}`;
        $e('[data-ed="adj-apply"]').disabled = !adjChanged(ed.adj);
        draw(); return;
      }
      if (["find", "erase-hint", "replace", "prompt", "instruct"].includes(k)) ed.fields[k] = e.target.value;
      if (k === "brush") { ed.brush = +e.target.value; e.target.previousElementSibling.textContent = `${ed.brush}px`; draw(); }
      if (k === "tol") { ed.tol = +e.target.value; e.target.previousElementSibling.textContent = ed.tol; }
      if (k === "feather") {
        ed.feather = +e.target.value; e.target.previousElementSibling.textContent = `${ed.feather}px`;
        const b = $e('[data-ed="mask-feather"]');
        if (b) { const ok = ed.maskOn && ed.feather > 0 && !ed.busy; b.disabled = !ok; b.title = ok ? `Soften the current selection's edge by ${ed.feather}px` : ed.maskOn ? "Set a Feather amount first" : "Nothing selected"; }
      }
      if (k === "strength") { ed.strength = +e.target.value / 100; e.target.previousElementSibling.textContent = `${e.target.value}%`; }
      if (k === "rw" && $e('[data-k="lock"]').checked) $e('[data-k="rh"]').value = Math.round(+e.target.value * ed.base.height / ed.base.width);
      if (k === "rh" && $e('[data-k="lock"]').checked) $e('[data-k="rw"]').value = Math.round(+e.target.value * ed.base.width / ed.base.height);
    });
    root.addEventListener("change", e => {
      if (e.target.dataset.k === "bg") ed.fields.bg = e.target.value;
      if (e.target.dataset.k === "contig") ed.contiguous = e.target.checked;
      if (e.target.dataset.k === "edit-model") {
        ed.fields["edit-model"] = e.target.value;
        Settings.set({ editor: { edit_model: e.target.value } });
        renderSide();
      }
      if (e.target.dataset.k === "aspect") { ed.aspect = e.target.value; fitAspect(); renderSide(); draw(); } });
    root.addEventListener("dblclick", e => {
      const adj = e.target.dataset.adj;
      if (adj) { ed.adj[adj] = ADJ.find(x => x[0] === adj)[4]; renderSide(); draw(); }
    });
    root.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.dataset.k === "find") { e.preventDefault(); $e('[data-ed="find"]').click(); } });

    cv.addEventListener("wheel", e => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
      zoomAt(Math.pow(1.2, -Math.max(-300, Math.min(300, px)) / 100), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    let drag = null;
    cv.addEventListener("pointerdown", e => {
      if (!ed || ed.busy) return;
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      cv.setPointerCapture(e.pointerId);
      if (e.button === 1 || ed.tool === "move" || space) { drag = { kind: "pan", sx, sy, px: ed.panX, py: ed.panY }; cv.style.cursor = "grabbing"; return; }
      if (e.button !== 0) return;
      if (ed.tool === "crop") {
        const h = cropHandles().find(([hx, hy]) => Math.abs(hx - sx) <= HANDLE && Math.abs(hy - sy) <= HANDLE);
        const [x, y, w, hh] = cropScreen();
        const kind = h ? h[2] : (sx > x && sx < x + w && sy > y && sy < y + hh ? "move" : null);
        if (kind) drag = { kind: "crop", what: kind, sx, sy, start: { ...ed.crop } };
        return;
      }
      if (ed.tool === "select") {
        const p = toImg(sx, sy);
        if (SHAPES.has(ed.mode) || ed.mode === "lasso") { ed.shape = { mode: ed.mode, a: p, b: p, pts: [p] }; drag = { kind: "shape", op: opFrom(e) }; drawOverlay(); return; }
        if (ed.mode === "wand") { wand(p, opFrom(e)); return; }
        if (ed.mode === "ai") { ed.stroke = [p]; drag = { kind: "ai", alt: e.altKey }; draw(); }
        else { ed.hist.push(snapshot()); ed.redo = []; ed.stroke = [p]; paint(ed.stroke, ed.mode === "erase"); drag = { kind: "paint" }; maskChanged(); }
      }
    });
    cv.addEventListener("pointermove", e => {
      if (!ed) return;
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      ed.cursor = [sx, sy];
      if (!drag) { if (ed.tool === "select" && (ed.mode === "brush" || ed.mode === "erase")) draw(); if (ed.tool === "crop") cv.style.cursor = cropCursor(sx, sy); return; }
      if (drag.kind === "pan") { ed.panX = drag.px + sx - drag.sx; ed.panY = drag.py + sy - drag.sy; draw(); }
      else if (drag.kind === "crop") { cropDrag(drag.what, (sx - drag.sx) / ed.zoom, (sy - drag.sy) / ed.zoom, drag.start); renderSide(); draw(); }
      else if (drag.kind === "ai") { ed.stroke.push(toImg(sx, sy)); draw(); }
      else if (drag.kind === "shape") {
        const p = toImg(sx, sy), s = ed.shape, last = s.pts.at(-1);
        s.b = p;
        if (s.mode === "lasso" && Math.hypot(p[0] - last[0], p[1] - last[1]) * ed.zoom >= 2) s.pts.push(p);
        drawOverlay();
      }
      else if (drag.kind === "paint") {
        const p = toImg(sx, sy);
        paint([ed.stroke.at(-1), p], ed.mode === "erase"); ed.stroke.push(p); maskChanged();
      }
    });
    const up = () => {
      if (!ed || !drag) return;
      const d = drag; drag = null;
      if (d.kind === "pan") cv.style.cursor = ed.tool === "move" ? "grab" : "";
      if (d.kind === "ai") { const pts = ed.stroke; ed.stroke = null; draw(); aiSelect(pts, d.alt); }
      if (d.kind === "paint") { ed.stroke = null; }
      if (d.kind === "shape") finishShape(d.op);
    };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", () => { if (ed) { ed.cursor = null; if (ed.tool === "select") draw(); } });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", e => { if (e.code === "Space") space = false; }, true);
    window.addEventListener("resize", draw);
  }
  let space = false;
  function cropCursor(sx, sy) {
    const h = cropHandles().find(([hx, hy]) => Math.abs(hx - sx) <= HANDLE && Math.abs(hy - sy) <= HANDLE);
    if (h) return { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" }[h[2]];
    const [x, y, w, hh] = cropScreen();
    return sx > x && sx < x + w && sy > y && sy < y + hh ? "move" : "default";
  }
  function onKey(e) {
    if (!ed) return;
    const typing = e.target.matches?.("input, textarea, select");
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.stopPropagation(); return e.shiftKey ? redo() : undo(); }
    if (ctrl && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); e.stopPropagation(); return redo(); }
    if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); return save(); }
    if (typing) return;
    // The studio's own shortcuts (Enter adds to the timeline, F fits it, Space plays…) don't
    // apply while the editor covers the stage.
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if (ctrl && k === "a") { e.preventDefault(); return MASK_OPS.all(); }
    if (ctrl && k === "d") { e.preventDefault(); return MASK_OPS.clear(); }
    if (ctrl && e.shiftKey && k === "i") { e.preventDefault(); return MASK_OPS.invert(); }
    if (ctrl || e.altKey) return;
    if (e.key === "Escape") return close();
    if (e.code === "Space") { space = true; e.preventDefault(); return; }
    if (e.key === "Enter" && ed.tool === "crop") { e.preventDefault(); return applyCrop(); }
    if (e.key === "[" || e.key === "]") { ed.brush = Math.max(4, Math.min(400, Math.round(ed.brush * (e.key === "]" ? 1.2 : 1 / 1.2)))); renderSide(); draw(); return; }
    if (e.key.toLowerCase() === "f") return fit();
    if (e.key === "1") return actual();
    if (e.key.toLowerCase() === "b") { ed.mode = "brush"; setTool("select"); }
    if (e.key.toLowerCase() === "e") { ed.mode = "erase"; setTool("select"); }
    const modeKey = { m: "rect", o: "ellipse", l: "lasso", w: "wand" }[k];
    if (modeKey) { ed.mode = modeKey; setTool("select"); }
  }

  return { open, close, isOpen: () => !!ed };
})();
