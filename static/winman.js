/* Movable, resizable modal windows.

   const w = WM.open({ id: "open-project", title: "Open project", content: el, width: 860, height: 560,
                       footer: el2, onClose: () => {} });
   w.close();  w.body;  w.setTitle("…");

   Drag the title bar to move, any edge or corner to resize, double-click the title bar (or ☐)
   to maximise. Esc closes the top window. Each window's position and size are remembered
   per id in localStorage ("bob.ui" → windows). */
"use strict";

(function () {
  const UI_KEY = "bob.ui";
  const stack = [];
  let z = 1000;

  const readUI = () => { try { return JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {}; } catch { return {}; } };
  const writeUI = ui => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };
  const saveGeom = (id, g) => { if (!id) return; const ui = readUI(); ui.windows = { ...(ui.windows || {}), [id]: g }; writeUI(ui); };
  const loadGeom = id => (id && readUI().windows?.[id]) || null;

  function clamp(g, minW, minH) {
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    // The screen wins over a window's minimum size (phones).
    minW = Math.min(minW, vw - pad * 2); minH = Math.min(minH, vh - pad * 2);
    const w = Math.max(minW, Math.min(g.w, vw - pad * 2));
    const h = Math.max(minH, Math.min(g.h, vh - pad * 2));
    const x = Math.max(pad, Math.min(g.x, vw - w - pad));
    const y = Math.max(pad, Math.min(g.y, vh - h - pad));
    return { x, y, w, h };
  }

  function open(opts) {
    const { id = null, title = "", content, footer = null, width = 640, height = 440,
      minWidth = 320, minHeight = 200, modal = true, onClose = null, className = "" } = opts;
    const existing = id && stack.find(w => w.id === id);
    if (existing) { existing.focus(); return existing; }

    const backdrop = modal ? Object.assign(document.createElement("div"), { className: "wm-backdrop" }) : null;
    const el = document.createElement("div");
    el.className = `wm-win ${className}`.trim();
    el.setAttribute("role", "dialog");
    if (modal) el.setAttribute("aria-modal", "true");
    el.tabIndex = -1;
    const titleId = `wm-title-${++z}`;
    el.setAttribute("aria-labelledby", titleId);
    el.innerHTML = `
      <header class="wm-bar">
        <span class="wm-title" id="${titleId}"></span>
        <span class="wm-ctl">
          <button type="button" class="wm-max" title="Maximise" aria-label="Maximise">☐</button>
          <button type="button" class="wm-close" title="Close (Esc)" aria-label="Close">✕</button>
        </span>
      </header>
      <div class="wm-body"></div>
      ${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map(d => `<i class="wm-h wm-${d}" data-dir="${d}"></i>`).join("")}`;
    $q(".wm-title", el).textContent = title;
    const body = $q(".wm-body", el);
    if (typeof content === "string") body.innerHTML = content; else if (content) body.appendChild(content);
    if (footer) { footer.classList.add("wm-foot"); el.appendChild(footer); }

    const saved = loadGeom(id);
    let g = saved && saved.w ? { x: saved.x, y: saved.y, w: saved.w, h: saved.h }
      : { w: width, h: height, x: (window.innerWidth - width) / 2, y: Math.max(40, (window.innerHeight - height) / 2.4) };
    g = clamp(g, minWidth, minHeight);
    let maximised = !!saved?.max, restore = null;

    const place = () => {
      if (maximised) Object.assign(el.style, { left: "8px", top: "8px", width: `calc(100vw - 16px)`, height: `calc(100vh - 16px)` });
      else Object.assign(el.style, { left: g.x + "px", top: g.y + "px", width: g.w + "px", height: g.h + "px" });
      el.classList.toggle("maxed", maximised);
      $q(".wm-max", el).textContent = maximised ? "❐" : "☐";
    };
    const persist = () => saveGeom(id, { ...g, max: maximised });

    const win = {
      id, el, body,
      setTitle(t) { $q(".wm-title", el).textContent = t; },
      focus() { el.style.zIndex = ++z; if (backdrop) backdrop.style.zIndex = z - 1; el.focus({ preventScroll: true }); },
      close(result) {
        const i = stack.indexOf(win);
        if (i < 0) return;
        stack.splice(i, 1);
        el.remove(); backdrop?.remove();
        window.removeEventListener("resize", onResize);
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
        onClose?.(result);
      },
    };
    const lastFocus = document.activeElement;

    // ---- move
    const bar = $q(".wm-bar", el);
    bar.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest("button")) return;
      win.focus();
      if (maximised) return;
      const sx = e.clientX, sy = e.clientY, ox = g.x, oy = g.y;
      bar.setPointerCapture(e.pointerId);
      el.classList.add("moving");
      const mv = ev => { g = clamp({ ...g, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }, minWidth, minHeight); place(); };
      const up = () => { bar.removeEventListener("pointermove", mv); bar.removeEventListener("pointerup", up); el.classList.remove("moving"); persist(); };
      bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", up);
    });
    const toggleMax = () => { maximised = !maximised; place(); persist(); };
    bar.addEventListener("dblclick", e => { if (!e.target.closest("button")) toggleMax(); });
    $q(".wm-max", el).onclick = toggleMax;
    $q(".wm-close", el).onclick = () => win.close();

    // ---- resize
    el.querySelectorAll(".wm-h").forEach(h => h.addEventListener("pointerdown", e => {
      if (e.button !== 0 || maximised) return;
      e.preventDefault(); win.focus();
      const dir = h.dataset.dir, sx = e.clientX, sy = e.clientY, o = { ...g };
      h.setPointerCapture(e.pointerId);
      el.classList.add("moving");
      const mv = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        let { x, y, w, h: hh } = o;
        if (dir.includes("e")) w = o.w + dx;
        if (dir.includes("s")) hh = o.h + dy;
        if (dir.includes("w")) { w = o.w - dx; x = o.x + dx; }
        if (dir.includes("n")) { hh = o.h - dy; y = o.y + dy; }
        if (w < minWidth) { if (dir.includes("w")) x -= minWidth - w; w = minWidth; }
        if (hh < minHeight) { if (dir.includes("n")) y -= minHeight - hh; hh = minHeight; }
        g = clamp({ x, y, w, h: hh }, minWidth, minHeight); place();
      };
      const up = () => { h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", up); el.classList.remove("moving"); persist(); };
      h.addEventListener("pointermove", mv); h.addEventListener("pointerup", up);
    }));

    // ---- keyboard: Esc closes, Tab stays inside the window
    el.addEventListener("keydown", e => {
      if (e.key === "Escape" && stack[stack.length - 1] === win) { e.stopPropagation(); win.close(); }
      if (e.key === "Tab") {
        const f = [...el.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
          .filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    backdrop?.addEventListener("pointerdown", e => { if (e.target === backdrop) { el.classList.add("nudge"); setTimeout(() => el.classList.remove("nudge"), 300); } });
    const onResize = () => { if (!maximised) { g = clamp(g, minWidth, minHeight); place(); } };
    window.addEventListener("resize", onResize);

    if (backdrop) document.body.appendChild(backdrop);
    document.body.appendChild(el);
    place();
    stack.push(win);
    win.focus();
    const first = body.querySelector("[autofocus], input:not([type=hidden]), select, textarea, button");
    first?.focus({ preventScroll: true });
    return win;
  }

  function $q(s, el) { return el.querySelector(s); }

  /* Small helpers built on open(): confirm and prompt that look like the rest of the app. */
  function ask({ title, message, ok = "OK", cancel = "Cancel", danger = false, input = null }) {
    return new Promise(resolve => {
      const box = document.createElement("div");
      box.className = "wm-ask";
      box.innerHTML = `<p></p>${input !== null ? `<input type="text" class="wm-input" spellcheck="false">` : ""}`;
      box.querySelector("p").textContent = message || "";
      const field = box.querySelector("input");
      if (field) field.value = input;
      const foot = document.createElement("div");
      foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm">${cancel}</button>
        <button type="button" class="btn sm ${danger ? "danger-solid" : "primary"}">${ok}</button>`;
      let done = false;
      const w = open({ id: null, title, content: box, footer: foot, width: 420, height: input !== null ? 210 : 180,
        minWidth: 300, minHeight: 150, onClose: () => { if (!done) resolve(null); } });
      const [bCancel, bOk] = foot.querySelectorAll("button");
      const accept = () => { done = true; w.close(); resolve(field ? field.value : true); };
      bCancel.onclick = () => { done = true; w.close(); resolve(null); };
      bOk.onclick = accept;
      if (field) { field.focus(); field.select(); field.addEventListener("keydown", e => { if (e.key === "Enter") accept(); }); }
      else bOk.focus();
    });
  }

  window.WM = { open, ask, top: () => stack[stack.length - 1] || null };
})();
