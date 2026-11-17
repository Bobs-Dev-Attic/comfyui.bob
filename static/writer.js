/* Prompt Writer window: your idea on the left, the H3 prompt rebuilt live on the right.
   The LLM fills the fields you haven't written or locked; code assembles the prompt
   (static/h3prompt.js, mirrored from app/llm.py). Talks to the studio window over a
   BroadcastChannel. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const H = window.H3Prompt;
const DRAFT_KEY = "bob.writer.draft";
const SETTINGS_KEY = "bob.writer";  // shared with the studio's Prompt writer panel
const FALLBACK_CTX = { kind: "video", engine: "h3", seconds: 5, aspect: "16:9", references: [], first_frame: null, last_frame: null, idea: "" };

const SHOT_FIELDS = ["framing", "setting", "action", "camera", "dialogue"];
const LABELS = { style: "Style", soundscape: "Sound", music: "Music", framing: "Framing", setting: "Setting & light",
  action: "Action", camera: "Camera", dialogue: "Spoken line" };
const PLACEHOLDERS = {
  style: "medium, look, palette, lens, mood", soundscape: "ambience and effects, in order", music: "score style, or N/A",
  setting: "where, and its light", action: "what happens, concretely", camera: "one move: holds / pushes in / pans…",
  dialogue: "words spoken (optional)",
};

const F = () => ({ v: "", src: "empty", lock: false });
const blankShot = () => Object.fromEntries(SHOT_FIELDS.map(k => [k, F()]));

const state = {
  ctx: null, linked: false,
  idea: "", seconds: 5, shotsSetting: "", dialogue: false, auto: true,
  f: { style: F(), soundscape: F(), music: F() },
  shots: [blankShot()],
  busy: false, pending: false, version: 0, fresh: new Set(), serverWarnings: [],
  lastFocus: null, structureKey: "",
};

/* ------------------------------------------------------------------ helpers */
function ctx() { return state.ctx || FALLBACK_CTX; }
function mode() {
  const c = ctx();
  if (c.engine === "h3ref" && c.kind === "video") return "ref";
  if (c.engine !== "h3") return null;
  if (c.kind === "video") return c.first_frame || c.last_frame ? "i2v" : "t2v";
  return c.kind === "image" ? "still" : c.kind === "audio" ? "sound" : null;
}
function nShots() {
  const m = mode();
  if (m === "still" || m === "sound") return 1;
  return state.shotsSetting ? +state.shotsSetting : H.autoShots(state.seconds);
}
function ensureShots() {
  const n = nShots();
  while (state.shots.length < n) state.shots.push(blankShot());
  // Keep extra shots in the draft (so going 3→2→3 brings shot 3 back), but only n are used.
}
function frames() { return mode() === "still" ? 5 : H.h3Length(state.seconds); }
function pictureCount() { return mode() === "ref" ? ctx().references.length : 0; }
function fieldAt(key) {
  if (!key) return null;
  if (!key.startsWith("shots.")) return state.f[key];
  const [, i, f] = key.split(".");
  return state.shots[+i - 1]?.[f];
}
function data() {
  return {
    style: state.f.style.v, soundscape: state.f.soundscape.v, music: state.f.music.v,
    shots: state.shots.slice(0, nShots()).map(s => ({
      framing: s.framing.v, setting: s.setting.v, action: s.action.v, camera: s.camera.v,
      dialogue: state.dialogue ? s.dialogue.v : "",
    })),
  };
}
function settings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; } catch { return {}; } }
function saveDraft() {
  const d = { idea: state.idea, shotsSetting: state.shotsSetting, dialogue: state.dialogue, auto: state.auto, f: state.f, shots: state.shots };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {}
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (!d) return false;
    Object.assign(state, { idea: d.idea || "", shotsSetting: d.shotsSetting || "", dialogue: !!d.dialogue, auto: d.auto !== false });
    for (const k of Object.keys(state.f)) if (d.f?.[k]) state.f[k] = { ...F(), ...d.f[k] };
    if (Array.isArray(d.shots) && d.shots.length) state.shots = d.shots.map(s => Object.fromEntries(SHOT_FIELDS.map(k => [k, { ...F(), ...(s?.[k] || {}) }])));
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ structure (fields) */
function fieldHTML(key, label) {
  const fd = fieldAt(key);
  const cls = fd.src === "user" ? "user" : fd.src === "llm" ? "llm" : "";
  const control = key.endsWith(".framing")
    ? `<select data-key="${key}" aria-label="${esc(label)}"><option value="">—</option>${H.FRAMINGS.map(f => `<option${f === fd.v ? " selected" : ""}>${f}</option>`).join("")}${fd.v && !H.FRAMINGS.includes(fd.v) ? `<option selected>${esc(fd.v)}</option>` : ""}</select>`
    : `<textarea data-key="${key}" rows="1" aria-label="${esc(label)}" placeholder="${esc(PLACEHOLDERS[key.split(".").pop()] || "")}">${esc(fd.v)}</textarea>`;
  return `<div class="f ${cls}" data-f="${key}"><label>${esc(label)}</label>${control}
    <button type="button" class="lock${fd.lock ? " on" : ""}" data-lock="${key}" title="${fd.lock ? "Locked: the LLM keeps this. Click to let it rewrite." : "Unlocked: the LLM may rewrite this. Click to keep it."}">${fd.lock ? "🔒" : "🔓"}</button></div>`;
}

function renderStructure() {
  const m = mode();
  ensureShots();
  const n = nShots();
  $("#w-unsupported").hidden = !!m;
  $("#w-shots-field").hidden = !(m === "t2v" || m === "i2v" || m === "ref");
  $("#w-dialogue-field").hidden = !(m === "t2v" || m === "i2v" || m === "ref");
  $("#w-dur-field").hidden = m === "still";

  const globals = m === "sound" ? ["soundscape", "music"] : m === "still" ? ["style"] : ["style", "soundscape", "music"];
  $("#w-globals").innerHTML = globals.map(k => fieldHTML(k, LABELS[k])).join("");

  const showShots = m && m !== "sound";
  $("#w-shots-h").hidden = !showShots;
  const fieldsFor = m === "still" ? ["framing", "setting", "action"] : ["framing", "setting", "action", "camera", ...(state.dialogue ? ["dialogue"] : [])];
  const times = H.shotTimes(frames(), n).concat([frames() / H.FPS]);
  $("#w-shotlist").innerHTML = !showShots ? "" : state.shots.slice(0, n).map((s, k) => `
    <div class="shot"><div class="shot-head"><b>${m === "still" ? "Frame" : `Shot ${k + 1}`}</b>
      ${m === "still" ? "" : `<span class="t">${times[k].toFixed(2)}–${times[k + 1].toFixed(2)} s</span>`}</div>
      ${fieldsFor.map(f => fieldHTML(`shots.${k + 1}.${f}`, LABELS[f])).join("")}</div>`).join("");

  $$("textarea[data-key]").forEach(autoGrow);
  state.structureKey = `${m}|${n}|${state.dialogue}`;
  renderPictures();
  renderMeta();
  renderPreview();
}

function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }

