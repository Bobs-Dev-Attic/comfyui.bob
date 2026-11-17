/* Bob Studio front end — vanilla JS, talks to the FastAPI backend in app/main.py. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const ENGINES = {
  video: [{ key: "h3", label: "MiniMax H3" }, { key: "h3ref", label: "H3 Reference" }],
  image: [{ key: "h3", label: "H3 still" }, { key: "klein", label: "FLUX 3 Klein" }, { key: "krea2", label: "Krea 2" }, { key: "h3image", label: "H3 Image" }],
  audio: [{ key: "h3", label: "H3 sound" }, { key: "music3", label: "Music 3" }],
};

const ENGINE_NOTES = {
  "video:h3": "Text-to-video, or image-to-video with first/last keyframes. Native stereo sound in the same pass.",
  "video:h3ref": "Reference-to-video: put people, objects or places from your pictures into a new scene, with sound.",
  "image:h3": "One frame rendered by the H3 video model at its native 768p canvas.",
  "image:klein": "Dedicated image model: fast and sharp, up to 2 MP.",
  "image:krea2": "Krea 2 Turbo: photoreal pictures in 8 steps, up to 2 MP.",
  "image:h3image": "MiniMax H3 Image: MiniMax's image model, 6 steps, up to 4 MP. Optional reference pictures.",
  "audio:h3": "H3 generates audio jointly with a tiny video, then keeps only the soundtrack (MP3).",
  "audio:music3": "Full songs with vocals from a style caption and tagged lyrics.",
};

const TEMPLATES = {
  "video:h3":
`Cinematic live-action look, <style, palette, lens, mood>.

[Shot 1] <subject and setting>. The camera holds a static shot as <action>.
[Shot 2] At 00:02.500, <next beat>. The camera pushes in with small amplitude at slow speed.

overall_soundscape: <ambience and sound effects, timed to the action>
non_diegetic_music: <score style, or N/A>`,
  "video:h3ref":
`<style, palette, lens, mood>. Use <Picture 1> as the main character and <Picture 2> as the setting.

[Shot 1] The person from <Picture 1> <action> in <setting>. The camera holds a static shot.
[Shot 2] At 00:02.500, <next beat>. The camera pushes in with small amplitude at slow speed.

overall_soundscape: <ambience and sound effects, timed to the action>
non_diegetic_music: <score style, or N/A>`,
  "image:h3":
`<medium and style>, <subject with concrete colors and materials>, <setting>, <lighting>. The camera holds a static shot.`,
  "image:klein":
`<medium: e.g. Studio photograph / Watercolor illustration>, <subject>, <setting>, <lighting and camera>, <colors and materials>.`,
  "image:krea2":
`<medium: e.g. Candid photograph / Oil painting>, <subject and action>, <setting>, <lighting and camera>, <colors and materials>.`,
  "image:h3image":
`<medium and style>, <subject with concrete colors and materials>, <setting>, <lighting and camera>.`,
  "audio:h3":
`overall_soundscape: <describe the sounds, their order and timing — e.g. rain on a tin roof, thunder building to a close crack at 3 seconds>
non_diegetic_music: <music style, or N/A>`,
  "audio:music3":
`Global Metadata: <genre>, <BPM>, <key>. <mood and arc>. <production texture>.

Vocal Details: <voice type, delivery, harmonies>.

Arrangement: <instruments and how sections build: intro, verses, chorus, bridge, outro>.`,
};

const TIPS = {
  h3: `<ul>
    <li>Write shots in order: <code>[Shot 1]</code>, <code>[Shot 2]</code>… with times like <code>At 00:03.000</code>.</li>
    <li>One camera move per shot, e.g. “The camera holds a static shot” or “pushes in with small amplitude at slow speed”.</li>
    <li>Describe sound too: <code>overall_soundscape:</code> and <code>non_diegetic_music:</code> (or <code>N/A</code>).</li>
    <li>Dialogue: <code>&lt;d&gt;[English] words&lt;/d&gt;</code>, about 2.5 words per second.</li>
    <li>H3 has no negative prompt — never write “no X”; describe what <em>is</em> there.</li>
    <li>Skip filler like “masterpiece, 8k”. 5 s or longer moves best (trained 5–15 s).</li>
    <li>Keyframe alignment text is added for you automatically.</li></ul>`,
  h3ref: `<ul>
    <li>Name each picture by its tag, e.g. “the woman from <code>&lt;Picture 1&gt;</code>”, and say which picture drives what: a character, an object, a place, or the style.</li>
    <li>Tags follow the order of the pictures above. Removing one renumbers the rest.</li>
    <li>This model is very sensitive to wording: precise tags beat long descriptions of the person.</li>
    <li>Shot and sound rules are the same as plain H3: <code>[Shot 1]</code>, one camera move per shot, <code>overall_soundscape:</code>.</li>
    <li>Turn on <b>Max reference detail</b> when faces drift; it's several times slower.</li></ul>`,
  klein: `<ul>
    <li>Lead with the medium and style, then scene, lighting, camera, then subjects with concrete colors and materials.</li>
    <li>Put any text to render in double quotes.</li>
    <li>Short prompt? Turn on <b>Enhance prompt</b>.</li></ul>`,
  krea2: `<ul>
    <li>Write plain sentences: subject and action first, then setting, lighting and camera.</li>
    <li>Name the medium (“photo of”, “illustration of”) when you want one; it defaults to photoreal.</li>
    <li>Put any text to render in double quotes.</li>
    <li>Short prompt? Turn on <b>Enhance prompt</b>: Krea 2's text encoder expands it.</li></ul>`,
  h3image: `<ul>
    <li>Describe the picture in full sentences: medium and style, subject, setting, lighting and camera.</li>
    <li>Optional reference pictures: name them <code>&lt;Picture 1&gt;</code>, <code>&lt;Picture 2&gt;</code>… e.g. “the woman from <code>&lt;Picture 1&gt;</code> in a café”.</li>
    <li>Put any text to render in double quotes.</li>
    <li>It always runs 6 steps (distilled). High is about 4 MP, the size it's tuned for.</li></ul>`,
  music3: `<ul>
    <li>Caption in three parts: Global Metadata → Vocal Details → Arrangement.</li>
    <li>Lyrics tags (<code>[Intro] [Verse] [Chorus] [Bridge] [Outro] [Instrumental]</code>) control structure.</li></ul>`,
};

const state = {
  caps: null,
  kind: "video",
  engine: { video: "h3", image: "h3", audio: "h3" },
  frames: { first_frame: null, last_frame: null },
  refs: [],  // [{ref, url}] for H3 Reference
  loras: [],  // [{name, strength}] LoRAs on the model (loras.js)
  unet: {},  // engine -> diffusion model file picked in Settings › Advanced (none = the engine's default)
  sampling: {},  // engine -> {sampler, scheduler} picked in Settings › Advanced (missing = the engine's own)
  shots: null,  // the Shots step (shots.js)
  arefs: [],  // [{ref, url, name}] reference sounds (voices to clone) for H3 Reference
  items: new Map(),
  selected: null,
  filter: "all",
  previews: new Map(),
  progress: new Map(),
  batch: 1,
  pickRole: null,
};

/* ------------------------------------------------------------------ helpers */
const ASPECT = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3], "21:9": [21, 9] };

function dimsFor([aw, ah], mp, multiple = 32) {
  const area = mp * 1024 * 1024;
  const w = Math.sqrt(area * aw / ah), h = w * ah / aw;
  const snap = v => Math.max(multiple, Math.round(v / multiple) * multiple);
  return [snap(w), snap(h)];
}
function h3Frames(sec) { const a = Math.max(5, Math.round(sec * 24)); return a + (5 - (a % 17)) % 17; }

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
const engineName = (kind, eng) => eng === "enhance" ? "Enhanced" : eng === "angles" ? "Angles" : eng === "imgedit" ? "Edited" : (ENGINES[kind]?.find(e => e.key === eng) || {}).label || eng;
function fmtDur(s) { if (s == null) return ""; s = Math.round(s); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }
function waveHTML(seed, n = 28) {
  let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; const h = 18 + (x % 62) * (0.6 + 0.4 * Math.sin(i / 3)); out += `<i style="height:${Math.max(8, h)}%"></i>`; }
  return `<div class="wave">${out}</div>`;
}

/* Browser URL for a media ref: files inside the app are served directly, files in a
   bookmarked folder through /api/media/file. */
function mediaUrl(ref) {
  if (!ref) return "";
  return /^(outputs|data\/uploads)\//.test(ref) ? "/" + ref : `/api/media/file?path=${encodeURIComponent(ref)}`;
}

/* ------------------------------------------------------------------ form */
function curKey() { return `${state.kind}:${state.engine[state.kind]}`; }

