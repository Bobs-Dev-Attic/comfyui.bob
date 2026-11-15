/* Bob Studio front end — vanilla JS, talks to the FastAPI backend in app/main.py. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const ENGINES = {
  video: [{ key: "h3", label: "MiniMax H3" }, { key: "h3ref", label: "H3 Reference" }],
  image: [{ key: "h3", label: "H3 still" }, { key: "klein", label: "FLUX 3 Klein" }],
  audio: [{ key: "h3", label: "H3 sound" }, { key: "music3", label: "Music 3" }],
};

const ENGINE_NOTES = {
  "video:h3": "Text-to-video, or image-to-video with first/last keyframes. Native stereo sound in the same pass.",
  "video:h3ref": "Reference-to-video: put people, objects or places from your pictures into a new scene, with sound.",
  "image:h3": "One frame rendered by the H3 video model at its native 768p canvas.",
  "image:klein": "Dedicated image model: fast and sharp, up to 2 MP.",
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
const engineName = (kind, eng) => (ENGINES[kind].find(e => e.key === eng) || {}).label || eng;
function fmtDur(s) { if (s == null) return ""; s = Math.round(s); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }
function waveHTML(seed, n = 28) {
  let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; const h = 18 + (x % 62) * (0.6 + 0.4 * Math.sin(i / 3)); out += `<i style="height:${Math.max(8, h)}%"></i>`; }
  return `<div class="wave">${out}</div>`;
}

/* ------------------------------------------------------------------ form */
function curKey() { return `${state.kind}:${state.engine[state.kind]}`; }

function renderForm() {
  const kind = state.kind, eng = state.engine[kind];
  renderModels();  // the Model step (shell.js)

  const isRef = eng === "h3ref";
  const isH3 = eng === "h3" || isRef, isKlein = eng === "klein", isMusic = eng === "music3";
  $("#f-frames").hidden = !(kind === "video") || isRef;
  $("#f-refs").hidden = !isRef;
  $("#f-fidelity").hidden = !isRef;
  $("#f-lyrics").hidden = !isMusic;
  $("#f-aspect").hidden = kind === "audio";
  $("#f-quality").hidden = kind === "audio";
  $("#f-seconds").hidden = kind === "image";
  $("#f-turbo").hidden = !isH3;
  $("#f-enhance").hidden = !isKlein;
  $("#prompt-label").textContent = isMusic ? "Style caption" : kind === "audio" ? "Sound description" : "Prompt";
  $("#prompt").placeholder = {
    video: "Describe the shots, camera moves, and the sound…",
    image: "Describe the picture…",
    audio: isMusic ? "Genre, tempo, mood, vocals, arrangement…" : "Describe the sounds and when they happen…",
  }[kind];

  // quality options
  const q = $("#quality"), prevQ = q.value;
  const opts = isKlein
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
  updateDerived();
  renderMissing();
  renderSteps();
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
    const mpTable = eng === "klein" ? { draft: 0.5, standard: 1, high: 2 } : { draft: 0.4, standard: 0.6, full: 0.98 };
    const mp = mpTable[$("#quality").value] ?? 0.4;
    const kf = state.frames.first_frame || state.frames.last_frame;
    if (kind === "video" && eng === "h3" && kf?.w) {
      const [w, h] = dimsFor([kf.w, kf.h], mp);
      dims = `${w} × ${h} (from keyframe)`;
    } else {
      const [w, h] = dimsFor(ASPECT[$("#aspect").value] || [16, 9], mp, eng === "klein" ? 16 : 32);
      dims = `${w} × ${h}`;
    }
  }
  $("#dims").textContent = dims;
  $("#dims").hidden = !dims;
  const turbo = $("#turbo").checked;
  const refLora = state.caps?.engines?.h3ref?.files?.turbo_lora || "";
  const refTurboSteps = /8step/i.test(refLora) ? 8 : 4;
  const autoSteps = eng === "h3" ? (turbo ? 8 : 20) : eng === "h3ref" ? (turbo && refLora ? refTurboSteps : 20) : eng === "klein" ? 16 : 30;
  $("#steps-hint").textContent = `auto = ${autoSteps}`;
  postContext();
  scheduleSave();
  $("#turbo-note").textContent = eng === "h3ref"
    ? (refLora ? `${refTurboSteps} steps with the ref2v turbo LoRA` : "Ref2v turbo LoRA not installed: runs 20 steps")
    : "8 steps with the turbo LoRA (≈3× faster)";
  $("#steps").placeholder = `auto (${autoSteps})`;
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
  return {
    kind, engine: eng,
    prompt: $("#prompt").value,
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
    references: eng === "h3ref" ? state.refs.map(r => r.ref) : [],
    max_fidelity: eng === "h3ref" && $("#fidelity").checked,
    project: state.project?.id ?? null,
  };
}