function renderPictures() {
  const c = ctx(), m = mode(), box = $("#w-pictures");
  let items = [];
  if (m === "ref") items = c.references.map((r, i) => ({ url: r.url, tag: `<Picture ${i + 1}>`, label: `Picture ${i + 1}` }));
  if (m === "i2v") items = [c.first_frame && { url: c.first_frame.url, label: "First frame" }, c.last_frame && { url: c.last_frame.url, label: "Last frame" }].filter(Boolean);
  box.hidden = !items.length;
  box.innerHTML = items.map(p => `<button type="button" class="w-pic" ${p.tag ? `data-tag="${esc(p.tag)}" title="Insert ${esc(p.tag)}"` : `title="${esc(p.label)}"`}><img src="${esc(p.url)}" alt=""><span>${esc(p.label)}</span></button>`).join("");
}

function renderMeta() {
  const c = ctx(), m = mode();
  const name = { t2v: "Text to video", i2v: "Image to video", ref: "Reference to video", still: "H3 still", sound: "H3 sound" }[m] || "Not an H3 engine";
  const bits = [name];
  if (m !== "still") bits.push(`${(H.h3Length(state.seconds) / H.FPS).toFixed(2)} s`);
  if (m !== "sound") bits.push(c.aspect);
  if (m === "ref") bits.push(`${c.references.length} picture${c.references.length === 1 ? "" : "s"}`);
  $("#w-mode").textContent = bits.join(" · ");
  const f = H.h3Length(state.seconds);
  $("#w-seconds-val").textContent = `${state.seconds}s → ${f} frames (${(f / H.FPS).toFixed(2)}s)`;
  const s = settings();
  $("#w-llm").textContent = s.model ? `${s.model} · ${s.backend === "openai" ? "local server" : "Ollama"}` : "LLM: studio default";
}