function renderForm() {
  const kind = state.kind, eng = state.engine[kind];
  renderModels();  // the Model step (shell.js)

  const isRef = eng === "h3ref", isH3Img = eng === "h3image";
  const isH3 = eng === "h3" || isRef, isKlein = eng === "klein" || eng === "krea2", isMusic = eng === "music3";
  $("#f-frames").hidden = !(kind === "video") || isRef;
  $("#f-refs").hidden = !(isRef || isH3Img);
  $("#f-arefs").hidden = !(kind === "video" && isH3);
  $("#f-arefs").classList.toggle("needs-ref", !isRef);
  $("#f-fidelity").hidden = !isRef;
  $("#f-enhance-after").hidden = kind === "audio";
  if (typeof Enhance !== "undefined") Enhance.renderSettings();  // FaceRefine fits H3 video only
  $("#f-lyrics").hidden = !isMusic;
  $("#f-aspect").hidden = kind === "audio";
  $("#f-quality").hidden = kind === "audio";
  $("#f-seconds").hidden = kind !== "audio";  // video: each shot has its own length (Shots step)
  $("#f-turbo").hidden = !isH3;
  $("#f-enhance").hidden = !isKlein;
  $("#enhance-hint").textContent = eng === "krea2" ? "Krea 2's text encoder expands short prompts" : "Qwen3.5 upsampler expands short prompts";
  $("#prompt-label").textContent = isMusic ? "Style caption" : kind === "audio" ? "Sound description" : "Prompt";
  $("#prompt").placeholder = {
    video: "Describe the shots, camera moves, and the sound…",
    image: "Describe the picture…",
    audio: isMusic ? "Genre, tempo, mood, vocals, arrangement…" : "Describe the sounds and when they happen…",
  }[kind];

  // quality options
  const q = $("#quality"), prevQ = q.value;
  const opts = isH3Img
    ? [["draft", "Draft · 1 MP"], ["standard", "Standard · 2 MP"], ["high", "High · 4 MP"]]
    : isKlein
    ? [["draft", "Draft · 0.5 MP"], ["standard", "Standard · 1 MP"], ["high", "High · 2 MP"]]
    : [["draft", "Draft · 480p"], ["standard", "Standard · 576p"], ["full", "Full · 768p"]];
  q.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  q.value = opts.some(o => o[0] === prevQ) ? prevQ : (kind === "image" && isH3 ? "full" : opts[0][0]);

  // duration range
  const s = $("#seconds");
  const cur = +s.value;  // read before changing min/max, which clamps the value
  if (isMusic) { s.max = 300; s.min = 10; s.step = 5; s.value = cur < 10 ? 60 : cur; }
  else { s.min = 2; s.max = 15; s.step = 0.5; s.value = cur > 15 ? 5 : cur; }

  $("#tips").innerHTML = TIPS[isRef ? "h3ref" : isH3 ? "h3" : eng] || "";
  renderRefs();
  renderWriter();
  if (state.step === "loras") Loras.render();
  Shots.renderBanner?.();
  updateDerived();
  renderMissing();
  renderSteps();
  Prompts.refresh();
}

function updateDerived() {
  const kind = state.kind, eng = state.engine[kind];
  const sec = +$("#seconds").value;
  if ((eng === "h3" || eng === "h3ref") && kind !== "image") {
    const f = h3Frames(sec);
    $("#seconds-val").textContent = `${sec}s → ${f} frames (${(f / 24).toFixed(2)}s)`;
  } else {
    $("#seconds-val").textContent = sec >= 60 ? fmtDur(sec) : `${sec}s`;
  }
  let dims = "";
  if (kind !== "audio") {
    const mpTable = eng === "h3image" ? { draft: 1, standard: 2, high: 4 } : eng === "klein" || eng === "krea2" ? { draft: 0.5, standard: 1, high: 2 } : { draft: 0.4, standard: 0.6, full: 0.98 };
    const mp = mpTable[$("#quality").value] ?? 0.4;
    const kf = state.frames.first_frame || state.frames.last_frame;
    if (kind === "video" && eng === "h3" && kf?.w) {
      const [w, h] = dimsFor([kf.w, kf.h], mp);
      dims = `${w} × ${h} (from keyframe)`;
    } else {
      const [w, h] = dimsFor(ASPECT[$("#aspect").value] || [16, 9], mp, eng === "klein" || eng === "krea2" ? 16 : 32);
      dims = `${w} × ${h}`;
    }
  }
  $("#dims").textContent = dims;
  $("#dims").hidden = !dims;
  if (typeof Enhance !== "undefined") Enhance.renderAfter();
  const turbo = $("#turbo").checked;
  const refLora = state.caps?.engines?.h3ref?.files?.turbo_lora || "";
  const refTurboSteps = /8step/i.test(refLora) ? 8 : 4;
  const autoSteps = eng === "h3" ? (turbo ? 8 : 20) : eng === "h3ref" ? (turbo && refLora ? refTurboSteps : 20) : eng === "klein" ? 16 : eng === "krea2" ? 8 : eng === "h3image" ? 6 : 30;
  $("#steps-hint").textContent = `auto = ${autoSteps}`;
  postContext();
  scheduleSave();
  $("#turbo-note").textContent = eng === "h3ref"
    ? (refLora ? `${refTurboSteps} steps with the ref2v turbo LoRA` : "Ref2v turbo LoRA not installed: runs 20 steps")
    : "8 steps with the turbo LoRA (≈3× faster)";
  $("#steps").placeholder = `auto (${autoSteps})`;
  $("#steps").title = eng === "h3image" ? "MiniMax H3 Image is distilled for 6 steps; other counts interpolate its schedule" : "";
  const cfgDef = state.caps?.sampling_defaults?.[eng]?.cfg;
  $("#samp-nums").hidden = !state.caps?.sampling_defaults?.[eng];
  $("#cfg").placeholder = cfgDef != null ? `auto (${cfgDef})` : "auto";
  $("#cfg-hint").textContent = eng === "h3" || eng === "h3ref"
    ? "auto = no negative (BasicGuider). A value switches to a CFG guider with an empty negative, about 2× slower."
    : cfgDef != null ? `auto = ${cfgDef}${cfgDef === 1 ? " (distilled: higher burns the picture)" : ""}` : "auto";
}

function renderMissing() {
  const eng = state.engine[state.kind];
  const cap = state.caps?.engines?.[eng];
  const box = $("#missing");
  const btn = $("#btn-generate");
  if (!state.caps) { box.hidden = true; return; }
  if (cap && !cap.ready) {
    const files = cap.missing.map(m => m.on_disk
      ? `<li>${esc(m.label)} → found at <code>${esc(m.on_disk)}</code></li>`
      : `<li>${esc(m.label)} → <code>models/${esc(m.folder)}/${esc(m.want.replace("*", "…"))}</code></li>`).join("");
    const nodes = cap.missing_nodes?.length ? `<p>Missing nodes: <code>${cap.missing_nodes.map(esc).join(", ")}</code> — update ComfyUI.</p>` : "";
    const yaml = state.caps.model_paths?.[0];
    const how = cap.all_on_disk
      ? `<p>These files are on this PC, but the running ComfyUI doesn't load their folders${state.caps.comfyui_paths_config?.length ? ` (it was started with <code>${esc(state.caps.comfyui_paths_config[0])}</code>)` : ""}.
         Restart ComfyUI with <code>--extra-model-paths-config "${esc(yaml || "your extra_model_paths.yaml")}"</code>, then
         <button type="button" class="link" id="btn-recheck">check again</button>.</p>`
      : `Download from <a href="${esc(cap.source)}" target="_blank" rel="noopener">${esc(cap.source.replace("https://", ""))}</a>, then
         <button type="button" class="link" id="btn-recheck">check again</button>.`;
    box.innerHTML = `<strong>${esc(cap.title)} ${cap.all_on_disk ? "isn't loaded by ComfyUI." : "isn't installed."}</strong><ul>${files}</ul>${nodes}${how}`;
    box.hidden = false;
    $("#btn-recheck").onclick = () => loadCaps(true);
    btn.disabled = true;
  } else {
    box.hidden = true;
    btn.disabled = false;
  }
  btn.textContent = state.batch > 1 ? `Generate ${state.batch} takes` : "Generate";
}

function collectRequest() {
  const kind = state.kind, eng = state.engine[kind];
  const steps = $("#steps").value ? +$("#steps").value : null;
  const cfg = $("#cfg").value !== "" ? +$("#cfg").value : null;
  return {
    kind, engine: eng,
    prompt: Prompts.final($("#prompt").value),  // tags and {a|b} resolved, tidied for the model
    lyrics: $("#lyrics").value,
    aspect: $("#aspect").value,
    quality: $("#quality").value,
    seconds: +$("#seconds").value,
    seed: $("#seed").value === "" ? -1 : +$("#seed").value,
    turbo: $("#turbo").checked,
    enhance: $("#enhance").checked,
    steps,
    batch: state.batch,
    first_frame: kind === "video" && eng === "h3" ? state.frames.first_frame?.ref ?? null : null,
    last_frame: kind === "video" && eng === "h3" ? state.frames.last_frame?.ref ?? null : null,
    references: eng === "h3ref" || eng === "h3image" ? state.refs.map(r => r.ref) : [],
    ref_audios: eng === "h3ref" && kind === "video" ? state.arefs.map(a => a.ref) : [],
    clean_audio: $("#clean-audio").checked,
    max_fidelity: eng === "h3ref" && $("#fidelity").checked,
    loras: Loras.forRequest(),
    unet: state.unet[eng] || null,
    sampler: state.sampling[eng]?.sampler || null,
    cfg,
    scheduler: state.sampling[eng]?.scheduler || null,
    enhance_after: (kind === "video" || kind === "image") ? Enhance.after() : null,
    project: state.project?.id ?? null,
  };
}