function applyParams(p) {
  state.kind = p.kind; state.engine[p.kind] = p.engine;
  renderForm();
  $("#prompt").value = p.prompt || "";
  $("#lyrics").value = p.lyrics || "";
  if (p.aspect) $("#aspect").value = p.aspect;
  if (p.quality) $("#quality").value = p.quality;
  if (p.seconds) $("#seconds").value = p.seconds;
  $("#turbo").checked = p.turbo !== false;
  $("#enhance").checked = !!p.enhance;
  $("#fidelity").checked = !!p.max_fidelity;
  if (p.engine === "h3ref") { state.refs = (p.references || []).map(r => ({ ref: r, url: "/" + r })); renderRefs(); }
  $("#steps").value = p.steps ?? "";
  for (const role of ["first_frame", "last_frame"]) {
    if (p[role]) setFrame(role, p[role], "/" + p[role]); else clearFrame(role);
  }
  updateDerived();
}

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
      if (ref) return setFrame(role, ref, "/" + ref);
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
    if (ref) return addRef(ref, "/" + ref);
    uploadRefs([...e.dataTransfer.files]);
  });
}

/* ------------------------------------------------------------------ Prompt Writer window link */
// The writer (static/writer.html) runs in its own window. This channel tells it what the
// studio is set to and receives "Use in studio" from it.
const studioChannel = new BroadcastChannel("bob-studio");
let contextTimer = null;
let writerWin = null;

function studioContext() {
  const pic = f => f ? { ref: f.ref, url: f.url } : null;
  return {
    kind: state.kind, engine: state.engine[state.kind],
    seconds: +$("#seconds").value, aspect: $("#aspect").value,
    references: state.refs.map(r => ({ ref: r.ref, url: r.url })),
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
    $("#seconds").value = msg.seconds; updateDerived();
  } else if (msg?.type === "use" && typeof msg.prompt === "string") {
    const p = $("#prompt");
    writer.undo = p.value;
    p.value = msg.prompt;
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
  $("#btn-writer-window").hidden = !ok;
  $("#f-writer").hidden = !ok;
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
    references: eng === "h3ref" ? state.refs.map(r => r.ref) : [],
    backend: $("#llm-backend").value, url: $("#llm-url").value.trim(), model: $("#llm-model").value,
  };
  writer.busy = true;
  $("#btn-write").disabled = true;
  const pics = body.references.length + (body.first_frame ? 1 : 0) + (body.last_frame ? 1 : 0);
  writerStatus(`Writing with ${esc(body.model)}${pics ? ` · looking at ${pics} picture${pics > 1 ? "s" : ""}` : ""}…`, true);
  try {
    const r = await api("/api/prompt/write", { method: "POST", body: JSON.stringify(body) });
    writer.undo = idea;
    $("#prompt").value = r.prompt;
    const notes = [`Written by ${esc(r.model)} in ${r.seconds}s`];
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
    if (it.kind === "video") return `<video src="${esc(f.url)}#t=0.6" muted preload="metadata" playsinline loop></video>`;
    if (it.kind === "image") return `<img src="${esc(f.url)}" alt="" loading="lazy">`;
    return waveHTML(it.id, 22);
  }
  if (isBusy(it)) {
    const pv = state.previews.get(it.id);
    if (pv) return `<img src="${pv}" alt="">`;
    return `<span class="state">${it.status === "running" ? "Rendering…" : it.status === "queued" ? "Queued" : "Submitting…"}</span>`;
  }
  return `<span class="state failed">${it.status === "cancelled" ? "Cancelled" : "Failed"}</span>`;
}