/* ------------------------------------------------------------------ live preview */
function renderPreview() {
  const m = mode();
  const out = $("#w-prompt");
  if (!m) { out.textContent = ""; $("#w-warnings").innerHTML = ""; $("#w-count").textContent = ""; return; }
  const n = nShots(), d = data();
  const segs = H.assemble(d, m, n, frames(), voiceCount());
  out.innerHTML = segs.map(s => {
    if (!s.key) return `<span class="tpl">${esc(s.text)}</span>`;
    if (s.hole) return `<span class="hole" data-key="${s.key}">${esc(s.text)}</span>`;
    const src = fieldAt(s.key)?.src === "user" ? "user" : "llm";
    return `<span class="${src}${state.fresh.has(s.key) ? " fresh" : ""}" data-key="${s.key}">${esc(s.text)}</span>`;
  }).join("");
  state.fresh.clear();
  const text = H.toText(segs);
  $("#w-count").textContent = `${text.split(/\s+/).filter(Boolean).length} words · ${text.length} characters`;

  const issues = H.check(d, m, n, frames(), pictureCount());
  const flagged = new Set(issues.map(i => i.key).filter(Boolean));
  $$(".f").forEach(el => el.classList.toggle("flag", flagged.has(el.dataset.f)));
  $("#w-warnings").innerHTML = issues.length
    ? issues.map(i => `<li ${i.key ? `data-key="${i.key}"` : ""}>${esc(i.msg)}</li>`).join("")
    : (text.trim() ? `<li class="ok">Ready for H3</li>` : "");
  saveDraft();
  // Only a complete shot list (no empty fields) replaces the studio's prompt.
  if (INLINE && touched && !segs.some(x => x.hole)) autoSend(text);
}

/* In the Prompt tab (?inline=1) there's no "Use in studio": once you change something here, the shot list
   goes into the studio's prompt as you work. */
const INLINE = new URLSearchParams(location.search).has("inline");
let touched = false, sendTimer = 0;
function autoSend(text) {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    if (!state.linked || !text.trim()) return;
    channel.postMessage({ type: "use", quiet: true, prompt: text, seconds: mode() === "still" ? undefined : state.seconds });
  }, 250);
}

function currentText() { const m = mode(); return m ? H.toText(H.assemble(data(), m, nShots(), frames(), voiceCount())) : ""; }
function voiceCount() { return mode() === "ref" ? ctx().voices || 0 : 0; }

/* ------------------------------------------------------------------ LLM */
let ideaTimer = null;
function status(html, busy = false) { const el = $("#w-status"); el.innerHTML = html; el.classList.toggle("busy", busy); }

function lockedPayload() {
  const locked = {};
  for (const [k, fd] of Object.entries(state.f)) if (fd.lock && fd.v.trim()) locked[k] = fd.v;
  locked.shots = state.shots.slice(0, nShots()).map(s => {
    const o = {};
    for (const k of SHOT_FIELDS) if (s[k].lock && s[k].v.trim()) o[k] = s[k].v;
    return o;
  });
  return locked;
}

