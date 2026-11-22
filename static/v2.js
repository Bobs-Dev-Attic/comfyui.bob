/* Bob Studio V2 (static/v2.html): a shot-focused studio where the 3D scene is the main tool.

   Every shot is a 3D scene (the scene builder, static/scene3d.js, drawn in the middle of the page) plus its own words:
   the setting and environment, what happens, a line of dialogue and who says it, background sound and music, and a
   quality. The model is chosen for each shot from what's in it (decide): text only goes to H3; a set with objects or a
   camera move is drawn as a rough animation and made by H3 with Time-to-Move, starting from a photo of its first
   frame (the Qwen gap fill paints in what the camera move reveals); objects with pictures go on H3 Reference. Shots are
   laid out in order on the timeline below, and Generate makes one or all of them.

   The object library (the Objects tab, shared by every project, /api/v2/objects): people, props and 3D models, each
   with what it becomes, reference pictures and LoRAs. Drag one onto the viewport and it stands where you drop it
   (Scene3D.addFromLibrary); its first picture goes to H3 Reference, and the LoRAs of the objects in a shot go with it.

   The camera library (the Cameras tab): ready-made moves (push in, orbit, crane, dolly zoom, follow…) worked out round
   the shot's subject at a framing and speed (Scene3D.applyCameraMove), and your own, saved from a shot relative to
   its subject (/api/v2/cameras) so they fit another shot's subject the same way.

   Sound: each shot has its background sound, music, and dialogue lines (who says what, in order). An object with a
   voice in the library speaks its lines with it (H3 Reference, <Audio N>). The timeline can have a soundtrack, one
   piece of music for all of it (MiniMax Music 3, as long as the shots together); while it's on, the shots are made
   without their own music.

   Export: each shot can be trimmed (start and end in its video) and join the next with a cut or a transition;
   ⬇ Export renders the shots' latest videos as one, in order, with the soundtrack under them (/api/v2/export,
   rendered as the classic timeline is). It shows up as a studio result.

   The right-hand column follows what's selected: the shot (picked in the list, or nothing selected in the scene)
   shows the Shot details; an object or the camera in the viewport shows the scene builder's own properties there,
   topped by V2's part (an object's lines in this shot and its library entry; the camera's moves). The scene builder
   is laid straight into the page's grid for that (v2.css: display: contents), so nothing of it moves in the DOM.

   The timeline has a ruler and four layers: 🎥 camera (each shot's camera keys, where they fall in its piece), 🎞 video
   (the shots, sized by the part used, transitions as overlaps), 🗣 sound (each shot's lines and background sound) and
   🎵 music (the soundtrack). The camera layer edits the open shot's camera: drag a key to retime it, click one to go
   to it, double-click to add one, right-click for delete, easing and more; a playhead runs across, and a click on the
   ruler moves it (drag along the ruler to scrub). Objects' keys have easing like the camera's. Markers (🚩, or M)
   label moments of the whole timeline: drag one to move it, double-click to name it, right-click for more. The
   mouse wheel over the timeline zooms about the cursor (Shift+wheel scrolls), and times show in seconds or frames. It folds away and its height drags; zoom fits or magnifies. While something is being made
   it shows the Log instead: every step and the studio's own log lines for each job, with progress, until it's done.
   A shot's words are kept with its scene too (v2shot), so a scene template carries them to any project.

   The page uses the studio's API as the classic page does (projects, scenes, items), and gives the scene builder the
   few globals it expects from that page (state, api, esc, mediaUrl, submit, and Shots, which V2 replaces). A project's
   V2 shots are kept by the studio in data/v2/<project>.json (/api/v2/board). */
"use strict";