function renderGallery() {
  const g = $("#gallery");
  const list = itemsSorted().filter(it => inScope(it) && (state.filter === "all" || it.kind === state.filter));
  g.innerHTML = "";
  if (!list.length) { g.innerHTML = `<p class="gallery-empty">Nothing here yet.</p>`; return; }
  const tpl = $("#tile-tpl");
  let lastDay = "";
  for (const it of list) {
    const day = new Date(it.created * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (day !== lastDay) { const d = document.createElement("div"); d.className = "day"; d.textContent = day; g.appendChild(d); lastDay = day; }
    const t = tpl.content.firstElementChild.cloneNode(true);
    t.dataset.id = it.id;
    t.classList.toggle("selected", it.id === state.selected);
    t.classList.toggle("busy", isBusy(it));
    $(".thumb", t).innerHTML = thumbHTML(it);
    const b = $(".badge", t); b.textContent = it.kind; b.classList.add(it.kind);
    $(".t-prompt", t).textContent = it.params?.prompt?.replace(/\s+/g, " ").slice(0, 120) || "";
    t.title = it.params?.prompt || "";
    const p = state.progress.get(it.id);
    $(".bar i", t).style.width = `${Math.round((p?.value ?? it.progress ?? 0) * 100)}%`;
    t.onclick = () => select(it.id);
    if (it.kind === "image" && it.status === "done" && it.files[0]) {
      t.draggable = true;
      t.addEventListener("dragstart", e => e.dataTransfer.setData("text/x-bob-ref", it.files[0].path));
    }
    const v = $("video", t);
    if (v) { t.onmouseenter = () => v.play().catch(() => {}); t.onmouseleave = () => { v.pause(); }; }
    g.appendChild(t);
  }
}

function patchTile(id) {
  const it = state.items.get(id);
  const t = $(`.tile[data-id="${id}"]`);
  if (!it || !t) return renderGallery();
  t.classList.toggle("busy", isBusy(it));
  const p = state.progress.get(id);
  $(".bar i", t).style.width = `${Math.round((p?.value ?? 0) * 100)}%`;
  const pv = state.previews.get(id);
  if (pv && isBusy(it)) { const img = $(".thumb img", t); if (img) img.src = pv; else $(".thumb", t).innerHTML = `<img src="${pv}" alt="">`; }
}

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
      <button class="btn ghost sm danger" data-cancel="${it.id}">Cancel</button>
      <div class="bar ${it.status === "running" && !pct ? "indeterminate" : ""}"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  $$("[data-cancel]", q).forEach(b => b.onclick = () => cancel(b.dataset.cancel));
}

async function cancel(id) { try { await api(`/api/items/${id}/cancel`, { method: "POST" }); } catch (e) { alert(e.message); } }

/* ------------------------------------------------------------------ viewer */
function select(id) {
  state.selected = id;
  $$(".tile").forEach(t => t.classList.toggle("selected", t.dataset.id === id));
  renderViewer();
}

function renderViewer() {
  const it = state.items.get(state.selected);
  const viewer = $("#viewer"), meta = $("#meta");
  if (!it) { $("#viewer-empty").hidden = false; [...viewer.children].forEach(c => c.id !== "viewer-empty" && c.remove()); meta.hidden = true; return; }
  $("#viewer-empty").hidden = true;
  [...viewer.children].forEach(c => c.id !== "viewer-empty" && c.remove());

  const f = it.files?.[0];
  let html = "";
  if (it.status === "done" && f) {
    if (it.kind === "video") html = `<video class="media" src="${esc(f.url)}" controls autoplay loop playsinline></video>`;
    else if (it.kind === "image") html = `<img class="media" src="${esc(f.url)}" alt="">`;
    else html = `<div class="audio-card">${waveHTML(it.id, 48)}<audio src="${esc(f.url)}" controls autoplay></audio></div>`;
  } else if (isBusy(it)) {
    const pv = state.previews.get(it.id) || (it.params.first_frame || it.params.references?.[0] ? "/" + (it.params.first_frame || it.params.references[0]) : "");
    html = `<div class="live">${pv ? `<img id="live-img" src="${pv}" alt="">` : ""}
      <div class="live-overlay"><div class="row"><span id="live-label"></span><span id="live-pct"></span></div>
      <div class="bar" id="live-bar"><i></i></div></div></div>`;
  } else {
    html = `<div class="failed-box"><b>${it.status === "cancelled" ? "Cancelled" : "Generation failed"}</b>\n\n${esc(it.error || "")}</div>`;
  }
  viewer.insertAdjacentHTML("beforeend", html);
  if (isBusy(it)) updateLive(it.id);

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
  meta.innerHTML = `
    <div class="facts">${facts.map(x => `<span>${esc(x)}</span>`).join("")}</div>
    <div class="prompt-text">${esc(it.params.prompt)}${it.params.lyrics && it.engine === "music3" ? "\n\n" + esc(it.params.lyrics) : ""}</div>
    <div class="actions">
      ${isBusy(it) ? `<button class="btn danger" data-a="cancel">Cancel</button>` : ""}
      <button class="btn" data-a="reuse">Reuse settings</button>
      <button class="btn" data-a="reroll">Re-roll</button>
      ${canFrame ? `<button class="btn" data-a="first">→ First frame</button><button class="btn" data-a="last">→ Last frame</button><button class="btn" data-a="ref">→ Reference</button>` : ""}
      ${f ? `<a class="btn" href="${esc(f.url)}" download="${esc(f.name)}">Download</a>` : ""}
      <button class="btn ghost danger" data-a="delete">Delete</button>
    </div>`;
  meta.hidden = false;
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
  if (a === "reuse") { applyParams(it.params); $("#seed").value = it.seed; scheduleSave(); showStep("prompt"); return; }
  if (a === "reroll") return submit({ ...it.params, seed: -1, batch: 1 });
  if (a === "ref") {
    state.kind = "video"; state.engine.video = "h3ref";
    addRef(it.files[0].path, it.files[0].url); renderForm();
    showStep("inputs");
    return;
  }
  if (a === "first" || a === "last") {
    state.kind = "video"; state.engine.video = "h3"; renderForm();
    setFrame(a === "first" ? "first_frame" : "last_frame", it.files[0].path, it.files[0].url);
    showStep("inputs");
    return;
  }
  if (a === "delete") {
    if (!confirm("Delete this item and its file from disk? This can't be undone.")) return;
    try { await api(`/api/items/${it.id}?files=true`, { method: "DELETE" }); } catch (e) { alert(e.message); }
  }
}