async function write() {
  const m = mode();
  if (!m) return;
  if (!state.idea.trim()) { status(`<span class="warn">Type your idea first.</span>`); return; }
  if (state.busy) { state.pending = true; return; }
  state.busy = true; state.pending = false;
  $("#w-write").disabled = true;
  const startVersion = state.version, c = ctx(), s = settings(), n = nShots();
  const pics = (m === "ref" ? c.references.length : 0) + (m === "i2v" ? (c.first_frame ? 1 : 0) + (c.last_frame ? 1 : 0) : 0);
  status(`Writing${pics ? ` · looking at ${pics} picture${pics > 1 ? "s" : ""}` : ""}…`, true);
  const body = {
    kind: c.kind, engine: c.engine, idea: state.idea, seconds: state.seconds, aspect: c.aspect,
    shots: m === "still" || m === "sound" ? null : n, dialogue: state.dialogue,
    first_frame: m === "i2v" ? c.first_frame?.ref ?? null : null,
    last_frame: m === "i2v" ? c.last_frame?.ref ?? null : null,
    references: m === "ref" ? c.references.map(r => r.ref) : [],
    voices: voiceCount(),
    backend: s.backend || null, url: s.urls?.[s.backend] || null, model: s.model || null,
    locked: lockedPayload(),
  };
  try {
    const res = await fetch("/api/prompt/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) throw new Error(typeof j.detail === "string" ? j.detail : res.statusText);
    if (state.version !== startVersion) { state.pending = true; return; }  // idea or locks changed meanwhile
    applyFields(j.fields || {});
    state.serverWarnings = j.warnings || [];
    status(`Written by ${esc(j.model)} in ${j.seconds}s${pics ? (j.vision ? ` · saw ${pics} picture${pics > 1 ? "s" : ""}` : ` · <span class="warn">this model can't see pictures</span>`) : ""}`);
  } catch (e) {
    status(`<span class="warn">${esc(e.message)}</span>`);
  } finally {
    state.busy = false;
    $("#w-write").disabled = false;
    if (state.pending) { state.pending = false; write(); }
  }
}

function applyFields(fields) {
  const set = (key, value) => {
    const fd = fieldAt(key);
    if (!fd || fd.lock || typeof value !== "string") return;
    if (fd.v !== value) state.fresh.add(key);
    fd.v = value; fd.src = value ? "llm" : "empty";
  };
  for (const k of Object.keys(state.f)) set(k, fields[k]);
  (fields.shots || []).forEach((s, i) => { if (state.shots[i]) for (const k of SHOT_FIELDS) set(`shots.${i + 1}.${k}`, s?.[k]); });
  renderStructure();
}

/* ------------------------------------------------------------------ events */
function bindEvents() {
  const idea = $("#w-idea");
  idea.addEventListener("input", () => {
    state.idea = idea.value; state.version++; saveDraft();
    clearTimeout(ideaTimer);
    if (state.auto && state.idea.trim().length >= 8) { status("Waiting for you to pause…"); ideaTimer = setTimeout(write, 1200); }
  });
  $("#w-auto").addEventListener("change", e => { state.auto = e.target.checked; saveDraft(); });
  $("#w-write").addEventListener("click", () => { clearTimeout(ideaTimer); write(); });

  // Field edits: typing locks the field (it's yours now); the preview follows every keystroke.
  document.addEventListener("input", e => {
    const key = e.target.dataset?.key;
    if (!key) return;
    const fd = fieldAt(key);
    fd.v = e.target.value; fd.src = fd.v ? "user" : "empty"; fd.lock = !!fd.v.trim();
    state.version++;
    const row = e.target.closest(".f");
    row.classList.toggle("user", !!fd.v); row.classList.remove("llm");
    const btn = $(".lock", row); btn.classList.toggle("on", fd.lock); btn.textContent = fd.lock ? "🔒" : "🔓";
    if (e.target.tagName === "TEXTAREA") autoGrow(e.target);
    renderPreview();
  });
  document.addEventListener("focusin", e => { if (e.target.matches?.("textarea[data-key], #w-idea")) state.lastFocus = e.target; });
  document.addEventListener("click", e => {
    const lock = e.target.closest?.("[data-lock]");
    if (lock) {
      const fd = fieldAt(lock.dataset.lock);
      fd.lock = !fd.lock; state.version++;
      lock.classList.toggle("on", fd.lock); lock.textContent = fd.lock ? "🔒" : "🔓";
      saveDraft(); return;
    }
    const pic = e.target.closest?.("[data-tag]");
    if (pic) { insertTag(pic.dataset.tag); return; }
    const jump = e.target.closest?.("#w-prompt [data-key], #w-warnings [data-key]");
    if (jump) { const el = $(`[data-key="${jump.dataset.key}"]`, $(".w-input")); if (el) { el.focus(); el.scrollIntoView({ block: "center", behavior: "smooth" }); } }
  });

  $("#w-seconds").addEventListener("input", e => {
    state.seconds = +e.target.value;
    channel.postMessage({ type: "set", seconds: state.seconds });
    renderStructure();  // shot times and, with Auto shots, the shot count follow the duration
  });
  $("#w-shots").addEventListener("change", e => { state.shotsSetting = e.target.value; state.version++; renderStructure(); });
  $("#w-dialogue").addEventListener("change", e => { state.dialogue = e.target.checked; state.version++; renderStructure(); });

  $("#w-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(currentText()); status("Copied to the clipboard."); } catch { status(`<span class="warn">Copy failed; select the text and copy it.</span>`); }
  });
  $("#w-clear").addEventListener("click", () => {
    if (!confirm("Clear every field and lock? Your idea stays.")) return;
    state.f = { style: F(), soundscape: F(), music: F() }; state.shots = [blankShot()]; state.version++;
    renderStructure();
  });
  for (const id of ["#w-use", "#w-use2"]) $(id).addEventListener("click", useInStudio);
}

function insertTag(tag) {
  const ta = state.lastFocus && document.contains(state.lastFocus) ? state.lastFocus : $("#w-idea");
  const { selectionStart: a = ta.value.length, selectionEnd: b = ta.value.length, value } = ta;
  const pad = a > 0 && !/\s$/.test(value.slice(0, a)) ? " " : "";
  ta.value = value.slice(0, a) + pad + tag + value.slice(b);
  ta.focus(); ta.selectionStart = ta.selectionEnd = a + pad.length + tag.length;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ------------------------------------------------------------------ studio link */
const channel = new BroadcastChannel("bob-studio");
let linkTimer = null;

channel.onmessage = ({ data: msg }) => {
  if (msg?.type === "context") {
    const first = !state.linked;
    state.linked = true;
    $("#w-link").className = "chip ok"; $("#w-link").lastChild.textContent = "Linked to studio";
    clearTimeout(linkTimer);
    const old = JSON.stringify(state.ctx);
    state.ctx = msg.ctx;
    if (first && !state.idea && msg.ctx.idea && !/\[Shot \d/.test(msg.ctx.idea)) { state.idea = msg.ctx.idea; $("#w-idea").value = state.idea; }
    if (typeof msg.ctx.seconds === "number" && msg.ctx.seconds !== state.seconds) { state.seconds = msg.ctx.seconds; $("#w-seconds").value = state.seconds; }
    if (old !== JSON.stringify(state.ctx) || first) renderStructure();
  } else if (msg?.type === "used") {
    status("Sent to the studio's prompt box.");
  } else if (msg?.type === "bye") {
    unlinked();
  }
};

function unlinked() {
  state.linked = false;
  $("#w-link").className = "chip bad"; $("#w-link").lastChild.textContent = "Studio not open";
}

function useInStudio() {
  const text = currentText();
  if (!text.trim()) { status(`<span class="warn">Nothing to send yet.</span>`); return; }
  if (!state.linked) {
    navigator.clipboard?.writeText(text).then(() => status("The studio isn't open, so the prompt was copied to the clipboard."),
      () => status(`<span class="warn">The studio isn't open; copy the prompt by hand.</span>`));
    return;
  }
  channel.postMessage({ type: "use", prompt: text, seconds: mode() === "still" ? undefined : state.seconds });
  try { window.opener?.focus(); } catch {}
}

/* ------------------------------------------------------------------ init */
function init() {
  // In the studio's Writer pane (an iframe): drop the page's own title bar brand.
  if (new URLSearchParams(location.search).has("embed") || window.self !== window.top) document.body.classList.add("embedded");
  if (INLINE) {
    document.body.classList.add("inline");
    for (const ev of ["input", "change"]) document.addEventListener(ev, () => { touched = true; }, true);
    document.addEventListener("click", e => { if (e.target.closest("button")) touched = true; }, true);
  }
  loadDraft();
  $("#w-idea").value = state.idea;
  $("#w-auto").checked = state.auto;
  $("#w-shots").value = state.shotsSetting;
  $("#w-dialogue").checked = state.dialogue;
  bindEvents();
  renderStructure();
  channel.postMessage({ type: "hello" });
  linkTimer = setTimeout(() => { if (!state.linked) { unlinked(); renderStructure(); } }, 1500);
  window.addEventListener("storage", e => { if (e.key === SETTINGS_KEY) renderMeta(); });
}
init();
