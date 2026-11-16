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
  { kind: "image", engine: "krea2", name: "Krea 2", opts: ["Up to 2 MP", "Photoreal", "Turbo 8 steps", "Prompt expander"] },
  { kind: "image", engine: "h3image", name: "MiniMax H3 Image", opts: ["Up to 4 MP", "6 steps", "Reference pictures", "<Picture N> tags"] },
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
        const file = unetFor(m.engine);
        return `<button type="button" class="model-card${key === sel ? " sel" : ""}" data-model="${key}" aria-pressed="${key === sel}">
          <b>${esc(m.name)}</b><span class="mc-state ${st.cls}">${st.label}</span>
          <span class="mc-note">${esc(ENGINE_NOTES[key] || "")}</span>
          <span class="mc-opts">${m.opts.map(o => `<span>${esc(o)}</span>`).join("")}</span>
          ${file ? `<span class="mc-file${file !== state.caps?.engines?.[m.engine]?.files?.unet ? " custom" : ""}">${esc(file.split(/[\\/]/).pop())}</span>` : ""}</button>`;
      }).join("")}</div>`).join("");
  renderUnet();
  renderSampling();
}

/* The diffusion model an engine uses: the user's pick (if ComfyUI still has it) or the default. */
function unetFor(engine) {
  const cap = state.caps?.engines?.[engine], pick = state.unet[engine];
  const all = cap?.unet_choices ? [...cap.unet_choices.match, ...cap.unet_choices.other] : [];
  return pick && all.includes(pick) ? pick : cap?.files?.unet || null;
}
function renderUnet() {
  const box = $("#unet-field");
  if (!box) return;
  const eng = state.engine[state.kind], cap = state.caps?.engines?.[eng], ch = cap?.unet_choices;
  if (!ch || (!ch.match.length && !ch.other.length)) { box.hidden = true; return; }
  box.hidden = false;
  const pick = state.unet[eng], def = cap.files?.unet;
  const all = [...ch.match, ...ch.other];
  const cur = pick && all.includes(pick) ? pick : "";
  const card = MODEL_CARDS.find(m => m.kind === state.kind && m.engine === eng);
  const opt = n => `<option value="${esc(n)}"${n === cur ? " selected" : ""}>${esc(n.replace(/\\/g, "/"))}</option>`;
  box.innerHTML = `<label for="unet-pick">Diffusion model <span class="opt">for ${esc(card?.name || eng)}</span></label>
    <select id="unet-pick">
      <option value=""${cur ? "" : " selected"}>Default${def ? ` · ${esc(def.replace(/\\/g, "/"))}` : " (not installed)"}</option>
      ${ch.match.length ? `<optgroup label="Made for ${esc(card?.name || eng)}">${ch.match.map(opt).join("")}</optgroup>` : ""}
      ${ch.other.length ? `<optgroup label="Other diffusion models (may not work)">${ch.other.map(opt).join("")}</optgroup>` : ""}
    </select>
    <p class="hint" id="unet-hint">${cur && ch.other.includes(cur)
      ? `<span class="warn">⚠ This file isn't known to be made for ${esc(card?.name || eng)}: the run may fail or look wrong.</span>`
      : "Swap in a fine-tune or another version of the model. The text encoder and VAE stay the same."}</p>`;
  $("#unet-pick").onchange = e => {
    if (e.target.value) state.unet[eng] = e.target.value; else delete state.unet[eng];
    renderModels(); scheduleSave();
  };
}

/* Sampler and scheduler for the picked engine (the Model step). Empty = the engine's own, which
   is what its ComfyUI template uses; the lists are ComfyUI's own (KSampler). */
const SAMPLING_NOTES = {
  h3image: "H3 Image is distilled for 6 steps on its own sigma grid: keep the simple scheduler and 6 steps, or the picture may come out noisy.",
  h3ref: "By default H3 Reference uses simple with the turbo LoRA and beta without it.",
  h3: "With the turbo LoRA, H3 is distilled for res_multistep and simple.",
  krea2: "Krea 2 Turbo is distilled for 8 steps with euler and simple.",
};
function renderSampling() {
  const box = $("#sampling-field");
  if (!box) return;
  const eng = state.engine[state.kind], caps = state.caps, def = caps?.sampling_defaults?.[eng];
  if (!def || !caps.samplers?.length) { box.hidden = true; return; }
  box.hidden = false;
  const cur = state.sampling[eng] || {};
  const defSched = eng === "h3ref" ? "simple or beta" : def.scheduler;
  const sel = (id, list, val, dflt, label) => `<label class="samp-l">${label}<select id="${id}">
      <option value=""${val ? "" : " selected"}>Default · ${esc(dflt)}</option>
      ${list.map(n => `<option value="${esc(n)}"${n === val ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`;
  const changed = !!(cur.sampler || cur.scheduler);
  box.innerHTML = `<label>Sampling <span class="opt">sampler and scheduler</span></label>
    <div class="samp-row">${sel("samp-sampler", caps.samplers, cur.sampler, def.sampler, "Sampler")}${sel("samp-scheduler", caps.schedulers, cur.scheduler, defSched, "Scheduler")}</div>
    <p class="hint">${changed && SAMPLING_NOTES[eng] ? `<span class="warn">⚠ ${esc(SAMPLING_NOTES[eng])}</span>`
      : "Default is what the model's ComfyUI template uses. Other choices change the look and the speed."}
      ${changed ? ` <button type="button" class="link" id="samp-reset">Back to default</button>` : ""}</p>`;
  const save = () => {
    const s = { sampler: $("#samp-sampler").value, scheduler: $("#samp-scheduler").value };
    if (s.sampler || s.scheduler) state.sampling[eng] = s; else delete state.sampling[eng];
    renderSampling(); renderSteps?.(); scheduleSave();
  };
  $("#samp-sampler").onchange = save; $("#samp-scheduler").onchange = save;
  const r = $("#samp-reset"); if (r) r.onclick = () => { delete state.sampling[eng]; renderSampling(); scheduleSave(); };
}

function pickModel(key) {
  const [kind, engine] = key.split(":");
  const prev = state.engine[state.kind];
  state.kind = kind; state.engine[kind] = engine;
  renderForm();
  scheduleSave();
  if (engine !== prev) Loras.checkFit(prev);  // LoRAs made for the old model may not fit the new one
}

/* ------------------------------------------------------------------ steps */
const STEPS = {
  project: { title: "Project", sub: "Start a new project, open a saved one, or just experiment." },
  model: { title: "Model", sub: "Choose what to make and the model that makes it." },
  inputs: { title: "Inputs", sub: "" },
  shots: { title: "Shots", sub: "Plan the video shot by shot: each with its length, framing, action, camera, line and inputs." },
  loras: { title: "LoRAs", sub: "Add LoRAs to the model: styles, characters, motions." },
  prompt: { title: "Prompt", sub: "Describe what you want. The Prompt Writer can turn a short idea into a full shot list." },
  settings: { title: "Settings", sub: "Size, length, speed and variations." },
  generate: { title: "Generate", sub: "Check your choices, then make it." },
};
const ORDER = Object.keys(STEPS);

function stepApplies(id) { return !["inputs", "shots"].includes(id) || state.kind === "video"; }
function visibleSteps() { return ORDER.filter(stepApplies); }
function stepDone(id) {
  const eng = state.engine[state.kind];
  switch (id) {
    case "project": return state.projectChosen;
    case "model": return !!state.caps?.engines?.[eng]?.ready;
    case "inputs": return eng === "h3ref" ? state.refs.length > 0 : !!(state.frames.first_frame || state.frames.last_frame);
    case "prompt": return !!$("#prompt").value.trim() || (typeof Shots !== "undefined" && Shots.on());
    case "shots": return typeof Shots !== "undefined" && Shots.on();
    case "loras": return state.loras.length > 0;
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
  if (!stepApplies(state.step)) return showStep(["inputs", "shots"].includes(state.step) ? "prompt" : "project");
  const i = vis.indexOf(state.step);
  $("#btn-back").disabled = i <= 0;
  $("#btn-next").hidden = i >= vis.length - 1;
  $("#btn-quick-gen").hidden = state.step === "generate";
  $("#btn-quick-gen").disabled = $("#btn-generate").disabled;
  const eng = state.engine[state.kind];
  const model = MODEL_CARDS.find(m => m.kind === state.kind && m.engine === eng)?.name || eng;
  $("#nav-info").textContent = `${state.project ? state.project.name : "Experiment"} · ${model}`;
  if (state.step === "inputs") renderInputsHead();
  if (state.step === "shots") Shots.render();
  if (state.step === "loras") Loras.render();
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
    row("Model", `${esc(card?.name || eng)} · ${ms.label}${state.unet[eng] && unetFor(eng) === state.unet[eng] ? ` · ${esc(state.unet[eng].split(/[\\/]/).pop())}` : ""}${state.sampling[eng] ? ` · ${esc([state.sampling[eng].sampler, state.sampling[eng].scheduler].filter(Boolean).join(" / "))}` : ""}`, "model", ms.cls !== "ok"),
    inputs !== null ? row("Inputs", esc(inputs || "add at least one picture"), "inputs", !inputs) : "",
    row("Prompt", prompt ? `<div class="pv">${esc(prompt.length > 400 ? prompt.slice(0, 400) + "…" : prompt)}</div>` : "empty", "prompt", !prompt),
    state.loras.length ? (() => {
      const bad = Loras.mismatched();
      return row("LoRAs", `${state.loras.length} LoRA${state.loras.length === 1 ? "" : "s"}${bad.length ? ` · ⚠ ${bad.length} made for another model` : ""}`, "loras", bad.length > 0);
    })() : "",
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
    seed: $("#seed").value, steps: $("#steps").value, cfg: $("#cfg").value, batch: state.batch,
    turbo: $("#turbo").checked, enhance: $("#enhance").checked, fidelity: $("#fidelity").checked,
    refs: state.refs.map(pickRef), frames: { first_frame: pickRef(state.frames.first_frame), last_frame: pickRef(state.frames.last_frame) },
    audios: state.arefs.map(pickRef), clean_audio: $("#clean-audio").checked,
    loras: state.loras.map(l => ({ name: l.name, strength: l.strength })),
    unet: { ...state.unet },
    sampling: structuredClone(state.sampling),
    shots: state.shots ? structuredClone(state.shots) : null,
  };
}

function applySettings(s) {
  state.loading = true;
  try {
    if (!s) { renderForm(); return; }
    if (s.kind) state.kind = s.kind;  // settings without a model choice keep the current one
    Object.assign(state.engine, s.engine || {});
    state.batch = s.batch || 1;
    $$("#batch-seg button").forEach(b => b.classList.toggle("active", +b.dataset.v === state.batch));
    state.refs = (s.refs || []).filter(Boolean).map(r => ({ ...r }));
    state.arefs = (s.audios || []).filter(Boolean).map(r => ({ ...r, name: r.ref.split("/").pop() }));
    $("#clean-audio").checked = s.clean_audio !== false;
    state.loras = (s.loras || []).filter(l => l && l.name).map(l => ({ name: l.name, strength: +l.strength || 1 }));
    state.unet = s.unet && typeof s.unet === "object" ? Object.fromEntries(Object.entries(s.unet).filter(([, v]) => typeof v === "string" && v)) : {};
    state.sampling = s.sampling && typeof s.sampling === "object"
      ? Object.fromEntries(Object.entries(s.sampling).filter(([, v]) => v && typeof v === "object" && (v.sampler || v.scheduler))
          .map(([k, v]) => [k, { sampler: String(v.sampler || ""), scheduler: String(v.scheduler || "") }])) : {};
    state.shots = s.shots && Array.isArray(s.shots.list) ? structuredClone(s.shots) : null;
    // A hand-edited or partial file may lack shot fields; the Shots step expects all of them.
    if (state.shots) state.shots.list = state.shots.list.filter(x => x && typeof x === "object").map(x => ({
      id: Math.random().toString(16).slice(2, 10), seconds: 3, framing: "medium shot", setting: "", action: "", camera: "holds a static shot",
      dialogue: "", voice: "", first_frame: null, last_frame: null, refs: [], ...x }));
    renderForm();
    $("#prompt").value = s.prompt || "";
    $("#lyrics").value = s.lyrics || "";
    if (s.aspect && [...$("#aspect").options].some(o => o.value === s.aspect)) $("#aspect").value = s.aspect;
    if (s.quality && [...$("#quality").options].some(o => o.value === s.quality)) $("#quality").value = s.quality;
    if (s.seconds) $("#seconds").value = s.seconds;
    $("#seed").value = s.seed ?? -1;
    $("#steps").value = s.steps ?? "";
    $("#cfg").value = s.cfg ?? "";
    $("#turbo").checked = s.turbo !== false;
    $("#enhance").checked = !!s.enhance;
    $("#fidelity").checked = !!s.fidelity;
    for (const role of ["first_frame", "last_frame"]) {
      const f = s.frames?.[role];
      if (f) setFrame(role, f.ref, f.url); else clearFrame(role);
    }
    renderRefs();
    renderArefs();
    Loras.render(); Shots.render();
    updateDerived();
  } finally {
    state.loading = false;
  }
}

/* Auto-save (Project settings). Off: changes collect here until Save / Ctrl+S. */
const Autosave = {
  enabled: true, delay: 0.7, dirty: new Set(),
  configure(cfg) {
    this.enabled = cfg?.autosave !== false;
    this.delay = Math.max(0.2, +(cfg?.autosave_delay ?? 0.7));
    this.render();
  },
  mark(what) { this.dirty.add(what); this.render(); },
  // Form renders call scheduleSave() too; with auto-save off only a real difference from what's saved counts.
  baseline: null,
  setBaseline() { try { this.baseline = JSON.stringify(collectSettings()); } catch { this.baseline = null; } },
  markSettings() {
    let now = null; try { now = JSON.stringify(collectSettings()); } catch {}
    if (now !== null && now === this.baseline) { this.dirty.delete("settings"); this.render(); return; }
    this.mark("settings");
  },
  render() {
    const b = $("#st-save");
    if (!b) return;
    b.hidden = !this.dirty.size;
    b.title = `Unsaved: ${[...this.dirty].join(", ")}. Save the project (Ctrl+S)`;
  },
  async saveAll() {
    clearTimeout(saveTimer);
    const what = [...this.dirty];
    await saveNow(true);
    await TL.saveNow(true);
    await saveNotes(true);
    this.dirty.clear(); this.render();
    if (what.length) Media.toast(`Saved ${state.project ? state.project.name : "Experiment"}.`);
  },
};

let saveTimer = null;
function scheduleSave() {
  if (state.loading || !state.shellReady) return;
  clearTimeout(saveTimer);
  renderSteps();
  if (!Autosave.enabled) return Autosave.markSettings();
  saveTimer = setTimeout(saveNow, Autosave.delay * 1000);
}
async function saveNow(force = false) {
  clearTimeout(saveTimer);
  if (!Autosave.enabled && !force) { Autosave.markSettings(); return; }
  Autosave.dirty.delete("settings"); Autosave.render(); Autosave.setBaseline();
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
      <div class="saved">${Autosave.enabled ? "Saved automatically" : "Auto-save off (Ctrl+S saves)"} · last change ${esc(timeOf(p.modified))} ·
        <button type="button" class="link" id="btn-history">Versions…</button> ·
        <button type="button" class="link" id="btn-duplicate">⧉ Duplicate…</button> ·
        <button type="button" class="link" id="btn-rename">✎ Rename…</button> ·
        <button type="button" class="link danger-link" id="btn-delete">🗑 Delete…</button> ·
        <button type="button" class="link" id="btn-psettings">⚙ Settings…</button></div></div>`;
    $("#btn-history").onclick = () => historyDialog(p.id);
    $("#btn-rename").onclick = () => renameProjectDialog();
    $("#btn-delete").onclick = () => deleteProjectDialog();
    $("#btn-duplicate").onclick = () => duplicateProjectDialog({ id: p.id, name: p.name, path: p.path });
    $("#btn-psettings").onclick = projectSettingsDialog;
    $("#notes-where").textContent = "saved with the project";
  } else {
    card.innerHTML = `<div class="proj-thumb">${EXPERIMENT_ICON}</div>
      <div><h3>Experiment</h3><div class="where">Nothing is saved as a project. Your settings stay in this browser.</div>
      <div class="saved"><button type="button" class="link" id="btn-save-as">Save as project…</button> ·
        <button type="button" class="link" id="btn-duplicate" title="A new project with Experiment's settings, timeline, library and results">⧉ Copy to a project…</button> ·
        <button type="button" class="link" id="btn-history">Versions…</button> ·
        <button type="button" class="link" id="btn-psettings">⚙ Settings…</button></div></div>`;
    $("#btn-history").onclick = () => historyDialog("experiment");
    $("#btn-duplicate").onclick = () => duplicateProjectDialog({ id: "experiment", name: "Experiment", path: "" });
    $("#btn-psettings").onclick = projectSettingsDialog;
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

async function openProject(id, { quiet = false, save = true, restored = false } = {}) {
  if (save && !(await leaveProject())) return null;
  try {
    clearTimeout(saveTimer);
    if (save && Autosave.enabled && state.project) await saveNow();
    else if (save && Autosave.enabled && state.shellReady) saveNow();  // keep the experiment's settings
    const p = await api(`/api/projects/${encodeURIComponent(id)}`);
    state.project = p; state.projectChosen = true;
    writeUI({ lastProject: p.id });
    // A brand-new project takes what's on screen; a restored version always brings its own settings back.
    applySettings(restored || (p.settings && (p.settings.kind || p.settings.prompt)) ? p.settings : collectSettings());
    $("#proj-notes").value = p.notes || "";
    Autosave.configure(p.config);
    Media.setProject(p.id, p.config?.gallery);
    TL.setProject(p.id, p.timeline);
    state.scope = "project"; syncScope();
    renderProjectCard(); renderRecent(); renderGallery(); selectInScope(); renderSteps();
    clearTimeout(saveTimer); Autosave.dirty.clear(); Autosave.render(); Autosave.setBaseline();  // just opened: nothing unsaved yet
    return p;
  } catch (e) {
    if (!quiet) WM.ask({ title: "Can't open project", message: e.message, ok: "OK", cancel: "Close" });
    return null;
  }
}

async function loadExperimentMedia() {
  try { const e = await api("/api/projects/experiment"); Autosave.configure(e.config); Media.setProject("experiment", e.config?.gallery); await TL.setProject("experiment", e.timeline);
    Autosave.dirty.clear(); Autosave.render(); Autosave.setBaseline(); }
  catch { Media.setProject("experiment", null); TL.setProject("experiment", null); }
}

async function startExperiment() {
  if (!(await leaveProject())) return;
  if (state.project) await saveNow(true);
  state.project = null; state.projectChosen = true;
  writeUI({ lastProject: null });
  const ex = loadExperiment();
  if (ex?.settings) applySettings(ex.settings);
  $("#proj-notes").value = ex?.notes || "";
  loadExperimentMedia();
  syncScope();
  renderProjectCard(); renderRecent(); renderGallery(); selectInScope(); renderSteps();
}

async function saveNotes(force = false) {
  if (!Autosave.enabled && !force) return Autosave.mark("notes");
  Autosave.dirty.delete("notes"); Autosave.render();
  if (!state.project) return saveNow(true);
  try { await api(`/api/projects/${state.project.id}`, { method: "PUT", body: JSON.stringify({ notes: $("#proj-notes").value }) }); } catch {}
}

/* Before leaving a project with unsaved changes: "save" | "discard" | null (cancel). */
function askUnsaved() {
  if (!Autosave.dirty.size) return Promise.resolve("discard");
  return new Promise(resolve => {
    const box = document.createElement("div");
    box.className = "wm-ask";
    box.innerHTML = `<p>Save the changes to <b>${esc(state.project ? state.project.name : "Experiment")}</b> first? Unsaved: ${esc([...Autosave.dirty].join(", "))}.</p>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button>
      <button type="button" class="btn sm danger" data-a="discard">Don't save</button><button type="button" class="btn sm primary" data-a="save">Save</button>`;
    let done = false;
    const w = WM.open({ title: "Unsaved changes", content: box, footer: foot, width: 440, height: 190, minWidth: 320, minHeight: 160,
      onClose: () => { if (!done) resolve(null); } });
    foot.addEventListener("click", e => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      done = true; w.close(); resolve(a === "cancel" ? null : a);
    });
  });
}
async function leaveProject() {
  const choice = await askUnsaved();
  if (choice === null) return false;
  if (choice === "save") await Autosave.saveAll();
  Autosave.dirty.clear(); Autosave.render();
  return true;
}

