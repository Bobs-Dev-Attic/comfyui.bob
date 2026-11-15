/* Side panel: step tabs (Project → Model → Inputs → Prompt → Settings → Generate), projects,
   settings that persist, and the adjustable panel width. Builds on app.js (state, renderForm, …),
   winman.js (WM) and explorer.js (Explorer). */
"use strict";

const UI_KEY = "bob.ui";
const EXPERIMENT_KEY = "bob.experiment";
const readUI = () => { try { return JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {}; } catch { return {}; } };
const writeUI = patch => { try { localStorage.setItem(UI_KEY, JSON.stringify({ ...readUI(), ...patch })); } catch {} };
const SIDE_DEFAULT = 460, SIDE_MIN = 340;

const PROJECT_ICON = `<svg viewBox="0 0 48 40" aria-hidden="true"><rect x="3" y="9" width="42" height="28" rx="4" fill="#ff7a45"/><path d="M3 9l6-6h8l-6 6zm14 0l6-6h8l-6 6zm14 0l6-6h7l-6 6z" fill="#ffb36b"/><path d="M20 17l11 6-11 6z" fill="#fff"/></svg>`;
const EXPERIMENT_ICON = `<svg viewBox="0 0 48 40" aria-hidden="true"><path d="M18 4h12M21 4v12L9 34a3 3 0 0 0 3 4h24a3 3 0 0 0 3-4L27 16V4" fill="none" stroke="#7aa2ff" stroke-width="3" stroke-linejoin="round"/><path d="M13 29h22l3 5H10z" fill="#7aa2ff"/></svg>`;

/* ------------------------------------------------------------------ models (step 2) */
const MODEL_CARDS = [
  { kind: "video", engine: "h3", name: "MiniMax H3", opts: ["Text to video", "First / last keyframes", "2–15 s", "Native stereo sound", "Turbo 8 steps"] },
  { kind: "video", engine: "h3ref", name: "H3 Reference", opts: ["1–9 reference pictures", "<Picture N> tags", "2–15 s", "Native stereo sound", "Turbo 4 steps"] },
  { kind: "image", engine: "h3", name: "H3 still", opts: ["One frame", "768p canvas", "8 aspect ratios"] },
  { kind: "image", engine: "klein", name: "FLUX 3 Klein", opts: ["Up to 2 MP", "Prompt upsampler", "Fast"] },
  { kind: "audio", engine: "h3", name: "H3 sound", opts: ["Ambience and effects", "2–15 s", "MP3"] },
  { kind: "audio", engine: "music3", name: "Music 3", opts: ["Songs with vocals", "Tagged lyrics", "10–300 s", "MP3"] },
];
const KIND_LABEL = { video: "Video", image: "Image", audio: "Audio" };
const KIND_COLOR = { video: "var(--video)", image: "var(--image)", audio: "var(--audio)" };

function modelState(engine) {
  const cap = state.caps?.engines?.[engine];
  if (!cap) return { cls: "", label: "Checking…" };
  if (cap.ready) return { cls: "ok", label: "Ready" };
  if (cap.all_on_disk) return { cls: "warn", label: "Not loaded" };
  return { cls: "bad", label: "Not installed" };
}

function renderModels() {
  const box = $("#model-list");
  if (!box) return;
  const sel = curKey();
  box.innerHTML = Object.keys(KIND_LABEL).map(kind => `
    <div class="model-group"><h4><i style="background:${KIND_COLOR[kind]}"></i>${KIND_LABEL[kind]}</h4>
      ${MODEL_CARDS.filter(m => m.kind === kind).map(m => {
        const st = modelState(m.engine), key = `${m.kind}:${m.engine}`;
        const file = state.caps?.engines?.[m.engine]?.files?.unet;
        return `<button type="button" class="model-card${key === sel ? " sel" : ""}" data-model="${key}" aria-pressed="${key === sel}">
          <b>${esc(m.name)}</b><span class="mc-state ${st.cls}">${st.label}</span>
          <span class="mc-note">${esc(ENGINE_NOTES[key] || "")}</span>
          <span class="mc-opts">${m.opts.map(o => `<span>${esc(o)}</span>`).join("")}</span>
          ${file ? `<span class="mc-file">${esc(file.split(/[\\/]/).pop())}</span>` : ""}</button>`;
      }).join("")}</div>`).join("");
}

function pickModel(key) {
  const [kind, engine] = key.split(":");
  state.kind = kind; state.engine[kind] = engine;
  renderForm();
  scheduleSave();
}

