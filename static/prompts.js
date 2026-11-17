/* Prompt step superpowers: prompt tags, tag presets, a catalog of saved prompts, and a live
   model view that reformats the prompt for the selected model as you type.

   Two layers run as you type:
   - Instantly, in the browser (every keystroke): the template is resolved ({a|b}, <tag>, {{tag}},
     <preset/>, <maybe>, <list>) and tidied for the model (weights and filler words out for FLUX and
     Krea, [English] in H3 dialogue, …), with notes on what the model handles badly. What Generate
     sends is exactly this text.
   - After a short pause: a local LLM rewrites the prompt in the model's own format and the text streams
     in as a suggestion. Tab accepts it, Esc dismisses it. Template parts are swapped for a value they
     can give and put back after, so the rewrite keeps them. The LLM is loaded while you type and unloaded when a render starts. */
const Prompts = (() => {
  const LIVE_KEY = "bob.prompt.live", TIDY_KEY = "bob.prompt.tidy";
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch {} };
  const S = {
    entries: [], presets: {}, nodeLib: false, loaded: false,
    live: ls(LIVE_KEY, true), tidy: ls(TIDY_KEY, true),
    previewSeed: Math.floor(Math.random() * 1e9),
    timer: 0, ctrl: null, sug: null,  // sug: {for, text, done, error, markers, missing}
    lastAsked: "", warmAt: 0, paused: false, entryId: null,
  };
  const ta = () => $("#prompt");

  /* ------------------------------------------------------------ the model being written for */
  const PROFILE = {
    "video:h3": "h3video", "video:h3ref": "h3ref", "image:h3": "h3still", "image:klein": "flux",
    "image:krea2": "krea", "image:h3image": "h3image", "audio:h3": "h3sound", "audio:music3": "music",
  };
  const modelKey = () => `${state.kind}:${state.engine[state.kind]}`;
  const profile = () => PROFILE[modelKey()] || null;
  const modelLabel = key => {
    const [k, e] = String(key || "").split(":");
    return e ? engineName(k, e) : key || "Any model";
  };

  /* ------------------------------------------------------------ template engine */
  const slug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  function rng(seed) {  // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function walk(tags, name) {
    let cur = tags;
    for (const k of name.split(".")) {
      if (cur && typeof cur === "object" && !Array.isArray(cur) && k in cur) cur = cur[k];
      else if (Array.isArray(cur) && /^\d+$/.test(k) && +k < cur.length) cur = cur[+k];
      else return undefined;
    }
    return cur;
  }
  const attrs = s => Object.fromEntries([...String(s || "").matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));
  const ESC = { "\\{": "\u0001", "\\}": "\u0002", "\\<": "\u0003", "\\>": "\u0004", "\\|": "\u0005" };
  const UNESC = { "\u0001": "{", "\u0002": "}", "\u0003": "<", "\u0004": ">", "\u0005": "|" };
  const SYNTAX = /\{[^{}]*\|[^{}]*\}|\{\{[^{}]+\}\}|<(maybe|list)\b[^>]*>|<[a-z0-9_]+(\s+[^<>]*)?\/>|<!--/i;

  /* Resolve a template: the same text, with every random part rolled from `seed`. Unknown <names>
     (H3's <d>, <Picture 1>, …) are left alone. */
  function resolve(text, { tags = state.promptTags || {}, presets = S.presets, seed = S.previewSeed } = {}) {
    const r = rng(seed), pick = arr => arr[Math.floor(r() * arr.length)];
    const lists = Object.fromEntries(Object.entries(presets).map(([k, v]) => [slug(k), v]));
    const pickN = (arr, n) => { const pool = [...arr], out = []; while (pool.length && out.length < n) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]); return out; };
    const asText = v => typeof v === "string" ? v : Array.isArray(v) ? (v.length ? asText(pick(v)) : "") : JSON.stringify(v);
    const chosen = {};
    let s = String(text || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\\[{}<>|]/g, m => ESC[m]);
    for (let guard = 0; guard < 8; guard++) {
      const before = s;
      // One roll per tag name, so <hero> twice is the same hero (as in the Prompt Explorer node).
      s = s.replace(/\{\{\s*([^{}]+?)\s*\}\}|<([A-Za-z_][\w.]*)>/g, (m, a, b) => {
        const n = (a || b).trim(), v = walk(tags, n);
        if (v === undefined) return m;
        return n in chosen ? chosen[n] : (chosen[n] = asText(v));
      });
      s = s.replace(/<([a-z0-9_]+)((?:\s+\w+="[^"]*")*)\s*\/>/gi, (m, name, at) => {
        const l = lists[name.toLowerCase()]; if (!l?.length) return m;
        const o = attrs(at); return pickN(l, Math.max(1, +o.count || 1)).join(o.sep ?? ", ");
      });
      s = s.replace(/<maybe((?:\s+\w+="[^"]*")*)\s*>([\s\S]*?)<\/maybe>/gi, (m, at, inner) => r() < (+(attrs(at).p ?? 0.5)) ? inner : "");
      s = s.replace(/<list((?:\s+\w+="[^"]*")*)\s*>([\s\S]*?)<\/list>/gi, (m, at, inner) => {
        const o = attrs(at), items = inner.split(",").map(x => x.trim()).filter(Boolean);
        return pickN(items, Math.max(1, +o.count || 1)).join(o.sep ?? ", ");
      });
      s = s.replace(/\{([^{}]*\|[^{}]*)\}/g, (m, body) => {
        const opts = body.split("|").map(o => { const w = o.match(/^\s*(\d+(?:\.\d+)?)::([\s\S]*)$/); return w ? [+w[1], w[2]] : [1, o]; });
        let t = r() * opts.reduce((a, [w]) => a + w, 0);
        for (const [w, o] of opts) { if ((t -= w) < 0) return o.trim(); }
        return opts.at(-1)[1].trim();
      });
      if (s === before) break;
    }
    return s.replace(/[\u0001-\u0005]/g, c => UNESC[c]);
  }
  const hasSyntax = text => SYNTAX.test(text) || Object.keys(state.promptTags || {}).some(k => text.includes(`<${k}>`));

  /* Keep template parts through an LLM rewrite. Each part is swapped for a real value it can give
     (LLMs keep the user's own words, but drop or fill in placeholders); after the rewrite that value
     is found again and turned back into the template part. */
  function protect(text) {
    const markers = [], tags = state.promptTags || {};
    const re = /<(maybe|list)\b[^>]*>[\s\S]*?<\/\1>|\{\{[^{}]+\}\}|\{[^{}]*\|[^{}]*\}|<[a-z0-9_]+(?:\s+\w+="[^"]*")*\s*\/>|<([A-Za-z_][\w.]*)>/gi;
    const out = text.replace(re, (m, _p, name) => {
      if (name && walk(tags, name) === undefined) return m;  // <d>, <Subject 1>… stay as they are
      let value = "";
      for (let k = 0; k < 6 && !value.trim(); k++) value = resolve(/^<maybe/i.test(m) ? m.replace(/^<maybe[^>]*>|<\/maybe>$/gi, "") : m, { seed: 7 + k });
      value = value.trim();
      if (!value || value === m || markers.some(x => x.value.toLowerCase() === value.toLowerCase())) return m;
      markers.push({ token: m, value });
      return value;
    });
    return { text: out, markers };
  }
  function unprotect(text, markers) {
    const missing = [];
    let out = text;
    // Longest values first, so "golden hour light" is matched before "golden".
    markers.map((x, i) => [x, i]).sort(([a], [b]) => b.value.length - a.value.length).forEach(([{ token, value }, i]) => {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\p{L}\\p{N}])`, "iu");
      const m = out.match(re);
      if (m) out = out.slice(0, m.index + m[1].length) + `\u0000${i}\u0000` + out.slice(m.index + m[0].length);
      else missing.push(token);
    });
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => markers[+i].token);
    return { text: out, missing };
  }

  /* ------------------------------------------------------------ instant tidy + notes per model */
  const FILLER = /\b(masterpiece|best quality|high quality|ultra[- ]?detailed|highly detailed|8k|4k|uhd|ultra[- ]?hd|hdr|trending on artstation|award[- ]winning|absurdres)\b/gi;
  const NEG = /\b(no|not|never|without|don't|doesn't|isn't|aren't|nothing|nobody)\b/gi;
  const words = s => (s.trim().match(/\S+/g) || []).length;
  function dropFiller(s) {
    return s.replace(new RegExp(`(^|,)\\s*(?:${FILLER.source})\\s*(?=,|$)`, "gim"), "$1").replace(FILLER, "")
      .replace(/,\s*,+/g, ",").replace(/^\s*,\s*|\s*,\s*$/gm, "").replace(/ {2,}/g, " ");
  }
  function shape(text, prof = profile()) {
    const notes = [];
    let s = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!prof) return { text: s, notes };
    const H3 = prof.startsWith("h3");
    const has = re => { re.lastIndex = 0; const hit = re.test(s); re.lastIndex = 0; return hit; };
    if (prof === "flux" || prof === "krea") {
      const w = /\(\s*([^():]+?)\s*:\s*[\d.]+\s*\)|\(\(+\s*([^()]+?)\s*\)+\)|\[\s*([^\][]+?)\s*\]/g;
      if (w.test(s)) { s = s.replace(w, (m, a, b, c) => a || b || c); notes.push(["Weights like (word:1.2) do nothing here: taken out", "fix"]); }
      if (has(FILLER)) { s = dropFiller(s); notes.push(["Filler such as “masterpiece, 8k” taken out", "fix"]); }
      const commas = (s.match(/,/g) || []).length, sentences = (s.match(/[.!?](\s|$)/g) || []).length;
      if (commas >= 6 && sentences <= 1 && words(s) / (commas + 1) < 3.5) notes.push([`${prof === "flux" ? "FLUX" : "Krea 2"} reads sentences: a tag list works better rewritten`, "tip"]);
      const n = words(s);
      if (n && n < 8) notes.push(["Short prompt: add the setting, light or style", "tip"]);
      else if (n > 160) notes.push([`${n} words: long prompts dilute; aim for 40–90`, "tip"]);
    }
    if (H3) {
      if (has(FILLER)) { s = dropFiller(s); notes.push(["Filler such as “8k, masterpiece” taken out", "fix"]); }
      const d = s.replace(/<d>(?!\s*\[)/g, "<d>[English] ");
      if (d !== s) { s = d; notes.push(["Dialogue tagged [English]", "fix"]); }
      const neg = [...new Set((s.replace(/<d>[\s\S]*?<\/d>/g, "").match(NEG) || []).map(x => x.toLowerCase()))];
      if (neg.length) notes.push([`H3 has no negative prompt: “${neg.slice(0, 3).join("”, “")}” may add what you meant to leave out`, "warn"]);
      const refs = state.refs?.length || 0;
      if (prof === "h3ref" || prof === "h3image") {
        const used = [...s.matchAll(/<Picture (\d+)>/g)].map(m => +m[1]);
        const bad = [...new Set(used.filter(n => n < 1 || n > refs))];
        if (bad.length) notes.push([`${bad.map(n => `<Picture ${n}>`).join(", ")}: only ${refs} reference picture${refs === 1 ? "" : "s"} added`, "warn"]);
        if (prof === "h3ref" && refs && !used.length) notes.push(["Refer to the references as <Picture 1>, <Picture 2>…", "tip"]);
      }
      if (prof === "h3video" || prof === "h3ref") {
        if (s && !/camera/i.test(s)) notes.push(["Add a camera move (e.g. “The camera pushes in slowly”)", "tip"]);
        if (s && !/soundscape|sound|music/i.test(s)) notes.push(["Describe the sound too: H3 renders it with the picture", "tip"]);
      }
    }
    if (prof === "music" && words(s) > 40) notes.push([`${words(s)} words: the style caption works best under 30`, "tip"]);
    return { text: s, notes };
  }

  /* What Generate sends: the resolved template, tidied for the model (when Tidy is on). */
  function final(raw = ta().value, seed = Math.floor(Math.random() * 1e9)) {
    const r = resolve(raw, { seed });
    return S.tidy ? shape(r).text : r;
  }

  /* ------------------------------------------------------------ live panel */
  function renderLive() {
    const box = $("#prompt-live");
    if (!box) return;
    const prof = profile(), raw = ta().value;
    if (!raw.trim() && !S.sug) { box.hidden = true; return; }
    box.hidden = false;
    const resolved = resolve(raw);
    const { text, notes } = S.tidy ? shape(resolved, prof) : { text: resolved, notes: [] };
    const changed = text !== raw.trim();
    const sug = S.sug;
    const canLive = !!prof;
    box.innerHTML = `
      <div class="pl-head">
        <span class="pl-model" title="The model this prompt is shaped for">${esc(modelLabel(modelKey()))}</span>
        <span class="pl-count">${words(text)} words</span>
        <span class="pl-gap"></span>
        <label class="pl-tg" title="Tidy the prompt for the model: weights and filler out, dialogue tagged. Generate sends the tidied text."><input type="checkbox" data-pl="tidy"${S.tidy ? " checked" : ""}> Tidy</label>
        <label class="pl-tg" title="${canLive ? "A local LLM rewrites the prompt in this model's format after you pause typing (Tab accepts)" : "No live rewrite for this model"}"><input type="checkbox" data-pl="live"${S.live && canLive ? " checked" : ""}${canLive ? "" : " disabled"}> ✨ Live rewrite</label>
      </div>
      ${notes.length ? `<ul class="pl-notes">${notes.map(([t, k]) => `<li class="pl-${k}">${k === "fix" ? "✓" : k === "warn" ? "⚠" : "💡"} ${esc(t)}</li>`).join("")}</ul>` : ""}
      ${sug ? `<div class="pl-sug${sug.done ? "" : " busy"}${sug.error ? " err" : ""}" aria-live="polite">
          <div class="pl-sug-head">${sug.error ? "⚠ Live rewrite" : sug.done ? `✨ ${esc(modelLabel(sug.model))} version` : `✨ Rewriting for ${esc(modelLabel(sug.model))}…`}
            ${sug.done && !sug.error ? `<span class="pl-keys"><kbd>Tab</kbd> accept · <kbd>Esc</kbd> dismiss</span>` : ""}</div>
          <div class="pl-sug-text">${sug.error ? esc(sug.error) : esc(sug.text) || "…"}</div>
          ${sug.missing?.length ? `<p class="pl-warn">⚠ The rewrite dropped ${sug.missing.map(m => `<code>${esc(m)}</code>`).join(", ")}; accepting adds ${sug.missing.length === 1 ? "it" : "them"} at the end.</p>` : ""}
          <div class="pl-sug-actions">${sug.done && !sug.error ? `<button type="button" class="btn sm primary" data-pl="accept">Accept</button>` : ""}
            <button type="button" class="btn sm" data-pl="dismiss">${sug.done || sug.error ? "Dismiss" : "Stop"}</button>
            ${sug.done ? `<button type="button" class="btn sm ghost" data-pl="again" title="Ask for another version">↻ Again</button>` : ""}</div>
        </div>` : S.paused ? `<p class="pl-paused">✨ Live rewrite is paused while a render runs, so the LLM doesn't take its VRAM.</p>` : ""}
      ${changed ? `<details class="pl-final"${hasSyntax(raw) ? " open" : ""}><summary>What ${esc(modelLabel(modelKey()))} gets${hasSyntax(raw) ? ` <button type="button" class="link" data-pl="reroll" title="Roll the random parts again">🎲 re-roll</button>` : ""}</summary><div class="pl-final-text">${esc(text)}</div></details>` : ""}`;
  }

  function onInput() {
    if (S.sug && !S.sug.accepting) dismiss(false);
    renderLive();
    clearTimeout(S.timer);
    if (!S.live || !profile()) return;
    warm();
    S.timer = setTimeout(ask, 850);
  }

  async function warm() {
    if (Date.now() - S.warmAt < 150000) return;
    S.warmAt = Date.now();
    const w = llmOpts();
    try { const r = await api("/api/prompt/warm", { method: "POST", body: JSON.stringify(w) }); S.paused = !!r.paused; if (S.paused) S.warmAt = 0; }
    catch { S.warmAt = 0; }
  }
  function llmOpts() {
    const st = (typeof writer !== "undefined" && writer.settings) || {};
    const backend = st.backend || undefined;
    return { backend, url: backend ? st.urls?.[backend] || undefined : undefined, model: st.model || undefined };
  }

  async function ask(force = false) {
    const raw = ta().value, prof = profile();
    if (!prof || !S.live) return;
    if (words(raw) < 3 || (!force && raw === S.lastAsked)) return;
    S.lastAsked = raw;
    S.ctrl?.abort();
    const ctrl = S.ctrl = new AbortController();
    const { text, markers } = protect(raw);
    const sug = S.sug = { for: raw, text: "", done: false, model: modelKey(), markers };
    renderLive();
    try {
      const res = await fetch("/api/prompt/rewrite", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ text, keep: markers.map(m => m.value), profile: prof, seconds: +$("#seconds").value || 5, ...llmOpts() }),
      });
      if (res.status === 409) { S.paused = true; S.sug = null; renderLive(); return; }
      S.paused = false;
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || res.statusText); }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", shown = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.error) throw new Error(m.error);
          if (m.t) sug.text += m.t;
          if (m.done) { const u = unprotect(m.text, markers); sug.text = u.text; sug.missing = u.missing; sug.done = true; }
        }
        if (S.sug !== sug) return;
        const now = performance.now();
        if (sug.done || now - shown > 50) { shown = now; renderSugText(sug); }
      }
      if (S.sug === sug) { sug.done = true; renderLive(); }
    } catch (e) {
      if (e.name === "AbortError" || S.sug !== sug) return;
      sug.error = /reachable|server|Ollama/i.test(e.message) ? `${e.message}. Start Ollama (or set the LLM in the Prompt writer), or turn Live rewrite off.` : e.message;
      sug.done = true; renderLive();
    }
  }
  // While streaming, update only the text, so the panel doesn't flicker.
  function renderSugText(sug) {
    const el = $("#prompt-live .pl-sug-text");
    if (!el || sug.done) { renderLive(); return; }
    el.textContent = unprotect(sug.text, sug.markers).text || "…";
  }

  function accept() {
    const sug = S.sug;
    if (!sug?.done || sug.error) return false;
    const t = ta(), before = t.value;
    const text = sug.text + (sug.missing?.length ? " " + sug.missing.join(" ") : "");
    sug.accepting = true;
    t.focus();
    t.select();
    // execCommand keeps the browser's own undo (Ctrl+Z brings the old prompt back).
    if (!document.execCommand?.("insertText", false, text)) { t.value = text; t.dispatchEvent(new Event("input", { bubbles: true })); }
    S.lastAsked = t.value; S.sug = null; S.undo = before;
    clearTimeout(S.timer);
    renderLive();
    Media.toast("Rewrite accepted. Ctrl+Z brings your text back.");
    return true;
  }
  function dismiss(render = true) {
    S.ctrl?.abort(); S.ctrl = null; S.sug = null;
    if (render) renderLive();
  }

  /* ------------------------------------------------------------ prompt tags (this prompt's own) */
  function renderTags() {
    const box = $("#prompt-tags");
    if (!box) return;
    const tags = state.promptTags || {};
    const names = Object.keys(tags);
    box.innerHTML = `<span class="pt-label" title="Named values this prompt uses as <name> or {{name}}. A tag with several values gives one at random.">Tags</span>
      ${names.map(n => { const v = tags[n], many = Array.isArray(v);
        return `<span class="pt-chip" data-tag="${esc(n)}"><button type="button" class="pt-ins" data-pt="insert" title="Insert <${esc(n)}> at the cursor">&lt;${esc(n)}&gt;</button><button type="button" class="pt-val" data-pt="edit" title="Edit">${many ? `🎲 ${v.length}` : esc(String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 28)) || "…"}</button></span>`; }).join("")}
      <button type="button" class="link" data-pt="add">+ Tag</button>
      <button type="button" class="link" data-pt="presets" title="Pick ready-made words: hair, outfits, lighting, camera…">🏷 Presets</button>`;
  }
  function editTag(name = null) {
    const tags = state.promptTags ||= {};
    const cur = name != null ? tags[name] : null;
    const vals = cur == null ? "" : Array.isArray(cur) ? cur.join("\n") : typeof cur === "string" ? cur : JSON.stringify(cur, null, 2);
    const box = document.createElement("div");
    box.className = "wm-form";
    box.innerHTML = `<label class="field">Name <input type="text" data-f="name" value="${esc(name || "")}" placeholder="e.g. hero" spellcheck="false"></label>
      <label class="field">Value <span class="hint inline">one per line; several lines = one at random each time</span>
        <textarea data-f="vals" rows="6" placeholder="a knight in silver armor">${esc(vals)}</textarea></label>
      <p class="hint">Use it in the prompt as <code>&lt;name&gt;</code> or <code>{{name}}</code>.</p>`;
    const foot = document.createElement("div");
    foot.innerHTML = `${name != null ? `<button type="button" class="btn sm danger" data-a="del">Delete tag</button>` : ""}<span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="cancel">Cancel</button><button type="button" class="btn sm primary" data-a="ok">${name != null ? "Save" : "Add and insert"}</button>`;
    const w = WM.open({ id: "prompt-tag", title: name != null ? `Tag <${name}>` : "New tag", content: box, footer: foot, width: 420, height: 380, minHeight: 300 });
    setTimeout(() => $(name != null ? '[data-f="vals"]' : '[data-f="name"]', box).focus(), 0);
    foot.addEventListener("click", e => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      if (a === "del") { delete tags[name]; afterTags(); w.close(); return; }
      if (a !== "ok") { w.close(); return; }
      const n = slug($('[data-f="name"]', box).value) || "";
      if (!n) { Media.toast("Give the tag a name."); return; }
      const lines = $('[data-f="vals"]', box).value.split("\n").map(x => x.trim()).filter(Boolean);
      if (name != null && n !== name) delete tags[name];
      tags[n] = lines.length > 1 ? lines : lines[0] || "";
      if (name == null) insertAtCursor(ta(), `<${n}>`);
      afterTags(); w.close();
    });
  }
  function afterTags() { renderTags(); renderLive(); scheduleSave(); }

  /* ------------------------------------------------------------ presets picker */
  async function presetsWin() {
    await load();
    const cats = Object.keys(S.presets);
    const box = document.createElement("div");
    box.className = "pp";
    box.innerHTML = `<input type="search" class="pp-q" placeholder="Filter, e.g. braid, neon, 35mm…" aria-label="Filter presets">
      <div class="pp-list">${cats.map(c => `<details class="pp-cat" data-cat="${esc(c)}"><summary><span>${esc(c)}</span>
        <button type="button" class="link" data-pp="random" title="Insert <${esc(slug(c))}/>: one at random each time">🎲 random</button></summary>
        <div class="pp-items">${S.presets[c].map(t => `<label><input type="checkbox" value="${esc(t)}"> ${esc(t)}</label>`).join("")}</div></details>`).join("")}</div>`;
    const foot = document.createElement("div");
    foot.innerHTML = `<span class="pp-n hint">Tick words, then insert them.</span><span class="wm-foot-gap"></span>
      <button type="button" class="btn sm" data-a="clear">Clear ticks</button><button type="button" class="btn sm primary" data-a="insert">Insert</button>`;
    const w = WM.open({ id: "prompt-presets", title: "Tag presets", content: box, footer: foot, width: 440, height: 560, modal: false });
    const count = () => { const n = $$("input:checked", box).length; $(".pp-n", foot).textContent = n ? `${n} ticked` : "Tick words, then insert them."; };
    box.addEventListener("change", count);
    $(".pp-q", box).addEventListener("input", e => {
      const q = e.target.value.trim().toLowerCase();
      $$(".pp-cat", box).forEach(d => {
        let any = false;
        $$("label", d).forEach(l => { const hit = !q || l.textContent.toLowerCase().includes(q) || d.dataset.cat.toLowerCase().includes(q); l.hidden = !hit; any ||= hit; });
        d.hidden = !any; d.open = !!q && any;
      });
    });
    box.addEventListener("click", e => {
      if (e.target.dataset.pp !== "random") return;
      e.preventDefault();
      insertAtCursor(ta(), `<${slug(e.target.closest(".pp-cat").dataset.cat)}/>`);
      ta().dispatchEvent(new Event("input", { bubbles: true }));
    });
    foot.addEventListener("click", e => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "clear") { $$("input:checked", box).forEach(i => i.checked = false); count(); }
      if (a === "insert") {
        const picked = $$("input:checked", box).map(i => i.value);
        if (!picked.length) { Media.toast("Tick some words first."); return; }
        insertAtCursor(ta(), picked.join(", "));
        ta().dispatchEvent(new Event("input", { bubbles: true }));
        $$("input:checked", box).forEach(i => i.checked = false); count();
      }
    });
    return w;
  }

  /* ------------------------------------------------------------ catalog */
  async function load(force = false) {
    if (S.loaded && !force) return;
    const j = await api("/api/prompts");
    S.entries = j.entries; S.presets = j.presets || {}; S.nodeLib = !!j.node_library; S.loaded = true;
  }

  async function catalog() {
    try { await load(true); } catch (e) { Media.toast(`Catalog: ${e.message}`); return; }
    const box = document.createElement("div");
    box.className = "pc";
    let sel = S.entryId && S.entries.some(e => e.id === S.entryId) ? S.entryId : null, filter = "all", q = "";
    const foot = document.createElement("div");
    const w = WM.open({ id: "prompt-catalog", title: "Prompt catalog", content: box, footer: foot, width: 820, height: 560, minWidth: 520, minHeight: 360 });
    function draw() {
      const mk = modelKey(), ql = q.toLowerCase();
      const list = S.entries.filter(e => (filter === "all" || e.model === mk) &&
        (!ql || e.title.toLowerCase().includes(ql) || e.prompt.toLowerCase().includes(ql) || Object.keys(e.tags || {}).some(k => k.includes(ql))));
      const groups = {};
      list.forEach(e => (groups[e.model || ""] ||= []).push(e));
      const order = Object.keys(groups).sort((a, b) => (a === mk ? -1 : b === mk ? 1 : modelLabel(a).localeCompare(modelLabel(b))));
      const cur = S.entries.find(e => e.id === sel);
      box.innerHTML = `<div class="pc-side">
          <div class="pc-tools"><input type="search" class="pc-q" value="${esc(q)}" placeholder="Search titles, text, tags" aria-label="Search the catalog">
            <div class="seg sm" role="group"><button type="button" data-f="all" class="${filter === "all" ? "active" : ""}">All</button><button type="button" data-f="this" class="${filter === "this" ? "active" : ""}" title="${esc(modelLabel(mk))}">This model</button></div></div>
          <div class="pc-list">${order.length ? order.map(g => `<div class="pc-group">${esc(modelLabel(g))}${g === mk ? " · this model" : ""}</div>
            ${groups[g].map(e => `<button type="button" class="pc-item${e.id === sel ? " on" : ""}" data-id="${esc(e.id)}"><b>${esc(e.title)}</b><small>${esc(e.prompt.replace(/\s+/g, " ").slice(0, 90))}</small></button>`).join("")}`).join("")
            : `<p class="hint pc-empty">${S.entries.length ? "Nothing matches." : "No saved prompts yet. Write one, then Save current prompt."}</p>`}</div>
          ${S.nodeLib ? `<button type="button" class="link pc-import" data-c="import" title="Copy the prompts from the ComfyUI Prompt Explorer node into this catalog (once; prompts already copied are skipped)">⇩ Import from the Prompt Explorer node</button>` : ""}
        </div>
        <div class="pc-main">${cur ? `<h3>${esc(cur.title)}</h3><p class="hint">${esc(modelLabel(cur.model))} · saved ${esc(cur.updated?.replace("T", " ") || "")}</p>
            <pre class="pc-text">${esc(cur.prompt)}</pre>
            ${Object.keys(cur.tags || {}).length ? `<h4>Tags</h4><ul class="pc-tags">${Object.entries(cur.tags).map(([k, v]) => `<li><code>&lt;${esc(k)}&gt;</code> ${Array.isArray(v) ? `🎲 ${v.map(esc).join(" · ")}` : esc(typeof v === "string" ? v : JSON.stringify(v))}</li>`).join("")}</ul>` : ""}`
          : `<p class="hint pc-empty">Pick a prompt to see it here.</p>`}</div>`;
      foot.innerHTML = `${cur ? `<button type="button" class="btn sm danger" data-c="delete">Delete</button>` : ""}<span class="wm-foot-gap"></span>
        <button type="button" class="btn sm" data-c="save" title="Save the Prompt step's text and tags in the catalog">💾 Save current prompt…</button>
        ${cur ? `<button type="button" class="btn sm primary" data-c="use">Use this prompt</button>` : ""}`;
      $(".pc-q", box).oninput = e => { q = e.target.value; const pos = e.target.selectionStart; draw(); const n = $(".pc-q", box); n.focus(); n.selectionStart = n.selectionEnd = pos; };
    }
    async function act(c) {
      const cur = S.entries.find(e => e.id === sel);
      if (c === "use" && cur) { use(cur); w.close(); return; }
      if (c === "delete" && cur) {
        if (!confirm(`Delete “${cur.title}” from the catalog? This can't be undone.`)) return;
        try { S.entries = (await api(`/api/prompts/${encodeURIComponent(cur.id)}`, { method: "DELETE" })).entries; sel = null; if (S.entryId === cur.id) S.entryId = null; draw(); }
        catch (e) { Media.toast(e.message); }
      }
      if (c === "save") { const saved = await saveDialog(); if (saved) { sel = saved.id; draw(); } }
      if (c === "import") {
        try { const r = await api("/api/prompts/import-node", { method: "POST" }); S.entries = r.entries; draw(); Media.toast(r.added ? `Imported ${r.added} prompt${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already here)` : ""}.` : "Nothing new to import."); }
        catch (e) { Media.toast(e.message); }
      }
    }
    box.addEventListener("click", e => {
      const it = e.target.closest(".pc-item"); if (it) { sel = it.dataset.id; draw(); return; }
      const f = e.target.closest("[data-f]")?.dataset.f; if (f) { filter = f; draw(); return; }
      const c = e.target.closest("[data-c]")?.dataset.c; if (c) act(c);
    });
    box.addEventListener("dblclick", e => { const it = e.target.closest(".pc-item"); if (it) { sel = it.dataset.id; act("use"); } });
    foot.addEventListener("click", e => { const c = e.target.closest("[data-c]")?.dataset.c; if (c) act(c); });
    draw();
  }

  function use(entry) {
    const t = ta();
    t.focus(); t.select();
    if (!document.execCommand?.("insertText", false, entry.prompt)) t.value = entry.prompt;
    state.promptTags = structuredClone(entry.tags || {});
    S.entryId = entry.id; S.lastAsked = entry.prompt; dismiss(false);
    renderTags(); renderLive(); scheduleSave();
    const mk = modelKey();
    Media.toast(entry.model && entry.model !== mk && entry.model.includes(":") ? `Loaded “${entry.title}”, written for ${modelLabel(entry.model)}. Live rewrite can reshape it for ${modelLabel(mk)}.` : `Loaded “${entry.title}”.`);
  }

  function saveDialog() {
    return new Promise(done => {
      const prior = S.entries.find(e => e.id === S.entryId);
      const box = document.createElement("div");
      box.className = "wm-form";
      box.innerHTML = `<label class="field">Title <input type="text" data-f="title" value="${esc(prior?.title || "")}" placeholder="e.g. Fisherman at dawn"></label>
        <p class="hint">Saves the prompt text and its ${Object.keys(state.promptTags || {}).length} tag(s) for ${esc(modelLabel(modelKey()))}.</p>`;
      const foot = document.createElement("div");
      foot.innerHTML = `<span class="wm-foot-gap"></span><button type="button" class="btn sm" data-a="cancel">Cancel</button>
        ${prior ? `<button type="button" class="btn sm" data-a="new">Save as new</button><button type="button" class="btn sm primary" data-a="update">Update “${esc(prior.title)}”</button>` : `<button type="button" class="btn sm primary" data-a="new">Save</button>`}`;
      const w = WM.open({ id: "prompt-save", title: "Save prompt", content: box, footer: foot, width: 440, height: 230, minHeight: 200, onClose: r => done(r || null) });
      setTimeout(() => $('[data-f="title"]', box).focus(), 0);
      const go = async a => {
        if (a === "cancel") { w.close(); return; }
        const title = $('[data-f="title"]', box).value.trim();
        if (!title) { Media.toast("Give it a title."); return; }
        try {
          const r = await api("/api/prompts", { method: "POST", body: JSON.stringify({ id: a === "update" ? prior.id : null, title, model: modelKey(), prompt: ta().value, tags: state.promptTags || {} }) });
          S.entries = r.entries; S.entryId = r.entry.id;
          Media.toast(`Saved “${r.entry.title}” in the catalog.`);
          w.close(r.entry);
        } catch (e) { Media.toast(e.message); }
      };
      foot.addEventListener("click", e => { const a = e.target.closest("[data-a]")?.dataset.a; if (a) go(a); });
      box.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(prior ? "update" : "new"); } });
    });
  }

  /* ------------------------------------------------------------ wiring */
  function init() {
    state.promptTags ||= {};
    const t = ta();
    t.addEventListener("input", onInput);
    t.addEventListener("keydown", e => {
      if (e.key === "Tab" && !e.shiftKey && S.sug?.done && !S.sug.error) { e.preventDefault(); accept(); }
      else if (e.key === "Escape" && S.sug) { e.preventDefault(); e.stopPropagation(); dismiss(); }
    });
    $("#prompt-live").addEventListener("click", e => {
      const a = e.target.closest("[data-pl]")?.dataset.pl;
      if (a === "accept") accept();
      if (a === "dismiss") dismiss();
      if (a === "again") { S.lastAsked = ""; ask(true); }
      if (a === "reroll") { e.preventDefault(); S.previewSeed = Math.floor(Math.random() * 1e9); renderLive(); }
    });
    $("#prompt-live").addEventListener("change", e => {
      const a = e.target.dataset.pl;
      if (a === "tidy") { S.tidy = e.target.checked; lsSet(TIDY_KEY, S.tidy); renderLive(); }
      if (a === "live") { S.live = e.target.checked; lsSet(LIVE_KEY, S.live); if (!S.live) dismiss(); else { S.lastAsked = ""; onInput(); } }
    });
    $("#prompt-tags").addEventListener("click", e => {
      const a = e.target.closest("[data-pt]")?.dataset.pt, name = e.target.closest("[data-tag]")?.dataset.tag;
      if (a === "add") editTag();
      if (a === "edit") editTag(name);
      if (a === "presets") presetsWin();
      if (a === "insert") { insertAtCursor(ta(), `<${name}>`); ta().dispatchEvent(new Event("input", { bubbles: true })); }
    });
    $("#btn-catalog").onclick = catalog;
    load().then(renderLive).catch(() => {});
    renderTags(); renderLive();
  }
  // The model, the prompt or the tags changed from outside (model pick, project load, Reuse…).
  function refresh() {
    if (S.sug && S.sug.model !== modelKey()) dismiss(false);
    S.lastAsked = "";
    renderTags(); renderLive();
  }

  return { init, refresh, resolve, shape, final, hasSyntax, catalog, presetsWin, accept, dismiss, profile, _S: S };
})();