/* Project settings: auto-save, linked audio, version history. Stored in project.json (config + timeline). */
async function projectSettingsDialog() {
  const id = state.project?.id || "experiment";
  let cfg = {};
  try { cfg = (await api(`/api/projects/${id}`)).config || {}; } catch {}
  const tlm = TL.model || {};
  const delays = [[0.7, "Right away"], [5, "After 5 seconds"], [30, "After 30 seconds"], [120, "After 2 minutes"]];
  const form = document.createElement("div");
  form.className = "wm-form";
  form.innerHTML = `
    <div class="field toggle-row"><label class="switch"><input type="checkbox" id="ps-auto"${cfg.autosave !== false ? " checked" : ""}><span></span></label>
      <div><strong>Auto-save</strong> <span class="hint inline">Off: save with Ctrl+S or the Save button; you're asked before leaving with unsaved changes</span></div></div>
    <div class="field"><label for="ps-delay">Save changes</label><select id="ps-delay">${delays.map(([v, l]) => `<option value="${v}"${Math.abs((cfg.autosave_delay ?? 0.7) - v) < 1e-6 ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="field toggle-row"><label class="switch"><input type="checkbox" id="ps-link"${tlm.link_audio !== false ? " checked" : ""}><span></span></label>
      <div><strong>Linked audio</strong> <span class="hint inline">Adding a video with sound puts its sound on an audio track, linked to the clip</span></div></div>
    <div class="field"><label for="ps-where">Sound goes on</label><select id="ps-where">
      <option value="new"${tlm.link_audio_track !== "free" ? " selected" : ""}>A new audio track for each video (A1, A2, A3…)</option>
      <option value="free"${tlm.link_audio_track === "free" ? " selected" : ""}>The first free audio track</option></select></div>
    <div class="field"><label>Versions</label><p class="hint">Versions of the project are kept automatically as it changes, and you can save named ones.
      How often and how many: <button type="button" class="link" id="ps-vsettings">Settings › Projects</button>. <button type="button" class="link" id="ps-history">Versions…</button></p></div>`;
  const sync = () => { form.querySelector("#ps-delay").disabled = !form.querySelector("#ps-auto").checked; form.querySelector("#ps-where").disabled = !form.querySelector("#ps-link").checked; };
  form.addEventListener("change", sync); sync();
  const foot = document.createElement("div");
  foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="ok">Save settings</button>`;
  const w = WM.open({ id: "project-settings", title: `Project settings · ${state.project ? state.project.name : "Experiment"}`, content: form, footer: foot,
    width: 560, height: 460, minWidth: 360, minHeight: 320 });
  form.querySelector("#ps-history").onclick = () => historyDialog(id);
  form.querySelector("#ps-vsettings").onclick = () => Settings.open("projects");
  foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
  foot.querySelector('[data-a="ok"]').onclick = async () => {
    const config = { autosave: form.querySelector("#ps-auto").checked, autosave_delay: +form.querySelector("#ps-delay").value };
    try {
      await api(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify({ config }) });
      const wasOff = !Autosave.enabled;
      Autosave.configure(config); renderProjectCard();
      TL.setLinkAudio(form.querySelector("#ps-link").checked, form.querySelector("#ps-where").value);
      if (wasOff && config.autosave && Autosave.dirty.size) await Autosave.saveAll();  // turning it on saves what's pending
      w.close();
      Media.toast(config.autosave ? "Auto-save is on." : "Auto-save is off: save with Ctrl+S.");
    } catch (e) { Media.toast(e.message); }
  };
}

