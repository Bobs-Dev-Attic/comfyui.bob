/* Inputs › reference pictures and sounds: the ⋯ menu on each.
   Pictures: Open (a large view), Edit… (the image editor; saving swaps in the edited copy), Describe with AI…
   (a vision LLM writes a detailed description to use in prompts, kept with the picture), Remove.
   Sounds: Audio tools… (volume, loudness, noise, rumble, remove music, trim silence, with a live preview to
   compare against the original; Save swaps in the cleaned copy, the original file is kept), Remove. */
"use strict";

const RefTools = (() => {
  const llmOpts = () => {
    const v = id => document.getElementById(id)?.value ?? "";
    return { backend: v("llm-backend") || null, url: v("llm-url").trim() || null, model: v("llm-model") || null };
  };
  function menuAt(anchor, items) {
    const r = anchor.getBoundingClientRect();
    Media.menu(r.left, r.bottom + 4, items);
    anchor.setAttribute("aria-expanded", "true");
    const m = document.querySelector(".ex-menu");
    new MutationObserver((_, obs) => { if (!m.isConnected) { anchor.setAttribute("aria-expanded", "false"); obs.disconnect(); } })
      .observe(document.body, { childList: true });
  }

  /* ---------------------------------------------------------------- pictures */
  function pictureMenu(i, anchor) {
    const r = state.refs[i]; if (!r) return;
    menuAt(anchor, [
      ["🔍  Open", () => openPicture(i)],
      ["✎  Edit…", () => editPicture(i)],
      [`✨  Describe with AI…${r.desc ? " (has one)" : ""}`, () => describe(i)],
      ["🎬  Animate objects…", () => Motion.open({ ref: r.ref, url: r.url, name: r.ref.split("/").pop() })],
      ["🗑  Remove", () => { state.refs.splice(i, 1); renderRefs(); }],
    ]);
  }
  function openPicture(i) {
    const r = state.refs[i];
    const box = document.createElement("div");
    box.className = "rt-view";
    box.innerHTML = `<img src="${esc(r.url)}" alt="Picture ${i + 1}">${r.desc ? `<p class="hint">${esc(r.desc)}</p>` : ""}`;
    WM.open({ id: "ref-view", title: `Picture ${i + 1} · ${r.ref.split("/").pop()}`, content: box, width: 820, height: 680, modal: false });
  }
  function editPicture(i) {
    const r = state.refs[i];
    if (typeof Editor === "undefined") return;
    Editor.open({ kind: "image", project: state.project?.id ?? null, files: [{ url: r.url, path: r.ref, name: r.ref.split("/").pop() }] }, {
      onSave: item => {
        const f = item.files?.[0]; if (!f) return;
        const k = state.refs.findIndex(x => x === r);  // the picture may have moved while the editor was open
        if (k < 0) return Media.toast("Saved as a new result.");
        state.refs[k] = { ref: f.path, url: f.url, ...(r.desc ? { desc: r.desc } : {}) };
        renderRefs();
        Media.toast(`Saved. Picture ${k + 1} now uses the edited picture (also in your results).`);
      },
    });
  }
  // Where a description can go: the Prompt step's prompt, or (video) a shot's "What happens".
  function describe(i) {
    const r = state.refs[i];
    const box = document.createElement("div");
    box.className = "rt-desc";
    const video = state.kind === "video", shots = video && typeof Shots !== "undefined" ? (Shots.ensure().list || []) : [];
    box.innerHTML = `<div class="rt-desc-top"><img src="${esc(r.url)}" alt=""><div>
        <p class="hint">A vision model looks at <b>Picture ${i + 1}</b> and writes a detailed description you can use in a prompt.
        It uses the Prompt writer's LLM (it needs one that can see pictures, such as qwen3-vl).</p>
        <p class="rt-status hint" aria-live="polite"></p></div></div>
      <textarea class="rt-text" rows="9" placeholder="The description appears here; you can edit it.">${esc(r.desc || "")}</textarea>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<button type="button" class="btn sm" data-a="run">${r.desc ? "↻ Describe again" : "✨ Describe"}</button>
      <span class="wm-foot-gap"></span>
      <button type="button" class="btn sm ghost" data-a="copy">Copy</button>
      ${video ? `<select data-a="shot" aria-label="Shot">${shots.map((_, k) => `<option value="${k}">Shot ${k + 1}</option>`).join("")}</select>
        <button type="button" class="btn sm" data-a="to-shot" title="Add it to that shot's What happens">Add to shot</button>`
        : `<button type="button" class="btn sm" data-a="to-prompt" title="Insert it into the prompt at the cursor">Insert in prompt</button>`}
      <button type="button" class="btn sm primary" data-a="keep">Keep</button>`;
    const w = WM.open({ id: "ref-describe", title: `Describe Picture ${i + 1}`, content: box, footer: foot, width: 640, height: 520 });
    const ta = box.querySelector(".rt-text"), st = box.querySelector(".rt-status");
    const text = () => ta.value.trim();
    const keep = () => { const k = state.refs.indexOf(r); if (k >= 0) { if (text()) r.desc = text(); else delete r.desc; renderRefs(); } };
    const tagged = () => `<Picture ${state.refs.indexOf(r) + 1}>: ${text()}`;
    async function run() {
      const b = foot.querySelector('[data-a="run"]'); b.disabled = true;
      st.textContent = "Looking at the picture…";
      try {
        const j = await api("/api/describe", { method: "POST", body: JSON.stringify({ ref: r.ref, ...llmOpts() }) });
        ta.value = j.text; keep();
        st.textContent = `Described by ${j.model} in ${j.seconds}s. Edit it if you like; it's kept with the picture.`;
        b.textContent = "↻ Describe again";
      } catch (e) { st.textContent = `⚠ ${e.message}`; }
      finally { b.disabled = false; }
    }
    foot.addEventListener("click", async e => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "run") return run();
      if (!text() && a !== "keep") return Media.toast("Describe the picture first.");
      if (a === "copy") { try { await navigator.clipboard.writeText(text()); Media.toast("Copied."); } catch {} }
      if (a === "keep") { keep(); w.close(); }
      if (a === "to-prompt") { keep(); insertAtCursor($("#prompt"), tagged()); $("#prompt").dispatchEvent(new Event("input", { bubbles: true })); w.close(); Media.toast("Added to the prompt."); }
      if (a === "to-shot") {
        keep();
        const k = +foot.querySelector('[data-a="shot"]').value, s = Shots.ensure().list[k];
        if (!s) return;
        s.action = [s.action.trim(), tagged()].filter(Boolean).join(" ");
        scheduleSave(); Shots.render(); w.close(); Media.toast(`Added to shot ${k + 1}'s What happens.`);
      }
    });
    if (!r.desc) run();
  }

  /* ---------------------------------------------------------------- sounds */
  function audioMenu(i, anchor) {
    if (!state.arefs[i]) return;
    menuAt(anchor, [
      ["🎚  Audio tools…", () => audioTools(i)],
      ["🗑  Remove", () => { state.arefs.splice(i, 1); renderArefs(); }],
    ]);
  }
  const DEF = { voice_only: false, rumble: false, denoise: 0, normalize: false, volume_db: 0, trim: false };
  function audioTools(i) {
    const a = state.arefs[i];
    const o = { ...DEF };
    const box = document.createElement("div");
    box.className = "rt-audio";
    box.innerHTML = `
      <p class="hint"><b>Audio ${i + 1}</b> · ${esc(a.name || a.ref.split("/").pop())}. Changes play back as you make them; Save
        replaces Audio ${i + 1} with the cleaned copy (the original file is kept).</p>
      <div class="rt-player">
        <div class="seg sm" role="group" aria-label="Listen to"><button type="button" data-ab="new" class="active">Processed</button><button type="button" data-ab="orig">Original</button></div>
        <audio controls preload="auto" src="${esc(a.url)}"></audio>
      </div>
      <p class="rt-status hint" aria-live="polite">No changes yet.</p>
      <div class="rt-tools">
        <label class="rt-row"><input type="checkbox" data-k="voice_only"> <span><b>Remove music</b> · keep only the voice <small>(Demucs in ComfyUI; the first time takes a while)</small></span></label>
        <div class="rt-row"><span><b>Reduce background noise</b> · hiss, fans, room tone</span><input type="range" min="0" max="100" step="5" data-k="denoise" value="0"><output data-o="denoise">Off</output></div>
        <label class="rt-row"><input type="checkbox" data-k="rumble"> <span><b>Remove rumble</b> · hum, wind and handling noise below 80 Hz</span></label>
        <label class="rt-row"><input type="checkbox" data-k="normalize"> <span><b>Even out loudness</b> · normalise to a standard level</span></label>
        <div class="rt-row"><span><b>Volume</b></span><input type="range" min="-12" max="12" step="0.5" data-k="volume_db" value="0"><output data-o="volume_db">0 dB</output></div>
        <label class="rt-row"><input type="checkbox" data-k="trim"> <span><b>Trim silence</b> at the start and end</span></label>
      </div>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<button type="button" class="btn sm ghost" data-a="reset">Reset</button><span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="save" disabled>Save</button>`;
    const w = WM.open({ id: "audio-tools", title: `Audio tools · Audio ${i + 1}`, content: box, footer: foot, width: 600, height: 560 });
    const au = box.querySelector("audio"), st = box.querySelector(".rt-status");
    let previewUrl = null, listen = "new", seq = 0, timer = 0;
    const plain = () => JSON.stringify(o) === JSON.stringify(DEF);
    const show = () => {
      box.querySelector('[data-o="denoise"]').textContent = o.denoise ? `${o.denoise}%` : "Off";
      box.querySelector('[data-o="volume_db"]').textContent = `${o.volume_db > 0 ? "+" : ""}${o.volume_db} dB`;
      foot.querySelector('[data-a="save"]').disabled = plain() || !previewUrl;
    };
    // Swap what's playing, keeping the position and whether it was playing.
    function play(url) {
      if (!url || au.getAttribute("src") === url) return;
      const t = au.currentTime, was = !au.paused;
      au.src = url;
      au.addEventListener("loadedmetadata", () => { try { au.currentTime = Math.min(t, au.duration || t); } catch {} if (was) au.play().catch(() => {}); }, { once: true });
    }
    async function preview() {
      const my = ++seq;
      if (plain()) { previewUrl = null; st.textContent = "No changes yet."; play(a.url); show(); return; }
      st.textContent = o.voice_only ? "Separating the voice from the music… (the first time per file takes a while)" : "Rendering the preview…";
      foot.querySelector('[data-a="save"]').disabled = true;
      try {
        const j = await api("/api/audio/preview", { method: "POST", body: JSON.stringify({ ref: a.ref, opts: o }) });
        if (my !== seq) return;  // a newer change is on its way
        previewUrl = j.url;
        st.textContent = `Preview ready (${j.seconds}s). Compare with the Original.`;
        if (listen === "new") play(previewUrl);
      } catch (e) { if (my === seq) st.textContent = `⚠ ${e.message}`; }
      show();
    }
    const schedule = () => { show(); clearTimeout(timer); timer = setTimeout(preview, 350); };
    box.addEventListener("input", e => {
      const k = e.target.dataset.k; if (!k) return;
      o[k] = e.target.type === "checkbox" ? e.target.checked : +e.target.value;
      schedule();
    });
    box.addEventListener("click", e => {
      const ab = e.target.closest("[data-ab]")?.dataset.ab; if (!ab) return;
      listen = ab;
      box.querySelectorAll("[data-ab]").forEach(b => b.classList.toggle("active", b.dataset.ab === ab));
      play(ab === "orig" ? a.url : previewUrl || a.url);
    });
    foot.addEventListener("click", async e => {
      const act = e.target.closest("[data-a]")?.dataset.a;
      if (act === "cancel") return w.close();
      if (act === "reset") {
        Object.assign(o, DEF);
        box.querySelectorAll("[data-k]").forEach(el => { if (el.type === "checkbox") el.checked = false; else el.value = DEF[el.dataset.k]; });
        return schedule();
      }
      if (act === "save") {
        const b = e.target.closest("button"); b.disabled = true; st.textContent = "Saving…";
        try {
          const j = await api("/api/audio/save", { method: "POST", body: JSON.stringify({ ref: a.ref, opts: o }) });
          const k = state.arefs.indexOf(a);
          if (k < 0) throw new Error("That sound was removed meanwhile");
          state.arefs[k] = { ref: j.ref, url: j.url, name: j.name };
          renderArefs(); au.pause(); w.close();
          Media.toast(`Saved. Audio ${k + 1} now uses the cleaned copy.`);
        } catch (err) { st.textContent = `⚠ ${err.message}`; b.disabled = false; }
      }
    });
    show();
  }

  return { pictureMenu, audioMenu, describe, audioTools };
})();