function applyParams(p) {
  state.kind = p.kind; state.engine[p.kind] = p.engine;
  if (p.unet) state.unet[p.engine] = p.unet; else delete state.unet[p.engine];
  if (p.sampler || p.scheduler) state.sampling[p.engine] = { sampler: p.sampler || "", scheduler: p.scheduler || "" };
  else delete state.sampling[p.engine];
  renderForm();
  $("#prompt").value = p.prompt || "";
  $("#lyrics").value = p.lyrics || "";
  if (p.aspect) $("#aspect").value = p.aspect;
  if (p.quality) $("#quality").value = p.quality;
  if (p.seconds) $("#seconds").value = p.seconds;
  $("#turbo").checked = p.turbo !== false;
  $("#enhance").checked = !!p.enhance;
  $("#fidelity").checked = !!p.max_fidelity;
  if (p.engine === "h3ref") {
    state.refs = (p.references || []).map(r => ({ ref: r, url: mediaUrl(r) })); renderRefs();
    state.arefs = (p.ref_audios || []).map(r => ({ ref: r, url: mediaUrl(r), name: r.split("/").pop() })); renderArefs();
    $("#clean-audio").checked = p.clean_audio !== false;
  }
  $("#steps").value = p.steps ?? "";
  $("#cfg").value = p.cfg ?? "";
  for (const role of ["first_frame", "last_frame"]) {
    if (p[role]) setFrame(role, p[role], mediaUrl(p[role])); else clearFrame(role);
  }
  updateDerived();
}

/* Tell the server log what the page did: Generate presses and script errors, for when something "does nothing". */
function clientLog(msg) {
  try { fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg: String(msg).slice(0, 1900) }), keepalive: true }); } catch {}
}
window.addEventListener("error", e => clientLog(`Script error: ${e.message} at ${e.filename?.split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", e => clientLog(`Unhandled: ${e.reason?.stack || e.reason}`));

async function submit(req) {
  $("#form-error").textContent = "";
  const btn = $("#btn-generate");
  btn.disabled = true;
  try {
    const { items } = await api("/api/generate", { method: "POST", body: JSON.stringify(req) });
    for (const it of items) state.items.set(it.id, it);
    select(items[0].id);
    renderGallery(); renderQueue();
  } catch (e) {
    $("#form-error").textContent = e.message;
    Media.toast(`Generate: ${e.message}`);
    clientLog(`Generate refused: ${e.message}`);  // the error line is on the Generate step; Generate can be pressed from anywhere
  } finally {
    renderMissing();
  }
}

/* ------------------------------------------------------------------ keyframes */
function setFrame(role, ref, url) {
  const drop = $(`.drop[data-role="${role}"]`);
  const img = $("img", drop);
  state.frames[role] = { ref, url };
  img.onload = () => { state.frames[role].w = img.naturalWidth; state.frames[role].h = img.naturalHeight; updateDerived(); };
  img.src = url;
  drop.classList.add("has");
}
function clearFrame(role) {
  const drop = $(`.drop[data-role="${role}"]`);
  state.frames[role] = null;
  $("img", drop).removeAttribute("src");
  drop.classList.remove("has");
  updateDerived();
}
async function uploadFile(role, file) {
  const fd = new FormData(); fd.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (!res.ok) throw new Error(j.detail || res.statusText);
    setFrame(role, j.ref, j.url);
  } catch (e) { $("#form-error").textContent = e.message; }
}
function initDrops() {
  const input = $("#file-input");
  for (const drop of $$(".drop")) {
    const role = drop.dataset.role;
    drop.addEventListener("click", e => { if (e.target.classList.contains("x")) return; state.pickRole = role; input.click(); });
    drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); state.pickRole = role; input.click(); } });
    $(".x", drop).addEventListener("click", e => { e.stopPropagation(); clearFrame(role); });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => {
      e.preventDefault(); drop.classList.remove("over");
      const ref = e.dataTransfer.getData("text/x-bob-ref");
      if (ref) return setFrame(role, ref, e.dataTransfer.getData("text/x-bob-url") || mediaUrl(ref));
      const f = e.dataTransfer.files[0]; if (f) uploadFile(role, f);
    });
  }
  input.addEventListener("change", () => { const f = input.files[0]; if (f && state.pickRole) uploadFile(state.pickRole, f); input.value = ""; });
}

/* ------------------------------------------------------------------ references */
const MAX_REFS = 9;

function renderRefs() {
  const box = $("#refs");
  if (!box) return;
  postContext();
  scheduleSave();
  box.innerHTML = state.refs.map((r, i) => `
    <div class="ref">
      <img src="${esc(r.url)}" alt="Reference ${i + 1}">
      <button type="button" class="tag" data-i="${i}" title="Insert into prompt">Picture ${i + 1}</button>
      <button type="button" class="x" data-i="${i}" title="Remove">×</button>
    </div>`).join("")
    + (state.refs.length < MAX_REFS ? `<div class="ref-add" id="ref-add" tabindex="0" role="button">+ Add<br>picture</div>` : "");
  $$(".ref .x", box).forEach(b => b.onclick = () => { state.refs.splice(+b.dataset.i, 1); renderRefs(); });
  Prompts.renderBar?.();
  $$(".ref .tag", box).forEach(b => b.onclick = () => insertAtCursor($("#prompt"), `<Picture ${+b.dataset.i + 1}>`));
  const add = $("#ref-add");
  if (add) {
    add.onclick = () => $("#ref-input").click();
    add.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#ref-input").click(); } };
  }
}

function addRef(ref, url) {
  if (state.refs.length >= MAX_REFS) { $("#form-error").textContent = `Up to ${MAX_REFS} reference pictures.`; return; }
  state.refs.push({ ref, url });
  renderRefs();
}

async function uploadRefs(files) {
  for (const f of files) {
    if (state.refs.length >= MAX_REFS) break;
    const fd = new FormData(); fd.append("file", f);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail || res.statusText);
      addRef(j.ref, j.url);
    } catch (e) { $("#form-error").textContent = e.message; }
  }
}

function insertAtCursor(ta, text) {
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const pad = a > 0 && !/\s$/.test(value.slice(0, a)) ? " " : "";
  ta.value = value.slice(0, a) + pad + text + value.slice(b);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = a + pad.length + text.length;
}

function initRefs() {
  const input = $("#ref-input");
  input.addEventListener("change", () => { uploadRefs([...input.files]); input.value = ""; });
  const field = $("#f-refs");
  field.addEventListener("dragover", e => { e.preventDefault(); $("#ref-add")?.classList.add("over"); });
  field.addEventListener("dragleave", () => $("#ref-add")?.classList.remove("over"));
  field.addEventListener("drop", e => {
    e.preventDefault(); $("#ref-add")?.classList.remove("over");
    const ref = e.dataTransfer.getData("text/x-bob-ref");
    if (ref) return addRef(ref, e.dataTransfer.getData("text/x-bob-url") || mediaUrl(ref));
    uploadRefs([...e.dataTransfer.files]);
  });
}

/* ------------------------------------------------------------------ reference sounds (voice cloning) */
const MAX_AREFS = 3;

function renderArefs() {
  const box = $("#arefs");
  if (!box) return;
  scheduleSave();
  box.innerHTML = state.arefs.map((a, i) => `
    <div class="aref">
      <button type="button" class="tag" data-i="${i}" title="Insert into prompt">Audio ${i + 1}</button>
      <audio controls preload="metadata" src="${esc(a.url)}"></audio>
      <span class="aref-name" title="${esc(a.ref)}">${esc(a.name || a.ref.split("/").pop())}</span>
      <button type="button" class="x" data-i="${i}" title="Remove">×</button>
    </div>`).join("")
    + (state.arefs.length < MAX_AREFS ? `<button type="button" class="aref-add" id="aref-add">＋ Add a voice recording</button>` : "");
  $$(".aref .x", box).forEach(b => b.onclick = () => { state.arefs.splice(+b.dataset.i, 1); renderArefs(); });
  $$(".aref .tag", box).forEach(b => b.onclick = () => insertAtCursor($("#prompt"), `<Audio ${+b.dataset.i + 1}>`));
  const add = $("#aref-add");
  if (add) add.onclick = () => $("#aref-input").click();
  Prompts.renderBar?.();
  postContext();
}

function addAref(ref, url, name) {
  if (state.arefs.length >= MAX_AREFS) { $("#form-error").textContent = `Up to ${MAX_AREFS} reference sounds.`; return; }
  if (state.arefs.some(a => a.ref === ref)) return;
  state.arefs.push({ ref, url: url || mediaUrl(ref), name: name || ref.split("/").pop() });
  renderArefs();
}

async function uploadArefs(files) {
  for (const f of files) {
    if (state.arefs.length >= MAX_AREFS) break;
    if (!/^(audio|video)\//.test(f.type) && !/\.(mp3|wav|flac|ogg|m4a|aac|opus|mp4|webm|mov|mkv)$/i.test(f.name)) {
      $("#form-error").textContent = `${f.name} isn't a sound or video file.`; continue;
    }
    const fd = new FormData(); fd.append("file", f);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail || res.statusText);
      addAref(j.ref, j.url, f.name);
    } catch (e) { $("#form-error").textContent = e.message; }
  }
}