/* Versions of project.json: kept automatically (Settings > Projects: how often, how many) and
   by name (Save a version). Each shows what changed since the one before it; any can come back. */
async function historyDialog(id) {
  const box = document.createElement("div");
  box.className = "wm-form";
  const keep = Settings.get("projects.versions_keep", 30), mins = Settings.get("projects.version_minutes", 1);
  const every = mins < 1 ? `${Math.round(mins * 60)} seconds` : mins === 1 ? "minute" : `${mins} minutes`;
  const w = WM.open({ id: "history", title: `Versions · ${id === "experiment" ? "Experiment" : state.project?.name || "Project"}`, content: box,
    width: 620, height: 560, minWidth: 380, minHeight: 280 });
  const tagText = { startup: "kept at startup", "before-restore": "kept before a restore", current: "" };
  async function render() {
    let versions = [];
    try { versions = (await api(`/api/projects/${id}/history`)).versions; } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    const rows = versions.map(v => {
      const cur = !v.file, named = !!v.label;
      const when = new Date(v.saved * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const chg = (v.changes || []).length ? v.changes : [cur ? "no changes since the last version" : "same as the version before"];
      return `<div class="ver-row${cur ? " current" : ""}${named ? " named" : ""}">
        <div>${named ? `<span class="ver-name">★ ${esc(v.label)}</span>` : ""}<b>${cur ? "Now" : esc(when)}</b>${tagText[v.tag] ? `<span class="ver-tag">${tagText[v.tag]}</span>` : ""}
          <small>${v.clips} clip${v.clips === 1 ? "" : "s"} · ${v.media} library item${v.media === 1 ? "" : "s"}${v.prompt ? ` · “${esc(v.prompt)}”` : ""}</small>
          ${chg.length ? `<div class="ver-chg" title="What changed since the version before">${chg.map(c => `<span>${esc(c)}</span>`).join("")}</div>` : ""}</div>
        <div class="ver-acts">${cur ? "" : `<button type="button" class="btn sm" data-restore="${esc(v.file)}" title="Go back to this version">Restore</button>
          <button type="button" class="btn sm ghost" data-name="${esc(v.file)}" data-label="${esc(v.label)}" title="${named ? "Rename, or clear the name" : "Name it: named versions are kept until you delete them"}">${named ? "Rename" : "☆ Name"}</button>
          <button type="button" class="btn sm ghost" data-del="${esc(v.file)}" title="Delete this version" aria-label="Delete this version">🗑</button>`}</div></div>`;
    }).join("");
    box.innerHTML = `<div class="ver-save"><input type="text" maxlength="120" placeholder="Name this version, e.g. “Before the new ending”" aria-label="Version name">
        <button type="button" class="btn sm primary" data-a="save">Save a version</button></div>
      <p class="hint">A version is kept automatically at most every ${every} while you work (the last ${keep}, set in <button type="button" class="link" data-a="settings">Settings</button>). Named versions are kept until you delete them. Restoring keeps the current state as a version first.</p>
      <div class="ver-list">${rows || `<p class="hint">No versions yet.</p>`}</div>`;
  }
  box.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches(".ver-save input")) box.querySelector('[data-a="save"]').click(); });
  box.addEventListener("click", async e => {
    const t = e.target;
    if (t.closest('[data-a="settings"]')) return Settings.open("projects");
    try {
      if (t.closest('[data-a="save"]')) {
        await Autosave.saveAll?.(); await TL.saveNow();
        const label = box.querySelector(".ver-save input").value.trim();
        const r = await api(`/api/projects/${id}/versions`, { method: "POST", body: JSON.stringify({ label }) });
        Media.toast(`Saved the version “${r.label}”.`); return render();
      }
      const n = t.closest("[data-name]");
      if (n) {
        const label = prompt("Name this version (empty clears the name; unnamed versions can be pruned):", n.dataset.label || "");
        if (label === null) return;
        await api(`/api/projects/${id}/versions/${encodeURIComponent(n.dataset.name)}`, { method: "PUT", body: JSON.stringify({ label }) });
        return render();
      }
      const d = t.closest("[data-del]");
      if (d) {
        if (!await WM.ask({ title: "Delete this version?", message: "It can't come back afterwards.", ok: "Delete" })) return;
        await api(`/api/projects/${id}/versions/${encodeURIComponent(d.dataset.del)}`, { method: "DELETE" });
        return render();
      }
      const b = t.closest("[data-restore]");
      if (b) {
        if (!await WM.ask({ title: "Restore this version?", message: "Settings, library and timeline go back to how they were then. The current state is kept as a named version first, so you can undo this.", ok: "Restore" })) return;
        await TL.saveNow();
        await api(`/api/projects/${id}/restore`, { method: "POST", body: JSON.stringify({ path: "", name: b.dataset.restore }) });
        // Reopen without saving first: saving now would write the old form over the restored version.
        if (id === "experiment") await loadExperimentMedia(); else await openProject(id, { save: false, restored: true });
        Media.toast("Restored."); return render();
      }
    } catch (err) { Media.toast(err.message); }
  });
  await render();
  return w;
}