/* ------------------------------------------------------------------ live events */
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === "item") {
      const prev = state.items.get(ev.item.id);
      state.items.set(ev.item.id, ev.item);
      if (!isBusy(ev.item)) { state.previews.delete(ev.item.id); state.progress.delete(ev.item.id); }
      if (!prev || prev.status !== ev.item.status) {
        renderGallery(); renderQueue();
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
    $("#st-comfy").className = "chip " + (s.comfyui ? "ok" : "bad");
    $("#st-comfy").lastChild.textContent = s.comfyui ? `ComfyUI ${s.comfyui_version || ""}` : "ComfyUI offline";
    $("#st-proxy").className = "chip " + (s.proxy ? "ok" : "bad");
    if (s.gpu) {
      const used = (s.gpu.vram_total - s.gpu.vram_free) / 2 ** 30, tot = s.gpu.vram_total / 2 ** 30;
      $("#st-gpu").textContent = `${s.gpu.name} · ${used.toFixed(1)}/${tot.toFixed(0)} GB`;
    }
    const q = s.queue || { running: 0, pending: 0 };
    $("#st-queue").textContent = `Queue ${q.running + q.pending}`;
    if (s.comfyui && !state.caps) loadCaps();
  } catch {
    $("#st-comfy").className = "chip bad";
  }
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
  };
  $("#btn-tips").onclick = () => { $("#tips").hidden = !$("#tips").hidden; };
  $("#btn-free").onclick = async () => {
    const b = $("#btn-free"); b.disabled = true; b.textContent = "Freeing…";
    try { await api("/api/free", { method: "POST" }); } catch {}
    b.disabled = false; b.textContent = "Free VRAM"; pollStatus();
  };
  $("#form").addEventListener("submit", e => { e.preventDefault(); submit(collectRequest()); });
  $("#prompt").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#form").requestSubmit(); } });
  initDrops();
  initRefs();
  initWriter();
  initSysCheck();
  $("#btn-writer-window").onclick = openWriterWindow;
  $("#prompt").addEventListener("input", () => postContext());
  $("#aspect").innerHTML = Object.keys(ASPECT).map(a => `<option>${a}</option>`).join("");
  renderForm();
  initShell();

  api("/api/items").then(({ items }) => {
    for (const it of items) state.items.set(it.id, it);
    renderGallery(); renderQueue();
    if (state.shellReady) selectInScope();  // otherwise initShell does it once the project is open
  });
  connectEvents();
  pollStatus();
  setInterval(pollStatus, 5000);
}

// Start once every script (winman.js, explorer.js, shell.js) has loaded.
document.addEventListener("DOMContentLoaded", init);