function initArefs() {
  const input = $("#aref-input");
  input.addEventListener("change", () => { uploadArefs([...input.files]); input.value = ""; });
  $("#btn-use-h3ref").onclick = () => { const prev = state.engine[state.kind]; state.engine.video = "h3ref"; renderForm(); scheduleSave(); Loras.checkFit(prev); };
  $("#clean-audio").addEventListener("change", () => scheduleSave());
  const field = $("#f-arefs");
  field.addEventListener("dragover", e => { e.preventDefault(); field.classList.add("over"); });
  field.addEventListener("dragleave", e => { if (!field.contains(e.relatedTarget)) field.classList.remove("over"); });
  field.addEventListener("drop", e => {
    e.preventDefault(); field.classList.remove("over");
    if (field.classList.contains("needs-ref")) { $("#form-error").textContent = "Switch to H3 Reference to use reference sounds."; return; }
    const ref = e.dataTransfer.getData("text/x-bob-ref");
    if (ref) {
      const kind = e.dataTransfer.getData("text/x-bob-kind") || (/\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(ref) ? "audio" : /\.(mp4|webm|mov|mkv)$/i.test(ref) ? "video" : "");
      if (kind !== "audio" && kind !== "video") { $("#form-error").textContent = "A reference sound is a sound file or a video with sound."; return; }
      return addAref(ref, e.dataTransfer.getData("text/x-bob-url") || mediaUrl(ref), e.dataTransfer.getData("text/x-bob-name") || "");
    }
    uploadArefs([...e.dataTransfer.files]);
  });
  renderArefs();
}

/* ------------------------------------------------------------------ Prompt Writer link */
// The writer (static/writer.html) runs in the top section's Writer pane (an iframe) or, popped out,
// in its own window. This channel tells it what the studio is set to and receives "Use in studio".
const studioChannel = new BroadcastChannel("bob-studio");
let contextTimer = null;
let writerWin = null;

function studioContext() {
  const pic = f => f ? { ref: f.ref, url: f.url } : null;
  return {
    kind: state.kind, engine: state.engine[state.kind],
    seconds: +$("#seconds").value, aspect: $("#aspect").value,
    references: state.refs.map(r => ({ ref: r.ref, url: r.url })),
    voices: state.engine.video === "h3ref" ? state.arefs.length : 0,  // <Audio N> is the voice of <Picture N>
    voice_names: state.engine.video === "h3ref" ? state.arefs.map(a => a.name || a.ref.split("/").pop()) : [],
    first_frame: state.engine.video === "h3" ? pic(state.frames.first_frame) : null,
    last_frame: state.engine.video === "h3" ? pic(state.frames.last_frame) : null,
    idea: $("#prompt").value,
  };
}
function postContext(now = false) {
  clearTimeout(contextTimer);
  const send = () => studioChannel.postMessage({ type: "context", ctx: studioContext() });
  if (now) send(); else contextTimer = setTimeout(send, 120);
}
studioChannel.onmessage = ({ data: msg }) => {
  if (msg?.type === "hello") postContext(true);
  else if (msg?.type === "set" && typeof msg.seconds === "number") {
    $("#seconds").value = msg.seconds; updateDerived(); Prompts.refresh();
  } else if (msg?.type === "use" && typeof msg.prompt === "string" && msg.quiet) {
    // The Shot writer in the Prompt tab keeps the prompt in step as you build the shot list.
    const p = $("#prompt");
    if (p.value === msg.prompt) return;
    if (writer.undo == null) {
      writer.undo = p.value;
      writerStatus(`The Shot writer is filling the prompt <button type="button" class="link" id="btn-undo-write">Undo</button>`);
      $("#btn-undo-write").onclick = () => { if (writer.undo != null) p.value = writer.undo; writer.undo = null; writerStatus(""); Prompts.setMode("text"); Prompts.refresh(); scheduleSave(); };
    }
    p.value = msg.prompt;
    if (typeof msg.seconds === "number" && +$("#seconds").value !== msg.seconds) { $("#seconds").value = msg.seconds; updateDerived(); }
    Prompts.refresh(); scheduleSave();
  } else if (msg?.type === "use" && typeof msg.prompt === "string") {
    const p = $("#prompt");
    writer.undo = p.value;
    p.value = msg.prompt;
    Prompts.refresh();
    if (typeof msg.seconds === "number") { $("#seconds").value = msg.seconds; updateDerived(); }
    writerStatus(`Prompt from the writer window <button type="button" class="link" id="btn-undo-write">Undo</button>`);
    $("#btn-undo-write").onclick = () => { if (writer.undo != null) p.value = writer.undo; writer.undo = null; writerStatus(""); };
    p.classList.remove("flash"); void p.offsetWidth; p.classList.add("flash");
    studioChannel.postMessage({ type: "used" });
  }
};
window.addEventListener("beforeunload", () => studioChannel.postMessage({ type: "bye" }));

function openWriterWindow() {
  if (writerWin && !writerWin.closed) { writerWin.focus(); postContext(true); return; }
  const w = Math.min(1400, screen.availWidth - 80), h = Math.min(950, screen.availHeight - 80);
  writerWin = window.open("/writer", "bob-writer", `popup,width=${w},height=${h}`);
  if (!writerWin) location.href = "/writer";  // popups blocked: open it here instead
}

/* ------------------------------------------------------------------ system check */
async function runSysCheck(show = false) {
  const chip = $("#st-sys");
  chip.className = "chip chip-btn"; chip.lastChild.textContent = "Checking…";
  if (show) { $("#sys-summary").textContent = "Checking…"; $("#sys-list").innerHTML = ""; }
  try {
    const r = await api("/api/syscheck");
    state.syscheck = r;
    const label = { ok: "System OK", warn: "System: warnings", fail: "System: problems" }[r.status];
    chip.className = "chip chip-btn " + (r.status === "ok" ? "ok" : r.status === "warn" ? "warn" : "bad");
    chip.lastChild.textContent = label;
    renderSysCheck();
    if (r.status === "fail" && !show && !WM.top()) openSysWindow();  // don't let a broken setup go unnoticed
  } catch (e) {
    chip.className = "chip chip-btn bad"; chip.lastChild.textContent = "System check failed";
    $("#sys-summary").textContent = e.message;
  }
}

function renderSysCheck() {
  const r = state.syscheck; if (!r) return;
  const counts = r.checks.reduce((a, c) => (a[c.status] = (a[c.status] || 0) + 1, a), {});
  $("#sys-summary").textContent = { ok: "Everything Bob Studio needs is in place.", warn: "Ready, with warnings.",
    fail: "Some checks failed; generation may not work until they're fixed." }[r.status]
    + ` ${counts.ok || 0} ok · ${counts.warn || 0} warning(s) · ${counts.fail || 0} failed · checked ${new Date(r.time * 1000).toLocaleTimeString()}`;
  const tag = { ok: "OK", warn: "WARN", fail: "FAIL", info: "INFO" };
  $("#sys-list").innerHTML = r.checks.map(c => `<li class="${esc(c.status)}"><span class="badge">${tag[c.status]}</span>
    <div><b>${esc(c.label)}</b><div class="detail">${esc(c.detail)}</div>${c.fix && c.status !== "ok" ? `<div class="fix">→ ${esc(c.fix)}</div>` : ""}</div></li>`).join("");
}

function initSysCheck() {
  $("#st-sys").onclick = openSysWindow;
  runSysCheck();
}

/* ------------------------------------------------------------------ prompt writer (local LLM) */
const WRITER_KEY = "bob.writer";
const writer = { backends: [], settings: {}, models: [], busy: false, undo: null, ticket: 0 };

function loadWriterSettings() {
  try { return JSON.parse(localStorage.getItem(WRITER_KEY) || "{}") || {}; } catch { return {}; }
}
function saveWriterSettings() {
  writer.settings = {
    backend: $("#llm-backend").value, model: $("#llm-model").value,
    urls: { ...(writer.settings.urls || {}), [$("#llm-backend").value]: $("#llm-url").value.trim() },
    shots: $("#llm-shots").value, dialogue: $("#llm-dialogue").checked,
  };
  try { localStorage.setItem(WRITER_KEY, JSON.stringify(writer.settings)); } catch {}
}

function writerSupported() {
  const eng = state.engine[state.kind];
  return eng === "h3ref" || (eng === "h3" && ["video", "image", "audio"].includes(state.kind));
}

function renderWriter() {
  const ok = writerSupported();
  $("#btn-write").hidden = !ok;
  $("#f-writer").hidden = !ok;
  Prompts.writerAvailable(ok);
  const multi = state.kind === "video";
  $("#llm-shots").closest(".row2").hidden = !multi;
}

async function initWriter() {
  writer.settings = loadWriterSettings();
  try {
    const j = await api("/api/llm/backends");
    writer.backends = j.backends;
    $("#llm-backend").innerHTML = j.backends.map(b => `<option value="${esc(b.key)}">${esc(b.label)}</option>`).join("");
    $("#llm-backend").value = writer.settings.backend || j.default;
  } catch (e) { $("#llm-hint").textContent = e.message; return; }
  $("#llm-shots").value = writer.settings.shots || "";
  $("#llm-dialogue").checked = !!writer.settings.dialogue;
  setWriterUrl();
  $("#llm-backend").onchange = () => { setWriterUrl(); saveWriterSettings(); loadLlmModels(); };
  $("#btn-llm-connect").onclick = () => { saveWriterSettings(); loadLlmModels(); };
  $("#llm-url").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); saveWriterSettings(); loadLlmModels(); } };
  $("#llm-model").onchange = () => { saveWriterSettings(); writerSummary(); };
  $("#llm-shots").onchange = saveWriterSettings;
  $("#llm-dialogue").onchange = saveWriterSettings;
  $("#btn-write").onclick = writePrompt;
  loadLlmModels();
}

