/* Project browser that works like Windows Explorer's Open dialog.

   Explorer.open({ mode: "open", onPick: project => … })          pick a project
   Explorer.open({ mode: "folder", title: "Choose a location", onPick: path => … })   pick a folder

   Toolbar: Back, Forward, Up, Refresh, a clickable address bar and search. Left: Quick access
   (Recent) and the folder tree. Right: Details (sortable columns) or Large icons. Double-click
   or Enter opens; Backspace goes up; F2 renames; Delete moves to the projects trash;
   Ctrl+Shift+N makes a folder; right-click for the same actions. */
"use strict";

(function () {
  const UI_KEY = "bob.ui";
  const readUI = () => { try { return JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {}; } catch { return {}; } };
  const writeUI = patch => { try { localStorage.setItem(UI_KEY, JSON.stringify({ ...readUI(), ...patch })); } catch {} };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const ICON = {
    folder: `<svg viewBox="0 0 48 40" aria-hidden="true"><path d="M2 8a4 4 0 0 1 4-4h12l5 5h19a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="#e8b33a"/><path d="M2 14h44v20a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="#f6c95b"/></svg>`,
    project: `<svg viewBox="0 0 48 40" aria-hidden="true"><rect x="3" y="9" width="42" height="28" rx="4" fill="#ff7a45"/><path d="M3 9l6-6h8l-6 6zm14 0l6-6h8l-6 6zm14 0l6-6h7l-6 6z" fill="#ffb36b"/><path d="M20 17l11 6-11 6z" fill="#fff"/></svg>`,
    recent: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  };
  const KIND = { video: "Video", image: "Image", audio: "Audio" };
  const fmtDate = t => t ? new Date(t * 1000).toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof j.detail === "string" ? j.detail : res.statusText);
    return j;
  }

  function open({ mode = "open", title, startPath, onPick } = {}) {
    const ui = readUI().explorer || {};
    const st = {
      path: startPath ?? ui.path ?? "", recent: false, entries: [], crumbs: [], tree: null,
      selected: null, view: ui.view || "details", sort: ui.sort || { key: "name", dir: 1 },
      back: [], fwd: [], filter: "", expanded: new Set(ui.expanded || [""]),
    };

    const root = document.createElement("div");
    root.className = "ex";
    root.innerHTML = `
      <div class="ex-tool">
        <button type="button" class="ex-btn" data-act="back" title="Back (Alt+Left)">←</button>
        <button type="button" class="ex-btn" data-act="fwd" title="Forward (Alt+Right)">→</button>
        <button type="button" class="ex-btn" data-act="up" title="Up (Backspace)">↑</button>
        <button type="button" class="ex-btn" data-act="refresh" title="Refresh (F5)">⟳</button>
        <div class="ex-addr" role="navigation" aria-label="Address"></div>
        <input type="search" class="ex-search" placeholder="Search" aria-label="Search this folder">
      </div>
      <div class="ex-cmd">
        <button type="button" class="ex-btn wide" data-act="newfolder" title="New folder (Ctrl+Shift+N)">＋ New folder</button>
        <button type="button" class="ex-btn wide" data-act="rename" title="Rename (F2)">Rename</button>
        <button type="button" class="ex-btn wide" data-act="delete" title="Delete (Del) — moves it to the projects trash">Delete</button>
        <span class="ex-gap"></span>
        <button type="button" class="ex-btn" data-act="details" title="Details">☰</button>
        <button type="button" class="ex-btn" data-act="icons" title="Large icons">▦</button>
      </div>
      <div class="ex-main">
        <nav class="ex-nav" aria-label="Folders"></nav>
        <div class="ex-view" tabindex="0" aria-label="Items"></div>
      </div>
      <div class="ex-status"></div>`;

    const foot = document.createElement("div");
    foot.innerHTML = mode === "folder"
      ? `<span class="ex-foot-label">Folder:</span><input class="ex-name" readonly>
         <button type="button" class="btn sm primary" data-act="pick">Select folder</button><button type="button" class="btn sm" data-act="cancel">Cancel</button>`
      : `<span class="ex-foot-label">Project:</span><input class="ex-name" readonly placeholder="Select a project">
         <span class="ex-type">Bob Studio projects</span>
         <button type="button" class="btn sm primary" data-act="pick" disabled>Open</button><button type="button" class="btn sm" data-act="cancel">Cancel</button>`;

    const win = WM.open({ id: mode === "folder" ? "explorer-folder" : "explorer-open", title: title || (mode === "folder" ? "Choose a location" : "Open project"),
      content: root, footer: foot, width: 900, height: 580, minWidth: 560, minHeight: 360, className: "wm-explorer" });

    const $ = s => root.querySelector(s);
    const view = $(".ex-view");

    /* ---------------------------------------------------------------- data */
    async function load(path, { push = true } = {}) {
      try {
        if (path === "::recent") {
          const j = await api("/api/projects/recent?limit=30");
          if (push && !st.recent) { st.back.push(st.path); st.fwd = []; }
          st.recent = true; st.entries = j.projects; st.crumbs = [{ name: "Recent", path: "::recent" }];
        } else {
          const j = await api(`/api/projects/browse?path=${encodeURIComponent(path)}`);
          if (push && (st.recent || path !== st.path)) { st.back.push(st.recent ? "::recent" : st.path); st.fwd = []; }
          st.recent = false; st.path = j.path; st.entries = j.entries; st.crumbs = j.crumbs; st.rootDir = j.root;
          let acc = ""; for (const c of j.crumbs.slice(1)) { acc = c.path; st.expanded.add(acc); }
          st.expanded.add("");
          writeUI({ explorer: { ...readUI().explorer, path: st.path, expanded: [...st.expanded] } });
        }
        st.selected = null; st.filter = ""; $(".ex-search").value = "";
        render();
      } catch (e) {
        status(`⚠ ${e.message}`);
        if (path && path !== "::recent" && path === st.path) load("", { push: false });
      }
    }
    async function loadTree() { try { st.tree = await api("/api/projects/tree"); } catch { st.tree = null; } renderNav(); }

    /* ---------------------------------------------------------------- render */
    function visible() {
      let list = st.entries;
      if (mode === "folder") list = list.filter(e => e.type === "folder");
      if (st.filter) { const f = st.filter.toLowerCase(); list = list.filter(e => (e.title || e.name).toLowerCase().includes(f)); }
      const { key, dir } = st.sort;
      const val = e => key === "name" ? (e.title || e.name).toLowerCase() : key === "modified" ? e.modified || 0
        : key === "type" ? typeName(e) : key === "items" ? e.items || 0 : 0;
      return [...list].sort((a, b) => {
        if (!st.recent && a.type !== b.type) return a.type === "folder" ? -1 : 1;  // folders first, like Explorer
        const x = val(a), y = val(b);
        return (x > y ? 1 : x < y ? -1 : 0) * dir;
      });
    }
    function typeName(e) { return e.type === "folder" ? "File folder" : `${KIND[e.kind] || "Bob"} project`; }

    function render() {
      renderAddr(); renderNav(); renderView(); renderStatus(); renderFoot();
      $('[data-act="back"]').disabled = !st.back.length;
      $('[data-act="fwd"]').disabled = !st.fwd.length;
      $('[data-act="up"]').disabled = st.recent || !st.path;
      $('[data-act="details"]').classList.toggle("on", st.view === "details");
      $('[data-act="icons"]').classList.toggle("on", st.view === "icons");
      const sel = current();
      $('[data-act="rename"]').disabled = !sel || st.recent;
      $('[data-act="delete"]').disabled = !sel;
      $('[data-act="newfolder"]').disabled = st.recent;
    }
    function renderAddr() {
      $(".ex-addr").innerHTML = st.crumbs.map((c, i) =>
        `${i ? `<span class="ex-sep">›</span>` : ""}<button type="button" class="ex-crumb" data-path="${esc(c.path)}">${esc(c.name)}</button>`).join("");
      $(".ex-search").placeholder = `Search ${st.crumbs[st.crumbs.length - 1]?.name || "Projects"}`;
    }
    function renderNav() {
      const node = (n, depth) => {
        const open = st.expanded.has(n.path), has = n.children?.length;
        const here = !st.recent && n.path === st.path;
        return `<div class="ex-node${here ? " here" : ""}" style="--d:${depth}" data-path="${esc(n.path)}">
            <button type="button" class="ex-twist${has ? "" : " none"}" data-twist="${esc(n.path)}" aria-label="${open ? "Collapse" : "Expand"}">${has ? (open ? "▾" : "▸") : ""}</button>
            <span class="ex-ico sm">${ICON.folder}</span><span class="ex-nlabel">${esc(n.name)}</span></div>
          ${open && has ? n.children.map(c => node(c, depth + 1)).join("") : ""}`;
      };
      $(".ex-nav").innerHTML = `<div class="ex-navh">Quick access</div>
        <div class="ex-node${st.recent ? " here" : ""}" style="--d:0" data-path="::recent"><span class="ex-twist none"></span><span class="ex-ico sm rc">${ICON.recent}</span><span class="ex-nlabel">Recent</span></div>
        <div class="ex-navh">This PC</div>${st.tree ? node(st.tree, 0) : ""}`;
    }
    function renderView() {
      const list = visible();
      if (!list.length) {
        view.innerHTML = `<div class="ex-empty">${st.filter ? "No items match your search." : st.recent ? "No projects yet." : mode === "folder" ? "No folders here." : "This folder is empty."}</div>`;
        return;
      }
      if (st.view === "icons") {
        view.innerHTML = `<div class="ex-grid">${list.map(e => `
          <button type="button" class="ex-item ex-tile${st.selected === e.path ? " sel" : ""}" data-path="${esc(e.path)}" title="${esc(tip(e))}">
            <span class="ex-big">${e.type === "project" && e.thumb ? `<img src="/${esc(e.thumb)}" alt="" loading="lazy">` : ICON[e.type]}</span>
            <span class="ex-tname">${esc(e.title || e.name)}</span></button>`).join("")}</div>`;
        return;
      }
      const cols = [["name", "Name"], ["modified", "Date modified"], ["type", "Type"], ["items", st.recent ? "Results" : "Items"]];
      if (st.recent) cols.splice(3, 0, ["where", "Location"]);
      view.innerHTML = `<table class="ex-table"><thead><tr>${cols.map(([k, l]) =>
          `<th data-sort="${k}" class="${st.sort.key === k ? (st.sort.dir > 0 ? "asc" : "desc") : ""}">${l}</th>`).join("")}</tr></thead>
        <tbody>${list.map(e => `<tr class="ex-item${st.selected === e.path ? " sel" : ""}" data-path="${esc(e.path)}" title="${esc(tip(e))}">
          <td><span class="ex-ico">${ICON[e.type]}</span>${esc(e.title || e.name)}</td>
          <td>${fmtDate(e.modified)}</td><td>${typeName(e)}</td>
          ${st.recent ? `<td class="ex-where">${esc(e.path.split("/").slice(0, -1).join(" › ") || "Projects")}</td>` : ""}
          <td class="num">${e.type === "folder" ? `${e.items} item${e.items === 1 ? "" : "s"}` : `${e.items || 0} result${e.items === 1 ? "" : "s"}`}</td></tr>`).join("")}</tbody></table>`;
    }
    function tip(e) {
      if (e.type === "folder") return `${e.name}\nFolder · ${e.items} item(s)`;
      return `${e.title || e.name}\n${typeName(e)} · ${e.model || "no model yet"}\nModified ${fmtDate(e.modified)}\nCreated ${fmtDate(e.created)}`;
    }
    function renderStatus() {
      const n = visible().length, sel = current();
      status(`${n} item${n === 1 ? "" : "s"}${sel ? ` · 1 item selected` : ""}${!st.recent && st.rootDir ? `<span class="ex-root">${esc(st.rootDir)}${st.path ? "\\" + esc(st.path.replaceAll("/", "\\")) : ""}</span>` : ""}`);
    }
    function status(html) { $(".ex-status").innerHTML = html; }
    function renderFoot() {
      const sel = current(), name = foot.querySelector(".ex-name"), pick = foot.querySelector('[data-act="pick"]');
      if (mode === "folder") {
        const target = sel?.type === "folder" ? sel.path : st.path;
        name.value = `Projects${target ? " › " + target.split("/").join(" › ") : ""}`;
        pick.disabled = st.recent;
      } else {
        name.value = sel?.type === "project" ? sel.title || sel.name : sel ? "" : "";
        pick.disabled = !sel;
        pick.textContent = sel?.type === "folder" ? "Open folder" : "Open";
      }
    }
    const current = () => st.entries.find(e => e.path === st.selected) || null;

    /* ---------------------------------------------------------------- actions */
    function select(path) { st.selected = path; render(); }
    function activate(e) {
      if (!e) return;
      if (e.type === "folder") return load(e.path);
      if (mode === "open") { win.close(); onPick?.(e); }
    }
    async function newFolder() {
      const name = await WM.ask({ title: "New folder", message: "Folder name", input: "New folder", ok: "Create" });
      if (!name) return;
      try { const r = await api("/api/projects/folder", { method: "POST", body: JSON.stringify({ path: st.path, name }) });
        await loadTree(); await load(st.path, { push: false }); select(r.path); }
      catch (err) { status(`⚠ ${esc(err.message)}`); }
    }
    async function rename() {
      const e = current(); if (!e || st.recent) return;
      const name = await WM.ask({ title: "Rename", message: `New name for “${e.title || e.name}”`, input: e.title || e.name, ok: "Rename" });
      if (!name || name === (e.title || e.name)) return;
      try { const r = await api("/api/projects/rename", { method: "POST", body: JSON.stringify({ path: e.path, name }) });
        await loadTree(); await load(st.path, { push: false }); select(r.path);
        window.dispatchEvent(new CustomEvent("bob:project-renamed", { detail: { id: e.id, path: r.path, name: r.name } })); }
      catch (err) { status(`⚠ ${esc(err.message)}`); }
    }
    async function remove() {
      const e = current(); if (!e) return;
      const what = e.type === "folder" ? `the folder “${e.name}” and everything in it` : `the project “${e.title || e.name}”`;
      const ok = await WM.ask({ title: "Delete", message: `Move ${what} to the projects trash (projects\\.trash)? Its generated videos and images stay in the gallery.`, ok: "Delete", danger: true });
      if (!ok) return;
      try { await api("/api/projects/delete", { method: "POST", body: JSON.stringify({ path: e.path }) });
        window.dispatchEvent(new CustomEvent("bob:project-deleted", { detail: { id: e.id, path: e.path } }));
        await loadTree(); await load(st.recent ? "::recent" : st.path, { push: false }); }
      catch (err) { status(`⚠ ${esc(err.message)}`); }
    }
    function go(where) {
      if (where === "back" && st.back.length) { st.fwd.push(st.recent ? "::recent" : st.path); load(st.back.pop(), { push: false }); }
      if (where === "fwd" && st.fwd.length) { st.back.push(st.recent ? "::recent" : st.path); load(st.fwd.pop(), { push: false }); }
      if (where === "up" && !st.recent && st.path) load(st.path.split("/").slice(0, -1).join("/"));
    }

    /* ---------------------------------------------------------------- events */
    root.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "back" || act === "fwd" || act === "up") return go(act);
      if (act === "refresh") return (loadTree(), load(st.recent ? "::recent" : st.path, { push: false }));
      if (act === "newfolder") return newFolder();
      if (act === "rename") return rename();
      if (act === "delete") return remove();
      if (act === "details" || act === "icons") { st.view = act; writeUI({ explorer: { ...readUI().explorer, view: act } }); return renderView(); }
      const crumb = e.target.closest(".ex-crumb"); if (crumb) return load(crumb.dataset.path);
      const twist = e.target.closest("[data-twist]");
      if (twist) { const p = twist.dataset.twist; st.expanded.has(p) ? st.expanded.delete(p) : st.expanded.add(p); return renderNav(); }
      const node = e.target.closest(".ex-node"); if (node) return load(node.dataset.path);
      const th = e.target.closest("th[data-sort]");
      if (th && th.dataset.sort !== "where") {
        const k = th.dataset.sort; st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : 1 };
        writeUI({ explorer: { ...readUI().explorer, sort: st.sort } }); return renderView();
      }
      const item = e.target.closest(".ex-item"); if (item) { select(item.dataset.path); view.focus({ preventScroll: true }); return; }
      if (e.target.closest(".ex-view")) select(null);
    });
    root.addEventListener("dblclick", e => { const item = e.target.closest(".ex-item"); if (item) activate(st.entries.find(x => x.path === item.dataset.path)); });
    foot.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") win.close();
      if (act === "pick") {
        if (mode === "folder") { const sel = current(); win.close(); onPick?.(sel?.type === "folder" ? sel.path : st.path); }
        else activate(current());
      }
    });
    $(".ex-search").addEventListener("input", e => { st.filter = e.target.value; renderView(); renderStatus(); });

    root.addEventListener("keydown", e => {
      if (e.target.matches("input")) return;
      const list = visible(), i = list.findIndex(x => x.path === st.selected);
      if (e.key === "ArrowDown" || e.key === "ArrowRight" && st.view === "icons") { e.preventDefault(); select(list[Math.min(list.length - 1, i + 1)]?.path ?? null); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft" && st.view === "icons" && !e.altKey) { e.preventDefault(); select(list[Math.max(0, i - 1)]?.path ?? null); }
      else if (e.key === "Enter") { e.preventDefault(); activate(current()); }
      else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); go("up"); }
      else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); go("back"); }
      else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); go("fwd"); }
      else if (e.key === "F2") { e.preventDefault(); rename(); }
      else if (e.key === "Delete") { e.preventDefault(); remove(); }
      else if (e.key === "F5") { e.preventDefault(); loadTree(); load(st.recent ? "::recent" : st.path, { push: false }); }
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); newFolder(); }
      // Ensure the selected row stays in view.
      requestAnimationFrame(() => view.querySelector(".sel")?.scrollIntoView({ block: "nearest" }));
    });

    // Right-click menu
    root.addEventListener("contextmenu", e => {
      if (!e.target.closest(".ex-view")) return;
      e.preventDefault();
      const item = e.target.closest(".ex-item");
      select(item ? item.dataset.path : null);
      const sel = current();
      const entries = sel
        ? [[sel.type === "folder" ? "Open folder" : mode === "open" ? "Open project" : null, () => activate(sel)],
           st.recent ? null : ["Rename", rename], ["Delete", remove]]
        : [st.recent ? null : ["New folder", newFolder], ["Refresh", () => load(st.recent ? "::recent" : st.path, { push: false })]];
      menu(e.clientX, e.clientY, entries.filter(x => x && x[0]));
    });
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

    loadTree();
    load(st.path, { push: false });
    view.focus({ preventScroll: true });
    return win;
  }

  window.Explorer = { open };
})();
