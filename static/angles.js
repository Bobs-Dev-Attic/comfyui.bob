/* Angles: re-shoot one picture from many camera angles with Qwen Image Edit 2511 and fal's
   multiple-angles LoRA (app/workflows.py build_angles). Opens from a picture's 🔄 Angles… (viewer,
   results menu, media library). Pick poses on an 8 directions × 4 heights grid (or a preset, e.g.
   24 head angles), add what the background and light should be, optionally make a plain backdrop
   pure white (done by the server, app/imaging.py) and enhance each result
   with SeedVR2 (the Enhance chain, run as each picture finishes), and put them in this project or
   a new one. The last choices are remembered (localStorage). */
"use strict";

const Angles = (() => {
  const KEY = "bob.angles";
  const AZ = [["front view", "Front"], ["front-right quarter view", "Front-right ¾"], ["right side view", "Right"],
    ["back-right quarter view", "Back-right ¾"], ["back view", "Back"], ["back-left quarter view", "Back-left ¾"],
    ["left side view", "Left"], ["front-left quarter view", "Front-left ¾"]];
  const EL = [["low-angle shot", "Low (−30°)"], ["eye-level shot", "Eye level"], ["elevated shot", "Elevated (30°)"], ["high-angle shot", "High (60°)"]];
  const DIST = [["close-up", "Close-up"], ["medium shot", "Medium"], ["wide shot", "Wide"]];
  const PRESETS = {
    head24: { label: "24 head angles", el: [0, 1, 2], dist: "close-up" },
    around8: { label: "8 around, eye level", el: [1], dist: null },
    all32: { label: "All 32", el: [0, 1, 2, 3], dist: null },
  };
  const DEF_PROMPT = "Plain pure white studio background, even soft lighting, same person, same face, hair and clothing.";
  const DEF = { cells: PRESETS.head24.el.flatMap(e => AZ.map((_, a) => `${e}:${a}`)), dist: "close-up", prompt: DEF_PROMPT,
    white: true, enhance: true, res: 1080, where: "new" };
  const load = () => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) || "{}") || {}) }; } catch { return { ...DEF }; } };
  const store = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} };
  const fmt = s => s < 90 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`;

  /* src = {ref, url, name}: the reference picture (a media ref and the URL to show it). */
  function dialog(src) {
    const o = load();
    const cur = state.project;
    const base = (src.name || src.ref.split("/").pop()).replace(/\.[a-z0-9]+$/i, "");
    const form = document.createElement("div");
    form.className = "ang";
    form.innerHTML = `
      <div class="ang-top">
        <img class="ang-ref" src="${esc(src.url)}" alt="Reference">
        <div class="ang-intro">
          <p class="hint">Qwen Image Edit 2511 re-shoots <b>${esc(base)}</b> from each chosen angle, keeping the person, hair and clothes. Same seed for all, about 10 s each once the model is loaded (the first one loads it, a few minutes).</p>
          <div class="ang-presets">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="btn sm" data-preset="${k}">${esc(p.label)}</button>`).join("")}
            <button type="button" class="btn sm" data-preset="none">Clear</button></div>
        </div>
      </div>
      <div class="ang-grid" role="group" aria-label="Camera angles">
        <span></span>${AZ.map(([, l]) => `<span class="ang-h">${esc(l)}</span>`).join("")}
        ${EL.map(([, el], e) => `<span class="ang-v">${esc(el)}</span>${AZ.map(([, az], a) => `<label class="ang-cell" title="${esc(`${az}, ${el}`)}"><input type="checkbox" data-cell="${e}:${a}"${o.cells.includes(`${e}:${a}`) ? " checked" : ""}></label>`).join("")}`).join("")}
      </div>
      <div class="ang-row">
        <div class="field"><label for="ang-dist">Distance</label><select id="ang-dist">${DIST.map(([v, l]) => `<option value="${v}"${o.dist === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field grow"><label for="ang-prompt">Also ask for</label><textarea id="ang-prompt" rows="2">${esc(o.prompt)}</textarea></div>
      </div>
      <div class="ang-row">
        <label class="check" title="Floods the plain backdrop from the picture's edges and makes it pure white (the model alone keeps the reference's backdrop tone)"><input type="checkbox" id="ang-white"${o.white ? " checked" : ""}> Make a plain background pure white</label>
      </div>
      <div class="ang-row">
        <label class="check"><input type="checkbox" id="ang-enh"${o.enhance ? " checked" : ""}> Enhance each with SeedVR2 to</label>
        <select id="ang-res">${[1080, 1440, 2160].map(v => `<option value="${v}"${+o.res === v ? " selected" : ""}>${v}p</option>`).join("")}</select>
      </div>
      <div class="field"><label>Put them in</label>
        <div class="radios">
          <label><input type="radio" name="ang-where" value="new"${o.where === "new" || !cur ? " checked" : ""}> A new project:</label>
          <input type="text" id="ang-pname" maxlength="120" value="${esc(`Angles – ${base}`)}">
          <label><input type="radio" name="ang-where" value="here"${o.where === "here" && cur ? " checked" : ""}> ${cur ? `This project (${esc(cur.name)})` : "Experiment"}</label>
        </div></div>
      <p class="ang-sum"></p><p class="err" id="ang-err"></p>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button>
      <button type="button" class="btn sm primary" data-a="go">🔄 Make angles</button>`;
    const w = WM.open({ id: "angles", title: "Angles", content: form, footer: foot, width: 760, height: 720, minWidth: 420, minHeight: 420 });
    const $f = s => form.querySelector(s);
    const cells = () => [...form.querySelectorAll("[data-cell]:checked")].map(c => c.dataset.cell);
    const poses = () => cells().map(c => { const [e, a] = c.split(":").map(Number); return `${AZ[a][0]} ${EL[e][0]} ${$f("#ang-dist").value}`; });
    const read = () => ({ cells: cells(), dist: $f("#ang-dist").value, prompt: $f("#ang-prompt").value, white: $f("#ang-white").checked, enhance: $f("#ang-enh").checked,
      res: +$f("#ang-res").value, where: form.querySelector('input[name="ang-where"]:checked').value });
    const enhOpts = v => v.enhance ? { facerefine: false, dlss: false, upscaler: "seedvr2", seedvr2_model: "", seedvr2_res: v.res } : null;
    const show = () => {
      const v = read(), n = v.cells.length;
      let secs = n * 10;
      const e = enhOpts(v), each = e && typeof Enhance !== "undefined" ? Enhance.estimate(e, { kind: "image", width: 1024, height: 1024 }) : null;
      if (each) secs += n * each;
      $f(".ang-sum").innerHTML = n ? `<b>${n}</b> angle${n > 1 ? "s" : ""}${e ? `, each enhanced to ${v.res}p` : ""} · about <b>${fmt(secs)}</b>${n ? " plus the first model load" : ""}` : "Pick at least one angle.";
      foot.querySelector('[data-a="go"]').disabled = !n;
      $f("#ang-pname").disabled = v.where !== "new";
    };
    form.addEventListener("input", show); form.addEventListener("change", show);
    form.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => {
      const p = PRESETS[b.dataset.preset];
      form.querySelectorAll("[data-cell]").forEach(c => { c.checked = !!p && p.el.includes(+c.dataset.cell.split(":")[0]); });
      if (p?.dist) $f("#ang-dist").value = p.dist;
      show();
    });
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="go"]').onclick = async () => {
      const v = read(), btn = foot.querySelector('[data-a="go"]');
      btn.disabled = true;
      try {
        let project = cur?.id || null;
        if (v.where === "new") {
          const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ folder: readUI().newProjectFolder ?? "", name: $f("#ang-pname").value,
            settings: { kind: "image" }, notes: `Angles of ${src.ref}: ${v.cells.length} poses, ${v.dist}.${v.enhance ? ` Enhanced with SeedVR2 to ${v.res}p.` : ""}` }) });
          project = p.id;
          await api(`/api/projects/${p.id}/library/add`, { method: "POST", body: JSON.stringify({ refs: [src.ref], tags: ["reference"] }) }).catch(() => {});
          await openProject(p.id);
        }
        const { items } = await api("/api/angles", { method: "POST", body: JSON.stringify({ ref: src.ref, poses: poses(), prompt: v.prompt, project, white_bg: v.white, enhance_after: enhOpts(v) }) });
        store(v);
        w.close();
        for (const x of items) { state.items.set(x.id, x); Activity.onEvent({ type: "item", item: x }); }
        renderGallery(); renderQueue();
        Media.toast(`Making ${items.length} angle${items.length > 1 ? "s" : ""}${v.enhance ? ", each enhanced with SeedVR2 as it finishes" : ""}.`);
      } catch (e) { $f("#ang-err").textContent = e.message; btn.disabled = false; }
    };
    show();
  }
  return { dialog };
})();
