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
  const st = { board: { shots: [], settings: {} }, sel: null, scenes: new Map(), busy: new Set(), saveT: 0, say: new Map(), objs: [], cams: [] };
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
      const sig = JSON.stringify([c.id, c.objs.map(o => [o.name, !!o.picture, o.lib, o.keys?.length || 0, o.hidden]), c.camKeys.length, c.seconds]);
      if (sig === lastSig) return;
      lastSig = sig;
      const sc = st.scenes.get(c.id); if (sc) Object.assign(sc, { seconds: c.seconds, camera_keys: c.camKeys, objects: c.objs.map(o => ({ name: o.name, picture: o.picture, lib: o.lib, keys: o.keys, hidden: o.hidden, mesh: !!o.mesh })) });
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
  function lorasFor(s) {
    const objs = objsOf(s).filter(o => o.lib);
    const out = new Map();
    for (const o of objs) for (const l of st.objs.find(x => x.id === o.lib)?.loras || []) if (l?.name && !out.has(l.name)) out.set(l.name, { name: l.name, strength: +l.strength || 1 });
    return [...out.values()].slice(0, 8);
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
    if (i.camMoves) why.push("The camera moves: H3 follows the scene's camera path (Time-to-Move).");
    if (i.objMoves) why.push("Objects move along their paths.");
    if (i.objects && !i.objMoves && !i.camMoves) why.push("The objects are where you put them; nothing moves, so they hold their places.");
    why.push(i.picture ? "It starts from the scene's picture." : "It starts from a photo of the first frame, made first (about a minute).");
    if (i.camMoves && !i.picture) why.push("What the camera move shows that the photo can't is painted in by Qwen first.");
    if (ref) why.push(`${i.pictures} object${i.pictures === 1 ? " has a picture" : "s have pictures"}: H3 Reference keeps ${i.pictures === 1 ? "its" : "their"} look.`);
    else if (i.pictures) why.push("Objects have pictures, but H3 Reference isn't installed: they go by their descriptions.");
    if (voices.length) why.push(`${voices.map(v => v.name).join(" and ")} speak${voices.length === 1 ? "s" : ""} with ${voices.length === 1 ? "a voice" : "voices"} from the library (H3 Reference).`);
    else if (!caps.engines?.h3ref?.ready && voicesFor(s).length) why.push("Some speakers have voices, but H3 Reference isn't installed: H3 picks the voices.");
    const L = lorasFor(s);
    if (L.length) why.push(`${L.length} LoRA${L.length === 1 ? "" : "s"} from the objects go${L.length === 1 ? "es" : ""} along.`);
    return { engine: "scene", ref, label: ref ? "MiniMax H3 Reference · 3D scene render" : "MiniMax H3 · 3D scene render", why, info: i };
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
    return linesOf(s).map(l => {
      const text = String(l.text || "").trim().replace(/^["“]|["”]$/g, ""); if (!text) return "";
      const tag = l.speaker ? `{${l.speaker}}` : "", named = tag && seen.has(tag); if (tag) seen.add(tag);
      const who = !l.speaker ? "Someone" : plain ? l.speaker : named ? again(s, l.speaker) : tag;
      const k = voices.findIndex(v => v.name === l.speaker);
      return `${who} says${k >= 0 ? `, using the voice timbre referenced from <Audio ${k + 1}>` : ""}: <d>[English] ${text}</d>`;
    }).filter(Boolean).join(" ");
  }
  const soundtrackOn = () => !!(st.board.settings.soundtrack?.on && st.board.settings.soundtrack?.style);
  const soundOf = s => `overall_soundscape: ${sentence(s.sound) || "Natural ambient sound of the scene."}\n\nnon_diegetic_music: ${soundtrackOn() ? "N/A" : String(s.music || "").trim() || "N/A"}`;
  // text to video: the whole shot in words (objects named by their names)
  function textPrompt(s) {
    const body = [sentence(s.setting), sentence(String(s.action || "").replace(/\{([^{}]+)\}/g, "$1")), dialogueOf(s, [], true), "The camera holds a static shot."].filter(Boolean).join(" ");
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
        const voices = d.ref ? voicesFor(s) : [];
        const what = [sentence(s.action), dialogueOf(s, voices)].filter(Boolean).join(" ");
        const r = await Scene3D.autoRender(s.scene, { text: what, look: String(s.setting || "").trim(), quality: s.quality, fill: true }, say);
        req = { ...r.req, project: state.project?.id ?? null, loras: lorasFor(s), ...(voices.length ? { ref_audios: voices.map(v => v.ref), clean_audio: true } : {}) };
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
    const t = st.board.settings.soundtrack, lane = $("v2-tlmusic");
    $("v2-musichint").hidden = !soundtrackOn();
    $("v2-music").disabled = soundtrackOn();
    lane.hidden = !t?.style;
    if (lane.hidden) return;
    const it = t.result && state.items.get(t.result), f = it?.status === "done" ? it.files?.[0] : null;
    const want = `${t.on}:${t.style}:${it?.id}:${it?.status}`;
    if (lane.dataset.k === want) return;
    lane.dataset.k = want;
    lane.classList.toggle("off", !t.on);
    lane.innerHTML = `<button type="button" class="v2-tlmb" data-a="music" title="Edit the soundtrack">🎵 ${esc(t.style.slice(0, 80))}${t.on ? "" : " (off)"}</button>
      ${f ? `<audio controls src="${esc(f.url)}"></audio>` : `<span class="hint">${it ? `${esc(it.status)}…` : "not made yet"}</span>`}`;
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
        <button type="button" class="v2-objadd" data-add="${esc(e.id)}" title="Put ${esc(e.name)} in the scene, in front of the camera" aria-label="Add ${esc(e.name)} to the scene">＋</button></div>`).join("");
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
    const tr = $("v2-tltrack"), shots = st.board.shots, secs = shots.map(s => pieceOf(s).d), T = totalSeconds();
    $("v2-total").textContent = shots.length ? `${shots.length} shot${shots.length === 1 ? "" : "s"} · ${T.toFixed(1)} s` : "";
    tr.innerHTML = shots.map((s, i) => {
      const it = latest(s);
      return `<div class="v2-clip${s.id === st.sel ? " sel" : ""}${it?.status === "done" ? " done" : ""}" draggable="true" data-id="${esc(s.id)}" style="flex:${secs[i]} 1 0" title="${esc(s.name)} · ${secs[i].toFixed(1)} s">
        <b>${i + 1}</b> ${esc(s.name)} <span>${secs[i].toFixed(1)} s ${badge(it)}</span></div>`
        + (joinOf(s, i, shots) ? `<span class="v2-join" title="${esc(document.querySelector(`#v2-trans option[value="${s.transition}"]`)?.textContent || s.transition)}, ${joinOf(s, i, shots).toFixed(1)} s">⧖</span>` : "");
    }).join("");
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
  function renderAll() { renderShots(); renderTimeline(); renderPanel(true); renderSoundtrack(); renderExport(); }

  /* ---- wiring */
  function wire() {
    $("v2-new").onclick = newMenu;
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
    grid.addEventListener("click", e => { const a = e.target.closest("[data-add]"); if (a) place(a.dataset.add); });
    grid.addEventListener("dblclick", e => { const c = e.target.closest(".v2-obj"); if (c && !e.target.closest("[data-add]")) objectEditor(st.objs.find(x => x.id === c.dataset.oid)); });
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
    // the soundtrack
    $("v2-music-btn").onclick = soundtrackDialog;
    $("v2-tlmusic").addEventListener("click", e => { if (e.target.closest('[data-a="music"]')) soundtrackDialog(); });
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
      if (ev.item.id === st.board.settings.lastExport) renderExport();
      if ((st.board.shots.some(s => s.results?.includes(ev.item.id)) || st.board.settings.soundtrack?.result === ev.item.id) && prev?.status !== ev.item.status) renderAll();
    };
  }

  async function init() {
    wire();
    Scene3D.mount($("v2-view"));
    try { const v = await api("/api/status"); $("v2-version").textContent = `v${v.version}`; } catch {}
    try { state.caps = await api("/api/capabilities"); } catch (e) { status(`Capabilities: ${e.message}`); }
    try { for (const it of (await api("/api/items")).items || []) state.items.set(it.id, it); } catch {}
    events();
    await loadObjects();
    await loadCameras();
    await loadProjects();
    await loadBoard();
  }
  return { init, decide, generate, _st: st };
})();
