/* MOSS-Image layout control: boxes for text, objects and characters on a canvas the shape of the picture.
   Drag on empty canvas to draw a box, drag a box to move it, drag its corner to resize. Boxes are drawn in
   order, background first; the prompt becomes the whole scene's caption. The server turns the boxes into the
   JSON layout prompt ComfyUI's "MOSS-Image Layout Prompt" node builds (workflows.moss_layout_prompt). */
const MossLayout = (() => {
  const TYPES = [["text", "Text"], ["object", "Object"], ["character", "Character"]];
  const MIN = 0.02;
  let sel = -1, drag = null;

  const L = () => (state.layout ||= { on: false, boxes: [] });
  const shown = () => state.kind === "image" && state.engine.image === "moss";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const aspect = () => ASPECT[$("#aspect").value] || [16, 9];
  const label = (b, i) => `${i + 1}${b.type === "text" ? " · T" : b.type === "character" ? " · ☺" : ""}`;
  const snippet = b => (b.type === "text" && b.text ? `“${b.text.split("\n")[0]}”` : b.desc || (b.type === "text" ? "text" : b.type)).slice(0, 60);

  /* For Generate: the boxes, when the layout is on and there are any (MOSS only). */
  function request() {
    const l = L();
    return shown() && l.on && l.boxes.length
      ? l.boxes.map(b => ({ x: +b.x.toFixed(4), y: +b.y.toFixed(4), w: +b.w.toFixed(4), h: +b.h.toFixed(4), type: b.type, text: b.type === "text" ? b.text || "" : "", desc: b.desc || "" }))
      : null;
  }

  function set(v) {
    const ok = b => b && [b.x, b.y, b.w, b.h].every(n => typeof n === "number" && isFinite(n));
    state.layout = v && typeof v === "object"
      ? { on: !!v.on, boxes: (Array.isArray(v.boxes) ? v.boxes : []).filter(ok).map(b => ({
          x: clamp(b.x, 0, 1), y: clamp(b.y, 0, 1), w: clamp(b.w, MIN, 1), h: clamp(b.h, MIN, 1),
          type: ["text", "character"].includes(b.type) ? b.type : "object", text: String(b.text || ""), desc: String(b.desc || "") })) }
      : { on: false, boxes: [] };
    sel = -1;
  }

  function changed(full = true) { scheduleSave(); if (full) render(); else renderCanvas(); }

  function render() {
    const box = $("#f-layout"); if (!box) return;
    box.hidden = !shown();
    if (box.hidden) return;
    const l = L();
    $("#layout-on").checked = l.on;
    $("#layout-count").textContent = l.boxes.length ? `${l.boxes.length} box${l.boxes.length === 1 ? "" : "es"}${l.on ? "" : " · off"}` : "";
    $("#layout-body").classList.toggle("off", !l.on);
    const [aw, ah] = aspect();
    $("#layout-canvas").style.aspectRatio = `${aw} / ${ah}`;
    $("#layout-canvas").style.width = `min(100%, ${Math.round(440 * aw / ah)}px)`;  // tall pictures: at most 440px high
    $("#layout-dims").textContent = $("#dims").textContent ? `Canvas ${$("#dims").textContent}` : "";
    $("#layout-enhance").hidden = !(l.on && l.boxes.length && $("#enhance").checked);
    renderCanvas();
    renderList();
  }

  function renderCanvas() {
    const c = $("#layout-canvas"), l = L();
    c.innerHTML = l.boxes.map((b, i) => `<div class="ml-box t-${b.type}${i === sel ? " sel" : ""}" data-i="${i}"
        style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%">
        <span class="ml-tag">${esc(label(b, i))}</span><span class="ml-txt">${esc(snippet(b))}</span><i class="ml-h" data-i="${i}" title="Drag to resize"></i></div>`).join("")
      + (l.boxes.length ? "" : `<p class="ml-empty">Drag here to draw a box. Draw the background first, then what's in front.</p>`);
  }

  function renderList() {
    const l = L();
    $("#layout-list").innerHTML = l.boxes.map((b, i) => `<div class="ml-item${i === sel ? " sel" : ""}" data-i="${i}">
      <div class="ml-row"><b class="ml-n t-${b.type}">${i + 1}</b>
        <div class="seg sm ml-type">${TYPES.map(([v, t]) => `<button type="button" data-t="${v}" class="${b.type === v ? "active" : ""}">${t}</button>`).join("")}</div>
        <span class="grow"></span>
        <button type="button" class="btn sm ghost" data-a="up" title="Draw earlier (further back)" ${i ? "" : "disabled"}>↑</button>
        <button type="button" class="btn sm ghost" data-a="down" title="Draw later (further in front)" ${i < l.boxes.length - 1 ? "" : "disabled"}>↓</button>
        <button type="button" class="btn sm ghost danger" data-a="del" title="Delete this box">✕</button></div>
      ${b.type === "text" ? `<textarea class="ml-text" rows="2" placeholder="The exact words, one line per line of text">${esc(b.text)}</textarea>` : ""}
      <textarea class="ml-desc" rows="2" placeholder="${b.type === "text" ? "Typeface, color, where it sits (e.g. large cream serif capitals across the top)" : b.type === "character" ? "Who it is: looks, clothing, pose" : "What it is: the object or area, its look"}">${esc(b.desc)}</textarea>
    </div>`).join("");
  }

  function pick(i) {
    sel = i;
    $$("#layout-canvas .ml-box").forEach(e => e.classList.toggle("sel", +e.dataset.i === i));
    $$("#layout-list .ml-item").forEach(e => e.classList.toggle("sel", +e.dataset.i === i));
    $(`#layout-list .ml-item[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function init() {
    const c = $("#layout-canvas"); if (!c) return;
    const pt = e => { const r = c.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)]; };
    c.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const l = L(), [px, py] = pt(e), h = e.target.closest(".ml-h"), el = e.target.closest(".ml-box");
      if (h) { const i = +h.dataset.i; drag = { mode: "size", i, b: { ...l.boxes[i] } }; pick(i); }
      else if (el) { const i = +el.dataset.i; drag = { mode: "move", i, px, py, b: { ...l.boxes[i] } }; pick(i); }
      else {
        l.on = true;
        l.boxes.push({ x: px, y: py, w: MIN, h: MIN, type: "object", text: "", desc: "" });
        drag = { mode: "draw", i: l.boxes.length - 1, px, py, fresh: true };
        sel = drag.i; renderCanvas();
      }
      c.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    c.addEventListener("pointermove", e => {
      if (!drag) return;
      const b = L().boxes[drag.i], [px, py] = pt(e);
      if (drag.mode === "draw") {
        b.x = Math.min(px, drag.px); b.y = Math.min(py, drag.py);
        b.w = Math.max(MIN, Math.abs(px - drag.px)); b.h = Math.max(MIN, Math.abs(py - drag.py));
      } else if (drag.mode === "move") {
        b.x = clamp(drag.b.x + px - drag.px, 0, 1 - b.w); b.y = clamp(drag.b.y + py - drag.py, 0, 1 - b.h);
      } else {
        b.w = clamp(px - b.x, MIN, 1 - b.x); b.h = clamp(py - b.y, MIN, 1 - b.y);
      }
      b.w = Math.min(b.w, 1 - b.x); b.h = Math.min(b.h, 1 - b.y);
      renderCanvas();
    });
    const end = () => {
      if (!drag) return;
      const fresh = drag.fresh, l = L(), b = l.boxes[drag.i];
      drag = null;
      if (fresh && b.w <= MIN && b.h <= MIN) {  // a click, not a drag: a default-sized box there
        b.w = 0.3; b.h = 0.2; b.x = clamp(b.x - 0.15, 0, 0.7); b.y = clamp(b.y - 0.1, 0, 0.8);
      }
      changed();
      if (fresh) setTimeout(() => $(`#layout-list .ml-item[data-i="${sel}"] .ml-desc`)?.focus(), 0);
    };
    c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);

    $("#layout-list").addEventListener("click", e => {
      const item = e.target.closest(".ml-item"); if (!item) return;
      const i = +item.dataset.i, l = L(), t = e.target.closest("[data-t]"), a = e.target.closest("[data-a]")?.dataset.a;
      if (t) { l.boxes[i].type = t.dataset.t; sel = i; return changed(); }
      if (a === "del") { l.boxes.splice(i, 1); sel = -1; return changed(); }
      if (a === "up" || a === "down") {
        const j = a === "up" ? i - 1 : i + 1;
        [l.boxes[i], l.boxes[j]] = [l.boxes[j], l.boxes[i]]; sel = j; return changed();
      }
      if (sel !== i) pick(i);
    });
    $("#layout-list").addEventListener("input", e => {
      const item = e.target.closest(".ml-item"); if (!item) return;
      const b = L().boxes[+item.dataset.i];
      if (e.target.classList.contains("ml-text")) b.text = e.target.value;
      if (e.target.classList.contains("ml-desc")) b.desc = e.target.value;
      changed(false);
    });
    $("#layout-list").addEventListener("focusin", e => { const item = e.target.closest(".ml-item"); if (item && +item.dataset.i !== sel) pick(+item.dataset.i); });
    $("#layout-on").addEventListener("change", e => { L().on = e.target.checked; changed(); });
    $("#layout-clear").addEventListener("click", () => {
      if (L().boxes.length && !confirm("Remove every box?")) return;
      L().boxes = []; sel = -1; changed();
    });
    c.addEventListener("keydown", e => {
      if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0) { L().boxes.splice(sel, 1); sel = -1; changed(); e.preventDefault(); }
    });
  }

  return { init, render, request, set, get: () => structuredClone(L()) };
})();
