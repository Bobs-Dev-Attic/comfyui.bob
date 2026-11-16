/* LoRAs: the LoRAs step (what's on the selected model) and the LoRA Explorer, a Windows
   Explorer style browser over every LoRA ComfyUI can load (app/loras.py): folder tree,
   address bar, search, details or large-icon view, a details pane with the preview picture,
   what model it's for, trigger words and description, and a strength to add it with.

   Rows in the step: drag the grip to reorder; the ⋯ menu moves, replaces, removes or shows
   a LoRA's details (its full safetensors metadata). Strength runs from -10 to 10.

   state.loras = [{name, strength}] (saved with the project settings, sent with each
   generation and applied in order after the model and any turbo LoRA). */
"use strict";

const Loras = (() => {
  let data = null, loading = null;
  const UI_KEY = "bob.ui";
  const readUI = () => { try { return JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {}; } catch { return {}; } };
  const writeUI = p => { try { localStorage.setItem(UI_KEY, JSON.stringify({ ...readUI(), ...p })); } catch {} };
  const FAM_COLOR = { h3: "#ff7a45", flux2: "#7aa2ff", krea2: "#3ccf8e", wan: "#c084fc", "qwen-image": "#f5b942", ltx: "#ff5d9e",
    flux1: "#60a5fa", sdxl: "#94a3b8", sd15: "#94a3b8", hunyuan: "#2dd4bf", music3: "#facc15", unknown: "#6b7280" };
  const FAM_SHORT = { h3: "H3", flux2: "F2", krea2: "K2", wan: "Wan", "qwen-image": "Qw", ltx: "LTX", flux1: "F1", sdxl: "XL", sd15: "1.5",
    hunyuan: "Hy", music3: "M3", unknown: "?" };

  async function load(refresh = false) {
    if (data && !refresh) return data;
    if (!loading || refresh) loading = fetch(`/api/loras${refresh ? "?refresh=true" : ""}`).then(r => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then(j => { data = j; loading = null; return j; }).catch(e => { loading = null; throw e; });
    return loading;
  }
  const engine = () => state.engine[state.kind];
  const fits = r => !!r && (data?.engine_families?.[engine()] || []).includes(r.family);
  const byName = n => data?.loras.find(r => r.name === n);
  const modelName = () => (typeof MODEL_CARDS !== "undefined" && MODEL_CARDS.find(m => m.kind === state.kind && m.engine === engine())?.name) || engine();
  const fmtSize = b => b == null ? "" : b > 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`;
  const fmtDate = t => t ? new Date(t * 1000).toLocaleDateString() : "";
  // Like Explorer: the file name. Titles in the metadata are often generic ("aitk_lora", "Krea 2 LoRA"), so they go in the details pane.
  const label = r => (r.file || r.name.split(/[\\/]/).pop()).replace(/\.safetensors$/i, "");
  const icon = (r, big) => `<span class="lx-ico${big ? " big" : ""}" style="--c:${FAM_COLOR[r.family] || FAM_COLOR.unknown}">${esc(FAM_SHORT[r.family] || "?")}</span>`;

  /* ---------------------------------------------------------------- the LoRAs step */
  const STR_MIN = -10, STR_MAX = 10;
  const clampStr = v => +Math.max(STR_MIN, Math.min(STR_MAX, +v || 0)).toFixed(2);
  // Long file names wrap after _ - . / (zero-width break points) rather than mid-word.
  const wrapName = t => esc(t).replace(/([_\-./])/g, "$1<wbr>");
  const fullPath = (r, name) => (r?.path || name).replace(/\\/g, "/");
  function add(name, strength = 1) {
    const i = state.loras.findIndex(l => l.name === name);
    if (i >= 0) state.loras[i].strength = strength;
    else if (state.loras.length >= 8) { Media.toast("Up to 8 LoRAs."); return false; }
    else state.loras.push({ name, strength });
    render(); scheduleSave();
    return true;
  }
  // Put another LoRA in row i, keeping its place and strength.
  function replace(i, name) {
    if (!state.loras[i]) return false;
    if (state.loras.some((l, j) => j !== i && l.name === name)) { Media.toast("That LoRA is already in the list."); return false; }
    state.loras[i] = { name, strength: state.loras[i].strength };
    render(); scheduleSave();
    return true;
  }
  function move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= state.loras.length || to >= state.loras.length) return;
    const [l] = state.loras.splice(from, 1);
    state.loras.splice(to, 0, l);
    render(); scheduleSave();
  }
  async function render() {
    const box = document.getElementById("lora-list");
    if (!box) return;
    document.getElementById("lora-model").textContent = modelName();
    if (!state.loras.length) {
      box.innerHTML = `<p class="hint lora-empty">No LoRAs. <button type="button" class="link" data-lx="browse">Browse LoRAs…</button> to add a style, a character or a motion.</p>`;
      return;
    }
    try { await load(); } catch {}
    const multi = state.loras.length > 1;
    box.innerHTML = state.loras.map((l, i) => {
      const r = byName(l.name) || { name: l.name, family: "unknown", triggers: [] };
      const ok = fits(r);
      const path = fullPath(r, l.name), cut = path.lastIndexOf("/");
      return `<div class="lora-row" data-i="${i}">
        <span class="lora-grip${multi ? "" : " off"}" data-grip title="${multi ? "Drag to reorder (LoRAs apply top to bottom)" : ""}" aria-hidden="true">⠿</span>
        ${icon(r)}
        <div class="lora-main">
          <div class="lora-name">${cut >= 0 ? `<span class="lora-dir">${wrapName(path.slice(0, cut + 1))}</span>` : ""}${wrapName(path.slice(cut + 1))}</div>
          ${ok ? "" : `<div class="lora-sub"><span class="warn" title="Made for ${esc(r.family_label || "another model")}, not ${esc(modelName())}: it may do nothing or break the result">⚠ not for ${esc(modelName())}</span></div>`}
          ${r.triggers?.length ? `<div class="lora-trig">${r.triggers.slice(0, 6).map(t => `<button type="button" class="chip-btn lora-tw" data-tw="${esc(t)}" title="Insert into the prompt">${esc(t)}</button>`).join("")}</div>` : ""}
        </div>
        <label class="lora-str" title="Strength from -10 to 10: 1 = full, 0.5 = half, negative = away from it">
          <input type="number" min="${STR_MIN}" max="${STR_MAX}" step="0.1" value="${l.strength}" data-k="num" aria-label="Strength">
        </label>
        <button type="button" class="ex-btn lora-more" data-lx="menu" title="More" aria-label="More for ${esc(path)}" aria-haspopup="menu">⋯</button>
      </div>`;
    }).join("");
  }
  function rowMenu(i, btn) {
    const n = state.loras.length, r = btn.getBoundingClientRect();
    Media.menu(r.left, r.bottom + 4, [
      i > 0 && ["Move up", () => move(i, i - 1)],
      i < n - 1 && ["Move down", () => move(i, i + 1)],
      ["Replace…", () => browse({ replace: i })],
      ["Details…", () => details(state.loras[i].name)],
      ["Remove", () => { state.loras.splice(i, 1); render(); scheduleSave(); }],
    ].filter(Boolean));
  }
  async function details(name) {
    try { await load(); } catch {}
    const r = byName(name) || { name, family_label: "Unknown" };
    const box = document.createElement("div");
    box.className = "lora-details";
    box.innerHTML = `<p class="hint">Reading its metadata…</p>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="ex-gap"></span><button type="button" class="btn sm" data-act="close">Close</button>`;
    const win = WM.open({ id: `lora-details:${name}`, title: label(r.file ? r : { name }), content: box, footer: foot, width: 720, height: 600, minWidth: 380, minHeight: 300 });
    foot.querySelector('[data-act="close"]').onclick = () => win.close();
    let md = null, err = "";
    try {
      const res = await fetch(`/api/loras/metadata?name=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      md = await res.json();
    } catch (e) { err = e.message; }
    const pretty = v => { const t = v.trim(); if (/^[[{]/.test(t)) { try { return JSON.stringify(JSON.parse(t), null, 2); } catch {} } return v; };
    const rows = md ? Object.entries(md.metadata) : [];
    box.innerHTML = `
      <div class="lora-det-head">
        <div class="lx-prev">${r.preview ? `<img src="/api/loras/preview?name=${encodeURIComponent(r.name)}" alt="">` : icon(r, true)}</div>
        <div class="lora-det-info">
          <h4 class="lora-det-name">${esc(fullPath(r, name))}</h4>
          ${r.title && r.title !== label(r.file ? r : { name }) ? `<p class="lx-title">“${esc(r.title)}”</p>` : ""}
          <dl class="lx-dl">
            <dt>Made for</dt><dd>${esc(r.family_label || "Unknown")} ${fits(r) ? `<span class="ok">✓ fits ${esc(modelName())}</span>` : `<span class="warn">⚠ not ${esc(modelName())}</span>`}</dd>
            ${r.base ? `<dt>Base</dt><dd>${esc(r.base)}</dd>` : ""}
            <dt>Type</dt><dd>${esc(r.kind || "lora")}${r.rank ? ` · rank ${r.rank}` : ""}${md ? ` · ${md.tensors} tensors${md.dtypes.length ? ` · ${esc(md.dtypes.join(", "))}` : ""}` : ""}</dd>
            ${r.size ? `<dt>Size</dt><dd>${fmtSize(r.size)} · ${fmtDate(r.mtime)}</dd>` : ""}
            ${r.trainer ? `<dt>Trained with</dt><dd>${esc(String(r.trainer).slice(0, 120))}</dd>` : ""}
          </dl>
        </div>
      </div>
      ${r.triggers?.length ? `<div class="lx-sec">Trigger words <span class="hint inline">(click to copy)</span></div><div class="lx-trig">${r.triggers.map(t => `<button type="button" class="chip-btn" data-copy="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
      ${r.description ? `<div class="lx-sec">About</div><p class="lx-desc">${esc(r.description)}</p>` : ""}
      <div class="lx-sec">Metadata ${md ? `<span class="hint inline">(${rows.length} field${rows.length === 1 ? "" : "s"})</span>` : ""}</div>
      ${err ? `<p class="warn">${esc(err)}</p>` : !rows.length ? `<p class="hint">This file has no metadata.</p>`
        : `<table class="lora-md"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v.length > 300 || v.includes("\n")
          ? `<details><summary>${esc(v.slice(0, 120))}${v.length > 120 ? "…" : ""}</summary><pre>${esc(pretty(v))}</pre></details>` : esc(v)}</td></tr>`).join("")}</tbody></table>`}`;
    box.addEventListener("click", e => {
      const cp = e.target.closest("[data-copy]");
      if (cp) navigator.clipboard?.writeText(cp.dataset.copy).then(() => Media.toast(`Copied “${cp.dataset.copy}”`));
    });
  }
  function initStep() {
    const step = document.querySelector('.step[data-step="loras"]');
    const list = document.getElementById("lora-list");
    step.addEventListener("click", e => {
      const a = e.target.closest("[data-lx]")?.dataset.lx, tw = e.target.closest("[data-tw]")?.dataset.tw;
      if (tw) return insertAtCursor($("#prompt"), tw);
      if (a === "browse") return browse();
      const i = +e.target.closest("[data-i]")?.dataset.i;
      if (Number.isNaN(i)) return;
      if (a === "menu") rowMenu(i, e.target.closest("[data-lx]"));
    });
    step.addEventListener("input", e => {
      const row = e.target.closest("[data-i]");
      if (e.target.dataset.k !== "num" || !row || e.target.value === "") return;
      state.loras[+row.dataset.i].strength = clampStr(e.target.value);
      scheduleSave();
    });
    step.addEventListener("change", e => {  // on leaving the box: show the clamped value
      const row = e.target.closest("[data-i]");
      if (e.target.dataset.k !== "num" || !row) return;
      const l = state.loras[+row.dataset.i];
      l.strength = clampStr(e.target.value); e.target.value = l.strength;
      scheduleSave();
    });
    // Mouse wheel over a strength box: up adds 0.1, down takes 0.1 (Shift: 1). One notch is one step.
    step.addEventListener("wheel", e => {
      const box = e.target.closest('[data-k="num"]'), row = box?.closest("[data-i]");
      if (!row || !e.deltaY) return;
      e.preventDefault();
      const l = state.loras[+row.dataset.i];
      l.strength = clampStr((+box.value || 0) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 1 : 0.1));
      box.value = l.strength;
      scheduleSave();
    }, { passive: false });
    // Drag the grip to reorder (pointer events, so mouse, pen and touch all work). The row
    // under the pointer shows a line where the dragged LoRA will land.
    let drag = null;
    const clearMarks = () => list.querySelectorAll(".drop-before, .drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"));
    const target = y => {  // [row, insert index] for a pointer height
      const rows = [...list.querySelectorAll(".lora-row")];
      if (!rows.length) return [null, -1];
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (y < r.top + r.height / 2) return [row, +row.dataset.i];
      }
      const last = rows[rows.length - 1];
      return [last, +last.dataset.i + 1];
    };
    list.addEventListener("pointerdown", e => {
      const g = e.target.closest("[data-grip]");
      if (!g || state.loras.length < 2 || e.button !== 0) return;
      e.preventDefault();
      const row = g.closest(".lora-row");
      drag = { from: +row.dataset.i, row, to: -1 };
      g.setPointerCapture(e.pointerId);
      row.classList.add("dragging");
      list.classList.add("reordering");
    });
    list.addEventListener("pointermove", e => {
      if (!drag) return;
      const [row, to] = target(e.clientY);
      drag.to = to;
      clearMarks();
      if (row && to !== drag.from && to !== drag.from + 1) row.classList.add(to === +row.dataset.i ? "drop-before" : "drop-after");
    });
    const end = e => {
      if (!drag) return;
      const { from, row } = drag;
      let to = drag.to;
      drag = null;
      clearMarks(); row.classList.remove("dragging"); list.classList.remove("reordering");
      if (e.type === "pointerup" && to >= 0) { if (to > from) to--; move(from, to); }
    };
    list.addEventListener("pointerup", end);
    list.addEventListener("pointercancel", end);
    document.getElementById("btn-lora-browse").onclick = () => browse();
  }

  /* ---------------------------------------------------------------- the LoRA Explorer */
  async function browse(opts = {}) {
    const ui = readUI().loraBrowser || {};
    const rep = Number.isInteger(opts.replace) && state.loras[opts.replace] ? opts.replace : null;
    const st = { path: ui.path ?? "", view: ui.view || "details", onlyFits: ui.onlyFits ?? true, q: "", sel: null,
      sort: ui.sort || { key: "name", dir: 1 }, back: [], fwd: [], expanded: new Set(ui.expanded || [""]), strength: 1 };
    const root = document.createElement("div");
    root.className = "ex lx";
    root.innerHTML = `
      <div class="ex-tool">
        <button type="button" class="ex-btn" data-act="back" title="Back (Alt+Left)">←</button>
        <button type="button" class="ex-btn" data-act="fwd" title="Forward (Alt+Right)">→</button>
        <button type="button" class="ex-btn" data-act="up" title="Up (Backspace)">↑</button>
        <button type="button" class="ex-btn" data-act="refresh" title="Look for new LoRAs (F5)">⟳</button>
        <div class="ex-addr" role="navigation" aria-label="Address"></div>
        <input type="search" class="ex-search" placeholder="Search LoRAs" aria-label="Search LoRAs (Ctrl+F)">
      </div>
      <div class="ex-cmd">
        <label class="lx-fit"><input type="checkbox" data-act="fits"> Only LoRAs for <b class="lx-model"></b></label>
        <select class="lx-fam" aria-label="Made for"><option value="">Any model</option></select>
        <label class="lx-fit"><input type="checkbox" data-act="norefmod" checked> Hide RefMods</label>
        <span class="ex-gap"></span>
        <button type="button" class="ex-btn" data-act="details" title="Details">☰</button>
        <button type="button" class="ex-btn" data-act="icons" title="Large icons">▦</button>
      </div>
      <div class="ex-main lx-main">
        <nav class="ex-nav" aria-label="Folders"></nav>
        <div class="ex-view" tabindex="0" aria-label="LoRAs"></div>
        <aside class="lx-pane" aria-label="Details"></aside>
      </div>
      <div class="ex-status"></div>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="ex-foot-label">Strength</span>
      <input type="range" class="lx-str" min="-2" max="2" step="0.05" value="1" aria-label="Strength"><input type="number" class="lx-strn" min="-10" max="10" step="0.1" value="1" aria-label="Strength">
      <span class="ex-gap"></span>
      <button type="button" class="btn sm primary" data-act="add" disabled>Add</button><button type="button" class="btn sm" data-act="close">Close</button>`;
    if (rep !== null) {  // replacing a row keeps its strength: no strength box
      foot.querySelector(".ex-foot-label").textContent = `Replace ${label(byName(state.loras[rep].name) || { name: state.loras[rep].name })}`;
      foot.querySelectorAll(".lx-str, .lx-strn").forEach(x => x.remove());
    }
    const win = WM.open({ id: "lora-browser", title: rep !== null ? `Replace a LoRA on ${modelName()}` : `LoRAs for ${modelName()}`, content: root, footer: foot, width: 1080, height: 660,
      minWidth: 520, minHeight: 360, className: "wm-explorer" });
    const $r = s => root.querySelector(s), view = $r(".ex-view");
    view.innerHTML = `<p class="ex-empty">Reading the LoRA folders…</p>`;
    try { await load(); } catch (e) { view.innerHTML = `<p class="ex-empty">Couldn't list LoRAs: ${esc(e.message)}</p>`; return; }
    const fams = [...new Set(data.loras.map(r => r.family))].sort();
    $r(".lx-fam").innerHTML += fams.map(f => `<option value="${f}">${esc(data.families[f] || f)}</option>`).join("");
    $r(".lx-fam").value = ui.fam || "";
    $r(".lx-model").textContent = modelName();
    $r('[data-act="fits"]').checked = st.onlyFits && (data.engine_families[engine()] || []).length > 0;

    const save = () => writeUI({ loraBrowser: { path: st.path, view: st.view, onlyFits: $r('[data-act="fits"]').checked, sort: st.sort,
      expanded: [...st.expanded], fam: $r(".lx-fam").value } });
    const passes = r => {
      if ($r('[data-act="norefmod"]').checked && r.kind === "refmod") return false;
      if ($r('[data-act="fits"]').checked && !fits(r)) return false;
      const f = $r(".lx-fam").value;
      return !f || r.family === f;
    };
    // folder tree from the LoRAs' paths
    function tree() {
      const t = { name: "All LoRAs", path: "", kids: new Map(), count: 0 };
      for (const r of data.loras) {
        if (!passes(r)) continue;
        t.count++;
        let n = t;
        for (const part of r.folder ? r.folder.split("/") : []) {
          const p = n.path ? `${n.path}/${part}` : part;
          if (!n.kids.has(part)) n.kids.set(part, { name: part, path: p, kids: new Map(), count: 0 });
          n = n.kids.get(part); n.count++;
        }
      }
      return t;
    }
    function nav(path, push = true) {
      if (push && path !== st.path) { st.back.push(st.path); st.fwd = []; }
      st.path = path; st.q = ""; $r(".ex-search").value = "";
      for (let p = path; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") st.expanded.add(p);
      st.expanded.add("");
      save(); draw();
    }
    function items() {
      const q = st.q.trim().toLowerCase();
      let rows = data.loras.filter(passes);
      const folders = [];
      if (q) {
        const terms = q.split(/\s+/);
        rows = rows.filter(r => (st.path ? r.path.startsWith(st.path + "/") : true) && terms.every(t => `${r.path} ${r.title} ${(r.triggers || []).join(" ")} ${r.family_label}`.toLowerCase().includes(t)));
      } else {
        const t = tree();
        let n = t; for (const part of st.path ? st.path.split("/") : []) n = n?.kids.get(part);
        if (n) folders.push(...[...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name)));
        rows = rows.filter(r => r.folder === st.path);
      }
      const k = st.sort.key, d = st.sort.dir;
      const val = r => k === "name" ? label(r).toLowerCase() : k === "for" ? r.family_label : k === "type" ? r.kind : k === "rank" ? (r.rank || 0)
        : k === "size" ? (r.size || 0) : k === "date" ? (r.mtime || 0) : "";
      rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * d);
      return { folders, rows };
    }
    function drawNav() {
      const t = tree(), out = [];
      const walk = (n, d) => {
        const open = st.expanded.has(n.path), kids = [...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name));
        out.push(`<div class="ex-node${n.path === st.path && !st.q ? " here" : ""}" data-path="${esc(n.path)}" style="--d:${d}" role="treeitem" aria-expanded="${open}">
          <button type="button" class="ex-twist${kids.length ? "" : " none"}" data-twist="${esc(n.path)}" tabindex="-1">${open ? "▾" : "▸"}</button>
          <span class="ex-nlabel">${d ? "📁" : "🧩"} ${esc(n.name)}</span><span class="lx-count">${n.count}</span></div>`);
        if (open) kids.forEach(k => walk(k, d + 1));
      };
      walk(t, 0);
      $r(".ex-nav").innerHTML = out.join("");
    }
    function drawAddr() {
      const parts = st.path ? st.path.split("/") : [];
      $r(".ex-addr").innerHTML = `<button type="button" class="ex-crumb" data-path="">🧩 LoRAs</button>` + parts.map((p, i) =>
        `<span class="ex-sep">›</span><button type="button" class="ex-crumb" data-path="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`).join("")
        + (st.q ? `<span class="ex-sep">›</span><span class="ex-crumb">Search “${esc(st.q)}”</span>` : "");
      $r('[data-act="back"]').disabled = !st.back.length;
      $r('[data-act="fwd"]').disabled = !st.fwd.length;
      $r('[data-act="up"]').disabled = !st.path;
      $r('[data-act="details"]').classList.toggle("on", st.view === "details");
      $r('[data-act="icons"]').classList.toggle("on", st.view === "icons");
    }
    function badge(r) {
      if (r.kind === "refmod") return `<span class="lx-badge bad" title="A RefMod reference embedding: it needs the RefMod nodes and can't be added as a LoRA">RefMod</span>`;
      if (r.turbo) return `<span class="lx-badge" title="H3's turbo LoRA: the Turbo setting applies it">turbo</span>`;
      if (!fits(r)) return `<span class="lx-badge warn" title="Made for ${esc(r.family_label)}">${esc(r.family_label)}</span>`;
      return state.loras.some(l => l.name === r.name) ? `<span class="lx-badge ok">added</span>` : "";
    }
    function drawView() {
      const { folders, rows } = items();
      if (!folders.length && !rows.length) { view.innerHTML = `<p class="ex-empty">${st.q ? "No LoRAs match." : "No LoRAs here with these filters."}</p>`; return; }
      if (st.view === "icons") {
        view.innerHTML = `<div class="ex-grid lx-grid">${folders.map(f => `<button type="button" class="ex-tile" data-folder="${esc(f.path)}">
            <span class="ex-big lx-folder">📁</span><span class="ex-tname">${esc(f.name)} <small>(${f.count})</small></span></button>`).join("")}
          ${rows.map(r => `<button type="button" class="ex-tile lx-tile${r.name === st.sel ? " sel" : ""}${r.kind === "refmod" ? " dim" : ""}" data-name="${esc(r.name)}" title="${esc(r.path)}">
            <span class="ex-big">${r.preview ? `<img loading="lazy" src="/api/loras/preview?name=${encodeURIComponent(r.name)}" alt="">` : icon(r, true)}</span>
            <span class="ex-tname">${esc(label(r))}</span>${badge(r)}</button>`).join("")}</div>`;
      } else {
        const th = (k, t) => `<th data-sort="${k}" class="${st.sort.key === k ? (st.sort.dir > 0 ? "asc" : "desc") : ""}">${t}</th>`;
        view.innerHTML = `<table class="ex-table lx-table"><thead><tr>${th("name", "Name")}${st.q ? "<th>Folder</th>" : ""}${th("for", "Made for")}${th("type", "Type")}${th("rank", "Rank")}${th("size", "Size")}${th("date", "Modified")}</tr></thead><tbody>
          ${folders.map(f => `<tr class="ex-item" data-folder="${esc(f.path)}"><td>📁 ${esc(f.name)}</td>${st.q ? "<td></td>" : ""}<td colspan="5">${f.count} LoRA${f.count === 1 ? "" : "s"}</td></tr>`).join("")}
          ${rows.map(r => `<tr class="ex-item${r.name === st.sel ? " sel" : ""}${r.kind === "refmod" ? " dim" : ""}" data-name="${esc(r.name)}" title="${esc(r.path)}">
            <td>${icon(r)} ${esc(label(r))} ${badge(r)}</td>${st.q ? `<td class="ex-where">${esc(r.folder || "—")}</td>` : ""}<td>${esc(r.family_label)}</td><td>${esc(r.kind)}</td>
            <td class="num">${r.rank ?? ""}</td><td class="num">${fmtSize(r.size)}</td><td class="num">${fmtDate(r.mtime)}</td></tr>`).join("")}
        </tbody></table>`;
      }
    }
    function drawPane() {
      const r = byName(st.sel), pane = $r(".lx-pane"), addBtn = foot.querySelector('[data-act="add"]');
      if (!r) {
        pane.innerHTML = `<p class="hint">Pick a LoRA to see what it's for, its trigger words and details. Double-click (or Enter) adds it.</p>`;
        addBtn.disabled = true; addBtn.textContent = "Add"; return;
      }
      const have = state.loras.find(l => l.name === r.name);
      pane.innerHTML = `
        <div class="lx-prev">${r.preview ? `<img src="/api/loras/preview?name=${encodeURIComponent(r.name)}" alt="">` : icon(r, true)}</div>
        <h4>${esc(label(r))}</h4>${r.title && r.title !== label(r) ? `<p class="lx-title">“${esc(r.title)}”</p>` : ""}
        <p class="lx-file" title="${esc(r.path)}">${esc(r.path)}</p>
        <dl class="lx-dl">
          <dt>Made for</dt><dd>${esc(r.family_label)} ${fits(r) ? `<span class="ok">✓ fits ${esc(modelName())}</span>` : `<span class="warn">⚠ not ${esc(modelName())}</span>`}</dd>
          ${r.base ? `<dt>Base</dt><dd>${esc(r.base)}</dd>` : ""}
          <dt>Type</dt><dd>${esc(r.kind)}${r.rank ? ` · rank ${r.rank}` : ""}${r.tensors ? ` · ${r.tensors} tensors` : ""}</dd>
          <dt>Size</dt><dd>${fmtSize(r.size)} · ${fmtDate(r.mtime)}</dd>
          ${r.trainer ? `<dt>Trained with</dt><dd>${esc(String(r.trainer).slice(0, 80))}</dd>` : ""}
        </dl>
        ${r.triggers?.length ? `<div class="lx-sec">Trigger words <span class="hint inline">(click to copy)</span></div><div class="lx-trig">${r.triggers.map(t => `<button type="button" class="chip-btn" data-copy="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
        ${r.description ? `<div class="lx-sec">About</div><p class="lx-desc">${esc(r.description)}</p>` : ""}
        ${r.kind === "refmod" ? `<p class="warn">A RefMod reference embedding, not a LoRA: it needs the RefMod nodes, so it can't be added here.</p>` : ""}
        ${r.turbo ? `<p class="hint">H3's turbo LoRA: the Turbo switch in Settings applies it.</p>` : ""}`;
      addBtn.disabled = r.kind === "refmod" || r.turbo;
      addBtn.textContent = rep !== null ? "Replace" : have ? "Update strength" : "Add";
    }
    function draw() { drawNav(); drawAddr(); drawView(); drawPane(); status(); }
    function status() {
      const { folders, rows } = items(), r = byName(st.sel);
      $r(".ex-status").innerHTML = `<span>${rows.length} LoRA${rows.length === 1 ? "" : "s"}${folders.length ? ` · ${folders.length} folder${folders.length === 1 ? "" : "s"}` : ""}</span>
        <span>${state.loras.length} on ${esc(modelName())}</span><span class="ex-root">${r ? esc(r.name) : ""}</span>`;
    }
    function select(name) { st.sel = name; view.querySelectorAll(".sel").forEach(e => e.classList.remove("sel")); view.querySelector(`[data-name="${CSS.escape(name)}"]`)?.classList.add("sel"); drawPane(); status(); }
    function addSel() {
      const r = byName(st.sel);
      if (!r || r.kind === "refmod" || r.turbo) return;
      if (rep !== null) {
        if (replace(rep, r.name)) { Media.toast(`Replaced with ${label(r)}.`); win.close(); }
        return;
      }
      if (add(r.name, st.strength)) { Media.toast(`${label(r)} ${state.loras.length ? "is on" : "added to"} ${modelName()} at ${st.strength}.`); drawView(); drawPane(); status(); }
    }

    root.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      const tw = e.target.closest("[data-twist]");
      if (tw) { const p = tw.dataset.twist; st.expanded.has(p) ? st.expanded.delete(p) : st.expanded.add(p); save(); return drawNav(); }
      const node = e.target.closest(".ex-node, .ex-crumb[data-path]");
      if (node) return nav(node.dataset.path);
      const cp = e.target.closest("[data-copy]");
      if (cp) { navigator.clipboard?.writeText(cp.dataset.copy).then(() => Media.toast(`Copied “${cp.dataset.copy}”`)); return; }
      const th = e.target.closest("th[data-sort]");
      if (th) { const k = th.dataset.sort; st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : 1 }; save(); return drawView(); }
      const f = e.target.closest("[data-folder]");
      if (f) return;  // folders open on double-click
      const it = e.target.closest("[data-name]");
      if (it) return select(it.dataset.name);
      if (act === "back" && st.back.length) { st.fwd.push(st.path); nav(st.back.pop(), false); }
      if (act === "fwd" && st.fwd.length) { st.back.push(st.path); nav(st.fwd.pop(), false); }
      if (act === "up" && st.path) nav(st.path.includes("/") ? st.path.slice(0, st.path.lastIndexOf("/")) : "");
      if (act === "refresh") { view.innerHTML = `<p class="ex-empty">Reading the LoRA folders…</p>`; load(true).then(draw, err => Media.toast(err.message)); }
      if (act === "details" || act === "icons") { st.view = act; save(); drawView(); drawAddr(); }
    });
    root.addEventListener("change", e => { if (e.target.matches('[data-act="fits"], [data-act="norefmod"], .lx-fam')) { save(); draw(); } });
    root.addEventListener("dblclick", e => {
      const f = e.target.closest("[data-folder]"); if (f) return nav(f.dataset.folder);
      if (e.target.closest("[data-name]")) addSel();
    });
    let qt = 0;
    $r(".ex-search").addEventListener("input", e => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value; drawAddr(); drawView(); status(); }, 120); });
    root.addEventListener("keydown", e => {
      if (e.target.matches("input, select") && e.key !== "Escape") { if (e.key === "Enter" && e.target.matches(".ex-search")) view.focus(); return; }
      const list = [...view.querySelectorAll("[data-name]")].map(x => x.dataset.name);
      const i = list.indexOf(st.sel);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $r(".ex-search").focus(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); if (list.length) { select(list[Math.min(list.length - 1, i + 1)]); view.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); } }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); if (list.length) { select(list[Math.max(0, i - 1)]); view.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); } }
      else if (e.key === "Enter") { e.preventDefault(); addSel(); }
      else if (e.key === "Backspace") { e.preventDefault(); if (st.path) nav(st.path.includes("/") ? st.path.slice(0, st.path.lastIndexOf("/")) : ""); }
      else if (e.key === "F5") { e.preventDefault(); load(true).then(draw); }
      else if (e.altKey && e.key === "ArrowLeft" && st.back.length) { st.fwd.push(st.path); nav(st.back.pop(), false); }
    });
    const syncStr = v => { st.strength = clampStr(v); foot.querySelectorAll(".lx-str, .lx-strn").forEach(x => { x.value = st.strength; }); };
    foot.addEventListener("input", e => { if (e.target.matches(".lx-str, .lx-strn")) syncStr(e.target.value); });
    foot.querySelector('[data-act="add"]').onclick = addSel;
    foot.querySelector('[data-act="close"]').onclick = () => win.close();
    draw();
    view.focus();
  }

  function forRequest() { return state.loras.map(l => ({ name: l.name, strength: l.strength })); }

  /* LoRAs on the list made for another model than the selected one. Only LoRAs whose model family is
     known count: an unknown one may fit, so it isn't flagged. */
  function mismatched(eng = engine()) {
    const want = data?.engine_families?.[eng] || [];
    if (!data || !want.length) return [];
    return state.loras.map((l, i) => ({ ...l, i, r: byName(l.name) }))
      .filter(x => x.r && x.r.family && x.r.family !== "unknown" && !want.includes(x.r.family));
  }

  /* After the model changes: if that leaves LoRAs that don't fit (and they did fit, or weren't
     there, before), say which and offer to take them off. prevEngine = the engine before the change. */
  async function checkFit(prevEngine) {
    if (!state.loras.length) return;
    try { await load(); } catch { return; }
    const bad = mismatched();
    if (!bad.length) return;
    const before = new Set(prevEngine ? mismatched(prevEngine).map(x => x.name) : []);
    if (bad.every(x => before.has(x.name))) return;  // nothing new: they didn't fit the last model either
    const name = modelName();
    const box = document.createElement("div");
    box.className = "wm-form lora-fit";
    box.innerHTML = `<p>${bad.length === 1 ? "This LoRA was" : `These ${bad.length} LoRAs were`} made for another model than <b>${esc(name)}</b>.
      On ${esc(name)} ${bad.length === 1 ? "it" : "they"} may do nothing, fail to load, or spoil the result.</p>
      <ul class="lora-fit-list">${bad.map(x => `<li>${icon(x.r)}<span class="lf-txt"><b title="${esc(fullPath(x.r, x.name))}">${esc(label(x.r))}</b><small>Made for ${esc(x.r.family_label || x.r.family)} · strength ${x.strength}</small></span></li>`).join("")}</ul>
      <p class="hint">Removed LoRAs can be added back from the LoRAs step (Browse LoRAs…).</p>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="keep">Keep them</button>
      <button type="button" class="btn sm primary" data-a="remove">Remove ${bad.length === 1 ? "it" : `all ${bad.length}`}</button>`;
    const w = WM.open({ id: "lora-fit", title: `LoRAs that don't fit ${name}`, content: box, footer: foot,
      width: 540, height: Math.min(560, 250 + bad.length * 52), minWidth: 360, minHeight: 220 });
    foot.addEventListener("click", e => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      if (a === "remove") {
        const drop = new Set(bad.map(x => x.name));
        state.loras = state.loras.filter(l => !drop.has(l.name));
        render(); scheduleSave(); renderSteps?.();
        Media.toast(`Removed ${bad.length} LoRA${bad.length === 1 ? "" : "s"} made for another model.`);
      }
      w.close();
    });
  }

  return { load, render, browse, initStep, add, replace, details, forRequest, fits: name => fits(byName(name)), mismatched, checkFit };
})();