/* Rename the open project: its folder and its name. Pending changes are saved first. */
async function renameProjectDialog() {
  const p = state.project;
  if (!p) return Media.toast("Experiment isn't a project. Save it as one first.");
  const name = await WM.ask({ title: "Rename project", message: `New name for “${p.name}”. Its folder is renamed too.`, input: p.name, ok: "Rename" });
  if (name === null || !name.trim() || name.trim() === p.name) return;
  try {
    await Autosave.saveAll(); await TL.saveNow?.();
    const r = await api("/api/projects/rename", { method: "POST", body: JSON.stringify({ path: p.path, name: name.trim() }) });
    window.dispatchEvent(new CustomEvent("bob:project-renamed", { detail: { id: p.id, path: r.path, name: r.name } }));
    renderRecent();
    Media.toast(`Renamed to “${r.name}”.`);
  } catch (e) { WM.ask({ title: "Can't rename the project", message: e.message, ok: "OK", cancel: "Close" }); }
}

/* Delete the open project: its folder goes to projects/.trash (it can be brought back by hand). */
async function deleteProjectDialog() {
  const p = state.project;
  if (!p) return Media.toast("Experiment isn't a project, so there's nothing to delete.");
  const ok = await WM.ask({ title: "Delete project", danger: true, ok: "Delete",
    message: `Delete “${p.name}”? Its folder, settings, timeline, library and versions move to the projects trash (projects\\.trash), where they can be recovered by hand. Its generated pictures, videos and sounds stay in the gallery under All.` });
  if (!ok) return;
  // Nothing may write into the folder once it's in the trash: drop the pending settings save, flush the timeline's.
  clearTimeout(saveTimer); saveTimer = null;
  Autosave.dirty.clear(); Autosave.render();
  try {
    await TL.saveNow?.();
    await api("/api/projects/delete", { method: "POST", body: JSON.stringify({ path: p.path }) });
    window.dispatchEvent(new CustomEvent("bob:project-deleted", { detail: { id: p.id, path: p.path } }));
    renderRecent();
    Media.toast(`Deleted “${p.name}”: it's in the projects trash.`);
  } catch (e) { WM.ask({ title: "Can't delete the project", message: e.message, ok: "OK", cancel: "Close" }); }
}