function setWriterUrl() {
  const key = $("#llm-backend").value;
  const def = writer.backends.find(b => b.key === key)?.url || "";
  $("#llm-url").value = writer.settings.urls?.[key] || def;
  $("#llm-url").placeholder = def;
}

function writerSummary() {
  const b = writer.backends.find(x => x.key === $("#llm-backend").value);
  const m = $("#llm-model").value;
  $("#writer-summary").textContent = m ? `· ${m} via ${b?.key === "ollama" ? "Ollama" : "local server"}` : "· not connected";
}

async function loadLlmModels() {
  const backend = $("#llm-backend").value, url = $("#llm-url").value.trim();
  const ticket = ++writer.ticket;  // only the latest attempt may update the list
  $("#llm-hint").textContent = "Connecting…";
  const sel = $("#llm-model");
  try {
    const j = await api(`/api/llm/models?backend=${encodeURIComponent(backend)}&url=${encodeURIComponent(url)}`);
    if (ticket !== writer.ticket) return;
    writer.models = j.models;
    if (!j.ok) {
      sel.innerHTML = ""; $("#llm-hint").textContent = j.error +
        (backend === "ollama" ? " Start Ollama, or switch to a local LLM server." : " Start llama-server / LM Studio, or check the URL.");
    } else {
      sel.innerHTML = j.models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.params ? ` · ${esc(m.params)}` : ""}${m.vision ? " · sees images" : ""}</option>`).join("");
      const saved = writer.settings.backend === backend ? writer.settings.model : null;
      sel.value = j.models.some(m => m.name === saved) ? saved : j.default;
      $("#llm-hint").textContent = backend === "ollama"
        ? "Models that see images also read your keyframes and reference pictures. Ollama unloads the model after each prompt to free VRAM for H3."
        : "Any OpenAI-compatible server (llama.cpp llama-server, LM Studio, vLLM). For pictures, run a vision model (llama-server --mmproj)."
          + (writer.backends.find(b => b.key === "openai")?.api_key ? " API key from .env is sent only to the server URL set there." : "");
    }
  } catch (e) { if (ticket !== writer.ticket) return; sel.innerHTML = ""; $("#llm-hint").textContent = e.message; }
  writerSummary();
}

function writerStatus(html, busy = false) {
  const el = $("#writer-status");
  el.innerHTML = html; el.hidden = !html; el.classList.toggle("busy", busy);
}

async function writePrompt() {
  if (writer.busy) return;
  const idea = $("#prompt").value.trim();
  if (!idea) { writerStatus(`<span class="warn">Type a short idea in the prompt box first, e.g. “a fisherman at dawn pulls up a glowing net”.</span>`); $("#prompt").focus(); return; }
  if (!$("#llm-model").value) { $("#f-writer").open = true; writerStatus(`<span class="warn">Connect to an LLM first.</span>`); return; }
  const kind = state.kind, eng = state.engine[kind];
  const body = {
    kind, engine: eng, idea,
    seconds: +$("#seconds").value, aspect: $("#aspect").value,
    shots: kind === "video" && $("#llm-shots").value ? +$("#llm-shots").value : null,
    dialogue: $("#llm-dialogue").checked,
    first_frame: kind === "video" && eng === "h3" ? state.frames.first_frame?.ref ?? null : null,
    last_frame: kind === "video" && eng === "h3" ? state.frames.last_frame?.ref ?? null : null,
    references: eng === "h3ref" || eng === "h3image" ? state.refs.map(r => r.ref) : [],
    backend: $("#llm-backend").value, url: $("#llm-url").value.trim(), model: $("#llm-model").value,
    creativity: Prompts.creativity(),
  };
  writer.busy = true;
  $("#btn-write").disabled = true;
  const pics = body.references.length + (body.first_frame ? 1 : 0) + (body.last_frame ? 1 : 0);
  writerStatus(`Writing with ${esc(body.model)}${pics ? ` · looking at ${pics} picture${pics > 1 ? "s" : ""}` : ""}…`, true);
  try {
    const r = await api("/api/prompt/write", { method: "POST", body: JSON.stringify(body) });
    writer.undo = idea;
    $("#prompt").value = r.prompt;
    Prompts.refresh();
    const notes = [`Written by ${esc(r.model)} at ${r.creativity ?? body.creativity}% creativity in ${r.seconds}s`];
    if (pics) notes.push(r.vision ? `saw ${pics} picture${pics > 1 ? "s" : ""}` : `<span class="warn">this model can't see pictures</span>`);
    if (r.warnings?.length) notes.push(`<span class="warn" title="${esc(r.warnings.join("\n"))}">${r.warnings.length} rule${r.warnings.length > 1 ? "s" : ""} not met: check it</span>`);
    writerStatus(notes.join(" · ") + ` <button type="button" class="link" id="btn-undo-write">Undo</button>`);
    $("#btn-undo-write").onclick = () => { if (writer.undo != null) $("#prompt").value = writer.undo; writer.undo = null; writerStatus(""); };
  } catch (e) {
    writerStatus(`<span class="warn">${esc(e.message)}</span>`);
  } finally {
    writer.busy = false;
    $("#btn-write").disabled = false;
  }
}

/* ------------------------------------------------------------------ gallery */
function itemsSorted() { return [...state.items.values()].sort((a, b) => b.created - a.created); }
const isBusy = it => ["submitting", "queued", "running"].includes(it.status);

function thumbHTML(it) {
  const f = it.files?.[0];
  if (it.status === "done" && f) {
    // Cached WebP thumbnails (a frame for video, a waveform for sound); the full file loads in the viewer.
    const th = `/api/media/thumb?path=${encodeURIComponent(f.path)}&w=320&v=${Math.round(it.finished || it.created)}`;
    const fallback = it.kind === "audio" ? waveHTML(it.id, 22) : `<span class="state">${it.kind === "video" ? "▶" : "🖼"}</span>`;
    return `<img src="${th}" alt="" loading="lazy" decoding="async" onerror="this.outerHTML=${esc(JSON.stringify(fallback))}">${it.kind === "video" ? `<span class="tile-kind">▶</span>` : ""}`;
  }
  if (isBusy(it)) {
    const pv = state.previews.get(it.id);
    if (pv) return `<img src="${pv}" alt="">`;
    return `<span class="state">${it.status === "running" ? "Rendering…" : it.status === "queued" ? "Queued" : "Submitting…"}</span>`;
  }
  return `<span class="state failed">${it.status === "cancelled" ? "Cancelled" : "Failed"}</span>`;
}

function renderGallery() { Bin.render(); }

function patchTile(id) { Bin.patch(id); }

