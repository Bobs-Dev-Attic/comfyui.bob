/* Track an object in a video: click it (or name it) on a frame, SAM 3.1 follows it through the clip, and its path
   (cleaned and smoothed on the server, app/tracking.py) can be saved for Animate objects, where a layer can take
   it as its own path. Opened from a video's menu in the results. */
"use strict";

const Tracker = (() => {
  let t = null;  // the open window's state
  const $ = sel => t?.root.querySelector(sel);
  const fmt = s => `${(+s || 0).toFixed(2)} s`;

  // Video pixels <-> the overlay canvas (the video is drawn "contain" in its box).
  function geom() {
    const v = t.video, c = t.canvas, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9, k = Math.min(W / vw, H / vh);
    return { k, ox: (W - vw * k) / 2, oy: (H - vh * k) / 2, vw, vh };
  }
  function draw() {
    if (!t) return;
    const g = geom(), ctx = t.canvas.getContext("2d");
    ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
    const R = t.result;
    if (R) {
      ctx.fillStyle = "rgba(255,197,61,.9)";
      for (let i = 0; i < R.path.length; i += 2) { const q = R.path[i]; ctx.fillRect(g.ox + q.x * g.vw * g.k - 1.5, g.oy + q.y * g.vh * g.k - 1.5, 3, 3); }
      const i = Math.round((t.video.currentTime - R.start) * R.fps);
      const q = R.path[Math.max(0, Math.min(R.path.length - 1, i))];
      if (t.video.currentTime >= R.start - 0.02 && t.video.currentTime <= R.start + R.duration + 0.05) {
        ctx.strokeStyle = "#ffc53d"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(g.ox + q.x * g.vw * g.k, g.oy + q.y * g.vh * g.k, 12, 0, Math.PI * 2); ctx.stroke();
      }
    }
    for (const p of t.points) {
      ctx.fillStyle = p.neg ? "#ff5a5f" : "#5be37d"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(g.ox + p.x * g.k, g.oy + p.y * g.k, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    $(".tr-time").textContent = `${fmt(t.video.currentTime)} / ${fmt(t.video.duration)}`;
    $(".tr-scrub").value = String(t.video.currentTime);
  }
  function renderSide() {
    const R = t.result;
    $(".tr-points").textContent = t.points.length ? `${t.points.filter(p => !p.neg).length} on the object, ${t.points.filter(p => p.neg).length} off it, at ${fmt(t.pickAt)}` : "No clicks yet.";
    $('[data-act="track"]').disabled = !!t.busy || !(t.points.some(p => !p.neg) || $("#tr-word").value.trim());
    $(".tr-st").textContent = t.busy || (R ? `Followed for ${fmt(R.duration)} from ${fmt(R.start)}: found on ${Math.round(R.found * 100)}% of the frames (gaps are filled in), ${R.keys.length} keys.` : "");
    $(".tr-save").hidden = !R;
  }
  const refresh = () => { renderSide(); draw(); };

  async function track() {
    const word = $("#tr-word").value.trim();
    t.busy = "Tracking… SAM 3.1 follows the object frame by frame (up to 15 s of the video)."; t.result = null; refresh();
    try {
      const start = t.points.length ? t.pickAt : t.video.currentTime;
      t.result = await api("/api/track", { method: "POST", body: JSON.stringify({ video: t.ref, start, text: t.points.some(p => !p.neg) ? "" : word,
        positive: t.points.filter(p => !p.neg).map(({ x, y }) => ({ x, y })), negative: t.points.filter(p => p.neg).map(({ x, y }) => ({ x, y })) }) });
      if (!$("#tr-name").value.trim()) $("#tr-name").value = word || "Tracked path";
      t.video.currentTime = t.result.start;
    } catch (e) { Media.toast(`Couldn't track it: ${e.message}`); }
    finally { if (t) { t.busy = ""; refresh(); } }
  }
  async function save() {
    const R = t.result, name = $("#tr-name").value.trim() || "Tracked path";
    try {
      await api("/api/tracks", { method: "POST", body: JSON.stringify({ name, video: t.ref, start: R.start, duration: R.duration,
        aspect: R.width / R.height, keys: R.keys }) });
      Media.toast(`Saved “${name}”: in Animate objects, pick an object and Use a tracked path.`);
    } catch (e) { Media.toast(`Couldn't save the path: ${e.message}`); }
  }

  function open(src) {
    if (t?.win) t.win.close();
    const root = document.createElement("div");
    root.className = "tr";
    root.innerHTML = `
      <div class="tr-stage">
        <div class="tr-box"><video class="tr-video" src="${esc(src.url)}" preload="auto" playsinline muted></video><canvas class="tr-canvas" aria-label="Click the object to track"></canvas></div>
        <div class="mo-transport"><button type="button" class="btn sm" data-act="play" title="Play">▶</button>
          <input type="range" class="tr-scrub" min="0" step="0.04" value="0" aria-label="Time"><span class="tr-time mo-time"></span></div>
      </div>
      <aside class="mo-side">
        <section><h3>1. The object</h3>
          <p class="hint">Go to a frame where it's clearly seen, then click it. Shift+click marks what isn't it. Or type its name.</p>
          <div class="mo-find"><input id="tr-word" placeholder="the dog" aria-label="What to track">
            <button type="button" class="btn sm" data-act="clear" title="Remove the clicks">Clear</button></div>
          <p class="hint tr-points"></p></section>
        <section><h3>2. Follow it</h3>
          <p class="hint">From that frame on, up to 15 s. Misdetections are dropped, gaps filled and the path smoothed.</p>
          <button type="button" class="btn primary sm" data-act="track">🎯 Track</button>
          <p class="hint tr-st" aria-live="polite"></p></section>
        <section class="tr-save" hidden><h3>3. Keep the path</h3>
          <div class="mo-find"><input id="tr-name" placeholder="Tracked path" aria-label="Name of the path">
            <button type="button" class="btn sm" data-act="save">Save path</button></div>
          <p class="hint">Then in 🎬 Animate objects, pick an object and choose it under Use a tracked path.</p></section>
      </aside>`;
    const win = WM.open({ id: "tracker", title: `Track an object · ${src.name || src.ref.split("/").pop()}`, content: root,
      width: 1040, height: 640, minWidth: 700, minHeight: 460, onClose: () => { if (t?.raf) cancelAnimationFrame(t.raf); t = null; } });
    t = { win, root, ref: src.ref, video: root.querySelector(".tr-video"), canvas: root.querySelector(".tr-canvas"), points: [], pickAt: 0, result: null, busy: "" };
    const v = t.video;
    v.addEventListener("loadedmetadata", () => { $(".tr-scrub").max = String(v.duration || 0); refresh(); });
    v.addEventListener("seeked", draw);
    const loop = () => { if (!t) return; if (!v.paused) draw(); t.raf = requestAnimationFrame(loop); };
    loop();
    root.addEventListener("click", e => {
      const a = e.target.closest("[data-act]")?.dataset.act; if (!a) return;
      if (a === "play") { if (v.paused) v.play().catch(() => {}); else v.pause(); }
      if (a === "clear") { t.points = []; refresh(); }
      if (a === "track") track();
      if (a === "save") save();
    });
    root.addEventListener("input", e => {
      if (e.target.classList.contains("tr-scrub")) { v.pause(); v.currentTime = +e.target.value; }
      if (e.target.id === "tr-word") renderSide();
    });
    t.canvas.addEventListener("pointerdown", e => {
      if (t.busy) return;
      const g = geom(), r = t.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - g.ox) / g.k, y = (e.clientY - r.top - g.oy) / g.k;
      if (x < 0 || y < 0 || x > g.vw || y > g.vh) return;
      v.pause();
      if (Math.abs(v.currentTime - t.pickAt) > 0.02) t.points = [];  // clicks belong to one frame
      t.pickAt = v.currentTime;
      t.points.push({ x: Math.round(x), y: Math.round(y), neg: e.shiftKey });
      refresh();
    });
    new ResizeObserver(() => t && draw()).observe(t.canvas);
    refresh();
  }

  return { open, _state: () => t };
})();