/* ------------------------------------------------------------------ steps */
const STEPS = {
  project: { title: "Project", sub: "Start a new project, open a saved one, or just experiment." },
  model: { title: "Model", sub: "Choose what to make and the model that makes it." },
  inputs: { title: "Inputs", sub: "" },
  prompt: { title: "Prompt", sub: "Describe what you want. The Prompt Writer can turn a short idea into a full shot list." },
  settings: { title: "Settings", sub: "Size, length, speed and variations." },
  generate: { title: "Generate", sub: "Check your choices, then make it." },
};
const ORDER = Object.keys(STEPS);

function stepApplies(id) { return id !== "inputs" || state.kind === "video"; }
function visibleSteps() { return ORDER.filter(stepApplies); }
function stepDone(id) {
  const eng = state.engine[state.kind];
  switch (id) {
    case "project": return state.projectChosen;
    case "model": return !!state.caps?.engines?.[eng]?.ready;
    case "inputs": return eng === "h3ref" ? state.refs.length > 0 : !!(state.frames.first_frame || state.frames.last_frame);
    case "prompt": return !!$("#prompt").value.trim();
    case "settings": return state.settingsVisited;
    default: return false;
  }
}

function renderSteps() {
  if (!state.step) return;  // before initShell
  const vis = visibleSteps();
  $$(".step-tab").forEach(t => {
    const id = t.dataset.step, i = vis.indexOf(id);
    t.hidden = i < 0;
    if (i >= 0) $(".n span", t).textContent = i + 1;
    t.classList.toggle("done", id !== state.step && stepDone(id));
    t.classList.toggle("active", id === state.step);
    t.setAttribute("aria-selected", id === state.step);
    t.title = `${i + 1}. ${STEPS[id].title}${stepDone(id) ? " ✓" : ""}`;
  });
  if (!stepApplies(state.step)) return showStep(state.step === "inputs" ? "prompt" : "project");
  const i = vis.indexOf(state.step);
  $("#btn-back").disabled = i <= 0;
  $("#btn-next").hidden = i >= vis.length - 1;
  $("#btn-quick-gen").hidden = state.step === "generate";
  $("#btn-quick-gen").disabled = $("#btn-generate").disabled;
  const eng = state.engine[state.kind];
  const model = MODEL_CARDS.find(m => m.kind === state.kind && m.engine === eng)?.name || eng;
  $("#nav-info").textContent = `${state.project ? state.project.name : "Experiment"} · ${model}`;
  if (state.step === "inputs") renderInputsHead();
  if (state.step === "generate") renderSummary();
}

function renderInputsHead() {
  const eng = state.engine[state.kind];
  STEPS.inputs.sub = eng === "h3ref"
    ? "Add 1–9 pictures of the people, objects, places or style to use. Refer to them as <Picture 1>, <Picture 2>… in the prompt."
    : "Optional: a first frame, a last frame, or both, to animate between.";
  $("#step-sub").textContent = STEPS.inputs.sub;
  $("#no-inputs").hidden = state.kind === "video";
}

function showStep(id) {
  if (!STEPS[id] || !stepApplies(id)) id = "project";
  if (state.step === "settings" && id !== "settings") state.settingsVisited = true;
  state.step = id;
  $$(".step").forEach(s => { s.hidden = s.dataset.step !== id; });
  const vis = visibleSteps();
  $("#step-title").innerHTML = `${esc(STEPS[id].title)} <small>Step ${vis.indexOf(id) + 1} of ${vis.length}</small>`;
  $("#step-sub").textContent = STEPS[id].sub;
  writeUI({ step: id });
  if (id === "project") renderRecent();
  renderSteps();
  $("#form").scrollTop = 0;
}

function moveStep(delta) {
  const vis = visibleSteps(), i = vis.indexOf(state.step);
  const next = vis[Math.max(0, Math.min(vis.length - 1, i + delta))];
  if (next) showStep(next);
}