/* ------------------------------------------------------------------ queue */
function renderQueue() {
  const q = $("#queue");
  const active = itemsSorted().filter(isBusy).reverse();
  q.innerHTML = active.map(it => {
    const p = state.progress.get(it.id);
    const pct = Math.round((p?.value ?? 0) * 100);
    const step = p?.steps ? ` · step ${p.step}/${p.steps}` : "";
    const label = it.status === "running" ? `${pct}%${step}` : it.status;
    return `<div class="q-item" data-id="${it.id}">
      <span class="q-title"><b>${esc(engineName(it.kind, it.engine))}</b> · ${esc(label)} — ${esc((it.params.prompt || "").slice(0, 60))}</span>
      <button class="btn ghost sm" data-log="${it.id}" title="Log, progress and time left">Log</button>
      <button class="btn ghost sm danger" data-cancel="${it.id}">Cancel</button>
      <div class="bar ${it.status === "running" && !pct ? "indeterminate" : ""}"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  $$("[data-cancel]", q).forEach(b => b.onclick = () => cancel(b.dataset.cancel));
  $$("[data-log]", q).forEach(b => b.onclick = () => Activity.show(b.dataset.log));
}

async function cancel(id) { try { await api(`/api/items/${id}/cancel`, { method: "POST" }); } catch (e) { alert(e.message); } }

/* ------------------------------------------------------------------ viewer */
function select(id) {
  state.selected = id;
  $$(".tile").forEach(t => t.classList.toggle("selected", t.dataset.id === id));
  Monitor.show("result");
  renderViewer();
}

/* Result viewer zoom: the wheel zooms the picture at the pointer (fit .. 16x of fit), scroll bars
   and dragging move around a zoomed picture, double-click goes back to fit. */
/* Result zoom for pictures and videos. "Fit" (the default) scales the result with the viewer, so dragging the bar
   above the timeline makes it smaller or bigger; a fixed zoom (100%, or −/+ and the mouse wheel) keeps that size and
   scrolls instead. The choice is remembered for the next result. Double-click a picture, or press Z, to switch
   Fit / 100%. */
const MediaZoom = (() => {
  const MIN = 0.05, MAX = 16, STEP = 1.2;
  const readUi = () => { try { return JSON.parse(localStorage.getItem("bob.ui") || "{}") || {}; } catch { return {}; } };
  const saveScale = s => { try { localStorage.setItem("bob.ui", JSON.stringify({ ...readUi(), resultZoom: s })); } catch {} };
  let ro = null, current = null;  // current: the viewer's zoom, for the Z key
  function attach(wrap, ctl) {
    const el = wrap.querySelector("img, video"), video = el.tagName === "VIDEO";
    let scale = typeof readUi().resultZoom === "number" ? readUi().resultZoom : null;  // null = Fit
    let drag = null;
    const nat = () => video ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
    const ready = () => nat()[0] > 0;
    const fitScale = () => { const [w, h] = nat(); return Math.min(wrap.clientWidth / w, wrap.clientHeight / h, 1); };
    const shown = () => scale ?? fitScale();
    function label() {
      if (!ctl) return;
      const pct = ready() ? `${Math.round(shown() * 100)}%` : "";
      const lb = ctl.querySelector("[data-z=toggle]");
      lb.textContent = scale == null ? `Fit${pct ? ` · ${pct}` : ""}` : pct;
      lb.setAttribute("aria-pressed", String(scale == null));
      lb.title = scale == null ? "Fit: the result scales with the viewer. Click or press Z for actual size (100%)" : "Fixed zoom: the result keeps this size. Click or press Z to fit the viewer";
    }
    // cx/cy: the screen point that stays put (the pointer, or the viewer's centre).
    function apply(ns, cx, cy, persist = true) {
      if (!ready()) { scale = ns; label(); return; }
      const wr = wrap.getBoundingClientRect(), er = el.getBoundingClientRect();
      cx ??= wr.left + wr.width / 2; cy ??= wr.top + wr.height / 2;
      const fx = er.width ? (cx - er.left) / er.width : .5, fy = er.height ? (cy - er.top) / er.height : .5;
      scale = ns == null ? null : Math.min(MAX, Math.max(MIN, ns));
      if (scale != null && Math.abs(scale - fitScale()) < 0.005 && fitScale() < 1) scale = null;  // zoomed back to the fit size
      wrap.classList.toggle("zoomed", scale != null);
      const [w, h] = nat();
      if (scale == null) el.style.width = el.style.height = "";
      else {
        el.style.width = `${Math.round(w * scale)}px`; el.style.height = `${Math.round(h * scale)}px`;
        wrap.scrollLeft = el.offsetLeft + fx * el.offsetWidth - (cx - wr.left);
        wrap.scrollTop = el.offsetTop + fy * el.offsetHeight - (cy - wr.top);
      }
      if (persist) saveScale(scale);
      label();
    }
    const step = dir => apply(shown() * Math.pow(STEP, dir));
    current = { wrap, toggle: () => apply(scale == null ? 1 : null) };
    el.addEventListener(video ? "loadedmetadata" : "load", () => apply(scale, undefined, undefined, false));
    if (ready()) apply(scale, undefined, undefined, false); else label();
    wrap.addEventListener("wheel", e => {
      if (!ready()) return;
      e.preventDefault();
      // One mouse-wheel notch (about 100 px) is one step; touchpads send many small deltas.
      const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
      apply(shown() * Math.pow(STEP, -Math.max(-300, Math.min(300, px)) / 100), e.clientX, e.clientY);
    }, { passive: false });
    if (!video) wrap.addEventListener("dblclick", e => apply(scale == null ? 1 : null, e.clientX, e.clientY));
    wrap.addEventListener("pointerdown", e => {
      if (scale == null || e.button !== 0) return;
      // A video's own controls (play, the scrubber, volume) sit along its bottom: leave those clicks alone.
      if (video && e.clientY > el.getBoundingClientRect().bottom - 48) return;
      if (wrap.scrollWidth <= wrap.clientWidth && wrap.scrollHeight <= wrap.clientHeight) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop, moved: false };
      wrap.setPointerCapture(e.pointerId); wrap.classList.add("panning");
    });
    wrap.addEventListener("pointermove", e => {
      if (!drag) return;
      wrap.scrollLeft = drag.l - (e.clientX - drag.x); wrap.scrollTop = drag.t - (e.clientY - drag.y);
    });
    const end = () => { drag = null; wrap.classList.remove("panning"); };
    wrap.addEventListener("pointerup", end); wrap.addEventListener("pointercancel", end);
    if (ctl) ctl.onclick = e => {
      const z = e.target.closest("[data-z]")?.dataset.z;
      if (z === "out") step(-1);
      else if (z === "in") step(1);
      else if (z === "toggle") apply(scale == null ? 1 : null);
    };
    // The viewer changes size with the bar above the timeline, the gallery and the window: keep the Fit % current.
    ro?.disconnect();
    ro = new ResizeObserver(() => { if (wrap.isConnected) label(); else ro.disconnect(); });
    ro.observe(wrap);
  }
  // Z: Fit <-> 100% for the result in the viewer (when one is showing).
  function toggle() {
    if (!current?.wrap.isConnected || current.wrap.closest("[hidden]")) return false;
    current.toggle();
    return true;
  }
  return { attach, toggle };
})();

/* The selected result's details: a summary (stars, facts, quick buttons) in the viewer's header, and the prompt,
   tags and every control in a panel that drops down over the viewer (ℹ Details, Alt+I), so the viewer keeps
   its whole height and the top section can be made smaller for the timeline. */
const Info = {
  open: (() => { try { return !!(JSON.parse(localStorage.getItem("bob.ui") || "{}") || {}).info; } catch { return false; } })(),
  set(on) {
    this.open = !!on;
    try { const u = JSON.parse(localStorage.getItem("bob.ui") || "{}") || {}; u.info = this.open; localStorage.setItem("bob.ui", JSON.stringify(u)); } catch {}
    this.sync();
  },
  sync() {
    const show = Monitor.mode !== "timeline" && !!state.items.get(state.selected);
    $("#meta").hidden = !(show && this.open);
    $("#mon-bar").hidden = !show;
    $("#btn-info").hidden = !show;
    $("#btn-info").setAttribute("aria-expanded", String(this.open));
  },
};

function renderViewer() {
  const it = state.items.get(state.selected);
  const viewer = $("#viewer"), meta = $("#meta");
  if (!it) { $("#viewer-empty").hidden = false; [...viewer.children].forEach(c => c.id !== "viewer-empty" && c.remove()); Info.sync(); return; }
  $("#viewer-empty").hidden = true;
  [...viewer.children].forEach(c => c.id !== "viewer-empty" && c.remove());

  const f = it.files?.[0];
  let html = "";
  if (it.status === "done" && f) {
    // No autoplay: the viewer often changes on its own (a project opens, a result finishes),
    // and sound must never start without the user pressing play.
    const zoomCtl = `<div class="zoom-ctl" role="group" aria-label="Zoom">
      <button type="button" data-z="out" title="Zoom out (or the mouse wheel)" aria-label="Zoom out">−</button>
      <button type="button" data-z="toggle" class="zc-label">Fit</button>
      <button type="button" data-z="in" title="Zoom in (or the mouse wheel)" aria-label="Zoom in">+</button></div>`;
    if (it.kind === "video") html = `<div class="zoom-wrap" title="Wheel: zoom at the pointer · drag: move when zoomed">
      <video class="media" src="${esc(f.url)}" controls playsinline preload="metadata"></video></div>${zoomCtl}`;
    else if (it.kind === "image") html = `<div class="zoom-wrap" title="Wheel: zoom at the pointer · drag: move · double-click: Fit / 100%">
      <img class="media" src="${esc(f.url)}" alt="" draggable="false"></div>${zoomCtl}`;
    else html = `<div class="audio-card">${waveHTML(it.id, 48)}<audio src="${esc(f.url)}" controls preload="metadata"></audio></div>`;
  } else if (isBusy(it)) {
    const pv = state.previews.get(it.id) || mediaUrl(it.params.first_frame || it.params.references?.[0]);
    html = `<div class="live">${pv ? `<img id="live-img" src="${pv}" alt="">` : ""}
      <div class="live-overlay"><div class="row"><span id="live-label"></span><span id="live-pct"></span></div>
      <div class="bar" id="live-bar"><i></i></div></div></div>`;
  } else {
    html = `<div class="failed-box"><b>${it.status === "cancelled" ? "Cancelled" : "Generation failed"}</b>\n\n${esc(it.error || "")}</div>`;
  }
  viewer.insertAdjacentHTML("beforeend", html);
  if (isBusy(it)) updateLive(it.id);
  const zw = viewer.querySelector(".zoom-wrap");
  if (zw) MediaZoom.attach(zw, viewer.querySelector(".zoom-ctl"));

  // meta
  const info = it.info || {};
  const facts = [
    engineName(it.kind, it.engine),
    info.width ? `${info.width}×${info.height}` : null,
    info.seconds ? `${info.seconds}s` : it.kind === "audio" && it.params.seconds ? `${it.params.seconds}s` : null,
    info.frames && it.kind === "video" ? `${info.frames} frames` : null,
    info.steps ? `${info.steps} steps${info.turbo ? " · turbo" : ""}` : null,
    info.enhanced ? "enhanced prompt" : null,
    `seed ${it.seed}`,
    it.finished && it.created ? `took ${fmtDur(it.finished - it.created)}` : null,
  ].filter(Boolean);
  const canFrame = it.kind === "image" && it.status === "done" && f;
  const bm = Bin.meta(it);
  const rated = it.status === "done" && f;
  const bar = $("#mon-bar");
  bar.innerHTML = `${rated ? `<span class="b-stars">${[1, 2, 3, 4, 5].map(i => `<button type="button" class="b-star${i <= bm.rating ? " on" : ""}" data-r="${i}" title="${i} star${i > 1 ? "s" : ""} (key ${i})">★</button>`).join("")}</span>` : ""}
    <span class="mb-facts" title="${esc(facts.join(" · "))}">${esc(facts.join(" · "))}</span>
    ${isBusy(it) ? `<button type="button" class="btn sm danger" data-a="cancel">Cancel</button>` : ""}
    ${rated ? `<button type="button" class="btn sm primary-soft" data-a="timeline" title="Add to the end of the timeline (Enter)">＋ Timeline</button>` : ""}`;
  $$("[data-a]", bar).forEach(b => b.onclick = () => action(b.dataset.a, it));
  $$("[data-r]", bar).forEach(b => b.onclick = () => Bin.rate(it, +b.dataset.r));
  const rateRow = rated ? `<div class="meta-rate">
      <span class="meta-tags">${bm.tags.map(t => `<i class="mg-tag on" style="--c:${Media.tagColor(t)}">${esc(t)}</i>`).join("")}</span>
      <button type="button" class="link" data-a="tags">🏷 ${bm.tags.length ? "Edit tags" : "Add tags"}</button></div>` : "";
  meta.innerHTML = `
    ${rateRow}
    <div class="facts">${facts.map(x => `<span>${esc(x)}</span>`).join("")}</div>
    <div class="prompt-text">${esc(it.params.prompt)}${it.params.lyrics && it.engine === "music3" ? "\n\n" + esc(it.params.lyrics) : ""}</div>
    <div class="actions">
      ${isBusy(it) ? `<button class="btn danger" data-a="cancel">Cancel</button>` : ""}
      ${it.status === "done" && f ? `<button class="btn primary-soft" data-a="timeline" title="Add to the end of the timeline (Enter)">＋ Timeline</button>` : ""}
      ${!["enhance", "angles", "imgedit"].includes(it.engine) ? `<button class="btn" data-a="reuse">Reuse settings</button>` : ""}
      ${it.engine !== "timeline" && !(it.engine === "imgedit" && it.params?.edit_op === "adjust") ? `<button class="btn" data-a="reroll">Re-roll</button>` : ""}
      ${it.status === "done" && f && (it.kind === "video" || it.kind === "image") ? `<button class="btn" data-a="enhance" title="FaceRefine, DLSS 5, SeedVR2 or RelayVSR">✨ Enhance…</button>` : ""}
      ${it.status === "done" && f && it.kind === "image" ? `<button class="btn" data-a="edit" title="Crop, resize, colors, and AI: select, erase, replace, change with a prompt, remove the background">✏ Edit</button>` : ""}
      ${it.status === "done" && f && it.kind === "image" ? `<button class="btn" data-a="angles" title="Re-shoot this picture from other camera angles (Qwen Image Edit)">🔄 Angles…</button>` : ""}
      ${canFrame ? `<button class="btn" data-a="first">→ First frame</button><button class="btn" data-a="last">→ Last frame</button><button class="btn" data-a="ref">→ Reference</button>` : ""}
      ${f ? `<a class="btn" href="${esc(f.url)}" download="${esc(f.name)}">Download</a>` : ""}
      ${it.engine !== "timeline" && it.status !== "submitting" ? `<button class="btn" data-a="workflow" title="The exact ComfyUI workflow this was made with: compare it with yours, or load it in ComfyUI">{ } Workflow</button>` : ""}
      <button class="btn ghost danger" data-a="delete">Delete</button>
    </div>`;
  Info.sync();
  $$("[data-a]", meta).forEach(b => b.onclick = () => action(b.dataset.a, it));
}

function updateLive(id) {
  if (id !== state.selected) return;
  const it = state.items.get(id), p = state.progress.get(id);
  const label = $("#live-label"); if (!label) return;
  const pct = Math.round((p?.value ?? 0) * 100);
  label.textContent = it.status === "running"
    ? (p?.steps ? `Sampling · step ${p.step}/${p.steps}` : "Loading models / encoding…")
    : it.status === "queued" ? "Waiting in ComfyUI queue…" : "Submitting…";
  $("#live-pct").textContent = it.status === "running" ? `${pct}%` : "";
  const bar = $("#live-bar");
  bar.classList.toggle("indeterminate", it.status !== "running" || !pct);
  $("i", bar).style.width = `${pct}%`;
  const pv = state.previews.get(id);
  if (pv) {
    let img = $("#live-img");
    if (!img) { $(".live").insertAdjacentHTML("afterbegin", `<img id="live-img" alt="">`); img = $("#live-img"); }
    img.src = pv;
  }
}

async function action(a, it) {
  if (a === "cancel") return cancel(it.id);
  if (a === "timeline") return Bin.toTimeline(it);
  if (a === "tags") return Bin.tags(it);
  if (a === "reuse") {
    applyParams(it.params); $("#seed").value = it.seed;
    // Video: the result's prompt comes back as a new shot with its own prompt, so the shot list isn't replaced.
    if (it.params?.kind === "video" && it.params.prompt) { const i = Shots.reuse(it.params.prompt, it.params.seconds); scheduleSave(); showStep("shots"); Shots.openModal(i); return; }
    scheduleSave(); showStep("prompt"); return;
  }
  if (a === "reroll") return submit({ ...it.params, seed: -1, batch: 1 });
  if (a === "enhance") return Enhance.dialog(it);
  if (a === "edit") return Editor.open(it);
  if (a === "workflow") return workflowDialog(it);
  if (a === "angles") { const f = it.files[0]; return Angles.dialog({ ref: f.path, url: f.url, name: f.name }); }
  if (a === "ref") {
    const prev = state.engine[state.kind];
    state.kind = "video"; state.engine.video = "h3ref";
    if (prev !== "h3ref") Loras.checkFit(prev);
    addRef(it.files[0].path, it.files[0].url); renderForm();
    showStep("inputs");
    return;
  }
  if (a === "first" || a === "last") {
    const prev = state.engine[state.kind];
    state.kind = "video"; state.engine.video = "h3"; renderForm();
    if (prev !== "h3") Loras.checkFit(prev);
    setFrame(a === "first" ? "first_frame" : "last_frame", it.files[0].path, it.files[0].url);
    showStep("inputs");
    return;
  }
  if (a === "delete") {
    if (Settings.get("generation.confirm_delete", true) && !confirm("Delete this item and its file from disk? This can't be undone.")) return;
    try { await api(`/api/items/${it.id}?files=true`, { method: "DELETE" }); } catch (e) { alert(e.message); }
  }
}

/* ------------------------------------------------------------------ live events */
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    Activity.onEvent(ev);
    if (ev.type === "item") { TL.onItem?.(ev.item); Shots.onItem(ev.item); Enhance.onItem(ev.item); }
    if (ev.type === "item") {
      const prev = state.items.get(ev.item.id);
      state.items.set(ev.item.id, ev.item);
      if (!isBusy(ev.item)) { state.previews.delete(ev.item.id); state.progress.delete(ev.item.id); }
      if (!prev || prev.status !== ev.item.status) {
        if (prev && isBusy(prev) && ["done", "failed"].includes(ev.item.status)) Settings.jobFinished(ev.item);
        renderGallery(); renderQueue();
        if (ev.item.status === "done") Media.refreshSource();
        if (ev.item.id === state.selected) renderViewer();
      }
    } else if (ev.type === "progress") {
      state.progress.set(ev.id, ev);
      patchTile(ev.id); renderQueue(); updateLive(ev.id);
    } else if (ev.type === "preview") {
      state.previews.set(ev.id, ev.src);
      patchTile(ev.id); updateLive(ev.id);
    } else if (ev.type === "deleted") {
      state.items.delete(ev.id);
      if (state.selected === ev.id) state.selected = null;
      renderGallery(); renderViewer(); renderQueue();
    }
  };
}

/* ------------------------------------------------------------------ status */
async function pollStatus() {
  try {
    const s = await api("/api/status");
    if (s.version) $("#app-version").textContent = `· v${s.version}`;
    // The studio updated itself (Settings › Updates) and restarted: this page still runs the old scripts.
    if (s.version && state.serverVersion && s.version !== state.serverVersion) offerReload(s.version);
    state.serverVersion ||= s.version;
    $("#st-comfy").className = "chip " + (s.comfyui ? "ok" : "bad");
    $("#st-comfy").lastChild.textContent = s.comfyui ? `ComfyUI ${s.comfyui_version || ""}` : "ComfyUI offline";
    $("#st-proxy").className = "chip " + (s.proxy ? "ok" : "bad");
    if (s.gpu) {
      const used = (s.gpu.vram_total - s.gpu.vram_free) / 2 ** 30, tot = s.gpu.vram_total / 2 ** 30;
      $("#st-gpu").textContent = `${s.gpu.name} · ${used.toFixed(1)}/${tot.toFixed(0)} GB`;
    }
    const q = s.queue || { running: 0, pending: 0 };
    Activity.setQueue(q);
    if (s.comfyui && !state.caps) loadCaps();
  } catch {
    $("#st-comfy").className = "chip bad";
  }
}

function offerReload(v) {
  if ($("#update-bar")) return;
  const bar = document.createElement("div");
  bar.id = "update-bar"; bar.className = "update-bar"; bar.setAttribute("role", "status");
  bar.innerHTML = `<span>Bob Studio updated to <b>v${esc(v)}</b>. Reload the page to use it.</span>
    <button type="button" class="btn sm primary">Reload</button>`;
  bar.querySelector("button").onclick = () => location.reload();
  document.body.appendChild(bar);
}

async function loadCaps(refresh = false) {
  try {
    state.caps = await api(`/api/capabilities${refresh ? "?refresh=true" : ""}`);
    const aspect = $("#aspect").value;
    $("#aspect").innerHTML = state.caps.aspects.map(a => `<option>${a}</option>`).join("");
    if (state.caps.aspects.includes(aspect)) $("#aspect").value = aspect;
    renderForm();
  } catch (e) {
    $("#form-error").textContent = e.message;
  }
}

/* ------------------------------------------------------------------ init */
function init() {
  $$("#filter-seg button").forEach(b => b.onclick = () => {
    state.filter = b.dataset.f;
    $$("#filter-seg button").forEach(x => x.classList.toggle("active", x === b));
    renderGallery();
  });
  $$("#batch-seg button").forEach(b => b.onclick = () => {
    state.batch = +b.dataset.v;
    $$("#batch-seg button").forEach(x => x.classList.toggle("active", x === b));
    renderMissing();
    scheduleSave();
  });
  ["#seconds", "#quality", "#aspect", "#turbo"].forEach(s => $(s).addEventListener("input", updateDerived));
  $("#btn-dice").onclick = () => { $("#seed").value = -1; };
  $("#btn-template").onclick = () => {
    const t = TEMPLATES[curKey()]; if (!t) return;
    const p = $("#prompt");
    p.value = p.value.trim() ? p.value.trimEnd() + "\n\n" + t : t;
    p.focus();
    Prompts.refresh();
  };
  $("#btn-tips").onclick = () => { $("#tips").hidden = !$("#tips").hidden; };
  $("#btn-free").onclick = async () => {
    const b = $("#btn-free"); b.disabled = true; b.textContent = "Freeing…";
    try { await api("/api/free", { method: "POST" }); } catch {}
    b.disabled = false; b.textContent = "Free VRAM"; pollStatus();
  };
  $("#form").addEventListener("submit", e => {
    e.preventDefault();
    try {
      const where = `${state.kind}:${state.engine[state.kind]} step=${state.step} prompt=${$("#prompt").value.length} chars`;
      if (Shots.on()) { clientLog(`Generate → Shots (${where})`); Shots.generate(collectRequest()); return; }
      if (!Prompts.readyToGenerate()) { clientLog(`Generate stopped before sending (${where})`); return; }
      clientLog(`Generate → sending (${where})`);
      submit(collectRequest());
    } catch (err) {
      clientLog(`Generate failed in the page: ${err?.stack || err}`);
      Media.toast(`Generate: ${err?.message || err}`);
    }
  });
  $("#prompt").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#form").requestSubmit(); } });
  initDrops();
  initRefs();
  Loras.initStep();
  Shots.init();
  Enhance.initSettings();
  $("#btn-goto-shots").onclick = () => showStep("shots");
  initArefs();
  initWriter();
  Prompts.init();
  initSysCheck();
  TL.mount($("#timeline"));
  Bin.init();
  Layout.init();
  $$("#mon-seg button").forEach(b => b.onclick = () => Monitor.show(b.dataset.m));
  $("#btn-info").onclick = () => Info.set(!Info.open);
  addEventListener("keydown", e => {
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "i" && !e.target.closest?.("input, textarea, select")) { e.preventDefault(); Info.set(!Info.open); }
    if (e.key === "Escape" && Info.open && e.target.closest?.("#meta")) { Info.set(false); $("#btn-info").focus(); }
    if ((e.key === "z" || e.key === "Z") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
        && !e.target.closest?.("input, textarea, select, [contenteditable], .wm-win") && !document.querySelector(".wm-backdrop")
        && !(typeof Editor !== "undefined" && Editor.isOpen()) && Monitor.mode !== "timeline" && MediaZoom.toggle()) e.preventDefault();
  });
  $("#pw-pop").onclick = () => { Prompts.setMode("text"); openWriterWindow(); };
  $("#btn-media").onclick = () => Media.openWindow();
  $("#prompt").addEventListener("input", () => postContext());
  $("#aspect").innerHTML = Object.keys(ASPECT).map(a => `<option>${a}</option>`).join("");
  renderForm();
  Settings.load().finally(initShell);  // the app settings decide e.g. whether the last project reopens
  $("#btn-menu").onclick = openMainMenu;

  api("/api/items").then(({ items }) => {
    for (const it of items) state.items.set(it.id, it);
    Activity.load(items.slice(0, 40));
    renderGallery(); renderQueue();
    if (state.shellReady) selectInScope();  // otherwise initShell does it once the project is open
  });
  connectEvents();
  pollStatus();
  setInterval(pollStatus, 5000);
}

/* The exact ComfyUI workflow (API format) a result was made with. */
async function workflowDialog(it) {
  let text;
  try {
    const r = await fetch(`/api/items/${it.id}/workflow`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    text = JSON.stringify(await r.json(), null, 2);
  } catch (e) { return Media.toast(e.message); }
  const g = JSON.parse(text);
  const pick = t => Object.values(g).filter(n => n.class_type === t).map(n => n.inputs);
  const ks = pick("KSampler")[0], sel = pick("KSamplerSelect")[0], sch = pick("BasicScheduler")[0], guide = pick("CFGGuider")[0];
  const sum = ks ? [["Sampler", ks.sampler_name], ["Scheduler", ks.scheduler], ["Steps", ks.steps], ["CFG", ks.cfg], ["Denoise", ks.denoise], ["Seed", ks.seed]]
    : [["Sampler", sel?.sampler_name], ["Scheduler", sch?.scheduler], ["Steps", sch?.steps], ["CFG", guide ? guide.cfg : "— (BasicGuider)"],
       ["Shift", pick("MiniMaxH3SigmaShift")[0] ? `${pick("MiniMaxH3SigmaShift")[0].shift_video} / ${pick("MiniMaxH3SigmaShift")[0].shift_audio}` : null],
       ["Seed", pick("RandomNoise")[0]?.noise_seed]];
  const models = Object.values(g).filter(n => /Loader/.test(n.class_type)).map(n => Object.values(n.inputs).filter(v => typeof v === "string" && /\.(safetensors|gguf|ckpt|pt)$/i.test(v))).flat();
  const box = document.createElement("div");
  box.className = "wm-form wf-box";
  box.innerHTML = `<p class="hint">The workflow sent to ComfyUI, in its API format. Load it in ComfyUI (drag the downloaded file onto the canvas) or compare these values with your own workflow. Input pictures and sounds are named by file; ComfyUI needs them in its <code>input</code> folder to run it.</p>
    <div class="wf-sum">${sum.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<span><small>${k}</small><b>${esc(v)}</b></span>`).join("")}</div>
    ${models.length ? `<p class="wf-models">${models.map(m => `<code>${esc(m.replace(/\\/g, "/"))}</code>`).join(" ")}</p>` : ""}
    <textarea class="wf-json" readonly spellcheck="false" aria-label="Workflow JSON">${esc(text)}</textarea>`;
  const foot = document.createElement("div");
  foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="copy">Copy</button>
    <a class="btn sm primary" href="/api/items/${esc(it.id)}/workflow?download=true">⬇ Download</a>`;
  WM.open({ id: `wf-${it.id}`, title: `Workflow · ${engineName(it.kind, it.engine)} · seed ${it.seed ?? ""}`, content: box, footer: foot,
    width: 720, height: 600, minWidth: 420, minHeight: 320 });
  foot.querySelector('[data-a="copy"]').onclick = () => navigator.clipboard?.writeText(text).then(() => Media.toast("Workflow copied."));
}

/* The ☰ menu left of "Bob Studio". */
function openMainMenu() {
  const b = $("#btn-menu"), r = b.getBoundingClientRect();
  const proj = () => state.project?.id || "experiment";
  b.setAttribute("aria-expanded", "true");
  Media.menu(r.left, r.bottom + 6, [
    ["⚙  Settings…   Ctrl+,", () => Settings.open("appearance")],
    ["🎨  Theme and colors…", () => Settings.open("appearance")],
    ["＋  New project…", () => newProjectDialog()],
    ["🕘  Project versions…", () => historyDialog(proj())],
    ["🗂  Project settings…", () => projectSettingsDialog()],
    ...(state.project ? [
      [`✎  Rename “${state.project.name}”…`, () => renameProjectDialog()],
      [`🗑  Delete “${state.project.name}”…`, () => deleteProjectDialog()],
    ] : []),
    ["ℹ  About Bob Studio", () => Settings.open("about")],
  ]);
  const m = document.querySelector(".ex-menu");
  const done = () => { b.setAttribute("aria-expanded", "false"); };
  new MutationObserver((_, obs) => { if (!m.isConnected) { done(); obs.disconnect(); } }).observe(document.body, { childList: true });
}

// Start once every script (winman.js, explorer.js, shell.js) has loaded.
document.addEventListener("DOMContentLoaded", init);
