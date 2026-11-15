/* Results bin: the studio's results with ★ ratings and tags, next to the timeline.

   Ratings and tags live in each project's media library (project.json → library.media),
   keyed by the result's file, so they show up in the Inputs gallery too. Drag a result
   onto the timeline, or double-click / Enter to add it at the end. */
"use strict";

const Bin = (() => {
  const libs = new Map();      // project id → Map(ref → {rating, tags})
  const loading = new Set();
  const UI = () => { try { return JSON.parse(localStorage.getItem("bob.ui") || "{}").bin || {}; } catch { return {}; } };
  const f = { q: "", rating: 0, tag: "", sort: "new", ...UI() };
  const saveUI = () => { try { const ui = JSON.parse(localStorage.getItem("bob.ui") || "{}"); ui.bin = { rating: f.rating, tag: f.tag, sort: f.sort }; localStorage.setItem("bob.ui", JSON.stringify(ui)); } catch {} };

  const pidOf = it => it.project || "experiment";
  const refOf = it => it.files?.[0]?.path;
  function meta(it) {
    const m = libs.get(pidOf(it))?.get(refOf(it));
    return { rating: m?.rating || 0, tags: m?.tags || [] };
  }
  function setLib(project, lib) {
    libs.set(project, new Map(lib.media.map(m => [m.ref, { rating: m.rating, tags: m.tags }])));
  }
  async function ensureLibs(list) {
    const need = [...new Set(list.map(pidOf))].filter(p => !libs.has(p) && !loading.has(p));
    if (!need.length) return;
    await Promise.all(need.map(async p => {
      loading.add(p);
      try { const r = await fetch(`/api/projects/${p}/library`); if (r.ok) setLib(p, await r.json()); else libs.set(p, new Map()); }
      catch { libs.set(p, new Map()); }
      loading.delete(p);
    }));
    render();
  }
  window.addEventListener("bob:library", e => { setLib(e.detail.project, e.detail.lib); render(); });

  function visible() {
    const q = f.q.trim().toLowerCase();
    let list = itemsSorted().filter(it => inScope(it) && (state.filter === "all" || it.kind === state.filter));
    list = list.filter(it => {
      const m = meta(it);
      if (f.rating && m.rating < f.rating) return false;
      if (f.tag && !m.tags.some(t => t.toLowerCase() === f.tag.toLowerCase())) return false;
      if (q && !((it.params?.prompt || "").toLowerCase().includes(q) || m.tags.some(t => t.toLowerCase().includes(q)) || (refOf(it) || "").toLowerCase().includes(q))) return false;
      return true;
    });
    if (f.sort === "rating") list = [...list].sort((a, b) => meta(b).rating - meta(a).rating || b.created - a.created);
    if (f.sort === "old") list = [...list].reverse();
    return list;
  }

  const stars = n => [1, 2, 3, 4, 5].map(i => `<button type="button" class="b-star${i <= n ? " on" : ""}" data-rate="${i}" aria-label="${i} star${i > 1 ? "s" : ""}">★</button>`).join("");

  function tileHTML(it) {
    const m = meta(it), busy = isBusy(it), p = state.progress.get(it.id);
    const onTl = TL.clipsForJob(it.id);
    const secs = it.info?.seconds ? `${it.info.seconds}s` : "";
    return `<div class="tile b-tile${it.id === state.selected ? " selected" : ""}${busy ? " busy" : ""}" data-id="${it.id}" tabindex="-1"
        draggable="${it.status === "done" && refOf(it) ? "true" : "false"}" title="${esc(it.params?.prompt || "")}">
      <div class="thumb">${thumbHTML(it)}${secs ? `<span class="b-dur">${secs}</span>` : ""}${onTl ? `<span class="b-ontl" title="On the timeline ${onTl}×">⧉${onTl > 1 ? onTl : ""}</span>` : ""}</div>
      ${it.status === "done" ? `<div class="b-row"><span class="b-stars">${stars(m.rating)}</span><span class="badge ${it.kind}">${it.engine === "timeline" ? "edit" : it.kind}</span></div>
        ${m.tags.length ? `<div class="b-tags">${m.tags.slice(0, 4).map(t => `<i style="--c:${Media.tagColor(t)}">${esc(t)}</i>`).join("")}${m.tags.length > 4 ? `<i>+${m.tags.length - 4}</i>` : ""}</div>` : ""}` : ""}
      <div class="t-prompt">${esc((it.params?.prompt || "").replace(/\s+/g, " ").slice(0, 90))}</div>
      <div class="bar"><i style="width:${Math.round((p?.value ?? it.progress ?? 0) * 100)}%"></i></div></div>`;
  }

  function renderFilters() {
    const tagSel = $("#bin-tag");
    if (!tagSel) return;
    const tags = new Map();
    for (const lib of libs.values()) for (const m of lib.values()) for (const t of m.tags) tags.set(t.toLowerCase(), t);
    const opts = [...tags.values()].sort((a, b) => a.localeCompare(b));
    tagSel.innerHTML = `<option value="">All tags</option>${opts.map(t => `<option${t.toLowerCase() === f.tag.toLowerCase() ? " selected" : ""}>${esc(t)}</option>`).join("")}`;
    $("#bin-rating").value = String(f.rating);
    $("#bin-sort").value = f.sort;
  }

  function render() {
    const g = $("#gallery");
    if (!g) return;
    const all = itemsSorted().filter(inScope);
    ensureLibs(all);
    const list = visible();
    const scroll = g.scrollTop;
    g.innerHTML = list.length ? list.map(tileHTML).join("")
      : `<p class="gallery-empty">${all.length ? "Nothing matches these filters." : "Results you generate show up here. Drag them onto the timeline."}</p>`;
    g.scrollTop = scroll;
    $("#bin-count").textContent = `${list.length}${list.length !== all.length ? ` of ${all.length}` : ""}`;
    renderFilters();
  }

  function patch(id) {
    const it = state.items.get(id), t = $(`#gallery .tile[data-id="${id}"]`);
    if (!it || !t) return render();
    t.classList.toggle("busy", isBusy(it));
    const p = state.progress.get(id);
    const bar = $(".bar i", t); if (bar) bar.style.width = `${Math.round((p?.value ?? 0) * 100)}%`;
    const pv = state.previews.get(id);
    if (pv && isBusy(it)) { const img = $(".thumb img", t); if (img) img.src = pv; else $(".thumb", t).innerHTML = `<img src="${pv}" alt="">`; }
  }

  async function rate(it, n) {
    const ref = refOf(it);
    if (!ref) return;
    const pid = pidOf(it), cur = meta(it).rating;
    const value = n === cur ? 0 : n;  // clicking the same star again clears it
    try {
      const r = await fetch(`/api/projects/${pid}/library/rate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refs: [ref], rating: value }) });
      const lib = await r.json();
      if (!r.ok) throw new Error(lib.detail || r.statusText);
      setLib(pid, lib);
      window.dispatchEvent(new CustomEvent("bob:library", { detail: { project: pid, lib } }));
      if (state.selected === it.id) renderViewer();
    } catch (e) { Media.toast(e.message); }
  }
  function tags(it) {
    const ref = refOf(it);
    if (!ref) return;
    const m = meta(it);
    Media.tagsDialog([{ ref, name: ref.split("/").pop(), kind: it.kind, tags: m.tags }], pidOf(it));
  }
  function toTimeline(it) {
    const f0 = it.files?.[0];
    if (it.status !== "done" || !f0) return;
    return TL.add({ ref: f0.path, kind: it.kind, name: (it.params?.prompt || f0.name).slice(0, 40), job: it.id });
  }

  function menu(x, y, it) {
    const done = it.status === "done" && it.files?.[0], img = it.kind === "image", vid = it.kind === "video";
    const items = [
      done && ["▶ Show in viewer", () => { select(it.id); }],
      done && ["＋ Add to timeline (Enter)", () => toTimeline(it)],
      done && ["★ Rate 5", () => rate(it, 5)], done && ["★ Rate 4", () => rate(it, 4)], done && ["★ Rate 3", () => rate(it, 3)],
      done && ["★ Rate 2", () => rate(it, 2)], done && ["★ Rate 1", () => rate(it, 1)], done && meta(it).rating && ["Clear rating (0)", () => rate(it, meta(it).rating)],
      done && ["🏷 Tags… (Shift+T)", () => tags(it)],
      done && img && ["Use as first frame", () => action("first", it)],
      done && img && ["Use as last frame", () => action("last", it)],
      done && img && ["Use as reference", () => action("ref", it)],
      done && vid && ["Continue from the last frame", () => continueFrom(it)],
      ["Reuse settings", () => action("reuse", it)],
      it.engine !== "timeline" && ["Re-roll", () => action("reroll", it)],
      done && ["Download", () => { const a = document.createElement("a"); a.href = it.files[0].url; a.download = it.files[0].name; a.click(); }],
      ["Delete…", () => action("delete", it)],
    ].filter(Boolean);
    document.querySelector(".ex-menu")?.remove();
    const m = document.createElement("div");
    m.className = "ex-menu"; m.setAttribute("role", "menu");
    m.innerHTML = items.map(([l], i) => `<button type="button" role="menuitem" data-i="${i}">${esc(l)}</button>`).join("");
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    Object.assign(m.style, { left: Math.min(x, innerWidth - r.width - 8) + "px", top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px", zIndex: 100000 });
    const close = () => { m.remove(); document.removeEventListener("pointerdown", out, true); };
    const out = ev => { if (!m.contains(ev.target)) close(); };
    m.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) { close(); items[+b.dataset.i][1](); } });
    m.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } });
    setTimeout(() => document.addEventListener("pointerdown", out, true));
    m.querySelector("button")?.focus();
  }

  async function continueFrom(it) {
    try {
      const info = await (await fetch(`/api/media/probe?path=${encodeURIComponent(refOf(it))}`)).json();
      const r = await fetch("/api/media/frame", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: refOf(it), t: Math.max(0, (info.duration || 0) - 1 / 24) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      state.kind = "video"; state.engine.video = "h3"; renderForm();
      setFrame("first_frame", j.ref, j.url);
      showStep("inputs");
      Media.toast("Last frame set as the first frame: describe what happens next, then generate.");
    } catch (e) { Media.toast(e.message); }
  }

  function onKey(e) {
    const it = state.items.get(state.selected);
    const list = visible();
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const i = list.findIndex(x => x.id === state.selected);
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))];
      if (next) { e.preventDefault(); select(next.id); $(`#gallery .tile[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" }); $(`#gallery .tile[data-id="${next.id}"]`)?.focus({ preventScroll: true }); }
      return true;
    }
    if (!it || it.status !== "done") return false;
    if (/^[0-5]$/.test(e.key) && !e.ctrlKey && !e.altKey) { e.preventDefault(); rate(it, +e.key || meta(it).rating); return true; }
    if (e.key === "T" && e.shiftKey) { e.preventDefault(); tags(it); return true; }
    if (e.key === "Enter") { e.preventDefault(); toTimeline(it); return true; }
    if (e.key === "Delete") { e.preventDefault(); action("delete", it); return true; }
    return false;
  }

  function init() {
    const g = $("#gallery");
    g.addEventListener("click", e => {
      const tile = e.target.closest(".tile[data-id]");
      if (!tile) return;
      const it = state.items.get(tile.dataset.id);
      const star = e.target.closest("[data-rate]");
      if (star) { e.stopPropagation(); return rate(it, +star.dataset.rate); }
      select(it.id);
      tile.focus({ preventScroll: true });
    });
    g.addEventListener("dblclick", e => { const t = e.target.closest(".tile[data-id]"); if (t) toTimeline(state.items.get(t.dataset.id)); });
    g.addEventListener("contextmenu", e => {
      const t = e.target.closest(".tile[data-id]");
      if (!t) return;
      e.preventDefault(); select(t.dataset.id); menu(e.clientX, e.clientY, state.items.get(t.dataset.id));
    });
    g.addEventListener("dragstart", e => {
      const t = e.target.closest(".tile[data-id]"), it = t && state.items.get(t.dataset.id);
      const f0 = it?.files?.[0];
      if (!f0) return;
      e.dataTransfer.setData("text/x-bob-ref", f0.path);
      e.dataTransfer.setData("text/x-bob-url", f0.url);
      e.dataTransfer.setData("text/x-bob-kind", it.kind);
      e.dataTransfer.setData("text/x-bob-job", it.id);
      e.dataTransfer.setData("text/x-bob-name", (it.params?.prompt || f0.name).slice(0, 40));
      e.dataTransfer.effectAllowed = "copy";
    });
    // Hover a video tile to see the clip in the thumbnail.
    g.addEventListener("pointerover", e => {
      const t = e.target.closest(".tile[data-id]");
      if (!t || t._hover) return;
      const it = state.items.get(t.dataset.id);
      if (it?.kind !== "video" || it.status !== "done") return;
      t._hover = true;
      const v = Object.assign(document.createElement("video"), { src: it.files[0].url, muted: true, loop: true, playsInline: true, className: "b-hover" });
      $(".thumb", t).appendChild(v); v.play().catch(() => {});
      t.addEventListener("pointerleave", () => { v.remove(); t._hover = false; }, { once: true });
    });
    $("#bin-q").addEventListener("input", e => { f.q = e.target.value; render(); });
    $("#bin-rating").addEventListener("change", e => { f.rating = +e.target.value; saveUI(); render(); });
    $("#bin-tag").addEventListener("change", e => { f.tag = e.target.value; saveUI(); render(); });
    $("#bin-sort").addEventListener("change", e => { f.sort = e.target.value; saveUI(); render(); });
  }

  return { init, render, patch, rate, tags, meta, onKey, toTimeline, invalidate: p => { libs.delete(p); render(); } };
})();
