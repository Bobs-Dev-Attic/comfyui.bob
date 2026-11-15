/* Media gallery for the Inputs step: organise pictures, clips and sounds.

   Sources: the project's Library, its virtual folders (saved tag filters), bookmarked folders
   on disk, the project's results, and Uploads. Thumbnails come from /api/media/thumb (cached
   on disk and in the browser). Tag files to collect them into the library; a virtual folder
   shows every library item whose tags match.

   Media.mount(el)       compact gallery (Inputs step)
   Media.openWindow()    the same gallery in a large window, with a navigation pane
   Media.setProject(id, galleryConfig)   called by shell.js when a project opens */
"use strict";

const Media = (() => {
  const KIND_ICON = { image: "🖼", video: "▶", audio: "♪" };
  const TAG_COLORS = ["#ff7a45", "#7aa2ff", "#3ccf8e", "#c38bff", "#f5b942", "#3ccfc0", "#ff5d6c", "#9097a5"];
  const IMPORT_TYPES = "image/*,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/flac,audio/ogg,audio/mp4";

  const st = {
    project: "experiment",
    lib: { media: [], tags: [], virtual_folders: [] },
    bookmarks: [],
    view: { source: "library", thumb_size: 132, sort: "added", descending: true, kind: "all" },
    sub: "", q: "", tagFilter: new Set(), selected: new Set(), anchor: null,
    listing: null, loading: false, error: "",
  };
  const mounts = new Set();
  let win = null, saveTimer = null;

  /* ------------------------------------------------------------------ data */
  const pid = () => st.project;
  const libByRef = () => new Map(st.lib.media.map(m => [m.ref, m]));
  const tagColor = name => {
    const t = st.lib.tags.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (t?.color) return t.color;
    let h = 0; for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return TAG_COLORS[h % TAG_COLORS.length];
  };

  async function call(path, opts) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof j.detail === "string" ? j.detail : res.statusText);
    return j;
  }
  const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });

  async function loadLibrary() {
    try { st.lib = await call(`/api/projects/${pid()}/library`); } catch (e) { st.error = e.message; }
  }
  async function loadBookmarks() {
    try { st.bookmarks = (await call("/api/bookmarks")).bookmarks; } catch { st.bookmarks = []; }
  }
  function applyLib(lib) {
    st.lib = { media: lib.media, tags: lib.tags, virtual_folders: lib.virtual_folders };
    if (lib.errors?.length) toast(lib.errors.join("\n"));
  }

  async function loadSource() {
    const src = st.view.source;
    st.error = ""; st.listing = null;
    if (src === "library" || src.startsWith("vf:")) { renderAll(); return; }
    st.loading = true; renderAll();
    try {
      if (src === "results") st.listing = await call(`/api/media/list?source=results&project=${pid() === "experiment" ? "" : pid()}`);
      else if (src === "uploads") st.listing = await call(`/api/media/list?source=uploads&path=${encodeURIComponent(st.sub)}`);
      else if (src.startsWith("bm:")) st.listing = await call(`/api/media/list?source=bookmark&id=${src.slice(3)}&path=${encodeURIComponent(st.sub)}`);
    } catch (e) { st.error = e.message; }
    st.loading = false;
    renderAll();
  }

  function folderOf(id) { return st.lib.virtual_folders.find(f => f.id === id); }
  function matchesFolder(m, f) {
    const tags = new Set(m.tags.map(t => t.toLowerCase())), want = f.tags.map(t => t.toLowerCase());
    const ok = f.match === "any" ? want.some(t => tags.has(t)) : want.every(t => tags.has(t));
    return ok && (!f.kinds.length || f.kinds.includes(m.kind));
  }

  /* Everything shown for the current source, after search, kind and tag filters. */
  function currentItems() {
    const src = st.view.source, byRef = libByRef();
    let items;
    if (src === "library") items = st.lib.media;
    else if (src.startsWith("vf:")) { const f = folderOf(src.slice(3)); items = f ? st.lib.media.filter(m => matchesFolder(m, f)) : []; }
    else items = (st.listing?.files || []).map(f => { const m = byRef.get(f.ref); return m ? { ...f, ...m, url: f.url, thumb: f.thumb } : { ...f, tags: [] }; });
    const q = st.q.trim().toLowerCase();
    return items.filter(m =>
      (st.view.kind === "all" || m.kind === st.view.kind) &&
      (!q || m.name.toLowerCase().includes(q) || m.tags.some(t => t.toLowerCase().includes(q)) || (m.prompt || "").toLowerCase().includes(q)) &&
      [...st.tagFilter].every(t => m.tags.some(x => x.toLowerCase() === t.toLowerCase())))
      .sort(sorter());
  }
  function sorter() {
    const { sort, descending } = st.view, d = descending ? -1 : 1;
    const key = m => sort === "name" ? m.name.toLowerCase() : sort === "kind" ? m.kind + m.name.toLowerCase()
      : sort === "modified" ? m.modified || 0 : m.added || m.modified || 0;
    return (a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * d; };
  }

  /* ------------------------------------------------------------------ persistence of the view */
  function saveView() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      call(`/api/projects/${pid()}`, { method: "PUT", body: JSON.stringify({ config: { gallery: st.view } }) }).catch(() => {});
    }, 600);
  }
  function setSource(src, sub = "") {
    st.view.source = src; st.sub = sub; st.selected.clear(); st.tagFilter.clear();
    saveView(); loadSource();
  }

  /* ------------------------------------------------------------------ render */
  function sourceLabel(src = st.view.source) {
    if (src === "library") return "Library";
    if (src === "results") return "This project's results";
    if (src === "uploads") return "Uploads";
    if (src.startsWith("vf:")) return folderOf(src.slice(3))?.name || "Virtual folder";
    if (src.startsWith("bm:")) return st.bookmarks.find(b => b.id === src.slice(3))?.name || "Bookmark";
    return src;
  }

  function sourceOptions() {
    const o = (v, l) => `<option value="${esc(v)}"${v === st.view.source ? " selected" : ""}>${esc(l)}</option>`;
    return `<optgroup label="Library">${o("library", `All media (${st.lib.media.length})`)}
        ${st.lib.virtual_folders.map(f => o(`vf:${f.id}`, `📁 ${f.name}`)).join("")}</optgroup>
      ${st.bookmarks.length ? `<optgroup label="Bookmarks">${st.bookmarks.map(b => o(`bm:${b.id}`, `★ ${b.name}`)).join("")}</optgroup>` : ""}
      <optgroup label="Sources">${o("results", "This project's results")}${o("uploads", "Uploads")}</optgroup>`;
  }

  function navHTML() {
    const n = (src, label, count, extra = "") => `<button type="button" class="mg-nav-item${st.view.source === src ? " on" : ""}" data-src="${esc(src)}" ${extra}>
        <span class="mg-nav-label">${label}</span>${count != null ? `<span class="mg-count">${count}</span>` : ""}</button>`;
    const vfCount = f => st.lib.media.filter(m => matchesFolder(m, f)).length;
    return `
      <div class="mg-nav-h">Library</div>${n("library", "🗂 All media", st.lib.media.length)}
      <div class="mg-nav-h">Virtual folders <button type="button" class="mg-add" data-act="new-folder" title="New virtual folder">＋</button></div>
      ${st.lib.virtual_folders.map(f => n(`vf:${f.id}`, `📁 ${esc(f.name)}`, vfCount(f), `data-folder="${f.id}" title="${esc(f.match === "all" ? "Tags: " + f.tags.join(" + ") : "Any of: " + f.tags.join(", "))}"`)).join("")
        || `<p class="mg-nav-empty">Save a tag filter as a folder.</p>`}
      <div class="mg-nav-h">Bookmarks <button type="button" class="mg-add" data-act="bookmark" title="Bookmark a folder">＋</button></div>
      ${st.bookmarks.map(b => n(`bm:${b.id}`, `${b.exists ? "★" : "⚠"} ${esc(b.name)}`, null, `data-bookmark="${b.id}" title="${esc(b.path)}"`)).join("")
        || `<p class="mg-nav-empty">Bookmark folders on your PC to browse them here.</p>`}
      <div class="mg-nav-h">Sources</div>${n("results", "✨ This project's results", null)}${n("uploads", "⬆ Uploads", null)}
      <div class="mg-nav-h">Tags</div>
      <div class="mg-nav-tags">${st.lib.tags.map(t => `<button type="button" class="mg-tag${st.tagFilter.has(t.name) ? " on" : ""}" data-tag="${esc(t.name)}" style="--c:${tagColor(t.name)}">${esc(t.name)} <small>${t.count}</small></button>`).join("") || `<p class="mg-nav-empty">No tags yet.</p>`}</div>`;
  }

  function toolbarHTML(full) {
    const kinds = [["all", "All"], ["image", "🖼"], ["video", "▶"], ["audio", "♪"]];
    return `
      ${full ? "" : `<div class="mg-row">
        <select class="mg-source" aria-label="Show">${sourceOptions()}</select>
        <button type="button" class="btn sm ghost mg-more" data-act="more" title="Import, bookmark, new folder">＋</button>
        <button type="button" class="btn sm ghost" data-act="expand" title="Open the media library in a window">⤢</button></div>`}
      <div class="mg-row">
        <input type="search" class="mg-search" placeholder="Search names, tags, prompts" value="${esc(st.q)}" aria-label="Search media">
        <div class="seg sm mg-kinds">${kinds.map(([k, l]) => `<button type="button" data-kind="${k}" class="${st.view.kind === k ? "active" : ""}" title="${k === "all" ? "All kinds" : k}">${l}</button>`).join("")}</div>
        ${full ? `<select class="mg-sort" aria-label="Sort">${[["added", "Date added"], ["modified", "Date modified"], ["name", "Name"], ["kind", "Kind"]].map(([v, l]) => `<option value="${v}"${st.view.sort === v ? " selected" : ""}>${l}</option>`).join("")}</select>
          <button type="button" class="btn sm ghost" data-act="dir" title="Reverse order">${st.view.descending ? "↓" : "↑"}</button>
          <button type="button" class="btn sm" data-act="import">⬆ Import</button>` : ""}
        <input type="range" class="mg-size" min="72" max="320" step="8" value="${st.view.thumb_size}" aria-label="Thumbnail size" title="Thumbnail size">
      </div>`;
  }

  function tagBarHTML(items) {
    if (st.view.source === "library" || st.view.source.startsWith("vf:") || items.some(m => m.tags.length) || st.tagFilter.size) {
      const counts = new Map();
      for (const m of items) for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1);
      for (const t of st.tagFilter) if (!counts.has(t)) counts.set(t, 0);
      const tags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 24);
      if (!tags.length) return "";
      return `<div class="mg-tags">${tags.map(([t, c]) => `<button type="button" class="mg-tag${st.tagFilter.has(t) ? " on" : ""}" data-tag="${esc(t)}" style="--c:${tagColor(t)}">${esc(t)} <small>${c}</small></button>`).join("")}
        ${st.tagFilter.size ? `<button type="button" class="link" data-act="clear-tags">clear</button>
          <button type="button" class="link" data-act="folder-from-tags">＋ save as virtual folder</button>` : ""}</div>`;
    }
    return "";
  }

  function crumbsHTML() {
    const src = st.view.source;
    if (!(src === "uploads" || src.startsWith("bm:")) || !st.listing) return "";
    const root = `<button type="button" class="mg-crumb" data-sub="">${esc(sourceLabel())}</button>`;
    return `<div class="mg-crumbs">${root}${st.listing.crumbs.map(c => `<span>›</span><button type="button" class="mg-crumb" data-sub="${esc(c.sub)}">${esc(c.name)}</button>`).join("")}</div>`;
  }

  function thumbW() { const px = st.view.thumb_size * (window.devicePixelRatio || 1); return px <= 160 ? 160 : px <= 256 ? 256 : 384; }

  function tileHTML(m, inLib) {
    const sel = st.selected.has(m.ref), thumb = m.thumb ? m.thumb.replace(/&w=\d+/, `&w=${thumbW()}`) : "";
    return `<div class="mg-tile${sel ? " sel" : ""}${m.exists === false ? " missing" : ""}" data-ref="${esc(m.ref)}" draggable="${m.exists === false ? "false" : "true"}" tabindex="-1" title="${esc(m.name + (m.tags.length ? "\nTags: " + m.tags.join(", ") : "") + (m.exists === false ? "\nFile not found" : ""))}">
        <div class="mg-img">${thumb && m.exists !== false ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'mg-ph',textContent:'${KIND_ICON[m.kind]}'}))">` : `<span class="mg-ph">${m.exists === false ? "⚠" : KIND_ICON[m.kind]}</span>`}
          ${m.kind !== "image" ? `<span class="mg-kind">${KIND_ICON[m.kind]}</span>` : ""}
          ${inLib ? `<span class="mg-inlib" title="In the library">●</span>` : ""}
          <span class="mg-check">✓</span></div>
        <div class="mg-name">${esc(m.name)}</div>
        ${m.tags.length ? `<div class="mg-dots">${m.tags.slice(0, 6).map(t => `<i style="background:${tagColor(t)}" title="${esc(t)}"></i>`).join("")}</div>` : ""}
      </div>`;
  }

  function gridHTML(items) {
    if (st.loading) return `<div class="mg-empty">Loading…</div>`;
    if (st.error) return `<div class="mg-empty err">${esc(st.error)}</div>`;
    // Sub-folders only while browsing; a tag filter is about files.
    const folders = st.tagFilter.size ? [] : (st.listing?.folders || []).filter(f => !st.q || f.name.toLowerCase().includes(st.q.toLowerCase()));
    const byRef = libByRef();
    if (!items.length && !folders.length) {
      const src = st.view.source;
      const msg = src === "library" ? "The library is empty. Import files, or tag items from a bookmark, your results or uploads to collect them here."
        : src.startsWith("vf:") ? "Nothing in the library has these tags yet."
        : st.q || st.tagFilter.size || st.view.kind !== "all" ? "Nothing matches the filters." : "No media files here.";
      return `<div class="mg-empty">${esc(msg)}</div>`;
    }
    return `<div class="mg-grid" style="--ts:${st.view.thumb_size}px">
      ${folders.map(f => `<div class="mg-tile mg-folder" data-sub="${esc(f.sub)}" title="${esc(f.name)}"><div class="mg-img"><span class="mg-ph">📁</span></div><div class="mg-name">${esc(f.name)}</div></div>`).join("")}
      ${items.map(m => tileHTML(m, byRef.has(m.ref))).join("")}</div>`;
  }

  function selBarHTML(items) {
    const n = st.selected.size;
    if (!n) return `<div class="mg-status">${items.length} item${items.length === 1 ? "" : "s"}${st.listing?.truncated ? " (first 2000)" : ""}</div>`;
    const byRef = libByRef(), refs = [...st.selected];
    const inLib = refs.filter(r => byRef.has(r)).length;
    const pics = refs.filter(r => (byRef.get(r) || items.find(m => m.ref === r))?.kind === "image").length;
    return `<div class="mg-selbar"><b>${n} selected</b>
      ${pics ? `<button type="button" class="btn sm primary" data-act="use">Use</button>` : ""}
      <button type="button" class="btn sm" data-act="tags">🏷 Tags…</button>
      ${inLib < n ? `<button type="button" class="btn sm" data-act="add">＋ Library</button>` : ""}
      ${inLib ? `<button type="button" class="btn sm" data-act="remove">Remove</button>` : ""}
      <button type="button" class="btn sm ghost" data-act="deselect" title="Clear selection">✕</button></div>`;
  }

  function render(root) {
    const full = root.classList.contains("mg-full");
    const items = currentItems();
    if (full) {
      root.querySelector(".mg-nav").innerHTML = navHTML();
      root.querySelector(".mg-head").innerHTML = `<h3>${esc(sourceLabel())}</h3>${toolbarHTML(true)}`;
    } else {
      root.querySelector(".mg-head").innerHTML = toolbarHTML(false);
    }
    root.querySelector(".mg-tagbar").innerHTML = tagBarHTML(items);
    root.querySelector(".mg-crumbbar").innerHTML = crumbsHTML();
    const body = root.querySelector(".mg-body"), scroll = body.scrollTop;
    body.innerHTML = gridHTML(items);
    body.scrollTop = scroll;
    root.querySelector(".mg-foot").innerHTML = selBarHTML(items) + (full ? `<span class="mg-cache" data-act="cache" title="Thumbnails are cached in data/thumbs">Thumbnail cache…</span>` : "");
    root._items = items;
  }
  function renderAll() { for (const r of mounts) if (document.contains(r)) render(r); else mounts.delete(r); }

  /* ------------------------------------------------------------------ actions */
  function selectedItems(root) {
    const all = new Map([...(root._items || []), ...st.lib.media].map(m => [m.ref, m]));
    return [...st.selected].map(r => all.get(r)).filter(Boolean);
  }

  function useItems(items, as = null) {
    const pics = items.filter(m => m.kind === "image" && m.exists !== false);
    if (!pics.length) return toast("Only pictures can be used as inputs.");
    const eng = state.engine[state.kind];
    if (state.kind !== "video") return toast("The current model doesn't take pictures. Pick a video model in step 2.");
    if (eng === "h3ref" && as !== "first_frame" && as !== "last_frame") {
      for (const m of pics) if (!state.refs.some(r => r.ref === m.ref)) addRef(m.ref, m.url);
      return;
    }
    if (as === "reference") return toast("Switch to H3 Reference in step 2 to use reference pictures.");
    const role = as || (!state.frames.first_frame ? "first_frame" : "last_frame");
    setFrame(role, pics[0].ref, pics[0].url);
    if (!as && pics[1] && role === "first_frame") setFrame("last_frame", pics[1].ref, pics[1].url);
  }

  async function addToLibrary(refs, tags = []) {
    try { applyLib(await post(`/api/projects/${pid()}/library/add`, { refs, tags })); renderAll(); }
    catch (e) { toast(e.message); }
  }
  async function removeFromLibrary(refs) {
    const byRef = libByRef(), ids = refs.map(r => byRef.get(r)?.id).filter(Boolean);
    if (!ids.length) return;
    const ok = await WM.ask({ title: "Remove from library", message: `Remove ${ids.length} item${ids.length > 1 ? "s" : ""} from this project's library? The files stay on disk.`, ok: "Remove" });
    if (!ok) return;
    try { applyLib(await post(`/api/projects/${pid()}/library/remove`, { ids })); st.selected.clear(); renderAll(); }
    catch (e) { toast(e.message); }
  }

  async function importFiles(files) {
    const refs = [];
    for (const f of files) {
      const fd = new FormData(); fd.append("file", f);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (!res.ok) throw new Error(j.detail || res.statusText);
        refs.push(j.ref);
      } catch (e) { toast(`${f.name}: ${e.message}`); }
    }
    if (refs.length) {
      await addToLibrary(refs, [...st.tagFilter]);
      toast(`Imported ${refs.length} file${refs.length > 1 ? "s" : ""} into the library.`);
    }
  }
  function pickFiles() {
    const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, accept: IMPORT_TYPES });
    input.onchange = () => importFiles([...input.files]);
    input.click();
  }

  function preview(m) {
    const box = document.createElement("div");
    box.className = "mg-preview";
    const mediaEl = m.kind === "image" ? `<img src="${esc(m.url)}" alt="">`
      : m.kind === "video" ? `<video src="${esc(m.url)}" controls autoplay loop playsinline></video>`
      : `<div class="mg-audio">${m.thumb ? `<img src="${esc(m.thumb.replace(/&w=\d+/, "&w=640"))}" alt="">` : ""}<audio src="${esc(m.url)}" controls autoplay></audio></div>`;
    box.innerHTML = `<div class="mg-pv-media">${mediaEl}</div>
      <div class="mg-pv-info"><b>${esc(m.name)}</b><span>${esc(m.ref)}</span>
        ${m.size ? `<span>${(m.size / 1048576).toFixed(m.size > 1048576 ? 1 : 2)} MB</span>` : ""}
        <span>${m.tags.length ? m.tags.map(t => `<i class="mg-tag on" style="--c:${tagColor(t)}">${esc(t)}</i>`).join(" ") : "No tags"}</span></div>`;
    const foot = document.createElement("div");
    const canUse = m.kind === "image" && state.kind === "video";
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="tags">🏷 Tags…</button>
      ${canUse ? `<button type="button" class="btn sm primary" data-a="use">Use</button>` : ""}<button type="button" class="btn sm" data-a="close">Close</button>`;
    const w = WM.open({ id: "media-preview", title: m.name, content: box, footer: foot, width: 760, height: 560, minWidth: 360, minHeight: 280 });
    foot.querySelector('[data-a="close"]').onclick = () => w.close();
    foot.querySelector('[data-a="tags"]').onclick = () => { w.close(); tagsDialog([m]); };
    foot.querySelector('[data-a="use"]')?.addEventListener("click", () => { w.close(); useItems([m]); });
  }

  /* ------------------------------------------------------------------ dialogs */
  function chipInput(initial = []) {
    // A tag picker: chips for chosen tags, a text box with suggestions, Enter or comma to add.
    const wrap = document.createElement("div");
    wrap.className = "mg-chipin";
    const chosen = [...initial];
    const listId = `tags-${Math.random().toString(36).slice(2)}`;
    wrap.innerHTML = `<div class="mg-chips"></div><input type="text" list="${listId}" placeholder="Type a tag, press Enter"><datalist id="${listId}">${st.lib.tags.map(t => `<option value="${esc(t.name)}">`).join("")}</datalist>`;
    const chips = wrap.querySelector(".mg-chips"), input = wrap.querySelector("input");
    const draw = () => {
      chips.innerHTML = chosen.map((t, i) => `<span class="mg-tag on" style="--c:${tagColor(t)}">${esc(t)} <button type="button" data-i="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join("");
    };
    const add = v => { for (const t of v.split(",").map(s => s.trim()).filter(Boolean)) if (!chosen.some(c => c.toLowerCase() === t.toLowerCase())) chosen.push(t.slice(0, 40)); input.value = ""; draw(); wrap.dispatchEvent(new Event("change")); };
    input.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === ",") && input.value.trim()) { e.preventDefault(); add(input.value); } else if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); draw(); wrap.dispatchEvent(new Event("change")); } });
    input.addEventListener("change", () => { if (input.value.trim()) add(input.value); });
    chips.addEventListener("click", e => { const b = e.target.closest("[data-i]"); if (b) { chosen.splice(+b.dataset.i, 1); draw(); wrap.dispatchEvent(new Event("change")); } });
    draw();
    wrap.value = () => { if (input.value.trim()) add(input.value); return chosen; };
    wrap.toggle = t => { const i = chosen.findIndex(c => c.toLowerCase() === t.toLowerCase()); if (i >= 0) chosen.splice(i, 1); else chosen.push(t); draw(); wrap.dispatchEvent(new Event("change")); };
    wrap.has = t => chosen.some(c => c.toLowerCase() === t.toLowerCase());
    return wrap;
  }

  function tagsDialog(items) {
    const refs = items.map(m => m.ref);
    const counts = new Map();
    for (const m of items) for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1);
    const form = document.createElement("div");
    form.className = "wm-form";
    form.innerHTML = `<p class="hint">${items.length} file${items.length > 1 ? "s" : ""}. Tagging a file also collects it into this project's library.</p>
      <div class="field"><label>Current tags <span class="opt">click × to remove from all</span></label><div class="mg-current"></div></div>
      <div class="field"><label>Add tags</label><div class="mg-addwrap"></div></div>
      ${st.lib.tags.length ? `<div class="field"><label>Suggestions</label><div class="mg-sugg">${st.lib.tags.map(t => `<button type="button" class="mg-tag" data-s="${esc(t.name)}" style="--c:${tagColor(t.name)}">${esc(t.name)}</button>`).join("")}</div></div>` : ""}`;
    const removed = new Set();
    const cur = form.querySelector(".mg-current");
    const drawCur = () => {
      const list = [...counts].filter(([t]) => !removed.has(t));
      cur.innerHTML = list.length ? list.map(([t, c]) => `<span class="mg-tag on" style="--c:${tagColor(t)}">${esc(t)} <small>${c}/${items.length}</small> <button type="button" data-rm="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join("") : `<span class="hint">None</span>`;
    };
    drawCur();
    cur.addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) { removed.add(b.dataset.rm); drawCur(); } });
    const adder = chipInput();
    form.querySelector(".mg-addwrap").appendChild(adder);
    form.querySelector(".mg-sugg")?.addEventListener("click", e => { const b = e.target.closest("[data-s]"); if (b) { adder.toggle(b.dataset.s); b.classList.toggle("on", adder.has(b.dataset.s)); } });
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="save">Apply</button>`;
    const w = WM.open({ id: "media-tags", title: "Tags", content: form, footer: foot, width: 480, height: 440, minWidth: 340, minHeight: 300 });
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="save"]').onclick = async () => {
      try {
        applyLib(await post(`/api/projects/${pid()}/library/tags`, { refs, add: adder.value(), remove: [...removed] }));
        w.close(); renderAll();
      } catch (e) { toast(e.message); }
    };
  }

  function folderDialog(folder = null, presetTags = []) {
    const f = folder || { name: "", tags: presetTags, match: "all", kinds: [] };
    const form = document.createElement("div");
    form.className = "wm-form";
    form.innerHTML = `
      <div class="field"><label for="vf-name">Name</label><input id="vf-name" type="text" maxlength="80" value="${esc(f.name)}" placeholder="e.g. Cast, Locations, Night shots" autofocus></div>
      <div class="field"><label>Show library items tagged</label><div class="vf-tags"></div></div>
      <div class="field"><label>Match</label><div class="radios">
        <label><input type="radio" name="vf-match" value="all"${f.match === "all" ? " checked" : ""}> All of these tags</label>
        <label><input type="radio" name="vf-match" value="any"${f.match === "any" ? " checked" : ""}> Any of them</label></div></div>
      <div class="field"><label>Kinds <span class="opt">none ticked = all</span></label><div class="radios">
        ${["image", "video", "audio"].map(k => `<label><input type="checkbox" name="vf-kind" value="${k}"${f.kinds.includes(k) ? " checked" : ""}> ${KIND_ICON[k]} ${k}</label>`).join("")}</div></div>
      <p class="hint" id="vf-count"></p><p class="err" id="vf-err"></p>`;
    const tags = chipInput(f.tags);
    form.querySelector(".vf-tags").appendChild(tags);
    const preview = () => {
      const probe = { tags: tags.value(), match: form.querySelector('input[name="vf-match"]:checked').value, kinds: [...form.querySelectorAll('input[name="vf-kind"]:checked')].map(i => i.value) };
      const n = probe.tags.length ? st.lib.media.filter(m => matchesFolder(m, probe)).length : 0;
      form.querySelector("#vf-count").textContent = probe.tags.length ? `${n} item${n === 1 ? "" : "s"} in the library match right now.` : "Add at least one tag.";
    };
    tags.addEventListener("change", preview); form.addEventListener("change", preview); preview();
    const foot = document.createElement("div");
    foot.innerHTML = `${folder ? `<button type="button" class="btn sm danger" data-a="delete">Delete folder</button>` : ""}<span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="save">${folder ? "Save" : "Create folder"}</button>`;
    const w = WM.open({ id: "media-folder", title: folder ? "Edit virtual folder" : "New virtual folder", content: form, footer: foot, width: 500, height: 470, minWidth: 360, minHeight: 360 });
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="save"]').onclick = async () => {
      const body = { ...(folder ? { id: folder.id, created: folder.created } : {}), name: form.querySelector("#vf-name").value.trim(), tags: tags.value(),
        match: form.querySelector('input[name="vf-match"]:checked').value, kinds: [...form.querySelectorAll('input[name="vf-kind"]:checked')].map(i => i.value) };
      try {
        const lib = await post(`/api/projects/${pid()}/library/folders`, body);
        applyLib(lib); w.close();
        const made = folder || lib.virtual_folders.find(x => x.name === body.name);
        if (made) setSource(`vf:${made.id}`); else renderAll();
      } catch (e) { form.querySelector("#vf-err").textContent = e.message; }
    };
    foot.querySelector('[data-a="delete"]')?.addEventListener("click", async () => {
      if (!await WM.ask({ title: "Delete virtual folder", message: `Delete “${folder.name}”? Only the folder goes; items and tags stay.`, ok: "Delete", danger: true })) return;
      try { applyLib(await call(`/api/projects/${pid()}/library/folders/${folder.id}`, { method: "DELETE" })); w.close(); if (st.view.source === `vf:${folder.id}`) setSource("library"); else renderAll(); }
      catch (e) { toast(e.message); }
    });
  }

  function bookmarkDialog() {
    const form = document.createElement("div");
    form.className = "wm-form mg-fs";
    form.innerHTML = `
      <div class="field"><label for="bm-path">Folder</label>
        <div class="loc"><button type="button" class="btn sm" data-up title="Up">↑</button><input id="bm-path" type="text" spellcheck="false" placeholder="Pick below or paste a path, like D:\\Pictures"><button type="button" class="btn sm" data-go>Go</button></div></div>
      <div class="mg-fslist" role="listbox" aria-label="Folders"></div>
      <div class="field"><label for="bm-name">Name</label><input id="bm-name" type="text" maxlength="80" placeholder="Shown in the gallery"></div>
      <p class="err" id="bm-err"></p>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="save">Bookmark folder</button>`;
    const w = WM.open({ id: "media-bookmark", title: "Bookmark a folder", content: form, footer: foot, width: 560, height: 560, minWidth: 380, minHeight: 400 });
    const pathIn = form.querySelector("#bm-path"), nameIn = form.querySelector("#bm-name"), list = form.querySelector(".mg-fslist");
    let parent = null;
    const go = async path => {
      try {
        const j = await call(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
        parent = j.parent; pathIn.value = j.path.replaceAll("/", "\\");
        if (j.path) nameIn.value = j.path.split("/").filter(Boolean).pop() || "";
        list.innerHTML = j.dirs.map(d => `<button type="button" class="mg-fsitem" data-path="${esc(d.path)}">${d.type === "drive" ? "💽" : d.type === "place" ? "⭐" : "📁"} ${esc(d.name)}</button>`).join("") || `<p class="hint">No sub-folders.</p>`;
        form.querySelector("[data-up]").disabled = parent === null;
        form.querySelector("#bm-err").textContent = "";
      } catch (e) { form.querySelector("#bm-err").textContent = e.message; }
    };
    list.addEventListener("click", e => { const b = e.target.closest("[data-path]"); if (b) go(b.dataset.path); });
    form.querySelector("[data-up]").onclick = () => go(parent ?? "");
    form.querySelector("[data-go]").onclick = () => go(pathIn.value.trim());
    pathIn.addEventListener("keydown", e => { if (e.key === "Enter") go(pathIn.value.trim()); });
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="save"]').onclick = async () => {
      try {
        const b = await post("/api/bookmarks", { path: pathIn.value.trim(), name: nameIn.value.trim() });
        await loadBookmarks(); w.close(); setSource(`bm:${b.id}`);
      } catch (e) { form.querySelector("#bm-err").textContent = e.message; }
    };
    go("");
  }

  async function tagMenu(name, x, y) {
    menu(x, y, [
      ["Rename tag…", async () => {
        const nn = await WM.ask({ title: "Rename tag", message: `Rename “${name}” everywhere in this project`, input: name, ok: "Rename" });
        if (nn && nn !== name) { try { applyLib(await post(`/api/projects/${pid()}/library/tag`, { name, new_name: nn })); st.tagFilter.delete(name); renderAll(); } catch (e) { toast(e.message); } }
      }],
      ["Colour…", () => {
        const inp = Object.assign(document.createElement("input"), { type: "color", value: tagColor(name) });
        inp.onchange = async () => { try { applyLib(await post(`/api/projects/${pid()}/library/tag`, { name, color: inp.value })); renderAll(); } catch (e) { toast(e.message); } };
        inp.click();
      }],
      ["Delete tag", async () => {
        if (!await WM.ask({ title: "Delete tag", message: `Remove “${name}” from every item and virtual folder?`, ok: "Delete", danger: true })) return;
        try { applyLib(await post(`/api/projects/${pid()}/library/tag`, { name })); st.tagFilter.delete(name); renderAll(); } catch (e) { toast(e.message); }
      }],
    ]);
  }

  async function bookmarkMenu(id, x, y) {
    const b = st.bookmarks.find(v => v.id === id);
    menu(x, y, [
      ["Rename bookmark…", async () => {
        const nn = await WM.ask({ title: "Rename bookmark", message: b.path, input: b.name, ok: "Rename" });
        if (nn) { try { await call(`/api/bookmarks/${id}`, { method: "PATCH", body: JSON.stringify({ name: nn }) }); await loadBookmarks(); renderAll(); } catch (e) { toast(e.message); } }
      }],
      ["Remove bookmark", async () => {
        if (!await WM.ask({ title: "Remove bookmark", message: `Remove the bookmark “${b.name}”? The folder itself isn't touched.`, ok: "Remove" })) return;
        await call(`/api/bookmarks/${id}`, { method: "DELETE" }); await loadBookmarks();
        if (st.view.source === `bm:${id}`) setSource("library"); else renderAll();
      }],
    ]);
  }

  async function cacheDialog() {
    let c = {};
    try { c = await call("/api/media/cache"); } catch {}
    const ok = await WM.ask({ title: "Thumbnail cache", message: `${c.files || 0} thumbnails, ${((c.bytes || 0) / 1048576).toFixed(1)} MB in data\\thumbs. They're remade when needed. Clear the cache?`, ok: "Clear cache" });
    if (ok) { await call("/api/media/cache", { method: "DELETE" }); toast("Thumbnail cache cleared."); }
  }

  function moreMenu(x, y) {
    menu(x, y, [
      ["⬆ Import files…", pickFiles],
      ["★ Bookmark a folder…", bookmarkDialog],
      ["📁 New virtual folder…", () => folderDialog(null, [...st.tagFilter])],
      ["⤢ Open in a window", openWindow],
    ]);
  }

  function itemMenu(root, x, y) {
    const items = selectedItems(root);
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null, byRef = libByRef();
    const pics = items.filter(m => m.kind === "image");
    const eng = state.engine[state.kind], video = state.kind === "video";
    const entries = [
      one && ["Open", () => preview(one)],
      pics.length && video && eng === "h3" && ["Use as first frame", () => useItems(pics, "first_frame")],
      pics.length && video && eng === "h3" && ["Use as last frame", () => useItems(pics, "last_frame")],
      pics.length && video && eng === "h3ref" && [`Add as reference${pics.length > 1 ? "s" : ""}`, () => useItems(pics, "reference")],
      ["🏷 Tags…", () => tagsDialog(items)],
      items.some(m => !byRef.has(m.ref)) && ["＋ Add to library", () => addToLibrary(items.map(m => m.ref))],
      items.some(m => byRef.has(m.ref)) && ["Remove from library", () => removeFromLibrary(items.map(m => m.ref))],
      one && ["Copy path", () => navigator.clipboard?.writeText(one.ref).then(() => toast("Path copied."))],
    ].filter(Boolean);
    menu(x, y, entries);
  }

  function menu(x, y, items) {
    document.querySelector(".ex-menu")?.remove();
    const m = document.createElement("div");
    m.className = "ex-menu"; m.setAttribute("role", "menu");
    m.innerHTML = items.map(([l], i) => `<button type="button" role="menuitem" data-i="${i}">${esc(l)}</button>`).join("");
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    Object.assign(m.style, { left: Math.min(x, innerWidth - r.width - 8) + "px", top: Math.min(y, innerHeight - r.height - 8) + "px", zIndex: 100000 });
    const close = () => { m.remove(); document.removeEventListener("pointerdown", outside, true); };
    const outside = ev => { if (!m.contains(ev.target)) close(); };
    m.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) { close(); items[+b.dataset.i][1](); } });
    m.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } });
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
    m.querySelector("button")?.focus();
  }

  function toast(msg) {
    let t = document.querySelector(".mg-toast");
    if (!t) { t = Object.assign(document.createElement("div"), { className: "mg-toast", role: "status" }); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3200);
  }

  /* ------------------------------------------------------------------ events */
  function bind(root) {
    root.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) {
        if (act === "expand") return openWindow();
        if (act === "more") { const r = e.target.getBoundingClientRect(); return moreMenu(r.left, r.bottom + 4); }
        if (act === "import") return pickFiles();
        if (act === "new-folder") return folderDialog(null, [...st.tagFilter]);
        if (act === "bookmark") return bookmarkDialog();
        if (act === "folder-from-tags") return folderDialog(null, [...st.tagFilter]);
        if (act === "clear-tags") { st.tagFilter.clear(); return renderAll(); }
        if (act === "dir") { st.view.descending = !st.view.descending; saveView(); return renderAll(); }
        if (act === "deselect") { st.selected.clear(); return renderAll(); }
        if (act === "use") return useItems(selectedItems(root));
        if (act === "tags") return tagsDialog(selectedItems(root));
        if (act === "add") return addToLibrary([...st.selected]);
        if (act === "remove") return removeFromLibrary([...st.selected]);
        if (act === "cache") return cacheDialog();
      }
      const nav = e.target.closest("[data-src]"); if (nav) return setSource(nav.dataset.src);
      const tag = e.target.closest(".mg-tag[data-tag]");
      if (tag) { const t = tag.dataset.tag; st.tagFilter.has(t) ? st.tagFilter.delete(t) : st.tagFilter.add(t); return renderAll(); }
      const kind = e.target.closest("[data-kind]");
      if (kind) { st.view.kind = kind.dataset.kind; saveView(); return renderAll(); }
      const crumb = e.target.closest("[data-sub]");
      if (crumb && (crumb.classList.contains("mg-crumb") || crumb.classList.contains("mg-folder"))) { st.sub = crumb.dataset.sub; st.selected.clear(); return loadSource(); }
      const tile = e.target.closest(".mg-tile[data-ref]");
      if (tile) {
        const ref = tile.dataset.ref, items = root._items || [];
        if (e.shiftKey && st.anchor) {
          const a = items.findIndex(m => m.ref === st.anchor), b = items.findIndex(m => m.ref === ref);
          if (a >= 0 && b >= 0) { if (!(e.ctrlKey || e.metaKey)) st.selected.clear(); for (const m of items.slice(Math.min(a, b), Math.max(a, b) + 1)) st.selected.add(m.ref); }
        } else if (e.ctrlKey || e.metaKey) { st.selected.has(ref) ? st.selected.delete(ref) : st.selected.add(ref); st.anchor = ref; }
        else { st.selected.clear(); st.selected.add(ref); st.anchor = ref; }
        return renderAll();
      }
      if (e.target.closest(".mg-body") && !e.target.closest(".mg-tile")) { st.selected.clear(); renderAll(); }
    });
    root.addEventListener("dblclick", e => {
      const tile = e.target.closest(".mg-tile[data-ref]");
      if (!tile) return;
      const m = (root._items || []).find(x => x.ref === tile.dataset.ref);
      if (!m) return;
      if (m.kind === "image" && state.kind === "video") useItems([m]); else preview(m);
    });
    root.addEventListener("contextmenu", e => {
      const tile = e.target.closest(".mg-tile[data-ref]");
      if (tile) {
        e.preventDefault();
        if (!st.selected.has(tile.dataset.ref)) { st.selected.clear(); st.selected.add(tile.dataset.ref); renderAll(); }
        return itemMenu(root, e.clientX, e.clientY);
      }
      const tag = e.target.closest(".mg-tag[data-tag]");
      if (tag && st.lib.tags.some(t => t.name === tag.dataset.tag)) { e.preventDefault(); return tagMenu(tag.dataset.tag, e.clientX, e.clientY); }
      const folder = e.target.closest("[data-folder]");
      if (folder) { e.preventDefault(); return folderDialog(folderOf(folder.dataset.folder)); }
      const bm = e.target.closest("[data-bookmark]");
      if (bm) { e.preventDefault(); return bookmarkMenu(bm.dataset.bookmark, e.clientX, e.clientY); }
    });
    root.addEventListener("change", e => {
      if (e.target.matches(".mg-source")) setSource(e.target.value);
      if (e.target.matches(".mg-sort")) {
        st.view.sort = e.target.value;
        st.view.descending = st.view.sort === "added" || st.view.sort === "modified";  // newest first, names A→Z
        saveView(); renderAll();
      }
    });
    root.addEventListener("input", e => {
      if (e.target.matches(".mg-search")) {
        st.q = e.target.value;
        const pos = e.target.selectionStart;
        renderAll();
        const again = root.querySelector(".mg-search"); again.focus(); again.setSelectionRange(pos, pos);
      }
      if (e.target.matches(".mg-size")) {
        st.view.thumb_size = +e.target.value;
        for (const r of mounts) { r.querySelector(".mg-grid")?.style.setProperty("--ts", st.view.thumb_size + "px"); const s = r.querySelector(".mg-size"); if (s && s !== e.target) s.value = e.target.value; }
        saveView();
      }
    });
    // Drag tiles onto keyframe / reference slots (or anything that accepts text/x-bob-ref).
    root.addEventListener("dragstart", e => {
      const tile = e.target.closest(".mg-tile[data-ref]");
      if (!tile) return;
      const m = (root._items || []).find(x => x.ref === tile.dataset.ref);
      e.dataTransfer.setData("text/x-bob-ref", m.ref);
      e.dataTransfer.setData("text/x-bob-url", m.url);
      e.dataTransfer.effectAllowed = "copy";
    });
    // Drop files from the desktop to import them.
    root.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); root.classList.add("drop"); } });
    root.addEventListener("dragleave", e => { if (!root.contains(e.relatedTarget)) root.classList.remove("drop"); });
    root.addEventListener("drop", e => { if (e.dataTransfer.files.length) { e.preventDefault(); root.classList.remove("drop"); importFiles([...e.dataTransfer.files]); } });
    root.addEventListener("keydown", e => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "Delete" && st.selected.size) { e.preventDefault(); removeFromLibrary([...st.selected]); }
      if (e.key === "Enter" && st.selected.size) { e.preventDefault(); useItems(selectedItems(root)); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); for (const m of root._items || []) st.selected.add(m.ref); renderAll(); }
      if (e.key === "Escape" && st.selected.size) { e.stopPropagation(); st.selected.clear(); renderAll(); }
    });
  }

  function skeleton(full) {
    const root = document.createElement("div");
    root.className = `mg ${full ? "mg-full" : "mg-compact"}`;
    root.tabIndex = -1;
    root.innerHTML = full
      ? `<nav class="mg-nav" aria-label="Media sources"></nav><div class="mg-main"><div class="mg-head"></div><div class="mg-tagbar"></div><div class="mg-crumbbar"></div><div class="mg-body"></div><div class="mg-foot"></div></div>`
      : `<div class="mg-head"></div><div class="mg-tagbar"></div><div class="mg-crumbbar"></div><div class="mg-body"></div><div class="mg-foot"></div>`;
    bind(root);
    return root;
  }

  /* ------------------------------------------------------------------ public */
  function mount(el) {
    const root = skeleton(false);
    el.replaceChildren(root);
    mounts.add(root);
    render(root);
    return root;
  }

  function openWindow() {
    if (win && document.contains(win.el)) { win.focus(); return; }
    const root = skeleton(true);
    mounts.add(root);
    win = WM.open({ id: "media-library", title: `Media library · ${state.project ? state.project.name : "Experiment"}`, content: root,
      width: 1080, height: 700, minWidth: 520, minHeight: 360, className: "wm-media", onClose: () => { mounts.delete(root); win = null; } });
    render(root);
  }

  async function setProject(id, gallery) {
    st.project = id || "experiment";
    st.view = { source: "library", thumb_size: 132, sort: "added", descending: true, kind: "all", ...(gallery || {}) };
    st.sub = ""; st.selected.clear(); st.tagFilter.clear(); st.q = "";
    if (win) win.setTitle(`Media library · ${state.project ? state.project.name : "Experiment"}`);
    await Promise.all([loadLibrary(), loadBookmarks()]);
    if (st.view.source.startsWith("vf:") && !folderOf(st.view.source.slice(3))) st.view.source = "library";
    if (st.view.source.startsWith("bm:") && !st.bookmarks.some(b => b.id === st.view.source.slice(3))) st.view.source = "library";
    await loadSource();
  }

  /* Results finishing or new uploads: refresh views that show them. */
  function refreshSource() { if (["results", "uploads"].includes(st.view.source) || st.view.source.startsWith("bm:")) loadSource(); }

  return { mount, openWindow, setProject, refreshSource, addToLibrary, toast };
})();
