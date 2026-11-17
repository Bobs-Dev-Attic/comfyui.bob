/* App-wide settings: a modal window (☰ menu > Settings…, or Ctrl+,) over data/settings.json.
   Changes apply right away and are saved as you make them (PUT /api/settings). The look is also
   cached in this browser, so the page starts in the right theme before the settings load. */
"use strict";

const Settings = (() => {
  const LOOK_KEY = "bob.look";
  const THEMES = [
    ["system", "System", "Follows your OS: dark or light"],
    ["dark", "Dark", "The studio's dark look"],
    ["light", "Light", "Bright panels, dark text"],
    ["midnight", "Midnight", "Deep blue-black"],
    ["graphite", "Graphite", "Neutral grey"],
    ["forest", "Forest", "Dark green tint"],
    ["paper", "Paper", "Warm light"],
    ["high-contrast", "High contrast", "Black, white and bright colors"],
  ];
  // Preview colors for the theme cards: [bg, panel, line, text].
  const SWATCH = {
    dark: ["#0e0f12", "#16181d", "#2a2e37", "#e9eaee"], light: ["#f4f4f6", "#ffffff", "#e2e4ea", "#17181c"],
    midnight: ["#0a0e1a", "#111729", "#243049", "#e6ebf5"], graphite: ["#1b1c1f", "#232428", "#3a3c42", "#ececee"],
    forest: ["#0d1410", "#131c17", "#26362c", "#e5eee8"], paper: ["#f3efe7", "#fbf8f2", "#ddd4c4", "#2a251d"],
    "high-contrast": ["#000000", "#0a0a0a", "#7a7a7a", "#ffffff"],
  };
  const ACCENTS = { orange: "#ff7a45", blue: "#4f8cff", violet: "#9b7bff", green: "#2fbf71", pink: "#ff5fa2", teal: "#22b8c8", gold: "#e5b52e", red: "#ef4444" };
  const SECTIONS = [
    ["appearance", "Appearance", "🎨"], ["projects", "Projects", "🗂"], ["generation", "Generation", "⚡"],
    ["editor", "Image editor", "✏"], ["updates", "Updates", "⟳"], ["advanced", "Settings file", "{ }"], ["about", "About", "ℹ"],
  ];

  let data = null;       // {settings, defaults, file, ...} from the server
  let modal = null;      // {root, section}
  let saveChain = Promise.resolve();
  const e = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------------------------------------------------------- the look */
  function applyLook(a) {
    if (!a) return;
    const r = document.documentElement;
    r.dataset.theme = a.theme || "system";
    r.dataset.accent = a.accent || "orange";
    r.dataset.text = a.font_size || "normal";
    r.dataset.motion = a.reduce_motion ? "reduce" : "";
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(a)); } catch { /* private window */ }
    const icon = document.querySelector('link[rel="icon"]');
    if (icon) icon.href = icon.href.replace(/fill='%23[0-9a-fA-F]{6}'/, `fill='%23${(ACCENTS[a.accent] || ACCENTS.orange).slice(1)}'`);
  }

  async function load() {
    try { data = await (await fetch("/api/settings")).json(); applyLook(data.settings.appearance); }
    catch { /* the server is down: keep the cached look */ }
    return data;
  }
  function get(path, fallback) {
    let v = data?.settings;
    for (const k of path.split(".")) v = v?.[k];
    return v === undefined ? fallback : v;
  }

  // Save a partial change, e.g. set({appearance: {theme: "light"}}); saves run one after another.
  function set(patch) {
    if (data) {  // apply locally first, so the window feels instant
      for (const [sec, vals] of Object.entries(patch)) Object.assign(data.settings[sec] ||= {}, vals);
      if (patch.appearance) applyLook(data.settings.appearance);
    }
    status("Saving…");
    saveChain = saveChain.then(async () => {
      const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || r.statusText);
      data = j; applyLook(data.settings.appearance);
      status("Saved");
      window.dispatchEvent(new CustomEvent("bob:settings", { detail: data.settings }));
    }).catch(err => { status(`Not saved: ${err.message}`, true); load().then(() => modal && render()); });
    return saveChain;
  }

  /* ---------------------------------------------------------------- the window */
  function status(msg, bad = false) {
    const s = modal?.root.querySelector(".set-status");
    if (s) { s.textContent = msg; s.title = msg; s.classList.toggle("bad", bad); }
  }

  async function open(section = "appearance") {
    if (!data) await load();
    if (!data) return Media.toast("Can't load the settings: is the studio running?");
    if (modal) { modal.section = section; render(); return; }
    const root = document.createElement("div");
    root.className = "set-overlay";
    root.innerHTML = `<div class="set-modal" role="dialog" aria-modal="true" aria-labelledby="set-title">
      <header class="set-head"><h2 id="set-title">Settings</h2><span class="set-status" aria-live="polite"></span>
        <button type="button" class="set-x" data-a="close" aria-label="Close settings" title="Close (Esc)">✕</button></header>
      <div class="set-body"><nav class="set-nav" aria-label="Settings sections">${SECTIONS.map(([k, l, i]) =>
        `<button type="button" data-sec="${k}"><span aria-hidden="true">${i}</span>${l}</button>`).join("")}</nav>
        <div class="set-pane" tabindex="-1"></div></div>
      <footer class="set-foot"><span>Saved to <code>${e(data.file)}</code> as you change things.</span>
        <button type="button" class="btn sm" data-a="close">Done</button></footer></div>`;
    document.body.appendChild(root);
    modal = { root, section };
    root.addEventListener("pointerdown", ev => { if (ev.target === root) close(); });
    root.addEventListener("keydown", ev => {
      if (ev.key === "Escape") { ev.stopPropagation(); close(); }
      if (ev.key === "Tab") trapFocus(ev);
    });
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    render();
    root.querySelector(`[data-sec="${modal.section}"]`)?.focus();
  }
  function close() { modal?.root.remove(); modal = null; }
  function trapFocus(ev) {
    const f = [...modal.root.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.offsetParent);
    if (!f.length) return;
    if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f.at(-1).focus(); }
    else if (!ev.shiftKey && document.activeElement === f.at(-1)) { ev.preventDefault(); f[0].focus(); }
  }

  const row = (title, hint, control) => `<div class="set-row"><div><b>${title}</b>${hint ? `<small>${hint}</small>` : ""}</div><div class="set-ctl">${control}</div></div>`;
  const toggle = (key, on) => `<label class="switch"><input type="checkbox" data-k="${key}"${on ? " checked" : ""}><span></span></label>`;
  const select = (key, cur, opts) => `<select data-k="${key}">${opts.map(([v, l]) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${e(l)}</option>`).join("")}</select>`;

  function render() {
    const s = data.settings, pane = modal.root.querySelector(".set-pane");
    modal.root.querySelectorAll("[data-sec]").forEach(b => b.classList.toggle("active", b.dataset.sec === modal.section));
    const sec = modal.section;
    if (sec === "appearance") {
      const a = s.appearance;
      pane.innerHTML = `<h3>Color theme</h3>
        <div class="set-themes" role="radiogroup" aria-label="Color theme">${THEMES.map(([k, l, d]) => {
          const [bg, panel, line, text] = SWATCH[k] || SWATCH.dark;
          const [bg2, panel2] = SWATCH.light;
          const preview = k === "system"
            ? `<i style="background:linear-gradient(135deg, ${bg} 50%, ${bg2} 50%)"><em style="background:${panel};border-color:${line}"></em><em class="r" style="background:${panel2};border-color:${SWATCH.light[2]}"></em></i>`
            : `<i style="background:${bg}"><em style="background:${panel};border-color:${line}"></em><u style="background:${text}"></u><s style="background:var(--accent)"></s></i>`;
          return `<button type="button" role="radio" aria-checked="${a.theme === k}" class="set-theme${a.theme === k ? " active" : ""}" data-theme-pick="${k}" title="${e(d)}">${preview}<span>${l}</span></button>`;
        }).join("")}</div>
        <h3>Accent color</h3>
        <div class="set-accents" role="radiogroup" aria-label="Accent color">${Object.entries(ACCENTS).map(([k, c]) =>
          `<button type="button" role="radio" aria-checked="${a.accent === k}" class="set-accent${a.accent === k ? " active" : ""}" data-accent-pick="${k}" style="--c:${c}" title="${k[0].toUpperCase() + k.slice(1)}"><span class="sr">${k}</span></button>`).join("")}</div>
        <h3>Text and motion</h3>
        ${row("Text size", "Body text across the studio", `<div class="seg sm">${[["small", "Small"], ["normal", "Normal"], ["large", "Large"]].map(([v, l]) =>
          `<button type="button" data-font="${v}" class="${a.font_size === v ? "active" : ""}">${l}</button>`).join("")}</div>`)}
        ${row("Reduce motion", "Turn off animations and transitions", toggle("appearance.reduce_motion", a.reduce_motion))}`;
    } else if (sec === "projects") {
      const p = s.projects;
      const mins = [[0.25, "Every 15 seconds"], [0.5, "Every 30 seconds"], [1, "Every minute"], [2, "Every 2 minutes"], [5, "Every 5 minutes"],
        [10, "Every 10 minutes"], [30, "Every 30 minutes"], [60, "Every hour"]];
      if (!mins.some(m => m[0] === p.version_minutes)) mins.push([p.version_minutes, `Every ${p.version_minutes} minutes`]);
      pane.innerHTML = `<h3>Versions</h3>
        <p class="hint">Each project keeps earlier versions of itself as you work, so you can go back. Named versions (Save a version) are kept until you delete them.</p>
        ${row("Versions to keep", "Automatic versions per project; the oldest go first", `<input type="number" min="5" max="500" step="1" data-k="projects.versions_keep" value="${p.versions_keep}">`)}
        ${row("Keep a version", "At most this often while a project changes", select("projects.version_minutes", p.version_minutes, mins))}
        ${row("A version when the app starts", "Of every project, so the state before a session can always come back", toggle("projects.version_on_start", p.version_on_start))}
        <h3>Opening</h3>
        ${row("Reopen the last project", "Off: the studio starts in Experiment", toggle("projects.reopen_last", p.reopen_last))}
        <p class="set-links">${typeof historyDialog === "function" ? `<button type="button" class="link" data-a="versions">Versions of the open project…</button>` : ""}</p>`;
    } else if (sec === "generation") {
      const g = s.generation;
      const perm = "Notification" in window ? Notification.permission : "unsupported";
      pane.innerHTML = `<h3>When a job finishes</h3>
        ${row("Play a sound", "A short chime when a picture, video or sound is ready", toggle("generation.sound_when_done", g.sound_when_done) + ` <button type="button" class="btn sm" data-a="chime">Try it</button>`)}
        ${row("Desktop notification", perm === "denied" ? "Blocked by the browser: allow notifications for this site first" : perm === "unsupported" ? "This browser can't show notifications" : "When the studio's tab is in the background",
          toggle("generation.notify_when_done", g.notify_when_done && perm === "granted"))}
        <h3>Results</h3>
        ${row("Ask before deleting a result", "Deleting removes its file from disk", toggle("generation.confirm_delete", g.confirm_delete))}`;
    } else if (sec === "editor") {
      const caps = state?.caps?.editor || {};
      pane.innerHTML = `<h3>AI edits</h3>
        ${row("Edit model", "For Erase, Replace with… and Edit the whole picture. The editor's own picker changes this too.",
          `<select data-k="editor.edit_model">${[["qwen", "Qwen Image Edit 2511 · fast"], ["h3image", "MiniMax H3 Image"]].map(([v, l]) =>
            `<option value="${v}"${s.editor.edit_model === v ? " selected" : ""}${state?.caps && !caps[v] ? " disabled" : ""}>${l}${state?.caps && !caps[v] ? " (not installed)" : ""}</option>`).join("")}</select>`)}`;
    } else if (sec === "updates") {
      const u = s.updates || { mode: "auto", check_minutes: 5 }, st = modal.update;
      const mins = [[1, "Every minute"], [5, "Every 5 minutes"], [15, "Every 15 minutes"], [60, "Every hour"], [360, "Every 6 hours"], [1440, "Once a day"]];
      if (!mins.some(m => m[0] === u.check_minutes)) mins.push([u.check_minutes, `Every ${u.check_minutes} minutes`]);
      const when = st?.checked ? new Date(st.checked * 1000).toLocaleTimeString() : "";
      const line = !st ? "Checking…"
        : st.error ? `⚠ ${e(st.error)}`
        : st.restarting ? "Installed. Restarting…"
        : st.behind ? `${st.behind} new change${st.behind === 1 ? "" : "s"} on GitHub${st.blocked ? `: ${e(st.blocked)}` : u.mode === "auto" ? ": installing when nothing is rendering" : ""}`
        : `✓ Up to date (v${e(st.version)})${when ? ` · checked ${e(when)}` : ""}`;
      pane.innerHTML = `<h3>Updates</h3>
        <p class="hint">The studio checks GitHub (<code>${e(st?.repo || "Bobs-Dev-Attic/comfyui.bob")}</code>, branch main) for a newer version.
          Automatic installs it while nothing is rendering, then the studio restarts itself and the page offers a reload. It never overwrites edits of your own.</p>
        ${row("When there's a new version", "", select("updates.mode", u.mode, [["auto", "Install it automatically"], ["notify", "Tell me; I'll install it"], ["off", "Don't check"]]))}
        ${row("Check", "", select("updates.check_minutes", u.check_minutes, mins))}
        <div class="set-update${st?.error || st?.blocked ? " bad" : ""}" aria-live="polite"><p>${line}</p>
          ${st?.commits?.length ? `<ul>${st.commits.map(c => `<li>${e(c)}</li>`).join("")}</ul>` : ""}</div>
        <div class="set-actions"><button type="button" class="btn sm" data-a="update-check">Check now</button>
          ${st?.behind && !st.blocked && !st.error && !st.restarting ? `<button type="button" class="btn sm primary" data-a="update-apply">Update and restart</button>` : ""}</div>`;
      if (!st) updateCheck(false);
    } else if (sec === "advanced") {
      pane.innerHTML = `<h3>Settings file</h3>
        <p class="hint">All of these settings live in <code>${e(data.file)}</code> in the studio's folder. Edit the JSON here, or export it to copy your setup to another PC.</p>
        <textarea class="set-json" spellcheck="false" aria-label="Settings as JSON">${e(JSON.stringify(s, null, 2))}</textarea>
        <div class="set-actions"><button type="button" class="btn sm primary" data-a="json-apply">Apply JSON</button>
          <button type="button" class="btn sm" data-a="export">⬇ Export…</button><button type="button" class="btn sm" data-a="import">⬆ Import…</button>
          <span class="wm-foot-gap"></span><button type="button" class="btn sm danger" data-a="reset">Reset everything</button></div>
        <input type="file" accept="application/json,.json" data-a="import-file" hidden>`;
    } else if (sec === "about") {
      const v = document.querySelector("#app-version")?.textContent.replace(/^·\s*/, "") || "";
      pane.innerHTML = `<div class="set-about"><span class="logo"></span><div><h3>Bob Studio ${e(v)}</h3>
        <p>A small creative studio on top of a local ComfyUI: MiniMax H3 video and sound, H3 Image, FLUX 3 Klein and Krea 2 pictures, Music 3 songs, a timeline and an image editor.</p>
        <p class="hint">${e(document.querySelector("#st-comfy")?.textContent || "")} · ${e(document.querySelector("#st-gpu")?.textContent || "")}</p>
        <p><a href="https://github.com/Bobs-Dev-Attic/comfyui.bob" target="_blank" rel="noopener">Source on GitHub</a> ·
          <a href="https://github.com/Bobs-Dev-Attic/comfyui.bob/blob/main/CHANGELOG.md" target="_blank" rel="noopener">What's new</a></p></div></div>`;
    }
    pane.scrollTop = 0;
  }

  function onClick(ev) {
    const t = ev.target;
    const sec = t.closest("[data-sec]")?.dataset.sec;
    if (sec) { modal.section = sec; render(); return; }
    const th = t.closest("[data-theme-pick]")?.dataset.themePick;
    if (th) { set({ appearance: { theme: th } }); render(); return; }
    const ac = t.closest("[data-accent-pick]")?.dataset.accentPick;
    if (ac) { set({ appearance: { accent: ac } }); render(); return; }
    const fs = t.closest("[data-font]")?.dataset.font;
    if (fs) { set({ appearance: { font_size: fs } }); render(); return; }
    const a = t.closest("[data-a]")?.dataset.a;
    if (!a) return;
    ({
      close,
      chime,
      versions: () => { close(); historyDialog(state.project?.id || "experiment"); },
      "update-check": () => updateCheck(true),
      "update-apply": async () => {
        status("Updating…");
        try {
          const r = await fetch("/api/update/apply", { method: "POST" });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.detail || r.statusText);
          modal.update = j; status("Restarting…"); render();
        } catch (err) { status(err.message, true); updateCheck(false); }
      },
      "json-apply": async () => {
        let obj;
        try { obj = JSON.parse(modal.root.querySelector(".set-json").value); } catch (err) { return status(`Not valid JSON: ${err.message}`, true); }
        await replaceAll(obj);
      },
      export: () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data.settings, null, 2)], { type: "application/json" }));
        Object.assign(document.createElement("a"), { href: url, download: "bob-studio-settings.json" }).click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      },
      import: () => modal.root.querySelector('[data-a="import-file"]').click(),
      reset: async () => {
        if (!await WM.ask({ title: "Reset every setting?", message: "Theme, project versions, notifications and the editor go back to their defaults. Your projects aren't touched.", ok: "Reset" })) return;
        await post("/api/settings/reset", {});
      },
    })[a]?.();
  }

  async function onChange(ev) {
    const t = ev.target;
    if (t.dataset.a === "import-file" && t.files[0]) {
      try { await replaceAll(JSON.parse(await t.files[0].text())); } catch (err) { status(`Can't import: ${err.message}`, true); }
      t.value = ""; return;
    }
    const key = t.dataset.k;
    if (!key) return;
    const [sec, name] = key.split(".");
    let v = t.type === "checkbox" ? t.checked : t.type === "number" ? +t.value : t.value;
    if (key === "projects.version_minutes" || key === "updates.check_minutes") v = +v;
    if (key === "projects.versions_keep") { v = Math.max(5, Math.min(500, Math.round(v || 30))); t.value = v; }
    if (key === "generation.notify_when_done" && v && "Notification" in window && Notification.permission !== "granted") {
      v = (await Notification.requestPermission()) === "granted";
      t.checked = v;
      if (!v) { render(); return status("Notifications are blocked for this site", true); }
    }
    set({ [sec]: { [name]: v } });
  }

  // Settings › Updates: what the studio last found (fresh = fetch from GitHub now).
  async function updateCheck(fresh) {
    try {
      const r = await fetch(fresh ? "/api/update/check" : "/api/update", { method: fresh ? "POST" : "GET" });
      const j = await r.json();
      if (modal) { modal.update = j; if (modal.section === "updates") render(); }
    } catch (err) { status(`Can't check: ${err.message}`, true); }
  }

  async function post(path, body) {
    status("Saving…");
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      data = j; applyLook(data.settings.appearance); render(); status("Saved");
      window.dispatchEvent(new CustomEvent("bob:settings", { detail: data.settings }));
    } catch (err) { status(`Not saved: ${err.message}`, true); }
  }
  const replaceAll = obj => post("/api/settings/import", obj);

  /* ---------------------------------------------------------------- job finished */
  let audioCtx = null;
  function chime() {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      [[880, 0], [1318.5, 0.12]].forEach(([f, d]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
        o.connect(g).connect(audioCtx.destination); o.start(t + d); o.stop(t + d + 0.55);
      });
    } catch { /* no audio */ }
  }
  // Called by the live event stream when a job changes state.
  function jobFinished(item) {
    if (!data) return;
    const ok = item.status === "done";
    if (get("generation.sound_when_done")) chime();
    if (get("generation.notify_when_done") && document.hidden && "Notification" in window && Notification.permission === "granted") {
      const what = { image: "Picture", video: "Video", audio: "Sound" }[item.kind] || "Result";
      try { new Notification(ok ? `${what} ready` : `${what} failed`, { body: (item.params?.prompt || item.error || "").slice(0, 120), tag: item.id, silent: true }); } catch { /* ignore */ }
    }
  }

  addEventListener("keydown", ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === ",") { ev.preventDefault(); open(); }
  });

  return { load, get, set, open, close, applyLook, jobFinished, chime, isOpen: () => !!modal };
})();
