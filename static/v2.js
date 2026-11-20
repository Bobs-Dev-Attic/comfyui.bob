/* Bob Studio V2 (static/v2.html): a shot-focused studio where the 3D scene is the main tool.

   Every shot is a 3D scene (the scene builder, static/scene3d.js, drawn in the middle of the page) plus its own words:
   the setting and environment, what happens, a line of dialogue and who says it, background sound and music, and a
   quality. The model is chosen for each shot from what's in it (decide): text only goes to H3; a set with objects or a
   camera move is drawn as a rough animation and made by H3 with Time-to-Move, starting from a photo of its first
   frame (the Qwen gap fill paints in what the camera move reveals); objects with pictures go on H3 Reference. Shots are
   laid out in order on the timeline below, and Generate makes one or all of them.

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
    return items;
  } catch (e) { Media.toast(`Generate: ${e.message}`); return null; }
}
// The classic Shots step isn't here: V2's shots are its own (the scene builder's shot links stay off).
const Shots = { on: () => false, each: () => false, targets: () => [], shotOfScene: () => null, isImage: () => false,
  placeWhenDone() {}, useScene() { return 0; }, linkScene() {}, unlinkScene() {} };

/* ---------------------------------------------------------------- V2 */
const V2 = (() => {
  const $ = id => document.getElementById(id);
  const uid = () => Math.random().toString(16).slice(2, 10);
  const PKEY = "bob.v2.project";
  const st = { board: { shots: [], settings: {} }, sel: null, scenes: new Map(), busy: new Set(), saveT: 0, say: new Map() };
  const shotOf = id => st.board.shots.find(x => x.id === id);
  const cur = () => shotOf(st.sel);
  const status = t => { $("v2-status").textContent = t || ""; };

  /* ---- the board: load and save (a moment after each change) */
  async function loadBoard() {
    const b = await api(`/api/v2/board?project=${encodeURIComponent(state.project?.id ?? "")}`);
    st.board = { shots: Array.isArray(b.shots) ? b.shots : [], settings: b.settings || {} };
    st.sel = st.board.shots.some(x => x.id === st.board.settings.sel) ? st.board.settings.sel : st.board.shots[0]?.id || null;
    await refreshScenes();
    renderAll();
    if (st.sel) openShot(st.sel, true);
  }
  function save() {
    clearTimeout(st.saveT);
    st.saveT = setTimeout(() => {
      st.board.settings.sel = st.sel;
      api(`/api/v2/board?project=${encodeURIComponent(state.project?.id ?? "")}`, { method: "PUT", body: JSON.stringify(st.board) })
        .catch(e => Media.toast(`Couldn't save the shots: ${e.message}`));
    }, 400);
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
      state.project = list.find(p => p.id === sel.value) || null;
      try { localStorage.setItem(PKEY, sel.value); } catch {}
      Scene3D._state()?.win?.close();
      await loadBoard();
    };
  }

  /* ---- new shots */
  async function newShot(how, tpl = null) {
    const n = st.board.shots.length + 1;
    let sc;
    try {
      sc = how === "template"
        ? await api(`/api/scenes/${tpl.id}/copy`, { method: "POST", body: JSON.stringify({ name: tpl.name, project: state.project?.id ?? null }) })
        : await api("/api/scenes", { method: "POST", body: JSON.stringify({ picture: null, name: `Shot ${n}`, project: state.project?.id ?? null, seconds: 5, aspect: "16:9" }) });
    } catch (e) { return Media.toast(`New shot: ${e.message}`); }
    st.scenes.set(sc.id, sc);
    const shot = { id: uid(), scene: sc.id, name: how === "template" ? tpl.name : `Shot ${n}`, setting: "", action: "", speaker: "", line: "", sound: "", music: "", quality: "standard", results: [] };
    st.board.shots.push(shot);
    save(); openShot(shot.id);
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
    renderAll();
    if (Scene3D._state()?.id !== s.scene) {
      $("v2-viewempty").hidden = true;
      await Scene3D.open(s.scene);
    }
    watchScene();
  }
  // The open scene changes as you work in it (objects, camera keys, length): the panel and timeline follow.
  let watchT = 0, lastSig = "";
  function watchScene() {
    clearInterval(watchT);
    watchT = setInterval(() => {
      const c = Scene3D.current(); if (!c) return;
      const sig = JSON.stringify([c.id, c.objs.map(o => [o.name, !!o.picture, o.keys?.length || 0, o.hidden]), c.camKeys.length, c.seconds]);
      if (sig === lastSig) return;
      lastSig = sig;
      const sc = st.scenes.get(c.id); if (sc) Object.assign(sc, { seconds: c.seconds, camera_keys: c.camKeys, objects: c.objs.map(o => ({ name: o.name, picture: o.picture, keys: o.keys, hidden: o.hidden, mesh: !!o.mesh })) });
      renderPanel(true); renderShots(); renderTimeline();
    }, 700);
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
  /* decide(shot) -> {engine: "h3" | "scene", ref, label, why: [reasons]} */
  function decide(s) {
    const i = sceneInfo(s), caps = state.caps || {}, why = [];
    if (!i.objects && !i.picture && !i.camMoves) {
      why.push("The set is empty and the camera holds still, so the words alone make the shot.");
      return { engine: "h3", ref: false, label: "MiniMax H3 · text to video", why, info: i };
    }
    const ref = i.pictures > 0 && !!caps.engines?.h3ref?.ready;
    if (i.camMoves) why.push("The camera moves: H3 follows the scene's camera path (Time-to-Move).");
    if (i.objMoves) why.push("Objects move along their paths.");
    if (i.objects && !i.objMoves && !i.camMoves) why.push("The objects are where you put them; nothing moves, so they hold their places.");
    why.push(i.picture ? "It starts from the scene's picture." : "It starts from a photo of the first frame, made first (about a minute).");
    if (i.camMoves && !i.picture) why.push("What the camera move shows that the photo can't is painted in by Qwen first.");
    if (ref) why.push(`${i.pictures} object${i.pictures === 1 ? " has a picture" : "s have pictures"}: H3 Reference keeps ${i.pictures === 1 ? "its" : "their"} look.`);
    else if (i.pictures) why.push("Objects have pictures, but H3 Reference isn't installed: they go by their descriptions.");
    return { engine: "scene", ref, label: ref ? "MiniMax H3 Reference · 3D scene render" : "MiniMax H3 · 3D scene render", why, info: i };
  }

  /* ---- the words for H3 */
  const sentence = t => { t = String(t || "").trim().replace(/\s+/g, " "); if (!t) return ""; t = t[0].toUpperCase() + t.slice(1); return /[.!?]$/.test(t) ? t : t + "."; };
  const lineOf = s => {
    const line = String(s.line || "").trim().replace(/^["“]|["”]$/g, "");
    if (!line) return "";
    // named once already in What happens: "The woman says" (the full description again reads as someone else)
    const named = s.speaker && String(s.action || "").includes(`{${s.speaker}}`);
    return `${!s.speaker ? "Someone" : named ? `The ${s.speaker.toLowerCase()}` : `{${s.speaker}}`} says: <d>[English] ${line}</d>`;
  };
  const soundOf = s => `overall_soundscape: ${sentence(s.sound) || "Natural ambient sound of the scene."}\n\nnon_diegetic_music: ${String(s.music || "").trim() || "N/A"}`;
  // text to video: the whole shot in words (objects named by their names)
  function textPrompt(s) {
    const body = [sentence(s.setting), sentence(String(s.action || "").replace(/\{([^{}]+)\}/g, "$1")), lineOf(s).replace(/\{([^{}]+)\}/g, "$1"), "The camera holds a static shot."].filter(Boolean).join(" ");
    return `integrated_multimodal_description: [Shot 1] ${body}\n\n${soundOf(s)}`;
  }

  /* ---- Generate */
  async function generate(id) {
    const s = shotOf(id); if (!s || st.busy.has(id)) return;
    const d = decide(s), say = m => { st.say.set(id, m); if (st.sel === id) $("v2-say").textContent = m; };
    st.busy.add(id); renderAll();
    try {
      let req;
      if (d.engine === "h3") {
        if (!String(s.action || s.setting || "").trim()) throw new Error("Say what the shot is: the setting, or what happens");
        req = { kind: "video", engine: "h3", prompt: textPrompt(s), seconds: d.info.seconds, aspect: "16:9", quality: s.quality || "standard",
          turbo: true, seed: -1, batch: 1, project: state.project?.id ?? null };
      } else {
        if (Scene3D._state()?.id !== s.scene) { await openShot(id); }
        const what = [sentence(s.action), lineOf(s)].filter(Boolean).join(" ");
        const r = await Scene3D.autoRender(s.scene, { text: what, look: String(s.setting || "").trim(), quality: s.quality, fill: true }, say);
        req = { ...r.req, project: state.project?.id ?? null };
        req.prompt = req.prompt.replace(/overall_soundscape:[\s\S]*$/, soundOf(s));
      }
      say("Sending to H3…");
      const items = await submit(req);
      if (!items?.length) throw new Error("H3 didn't take it");
      s.results = [items[0].id, ...(s.results || [])].slice(0, 20);
      save();
      say("Queued: it shows here when it's done.");
    } catch (e) { say(`⚠ ${e.message}`); Media.toast(`${s.name}: ${e.message}`); }
    finally { st.busy.delete(id); renderAll(); }
  }
  async function generateAll() {
    for (const s of st.board.shots.slice()) await generate(s.id);
  }

  /* ---- drawing */
  const latest = s => (s.results || []).map(id => state.items.get(id)).find(Boolean);
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
  function renderTimeline() {
    const tr = $("v2-tltrack"), shots = st.board.shots, secs = shots.map(s => decide(s).info.seconds), T = secs.reduce((a, b) => a + b, 0);
    $("v2-total").textContent = shots.length ? `${shots.length} shot${shots.length === 1 ? "" : "s"} · ${T.toFixed(1)} s` : "";
    tr.innerHTML = shots.map((s, i) => {
      const it = latest(s);
      return `<div class="v2-clip${s.id === st.sel ? " sel" : ""}${it?.status === "done" ? " done" : ""}" draggable="true" data-id="${esc(s.id)}" style="flex:${secs[i]} 1 0" title="${esc(s.name)} · ${secs[i].toFixed(1)} s">
        <b>${i + 1}</b> ${esc(s.name)} <span>${secs[i].toFixed(1)} s ${badge(it)}</span></div>`;
    }).join("");
  }
  function renderPanel(keepFocus = false) {
    const s = cur();
    $("v2-form").hidden = !s;
    $("v2-shot-title").textContent = s ? s.name : "Shot";
    if (!s) return;
    const d = decide(s);
    for (const [id, k] of [["v2-name", "name"], ["v2-setting", "setting"], ["v2-action", "action"], ["v2-line", "line"], ["v2-sound", "sound"], ["v2-music", "music"], ["v2-quality", "quality"]]) {
      const el = $(id); if (!(keepFocus && document.activeElement === el)) el.value = s[k] ?? (k === "quality" ? "standard" : "");
    }
    const names = d.info.names;
    $("v2-tags").innerHTML = names.map(n => `<button type="button" class="chip-btn" data-tag="${esc(n)}" title="Put {${esc(n)}} in">${esc(n)}</button>`).join("");
    const sp = $("v2-speaker");
    if (document.activeElement !== sp) sp.innerHTML = `<option value="">Someone</option>` + names.map(n => `<option value="${esc(n)}"${n === s.speaker ? " selected" : ""}>${esc(n)}</option>`).join("");
    $("v2-len").textContent = `${d.info.seconds.toFixed(1)} s${d.info.live ? " (the scene's length: set it under the scene's timeline)" : ""}`;
    $("v2-model").innerHTML = `<div class="v2-mh"><span>Model</span><b>${esc(d.label)}</b><span class="v2-auto">auto</span></div><ul>${d.why.map(w => `<li>${esc(w)}</li>`).join("")}</ul>`;
    const busy = st.busy.has(s.id);
    $("v2-gen").disabled = busy;
    $("v2-gen").textContent = busy ? "Working…" : "🎬 Generate shot";
    $("v2-say").textContent = st.say.get(s.id) || "";
    const it = latest(s), f = fileOf(it), box = $("v2-result");
    const want = it ? `${it.id}:${it.status}` : "";
    if (box.dataset.k !== want) {
      box.dataset.k = want;
      box.innerHTML = !it ? "" : f ? `<video src="${esc(f.url)}" controls preload="metadata"></video><p class="hint">Made ${new Date((it.finished || it.created) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>`
        : `<p class="hint">${it.status === "failed" ? `⚠ Failed: ${esc(it.error || "")}` : `${esc(it.status)}…`}</p>`;
    }
  }
  function renderAll() { renderShots(); renderTimeline(); renderPanel(true); }

  /* ---- wiring */
  function wire() {
    $("v2-new").onclick = newMenu;
    $("v2-shotlist").addEventListener("click", e => {
      const x = e.target.closest("[data-x]"); if (x) return removeShot(x.dataset.x);
      const b = e.target.closest(".v2-shot"); if (b) openShot(b.dataset.id);
    });
    $("v2-shotlist").addEventListener("keydown", e => { const b = e.target.closest(".v2-shot"); if (b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openShot(b.dataset.id); } });
    const fields = [["v2-name", "name"], ["v2-setting", "setting"], ["v2-action", "action"], ["v2-line", "line"], ["v2-sound", "sound"], ["v2-music", "music"], ["v2-quality", "quality"], ["v2-speaker", "speaker"]];
    for (const [id, k] of fields) $(id).addEventListener(id === "v2-quality" || id === "v2-speaker" ? "change" : "input", e => {
      const s = cur(); if (!s) return;
      s[k] = e.target.value; save();
      if (k === "name") { renderShots(); renderTimeline(); $("v2-shot-title").textContent = s.name; }
    });
    $("v2-tags").addEventListener("click", e => {
      const b = e.target.closest("[data-tag]"); if (!b) return;
      const ta = $("v2-action"), t = `{${b.dataset.tag}}`, a = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, a) + t + ta.value.slice(ta.selectionEnd ?? a); ta.focus(); ta.selectionStart = ta.selectionEnd = a + t.length;
      ta.dispatchEvent(new Event("input"));
    });
    $("v2-gen").onclick = () => st.sel && generate(st.sel);
    $("v2-genall").onclick = generateAll;
    // the timeline: click to open a shot, drag to reorder
    const tr = $("v2-tltrack");
    let drag = null;
    tr.addEventListener("click", e => { const c = e.target.closest(".v2-clip"); if (c) openShot(c.dataset.id); });
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
  function events() {
    const es = new EventSource("/api/events");
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type !== "item") return;
      const prev = state.items.get(ev.item.id);
      state.items.set(ev.item.id, ev.item);
      Scene3D.onItem?.(ev.item);
      if (st.board.shots.some(s => s.results?.includes(ev.item.id)) && prev?.status !== ev.item.status) renderAll();
    };
  }

  async function init() {
    wire();
    Scene3D.mount($("v2-view"));
    try { const v = await api("/api/status"); $("v2-version").textContent = `v${v.version}`; } catch {}
    try { state.caps = await api("/api/capabilities"); } catch (e) { status(`Capabilities: ${e.message}`); }
    try { for (const it of (await api("/api/items")).items || []) state.items.set(it.id, it); } catch {}
    events();
    await loadProjects();
    await loadBoard();
  }
  return { init, decide, generate, _st: st };
})();