function renderSummary() {
  const kind = state.kind, eng = state.engine[kind];
  const card = MODEL_CARDS.find(m => m.kind === kind && m.engine === eng);
  const ms = modelState(eng);
  const prompt = $("#prompt").value.trim();
  const inputs = kind !== "video" ? null
    : eng === "h3ref" ? (state.refs.length ? `${state.refs.length} reference picture${state.refs.length > 1 ? "s" : ""}` : "")
    : [state.frames.first_frame && "first frame", state.frames.last_frame && "last frame"].filter(Boolean).join(" + ") || "none (text to video)";
  const dims = $("#dims").hidden ? "" : $("#dims").textContent;
  const length = kind === "image" ? "" : $("#seconds-val").textContent;
  const extras = [
    !$("#f-quality").hidden && $("#quality").selectedOptions[0]?.textContent,
    !$("#f-turbo").hidden && ($("#turbo").checked ? "turbo" : "full steps"),
    !$("#f-enhance").hidden && $("#enhance").checked && "enhanced prompt",
    !$("#f-fidelity").hidden && $("#fidelity").checked && "max reference detail",
    state.batch > 1 && `${state.batch} takes`,
    $("#seed").value !== "" && +$("#seed").value >= 0 && `seed ${$("#seed").value}`,
  ].filter(Boolean).join(" · ");
  const row = (k, v, step, missing = false) => `<div><span class="k">${k}</span><span class="v${missing ? " missing" : ""}">${v}
      ${step ? ` <button type="button" class="jump" data-goto="${step}">Edit</button>` : ""}</span></div>`;
  $("#summary").innerHTML = [
    row("Project", esc(state.project ? state.project.name : "Experiment (not saved)"), "project"),
    row("Model", `${esc(card?.name || eng)} · ${ms.label}`, "model", ms.cls !== "ok"),
    inputs !== null ? row("Inputs", esc(inputs || "add at least one picture"), "inputs", !inputs) : "",
    row("Prompt", prompt ? `<div class="pv">${esc(prompt.length > 400 ? prompt.slice(0, 400) + "…" : prompt)}</div>` : "empty", "prompt", !prompt),
    row("Settings", esc([dims, length, extras].filter(Boolean).join(" · ") || "defaults"), "settings"),
  ].join("");
}

/* ------------------------------------------------------------------ settings that persist */
function pickRef(f) { return f ? { ref: f.ref, url: f.url } : null; }
function collectSettings() {
  return {
    v: 1, kind: state.kind, engine: { ...state.engine },
    prompt: $("#prompt").value, lyrics: $("#lyrics").value,
    aspect: $("#aspect").value, quality: $("#quality").value, seconds: +$("#seconds").value,
    seed: $("#seed").value, steps: $("#steps").value, batch: state.batch,
    turbo: $("#turbo").checked, enhance: $("#enhance").checked, fidelity: $("#fidelity").checked,
    refs: state.refs.map(pickRef), frames: { first_frame: pickRef(state.frames.first_frame), last_frame: pickRef(state.frames.last_frame) },
  };
}

function applySettings(s) {
  state.loading = true;
  try {
    if (!s || !s.kind) { renderForm(); return; }
    state.kind = s.kind;
    Object.assign(state.engine, s.engine || {});
    state.batch = s.batch || 1;
    $$("#batch-seg button").forEach(b => b.classList.toggle("active", +b.dataset.v === state.batch));
    state.refs = (s.refs || []).filter(Boolean).map(r => ({ ...r }));
    renderForm();
    $("#prompt").value = s.prompt || "";
    $("#lyrics").value = s.lyrics || "";
    if (s.aspect && [...$("#aspect").options].some(o => o.value === s.aspect)) $("#aspect").value = s.aspect;
    if (s.quality && [...$("#quality").options].some(o => o.value === s.quality)) $("#quality").value = s.quality;
    if (s.seconds) $("#seconds").value = s.seconds;
    $("#seed").value = s.seed ?? -1;
    $("#steps").value = s.steps ?? "";
    $("#turbo").checked = s.turbo !== false;
    $("#enhance").checked = !!s.enhance;
    $("#fidelity").checked = !!s.fidelity;
    for (const role of ["first_frame", "last_frame"]) {
      const f = s.frames?.[role];
      if (f) setFrame(role, f.ref, f.url); else clearFrame(role);
    }
    renderRefs();
    updateDerived();
  } finally {
    state.loading = false;
  }
}