/* The open project was deleted: drop what's pending for it (don't save into the trash) and go to Experiment. */
async function closeDeletedProject() {
  clearTimeout(saveTimer); saveTimer = null;
  TL.detach?.();
  Autosave.dirty.clear(); Autosave.render();
  state.project = null;
  writeUI({ lastProject: null });
  await startExperiment();
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

/* Duplicate a project (or Experiment). src = {id, name, path}. Settings, prompt, LoRAs, Shots,
   notes and options always come along; the timeline, media library and results are optional.
   Media files aren't duplicated: the copy points at the same uploads and outputs. */
function duplicateProjectDialog(src, { open = true, onDone = null } = {}) {
  const isExp = src.id === "experiment";
  let folder = isExp ? (readUI().newProjectFolder ?? "") : (src.path || "").split("/").slice(0, -1).join("/");
  const form = document.createElement("div");
  form.className = "wm-form";
  form.innerHTML = `
    <div class="field"><label for="dp-name">Name of the copy</label><input id="dp-name" type="text" maxlength="120" value="${esc(`${src.name} copy`)}"></div>
    <div class="field"><label for="dp-loc">Location</label>
      <div class="loc"><input id="dp-loc" type="text" readonly><button type="button" class="btn sm" id="dp-browse">Browse…</button></div></div>
    <div class="field"><label>Copy</label>
      <div class="dp-parts">
        <label class="check"><input type="checkbox" checked disabled> Settings: model, prompt, LoRAs, Shots, inputs, notes and options</label>
        <label class="check"><input type="checkbox" id="dp-timeline" checked> Timeline: clips, effects, camera moves, markers, export settings</label>
        <label class="check"><input type="checkbox" id="dp-library" checked> Media library: pictures, videos and sounds with their tags, ratings and folders</label>
        <label class="check"><input type="checkbox" id="dp-results" checked> Results: the generated pictures, videos and sounds in the gallery</label>
      </div>
      <p class="hint">Files aren't duplicated: both projects use the same uploads and results, so the copy takes no extra space.
        Deleting a result in one project keeps the file while the other still uses it.</p></div>
    ${open ? `<label class="check"><input type="checkbox" id="dp-open" checked> Open the copy</label>` : ""}
    <p class="err" id="dp-err"></p>`;
  const foot = document.createElement("div");
  foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button>
    <button type="button" class="btn sm primary" data-a="copy">Duplicate</button>`;
  const win = WM.open({ id: "dup-project", title: `Duplicate “${src.name}”`, content: form, footer: foot, width: 560, height: 520, minWidth: 380, minHeight: 400 });
  const loc = form.querySelector("#dp-loc");
  const showLoc = () => { loc.value = ["Projects", ...folder.split("/").filter(Boolean)].join(" › "); };
  showLoc();
  form.querySelector("#dp-browse").onclick = () => Explorer.open({ mode: "folder", startPath: folder, title: "Choose where to save the copy",
    onPick: path => { folder = path; showLoc(); } });
  const name = form.querySelector("#dp-name");
  name.focus(); name.select();
  const go = async () => {
    const btn = foot.querySelector('[data-a="copy"]');
    btn.disabled = true;
    try {
      if (state.project?.id === src.id || (isExp && !state.project)) await Autosave.saveAll();  // copy what's on screen
      const p = await api("/api/projects/copy", { method: "POST", body: JSON.stringify({
        id: src.id, name: name.value, folder,
        timeline: form.querySelector("#dp-timeline").checked, library: form.querySelector("#dp-library").checked,
        results: form.querySelector("#dp-results").checked }) });
      win.close();
      Media.toast(`Copied to “${p.name}”${p.results_copied ? ` with ${p.results_copied} result${p.results_copied > 1 ? "s" : ""}` : ""}.`);
      if (open && form.querySelector("#dp-open")?.checked) await openProject(p.id);
      onDone?.(p);
    } catch (e) { form.querySelector("#dp-err").textContent = e.message; btn.disabled = false; }
  };
  foot.querySelector('[data-a="copy"]').onclick = go;
  foot.querySelector('[data-a="cancel"]').onclick = () => win.close();
  name.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
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
  $("#form").addEventListener("click", e => { const b = e.target.closest(".advanced [data-goto]"); if (b) showStep(b.dataset.goto); });
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
    if (!Autosave.enabled) return Autosave.mark("notes");
    notesTimer = setTimeout(() => saveNotes(), Autosave.delay * 1000);
  });
  $("#st-save").onclick = () => Autosave.saveAll();
  addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); Autosave.saveAll(); }
  }, true);
  addEventListener("beforeunload", e => { if (Autosave.dirty.size) { e.preventDefault(); e.returnValue = ""; } });
  $("#form").addEventListener("input", e => { if (e.target.id !== "proj-notes") scheduleSave(); });
  $("#form").addEventListener("change", e => { if (e.target.id !== "proj-notes") scheduleSave(); });
  $$("#scope-seg button").forEach(b => b.onclick = () => { state.scope = b.dataset.s; syncScope(); renderGallery(); selectInScope(); });
  window.addEventListener("bob:project-renamed", e => {
    if (state.project && e.detail.id === state.project.id) { state.project.name = e.detail.name; state.project.path = e.detail.path; renderProjectCard(); renderSteps(); }
  });
  window.addEventListener("bob:project-deleted", e => { if (state.project && e.detail.id === state.project.id) closeDeletedProject(); });
  window.addEventListener("beforeunload", () => { if (saveTimer) saveNow(); });

  // Reopen what was open last time; otherwise the experiment.
  const ui = readUI();
  let opened = null;
  if (ui.lastProject && Settings.get("projects.reopen_last", true)) opened = await openProject(ui.lastProject, { quiet: true });
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
