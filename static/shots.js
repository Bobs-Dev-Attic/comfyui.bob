/* Shots: the Shots step for video models. A shot list, each shot with its own length, framing,
   setting, action, camera move and spoken line (with a voice from the reference sounds), and its
   own inputs: first / last frame (H3) or which reference pictures it uses (H3 Reference).

   Two ways to make video from it, chosen per run:
   - multi: one generation whose prompt is H3's multi-shot format ([Shot 1] ... [Shot 2] At
     00:03.000, ...), timed from each shot's length; the first shot's first frame and the last
     shot's last frame become the video's keyframes;
   - each: one generation per shot, then the results go on the timeline in order.

   state.shots = {on, mode, style, soundscape, music, list: [shot]} (saved with the settings). */
"use strict";

const Shots = (() => {
  const P = () => window.H3Prompt;
  const CAMERAS = ["holds a static shot", "slowly pushes in", "slowly pulls back", "pans left", "pans right", "tilts up", "tilts down",
    "tracks alongside the subject", "follows the subject from behind", "orbits around the subject", "cranes up", "is handheld and close", "racks focus"];
  const uid = () => Math.random().toString(16).slice(2, 10);
  const blank = (seconds = 3) => ({ id: uid(), seconds, framing: "medium shot", setting: "", action: "", camera: "holds a static shot", dialogue: "", voice: "",
    first_frame: null, last_frame: null, refs: [] });
  const on = () => state.kind === "video" && state.shots?.on && state.shots.list.length > 0;
  const total = () => state.shots.list.reduce((a, s) => a + (+s.seconds || 0), 0);
  const fmtT = t => P()?.fmtTime(t) || t.toFixed(2);

  function ensure() {
    if (!state.shots || !Array.isArray(state.shots.list)) state.shots = { on: false, mode: "multi", style: "", soundscape: "", music: "", list: [] };
    if (!state.shots.list.length) state.shots.list.push(blank(3), blank(3));
    return state.shots;
  }

  /* ---------------------------------------------------------------- prompts */
  function shotText(s, k, start, n) {
    const H = P();
    let framing = (s.framing || "medium shot").trim();
    const head = k > 0 && n > 1 ? `At ${fmtT(start)}, ${framing}` : framing[0].toUpperCase() + framing.slice(1);
    const parts = [`${head}.`];
    if (s.setting.trim()) parts.push(H.sentence(s.setting));
    if (s.action.trim()) parts.push(H.sentence(s.action));
    const line = H.cleanDialogue(s.dialogue || "", H.dialogueBudget(+s.seconds || 3));
    if (line) parts.push(s.voice ? `They say, in the voice of ${s.voice}: <d>[English] ${line}</d>` : `They say: <d>[English] ${line}</d>`);
    parts.push(`The camera ${H.cameraText(s.camera || "holds a static shot")}.`);
    return parts.join(" ");
  }
  function tail() {
    const sh = state.shots, H = P();
    return `\n\noverall_soundscape: ${H.sentence(sh.soundscape || "") || "Natural ambient sound of the scene."}\nnon_diegetic_music: ${(sh.music || "").trim() || "N/A"}`;
  }
  // The whole multi-shot prompt, or one shot's own prompt (each mode).
  function prompt(only = null) {
    const sh = state.shots, H = P();
    const style = H.sentence(sh.style || "") || "Cinematic live-action, natural light.";
    if (only != null) return `${style}\n\n[Shot 1] ${shotText(sh.list[only], 0, 0, 1)}${tail()}`;
    let t = 0;
    const body = sh.list.map((s, k) => { const txt = `[Shot ${k + 1}] ${shotText(s, k, t, sh.list.length)}`; t += +s.seconds || 0; return txt; }).join("\n");
    return `${style}\n\n${body}${tail()}`;
  }

  /* ---------------------------------------------------------------- the step */
  function render() {
    const box = document.getElementById("shot-list");
    if (!box) return;
    const sh = ensure(), eng = state.engine.video, isRef = eng === "h3ref";
    document.getElementById("shots-on").checked = !!sh.on;
    $$("#shots-mode button").forEach(b => b.classList.toggle("active", b.dataset.m === sh.mode));
    document.getElementById("shots-style").value = sh.style || "";
    document.getElementById("shots-sound").value = sh.soundscape || "";
    document.getElementById("shots-music").value = sh.music || "";
    const T = total();
    document.getElementById("shots-total").textContent = `${sh.list.length} shot${sh.list.length === 1 ? "" : "s"} · ${T.toFixed(1)} s`;
    const voices = state.arefs.map((_, i) => `<Audio ${i + 1}>`);
    let t = 0;
    box.innerHTML = sh.list.map((s, i) => {
      const t0 = t; t += +s.seconds || 0;
      const frame = role => {
        const f = s[role];
        return `<div class="shot-frame${f ? " has" : ""}" data-role="${role}" tabindex="0" title="${role === "first_frame" ? "First" : "Last"} frame of this shot: drop a picture, or click to upload">
          ${f ? `<img src="${esc(f.url)}" alt=""><button type="button" class="x" data-shot-act="clear-${role}" title="Remove">×</button>` : `<span>${role === "first_frame" ? "First" : "Last"} frame</span>`}</div>`;
      };
      return `<div class="shot-card" data-i="${i}">
        <div class="shot-h">
          <b>Shot ${i + 1}</b><span class="shot-t">${fmtT(t0)} – ${fmtT(t)}</span>
          <label class="shot-dur" title="Length of this shot">⏱ <input type="number" min="1" max="15" step="0.5" value="${s.seconds}" data-f="seconds"> s</label>
          <span class="shot-btns">
            <button type="button" class="ex-btn" data-shot-act="up" title="Move earlier" ${i ? "" : "disabled"}>↑</button>
            <button type="button" class="ex-btn" data-shot-act="down" title="Move later" ${i < sh.list.length - 1 ? "" : "disabled"}>↓</button>
            <button type="button" class="ex-btn" data-shot-act="dup" title="Duplicate">⧉</button>
            <button type="button" class="ex-btn" data-shot-act="del" title="Delete" ${sh.list.length > 1 ? "" : "disabled"}>✕</button>
          </span>
        </div>
        <div class="row2">
          <div class="field"><label>Framing</label><select data-f="framing">${P().FRAMINGS.map(f => `<option${f === s.framing ? " selected" : ""}>${f}</option>`).join("")}<option value="over-the-shoulder shot"${s.framing === "over-the-shoulder shot" ? " selected" : ""}>over-the-shoulder shot</option><option value="point-of-view shot"${s.framing === "point-of-view shot" ? " selected" : ""}>point-of-view shot</option><option value="insert shot"${s.framing === "insert shot" ? " selected" : ""}>insert shot</option></select></div>
          <div class="field"><label>Camera</label><input list="shot-cams" data-f="camera" value="${esc(s.camera)}" placeholder="holds a static shot"></div>
        </div>
        <div class="field"><label>Where</label><input data-f="setting" value="${esc(s.setting)}" placeholder="A rain-soaked back alley at night, neon signs further down"></div>
        <div class="field"><label>What happens ${isRef && state.refs.length ? `<span class="shot-tags">${state.refs.map((_, k) => `<button type="button" class="chip-btn" data-tag="<Picture ${k + 1}>">Picture ${k + 1}</button>`).join("")}</span>` : ""}</label>
          <textarea rows="2" data-f="action" placeholder="The woman from <Picture 1> turns around and smiles">${esc(s.action)}</textarea></div>
        <div class="row2 shot-say">
          <div class="field"><label>Spoken line <span class="opt">optional</span></label><input data-f="dialogue" value="${esc(s.dialogue)}" placeholder="See you tomorrow."></div>
          <div class="field"><label>Voice</label><select data-f="voice" ${voices.length ? "" : "disabled title='Add reference sounds on the Inputs step to choose a voice'"}><option value="">Any</option>${voices.map(v => `<option${v === s.voice ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
        </div>
        ${!isRef ? `<div class="shot-frames">${frame("first_frame")}${frame("last_frame")}
          <p class="hint">${sh.mode === "multi" ? (i === 0 ? "Shot 1's first frame starts the video." : i === sh.list.length - 1 ? "The last shot's last frame ends the video." : "One video: only the first shot's first frame and the last shot's last frame are used.") : "Each shot is its own video and uses its own frames."}</p></div>` : ""}
        ${isRef && sh.mode === "each" && state.refs.length ? `<div class="shot-refs"><span class="hint inline">Pictures in this shot:</span> ${state.refs.map((r, k) => `<label class="shot-ref"><input type="checkbox" data-ref="${k}"${!s.refs?.length || s.refs.includes(k) ? " checked" : ""}><img src="${esc(r.url)}" alt="">${k + 1}</label>`).join("")}</div>` : ""}
      </div>`;
    }).join("");
    document.getElementById("shots-prompt").textContent = sh.mode === "multi" ? prompt() : sh.list.map((_, i) => `── Shot ${i + 1} ──\n${prompt(i)}`).join("\n\n");
    const warn = [];
    if (sh.mode === "multi" && T > 15) warn.push(`H3 makes up to about 15 s in one video; this is ${T.toFixed(1)} s. Use “One video per shot”, or shorten.`);
    if (sh.mode === "multi" && sh.list.length > 6) warn.push("More than 6 shots in one video crowds it; H3 does best with 1–5.");
    document.getElementById("shots-hint").innerHTML = sh.on
      ? `${sh.mode === "multi" ? `Generate makes <b>one ${T.toFixed(1)} s video</b> from this shot list.` : `Generate makes <b>${sh.list.length} videos</b>, one per shot, and puts them on the timeline in order.`} ${warn.map(w => `<span class="warn">⚠ ${esc(w)}</span>`).join(" ")}`
      : "Shots are off: Generate uses the Prompt step. Turn on <b>Use shots</b> to build the video from this list.";
    renderBanner();
  }
  function renderBanner() {
    const b = document.getElementById("prompt-shots-banner");
    if (b) b.hidden = !on();
  }
  function changed() { scheduleSave(); render(); }

  function init() {
    ensure();
    const step = document.querySelector('.step[data-step="shots"]');
    step.addEventListener("input", e => {
      const sh = state.shots, f = e.target.dataset.f, card = e.target.closest("[data-i]");
      if (e.target.id === "shots-style") sh.style = e.target.value;
      else if (e.target.id === "shots-sound") sh.soundscape = e.target.value;
      else if (e.target.id === "shots-music") sh.music = e.target.value;
      else if (f && card) {
        const s = sh.list[+card.dataset.i];
        s[f] = f === "seconds" ? Math.max(1, Math.min(15, +e.target.value || 1)) : e.target.value;
        if (f === "seconds") { render(); scheduleSave(); return; }
      } else if (e.target.dataset.ref != null && card) {
        const s = sh.list[+card.dataset.i];
        s.refs = [...card.querySelectorAll("[data-ref]")].filter(x => x.checked).map(x => +x.dataset.ref);
      } else return;
      scheduleSave();
      document.getElementById("shots-prompt").textContent = sh.mode === "multi" ? prompt() : sh.list.map((_, i) => `── Shot ${i + 1} ──\n${prompt(i)}`).join("\n\n");
    });
    step.addEventListener("change", e => {
      if (e.target.id === "shots-on") { state.shots.on = e.target.checked; changed(); }
      else if (e.target.matches("select[data-f]")) { const s = state.shots.list[+e.target.closest("[data-i]").dataset.i]; s[e.target.dataset.f] = e.target.value; changed(); }
    });
    step.addEventListener("click", e => {
      const sh = state.shots;
      const m = e.target.closest("#shots-mode button")?.dataset.m;
      if (m) { sh.mode = m; return changed(); }
      if (e.target.closest("#btn-shot-add")) { const last = sh.list[sh.list.length - 1]; sh.list.push({ ...blank(last?.seconds || 3), framing: last?.framing || "medium shot", setting: last?.setting || "" }); return changed(); }
      const tag = e.target.closest("[data-tag]");
      if (tag) { const ta = tag.closest(".shot-card").querySelector('[data-f="action"]'); insertAtCursor(ta, tag.dataset.tag); ta.dispatchEvent(new Event("input", { bubbles: true })); return; }
      const a = e.target.closest("[data-shot-act]")?.dataset.shotAct, card = e.target.closest("[data-i]");
      if (a && card) {
        const i = +card.dataset.i;
        if (a === "up" && i) [sh.list[i - 1], sh.list[i]] = [sh.list[i], sh.list[i - 1]];
        if (a === "down" && i < sh.list.length - 1) [sh.list[i + 1], sh.list[i]] = [sh.list[i], sh.list[i + 1]];
        if (a === "dup") sh.list.splice(i + 1, 0, { ...structuredClone(sh.list[i]), id: uid() });
        if (a === "del" && sh.list.length > 1) sh.list.splice(i, 1);
        if (a.startsWith("clear-")) sh.list[i][a.slice(6)] = null;
        return changed();
      }
      const fr = e.target.closest(".shot-frame");
      if (fr && !fr.classList.contains("has")) pickFrame(+fr.closest("[data-i]").dataset.i, fr.dataset.role);
    });
    // frames: drop from the gallery / Media, or files
    step.addEventListener("dragover", e => { const fr = e.target.closest(".shot-frame"); if (fr) { e.preventDefault(); fr.classList.add("over"); } });
    step.addEventListener("dragleave", e => e.target.closest(".shot-frame")?.classList.remove("over"));
    step.addEventListener("drop", async e => {
      const fr = e.target.closest(".shot-frame"); if (!fr) return;
      e.preventDefault(); fr.classList.remove("over");
      const i = +fr.closest("[data-i]").dataset.i, role = fr.dataset.role;
      const ref = e.dataTransfer.getData("text/x-bob-ref");
      if (ref) {
        const kind = e.dataTransfer.getData("text/x-bob-kind");
        if (kind && kind !== "image") return Media.toast("Shot frames are pictures. Use “Continue from this clip's last frame” on a video to get one.");
        state.shots.list[i][role] = { ref, url: e.dataTransfer.getData("text/x-bob-url") || mediaUrl(ref) };
        return changed();
      }
      const f = e.dataTransfer.files[0]; if (f) await uploadTo(i, role, f);
    });
  }
  function pickFrame(i, role) {
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/webp,image/bmp" });
    inp.onchange = () => inp.files[0] && uploadTo(i, role, inp.files[0]);
    inp.click();
  }
  async function uploadTo(i, role, file) {
    const fd = new FormData(); fd.append("file", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd }), j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      if (j.kind !== "image") throw new Error("Shot frames are pictures.");
      state.shots.list[i][role] = { ref: j.ref, url: j.url };
      changed();
    } catch (e) { Media.toast(e.message); }
  }

  /* ---------------------------------------------------------------- generate */
  // batch id → {ids: [item ids in shot order], project}; kept in localStorage so a reload doesn't lose it
  const pending = new Map();
  const PKEY = "bob.shotBatches";
  const savePending = () => { try { localStorage.setItem(PKEY, JSON.stringify([...pending])); } catch {} };
  try { for (const [k, v] of JSON.parse(localStorage.getItem(PKEY) || "[]")) pending.set(k, v); } catch {}
  async function generate(base) {
    const sh = state.shots, isRef = base.engine === "h3ref";
    if (sh.mode === "multi") {
      const first = sh.list[0].first_frame, last = sh.list[sh.list.length - 1].last_frame;
      const req = { ...base, prompt: prompt(), seconds: Math.min(300, total()),
        first_frame: !isRef ? first?.ref ?? null : null, last_frame: !isRef ? last?.ref ?? null : null };
      return submit(req);
    }
    // one per shot: submit them in order, then place the results on the timeline in order
    const ids = [];
    $("#form-error").textContent = "";
    for (let i = 0; i < sh.list.length; i++) {
      const s = sh.list[i];
      const refs = isRef ? (s.refs?.length ? s.refs.map(k => state.refs[k]?.ref).filter(Boolean) : base.references) : [];
      const req = { ...base, batch: 1, prompt: prompt(i), seconds: +s.seconds || 3, references: refs,
        first_frame: !isRef ? s.first_frame?.ref ?? null : null, last_frame: !isRef ? s.last_frame?.ref ?? null : null };
      if (isRef && !refs.length && !(base.ref_audios || []).length) { $("#form-error").textContent = `Shot ${i + 1} has no reference pictures.`; return; }
      try {
        const { items } = await api("/api/generate", { method: "POST", body: JSON.stringify(req) });
        for (const it of items) { state.items.set(it.id, it); Activity.onEvent({ type: "item", item: it }); }
        ids.push(items[0].id);
      } catch (e) { $("#form-error").textContent = `Shot ${i + 1}: ${e.message}`; break; }
    }
    if (!ids.length) return;
    pending.set(ids[0], { ids, project: state.project?.id ?? "experiment" });
    savePending();
    renderGallery(); renderQueue(); select(ids[0]);
    Media.toast(`${ids.length} shot${ids.length === 1 ? "" : "s"} queued: they go on the timeline in order when all are done.`);
  }
  // Called for every studio item update: when a whole batch is done, lay it out on the timeline.
  async function onItem(it) {
    for (const [key, b] of pending) {
      if (!b.ids.includes(it.id)) continue;
      // `it` is newer than state.items here (the studio stores it after telling us)
      const all = b.ids.map(id => (id === it.id ? it : state.items.get(id)));
      if (all.some(x => !x || !["done", "failed", "cancelled"].includes(x.status))) return;
      pending.delete(key);
      savePending();
      const okItems = all.filter(x => x.status === "done" && x.files?.length);
      if ((state.project?.id ?? "experiment") !== b.project || !TL.model || !okItems.length) return;
      const v1 = TL.model.tracks.find(t => t.kind === "video");
      let at = Math.max(0, ...TL.model.clips.filter(c => c.track === v1?.id).map(c => c.start + c.trim_out - c.trim_in));
      for (const x of okItems) {
        const f = x.files.find(f => /^video\//.test(f.content_type || "")) || x.files[0];
        const c = await TL.add({ ref: f.path, kind: "video", name: (x.params?.prompt || "").split("\n").find(l => l.startsWith("[Shot"))?.slice(9, 60) || "Shot", job: x.id }, { track: v1?.id, at });
        if (c) at = c.start + c.trim_out - c.trim_in;
      }
      Media.toast(`The ${okItems.length} shots are on the timeline in order${okItems.length < all.length ? ` (${all.length - okItems.length} failed)` : ""}.`);
      return;
    }
  }

  return { init, render, renderBanner, prompt, on, generate, onItem, ensure };
})();
