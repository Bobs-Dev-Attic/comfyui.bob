/* Enhance: improve a finished picture or video with FaceRefine, DLSS 5 and an upscaler
   (SeedVR2 or RelayVSR x2), in that order (app/workflows.py build_enhance). The window opens
   from a result's ✨ Enhance… (viewer or results menu); Settings › After generating can run
   the same chain on every new result. The last choices are remembered (localStorage). */
"use strict";

const Enhance = (() => {
  const KEY = "bob.enhance";
  const DEF = { facerefine: false, face_strength: 0.4, face_steps: 20, dlss: true, dlss_mode: "1x", dlss_style: "Default", dlss_intensity: 1,
    upscaler: "seedvr2", seedvr2_model: "", seedvr2_res: 1080, relay_detail: 0.45 };
  let caps = null;
  const load = () => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) || "{}") || {}) }; } catch { return { ...DEF }; } };
  const store = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} };
  async function getCaps() {
    if (!caps) { try { caps = await api("/api/enhance/caps"); } catch { caps = {}; } }
    return caps;
  }
  const label = { facerefine: "FaceRefine", dlss: "DLSS 5", seedvr2: "SeedVR2", relayvsr: "RelayVSR ×2" };
  function summary(o, kind) {
    const s = [];
    if (o.facerefine && kind === "video") s.push("FaceRefine");
    if (o.dlss) s.push(`DLSS 5 ${o.dlss_mode}`);
    if (o.upscaler === "seedvr2") s.push(`SeedVR2 → ${o.seedvr2_res}p`);
    if (o.upscaler === "relayvsr" && kind === "video") s.push("RelayVSR ×2");
    return s.join(" → ") || "nothing";
  }
  const DLSS_K = { "1x": 1, "1.5x": 1.5, "1.724x": 1.724, "2x": 2, "3x": 3 };

  /* ---- Time estimates, in seconds.
     Each step's cost per frame and megapixel was measured on this studio's own runs (FaceRefine
     ~0.73 s a frame at 20 steps, DLSS 5 ~0.2 s and RelayVSR ~0.24 s per output megapixel-frame,
     SeedVR2 3B ~5 s per megapixel on a picture), plus the model loads. The sum is then scaled by
     how long recent enhance runs here really took against the same sum: runs of the same chain
     first, any enhance run otherwise, so the numbers settle to this machine. */
  const MPX = (w, h) => w * h / 1e6;
  function rawEstimate(o, src) {
    if (!o || !src?.width || !src?.height) return null;
    const video = src.kind === "video", n = video ? Math.max(1, src.frames || 121) : 1;
    let t = 4, W = src.width, H = src.height;
    if (o.facerefine && video) t += 20 + n * (0.33 + 0.02 * (o.face_steps || 20));
    if (o.dlss) { const k = DLSS_K[o.dlss_mode] || 1; W *= k; H *= k; t += 3 + 0.2 * MPX(W, H) * n; }
    if (o.upscaler === "seedvr2") {
      const s = (o.seedvr2_res || 1080) / Math.min(W, H), big = /7b/i.test(o.seedvr2_model || "");
      W *= s; H *= s;
      t += 12 + MPX(W, H) * n * (video ? (big ? 2.5 : 0.9) : (big ? 12 : 5));
    }
    if (o.upscaler === "relayvsr" && video) { W *= 2; H *= 2; t += 5 + 0.24 * MPX(W, H) * n; }
    return t;
  }
  const chainOf = (o, kind) => [kind, o.facerefine && kind === "video" && "face", o.dlss && "dlss", o.upscaler !== "none" && o.upscaler].filter(Boolean).join("+");
  // What an enhance result was made from (its info carries the source size since 0.20).
  const sourceOf = x => ({ kind: x.kind, width: x.info?.src_width, height: x.info?.src_height, frames: x.info?.frames });
  function factor(o, kind) {
    const runs = [...(state.items?.values?.() || [])]
      .filter(x => x.engine === "enhance" && x.status === "done" && x.started && x.finished && x.info?.src_width && x.params?.enhance_opts)
      .sort((a, b) => b.finished - a.finished);
    const median = list => {
      const v = list.slice(0, 8).map(x => (x.finished - x.started) / rawEstimate(x.params.enhance_opts, sourceOf(x))).filter(r => r > 0 && isFinite(r)).sort((a, b) => a - b);
      return v.length ? v[v.length >> 1] : null;
    };
    const f = median(runs.filter(x => chainOf(x.params.enhance_opts, x.kind) === chainOf(o, kind))) ?? median(runs) ?? 1;
    return Math.min(3, Math.max(0.33, f));
  }
  // Seconds an enhance run takes on the GPU. src: {kind, width, height, frames}.
  function estimate(o, src) {
    const r = rawEstimate(o, src);
    return r == null ? null : r * factor(o, src.kind);
  }
  // The chain a finished generation gets from Settings › After generating (only what fits it).
  function afterOpts(it) {
    if (!it?.params?.enhance_after || it.engine === "enhance" || !["video", "image"].includes(it.kind)) return null;
    const o = { ...it.params.enhance_after };
    if (it.kind !== "video") { o.facerefine = false; if (o.upscaler === "relayvsr") o.upscaler = "none"; }
    if (o.facerefine && !["h3", "h3ref"].includes(it.params.engine)) o.facerefine = false;
    return summary(o, it.kind) === "nothing" ? null : o;
  }
  // For the activity console: how long a running enhance takes in all (stages restart the
  // progress bar, so its rate alone can't tell), and what a generation's auto-enhance adds.
  function expected(it) {
    return it?.engine === "enhance" ? estimate(it.params?.enhance_opts, sourceOf(it)) : null;
  }
  function afterTime(it) {
    const o = afterOpts(it);
    return o ? estimate(o, { kind: it.kind, width: it.info?.width, height: it.info?.height, frames: it.info?.frames }) : null;
  }
  const fmtTime = s => s == null ? "" : s < 90 ? `~${Math.max(5, Math.round(s / 5) * 5)} s` : s < 5400 ? `~${Math.round(s / 60)} min` : `~${(s / 3600).toFixed(1)} h`;

  function outSize(o, w, h, kind) {
    if (!w || !h) return "";
    let k = 1;
    if (o.dlss) k *= DLSS_K[o.dlss_mode] || 1;
    let W = w * k, H = h * k;
    if (o.upscaler === "seedvr2") { const s = o.seedvr2_res / Math.min(W, H); W *= s; H *= s; }
    if (o.upscaler === "relayvsr" && kind === "video") { W *= 2; H *= 2; }
    return `${w}×${h} → ${Math.round(W / 2) * 2}×${Math.round(H / 2) * 2}`;
  }

  /* The window. it = a studio result, or null for the Settings › After generating choices. */
  async function dialog(it = null) {
    const c = await getCaps();
    const o = load(), kind = it?.kind || "video";
    const h3 = it ? ["h3", "h3ref"].includes(it.params?.engine) : true;
    const isVideo = kind === "video";
    if (!o.seedvr2_model || !(c.seedvr2_models || []).includes(o.seedvr2_model))
      o.seedvr2_model = (c.seedvr2_models || []).find(m => /3b_fp8/.test(m)) || (c.seedvr2_models || [])[0] || "";
    const dis = (cond, why) => cond ? "" : ` disabled title="${esc(why)}"`;
    const form = document.createElement("div");
    form.className = "enh";
    form.innerHTML = `
      <p class="hint">${it ? `${esc(it.kind === "video" ? "Video" : "Picture")}: ${esc((it.params?.prompt || it.files?.[0]?.name || "").slice(0, 90))}` : "Runs on every new picture or video when Settings › After generating is on."}
        The steps run in this order; each is optional.</p>
      <div class="enh-step${isVideo && h3 && c.facerefine ? "" : " off"}">
        <label class="check"><input type="checkbox" data-k="facerefine"${o.facerefine && isVideo && h3 ? " checked" : ""}${dis(isVideo && h3 && c.facerefine,
          !c.facerefine ? "ComfyUI-H3-FaceRefine isn't installed" : !isVideo ? "FaceRefine is for videos" : "FaceRefine needs a video made with H3 or H3 Reference")}> 1 · FaceRefine</label>
        <p class="hint">Tracks the main face, re-renders it with H3 Reference at a low denoise using the video's own prompt, references and LoRAs (more where faces are small), and stitches it back. The sound is kept.</p>
        <div class="enh-opts">
          <div class="field"><label>Strength <span data-out="face_strength"></span></label><input type="range" min="0.1" max="0.8" step="0.05" data-k="face_strength" value="${o.face_strength}"></div>
          <div class="field"><label>Steps</label><input type="number" min="4" max="50" data-k="face_steps" value="${o.face_steps}"></div>
        </div>
      </div>
      <div class="enh-step${c.dlss ? "" : " off"}">
        <label class="check"><input type="checkbox" data-k="dlss"${o.dlss ? " checked" : ""}${dis(c.dlss, "ComfyUI-DLSS5-Enhancer isn't installed")}> 2 · DLSS 5</label>
        <p class="hint">NVIDIA neural rendering: sharper detail, tone and skin. 1x only improves the look; 1.5–3x also upscales.</p>
        <div class="enh-opts">
          <div class="field"><label>Mode</label><select data-k="dlss_mode">${[["1x", "1x · look only"], ["1.5x", "1.5x · Quality"], ["1.724x", "1.72x · Balanced"], ["2x", "2x · Performance"], ["3x", "3x · Ultra Performance"]]
            .map(([v, l]) => `<option value="${v}"${o.dlss_mode === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
          <div class="field"><label>Style</label><select data-k="dlss_style">${["Default", "Natural", "Cinematic"].map(v => `<option${o.dlss_style === v ? " selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="field"><label>Intensity <span data-out="dlss_intensity"></span></label><input type="range" min="0" max="2" step="0.05" data-k="dlss_intensity" value="${o.dlss_intensity}"></div>
        </div>
      </div>
      <div class="enh-step">
        <label class="check">3 · Upscale</label>
        <div class="enh-up">
          <label class="check"><input type="radio" name="enh-up" value="none"${o.upscaler === "none" ? " checked" : ""}> None</label>
          <label class="check"><input type="radio" name="enh-up" value="seedvr2"${o.upscaler === "seedvr2" ? " checked" : ""}${dis(c.seedvr2, "SeedVR2 nodes or models aren't installed")}> SeedVR2</label>
          <label class="check"><input type="radio" name="enh-up" value="relayvsr"${o.upscaler === "relayvsr" && isVideo ? " checked" : ""}${dis(c.relayvsr && isVideo, !isVideo ? "RelayVSR is for videos" : "RelayVSR model files aren't installed")}> RelayVSR ×2</label>
        </div>
        <div class="enh-opts" data-up="seedvr2">
          <div class="field"><label>SeedVR2 model</label><select data-k="seedvr2_model">${(c.seedvr2_models || []).map(m => `<option${m === o.seedvr2_model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select></div>
          <div class="field"><label>Short side</label><select data-k="seedvr2_res">${[720, 1080, 1440, 2160].map(v => `<option value="${v}"${+o.seedvr2_res === v ? " selected" : ""}>${v}p</option>`).join("")}</select></div>
        </div>
        <div class="enh-opts" data-up="relayvsr">
          <div class="field"><label>Detail <span data-out="relay_detail"></span></label><input type="range" min="0" max="1" step="0.05" data-k="relay_detail" value="${o.relay_detail}"></div>
        </div>
        <p class="hint">SeedVR2 restores and upscales to a chosen size (3B is faster, 7B finer). RelayVSR doubles video resolution in one fast step.</p>
      </div>
      <p class="enh-sum"></p>`;
    const read = () => {
      const v = { ...o };
      form.querySelectorAll("[data-k]").forEach(el => { v[el.dataset.k] = el.type === "checkbox" ? el.checked : el.type === "range" || el.type === "number" ? +el.value : el.value; });
      v.seedvr2_res = +v.seedvr2_res;
      v.upscaler = form.querySelector('input[name="enh-up"]:checked')?.value || "none";
      if (!isVideo) { v.facerefine = false; if (v.upscaler === "relayvsr") v.upscaler = "none"; }
      return v;
    };
    const show = () => {
      const v = read();
      form.querySelectorAll("[data-out]").forEach(s => { s.textContent = (+v[s.dataset.out]).toFixed(2); });
      form.querySelectorAll("[data-up]").forEach(d => { d.hidden = d.dataset.up !== v.upscaler; });
      const f = it?.files?.[0], info = it?.info || {};
      const size = outSize(v, info.width, info.height, kind);
      const secs = summary(v, kind) === "nothing" ? null : estimate(v, it ? { kind, width: info.width, height: info.height, frames: info.frames } : formSource());
      form.querySelector(".enh-sum").innerHTML = `Runs: <b>${esc(summary(v, kind))}</b>${size ? ` · ${size}` : ""}`
        + (secs != null ? ` · takes <b>${fmtTime(secs)}</b>${it ? "" : " for each result at the current settings"}` : "");
      foot.querySelector('[data-a="go"]').disabled = summary(v, kind) === "nothing";
    };
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button>
      <button type="button" class="btn sm primary" data-a="go">${it ? "✨ Enhance" : "Save"}</button>`;
    const w = WM.open({ id: "enhance", title: it ? "Enhance" : "Enhance after generating", content: form, footer: foot, width: 620, height: 640, minWidth: 340, minHeight: 300 });
    form.addEventListener("input", show); form.addEventListener("change", show); show();
    foot.querySelector('[data-a="cancel"]').onclick = () => w.close();
    foot.querySelector('[data-a="go"]').onclick = async () => {
      const v = read();
      store({ ...load(), ...v, ...(isVideo ? {} : { facerefine: o.facerefine, upscaler: v.upscaler === "none" && o.upscaler === "relayvsr" ? "relayvsr" : v.upscaler }) });
      w.close();
      if (!it) { renderAfter(); return; }
      await run(it, v);
    };
  }
  async function run(it, opts) {
    try {
      const { items } = await api("/api/enhance", { method: "POST", body: JSON.stringify({ item: it.id, options: opts }) });
      for (const x of items) { state.items.set(x.id, x); Activity.onEvent({ type: "item", item: x }); }
      renderGallery(); renderQueue();
      Activity.show(items[0].id);
      Media.toast(`Enhancing (${summary(opts, it.kind)})… the result appears in the gallery.`);
    } catch (e) { Media.toast(`Enhance failed: ${e.message}`); }
  }

  /* ---- Settings › After generating */
  function after() {
    const sel = document.getElementById("enhance-after");
    return sel?.value === "on" ? load() : null;
  }
  // The size and length the Settings step would make now, for the After generating estimate.
  function formSource() {
    const m = /(\d+)\s*×\s*(\d+)/.exec(document.getElementById("dims")?.textContent || "");
    const f = /(\d+) frames/.exec(document.getElementById("seconds-val")?.textContent || "");
    const sec = +(document.getElementById("seconds")?.value || 5);
    return m ? { kind: state.kind, width: +m[1], height: +m[2], frames: f ? +f[1] : Math.round(sec * 24) + 1 } : null;
  }
  function renderAfter() {
    const h = document.getElementById("enhance-after-hint");
    if (!h) return;
    const on = document.getElementById("enhance-after").value === "on";
    if (!on) { h.textContent = "Results stay as they come out. Use ✨ Enhance… on any result later."; return; }
    const o = afterOpts({ kind: state.kind, engine: state.engine?.[state.kind], params: { engine: state.engine?.[state.kind], enhance_after: load() } });
    const secs = o && formSource() ? estimate(o, formSource()) : null;
    h.textContent = `Each new result then runs: ${o ? summary(o, state.kind) : "nothing (no step fits this kind)"}`
      + (secs != null ? `, adding ${fmtTime(secs)} per result at these settings` : "") + ". Results made by Enhance aren't enhanced again.";
  }
  function initSettings() {
    const sel = document.getElementById("enhance-after");
    try { sel.value = localStorage.getItem(KEY + ".after") || ""; } catch {}
    sel.addEventListener("change", () => { try { localStorage.setItem(KEY + ".after", sel.value); } catch {} renderAfter(); });
    document.getElementById("btn-enhance-after").onclick = () => dialog(null);
    renderAfter();
  }
  // A generation that asked to be enhanced afterwards (its params carry the chain) has finished.
  const doneKey = KEY + ".done";
  async function onItem(it) {
    if (it.status !== "done" || !it.params?.enhance_after || it.engine === "enhance") return;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(doneKey) || "[]"); } catch {}
    if (done.includes(it.id)) return;
    done = [...done, it.id].slice(-200);
    try { localStorage.setItem(doneKey, JSON.stringify(done)); } catch {}
    const o = afterOpts(it);
    if (o) await run(it, o);
  }
  return { dialog, after, initSettings, onItem, estimate, expected, afterTime, fmtTime, renderAfter };
})();