let saveTimer = null;
function scheduleSave() {
  if (state.loading || !state.shellReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
  renderSteps();
}
async function saveNow() {
  clearTimeout(saveTimer);
  const settings = collectSettings();
  if (!state.project) {
    try { localStorage.setItem(EXPERIMENT_KEY, JSON.stringify({ settings, notes: $("#proj-notes").value })); } catch {}
    return;
  }
  try {
    const p = await api(`/api/projects/${state.project.id}`, { method: "PUT", body: JSON.stringify({ settings }) });
    state.project = { ...state.project, modified: p.modified };
    renderProjectCard();
  } catch (e) {
    $("#proj-card .saved") && ($("#proj-card .saved").textContent = `Not saved: ${e.message}`);
  }
}
function loadExperiment() { try { return JSON.parse(localStorage.getItem(EXPERIMENT_KEY) || "null"); } catch { return null; } }

/* ------------------------------------------------------------------ projects */
function where(path) {
  const parts = (path || "").split("/").slice(0, -1);
  return ["Projects", ...parts].join(" › ");
}
const timeOf = t => t ? new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

function renderProjectCard() {
  const p = state.project, card = $("#proj-card");
  card.classList.toggle("exp", !p);
  if (p) {
    card.innerHTML = `<div class="proj-thumb">${p.thumb ? `<img src="/${esc(p.thumb)}" alt="">` : PROJECT_ICON}</div>
      <div><h3>${esc(p.name)}</h3><div class="where">${esc(where(p.path))}</div>
      <div class="saved">Saved automatically · last change ${esc(timeOf(p.modified))}</div></div>`;
    $("#notes-where").textContent = "saved with the project";
  } else {
    card.innerHTML = `<div class="proj-thumb">${EXPERIMENT_ICON}</div>
      <div><h3>Experiment</h3><div class="where">Nothing is saved as a project. Your settings stay in this browser.</div>
      <div class="saved"><button type="button" class="link" id="btn-save-as">Save as project…</button></div></div>`;
    $("#btn-save-as").onclick = () => newProjectDialog({ fromCurrent: true });
    $("#notes-where").textContent = "kept in this browser";
  }
}

async function renderRecent() {
  const box = $("#recent-list");
  try {
    const { projects } = await api("/api/projects/recent?limit=6");
    box.innerHTML = projects.length ? projects.map(e => `
      <button type="button" class="recent-item${state.project?.id === e.id ? " current" : ""}" data-open="${esc(e.id)}" title="${esc(where(e.path) + " › " + e.name)}">
        <span class="ri-thumb">${e.thumb ? `<img src="/${esc(e.thumb)}" alt="" loading="lazy">` : PROJECT_ICON}</span>
        <span><b>${esc(e.title || e.name)}</b><small>${esc(where(e.path))}</small></span>
        <small>${esc(timeOf(e.modified))}</small></button>`).join("")
      : `<p class="hint">No saved projects yet. Start one with <b>New project</b>.</p>`;
  } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

async function openProject(id, { quiet = false } = {}) {
  try {
    if (state.project) await saveNow();
    else if (state.shellReady) saveNow();  // keep the experiment's settings
    const p = await api(`/api/projects/${encodeURIComponent(id)}`);
    state.project = p; state.projectChosen = true;
    writeUI({ lastProject: p.id });
    applySettings(p.settings && p.settings.kind ? p.settings : collectSettings());
    $("#proj-notes").value = p.notes || "";
    Media.setProject(p.id, p.config?.gallery);
    TL.setProject(p.id, p.timeline);
    state.scope = "project"; syncScope();
    renderProjectCard(); renderRecent(); renderGallery(); selectInScope(); renderSteps();
    return p;
  } catch (e) {
    if (!quiet) WM.ask({ title: "Can't open project", message: e.message, ok: "OK", cancel: "Close" });
    return null;
  }
}

async function loadExperimentMedia() {
  try { const e = await api("/api/projects/experiment"); Media.setProject("experiment", e.config?.gallery); TL.setProject("experiment", e.timeline); }
  catch { Media.setProject("experiment", null); TL.setProject("experiment", null); }
}

async function startExperiment() {
  if (state.project) await saveNow();
  state.project = null; state.projectChosen = true;
  writeUI({ lastProject: null });
  const ex = loadExperiment();
  if (ex?.settings) applySettings(ex.settings);
  $("#proj-notes").value = ex?.notes || "";
  loadExperimentMedia();
  syncScope();
  renderProjectCard(); renderRecent(); renderGallery(); selectInScope(); renderSteps();
}

function newProjectDialog({ fromCurrent = false } = {}) {
  const ui = readUI();
  let folder = ui.newProjectFolder ?? "";
  const form = document.createElement("div");
  form.className = "wm-form";
  form.innerHTML = `
    <div class="field"><label for="np-name">Project name</label><input id="np-name" type="text" maxlength="120" value="Untitled project" autofocus></div>
    <div class="field"><label for="np-loc">Location</label>
      <div class="loc"><input id="np-loc" type="text" readonly><button type="button" class="btn sm" id="np-browse">Browse…</button></div></div>
    <div class="field"><label>Start with</label>
      <div class="radios">
        <label><input type="radio" name="np-start" value="current"${fromCurrent || !state.project ? " checked" : ""}> Current settings</label>
        <label><input type="radio" name="np-start" value="blank"${fromCurrent || !state.project ? "" : " checked"}> Defaults</label>
      </div></div>
    <div class="field"><label for="np-notes">Notes <span class="opt">optional</span></label><textarea id="np-notes" rows="3"></textarea></div>
    <p class="err" id="np-err"></p>`;
  const foot = document.createElement("div");
  foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button>
    <button type="button" class="btn sm primary" data-a="create">Create project</button>`;
  const win = WM.open({ id: "new-project", title: fromCurrent ? "Save as project" : "New project", content: form, footer: foot,
    width: 520, height: 470, minWidth: 380, minHeight: 380 });
  const loc = form.querySelector("#np-loc");
  const showLoc = () => { loc.value = ["Projects", ...folder.split("/").filter(Boolean)].join(" › "); };
  showLoc();
  form.querySelector("#np-browse").onclick = () => Explorer.open({ mode: "folder", startPath: folder, title: "Choose where to save the project",
    onPick: path => { folder = path; showLoc(); } });
  const name = form.querySelector("#np-name");
  name.select();
  const create = async () => {
    const start = form.querySelector('input[name="np-start"]:checked').value;
    const settings = start === "current" ? collectSettings() : {};
    try {
      const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ folder, name: name.value, settings, notes: form.querySelector("#np-notes").value }) });
      writeUI({ newProjectFolder: folder });
      win.close();
      if (start === "blank") { state.loading = true; resetForm(); state.loading = false; }
      await openProject(p.id);
      showStep("model");
    } catch (e) { form.querySelector("#np-err").textContent = e.message; }
  };
  foot.querySelector('[data-a="create"]').onclick = create;
  foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
  name.addEventListener("keydown", e => { if (e.key === "Enter") create(); });
}

function resetForm() {
  applySettings({ kind: "video", engine: { video: "h3", image: "h3", audio: "h3" }, prompt: "", lyrics: "", aspect: "16:9",
    quality: "draft", seconds: 5, seed: -1, steps: "", batch: 1, turbo: true, enhance: false, fidelity: false, refs: [], frames: {} });
}

function openProjectDialog() {
  Explorer.open({ mode: "open", onPick: e => openProject(e.id).then(p => { if (p) showStep(p.settings?.kind ? "prompt" : "model"); }) });
}

/* ------------------------------------------------------------------ gallery scope */
/* Point the viewer at this scope's newest result (or nothing) after switching project. */
function selectInScope() {
  const cur = state.items.get(state.selected);
  if (cur && inScope(cur)) return;
  const first = itemsSorted().find(inScope);
  select(first ? first.id : null);
}

function syncScope() {
  $$("#scope-seg button").forEach(b => b.classList.toggle("active", b.dataset.s === state.scope));
  $("#scope-seg button[data-s=project]").textContent = state.project ? "This project" : "Experiment";
}
function inScope(it) {
  if (state.scope === "all") return true;
  return state.project ? it.project === state.project.id : !it.project;
}

/* ------------------------------------------------------------------ adjustable side panel */
function setSideWidth(w, save = true) {
  const layout = $("#layout");
  const max = Math.max(SIDE_MIN, Math.min(900, layout.clientWidth - 420));
  w = Math.round(Math.max(SIDE_MIN, Math.min(max, w)));
  document.documentElement.style.setProperty("--side-w", w + "px");
  $("#splitter").setAttribute("aria-valuenow", w);
  if (save) writeUI({ sideWidth: w });
  return w;
}
function initSplitter() {
  const sp = $("#splitter"), layout = $("#layout");
  sp.setAttribute("aria-valuemin", SIDE_MIN);
  setSideWidth(readUI().sideWidth || SIDE_DEFAULT, false);
  sp.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add("drag"); document.body.classList.add("resizing");
    const left = layout.getBoundingClientRect().left + parseFloat(getComputedStyle(layout).paddingLeft);
    const mv = ev => setSideWidth(ev.clientX - left - 5, false);
    const up = () => {
      sp.removeEventListener("pointermove", mv); sp.removeEventListener("pointerup", up);
      sp.classList.remove("drag"); document.body.classList.remove("resizing");
      setSideWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-w")));
    };
    sp.addEventListener("pointermove", mv); sp.addEventListener("pointerup", up);
  });
  sp.addEventListener("dblclick", () => setSideWidth(SIDE_DEFAULT));
  sp.addEventListener("keydown", e => {
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-w")) || SIDE_DEFAULT;
    if (e.key === "ArrowLeft") { e.preventDefault(); setSideWidth(cur - 20); }
    if (e.key === "ArrowRight") { e.preventDefault(); setSideWidth(cur + 20); }
    if (e.key === "Home") { e.preventDefault(); setSideWidth(SIDE_DEFAULT); }
  });
  window.addEventListener("resize", () => setSideWidth(readUI().sideWidth || SIDE_DEFAULT, false));
}

/* ------------------------------------------------------------------ system check window */
function openSysWindow() {
  const content = $("#sys-content");
  content.hidden = false;
  const foot = document.createElement("div");
  foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="rerun">Run again</button>
    <button type="button" class="btn sm primary" data-a="close">Close</button>`;
  const w = WM.open({ id: "syscheck", title: "System check", content, footer: foot, width: 660, height: 600, minWidth: 380, minHeight: 280,
    onClose: () => { content.hidden = true; document.body.appendChild(content); } });
  foot.querySelector('[data-a="rerun"]').onclick = () => runSysCheck(true);
  foot.querySelector('[data-a="close"]').onclick = () => w.close();
  renderSysCheck();
}

/* ------------------------------------------------------------------ init */
async function initShell() {
  initSplitter();
  Media.mount($("#media-inputs"));
  state.scope = "project";
  state.projectChosen = false;
  $$(".step-tab").forEach(t => t.addEventListener("click", () => showStep(t.dataset.step)));
  $(".steps").addEventListener("keydown", e => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    moveStep(e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1);
    $(`.step-tab[data-step="${state.step}"]`)?.focus();
  });
  $("#btn-back").onclick = () => moveStep(-1);
  $("#btn-next").onclick = () => moveStep(1);
  $("#btn-quick-gen").onclick = () => $("#form").requestSubmit();
  $("#model-list").addEventListener("click", e => { const c = e.target.closest("[data-model]"); if (c) pickModel(c.dataset.model); });
  $("#model-list").addEventListener("dblclick", e => { if (e.target.closest("[data-model]")) moveStep(1); });
  $("#summary").addEventListener("click", e => { const b = e.target.closest("[data-goto]"); if (b) showStep(b.dataset.goto); });
  $("#btn-proj-new").onclick = () => newProjectDialog();
  $("#btn-proj-open").onclick = openProjectDialog;
  $("#btn-proj-exp").onclick = () => startExperiment().then(() => showStep("model"));
  $("#recent-list").addEventListener("click", e => {
    const b = e.target.closest("[data-open]");
    if (b) openProject(b.dataset.open).then(p => { if (p) showStep("model"); });
  });
  let notesTimer = null;
  $("#proj-notes").addEventListener("input", () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => {
      if (!state.project) return saveNow();
      try { await api(`/api/projects/${state.project.id}`, { method: "PUT", body: JSON.stringify({ notes: $("#proj-notes").value }) }); } catch {}
    }, 700);
  });
  $("#form").addEventListener("input", e => { if (e.target.id !== "proj-notes") scheduleSave(); });
  $("#form").addEventListener("change", e => { if (e.target.id !== "proj-notes") scheduleSave(); });
  $$("#scope-seg button").forEach(b => b.onclick = () => { state.scope = b.dataset.s; syncScope(); renderGallery(); selectInScope(); });
  window.addEventListener("bob:project-renamed", e => {
    if (state.project && e.detail.id === state.project.id) { state.project.name = e.detail.name; state.project.path = e.detail.path; renderProjectCard(); renderSteps(); }
  });
  window.addEventListener("bob:project-deleted", e => { if (state.project && e.detail.id === state.project.id) startExperiment(); });
  window.addEventListener("beforeunload", () => { if (saveTimer) saveNow(); });

  // Reopen what was open last time; otherwise the experiment.
  const ui = readUI();
  let opened = null;
  if (ui.lastProject) opened = await openProject(ui.lastProject, { quiet: true });
  if (!opened) {
    const ex = loadExperiment();
    if (ex?.settings) applySettings(ex.settings);
    $("#proj-notes").value = ex?.notes || "";
    loadExperimentMedia();
    state.project = null;
    state.projectChosen = !!ex;
    syncScope();
    renderProjectCard();
  }
  state.shellReady = true;
  showStep(ui.step && STEPS[ui.step] ? ui.step : "project");
  renderGallery();
  selectInScope();
}