/* ---------------------------------------------------------------- what the scene builder expects from its page */
const state = { caps: null, items: new Map(), project: null, refs: [], shots: null, kind: "video", engine: { video: "h3", image: "h3", audio: "h3" } };
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function mediaUrl(ref) { return !ref ? "" : /^(outputs|data\/uploads)\//.test(ref) ? "/" + ref : `/api/media/file?path=${encodeURIComponent(ref)}`; }
async function submit(req) {
  try {
    const { items } = await api("/api/generate", { method: "POST", body: JSON.stringify(req) });
    for (const it of items) state.items.set(it.id, it);
    if (typeof V2 !== "undefined") V2.onSubmit(req, items);  // the log follows it (V2 is a const, not on window)
    return items;
  } catch (e) { Media.toast(`Generate: ${e.message}`); return null; }
}
// The classic Shots step isn't here: V2's shots are its own (the scene builder's shot links stay off).
const Shots = { on: () => false, each: () => false, targets: () => [], shotOfScene: () => null, isImage: () => false,
  placeWhenDone: (items, project, sceneId) => V2.addWhenDone(sceneId, items), placeNow: (it, project, sceneId) => V2.addRender(sceneId, it), useScene() { return 0; }, linkScene() {}, unlinkScene() {} };

/* ---------------------------------------------------------------- V2 */
const V2 = (() => {
  const $ = id => document.getElementById(id);
  const uid = () => Math.random().toString(16).slice(2, 10);
  const PKEY = "bob.v2.project";
  const st = { board: { shots: [], settings: {} }, sel: null, scenes: new Map(), busy: new Set(), hearing: new Set(), saveT: 0, say: new Map(), stg: new Map(), objs: [], cams: [], log: [], tlv: "tl" };
  const shotOf = id => st.board.shots.find(x => x.id === id);
  const cur = () => shotOf(st.sel);
  const status = t => { $("v2-status").textContent = t || ""; };

  /* ---- the board: load and save (a moment after each change) */
  async function loadBoard() {
    const b = await api(`/api/v2/board?project=${encodeURIComponent(state.project?.id ?? "")}`);
    st.board = { shots: Array.isArray(b.shots) ? b.shots : [], settings: b.settings || {} };
    saves.k.clear(); saves.at = b.saved ? b.saved * 1000 : 0; saves.err = ""; saveSign(); projLoraBtn();
    st.sel = st.board.shots.some(x => x.id === st.board.settings.sel) ? st.board.settings.sel : st.board.shots[0]?.id || null;
    await refreshScenes();
    renderAll();
    if (st.sel) openShot(st.sel, true);
  }
  /* Saved or not: what's waiting to be saved (board: the shots; words: the shot's words, with its scene; scene: the
     3D scene, which scene3d.js tells with "bob:save"), and when the project was last saved. The sign next to the
     project: ✓ saved, ● changes waiting, ⚠ a save failed; its tooltip says when it was last saved. */
  const saves = { k: new Map(), at: 0, err: "" };  // k: what -> "pending" | "failed"
  function saved(what, k, err = "") {
    if (k === "saved") { saves.k.delete(what); saves.at = Date.now(); if (![...saves.k.values()].includes("failed")) saves.err = ""; }
    else { saves.k.set(what, k); if (k === "failed") saves.err = err; }
    saveSign();
  }
  function saveSign() {
    const el = $("v2-save"); if (!el) return;
    const v = [...saves.k.values()], k = v.includes("failed") ? "failed" : v.length ? "pending" : "saved";
    const when = saves.at ? `last saved ${new Date(saves.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}` : "not saved yet";
    const name = state.project?.name || "Experiment";
    el.dataset.s = k;
    el.textContent = k === "failed" ? "⚠" : k === "pending" ? "●" : "✓";
    el.title = k === "failed" ? `${name}: a change couldn't be saved (${saves.err || "the studio didn't answer"}). It tries again with the next change · ${when}`
      : k === "pending" ? `${name}: changes not saved yet (they save in a moment) · ${when}` : `${name}: saved · ${when}`;
    el.setAttribute("aria-label", el.title);
  }
  document.addEventListener("bob:save", e => saved(e.detail?.what || "scene", e.detail?.state, e.detail?.err));
  function save() {
    clearTimeout(st.saveT);
    clearTimeout(st.wordsT);
    const s = cur(), proj = state.project?.id ?? "";
    if (s) {  // the selected shot's words, kept with its scene
      saved("words", "pending");
      const run = () => {
        const v2shot = { name: s.name, setting: s.setting || "", action: s.action || "", lines: linesOf(s), sound: s.sound || "", music: s.music || "",
          quality: s.quality || "standard", transition: s.transition || "cut", tlen: s.tlen || "" };
        api(`/api/scenes/${s.scene}`, { method: "PATCH", body: JSON.stringify({ v2shot }) }).then(() => saved("words", "saved")).catch(e => saved("words", "failed", e.message));
      };
      st.wordsRun = run;
      st.wordsT = setTimeout(() => { if (st.wordsRun === run) st.wordsRun = null; run(); }, 1200);
    }
    saved("board", "pending");
    const board = st.board, run = () => {  // this project's shots, even when another is open by then
      board.settings.sel = st.board === board ? st.sel : board.settings.sel;
      api(`/api/v2/board?project=${encodeURIComponent(proj)}`, { method: "PUT", body: JSON.stringify(board) })
        .then(() => { if (st.board === board) saved("board", "saved"); })
        .catch(e => { if (st.board === board) saved("board", "failed", e.message); Media.toast(`Couldn't save the shots: ${e.message}`); });
    };
    st.boardRun = run;
    st.saveT = setTimeout(() => { if (st.boardRun === run) st.boardRun = null; run(); }, 400);
  }
  // Send what's waiting now (before another project opens, or the page goes)
  function flushSaves() {
    clearTimeout(st.saveT); clearTimeout(st.wordsT);
    const a = st.wordsRun, b = st.boardRun; st.wordsRun = st.boardRun = null;
    a?.(); b?.();
  }
  async function refreshScenes() {
    try { for (const sc of (await api("/api/scenes")).scenes || []) st.scenes.set(sc.id, sc); } catch { /* keep what we have */ }
  }

  /* ---- projects */
  async function loadProjects() {
    const sel = $("v2-project");
    let list = [];
    try { list = (await api("/api/projects/recent?limit=30")).projects || []; } catch { /* only Experiment */ }
    const want = (() => { try { return localStorage.getItem(PKEY) || ""; } catch { return ""; } })();
    sel.innerHTML = `<option value="">Experiment</option>` + list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    sel.value = list.some(p => p.id === want) ? want : "";
    state.project = list.find(p => p.id === sel.value) || null;
    sel.onchange = async () => {
      flushSaves();
      state.project = list.find(p => p.id === sel.value) || null;
      try { localStorage.setItem(PKEY, sel.value); } catch {}
      Scene3D._state()?.win?.close();
      await loadBoard();
    };
    $("v2-newproj").onclick = newProject;
  }
  // a new, empty project in a folder you choose (the last one used, at first), then switch to it
  function newProject() {
    const box = document.createElement("div");
    box.className = "wm-form";
    box.innerHTML = `<div class="field"><label for="v2-np-name">Project name</label><input id="v2-np-name" type="text" maxlength="120" value="Untitled project"></div>
      <div class="field"><label for="v2-np-loc">Location</label>
        <div class="loc"><input id="v2-np-loc" type="text" readonly><button type="button" class="btn sm" id="v2-np-browse">Browse…</button></div></div>
      <div class="field"><label for="v2-np-notes">Notes <span class="opt">optional</span></label><textarea id="v2-np-notes" rows="3"></textarea></div>
      <p class="err" id="v2-np-err"></p>`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="grow"></span><button type="button" class="btn ghost" data-a="close">Cancel</button>
      <button type="button" class="btn primary" data-a="go">Create project</button>`;
    const win = WM.open({ id: "v2-newproj", title: "New project", content: box, footer: foot, width: 500, height: 420, modal: true });
    const name = box.querySelector("#v2-np-name");
    let folder = "";
    try { folder = JSON.parse(localStorage.getItem("bob.ui") || "{}")?.newProjectFolder ?? ""; } catch {}
    const loc = box.querySelector("#v2-np-loc");
    const showLoc = () => { loc.value = ["Projects", ...folder.split("/").filter(Boolean)].join(" › "); };
    showLoc();
    box.querySelector("#v2-np-browse").onclick = () => Explorer.open({ mode: "folder", startPath: folder, title: "Choose where to save the project",
      onPick: path => { folder = path; showLoc(); } });
    setTimeout(() => { name.focus(); name.select(); }, 0);
    const go = async () => {
      if (!name.value.trim()) { box.querySelector("#v2-np-err").textContent = "Give the project a name."; return; }
      try {
        const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ folder, name: name.value.trim(), settings: {}, notes: box.querySelector("#v2-np-notes").value }) });
        try { localStorage.setItem("bob.ui", JSON.stringify({ ...JSON.parse(localStorage.getItem("bob.ui") || "{}"), newProjectFolder: folder })); } catch {}
        win.close();
        try { localStorage.setItem(PKEY, p.id); } catch {}
        Scene3D._state()?.win?.close();
        await loadProjects();
        await loadBoard();
        Media.toast(`Started “${p.name || name.value.trim()}”.`);
      } catch (e) { box.querySelector("#v2-np-err").textContent = e.message; }
    };
    foot.querySelector('[data-a="close"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = go;
    name.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  }

  /* ---- new shots */
  async function newShot(how, tpl = null) {
    const n = st.board.shots.length + 1;
    let sc;
    try {
      sc = how === "template"
        ? await api(`/api/scenes/${tpl.id}/copy`, { method: "POST", body: JSON.stringify({ name: tpl.name, project: state.project?.id ?? null }) })
        : await api("/api/scenes", { method: "POST", body: JSON.stringify({ picture: null, name: `Shot ${n}`, project: state.project?.id ?? null, seconds: 5, aspect: "16:9",
          objects: [{ id: uid(), name: "Cube", prim: "cube", color: "#c9c4ba", dims: [1, 1, 1] }] }) });
    } catch (e) { return Media.toast(`New shot: ${e.message}`); }
    st.scenes.set(sc.id, sc);
    const w = how === "template" && tpl.v2shot && typeof tpl.v2shot === "object" ? tpl.v2shot : {};  // a template's words
    const shot = { id: uid(), scene: sc.id, name: how === "template" ? tpl.name : `Shot ${n}`, setting: w.setting || "", action: w.action || "",
      lines: Array.isArray(w.lines) ? w.lines.map(l => ({ speaker: String(l?.speaker || ""), text: String(l?.text || "") })) : [],
      sound: w.sound || "", music: w.music || "", quality: w.quality || "standard", transition: w.transition || "cut", tlen: w.tlen || "", results: [] };
    st.board.shots.push(shot);
    save();
    await openShot(shot.id);
    if (how !== "template") {  // a new set: a camera on the cube, a little way back
      for (let k = 0; k < 30 && !Scene3D.current()?.objs.every(o => o.pos); k++) await new Promise(r => setTimeout(r, 100));
      Scene3D.applyCameraMove("static", { framing: "wide" });
      Scene3D.select(-1);
    }
  }
  async function newMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    let tpls = [];
    try { tpls = ((await api("/api/scenes")).scenes || []).filter(x => x.template && x.status === "done"); } catch { /* none */ }
    Media.menu(r.left, r.bottom + 4, [
      ["＋ Empty set (a floor and a sky)", () => newShot("empty")],
      ...tpls.map(x => [`⭐ ${x.name}${x.seconds ? ` · ${(+x.seconds).toFixed(0)} s` : ""}`, () => newShot("template", x)]),
    ]);
  }
  function removeShot(id) {
    const s = shotOf(id); if (!s || !confirm(`Remove “${s.name}” from the shots? Its 3D scene stays in the scene list.`)) return;
    st.board.shots = st.board.shots.filter(x => x.id !== id);
    if (st.sel === id) { st.sel = st.board.shots[0]?.id || null; if (st.sel) openShot(st.sel); else { Scene3D._state()?.win?.close(); renderAll(); } }
    save(); renderAll();
  }

  /* ---- the viewport: the selected shot's scene */
  async function openShot(id, quiet = false) {
    const s = shotOf(id); if (!s) return;
    st.sel = id; if (!quiet) save();
    if (Scene3D.current()?.id === s.scene) Scene3D.select(-1);
    inspect("shot");
    renderAll();
    if (Scene3D._state()?.id !== s.scene) {
      $("v2-viewempty").hidden = true;
      await Scene3D.open(s.scene);
      document.querySelector(".v2-main").classList.add("scene");
      st.names = null;
    }
    watchScene();
  }
  // The open scene changes as you work in it (objects, camera keys, length): the panel and timeline follow.
  let watchT = 0, lastSig = "";
  function watchScene() {
    clearInterval(watchT);
    watchT = setInterval(() => {
      const c = Scene3D.current(); if (!c) return;
      // the selection picks what the right-hand column shows
      const selKey = c.camSel ? "cam" : c.sel >= 0 ? c.objs[c.sel]?.id : "";
      if (selKey !== st.selKey) { st.selKey = selKey; inspect(selKey ? "scene" : "shot"); }
      else if (selKey) renderObjx();
      // an object renamed: the shot's {Name} tags and speakers follow
      const names = new Map(c.objs.map(o => [o.id, o.name])), s0 = st.board.shots.find(x => x.scene === c.id);
      if (st.names && s0) for (const [id, n] of names) {
        const was = st.names.get(id); if (!was || was === n) continue;
        s0.action = String(s0.action || "").split(`{${was}}`).join(`{${n}}`);
        for (const l of linesOf(s0)) if (l.speaker === was) l.speaker = n;
        save(); $("v2-lines").dataset.shot = "";
      }
      st.names = names;
      placePlayhead();
      const sig = JSON.stringify([c.id, c.objs.map(o => [o.name, !!o.picture, o.lib, (o.keys || []).map(k => k.t), o.hidden]), c.camKeys.map(k => [k.t, k.ease || "", k.lens || 0]), c.seconds, c.sel]);
      if (sig === lastSig) return;
      lastSig = sig;
      const sc = st.scenes.get(c.id); if (sc) Object.assign(sc, { seconds: c.seconds, camera_keys: c.camKeys, objects: c.objs.map(o => ({ name: o.name, picture: o.picture, lib: o.lib, keys: o.keys, hidden: o.hidden, mesh: !!o.mesh })) });
      renderPanel(true); renderShots(); renderTimeline();
    }, 700);
  }

  /* ---- the right-hand column: the shot, or what's selected in the scene */
  function inspect(mode) {
    const main = document.querySelector(".v2-main");
    main.classList.toggle("insp-scene", mode === "scene");
    const c = Scene3D.current(), o = c && c.sel >= 0 ? c.objs[c.sel] : null;
    main.classList.toggle("insp-cam", mode === "scene" && !!c?.camSel);
    const side = document.querySelector("#v2-view .s3-side"); if (side && mode === "scene") side.scrollTop = 0;
    $("v2-paneltoggle").textContent = mode !== "scene" ? "📝 Shot" : c?.camSel ? "🎥 Camera" : `🧱 ${o?.name || "Object"}`;
    if (mode === "scene") renderObjx(true);
  }
  // V2's part above the scene builder's properties: an object's lines in this shot and its library entry, or the camera's moves.
  function renderObjx(force = false) {
    const side = document.querySelector("#v2-view .s3-side"), c = Scene3D.current(), s = cur();
    if (!side || !c || !s) return;
    let box = side.querySelector(".v2-objx");
    if (!box) {
      box = document.createElement("section"); box.className = "v2-objx"; side.prepend(box);
      // the builder's sections, named so v2.css can put the selected thing's first
      for (const sec of side.querySelectorAll(":scope > section")) {
        const h = sec.querySelector("h3")?.textContent.trim();
        if (h === "View") sec.classList.add("v2s-view"); else if (h === "Camera") sec.classList.add("v2s-cam"); else if (h === "Objects") sec.classList.add("v2s-objs");
      }
    }
    if (!force && box.contains(document.activeElement)) return;
    const o = c.sel >= 0 ? c.objs[c.sel] : null;
    const key = JSON.stringify([c.camSel, o?.id, o?.name, o?.lib, linesOf(s).filter(l => o && l.speaker === o.name), st.objs.length, st.cams.length,
      o?.lib && st.objs.find(x => x.id === o.lib)?.loras, st.loraList?.length]);
    if (!force && box.dataset.k === key) return;
    box.dataset.k = key;
    const back = `<button type="button" class="btn sm ghost v2-back" data-x="shot" title="The shot's words, sound and settings">← 🎞 ${esc(s.name)}</button>`;
    if (c.camSel) {
      box.innerHTML = `${back}<h3>🎥 Camera</h3>
        <div class="v2-xrow"><select data-x="move" aria-label="Camera move">${(Scene3D.CAM_MOVES || []).map(m => `<option value="${esc(m.id)}">${m.icon} ${esc(m.name)}</option>`).join("")}</select>
          <select data-x="frame" aria-label="Framing"><option value="close">Close-up</option><option value="medium" selected>Medium</option><option value="wide">Wide</option><option value="extreme">Extreme wide</option></select>
          <button type="button" class="btn sm" data-x="apply">Apply</button></div>
        <div class="v2-xrow"><button type="button" class="btn sm ghost" data-x="savecam">💾 Save this camera</button><span class="hint">${c.camKeys.length} key${c.camKeys.length === 1 ? "" : "s"}</span></div>`;
      return;
    }
    if (!o) { box.innerHTML = back; return; }
    const lib = o.lib && st.objs.find(x => x.id === o.lib), mine = linesOf(s).map((l, k) => [l, k]).filter(([l]) => l.speaker === o.name);
    box.innerHTML = `${back}<h3>${esc(o.name)}</h3>
      <div class="field"><label for="v2-oname">Name <span class="opt">{Name} in the shot's words</span></label><input id="v2-oname" maxlength="60" value="${esc(o.name)}"></div>
      <div class="field"><span class="v2-flbl">Lines in this shot</span>
        ${mine.map(([l, k]) => `<div class="v2-xline"><input data-xl="${k}" maxlength="300" value="${esc(l.text || "")}" placeholder="What ${esc(o.name)} says" aria-label="Line ${k + 1}"><button type="button" class="v2-x" data-xrm="${k}" aria-label="Remove this line">✕</button></div>`).join("")}
        <button type="button" class="btn sm" data-x="addline">＋ Line for ${esc(o.name)}</button>
        <p class="hint">The shot's dialogue keeps every line in order${lib?.voice ? `; ${esc(o.name)} speaks with the voice from the library` : ""}.</p></div>
      ${objLoraField(lib)}
      <div class="v2-xrow">${lib ? `<span class="hint">From the library: <b>${esc(lib.name)}</b></span><button type="button" class="btn sm ghost" data-x="editlib">Edit…</button>`
        : `<button type="button" class="btn sm ghost" data-x="savelib" title="Keep it in the object library, with its shape, what it is and its picture">💾 Save to the library</button>`}</div>`;
  }
  /* A library object's LoRAs, in the selected object's panel: a row each (which, how strong). They're the library
     object's, so every shot it's in uses them; one that isn't in the library is saved there with its first. */
  function objLoraField(lib) {
    const L = st.loraList || [], mine = lib?.loras || [];
    return `<div class="field"><span class="v2-flbl">LoRAs <span class="opt">${lib ? "the library object's: every shot it's in uses them" : "a character, a look"}</span></span>
      ${mine.map((l, k) => `<div class="v2-lora"><select data-xlname="${k}" aria-label="LoRA ${k + 1}">${L.some(x => x.name === l.name) ? "" : `<option value="${esc(l.name)}">${esc(l.name)} (not found)</option>`}${L.map(x => `<option value="${esc(x.name)}"${x.name === l.name ? " selected" : ""}>${esc(x.title || x.name)}</option>`).join("")}</select>
        <input type="number" data-xlstr="${k}" min="0" max="2" step="0.05" value="${+l.strength || 1}" aria-label="Strength"><button type="button" class="btn sm ghost" data-xlrm="${k}" aria-label="Remove this LoRA">✕</button></div>`).join("")}
      ${L.length ? `<button type="button" class="btn sm" data-x="addlora"${mine.length >= 4 ? " disabled" : ""} title="${lib ? "Add a MiniMax H3 LoRA" : "Saves it to the object library, then adds a MiniMax H3 LoRA"}">＋ LoRA</button>`
        : st.loraList ? `<p class="hint">No MiniMax H3 LoRAs found in ComfyUI.</p>` : ""}</div>`;
  }
  const putLib = e => api(`/api/v2/objects/${e.id}`, { method: "PUT", body: JSON.stringify({ id: e.id, name: e.name, kind: e.kind, prim: e.prim, model: e.model, becomes: e.becomes,
    pictures: e.pictures || [], loras: e.loras || [], voice: e.voice || null, notes: e.notes || "" }) });
  // the selected object into the object library (its shape, what it is, its picture); its entry
  async function saveToLib(c, o) {
    const e2 = { id: uid(), name: o.name, kind: o.prim ? "prim" : "model", prim: o.prim || null, model: o.prim ? null : o.model || null, becomes: o.becomes || "",
      pictures: o.picture ? [o.picture] : [], loras: [], voice: null, notes: "" };
    await api(`/api/v2/objects/${e2.id}`, { method: "PUT", body: JSON.stringify(e2) }); o.lib = e2.id; Scene3D.rename(c.sel, o.name); await loadObjects();
    return st.objs.find(x => x.id === e2.id) || e2;
  }
  // a change to the selected object's library LoRAs: kept, and the panels redrawn
  async function libLoras(lib, change) {
    if (!Array.isArray(lib.loras)) lib.loras = [];
    change(lib.loras);
    try { await putLib(lib); } catch (err) { Media.toast(`LoRAs: ${err.message}`); }
    renderObjects(); renderObjx(true); renderPanel(true);
  }
  async function objxClick(e) {
    const b = e.target.closest("[data-x], [data-xrm], [data-xlrm]"); if (!b) return;
    const c = Scene3D.current(), s = cur(); if (!c || !s) return;
    const o = c.sel >= 0 ? c.objs[c.sel] : null, x = b.dataset.x;
    if (x === "shot") { Scene3D.select(-1); return inspect("shot"); }
    if (x === "apply") { const box = b.closest(".v2-objx"); Scene3D.applyCameraMove(box.querySelector('[data-x="move"]').value, { framing: box.querySelector('[data-x="frame"]').value }); return renderPanel(true); }
    if (x === "savecam") return saveCamera();
    if (b.dataset.xrm != null) { linesOf(s).splice(+b.dataset.xrm, 1); save(); $("v2-lines").dataset.shot = ""; return renderObjx(true); }
    if (!o) return;
    if (x === "addline") { linesOf(s).push({ speaker: o.name, text: "" }); save(); $("v2-lines").dataset.shot = ""; renderObjx(true);
      const ins = document.querySelectorAll(".v2-objx [data-xl]"); ins[ins.length - 1]?.focus(); return; }
    if (x === "editlib") return objectEditor(st.objs.find(y => y.id === o.lib));
    if (x === "savelib") {
      try { await saveToLib(c, o); renderObjx(true); Media.toast(`${o.name} is in the object library: drag it into other shots.`); } catch (err) { Media.toast(`Save: ${err.message}`); }
    }
    if (x === "addlora" && st.loraList?.length) {
      let lib = o.lib && st.objs.find(y => y.id === o.lib);
      if (!lib) try { lib = await saveToLib(c, o); Media.toast(`${o.name} is in the object library now, with its LoRAs.`); } catch (err) { return Media.toast(`Save: ${err.message}`); }
      const used = new Set((lib.loras || []).map(l => l.name));
      if ((lib.loras || []).length < 4) await libLoras(lib, ls => ls.push({ name: (st.loraList.find(l => !used.has(l.name)) || st.loraList[0]).name, strength: 1 }));
      const sels = document.querySelectorAll(".v2-objx [data-xlname]"); sels[sels.length - 1]?.focus();
    }
    if (b.dataset.xlrm != null) { const lib = o.lib && st.objs.find(y => y.id === o.lib); if (lib) await libLoras(lib, ls => ls.splice(+b.dataset.xlrm, 1)); }
  }

  /* ---- the model, from what's in the shot */
  function sceneInfo(s) {
    const c = Scene3D.current();
    if (c && c.id === s.scene) {
      const objs = c.objs.filter(o => o.mesh && o.pos && !o.hidden);
      return { objects: objs.length, names: objs.map(o => o.name), pictures: objs.filter(o => o.picture).length, camMoves: c.moves,
        objMoves: objs.some(o => o.keys?.length > 1), picture: !!c.sc.picture, seconds: +c.seconds || 5, edit: c.edit, live: true };
    }
    const sc = st.scenes.get(s.scene) || {}, objs = (sc.objects || []).filter(o => !o.hidden);
    const K = sc.camera_keys || [];
    return { objects: objs.length, names: objs.map(o => o.name), pictures: objs.filter(o => o.picture).length,
      camMoves: K.length > 1 && K.some(k => Math.abs(k.yaw - K[0].yaw) + Math.abs(k.pitch - K[0].pitch) + Math.abs(k.dist - K[0].dist) > 1e-3),
      objMoves: objs.some(o => o.keys?.length > 1), picture: !!sc.picture, seconds: +sc.seconds || 5, edit: null, live: false };
  }
  // The objects in a shot's scene (as the builder has them when it's open).
  const objsOf = s => { const c = Scene3D.current(); return (c && c.id === s.scene ? c.objs : st.scenes.get(s.scene)?.objects || []).filter(o => !o.hidden); };
  const libOf = (s, name) => { const o = objsOf(s).find(x => x.name === name); return o?.lib ? st.objs.find(x => x.id === o.lib) : null; };
  // A shot's dialogue: [{speaker, text}] (an older shot's one line becomes the first).
  function linesOf(s) {
    if (!Array.isArray(s.lines)) { s.lines = s.line ? [{ speaker: s.speaker || "", text: s.line }] : []; delete s.line; delete s.speaker; }
    return s.lines;
  }
  // The voices a shot speaks with: each speaker's library voice, in order of first line, up to 3 (H3 takes 3).
  function voicesFor(s) {
    const out = [];
    for (const l of linesOf(s)) {
      if (!String(l.text || "").trim() || !l.speaker) continue;
      const v = libOf(s, l.speaker)?.voice;
      if (v && !out.some(x => x.ref === v) && out.length < 3) out.push({ ref: v, name: l.speaker });
    }
    return out;
  }
  // The LoRAs a shot takes: those of the library objects in its scene, each once, up to 8.
  /* The LoRAs a shot is made with: its own (s.loras: a style, a look), then its library objects' (a character), then
     the project's (every shot: the film's look). One in more than one goes at the first one's strength, so a shot can
     turn an object's or the project's down or up for itself; at 0 it's off. At most 8 go along. */
  const strengthOf = l => { const v = +l?.strength; return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1; };
  const objLoras = s => {
    const out = new Map();
    for (const o of objsOf(s).filter(o => o.lib)) for (const l of st.objs.find(x => x.id === o.lib)?.loras || [])
      if (l?.name && !out.has(l.name)) out.set(l.name, { name: l.name, strength: strengthOf(l) });
    return [...out.values()];
  };
  const projLoras = () => (st.board.settings.loras || []).filter(l => l?.name).map(l => ({ name: l.name, strength: strengthOf(l) }));
  // every LoRA with where it comes from ("shot" | "objects" | "project"), the first of each name, before the cap
  function loraSources(s) {
    const out = new Map();
    for (const [from, list] of [["shot", (s.loras || []).filter(l => l?.name).map(l => ({ name: l.name, strength: strengthOf(l) }))], ["objects", objLoras(s)], ["project", projLoras()]])
      for (const l of list) if (!out.has(l.name)) out.set(l.name, { ...l, from });
    return [...out.values()];
  }
  function lorasFor(s) {
    return loraSources(s).filter(l => l.strength > 0).slice(0, 8).map(({ name, strength }) => ({ name, strength }));
  }
  // The H3 LoRAs to pick from (as the object editor's), loaded once
  async function loadLoras() {
    try { st.loraList = ((await api("/api/loras")).loras || []).filter(l => l.family === "h3" && !l.turbo && !l.missing_file); } catch { st.loraList = []; }
  }
  // The shot panel's LoRAs: a row each (which one, how strong), and what its objects add
  function renderShotLoras(s, force = false) {
    const box = $("v2-shotloras"); if (!box || (!force && box.contains(document.activeElement))) return;
    const L = st.loraList || [], mine = s.loras || [], title = n => L.find(x => x.name === n)?.title || n;
    const src = loraSources(s), at = n => src.find(x => x.name === n);
    const said = (list, kind) => list.length ? `With ${kind}: ${list.map(l => { const w = at(l.name);
      return `${esc(title(l.name))} ${w.from !== (kind === "the project's" ? "project" : "objects") ? (w.strength > 0 ? `(at ${w.from === "shot" ? "this shot's" : "its object's"} strength, ${w.strength})` : "(off in this shot)") : `(${l.strength})`}`; }).join(", ")}. ` : "";
    const on = src.filter(l => l.strength > 0).length;
    box.innerHTML = mine.map((l, k) => `<div class="v2-lora"><select data-slname="${k}" aria-label="LoRA ${k + 1}">${L.some(x => x.name === l.name) ? "" : `<option value="${esc(l.name)}">${esc(l.name)} (not found)</option>`}${L.map(x => `<option value="${esc(x.name)}"${x.name === l.name ? " selected" : ""}>${esc(x.title || x.name)}</option>`).join("")}</select>
        <input type="number" data-slstr="${k}" min="0" max="2" step="0.05" value="${strengthOf(l)}" aria-label="Strength" title="0 turns it off in this shot"><button type="button" class="btn sm ghost" data-slrm="${k}" aria-label="Remove this LoRA">✕</button></div>`).join("")
      + (L.length ? `<button type="button" class="btn sm" data-sladd${mine.length >= 4 ? " disabled" : ""}>＋ LoRA</button>` : st.loraList ? `<p class="hint">No MiniMax H3 LoRAs found in ComfyUI.</p>` : "")
      + (objLoras(s).length || projLoras().length ? `<p class="hint">${said(objLoras(s), "its objects'")}${said(projLoras(), "the project's")}A shot's own at 0 turns one off here.${on > 8 ? " Only the first 8 go along." : ""}</p>` : "");
  }
  /* decide(shot) -> {engine: "h3" | "scene", ref, label, why: [reasons]} */
  function decide(s) {
    const i = sceneInfo(s), caps = state.caps || {}, why = [];
    if (!i.objects && !i.picture && !i.camMoves) {
      why.push("The set is empty and the camera holds still, so the words alone make the shot.");
      return { engine: "h3", ref: false, label: "MiniMax H3 · text to video", why, info: i };
    }
    const voices = caps.engines?.h3ref?.ready ? voicesFor(s) : [];
    const ref = (i.pictures > 0 || voices.length > 0) && !!caps.engines?.h3ref?.ready;
    const byRef = Scene3D.lastGuide?.() === "reference";  // the Render window's choice: a reference video or Time-to-Move
    if (i.camMoves) why.push(byRef ? "The camera moves: H3 Reference follows the 3D scene's render of the move, shown it as <Video 1> (Time-to-Move instead: the Render window)."
      : "The camera moves: H3 follows the scene's camera path (Time-to-Move).");
    if (i.objMoves) why.push("Objects move along their paths.");
    if (i.objects && !i.objMoves && !i.camMoves) why.push("The objects are where you put them; nothing moves, so they hold their places.");
    why.push(i.picture ? "It starts from the scene's picture." : "It starts from a photo of the first frame, made first (about a minute).");
    if (i.camMoves && !i.picture) why.push("What the camera move shows that the photo can't is painted in by Qwen first.");
    if (ref) why.push(`${i.pictures} object${i.pictures === 1 ? " has a picture" : "s have pictures"}: H3 Reference keeps ${i.pictures === 1 ? "its" : "their"} look.`);
    else if (i.pictures) why.push("Objects have pictures, but H3 Reference isn't installed: they go by their descriptions.");
    if (voices.length) why.push(`${voices.map(v => v.name).join(" and ")} speak${voices.length === 1 ? "s" : ""} with ${voices.length === 1 ? "a voice" : "voices"} from the library (H3 Reference).`);
    else if (!caps.engines?.h3ref?.ready && voicesFor(s).length) why.push("Some speakers have voices, but H3 Reference isn't installed: H3 picks the voices.");
    const L = lorasFor(s), src = loraSources(s).filter(l => l.strength > 0).slice(0, 8), n = k => src.filter(l => l.from === k).length;
    if (L.length) why.push(`${L.length} LoRA${L.length === 1 ? "" : "s"} go${L.length === 1 ? "es" : ""} along: ${[n("shot") ? `${n("shot")} the shot's` : "", n("objects") ? `${n("objects")} from its objects` : "", n("project") ? `${n("project")} the project's` : ""].filter(Boolean).join(", ")}.`);
    return { engine: "scene", ref: ref || byRef, label: ref || byRef ? `MiniMax H3 Reference · 3D scene render${byRef ? " (reference video)" : ""}` : "MiniMax H3 · 3D scene render", why, info: i };
  }

  /* ---- the words for H3 */
  const sentence = t => { t = String(t || "").trim().replace(/\s+/g, " "); if (!t) return ""; t = t[0].toUpperCase() + t.slice(1); return /[.!?]$/.test(t) ? t : t + "."; };
  /* The lines, in order: "{Woman} says, using the voice timbre referenced from <Audio 1>: <d>[English] …</d>". A speaker
     named already (in What happens, or a line before) is "The woman": the full description again reads as someone else.
     plain: names without {braces} (text to video). voices: from voicesFor. */
  // Someone named before, said again in a few words: "the young woman" from "a young woman in a red wool coat" (what
  // the object becomes), or "the woman" for an object called Woman; a name with no description stays as it is.
  function again(s, name) {
    const o = objsOf(s).find(x => x.name === name), what = String(o?.becomes || libOf(s, name)?.becomes || "").trim().toLowerCase();
    const short = what.split(/,|\b(?:in|with|wearing|who|holding|from|on|at|carrying)\b/)[0].replace(/^(a|an|the)\s+/, "").trim().split(/\s+/).slice(0, 4).join(" ");
    if (short) return `The ${short}`;
    return /^[a-z]/.test(name) || /^(man|woman|girl|boy|child|person|lady|dog|cat|robot)( \d+)?$/i.test(name) ? `The ${name.toLowerCase()}` : name;
  }
  function dialogueOf(s, voices = [], plain = false) {
    const seen = new Set(String(s.action || "").match(/\{[^{}]+\}/g) || []);
    const out = linesOf(s).map(l => {
      const text = String(l.text || "").trim().replace(/^["“]|["”]$/g, ""); if (!text) return "";
      const tag = l.speaker ? `{${l.speaker}}` : "", named = tag && seen.has(tag); if (tag) seen.add(tag);
      const who = !l.speaker ? "Someone" : plain ? l.speaker : named ? again(s, l.speaker) : tag;
      const k = voices.findIndex(v => v.name === l.speaker);
      return `${who} says once${k >= 0 ? `, using the voice timbre referenced from <Audio ${k + 1}>` : ""}: <d>[English] ${text}</d>`;
    }).filter(Boolean).join(" ");
    // ...and no words of H3's own around them (see Scene3D's linesText)
    if (out) return `${out} Only the words inside the dialogue tags are spoken, each line once; before, between and after them the speakers stay silent with their lips closed.`;
    return out;
  }
  const soundtrackOn = () => !!(st.board.settings.soundtrack?.on && st.board.settings.soundtrack?.style);
  const soundOf = s => `overall_soundscape: ${sentence(s.sound) || "Natural ambient sound of the scene."}\n\nnon_diegetic_music: ${soundtrackOn() ? "N/A" : String(s.music || "").trim() || "N/A"}`;
  // text to video: the whole shot in words (objects named by their names)
  function textPrompt(s) {
    const body = [sentence(s.setting), sentence(String(s.action || "").replace(/\{([^{}]+)\}/g, "$1")), dialogueOf(s, [], true), "The camera holds a static shot."].filter(Boolean).join(" ");
    return `integrated_multimodal_description: [Shot 1] ${body}\n\n${soundOf(s)}`;
  }

  /* ---- Generate */
  /* A shot's progress while it's made: the Render window's stages (Scene3D.stages), one list per shot, shown under
     Generate when that shot is open. */
  function stagesFor(id) {
    const old = st.stg.get(id); old?.stop?.(); old?.stopPhoto?.(); old?.stopUse?.();
    const el = document.createElement("section");
    el.className = "s3p-set s3r-stages v2-stages";
    el.setAttribute("aria-label", "Progress"); el.setAttribute("aria-live", "polite");
    el.innerHTML = `<div class="s3r-use" role="status" aria-label="The machine's load" hidden></div><h4>Progress <span class="s3r-sgh"></span></h4><ol></ol>`;
    const g = { el, sg: Scene3D.stages(el, () => st.stg.get(id) === g) };
    st.stg.set(id, g); showStages();
    // the machine's load while it's made (the Render window's), until the video's done or it fails
    g.stopUse = Scene3D.usageStrip?.(el.querySelector(".s3r-use"), () => st.stg.get(id) === g);
    return g;
  }
  function showStages() {
    const host = $("v2-stages"), g = st.sel && st.stg.get(st.sel);
    if (!g) { host.replaceChildren(); return; }
    if (g.el.parentNode !== host) host.replaceChildren(g.el);
  }
  async function generate(id) {
    const s = shotOf(id); if (!s || st.busy.has(id)) return;
    const entry = logStart(`🎬 ${s.name}`, id);
    const d = decide(s), g = stagesFor(id), sg = g.sg;
    const say = m => { st.say.set(id, m); if (st.sel === id) $("v2-say").textContent = m; logLine(entry, m); if (!/^Queued:/.test(m)) sg.say(m); };
    st.ctx = entry;
    { // its stages: the 3D scene's (a photo and the fill come in if it makes them), then H3 and the word check
      const n = Math.min(4, Math.max(1, +s.takes || 1)), words = linesOf(s).some(l => String(l.text || "").trim());
      const gpu = `Rendering on the GPU (${d.ref ? "H3 Reference" : "H3"}${n > 1 ? `, ${n} takes` : ""})`;
      const byRef = d.engine !== "h3" && Scene3D.lastGuide?.() === "reference";
      sg.plan([...(d.engine === "h3" ? [] : [["anim", byRef ? "Drawing the 3D scene's render (<Video 1>)" : "Drawing the rough animation"], ["mask", "Drawing its mask"]]),
        ["send", n > 1 ? `Sending ${n} takes to H3` : "Sending to H3"], ["queue", "Waiting in ComfyUI's queue"], ["gpu", gpu], ["save", n > 1 ? "Saving the videos" : "Saving the video"],
        ...(words ? [["words", "Checking the words (Whisper)"]] : [])]);
      g.words = words;
    }
    say(`Model: ${d.label}.`);
    st.busy.add(id); renderAll();
    try {
      { const voices = voicesFor(s);  // each speaker's voice sets their pace (measured once, Scene3D.loadRates)
        if (voices.length) await Promise.race([Scene3D.loadRates?.(voices), new Promise(r => setTimeout(r, 20000))]);
        const talk = Scene3D.speechSeconds?.(linesOf(s), voices) || 0, len = +d.info?.seconds || +s.seconds || 0, pace = Scene3D.paceNote?.(linesOf(s), voices);
        if (talk && len - talk > (Scene3D.SPARE_TALK || 2.5)) say(`⚠ The lines take about ${talk.toFixed(1)} s of this ${len.toFixed(1)} s shot${pace ? ` (at their voices' pace: ${pace} syllables a second)` : ""}: H3 may fill the rest with words of its own. A shorter shot, or more in What happens, keeps it to the lines.`); }
      let req;
      if (d.engine === "h3") {
        if (!String(s.action || s.setting || "").trim()) throw new Error("Say what the shot is: the setting, or what happens");
        req = { kind: "video", engine: "h3", prompt: textPrompt(s), seconds: d.info.seconds, aspect: "16:9", quality: s.quality || "standard",
          turbo: true, seed: -1, batch: 1, project: state.project?.id ?? null, scene: s.scene || null };
      } else {
        if (Scene3D._state()?.id !== s.scene) { await openShot(id); }
        const voices = d.ref ? voicesFor(s) : [];
        const extra = { ...shotExtra(s.scene), voices };  // the voices H3 Reference gets (none on plain H3)
        const r = await Scene3D.autoRender(s.scene, { text: sentence(s.action), extra, look: String(s.setting || "").trim(), quality: s.quality, fill: true,
          onPhoto: pid => { g.stopPhoto?.(); g.stopPhoto = Scene3D.followPhoto(pid, sg); } }, say);
        g.stopPhoto?.(); g.stopPhoto = null;
        req = { ...r.req, project: state.project?.id ?? null, loras: lorasFor(s), ...(voices.length ? { ref_audios: voices.map(v => v.ref), clean_audio: true } : {}) };
      }
      req.batch = Math.min(4, Math.max(1, +s.takes || 1));
      say(req.batch > 1 ? `Sending ${req.batch} takes to H3…` : "Sending to H3…");
      const items = await submit(req);
      if (!items?.length) throw new Error("H3 didn't take it");
      s.results = [...items.map(i => i.id), ...(s.results || [])].slice(0, 20);
      delete s.pick;  // the new takes: the shot uses the one whose words come out best
      save();
      say("Queued: it shows here when it's done.");
      g.stop = Scene3D.followRender(items, sg, g.words, () => { g.stopUse?.(); g.stopUse = null; });
    } catch (e) { g.stopPhoto?.(); g.stopUse?.(); g.stopUse = null; sg.fail(e.message); say(`⚠ ${e.message}`); Media.toast(`${s.name}: ${e.message}`); entry.failed = e.message; }
    finally { st.busy.delete(id); entry.prep = false; if (st.ctx === entry) st.ctx = null; renderAll(); renderLog(); }
  }
  /* 🗣 Words (app/heard.py): Whisper hears a take's lines and scores them; the shot then uses its best take. */
  async function hear(it) {
    if (st.hearing.has(it.id)) return;
    st.hearing.add(it.id); renderPanel(true);
    Media.toast("Checking the words: Whisper hears the sound…");
    try { it.heard = await api(`/api/items/${it.id}/heard`, { method: "POST" }); state.items.set(it.id, it); Media.toast(`Words: ${it.heard.score}% said as written.`); }
    catch (e) { Media.toast(`Checking the words: ${e.message}`); }
    finally { st.hearing.delete(it.id); renderAll(); }
  }
  /* 🔁 Retake the sound (engine "retake", app/workflows.py build_retake): the take's sound made again from a prompt,
     all of it or some stretches, its picture kept frame for frame. The new takes go on the shot, best words first. */
  function retakeDialog(s, it) {
    const f = fileOf(it); if (!f) return;
    const p = it.params || {}, secs = +(it.info?.seconds || p.seconds || 0);
    const box = document.createElement("div");
    box.className = "wm-form v2-rt";
    box.innerHTML = `<p class="hint">H3 Reference makes the sound again from the prompt: its lines (<code>&lt;d&gt;…&lt;/d&gt;</code>), voices and sounds. The picture stays exactly as it is${secs ? ` (${secs.toFixed(1)} s)` : ""}.</p>
      <label class="v2-rt-l">What is said and heard<textarea id="v2-rt-prompt" rows="9" spellcheck="true">${esc(p.prompt || "")}</textarea></label>
      <label class="v2-rt-l">Only these stretches <span class="hint">seconds, e.g. 1.2-3.4, 5-6 · empty: all of the sound; the rest keeps the original sound</span>
        <span class="v2-rt-row"><input id="v2-rt-ranges" type="text" placeholder="All of it" autocomplete="off">
        <button type="button" class="btn sm" data-m="start" title="Start a stretch where the shot's video is now">⏱ From here</button>
        <button type="button" class="btn sm" data-m="end" title="End the stretch where the shot's video is now">⏱ To here</button></span></label>
      <label class="v2-rt-l">Takes <span class="hint">each is checked for its words; the shot uses the best</span>
        <select id="v2-rt-takes"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select></label>
      <label class="check" title="MelBand RoFormer splits both: the new take's voice goes over the original's music and other sounds"><input type="checkbox" id="v2-rt-keepbg" checked> Keep its music and sounds: only the voice is new</label>
      ${p.ref_audios?.length ? `<label class="check"><input type="checkbox" id="v2-rt-voices" checked> Use the ${p.ref_audios.length} voice${p.ref_audios.length > 1 ? "s" : ""} it was made with</label>` : ""}
      <p class="v2-rt-err warn" hidden></p>`;
    let mark = null;
    box.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
      const v = $("v2-result").querySelector("video"), t = v ? +v.currentTime.toFixed(2) : null;
      if (t == null) return Media.toast("Play the shot's video and stop where the stretch starts or ends.");
      const inp = box.querySelector("#v2-rt-ranges");
      if (b.dataset.m === "start") { mark = t; Media.toast(`Stretch from ${t} s: now stop where it ends and press To here.`); return; }
      const a = mark ?? 0; mark = null;
      inp.value = [inp.value.trim(), `${a}-${+Math.max(a + 0.2, t).toFixed(2)}`].filter(Boolean).join(", ");
    });
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button>
      <button type="button" class="btn sm primary" data-a="go">🔁 Retake</button>`;
    const win = WM.open({ id: `v2rt-${it.id}`, title: `Retake the sound · ${s.name}`, content: box, footer: foot, width: 620, height: 560, minWidth: 420, minHeight: 380 });
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = async e => {
      const prompt = box.querySelector("#v2-rt-prompt").value.trim(), err = box.querySelector(".v2-rt-err");
      if (!prompt) { err.hidden = false; err.textContent = "Write what is said and heard."; return; }
      const voices = box.querySelector("#v2-rt-voices"), n = +box.querySelector("#v2-rt-takes").value;
      e.target.disabled = true;
      try {
        const items = await submit({ ...p, kind: "video", engine: "retake", source: f.path, prompt, retake_ranges: box.querySelector("#v2-rt-ranges").value.trim(),
          retake_keep_bg: box.querySelector("#v2-rt-keepbg").checked, seed: -1, batch: n, project: state.project?.id ?? null,
          references: p.references || [], ref_audios: voices && !voices.checked ? [] : (p.ref_audios || []),
          first_frame: null, last_frame: null, continue_from: null, enhance_after: null, motion_video: null, motion_video_mask: null, motion_layers: [] });
        if (!items?.length) throw new Error("It wasn't taken");
        s.results = [...items.map(i => i.id), ...(s.results || [])].slice(0, 20);
        delete s.pick;
        save(); renderAll();
        Media.toast(`Retaking the sound of ${s.name}: ${n} take${n > 1 ? "s" : ""}.`);
        win.close();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; e.target.disabled = false; }
    };
  }
  /* The Render window's Add to Timeline: the finished video becomes the take of the shot that uses its scene (a new
     shot at the end when none does), picked, so the timeline plays it. */
  function addRender(sceneId, it) {
    if (!it?.id || !sceneId) return false;
    let s = st.board.shots.find(x => x.scene === sceneId), made = false;
    if (!s) {
      const n = st.board.shots.length + 1;
      s = { id: uid(), scene: sceneId, name: st.scenes.get(sceneId)?.name || `Shot ${n}`, setting: "", action: "", lines: [], sound: "", music: "",
        quality: "standard", transition: "cut", tlen: "", results: [] };
      st.board.shots.push(s); made = true;
    }
    s.results = [it.id, ...(s.results || []).filter(x => x !== it.id)].slice(0, 20);
    s.pick = it.id;
    save(); renderAll();
    Media.toast(made ? `It's on the timeline as a new shot, ${s.name}.` : `It's ${s.name}'s take on the timeline now.`);
    return true;
  }
  // The Render window's "Add it to the timeline when it's done": the first good take goes in when it's done
  const addLater = new Map();  // a take's id -> { scene, ids: all the takes }
  function addWhenDone(sceneId, items) {
    if (!sceneId || !items?.length) return;
    const b = { scene: sceneId, ids: items.map(x => x.id) };
    for (const id of b.ids) addLater.set(id, b);
  }
  function maybeAddLater(it) {
    const b = addLater.get(it.id); if (!b) return;
    const all = b.ids.map(id => id === it.id ? it : state.items.get(id));
    const good = all.find(x => x?.status === "done" && x.files?.length);
    if (!good && !all.every(x => ["done", "failed", "cancelled"].includes(x?.status))) return;
    for (const id of b.ids) addLater.delete(id);
    if (good) addRender(b.scene, good);
  }
  async function generateAll() {
    for (const s of st.board.shots.slice()) await generate(s.id);
  }

  /* ---- the timeline: each shot's piece of its video, and how it joins the next */
  const num = (v, d = null) => v === "" || v == null || !isFinite(+v) ? d : +v;
  // its video's length (the latest result when there is one, else the scene's), and the part used
  function pieceOf(s) {
    const it = latest(s), len = num(it?.status === "done" ? it.params?.seconds : null, decide(s).info.seconds);
    const a = Math.max(0, Math.min(num(s.trim_in, 0), len - 0.2)), b = Math.max(a + 0.2, Math.min(num(s.trim_out, len), len));
    return { len, a, b, d: b - a };
  }
  const joinOf = (s, i, list) => i < list.length - 1 && s.transition && s.transition !== "cut"
    ? Math.min(num(s.tlen, 0.5), pieceOf(s).d / 2, pieceOf(list[i + 1]).d / 2) : 0;
  const totalSeconds = () => { const L = st.board.shots; return L.reduce((a, s, i) => a + pieceOf(s).d - joinOf(s, i, L), 0); };

  /* ---- export: the shots as one video, with the soundtrack under them */
  function exportDialog() {
    const L = st.board.shots, rows = L.map((s, i) => ({ s, i, it: latest(s), f: fileOf(latest(s)) }));
    const missing = rows.filter(r => !r.f);
    const t = st.board.settings.soundtrack, mit = t?.result && state.items.get(t.result), mf = t?.on && mit?.status === "done" ? mit.files?.[0] : null;
    const ex = { name: `${state.project?.name || "Experiment"} · V2`, music: 0.6, shots: 1, format: "mp4-h264", ...(st.board.settings.export || {}) };
    const box = document.createElement("div");
    box.className = "v2-ed";
    box.innerHTML = `<p class="hint">The shots' latest videos, in order, trimmed and joined as set under each shot's “On the timeline”, ${totalSeconds().toFixed(1)} s.</p>
      <ul class="v2-exl">${rows.map(r => `<li>${r.f ? "✓" : "⚠"} ${r.i + 1}. ${esc(r.s.name)} <span class="hint">${r.f ? `${pieceOf(r.s).d.toFixed(1)} s${r.s.transition && r.s.transition !== "cut" && r.i < L.length - 1 ? ` · ${esc(document.querySelector(`#v2-trans option[value="${r.s.transition}"]`)?.textContent || r.s.transition)}` : ""}`
        : r.it ? esc(r.it.status) : "not made yet"}</span></li>`).join("")}</ul>
      ${missing.length ? `<p class="warn">${missing.length === L.length ? "No shot has a video yet: Generate them first." : `${missing.length} shot${missing.length === 1 ? " has" : "s have"} no video yet and ${missing.length === 1 ? "is" : "are"} left out.`}</p>` : ""}
      <div class="field"><label for="ve-name">Name</label><input id="ve-xname" maxlength="100" value="${esc(ex.name)}"></div>
      <label class="check"><input type="checkbox" id="ve-xmusic"${mf ? " checked" : " disabled"}> The soundtrack under the shots ${mf ? "" : `<span class="opt">${t?.style ? "not made yet, or off" : "none: 🎵 Soundtrack makes one"}</span>`}</label>
      <div class="row2"><div class="field"><label for="ve-xmv">Soundtrack level</label><input type="range" id="ve-xmv" min="0" max="1.5" step="0.05" value="${ex.music}"></div>
        <div class="field"><label for="ve-xsv">The shots' own sound</label><input type="range" id="ve-xsv" min="0" max="1.5" step="0.05" value="${ex.shots}"></div></div>
      <div class="field"><label for="ve-xfmt">Format</label><select id="ve-xfmt"><option value="mp4-h264">MP4 · H.264 (plays everywhere)</option><option value="mp4-h265">MP4 · H.265 (smaller)</option>
        <option value="webm-vp9">WebM · VP9 (web)</option><option value="mov-prores">MOV · ProRes 422 HQ (editing)</option></select></div>`;
    box.querySelector("#ve-xfmt").value = ex.format;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="grow"></span><button type="button" class="btn ghost" data-a="close">Cancel</button>
      <button type="button" class="btn primary" data-a="go"${missing.length === L.length ? " disabled" : ""}>⬇ Export</button>`;
    const win = WM.open({ id: "v2-export", title: "Export", content: box, footer: foot, width: 520, height: 560, modal: true });
    foot.querySelector('[data-a="close"]').onclick = () => win.close();
    foot.querySelector('[data-a="go"]').onclick = async e => {
      const o = { name: box.querySelector("#ve-xname").value.trim() || "V2 export", music: +box.querySelector("#ve-xmv").value, shots: +box.querySelector("#ve-xsv").value, format: box.querySelector("#ve-xfmt").value };
      st.board.settings.export = o; save();
      const use = rows.filter(r => r.f);
      const clips = use.map((r, k) => { const p = pieceOf(r.s); return { ref: r.f.path, name: r.s.name, trim_in: p.a, trim_out: p.b,
        transition: k < use.length - 1 ? r.s.transition || "cut" : "cut", tlen: Math.max(0.1, Math.min(3, num(r.s.tlen, 0.5))) }; });
      e.target.disabled = true;
      try {
        const it = await api("/api/v2/export", { method: "POST", body: JSON.stringify({ project: state.project?.id ?? null, name: o.name, clips,
          music: box.querySelector("#ve-xmusic").checked && mf ? mf.path : null, music_volume: o.music, shots_volume: o.shots, format: o.format }) });
        state.items.set(it.id, it);
        onSubmit({ engine: "timeline" }, [it]);
        st.board.settings.lastExport = it.id; save(); renderExport();
        win.close();
        Media.toast("Exporting: it shows in the timeline bar, and in the classic page's gallery, when it's done.");
      } catch (err) { e.target.disabled = false; Media.toast(`Export: ${err.message}`); }
    };
  }
  function renderExport() {
    const it = st.board.settings.lastExport && state.items.get(st.board.settings.lastExport), el = $("v2-exportst");
    if (!it) { el.innerHTML = ""; return; }
    const f = it.status === "done" ? it.files?.[0] : null;
    el.innerHTML = f ? `Exported: <a href="${esc(f.url)}" target="_blank" rel="noopener">▶ ${esc(f.name || "the video")}</a>`
      : it.status === "failed" ? `<span class="warn">Export failed: ${esc(it.error || "")}</span>` : `Exporting… ${Math.round((it.progress || 0) * 100)}%`;
  }

  /* ---- the soundtrack: one piece of music for the whole timeline (MiniMax Music 3) */
  /* 🧩 The project's LoRAs: every shot in it is made with them (after its own and its objects'; a shot's own at 0
     turns one off there). Kept with the shots (the board's settings). */
  function projectLorasDialog() {
    const box = document.createElement("div");
    box.className = "v2-ed";
    const list = () => (st.board.settings.loras ||= []);
    const draw = () => {
      const L = st.loraList || [], mine = list();
      box.innerHTML = `<p class="hint">LoRAs every shot in ${esc(state.project?.name || "Experiment")} is made with: the film's look, a style. A shot's own LoRAs and its objects' come first; one a shot has too goes at the shot's strength, and at 0 it's off in that shot.</p>
        ${mine.map((l, k) => `<div class="v2-lora"><select data-plname="${k}" aria-label="LoRA ${k + 1}">${L.some(x => x.name === l.name) ? "" : `<option value="${esc(l.name)}">${esc(l.name)} (not found)</option>`}${L.map(x => `<option value="${esc(x.name)}"${x.name === l.name ? " selected" : ""}>${esc(x.title || x.name)}</option>`).join("")}</select>
          <input type="number" data-plstr="${k}" min="0" max="2" step="0.05" value="${strengthOf(l)}" aria-label="Strength"><button type="button" class="btn sm ghost" data-plrm="${k}" aria-label="Remove this LoRA">✕</button></div>`).join("")}
        ${L.length ? `<button type="button" class="btn sm" data-pladd${mine.length >= 4 ? " disabled" : ""}>＋ LoRA</button>` : `<p class="hint">No MiniMax H3 LoRAs found in ComfyUI.</p>`}`;
    };
    const changed = () => { save(); projLoraBtn(); renderPanel(true); };
    box.addEventListener("change", e => {
      const t = e.target, l = list()[+(t.dataset.plname ?? t.dataset.plstr)]; if (!l) return;
      if (t.dataset.plname != null) l.name = t.value; else l.strength = t.value === "" ? 1 : strengthOf({ strength: t.value });
      changed();
    });
    box.addEventListener("click", e => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.hasAttribute("data-pladd") && st.loraList?.length && list().length < 4) {
        const used = new Set(list().map(l => l.name)); list().push({ name: (st.loraList.find(x => !used.has(x.name)) || st.loraList[0]).name, strength: 1 });
      } else if (t.dataset.plrm != null) list().splice(+t.dataset.plrm, 1);
      else return;
      changed(); draw();
      if (t.hasAttribute("data-pladd")) box.querySelector(`[data-plname="${list().length - 1}"]`)?.focus();
    });
    draw();
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm primary" data-a="done">Done</button>`;
    const win = WM.open({ id: "v2-projloras", title: `LoRAs · ${state.project?.name || "Experiment"}`, content: box, footer: foot, width: 560, height: 420, modal: true });
    foot.querySelector('[data-a="done"]').onclick = () => win.close();
  }
  // the timeline bar's button: how many the project has
  function projLoraBtn() {
    const b = $("v2-projloras"); if (!b) return;
    const n = projLoras().length;
    b.textContent = n ? `🧩 LoRAs · ${n}` : "🧩 LoRAs";
    b.classList.toggle("on", n > 0);
  }
  function soundtrackDialog() {
    const t = { on: true, style: "", lyrics: "", ...(st.board.settings.soundtrack || {}) }, T = totalSeconds();
    const it = t.result && state.items.get(t.result), f = it?.status === "done" ? it.files?.[0] : null;
    const box = document.createElement("div");
    box.className = "v2-ed";
    box.innerHTML = `<p class="hint">One piece of music under every shot, ${T.toFixed(1)} s long (the shots together), made by MiniMax Music 3. While it's on, the shots are made without their own music.</p>
      <label class="check"><input type="checkbox" id="vs-on"${t.on ? " checked" : ""}> Use the soundtrack</label>
      <div class="field"><label for="vs-style">The music <span class="opt">genre, tempo, instruments, mood</span></label>
        <textarea id="vs-style" rows="3" maxlength="1000" placeholder="Warm acoustic folk, 90 BPM, fingerpicked guitar and soft strings; calm at first, building gently to a hopeful end.">${esc(t.style)}</textarea></div>
      <div class="field"><label for="vs-lyrics">Lyrics <span class="opt">optional; none: instrumental</span></label>
        <textarea id="vs-lyrics" rows="4" maxlength="5000" placeholder="[Verse]&#10;…">${esc(t.lyrics)}</textarea></div>
      <div class="v2-say-row"><span class="hint" id="vs-say">${it ? `${f ? "Made" : esc(it.status)}${t.seconds ? ` · ${(+t.seconds).toFixed(1)} s` : ""}${t.seconds && Math.abs(t.seconds - T) > 0.6 ? ` · ⚠ the timeline is ${T.toFixed(1)} s now: make it again to fit` : ""}` : "Not made yet."}</span></div>
      ${f ? `<audio controls src="${esc(f.url)}" style="width:100%"></audio>` : ""}`;
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `<span class="grow"></span><button type="button" class="btn ghost" data-a="close">Close</button>
      <button type="button" class="btn primary" data-a="make"${T < 1 ? " disabled" : ""}>🎵 ${f ? "Make it again" : "Make the soundtrack"}</button>`;
    const win = WM.open({ id: "v2-soundtrack", title: "Soundtrack", content: box, footer: foot, width: 520, height: 520, modal: true });
    const keep = () => {
      st.board.settings.soundtrack = { ...t, on: box.querySelector("#vs-on").checked, style: box.querySelector("#vs-style").value.trim(), lyrics: box.querySelector("#vs-lyrics").value.trim() };
      save(); renderAll();
    };
    box.addEventListener("change", keep);
    foot.querySelector('[data-a="close"]').onclick = () => { keep(); win.close(); };
    foot.querySelector('[data-a="make"]').onclick = async e => {
      keep();
      const cur0 = st.board.settings.soundtrack;
      if (!cur0.style) { box.querySelector("#vs-style").focus(); return Media.toast("Describe the music first."); }
      e.target.disabled = true;
      const secs = Math.max(5, Math.min(300, Math.round(totalSeconds() * 10) / 10));
      const items = await submit({ kind: "audio", engine: "music3", prompt: cur0.style, lyrics: cur0.lyrics || "", seconds: secs, seed: -1, batch: 1, project: state.project?.id ?? null });
      if (!items?.length) { e.target.disabled = false; return; }
      st.board.settings.soundtrack = { ...cur0, result: items[0].id, seconds: secs };
      save(); renderAll(); win.close();
      Media.toast(`Soundtrack: Music 3 is making ${secs} s of music. It shows under the timeline when it's done.`);
    };
  }
  function renderSoundtrack() {
    $("v2-musichint").hidden = !soundtrackOn();
    $("v2-music").disabled = soundtrackOn();
  }

  /* ---- the log: what's being made, step by step, with the studio's own log lines and progress */
  const LOG_MAX = 12, LOG_KEY = "bob.v2.log";
  /* The log is kept in this browser (its jobs, their own steps and which studio results they made), so a reload
     shows it again; the results' lines and progress come back from the studio. */
  function keepLog() {
    if (!st.logReady) return;  // not before the kept one is back
    clearTimeout(st.logKeepT);
    st.logKeepT = setTimeout(() => {
      try { localStorage.setItem(LOG_KEY, JSON.stringify(st.log.map(e => ({ ...e, lines: e.lines.slice(-80) })))); } catch { /* not kept */ }
    }, 400);
  }
  function restoreLog() {
    let kept = [];
    st.logReady = true;
    try { kept = JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { /* none */ }
    if (!Array.isArray(kept)) return;
    st.log = kept.filter(e => e && e.key && Array.isArray(e.lines) && Array.isArray(e.items)).slice(0, LOG_MAX).map(e => {
      const items = e.items.filter(x => state.items.has(x?.id));  // results the studio no longer has go
      // one that was still being prepared in the page when it reloaded was never sent
      const failed = e.failed || (e.prep && !items.length ? "the page was reloaded before it was sent" : null);
      return { ...e, items, prep: false, failed };
    });
  }
  const engineTitle = req => req.engine === "imgedit" ? (/^Replace every solid magenta/.test(req.prompt || "") ? "🧩 Qwen fills what the photo can't see" : "📷 Photo of the first frame")
    : req.engine === "motion" ? "🎬 Video (H3 following the scene)" : req.engine === "h3" || req.engine === "h3ref" ? "🎬 Video (H3)" : req.engine === "music3" ? "🎵 Soundtrack (Music 3)"
    : req.engine === "timeline" ? "⬇ Export" : req.engine === "retake" ? "🔁 Sound retake" : `⚙ ${req.engine}`;
  function logStart(title, shot = null) {
    const e = { key: uid(), title, shot, t0: Date.now() / 1000, lines: [], items: [], prep: true, failed: null };
    st.log.unshift(e); st.log.length = Math.min(st.log.length, LOG_MAX);
    st.logAuto = true; showTlView("log");
    renderLog();
    return e;
  }
  const logLine = (e, msg) => { e.lines.push({ t: Date.now() / 1000, msg }); renderLog(); };
  function onSubmit(req, items) {
    const id = items?.[0]?.id; if (!id) return;
    if (st.ctx) { st.ctx.items.push({ id, title: engineTitle(req) }); return renderLog(); }
    const e = logStart(engineTitle(req)); e.prep = false; e.items.push({ id, title: engineTitle(req) }); renderLog();
  }
  const FIN = ["done", "failed", "cancelled"];
  // while anything runs, the log redraws every second (elapsed time, progress)
  setInterval(() => { if ((st.tlv === "log" || st.logWin?.isConnected) && st.log.some(entryBusy)) renderLog(); }, 1000);
  const entryBusy = e => e.prep || e.items.some(x => !FIN.includes(state.items.get(x.id)?.status || "queued"));
  function renderLog() {
    keepLog();
    const busy = st.log.filter(entryBusy).length;
    $("v2-logn").textContent = busy ? `· ${busy}` : "";
    if (!$("v2-log").hidden) drawLog($("v2-log"), 40);
    if (st.logWin?.isConnected) drawLog(st.logWin, 400);
    // everything done: back to the timeline a moment later (if the log came up by itself)
    clearTimeout(st.logBackT);
    if (!busy && st.logAuto && st.tlv === "log") st.logBackT = setTimeout(() => { if (!st.log.some(entryBusy) && st.logAuto) showTlView("tl"); }, 6000);
  }
  /* The log into a box (the timeline's, or the big window's), its last n lines a job. Each job's lines stay on the
     newest one as they come in, unless they were scrolled up to read (then they stay put). */
  function drawLog(box, n) {
    if (!st.log.length) { box.innerHTML = `<p class="hint">Nothing made yet. When a shot, photo, soundtrack or export is being made, every step shows here.</p>`; return; }
    const keep = box.scrollTop, was = new Map();
    box.querySelectorAll(".v2-logjob[data-k] ol").forEach(ol => was.set(ol.parentElement.dataset.k, ol.scrollHeight - ol.scrollTop - ol.clientHeight < 6 ? null : ol.scrollTop));
    box.innerHTML = st.log.map(e => {
      const its = e.items.map(x => ({ ...x, it: state.items.get(x.id) }));
      const last = its.at(-1)?.it, status = e.failed ? "failed" : entryBusy(e) ? (e.prep && !last ? "preparing" : last?.status || "queued") : last?.status || "done";
      const pct = last && !FIN.includes(last.status) ? Math.round((last.progress || 0) * 100) : status === "done" ? 100 : 0;
      const lines = [...e.lines.map(l => ({ ...l, who: "" })), ...its.flatMap(x => (x.it?.log || []).map(l => ({ t: l.t, msg: l.msg, level: l.level, who: x.title })))]
        .sort((a, b) => a.t - b.t).slice(-n);
      const dur = Math.max(0, ((FIN.includes(last?.status) ? (last.finished || Date.now() / 1000) : Date.now() / 1000) - e.t0));
      return `<article class="v2-logjob ${esc(status)}" data-k="${esc(e.key)}"><header><b>${esc(e.title)}</b><span class="v2-logst">${esc(status)}${e.failed ? `: ${esc(e.failed)}` : ""}</span>
          <span class="hint">${Math.floor(dur / 60) ? `${Math.floor(dur / 60)} m ` : ""}${Math.round(dur % 60)} s</span>
          ${its.length ? `<span class="hint">${its.map(x => esc(x.title)).join(" → ")}</span>` : ""}</header>
        <div class="v2-logbar"><i style="width:${pct}%"></i></div>
        <ol>${lines.map(l => `<li class="${l.level === "error" ? "err" : ""}"><time>${new Date(l.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>${l.who ? `<span class="v2-logwho">${esc(l.who.replace(/^\S+\s/, ""))}</span>` : ""} ${esc(l.msg)}</li>`).join("")}</ol></article>`;
    }).join("");
    box.scrollTop = keep;
    box.querySelectorAll(".v2-logjob[data-k] ol").forEach(ol => { const t = was.get(ol.parentElement.dataset.k); ol.scrollTop = t == null ? ol.scrollHeight : t; });
  }
  // ⤢ The log in a big window (it keeps up while it's open; the timeline stays usable)
  function logWindow() {
    const box = document.createElement("div");
    box.className = "v2-log v2-logbig";
    box.setAttribute("aria-live", "polite");
    st.logWin = box;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm primary" data-a="close">Close</button>`;
    const win = WM.open({ id: "v2-logwin", title: "Log", content: box, footer: foot, width: Math.min(1100, innerWidth - 60), height: Math.min(760, innerHeight - 80),
      modal: false, onClose: () => { if (st.logWin === box) st.logWin = null; } });
    foot.querySelector('[data-a="close"]').onclick = () => win.close();
    drawLog(box, 400);
  }
  function showTlView(v) {
    st.tlv = v;
    document.querySelectorAll(".v2-tlview [data-tlv]").forEach(b => { const on = b.dataset.tlv === v; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
    $("v2-tlbody").hidden = v !== "tl"; $("v2-log").hidden = v !== "log";
    document.querySelector(".v2-tlzoom").hidden = v !== "tl";
    $("v2-logbig").hidden = v !== "log";
    if (v === "log") renderLog(); else renderTimeline();
  }

  /* ---- the timeline's size: folded or not, its height, its zoom (kept in this browser) */
  const TLK = "bob.v2.tl";
  const tlUI = (() => { try { return { h: 210, fold: false, z: 0, units: "s", ...JSON.parse(localStorage.getItem(TLK) || "{}") }; } catch { return { h: 210, fold: false, z: 0, units: "s" }; } })();
  // a time as the timeline shows it: seconds, or frames (24 a second)
  const fmtT = (t, dp = 1) => tlUI.units === "f" ? `${Math.round(t * 24)} f` : `${(+t).toFixed(dp)} s`;
  const markers = () => (st.board.settings.markers ||= []);
  const saveTlUI = () => { try { localStorage.setItem(TLK, JSON.stringify(tlUI)); } catch {} };
  function applyTlUI() {
    const tl = $("v2-tl"), h = Math.max(110, Math.min(Math.round(innerHeight * 0.7), tlUI.h));
    tl.classList.toggle("folded", tlUI.fold);
    tl.style.height = tlUI.fold ? "" : `${h}px`;
    $("v2-tlfold").textContent = tlUI.fold ? "▸" : "▾";
    $("v2-tlfold").setAttribute("aria-expanded", String(!tlUI.fold));
    $("v2-tlfold").title = tlUI.fold ? "Open the timeline" : "Fold the timeline away";
  }

  /* ---- the object library */
  const SHAPES = [["figure", "🧍 Person"], ["cube", "▢ Cube"], ["sphere", "◯ Sphere"], ["cylinder", "⌭ Cylinder"], ["cone", "△ Cone"], ["plane", "▱ Plane"], ["torus", "◎ Ring"]];
  const shapeIcon = e => e.kind === "model" ? "🧊" : (SHAPES.find(x => x[0] === e.prim)?.[1] || "🧍").split(" ")[0];
  async function loadObjects() {
    try { st.objs = (await api("/api/v2/objects")).objects || []; } catch (e) { st.objs = []; status(`Objects: ${e.message}`); }
    renderObjects();
  }
  function renderObjects() {
    const q = ($("v2-objq").value || "").trim().toLowerCase();
    const list = st.objs.slice().sort((a, b) => a.name.localeCompare(b.name)).filter(e => !q || `${e.name} ${e.becomes}`.toLowerCase().includes(q));
    $("v2-noobjs").hidden = st.objs.length > 0;
    $("v2-objgrid").innerHTML = list.map(e => `<div class="v2-obj" role="listitem" draggable="true" tabindex="0" data-oid="${esc(e.id)}" title="${esc(e.becomes || e.name)}: drag onto the scene, or ＋; double-click to edit">
        <div class="v2-objth">${e.pictures?.[0] ? `<img src="${esc(mediaUrl(e.pictures[0]))}" alt="" loading="lazy">` : `<span>${shapeIcon(e)}</span>`}</div>
        <b>${esc(e.name)}</b><span class="hint">${e.pictures?.length ? `${e.pictures.length} 🖼` : ""}${e.loras?.length ? ` ${e.loras.length} 🧩` : ""}${e.voice ? " 🗣" : ""}</span>
        <button type="button" class="v2-objadd" data-add="${esc(e.id)}" title="Put ${esc(e.name)} in the scene, in front of the camera" aria-label="Add ${esc(e.name)} to the scene">＋</button>
        <button type="button" class="v2-objedit" data-edit="${esc(e.id)}" title="Edit ${esc(e.name)}: what it is, pictures, LoRAs, voice" aria-label="Edit ${esc(e.name)}">✎</button></div>`).join("");
  }
  async function place(id, cx = null, cy = null) {
    const e = st.objs.find(x => x.id === id); if (!e) return;
    if (!Scene3D.current()) return Media.toast("Open a shot first: its scene is where objects go.");
    const o = await Scene3D.addFromLibrary(e, cx, cy);
    if (o) Media.toast(`${o.name} is in the scene${e.pictures?.length ? " (its picture keeps its look on H3 Reference)" : ""}.`);
  }
  async function objectEditor(e0 = null) {
    const e = e0 ? { voice: null, ...structuredClone(e0) } : { id: uid(), name: "", kind: "prim", prim: "figure", model: null, becomes: "", pictures: [], loras: [], voice: null, notes: "" };
    let models = [], loras = [];
    try { models = ((await api("/api/models3d")).models || []).filter(m => m.status === "done"); } catch { /* none */ }
    try { loras = ((await api("/api/loras")).loras || []).filter(l => l.family === "h3" && !l.turbo && !l.missing_file); } catch { /* none */ }
    const box = document.createElement("div");
    box.className = "v2-ed";
    const shapeVal = () => e.kind === "model" ? `model:${e.model}` : e.prim || "figure";
    const draw = () => {
      box.innerHTML = `<div class="field"><label for="ve-name">Name <span class="opt">how you call it in the shot: {Name}</span></label><input id="ve-name" maxlength="60" value="${esc(e.name)}" placeholder="Woman"></div>
        <div class="field"><label for="ve-shape">Stand-in in the scene</label><select id="ve-shape">
          <optgroup label="Shapes">${SHAPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</optgroup>
          ${models.length ? `<optgroup label="3D models">${models.map(m => `<option value="model:${esc(m.id)}">🧊 ${esc(m.name)}</option>`).join("")}</optgroup>` : ""}</select></div>
        <div class="field"><label for="ve-becomes">What it is <span class="opt">what the photo and video make of it</span></label>
          <textarea id="ve-becomes" rows="2" maxlength="300" placeholder="a young woman in a flowing white linen sundress, barefoot">${esc(e.becomes)}</textarea></div>
        <div class="field"><span class="v2-lbl">Reference pictures <span class="opt">the first goes to H3 Reference, to keep its look</span></span>
          <div class="v2-pics">${e.pictures.map((p, k) => `<span class="v2-pic"><img src="${esc(mediaUrl(p))}" alt="Picture ${k + 1}">${k === 0 ? `<i>used</i>` : ""}<button type="button" data-rmpic="${k}" aria-label="Remove picture ${k + 1}">✕</button></span>`).join("")}
            <button type="button" class="v2-picadd" data-act="addpic" title="Upload pictures">＋</button></div>
          <input type="file" id="ve-files" accept="image/png,image/jpeg,image/webp" multiple hidden></div>
        <div class="field"><span class="v2-lbl">LoRAs <span class="opt">MiniMax H3 LoRAs: a character, a style</span></span>
          ${e.loras.map((l, k) => `<div class="v2-lora"><select data-lname="${k}">${loras.some(x => x.name === l.name) ? "" : `<option value="${esc(l.name)}">${esc(l.name)} (not found)</option>`}${loras.map(x => `<option value="${esc(x.name)}"${x.name === l.name ? " selected" : ""}>${esc(x.title || x.name)}</option>`).join("")}</select>
            <input type="number" data-lstr="${k}" min="0" max="2" step="0.05" value="${+l.strength || 1}" aria-label="Strength"><button type="button" class="btn sm ghost" data-rmlora="${k}" aria-label="Remove this LoRA">✕</button></div>`).join("")}
          ${loras.length ? `<button type="button" class="btn sm" data-act="addlora"${e.loras.length >= 4 ? " disabled" : ""}>＋ LoRA</button>` : `<p class="hint">No MiniMax H3 LoRAs found in ComfyUI.</p>`}</div>
        <div class="field"><span class="v2-lbl">Voice <span class="opt">a recording of how it speaks: its lines use it (H3 Reference)</span></span>
          ${e.voice ? `<div class="v2-voice"><audio controls src="${esc(mediaUrl(e.voice))}"></audio><button type="button" class="btn sm ghost" data-act="rmvoice">✕ Remove</button></div>` : ""}
          <button type="button" class="btn sm" data-act="addvoice">${e.voice ? "Replace…" : "＋ Voice recording…"}</button>
          <input type="file" id="ve-voice" accept="audio/*,video/mp4,video/webm,video/quicktime" hidden>
          <p class="hint">A clear 6–10 s of the voice; it's cleaned up and the best part kept. Only use voices you have permission to use.</p></div>
        <div class="field"><label for="ve-notes">Notes <span class="opt">not sent to the model</span></label><textarea id="ve-notes" rows="2" maxlength="2000">${esc(e.notes)}</textarea></div>`;
      box.querySelector("#ve-shape").value = shapeVal();
    };
    const read = () => {
      e.name = box.querySelector("#ve-name").value.trim(); e.becomes = box.querySelector("#ve-becomes").value.trim(); e.notes = box.querySelector("#ve-notes").value;
      const v = box.querySelector("#ve-shape").value;
      if (v.startsWith("model:")) { e.kind = "model"; e.model = v.slice(6); e.prim = null; } else { e.kind = "prim"; e.prim = v; e.model = null; }
      box.querySelectorAll("[data-lname]").forEach(el => { e.loras[+el.dataset.lname].name = el.value; });
      box.querySelectorAll("[data-lstr]").forEach(el => { e.loras[+el.dataset.lstr].strength = Math.max(0, Math.min(2, +el.value || 1)); });
    };
    draw();
    box.addEventListener("click", async ev => {
      const t = ev.target.closest("button"); if (!t) return;
      read();
      if (t.dataset.act === "addpic") return box.querySelector("#ve-files").click();
      if (t.dataset.act === "addvoice") return box.querySelector("#ve-voice").click();
      if (t.dataset.act === "rmvoice") { e.voice = null; return draw(); }
      if (t.dataset.rmpic != null) { e.pictures.splice(+t.dataset.rmpic, 1); return draw(); }
      if (t.dataset.act === "addlora" && loras.length) { e.loras.push({ name: loras[0].name, strength: 1 }); return draw(); }
      if (t.dataset.rmlora != null) { e.loras.splice(+t.dataset.rmlora, 1); return draw(); }
    });
    box.addEventListener("change", async ev => {
      if (ev.target.id === "ve-voice") {
        read();
        const f = ev.target.files[0]; if (!f) return;
        const fd = new FormData(); fd.append("file", f, f.name);
        try { const r = await fetch("/api/upload", { method: "POST", body: fd }); if (!r.ok) throw new Error(r.statusText); e.voice = (await r.json()).ref; }
        catch (err) { Media.toast(`Upload: ${err.message}`); }
        return draw();
      }
      if (ev.target.id !== "ve-files") return;
      read();
      for (const f of [...ev.target.files].slice(0, 9 - e.pictures.length)) {
        const fd = new FormData(); fd.append("file", f, f.name);
        try { const r = await fetch("/api/upload", { method: "POST", body: fd }); if (!r.ok) throw new Error(r.statusText); e.pictures.push((await r.json()).ref); }
        catch (err) { Media.toast(`Upload: ${err.message}`); }
      }
      draw();
    });
    const foot = document.createElement("div");
    foot.className = "wm-foot-row";
    foot.innerHTML = `${e0 ? `<button type="button" class="btn ghost danger" data-a="del">🗑 Delete</button>` : ""}<span class="grow"></span>
      <button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn primary" data-a="save">Save</button>`;
    const win = WM.open({ id: "v2-object", title: e0 ? `Object · ${e0.name}` : "New object", content: box, footer: foot, width: 520, height: 640, modal: true });
    foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
    foot.querySelector('[data-a="del"]')?.addEventListener("click", async () => {
      if (!confirm(`Delete “${e0.name}” from the library? Objects already in scenes stay there.`)) return;
      try { await api(`/api/v2/objects/${e0.id}`, { method: "DELETE" }); win.close(); await loadObjects(); } catch (err) { Media.toast(err.message); }
    });
    foot.querySelector('[data-a="save"]').onclick = async () => {
      read();
      if (!e.name) { box.querySelector("#ve-name").focus(); return Media.toast("Give it a name."); }
      try {
        await api(`/api/v2/objects/${e.id}`, { method: "PUT", body: JSON.stringify({ id: e.id, name: e.name, kind: e.kind, prim: e.prim, model: e.model, becomes: e.becomes, pictures: e.pictures, loras: e.loras, voice: e.voice || null, notes: e.notes }) });
        win.close(); await loadObjects(); renderPanel(true);
      } catch (err) { Media.toast(`Save: ${err.message}`); }
    };
    setTimeout(() => box.querySelector("#ve-name")?.focus(), 50);
  }

  /* ---- the camera library */
  async function loadCameras() {
    try { st.cams = (await api("/api/v2/cameras")).cameras || []; } catch { st.cams = []; }
    renderCameras();
  }
  function renderCameras() {
    const moves = Scene3D.CAM_MOVES || [];
    $("v2-camlist").innerHTML = moves.map(m => `<div class="v2-cam" role="listitem" tabindex="0" draggable="true" data-move="${esc(m.id)}" title="${esc(m.says)}">
        <span class="v2-camic">${m.icon}</span><span><b>${esc(m.name)}</b><span class="hint">${esc(m.says)}</span></span></div>`).join("")
      + (st.cams.length ? `<h3 class="v2-camh">Your cameras</h3>` + st.cams.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => `<div class="v2-cam" role="listitem" tabindex="0" draggable="true" data-saved="${esc(c.id)}" title="${esc(c.notes || c.name)}">
        <span class="v2-camic">💾</span><span><b>${esc(c.name)}</b><span class="hint">${c.keys.length} key${c.keys.length === 1 ? "" : "s"}${c.fx ? ` · ${esc(c.fx)}` : ""}${c.dof ? ` · f/${c.dof}` : ""}</span></span>
        <button type="button" class="v2-x" data-rmcam="${esc(c.id)}" aria-label="Delete ${esc(c.name)}" title="Delete this camera">✕</button></div>`).join("") : "");
  }
  function applyCam(el) {
    if (!Scene3D.current()) return Media.toast("Open a shot first: its camera is what changes.");
    const opts = { framing: $("v2-camframe").value, speed: $("v2-camspeed").value };
    let ok = false, name = "";
    if (el.dataset.move) { ok = Scene3D.applyCameraMove(el.dataset.move, opts); name = (Scene3D.CAM_MOVES.find(m => m.id === el.dataset.move) || {}).name; }
    else if (el.dataset.saved) { const c = st.cams.find(x => x.id === el.dataset.saved); ok = Scene3D.applySavedCamera(c); name = c?.name; }
    if (ok) { Media.toast(`Camera: ${name}. ↶ Undo in the scene takes it back.`); renderPanel(true); }
  }
  async function saveCamera() {
    const c = Scene3D.cameraOut();
    if (!c) return Media.toast("This shot's camera has no keys yet: key the camera in the scene, or use one of the moves.");
    const name = prompt("Name this camera", cur()?.name ? `${cur().name} camera` : "My camera");
    if (!name?.trim()) return;
    const id = uid();
    try {
      await api(`/api/v2/cameras/${id}`, { method: "PUT", body: JSON.stringify({ id, name: name.trim().slice(0, 80), keys: c.keys, fx: c.fx, dof: c.dof, h: c.h }) });
      await loadCameras();
      Media.toast(`Saved “${name.trim()}”: it's under Your cameras.`);
    } catch (e) { Media.toast(`Save camera: ${e.message}`); }
  }

  /* ---- drawing */
  /* The take a shot uses: the one picked in its takes; else, of the newest generation's takes (same prompt and
     model as the newest), the finished one whose words came out best (🗣, app/heard.py); else the newest. */
  const byWords = (a, b) => (b.heard?.score ?? -1) - (a.heard?.score ?? -1) || b.created - a.created;  // best words, then newest
  const autoTake = s => {
    const its = (s.results || []).map(id => state.items.get(id)).filter(Boolean);
    if (!its.length) return undefined;
    const top = its[0], heard = its.filter(x => x.engine === top.engine && x.params?.prompt === top.params?.prompt && x.status === "done" && x.heard?.score != null);
    return heard.length ? heard.sort(byWords)[0] : top;
  };
  const latest = s => { const pick = s.pick && (s.results || []).includes(s.pick) && state.items.get(s.pick); return pick || autoTake(s); };
  const tone = v => v == null ? "" : v >= 80 ? "s-good" : v >= 60 ? "s-ok" : "s-bad";
  // a shot's finished takes, best words first (then newest)
  const takesOf = s => (s.results || []).map(id => state.items.get(id)).filter(x => x && x.status === "done" && fileOf(x))
    .sort(byWords);
  const fileOf = it => it?.status === "done" ? (it.files || []).find(f => /^video\//.test(f.content_type || "")) || it.files?.[0] : null;
  const thumbOf = s => {
    const sc = st.scenes.get(s.scene) || {};
    return sc.plate_url || sc.picture_url || sc.backdrop_url || "";
  };
  const badge = it => !it ? "" : it.status === "done" ? "✓" : ["failed", "cancelled"].includes(it.status) ? "⚠" : "…";
  function renderShots() {
    const box = $("v2-shotlist");
    $("v2-noshots").hidden = st.board.shots.length > 0;
    box.innerHTML = st.board.shots.map((s, i) => {
      const d = decide(s), it = latest(s), f = fileOf(it), th = thumbOf(s);
      return `<div class="v2-shot${s.id === st.sel ? " sel" : ""}" role="option" aria-selected="${s.id === st.sel}" tabindex="0" data-id="${esc(s.id)}">
        <div class="v2-th">${f ? `<video src="${esc(f.url)}" muted preload="metadata"></video>` : th ? `<img src="${esc(th)}" alt="">` : `<span>${i + 1}</span>`}</div>
        <div class="v2-sm"><b>${i + 1}. ${esc(s.name)}</b><span class="hint">${d.info.seconds.toFixed(1)} s · ${d.engine === "h3" ? "text" : d.ref ? "H3 Reference" : "3D render"}${it ? ` · ${badge(it)} ${esc(it.status)}` : ""}</span></div>
        <button type="button" class="v2-x" data-x="${esc(s.id)}" title="Remove this shot" aria-label="Remove ${esc(s.name)}">✕</button></div>`;
    }).join("");
  }
  // Where each shot sits: its start on the timeline (after the overlap of a transition), the part of its video used.
  function layout() {
    const L = st.board.shots; let end = 0;
    return L.map((s, i) => { const p = pieceOf(s), start = i ? Math.max(0, end - joinOf(L[i - 1], i - 1, L)) : 0; end = start + p.d; return { s, i, start, p }; });
  }
  const camKeysOf = s => { const c = Scene3D.current(); return (c && c.id === s.scene ? c.camKeys : st.scenes.get(s.scene)?.camera_keys) || []; };
  const LABEL = 96;
  function renderTimeline() {
    const box = $("v2-tracks"), shots = st.board.shots, L = layout(), T = Math.max(1, totalSeconds());
    $("v2-total").textContent = shots.length ? `${shots.length} shot${shots.length === 1 ? "" : "s"} · ${fmtT(totalSeconds())}` : "";
    $("v2-tlunits").textContent = tlUI.units === "f" ? "f" : "s";
    if (st.tlv === "log" || tlUI.fold) return;
    const fitW = Math.max(200, ($("v2-tlbody").clientWidth || 800) - LABEL - 16), pps = fitW / T * 2 ** tlUI.z, W = Math.ceil(T * pps);
    st.pps = pps; st.layout = L;
    const x = t => `${(t * pps).toFixed(1)}px`, w = d => `${Math.max(2, d * pps).toFixed(1)}px`;
    const steps = tlUI.units === "f" ? [1, 2, 6, 12, 24, 48, 120, 240, 480, 1440].map(f => f / 24) : [0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find(v => v * pps >= 46) || steps.at(-1);
    const ticks = [];
    for (let i = 0, t = 0; t <= T + 1e-6; t = ++i * step) ticks.push(`<span class="v2-tick" style="left:${x(t)}">${tlUI.units === "f" ? Math.round(t * 24) : t % 1 ? t.toFixed(1) : t}${tlUI.units === "f" ? "" : "s"}</span>`);
    // markers: a flag on the ruler, a line down the layers
    const marks = markers().map(m => `<span class="v2-mark" data-m="${esc(m.id)}" style="left:${x(m.t)}" title="${esc(m.label || "Marker")} · ${fmtT(m.t, 2)}\nDrag to move · double-click to name · right-click for more">🚩${m.label ? ` ${esc(m.label)}` : ""}</span>`).join("");
    const markLines = markers().map(m => `<div class="v2-markline" style="left:calc(${LABEL}px + ${x(m.t)})"></div>`).join("");
    const tname = s => document.querySelector(`#v2-trans option[value="${s.transition}"]`)?.textContent || s.transition;
    // 🎥 camera: each shot's keys inside the part of its video used; a line between keys where it moves
    const cam = L.map(({ s, start, p }) => {
      const K = camKeysOf(s), inside = K.filter(k => k.t >= p.a - 1e-3 && k.t <= p.b + 1e-3);
      const moves = K.length > 1 && K.some(k => Math.abs(k.yaw - K[0].yaw) + Math.abs(k.pitch - K[0].pitch) + Math.abs(k.dist - K[0].dist) + Math.abs((k.lens || 0) - (K[0].lens || 0)) > 1e-3);
      const lens = K.some(k => k.lens && Math.abs(k.lens - (K[0].lens || k.lens)) > 0.5);
      return `<div class="v2-camseg${s.id === st.sel ? " sel" : ""}" data-cam="${esc(s.id)}" style="left:${x(start)};width:${w(p.d)}" title="${esc(s.name)}: ${K.length} camera key${K.length === 1 ? "" : "s"}${moves ? ", moving" : ", holding still"}${lens ? ", zooming" : ""}">
          ${moves && inside.length > 1 ? `<i class="v2-camline" style="left:${x(inside[0].t - p.a)};width:${w(inside.at(-1).t - inside[0].t)}"></i>` : ""}
          ${inside.map(k => `<b class="v2-key${k.ease ? " ease" : ""}${openOf(s) ? " edit" : ""}" data-k="${K.indexOf(k)}" style="left:${x(k.t - p.a)}" title="${k.t.toFixed(2)} s · frame ${Math.round(k.t * 24)}${k.lens ? ` · ${Math.round(k.lens)} mm` : ""}${k.shake ? ` · shake ${k.shake}%` : ""}${k.ease ? ` · ${esc(Scene3D.camEdit.EASES[k.ease] || "eased")}` : ""}${openOf(s) ? "\nDrag to retime · right-click for more" : "\nClick to open this shot"}">◆</b>`).join("")}
          <span class="v2-camtxt">${!K.length ? "no camera keys" : moves ? `${lens ? "zoom · " : ""}${inside.length} keys` : "still"}</span></div>`;
    }).join("");
    // 🎞 video: the shots, a transition where two overlap
    const vid = L.map(({ s, i, start, p }) => {
      const it = latest(s), j = i < L.length - 1 ? joinOf(s, i, shots) : 0, th = thumbOf(s);
      return `<div class="v2-clip${s.id === st.sel ? " sel" : ""}${it?.status === "done" ? " done" : ""}" draggable="true" data-id="${esc(s.id)}" style="left:${x(start)};width:${w(p.d)}" title="${esc(s.name)} · ${p.d.toFixed(1)} s${p.a ? ` (from ${p.a.toFixed(1)} s in)` : ""}">
          ${th ? `<img src="${esc(th)}" alt="" loading="lazy">` : ""}<span class="v2-cliptx"><b>${i + 1}</b> ${esc(s.name)}</span><span class="v2-clipd">${fmtT(p.d)} ${badge(it)}</span></div>`
        + (j ? `<div class="v2-trans" style="left:${x(start + p.d - j)};width:${w(j)}" title="${esc(tname(s))}, ${j.toFixed(1)} s">⧖</div>` : "");
    }).join("");
    // 🗣 sound: each shot's lines and background sound
    const snd = L.map(({ s, start, p }) => {
      const lines = linesOf(s).filter(l => String(l.text || "").trim());
      return `<div class="v2-sndseg" data-id="${esc(s.id)}" style="left:${x(start)};width:${w(p.d)}" title="${esc([s.sound, ...lines.map(l => `${l.speaker || "Someone"}: ${l.text}`)].filter(Boolean).join("\n") || "No sound described")}">
          ${lines.map(l => `<span class="v2-line-chip">🗣 ${esc(l.speaker || "Someone")}: ${esc(l.text)}</span>`).join("")}${s.sound ? `<span class="v2-amb">${esc(s.sound)}</span>` : ""}</div>`;
    }).join("");
    // 🎵 music: the soundtrack under it all
    const t = st.board.settings.soundtrack, mit = t?.result && state.items.get(t.result), mf = mit?.status === "done" ? mit.files?.[0] : null;
    const mus = t?.style ? `<div class="v2-musclip${t.on ? "" : " off"}" style="left:0;width:${w(Math.min(T, +t.seconds || T))}">
          <button type="button" class="v2-tlmb" data-a="music" title="Edit the soundtrack">🎵 ${esc(t.style.slice(0, 80))}${t.on ? "" : " (off)"}</button>
          ${mf ? `<audio controls src="${esc(mf.url)}"></audio>` : `<span class="hint">${mit ? `${esc(mit.status)}…` : "not made yet"}</span>`}</div>`
      : `<button type="button" class="v2-tlmb v2-musadd" data-a="music" style="left:0">🎵 Add a soundtrack…</button>`;
    box.style.setProperty("--tlw", `${W}px`);
    box.innerHTML = !shots.length ? `<p class="hint v2-tlnone">Shots line up here in order, with their camera, sound and music.</p>` : `
      <div class="v2-trow v2-ruler"><span class="v2-tlab" title="Click or drag along the ruler to move the play line; right-click to add a marker">${tlUI.units === "f" ? "frames" : "seconds"}</span><div class="v2-lane">${ticks.join("")}${marks}</div></div>
      <div class="v2-trow v2-tcam"><span class="v2-tlab" title="Each shot's camera keys">🎥 Camera</span><div class="v2-lane">${cam}</div></div>
      ${objRows(L, x, w)}
      <div class="v2-trow v2-tvid"><span class="v2-tlab" title="The shots, in order; drag one to move it">🎞 Video</span><div class="v2-lane">${vid}</div></div>
      <div class="v2-trow v2-tsnd"><span class="v2-tlab" title="Each shot's dialogue and background sound">🗣 Sound</span><div class="v2-lane">${snd}</div></div>
      <div class="v2-trow v2-tmus"><span class="v2-tlab" title="One piece of music under every shot">🎵 Music</span><div class="v2-lane">${mus}</div></div>
      ${markLines}
      <div class="v2-playhead" id="v2-playhead" hidden></div>`;
    placePlayhead();
  }
  const openOf = s => Scene3D.current()?.id === s.scene;
  // The open shot's objects, a row each: their keys (where each was keyed) inside the shot, a line where it moves.
  function objRows(L, x, w) {
    const c = Scene3D.current(), at = L.find(q => q.s.scene === c?.id); if (!c || !at) return "";
    const { s, start, p } = at;
    return c.objs.map((o, i) => [o, i]).filter(([o]) => o.mesh && o.pos && !o.hidden).map(([o, i]) => {
      const K = o.keys || [], inside = K.filter(k => k.t >= p.a - 1e-3 && k.t <= p.b + 1e-3);
      const moves = K.length > 1;
      return `<div class="v2-trow v2-tobj${i === c.sel ? " sel" : ""}"><span class="v2-tlab" title="${esc(o.name)}: ${K.length ? `${K.length} keys` : "where it stands (no keys)"}">↳ ${esc(o.name)}</span><div class="v2-lane">
          <div class="v2-objseg" data-obj="${i}" data-shot="${esc(s.id)}" style="left:${x(start)};width:${w(p.d)}" title="${esc(o.name)}: double-click to key it here; right-click for more">
            ${moves && inside.length > 1 ? `<i class="v2-objline" style="left:${x(inside[0].t - p.a)};width:${w(inside.at(-1).t - inside[0].t)}"></i>` : ""}
            ${inside.map(k => `<b class="v2-okey${k.ease ? " ease" : ""}" data-o="${i}" data-k="${K.indexOf(k)}" style="left:${x(k.t - p.a)}" title="${k.t.toFixed(2)} s · frame ${Math.round(k.t * 24)}${k.ease ? ` · ${esc(Scene3D.camEdit.EASES[k.ease] || "eased")}` : ""}\nDrag to retime · right-click for more">◆</b>`).join("")}
            ${!K.length ? `<span class="v2-camtxt">no keys: it stays where it is</span>` : ""}</div></div></div>`;
    }).join("");
  }
  // The playhead: the open shot's time, where that shot sits on the timeline.
  // the play line follows playback smoothly (started by init: the scene builder loads after this file)
  function follow() { if (st.tlv === "tl" && !tlUI.fold) placePlayhead(); requestAnimationFrame(follow); }
  function placePlayhead() {
    const ph = $("v2-playhead"), c = Scene3D.current(); if (!ph) return;
    const L = st.layout?.find(q => q.s.scene === c?.id);
    if (!c || !L || st.tlv !== "tl") { ph.hidden = true; return; }
    const t = Math.max(L.p.a, Math.min(L.p.b, c.t));
    ph.hidden = false; ph.style.left = `calc(${LABEL}px + ${((L.start + t - L.p.a) * st.pps).toFixed(1)}px)`;
  }
  // A point on the timeline (clientX) -> {L: the shot under it, t: that shot's own time}.
  function timeAt(clientX) {
    const lane = document.querySelector("#v2-tracks .v2-lane"); if (!lane || !st.layout) return null;
    const T = (clientX - lane.getBoundingClientRect().left) / st.pps;
    const L = st.layout.slice().reverse().find(q => T >= q.start - 1e-6) || st.layout[0];
    return L ? { L, t: Math.max(L.p.a, Math.min(L.p.b, L.p.a + T - L.start)) } : null;
  }
  // The play line on the whole timeline (the open shot's time where that shot sits), or null.
  function playGlobal() {
    const c = Scene3D.current(), L = st.layout?.find(q => q.s.scene === c?.id);
    return c && L ? L.start + Math.max(L.p.a, Math.min(L.p.b, c.t)) - L.p.a : null;
  }
  const globalAt = clientX => { const lane = document.querySelector("#v2-tracks .v2-lane"); return lane ? Math.max(0, (clientX - lane.getBoundingClientRect().left) / st.pps) : 0; };
  async function goGlobal(T) {
    const L = st.layout?.slice().reverse().find(q => T >= q.start - 1e-6) || st.layout?.[0]; if (!L) return;
    await openAt(L); Scene3D.camEdit.seek(Math.max(L.p.a, Math.min(L.p.b, L.p.a + T - L.start))); placePlayhead();
  }
  function addMarker(T) {
    const n = markers().length + 1;
    markers().push({ id: uid(), t: Math.round(T * 24) / 24, label: `Marker ${n}` }); markers().sort((a, b) => a.t - b.t);
    save(); renderTimeline();
  }
  function nameMarker(m) {
    const v = prompt("Name this marker", m.label || ""); if (v == null) return;
    m.label = v.trim().slice(0, 60); save(); renderTimeline();
  }
  async function openAt(L) { if (!openOf(L.s)) { await openShot(L.s.id); for (let k = 0; k < 40 && !openOf(L.s); k++) await new Promise(r => setTimeout(r, 100)); } }
  // The camera layer: drag a key to retime it, click it to go there, double-click to add one, right-click for more.
  function wireCamLayer(tr) {
    tr.addEventListener("pointerdown", e => {
      const ok = e.target.closest(".v2-okey"); if (!ok || e.button !== 0) return;
      const at = st.layout.find(q => openOf(q.s)), c = Scene3D.current(); if (!at || !c) return;
      e.preventDefault(); e.stopPropagation();
      const i = +ok.dataset.o, k = +ok.dataset.k, t0 = c.objs[i]?.keys?.[k]?.t ?? 0, x0 = e.clientX, L = at;
      let t = t0, moved = false;
      ok.setPointerCapture(e.pointerId); ok.classList.add("drag");
      const mv = ev => {
        const dx = ev.clientX - x0; if (Math.abs(dx) > 3) moved = true;
        t = Math.max(L.p.a, Math.min(L.p.b, Math.round((t0 + dx / st.pps) * 24) / 24));
        ok.style.left = `${((t - L.p.a) * st.pps).toFixed(1)}px`; ok.title = `${t.toFixed(2)} s · frame ${Math.round(t * 24)}`;
      };
      const up = () => {
        ok.removeEventListener("pointermove", mv); ok.removeEventListener("pointerup", up); ok.classList.remove("drag");
        if (moved && Math.abs(t - t0) > 1e-3) Scene3D.objEdit.move(i, k, t);
        Scene3D.select(i); Scene3D.camEdit.seek(moved ? t : t0);
        renderTimeline();
      };
      ok.addEventListener("pointermove", mv); ok.addEventListener("pointerup", up);
    });
    tr.addEventListener("dblclick", e => {
      const seg = e.target.closest("[data-obj]"); if (!seg || e.target.closest(".v2-okey")) return;
      const at = timeAt(e.clientX); if (!at || !openOf(at.L.s)) return;
      if (Scene3D.objEdit.add(+seg.dataset.obj, at.t)) Media.toast(`Key at ${at.t.toFixed(2)} s: move, turn or size it there (its gizmo or details) to make it move.`);
      renderTimeline();
    });
    tr.addEventListener("contextmenu", e => {
      const seg = e.target.closest("[data-obj]"); if (!seg) return;
      e.preventDefault(); e.stopPropagation();
      const at = timeAt(e.clientX); if (!at || !openOf(at.L.s)) return;
      const i = +seg.dataset.obj, ok = e.target.closest(".v2-okey"), o = Scene3D.current().objs[i];
      if (ok) {
        const k = +ok.dataset.k, q = o.keys[k], last = k === o.keys.length - 1, E = Scene3D.camEdit.EASES;
        return Media.menu(e.clientX, e.clientY, [
          [`◆ Go to this key (${q.t.toFixed(2)} s)`, () => { Scene3D.select(i); Scene3D.camEdit.seek(q.t); }],
          null,
          ...(last ? [] : [
            [`${!q.ease ? "● " : ""}Steady to the next key`, () => { Scene3D.objEdit.ease(i, k, null); renderTimeline(); }],
            ...Object.entries(E).map(([v, label]) => [`${q.ease === v ? "● " : ""}${label}`, () => { Scene3D.objEdit.ease(i, k, v); renderTimeline(); }]),
            null]),
          [`🗑 Delete this key${o.keys.length <= 2 ? ` (${o.name} then stays still)` : ""}`, () => { Scene3D.objEdit.remove(i, k); renderTimeline(); }],
        ]);
      }
      Media.menu(e.clientX, e.clientY, [
        [`◆ Key ${o.name} here (${at.t.toFixed(2)} s)`, () => { Scene3D.objEdit.add(i, at.t); renderTimeline(); }],
        [`🧱 ${o.name}'s details`, () => { Scene3D.select(i); Scene3D.camEdit.seek(at.t); }],
      ]);
    });
    tr.addEventListener("click", e => {
      const seg = e.target.closest("[data-obj]"); if (!seg || e.target.closest(".v2-okey")) return;
      const at = timeAt(e.clientX); if (at && openOf(at.L.s)) { Scene3D.select(+seg.dataset.obj); Scene3D.camEdit.seek(at.t); }
    });
    tr.addEventListener("pointerdown", e => {
      const key = e.target.closest(".v2-key"); if (!key || e.button !== 0) return;
      const seg = key.closest("[data-cam]"), s = shotOf(seg.dataset.cam); if (!s) return;
      e.preventDefault(); e.stopPropagation();
      if (!openOf(s)) { openAt(st.layout.find(q => q.s === s)).then(() => Scene3D.selectCam()); return; }
      const L = st.layout.find(q => q.s === s), i = +key.dataset.k, K = camKeysOf(s), t0 = K[i]?.t ?? 0, x0 = e.clientX;
      let t = t0, moved = false;
      key.setPointerCapture(e.pointerId); key.classList.add("drag");
      const mv = ev => {
        const dx = ev.clientX - x0; if (Math.abs(dx) > 3) moved = true;
        t = Math.max(L.p.a, Math.min(L.p.b, Math.round((t0 + dx / st.pps) * 24) / 24));
        key.style.left = `${((t - L.p.a) * st.pps).toFixed(1)}px`; key.title = `${t.toFixed(2)} s · frame ${Math.round(t * 24)}`;
      };
      const up = () => {
        key.removeEventListener("pointermove", mv); key.removeEventListener("pointerup", up); key.classList.remove("drag");
        if (moved && Math.abs(t - t0) > 1e-3) Scene3D.camEdit.move(i, t);
        Scene3D.selectCam(); Scene3D.camEdit.seek(moved ? t : t0);
        renderTimeline();
      };
      key.addEventListener("pointermove", mv); key.addEventListener("pointerup", up);
    });
    tr.addEventListener("dblclick", async e => {
      const seg = e.target.closest("[data-cam]"); if (!seg || e.target.closest(".v2-key")) return;
      const at = timeAt(e.clientX); if (!at) return;
      await openAt(at.L);
      if (Scene3D.camEdit.add(at.t)) { Scene3D.selectCam(); Media.toast(`Camera key at ${at.t.toFixed(2)} s: change the camera there (its arrows and rings, or the details) to move it.`); }
      renderTimeline();
    });
    tr.addEventListener("contextmenu", async e => {
      const seg = e.target.closest("[data-cam]"); if (!seg) return;
      e.preventDefault();
      const at = timeAt(e.clientX); if (!at) return;
      const key = e.target.closest(".v2-key"), s = at.L.s;
      if (key && openOf(s)) {
        const i = +key.dataset.k, k = camKeysOf(s)[i], last = i === camKeysOf(s).length - 1, E = Scene3D.camEdit.EASES;
        Media.menu(e.clientX, e.clientY, [
          [`◆ Go to this key (${k.t.toFixed(2)} s)`, () => { Scene3D.selectCam(); Scene3D.camEdit.seek(k.t); }],
          null,
          ...(last ? [] : [
            [`${!k.ease ? "● " : ""}Steady to the next key`, () => { Scene3D.camEdit.ease(i, null); renderTimeline(); }],
            ...Object.entries(E).map(([v, label]) => [`${k.ease === v ? "● " : ""}${label}`, () => { Scene3D.camEdit.ease(i, v); renderTimeline(); }]),
            null]),
          ["🗑 Delete this key", () => { Scene3D.camEdit.remove(i); renderTimeline(); }],
        ]);
        return;
      }
      Media.menu(e.clientX, e.clientY, [
        [`◆ Key the camera here (${at.t.toFixed(2)} s)`, async () => { await openAt(at.L); Scene3D.camEdit.add(at.t); Scene3D.selectCam(); renderTimeline(); }],
        ["🎥 The camera's details", async () => { await openAt(at.L); Scene3D.selectCam(); Scene3D.camEdit.seek(at.t); }],
      ]);
    });
    // the ruler: press or drag along it to move the play line (scrubbing the open shot; another shot opens on release)
    tr.addEventListener("pointerdown", async e => {
      const ruler = e.target.closest(".v2-ruler"); if (!ruler || e.button !== 0 || e.target.closest(".v2-mark")) return;
      e.preventDefault();
      const lane = ruler.querySelector(".v2-lane"); lane.setPointerCapture(e.pointerId);
      let last = timeAt(e.clientX);
      if (last) { await openAt(last.L); Scene3D.camEdit.seek(last.t); placePlayhead(); }
      const mv = ev => { const at = timeAt(ev.clientX); if (!at) return; last = at; if (openOf(at.L.s)) { Scene3D.camEdit.seek(at.t); placePlayhead(); } };
      const up = async () => { lane.removeEventListener("pointermove", mv); lane.removeEventListener("pointerup", up); if (last && !openOf(last.L.s)) { await openAt(last.L); Scene3D.camEdit.seek(last.t); } };
      lane.addEventListener("pointermove", mv); lane.addEventListener("pointerup", up);
    });
    tr.addEventListener("contextmenu", e => {
      const ruler = e.target.closest(".v2-ruler"); if (!ruler) return;
      e.preventDefault();
      const mk = e.target.closest(".v2-mark"), T = globalAt(e.clientX);
      if (mk) {
        const m = markers().find(q => q.id === mk.dataset.m); if (!m) return;
        return Media.menu(e.clientX, e.clientY, [
          [`▶ Go to this marker (${fmtT(m.t, 2)})`, () => goGlobal(m.t)],
          ["✎ Name it…", () => nameMarker(m)],
          ["🗑 Delete this marker", () => { st.board.settings.markers = markers().filter(q => q !== m); save(); renderTimeline(); }],
        ]);
      }
      Media.menu(e.clientX, e.clientY, [
        [`🚩 Add a marker here (${fmtT(T, 2)})`, () => addMarker(T)],
        [`▶ Move the play line here`, () => goGlobal(T)],
      ]);
    });
    tr.addEventListener("dblclick", e => { const mk = e.target.closest(".v2-mark"); if (mk) { const m = markers().find(q => q.id === mk.dataset.m); if (m) nameMarker(m); } });
    tr.addEventListener("pointerdown", e => {  // drag a marker along the ruler
      const mk = e.target.closest(".v2-mark"); if (!mk || e.button !== 0) return;
      const m = markers().find(q => q.id === mk.dataset.m); if (!m) return;
      e.preventDefault(); e.stopPropagation(); mk.setPointerCapture(e.pointerId);
      const x0 = e.clientX, t0 = m.t; let moved = false;
      const mv = ev => { const dx = ev.clientX - x0; if (Math.abs(dx) > 3) moved = true; m.t = Math.max(0, Math.min(totalSeconds(), Math.round((t0 + dx / st.pps) * 24) / 24)); mk.style.left = `${(m.t * st.pps).toFixed(1)}px`; };
      const up = () => { mk.removeEventListener("pointermove", mv); mk.removeEventListener("pointerup", up); if (moved) save(); else goGlobal(m.t); renderTimeline(); };
      mk.addEventListener("pointermove", mv); mk.addEventListener("pointerup", up);
    });
    // the mouse wheel over the timeline zooms about the cursor (Shift+wheel scrolls it sideways)
    $("v2-tlbody").addEventListener("wheel", e => {
      if (e.shiftKey || e.ctrlKey || !st.layout?.length) return;
      e.preventDefault();
      const body = $("v2-tlbody"), cx = e.clientX - body.getBoundingClientRect().left, T = (body.scrollLeft + cx - LABEL) / st.pps;
      const z = Math.max(0, Math.min(6, tlUI.z + (e.deltaY < 0 ? 0.25 : -0.25))); if (z === tlUI.z) return;
      tlUI.z = z; saveTlUI(); renderTimeline();
      body.scrollLeft = Math.max(0, LABEL + T * st.pps - cx);
    }, { passive: false });
    // M adds a marker at the play line (not while typing)
    document.addEventListener("keydown", e => {
      if (e.key.toLowerCase() !== "m" || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable) return;
      if (!document.querySelector(".v2-tl")?.matches(":hover") && !document.querySelector("#v2-view")?.contains(document.activeElement)) return;
      e.preventDefault(); addMarker(playGlobal() ?? 0);
    });
  }
  function renderPanel(keepFocus = false) {
    const s = cur();
    $("v2-form").hidden = !s;
    $("v2-shot-title").textContent = s ? s.name : "Shot";
    if (!s) return;
    const d = decide(s);
    const DEF = { quality: "standard", transition: "cut" };
    for (const [id, k] of [["v2-name", "name"], ["v2-setting", "setting"], ["v2-action", "action"], ["v2-sound", "sound"], ["v2-music", "music"], ["v2-quality", "quality"],
      ["v2-tin", "trim_in"], ["v2-tout", "trim_out"], ["v2-trans", "transition"], ["v2-tlen", "tlen"]]) {
      const el = $(id); if (!(keepFocus && document.activeElement === el)) el.value = s[k] ?? DEF[k] ?? "";
    }
    const names = d.info.names;
    $("v2-tags").innerHTML = names.map(n => `<button type="button" class="chip-btn" data-tag="${esc(n)}" title="Put {${esc(n)}} in">${esc(n)}</button>`).join("");
    renderLines(s, names);
    renderShotLoras(s);
    $("v2-len").textContent = `${d.info.seconds.toFixed(1)} s${d.info.live ? " (the scene's length: set it under the scene's timeline)" : ""}`;
    $("v2-model").innerHTML = `<div class="v2-mh"><span>Model</span><b>${esc(d.label)}</b><span class="v2-auto">auto</span></div><ul>${d.why.map(w => `<li>${esc(w)}</li>`).join("")}</ul>`;
    const busy = st.busy.has(s.id);
    $("v2-gen").disabled = busy;
    $("v2-gen").textContent = busy ? "Working…" : "🎬 Generate shot";
    $("v2-say").textContent = st.say.get(s.id) || "";
    showStages();
    $("v2-takes").value = String(Math.min(4, Math.max(1, +s.takes || 1)));
    const it = latest(s), f = fileOf(it), box = $("v2-result"), takes = takesOf(s);
    const want = it ? `${it.id}:${it.status}:${it.heard?.score ?? ""}:${st.hearing.has(it.id)}:${takes.map(x => `${x.id}${x.heard?.score ?? ""}`).join(",")}:${s.pick || ""}` : "";
    if (box.dataset.k !== want) {
      box.dataset.k = want;
      const h = it?.heard, lines = it && /<d>[\s\S]*?<\/d>/.test(it.params?.prompt || "");
      const best = autoTake(s);  // ★: the take the shot uses unless one is picked
      box.innerHTML = !it ? "" : f ? `<video src="${esc(f.url)}" controls preload="metadata"></video>
        <p class="hint">${it.engine === "retake" ? "Retaken sound · " : ""}${takes.length > 1 ? `Take: seed ${it.seed}${s.pick ? " (picked)" : best?.id === it.id ? " (best words)" : ""} · ` : ""}made ${new Date((it.finished || it.created) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
        ${h?.score != null ? `<p class="v2-words"><b class="${tone(h.score)}">🗣 ${h.score}%</b> of the lines said as written · heard: ${h.heard ? `“${esc(h.heard)}”` : "<i>nothing</i>"}${h.extra ? ` <span class="warn">(${h.extra} word${h.extra > 1 ? "s" : ""} more than the lines)</span>` : ""}</p>` : ""}
        ${takes.length > 1 ? `<div class="v2-takes" role="listbox" aria-label="Takes, best words first"><span class="hint">Takes, best words first: pick the one the shot uses</span>${takes.map(x =>
          `<button type="button" class="v2-take${x.id === it.id ? " on" : ""}" data-take="${esc(x.id)}" aria-selected="${x.id === it.id}">${best?.id === x.id ? "★ " : ""}${x.engine === "retake" ? `retake ${x.seed}` : x.engine === "enhance" ? "✨ enhanced" : `seed ${x.seed}`}${x.heard?.score != null ? ` <b class="${tone(x.heard.score)}">${x.heard.score}%</b>` : ""}</button>`).join("")}</div>` : ""}
        <div class="v2-resact">${lines ? `<button type="button" class="btn sm" data-hear ${st.hearing.has(it.id) ? "disabled" : ""} title="Whisper hears the lines; the score is how much of them was said as written">${st.hearing.has(it.id) ? "🗣 Checking…" : h ? "🗣 Check the words again" : "🗣 Check the words"}</button>` : ""}
          <button type="button" class="btn sm" data-retake title="Make the sound again from the prompt (H3 Reference): all of it or some stretches, the picture kept exactly; the takes land on this shot">🔁 Retake the sound…</button>
          ${it.engine !== "enhance" ? `<button type="button" class="btn sm" data-enhance title="FaceRefine, DLSS 5, SeedVR2 or RelayVSR: the enhanced video becomes the shot's take">✨ Enhance…</button>` : ""}</div>`
        : `<p class="hint">${it.status === "failed" ? `⚠ Failed: ${esc(it.error || "")}` : `${esc(it.status)}…`}</p>`;
      box.querySelectorAll("[data-take]").forEach(b => b.onclick = () => { s.pick = b.dataset.take; save(); renderAll(); });
      box.querySelector("[data-hear]")?.addEventListener("click", () => hear(it));
      box.querySelector("[data-retake]")?.addEventListener("click", () => retakeDialog(s, it));
      box.querySelector("[data-enhance]")?.addEventListener("click", () => Enhance.dialog(it, { onRun: v => enhanceTake(it, v) }));
    }
  }
  // The dialogue lines (kept as they are while one is being typed in).
  function renderLines(s, names) {
    const box = $("v2-lines");
    if (box.contains(document.activeElement) && box.dataset.shot === s.id) return;
    box.dataset.shot = s.id;
    box.innerHTML = linesOf(s).map((l, k) => {
      const v = l.speaker && libOf(s, l.speaker)?.voice;
      return `<div class="v2-line"><select data-lsp="${k}" aria-label="Who says line ${k + 1}"><option value="">Someone</option>${[...new Set([...names, l.speaker].filter(Boolean))].map(n => `<option value="${esc(n)}"${n === l.speaker ? " selected" : ""}>${esc(n)}${n === l.speaker && v ? " 🗣" : ""}</option>`).join("")}</select>
        <input data-ltx="${k}" maxlength="300" value="${esc(l.text || "")}" placeholder="Come on in, the water's warm!" aria-label="Line ${k + 1}">
        <button type="button" class="v2-x" data-lrm="${k}" aria-label="Remove line ${k + 1}" title="Remove this line">✕</button></div>`;
    }).join("");
  }
  function renderAll() { renderShots(); renderTimeline(); renderPanel(true); renderSoundtrack(); renderExport(); renderLog(); }

  /* ---- wiring */
  function wire() {
    $("v2-new").onclick = newMenu;
    // narrow windows (v2.css): the library tabs open a drawer, 📝 Shot opens the shot panel as a drawer
    const main = document.querySelector(".v2-main"), narrow = () => matchMedia("(max-width: 1180px)").matches;
    const setRight = on => { main.classList.toggle("right-open", on); $("v2-paneltoggle").setAttribute("aria-expanded", String(on)); if (on) main.classList.remove("left-open"); };
    $("v2-paneltoggle").onclick = () => setRight(!main.classList.contains("right-open"));
    document.querySelectorAll(".v2-tabs [data-tab]").forEach(b => b.addEventListener("click", () => {
      if (!narrow()) return;
      const again = b.classList.contains("on") && main.classList.contains("left-open");
      main.classList.toggle("left-open", !again);
      if (!again) setRight(false);
    }));
    // a click in the viewport or timeline closes a drawer; so do Esc and picking a shot
    document.querySelector(".v2-view").addEventListener("pointerdown", e => { if (narrow() && !e.target.closest(".s3-side")) { main.classList.remove("left-open"); setRight(false); } });
    document.querySelector(".v2-tl").addEventListener("pointerdown", () => { if (narrow()) main.classList.remove("left-open"); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && narrow() && !document.querySelector(".wm-win")) { main.classList.remove("left-open"); setRight(false); } });
    $("v2-shotlist").addEventListener("click", e => { if (narrow() && e.target.closest(".v2-shot") && !e.target.closest("[data-x]")) main.classList.remove("left-open"); });
    // the inspector's V2 part (inside the scene builder's properties)
    const host = $("v2-view");
    host.addEventListener("click", e => { if (e.target.closest(".v2-objx")) objxClick(e); });
    host.addEventListener("input", e => {
      const s = cur(), k = e.target.dataset.xl; if (!s || k == null) return;
      linesOf(s)[+k].text = e.target.value; save(); $("v2-lines").dataset.shot = ""; renderPanel(true);
    });
    host.addEventListener("change", e => {
      const t = e.target, xl = t.dataset.xlname ?? t.dataset.xlstr;
      if (xl != null && t.closest(".v2-objx")) {  // the selected object's LoRAs
        const c = Scene3D.current(), o = c && c.sel >= 0 ? c.objs[c.sel] : null, lib = o?.lib && st.objs.find(y => y.id === o.lib);
        if (lib) { t.blur(); libLoras(lib, ls => { const l = ls[+xl]; if (!l) return; if (t.dataset.xlname != null) l.name = t.value; else l.strength = Math.max(0, Math.min(2, +t.value || 1)); }); }
        return;
      }
      if (e.target.id !== "v2-oname") return;
      const c = Scene3D.current(); if (c && c.sel >= 0) Scene3D.rename(c.sel, e.target.value);
    });
    // the library tabs
    document.querySelectorAll(".v2-tabs [data-tab]").forEach(b => b.onclick = () => {
      document.querySelectorAll(".v2-tabs [data-tab]").forEach(x => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-selected", String(on)); });
      document.querySelectorAll(".v2-pane").forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    });
    // the camera library: click or drag onto the viewport to apply; save this shot's; delete a saved one
    $("v2-camsave").onclick = saveCamera;
    const cl = $("v2-camlist");
    cl.addEventListener("click", async e => {
      const rm = e.target.closest("[data-rmcam]");
      if (rm) { const c = st.cams.find(x => x.id === rm.dataset.rmcam); if (c && confirm(`Delete the camera “${c.name}”?`)) { try { await api(`/api/v2/cameras/${c.id}`, { method: "DELETE" }); await loadCameras(); } catch (err) { Media.toast(err.message); } } return; }
      const el = e.target.closest(".v2-cam"); if (el) applyCam(el);
    });
    cl.addEventListener("keydown", e => { const el = e.target.closest(".v2-cam"); if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); applyCam(el); } });
    cl.addEventListener("dragstart", e => { const el = e.target.closest(".v2-cam"); if (!el) return; e.dataTransfer.setData("text/x-bob-cam", el.dataset.move ? `move:${el.dataset.move}` : `saved:${el.dataset.saved}`); e.dataTransfer.effectAllowed = "copy"; });
    // the object library: new, find, edit, add, drag onto the viewport
    $("v2-objnew").onclick = () => objectEditor();
    $("v2-objq").addEventListener("input", renderObjects);
    const grid = $("v2-objgrid");
    grid.addEventListener("click", e => { const a = e.target.closest("[data-add]"); if (a) return place(a.dataset.add);
      const ed = e.target.closest("[data-edit]"); if (ed) objectEditor(st.objs.find(x => x.id === ed.dataset.edit)); });
    grid.addEventListener("dblclick", e => { const c = e.target.closest(".v2-obj"); if (c && !e.target.closest("[data-add], [data-edit]")) objectEditor(st.objs.find(x => x.id === c.dataset.oid)); });
    grid.addEventListener("keydown", e => { const c = e.target.closest(".v2-obj"); if (c && e.key === "Enter") objectEditor(st.objs.find(x => x.id === c.dataset.oid)); });
    grid.addEventListener("dragstart", e => { const c = e.target.closest(".v2-obj"); if (!c) return; e.dataTransfer.setData("text/x-bob-obj", c.dataset.oid); e.dataTransfer.effectAllowed = "copy"; });
    const view = $("v2-view").parentElement;
    view.addEventListener("dragover", e => { if ([...e.dataTransfer.types].some(t => t === "text/x-bob-obj" || t === "text/x-bob-cam")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; view.classList.add("v2-drop"); } });
    view.addEventListener("dragleave", e => { if (!view.contains(e.relatedTarget)) view.classList.remove("v2-drop"); });
    view.addEventListener("drop", e => {
      const cam = e.dataTransfer.getData("text/x-bob-cam");
      if (cam) { e.preventDefault(); view.classList.remove("v2-drop"); const [k, v] = cam.split(":"); return applyCam({ dataset: k === "move" ? { move: v } : { saved: v } }); }
      const id = e.dataTransfer.getData("text/x-bob-obj"); view.classList.remove("v2-drop");
      if (!id) return;
      e.preventDefault();
      const cv = view.querySelector(".s3-canvas"), r = cv?.getBoundingClientRect();
      const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      place(id, inside ? e.clientX : null, inside ? e.clientY : null);
    });
    $("v2-shotlist").addEventListener("click", e => {
      const x = e.target.closest("[data-x]"); if (x) return removeShot(x.dataset.x);
      const b = e.target.closest(".v2-shot"); if (b) openShot(b.dataset.id);
    });
    $("v2-shotlist").addEventListener("keydown", e => { const b = e.target.closest(".v2-shot"); if (b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openShot(b.dataset.id); } });
    const fields = [["v2-name", "name"], ["v2-setting", "setting"], ["v2-action", "action"], ["v2-sound", "sound"], ["v2-music", "music"], ["v2-quality", "quality"],
      ["v2-tin", "trim_in"], ["v2-tout", "trim_out"], ["v2-trans", "transition"], ["v2-tlen", "tlen"]];
    $("v2-export").onclick = exportDialog;
    // the dialogue lines
    $("v2-addline").onclick = () => { const s = cur(); if (!s) return; linesOf(s).push({ speaker: "", text: "" }); save(); $("v2-lines").dataset.shot = ""; renderPanel(true); $("v2-lines").querySelector(`[data-ltx="${s.lines.length - 1}"]`)?.focus(); };
    $("v2-lines").addEventListener("input", e => { const s = cur(), k = e.target.dataset.ltx; if (s && k != null) { linesOf(s)[+k].text = e.target.value; save(); renderPanel(true); } });
    $("v2-lines").addEventListener("change", e => { const s = cur(), k = e.target.dataset.lsp; if (s && k != null) { linesOf(s)[+k].speaker = e.target.value; save(); $("v2-lines").dataset.shot = ""; renderPanel(true); } });
    $("v2-lines").addEventListener("click", e => { const s = cur(), k = e.target.closest("[data-lrm]")?.dataset.lrm; if (s && k != null) { linesOf(s).splice(+k, 1); save(); $("v2-lines").dataset.shot = ""; renderPanel(true); } });
    // the shot's LoRAs
    const shotLoras = () => { const s = cur(); if (s && !Array.isArray(s.loras)) s.loras = []; return s; };
    $("v2-shotloras").addEventListener("change", e => {
      const s = shotLoras(), t = e.target; if (!s) return;
      if (t.dataset.slname != null) s.loras[+t.dataset.slname].name = t.value;
      else if (t.dataset.slstr != null) s.loras[+t.dataset.slstr].strength = t.value === "" ? 1 : strengthOf({ strength: t.value });
      else return;
      save(); t.blur(); renderPanel(true);
    });
    $("v2-shotloras").addEventListener("click", e => {
      const s = shotLoras(), t = e.target.closest("button"); if (!s || !t) return;
      if (t.hasAttribute("data-sladd") && st.loraList?.length && s.loras.length < 4) {
        const used = new Set(lorasFor(s).map(l => l.name));
        s.loras.push({ name: (st.loraList.find(x => !used.has(x.name)) || st.loraList[0]).name, strength: 1 });
      } else if (t.dataset.slrm != null) s.loras.splice(+t.dataset.slrm, 1);
      else return;
      save(); renderPanel(true); renderShotLoras(s, true);  // the button clicked has the focus: draw them anyway
      if (t.hasAttribute("data-sladd")) $("v2-shotloras").querySelector(`[data-slname="${s.loras.length - 1}"]`)?.focus();
    });
    // the soundtrack, and the project's LoRAs
    $("v2-music-btn").onclick = soundtrackDialog;
    $("v2-projloras").onclick = projectLorasDialog;
    $("v2-settings").onclick = () => Settings.open("generation");

    for (const [id, k] of fields) $(id).addEventListener(id === "v2-quality" || id === "v2-trans" ? "change" : "input", e => {
      const s = cur(); if (!s) return;
      s[k] = e.target.value; save();
      if (["trim_in", "trim_out", "transition", "tlen"].includes(k)) renderTimeline();
      if (k === "name") { renderShots(); renderTimeline(); $("v2-shot-title").textContent = s.name; }
    });
    $("v2-tags").addEventListener("click", e => {
      const b = e.target.closest("[data-tag]"); if (!b) return;
      const ta = $("v2-action"), t = `{${b.dataset.tag}}`, a = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, a) + t + ta.value.slice(ta.selectionEnd ?? a); ta.focus(); ta.selectionStart = ta.selectionEnd = a + t.length;
      ta.dispatchEvent(new Event("input"));
    });
    $("v2-gen").onclick = () => st.sel && generate(st.sel);
    $("v2-takes").onchange = e => { const s = cur(); if (s) { s.takes = +e.target.value; save(); } };
    $("v2-genall").onclick = generateAll;
    // the timeline: fold, height, zoom, timeline or log; click a clip to open its shot (its camera from the camera
    // layer), drag a clip to reorder
    applyTlUI();
    $("v2-tlfold").onclick = () => { tlUI.fold = !tlUI.fold; saveTlUI(); applyTlUI(); renderTimeline(); };
    $("v2-tlunits").onclick = () => { tlUI.units = tlUI.units === "f" ? "s" : "f"; saveTlUI(); renderTimeline(); };
    $("v2-tlmark").onclick = () => addMarker(playGlobal() ?? 0);
    $("v2-logbig").onclick = () => { st.logAuto = false; logWindow(); };
    document.querySelectorAll(".v2-tlview [data-tlv]").forEach(b => b.onclick = () => { st.logAuto = false; if (tlUI.fold) { tlUI.fold = false; saveTlUI(); applyTlUI(); } showTlView(b.dataset.tlv); });
    document.querySelector(".v2-tlzoom").addEventListener("click", e => {
      const z = e.target.closest("[data-z]")?.dataset.z; if (!z) return;
      tlUI.z = z === "fit" ? 0 : Math.max(0, Math.min(5, tlUI.z + (z === "+" ? 0.5 : -0.5))); saveTlUI(); renderTimeline();
    });
    const grip = $("v2-tlgrip");
    grip.addEventListener("pointerdown", e => {
      if (tlUI.fold) return;
      e.preventDefault(); grip.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = $("v2-tl").getBoundingClientRect().height;
      const mv = ev => { tlUI.h = h0 + (y0 - ev.clientY); applyTlUI(); };
      const up = () => { grip.removeEventListener("pointermove", mv); grip.removeEventListener("pointerup", up); saveTlUI(); renderTimeline(); };
      grip.addEventListener("pointermove", mv); grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("keydown", e => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); tlUI.h += e.key === "ArrowUp" ? 20 : -20; applyTlUI(); saveTlUI(); renderTimeline(); } });
    addEventListener("resize", () => { applyTlUI(); renderTimeline(); });
    const tr = $("v2-tracks");
    wireCamLayer(tr);
    let drag = null;
    tr.addEventListener("click", e => {
      if (e.target.closest('[data-a="music"]')) return soundtrackDialog();
      const k = e.target.closest("[data-cam]");
      if (k) { if (e.target.closest(".v2-key")) return; const at = timeAt(e.clientX); if (at) openAt(at.L).then(() => { Scene3D.selectCam(); Scene3D.camEdit.seek(at.t); }); return; }
      const c = e.target.closest(".v2-clip, .v2-sndseg"); if (c) openShot(c.dataset.id);
    });
    tr.addEventListener("dragstart", e => { const c = e.target.closest(".v2-clip"); if (!c) return; drag = c.dataset.id; e.dataTransfer.effectAllowed = "move"; });
    tr.addEventListener("dragover", e => { if (drag) e.preventDefault(); });
    tr.addEventListener("drop", e => {
      e.preventDefault();
      const c = e.target.closest(".v2-clip"), L = st.board.shots; if (!drag || !c || c.dataset.id === drag) return;
      const from = L.findIndex(x => x.id === drag), to = L.findIndex(x => x.id === c.dataset.id);
      const [m] = L.splice(from, 1); L.splice(to, 0, m); drag = null; save(); renderAll();
    });
    tr.addEventListener("dragend", () => { drag = null; });
  }

  /* The top row: what the generation is doing, in one line (Idle when nothing is), and the machine's load. */
  const act = { doing: new Map(), step: new Map(), pos: new Map() };
  const KINDS = { video: "Video", image: "Photo", audio: "Sound" };
  // a job's log line -> what it's doing, in words (null: a line that doesn't say)
  const outOf = it => it?.kind === "image" ? "photo" : it?.kind === "audio" ? "sound" : "video";
  const fromLog = (msg, it) => /^Node \d+ · /.test(msg) ? Scene3D.doingOf(msg.replace(/^Node \d+ · /, ""), outOf(it))
    : /^Sent to ComfyUI/.test(msg) ? "sent to ComfyUI" : /^Running on the GPU/.test(msg) ? "loading the models and preparing"
    : /^Downloading the results/.test(msg) ? `saving the ${outOf(it)}` : /^Checking the words/.test(msg) ? "checking the spoken words" : null;
  function activity() {
    const el = $("v2-activity"); if (!el) return;
    const busy = [...state.items.values()].filter(x => ["queued", "submitting", "running"].includes(x.status));
    const run = busy.filter(x => x.status === "running").sort((a, b) => (a.started || a.created) - (b.started || b.created))[0];
    const waiting = busy.length - (run ? 1 : 0);
    let t = "Idle";
    if (run) {
      const shot = st.board?.shots?.find(s => run.params?.scene && s.scene === run.params.scene || s.results?.includes(run.id));
      const what = `${KINDS[run.kind] || "Job"}${shot ? ` · ${shot.name || "a shot"}` : ""}`;
      // what it's on: from the live events, or (a page opened mid-job) its log so far
      const doing = act.doing.get(run.id) ?? [...(run.log || [])].reverse().map(e => fromLog(e.msg || "", run)).find(Boolean), stp = act.step.get(run.id);
      const pct = stp ? ` · ${Math.round(100 * stp[0] / stp[1])}%` : run.progress ? ` · ${Math.round(100 * run.progress)}%` : "";
      const words = stp ? `${Scene3D.stepVerb(doing)}, step ${stp[0]} of ${stp[1]}` : doing || "starting";
      t = `${what}: ${words}${pct}${waiting ? ` · ${waiting} more waiting` : ""}`;
    } else if (busy.length) {
      const p = Math.min(...busy.map(x => act.pos.get(x.id) ?? Infinity));
      t = `${busy.length} waiting${Number.isFinite(p) ? `, ComfyUI queue position ${p}` : ""}`;
    }
    el.textContent = t; el.title = t === "Idle" ? "Nothing is generating" : t; el.classList.toggle("busy", t !== "Idle");
  }
  function onActivity(ev) {
    const said = ev.type === "log" && fromLog(ev.msg || "", state.items.get(ev.id));
    if (said) { act.doing.set(ev.id, said); act.step.delete(ev.id); } else if (ev.type === "progress" && ev.steps > 1) act.step.set(ev.id, [ev.step, ev.steps]);
    else if (ev.type === "queue") act.pos.set(ev.id, ev.position);
    else if (ev.type === "item" && !["queued", "submitting", "running"].includes(ev.item.status)) {
      act.doing.delete(ev.item.id); act.step.delete(ev.item.id); act.pos.delete(ev.item.id);
    }
    activity();
  }
  async function meters() {
    const box = $("v2-meters"); if (!box || document.hidden) return;
    let u; try { u = await api("/api/system/usage"); } catch { return; }
    const set = (k, v, tip) => { const m = box.querySelector(`[data-m="${k}"]`); if (!m) return;
      m.querySelector("b").textContent = v == null ? "–" : `${Math.round(v)}%`; m.classList.toggle("hot", v >= 90); if (tip) m.title = tip; };
    const gb = b => (b / 1024 ** 3).toFixed(1);
    set("cpu", u.cpu, "CPU use");
    set("gpu", u.gpu?.pct, u.gpu ? `GPU use: ${u.gpu.name}${u.gpu.mem_total ? `; its memory ${gb(u.gpu.mem_used)} of ${gb(u.gpu.mem_total)} GB (${Math.round(u.gpu.mem_pct)}%)` : ""}` : "GPU use (no NVIDIA GPU found)");
    set("memory", u.memory?.pct, u.memory ? `Memory (RAM): ${gb(u.memory.used)} of ${gb(u.memory.total)} GB` : "Memory (RAM) use");
  }
  /* A retake the studio made by itself (a scene render's words came out low): another take of the shot that has the
     render, beside it (the shot uses the take with the best words), and a step in that render's log. */
  function retookItself(it) {
    const of = it.params?.retake_of; if (!of) return;
    const s = st.board.shots.find(x => x.results?.includes(of));
    if (s && !s.results.includes(it.id)) { s.results = [it.id, ...s.results].slice(0, 20); save(); renderAll(); }
    const e = st.log.find(x => x.items.some(y => y.id === of));
    if (e && !e.items.some(y => y.id === it.id)) { e.items.push({ id: it.id, title: "🔁 Sound retake (the words came out low)" }); renderLog(); }
  }
  /* ✨ A take enhanced (here, from Classic, or the Render window's final take by the studio): it becomes another take
     of the shot that has its source, and once it's done, the one the shot uses. */
  function enhancedTake(it, prev = null) {
    const of = it?.engine === "enhance" && it.params?.enhance_of; if (!of) return;
    const s = st.board.shots.find(x => x.results?.includes(of) || x.results?.includes(it.id)); if (!s) return;
    const add = !s.results.includes(it.id), pick = it.status === "done" && prev?.status !== "done" && s.pick !== it.id;
    if (!add && !pick) return;
    if (add) s.results = [it.id, ...s.results].slice(0, 20);
    if (pick) s.pick = it.id;
    save(); renderAll();
  }
  async function enhanceTake(it, opts) {
    try {
      const { items } = await api("/api/enhance", { method: "POST", body: JSON.stringify({ item: it.id, options: opts }) });
      if (!items.length) return Media.toast("That enhance is already being set up.");
      for (const x of items) { const known = state.items.has(x.id); state.items.set(x.id, x); if (!known) { enhancedTake(x); adopt(x); } }
      Media.toast(`Enhancing (${Enhance.summary(opts, it.kind)}): it becomes the shot's take when it's done.`);
    } catch (e) { Media.toast(`Enhance: ${e.message}`); }
  }
  /* A job this page didn't start (it was running when the page opened, or the studio started it: the lips redrawn,
     a sound retake, an enhance) goes in the log too: beside the job it's for when that's there, else on its own. */
  function adopt(it) {
    if (!["queued", "running"].includes(it?.status) || st.log.some(e => e.items.some(x => x.id === it.id))) return;
    const p = it.params || {}, of = p.relock_of || p.retake_of || p.enhance_of;
    const title = p.relock_of ? "👄 Lips redrawn to the cleaned sound" : p.retake_of ? "🔁 Sound retake (the words came out low)"
      : p.enhance_of ? "✨ Enhance" : engineTitle({ ...p, engine: it.engine || p.engine });
    const e = of && st.log.find(x => x.items.some(y => y.id === of));
    if (e) { e.items.push({ id: it.id, title }); renderLog(); return; }
    const n = logStart(title); n.prep = false; n.t0 = it.created || n.t0; n.items.push({ id: it.id, title }); renderLog();
  }
  function events() {
    const es = new EventSource("/api/events");
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type !== "item") { onActivity(ev); return; }
      const prev = state.items.get(ev.item.id);
      state.items.set(ev.item.id, ev.item);
      onActivity(ev);
      Scene3D.onItem?.(ev.item);
      maybeAddLater(ev.item);
      enhancedTake(ev.item, prev);
      if (!prev) { retookItself(ev.item); adopt(ev.item); }
      if (ev.item.id === st.board.settings.lastExport) renderExport();
      if (st.log.some(e2 => e2.items.some(x => x.id === ev.item.id))) renderLog();
      if ((st.board.shots.some(s => s.results?.includes(ev.item.id)) || st.board.settings.soundtrack?.result === ev.item.id)
        && (prev?.status !== ev.item.status || prev?.heard?.score !== ev.item.heard?.score)) renderAll();
    };
  }

  async function init() {
    wire();
    Scene3D.mount($("v2-view"));
    follow();
    try { const v = await api("/api/status"); $("v2-version").textContent = `v${v.version}`; } catch {}
    try { state.caps = await api("/api/capabilities"); } catch (e) { status(`Capabilities: ${e.message}`); }
    try { for (const it of (await api("/api/items")).items || []) state.items.set(it.id, it); } catch {}
    restoreLog();  // the log as it was before a reload
    for (const it of [...state.items.values()].sort((a, b) => a.created - b.created)) adopt(it);  // what's still being made
    renderLog();
    events();
    activity(); meters(); setInterval(meters, 3000);
    saveSign();
    window.addEventListener("beforeunload", e => {  // changes still waiting: send them, and ask before leaving
      if (![...saves.k.values()].includes("pending")) return;
      flushSaves(); e.preventDefault(); e.returnValue = "";
    });
    await loadObjects();
    await loadLoras();
    Settings.load();  // the app's settings (the look, the retake threshold the Render window shows)
    await loadCameras();
    await loadProjects();
    await loadBoard();
  }
  // What happens in the shot that has this scene (the builder's Render window starts from it)
  const shotWhat = sceneId => String(st.board.shots.find(x => x.scene === sceneId)?.action || "").trim();
  // ...and its setting (the photo's look starts from it, as Generate uses it)
  const shotSetting = sceneId => String(st.board.shots.find(x => x.scene === sceneId)?.setting || "").trim();
  // ...and its dialogue and sound, as Generate puts them in the prompt (the Render window adds them to its own)
  // voices: the speakers' library voices (H3 Reference's <Audio N>), when H3 Reference is there; voiced: the lines
  // saying which voice each speaks with
  const shotExtra = sceneId => {
    const s = st.board.shots.find(x => x.scene === sceneId); if (!s) return null;
    const voices = state.caps?.engines?.h3ref?.ready ? voicesFor(s) : [];
    return { lines: linesOf(s).filter(l => String(l.text || "").trim()).map(l => ({ speaker: l.speaker || "", text: String(l.text).trim() })),
      voices, sound: soundOf(s), loras: lorasFor(s) };
  };
  return { init, decide, generate, onSubmit, addRender, addWhenDone, shotWhat, shotSetting, shotExtra, _st: st };
})();
