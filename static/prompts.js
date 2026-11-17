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
  const LIVE_KEY = "bob.prompt.live", TIDY_KEY = "bob.prompt.tidy", MODEL_KEY = "bob.prompt.liveModel";
  const lsStr = k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch {} };
  const S = {
    entries: [], presets: {}, nodeLib: false, loaded: false,
    live: ls(LIVE_KEY, true), tidy: ls(TIDY_KEY, true),
    liveModel: lsStr(MODEL_KEY),  // "" = the fastest installed (the server picks)
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
      if (neg.length) {
        const phrases = [...new Set((s.replace(/<d>[\s\S]*?<\/d>/g, "").match(/\b(?:no|not|never|without|nothing|nobody)\b(?:\s+[\w'-]+){0,2}/gi) || []))].slice(0, 6);
        notes.push([`H3 has no negative prompt: “${neg.slice(0, 3).join("”, “")}” may add what you meant to leave out`, "warn",
          `Negations make H3 add the thing: rewrite ${phrases.map(p => `“${p}”`).join(", ")} as what IS there (e.g. “no windows” → “bare plaster walls”, “not smiling” → “a calm, neutral face”). Use none of the words no, not, never, without outside spoken lines.`]);
      }
      const refs = state.refs?.length || 0;
      if (prof === "h3ref" || prof === "h3image") {
        const used = [...s.matchAll(/<Picture (\d+)>/g)].map(m => +m[1]);
        const bad = [...new Set(used.filter(n => n < 1 || n > refs))];
        if (bad.length) notes.push([`${bad.map(n => `<Picture ${n}>`).join(", ")}: only ${refs} reference picture${refs === 1 ? "" : "s"} added`, "warn",
          refs ? `Only ${Array.from({ length: refs }, (_, i) => `<Picture ${i + 1}>`).join(", ")} exist. Remove ${bad.map(n => `<Picture ${n}>`).join(", ")}: refer to that person or thing with an existing tag or describe it in plain words instead.`
            : `There are no reference pictures: remove every <Picture N> tag and describe those people or things in plain words.`]);
        if (prof === "h3ref" && refs && !used.length) notes.push(["Refer to the references as <Picture 1>, <Picture 2>…", "tip"]);
        // Voices go with the picture of the same number: a sentence pairing <Picture 2> with <Audio 1> is likely a slip.
        if (prof === "h3ref") {
          const wrong = new Set();
          for (const sent of s.split(/(?<=[.!?])\s+|\n/)) {
            const pics = [...new Set([...sent.matchAll(/<Picture (\d+)>/g)].map(m => +m[1]))];
            const auds = [...new Set([...sent.matchAll(/<Audio (\d+)>/g)].map(m => +m[1]))];
            if (pics.length === 1 && auds.length === 1 && pics[0] !== auds[0]) wrong.add(`<Picture ${pics[0]}> with <Audio ${auds[0]}>`);
          }
          if (wrong.size) notes.push([`Voice mix-up? ${[...wrong].join(", ")}: <Audio N> is the voice of the person in <Picture N>`, "warn",
            `<Audio N> is the voice of the person in <Picture N>: give each speaker the voice with their own number (${[...wrong].join(", ")} is wrong).`]);
        }
      }
      if (prof === "h3video" || prof === "h3ref") {
        if (s && !/camera/i.test(s)) notes.push(["Add a camera move (e.g. “The camera pushes in slowly”)", "tip", "End every shot with exactly one camera move, e.g. “The camera pushes in slowly.”"]);
        // Shot lines written without their [Shot N] tag (LLMs drop it): "At 00:04.000, close-up…" lines.
        if (!/^\s*\[Shot\s*\d+\]/im.test(s) && /^\s*At\s+\d+:\d+(?:\.\d+)?,/im.test(s)) {
          let k = 0;
          s = s.replace(/^(\s*)At\s+(\d+:\d+(?:\.\d+)?),\s*/gim, (m, sp, time) => `${sp}[Shot ${++k}] ${k === 1 && /^0+:0+(\.0+)?$/.test(time) ? "" : `At ${time}, `}`);
          notes.push(["Shot lines tagged [Shot 1], [Shot 2]…", "fix"]);
        }
        // Spoken words in quotes after says/asks… go in H3's <d> tags, or H3 may not voice them.
        const quoted = s.replace(/\b(say|says|said|asks|asked|whispers|whispered|shouts|shouted|replies|replied)\b[,:]?\s*[“"]([^”"<>]{1,300})[”"]/gi,
          (m, verb, line) => `${verb}: <d>[English] ${line.trim()}</d>`);
        if (quoted !== s) { s = quoted; notes.push(["Spoken line put in <d>[English] …</d>", "fix"]); }
        if (/^\s*\[Shot\s*\d+\]/im.test(s)) s = shotList(s, notes);
        else {
          if (s && !/soundscape|sound|music/i.test(s)) notes.push(["Describe the sound too: H3 renders it with the picture", "tip", "Add the overall_soundscape: and non_diegetic_music: lines at the end."]);
          // (Whether the spoken lines fit the clip is part of the duration estimate below.)
        }
      }
      if ((prof === "h3video" || prof === "h3ref") && s && words(s) >= 3) {
        const d = durationNote(s);
        if (d) notes.push([d[0], d[1], d[1] === "warn" ? "Make it fit the clip: fewer shots, shorter spoken lines, or simpler action." : null, d[2]]);
      }
      if (prof === "h3sound" && s) {
        if (!/^\s*overall_soundscape\s*:/im.test(s)) notes.push(["Start with “overall_soundscape:” and the ambience and effects in order", "tip"]);
        if (!/^\s*non_diegetic_music\s*:/im.test(s)) notes.push(["Add a “non_diegetic_music:” line (the score, or N/A)", "tip"]);
      }
    }
    if (prof === "music" && words(s) > 40) notes.push([`${words(s)} words: the style caption works best under 30`, "tip"]);
    return { text: s, notes };
  }

  /* ------------------------------------------------------------ H3 shot lists
     "[Shot 1] … [Shot 2] At 00:04.000, …" plus overall_soundscape: / non_diegetic_music: lines. Numbers
     and times are put right (times on whole frames, as 00:SS.mmm); the rest is checked against the clip
     length from Settings: start times inside the clip and in order, spoken words that fit each shot (about
     2.5 a second), shots long enough to read, and the two sound lines. */
  const FPS = 24;
  const clipSeconds = () => h3Frames(+$("#seconds").value || 5) / FPS;
  const fmtSec = t => `${Math.round(t * 10) / 10} s`;
  const fmtTime = t => `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(3).padStart(6, "0")}`;
  /* How long the clip needs to be: each shot needs time to read (about 2 s) and to speak its lines (2.5 words a
     second, plus a little air); timed shots need what's left after their start. A suggestion in 0.5 s steps. */
  function neededSeconds(s) {
    const lines = text => spoken(text);
    const shotNeed = text => Math.max(2, lines(text) ? lines(text) / 2.5 + 0.8 : 2);
    if (!/^\s*\[Shot\s*\d+\]/im.test(s)) return Math.max(3, spoken(s) ? spoken(s) / 2.5 + 1 : 3);
    const bodies = s.split(/^\s*\[Shot\s*\d+\]/im).slice(1).map(b => b.split(/^\s*(overall_soundscape|non_diegetic_music)\s*:/im)[0]);
    let sum = 0, last = 0;
    bodies.forEach((b, k) => {
      const need = shotNeed(b);
      sum += need;
      const m = b.match(/^\s*At\s+(?:(\d+):)?(\d+(?:\.\d+)?)/i);
      if (m) last = Math.max(last, (+m[1] || 0) * 60 + +m[2] + need);
      else if (k === 0) last = need;
    });
    return Math.max(sum, last);
  }
  function durationNote(s) {
    const need = neededSeconds(s), clip = clipSeconds(), set = +$("#seconds").value || 5;
    const max = +$("#seconds").max || 15, min = +$("#seconds").min || 2;
    // H3 snaps the length to its frame grid (12.5 s → 12.3 s), so suggest the first setting that still covers it.
    let suggest = Math.min(max, Math.max(min, Math.ceil(need * 2) / 2));
    while (suggest < max && h3Frames(suggest) / FPS < need - 0.05) suggest += 0.5;
    if (need > max + 0.25) return [`This needs about ${fmtSec(need)}, more than H3's ${max} s: split it into two clips or trim it`, "warn", null];
    if (need > clip + 0.25) return [`May be cut off: it needs about ${fmtSec(need)}, the clip is ${fmtSec(clip)}`, "warn", suggest];
    if (clip - need >= 4 && suggest < set) return [`About ${fmtSec(need)} is enough; the clip is ${fmtSec(clip)}`, "tip", suggest];
    return null;
  }
  // The words inside each <d>…</d> (without the [Language] tag): a rewrite must keep them word for word.
  const spokenLines = text => [...String(text).matchAll(/<d>\s*(?:\[[^\]]*\]\s*)?([\s\S]*?)<\/d>/g)].map(m => m[1].trim()).filter(Boolean).slice(0, 10);
  const spoken = text => [...text.matchAll(/<d>([\s\S]*?)<\/d>/g)].reduce((n, m) => n + words(m[1].replace(/^\s*\[[^\]]*\]/, "")), 0);
  function shotList(s, notes) {
    const clip = clipSeconds();
    // Split into [head, "[Shot n]", body, "[Shot m]", body, …]; the sound lines live in the last body.
    const parts = s.split(/^(\s*\[Shot\s*\d+\])/im);
    const n = (parts.length - 1) / 2;
    let renumbered = false, retimed = false;
    const shots = [];
    for (let k = 0; k < n; k++) {
      const tag = parts[1 + 2 * k], want = `[Shot ${k + 1}]`;
      if (tag.trim() !== want) { parts[1 + 2 * k] = tag.replace(/\[Shot\s*\d+\]/i, want); renumbered = true; }
      let body = parts[2 + 2 * k];
      const m = body.match(/^\s*At\s+(?:(\d+):)?(\d+(?:\.\d+)?)\s*(?:s\b)?\s*,?[ \t]*/i);
      let start = k === 0 ? 0 : null;
      if (m) {
        start = Math.round(((+m[1] || 0) * 60 + +m[2]) * FPS) / FPS;
        const fixed = ` At ${fmtTime(start)}, `;
        if (m[0] !== fixed) { body = fixed + body.slice(m[0].length).replace(/^\s+/, ""); retimed = true; }
      }
      parts[2 + 2 * k] = body;
      shots.push({ start, body });
    }
    s = parts.join("");
    if (renumbered) notes.push(["Shots numbered 1, 2, 3… in order", "fix"]);
    if (retimed) notes.push(["Shot times written as 00:SS.mmm on whole frames", "fix"]);
    shots.forEach((x, k) => {
      if (k > 0 && x.start == null) notes.push([`Shot ${k + 1} has no start time: begin it with “At ${fmtTime(Math.round(k * clip / n * FPS) / FPS)}, ”`, "warn"]);
    });
    const known = shots.map((x, k) => ({ ...x, k })).filter(x => x.start != null);
    known.forEach((x, i) => {
      if (x.start >= clip) notes.push([`Shot ${x.k + 1} starts at ${fmtSec(x.start)}, after the clip ends (${fmtSec(clip)}): lower it or make the clip longer in Settings`, "warn"]);
      else if (i > 0 && x.start <= known[i - 1].start) notes.push([`Shot ${x.k + 1} starts before or with shot ${known[i - 1].k + 1}: times must go up`, "warn"]);
    });
    // Each shot runs to the next known start (or the clip's end).
    known.forEach((x, i) => {
      const end = Math.min(clip, i + 1 < known.length ? known[i + 1].start : clip), len = end - x.start;
      if (len <= 0 || x.start >= clip) return;
      if (len < 1) notes.push([`Shot ${x.k + 1} lasts ${fmtSec(len)}: too short to read; give it at least a second`, "tip"]);
      const said = spoken(shots[x.k].body.split(/^\s*(overall_soundscape|non_diegetic_music)\s*:/im)[0]), budget = Math.max(2, Math.floor(len * 2.5));
      if (said > budget) notes.push([`Shot ${x.k + 1}: ${said} spoken words in ${fmtSec(len)}; about ${budget} fit`, "warn"]);
    });
    if (n > Math.max(1, Math.floor(clip / 1.5))) notes.push([`${n} shots in ${fmtSec(clip)} is a lot: H3 needs about 1.5 s or more per shot`, "tip"]);
    if (!/^\s*overall_soundscape\s*:/im.test(s)) notes.push(["Add an “overall_soundscape:” line after the shots (ambience and effects, in order)", "warn"]);
    if (!/^\s*non_diegetic_music\s*:/im.test(s)) notes.push(["Add a “non_diegetic_music:” line (the score, or N/A)", "tip"]);
    return s;
  }

  /* What Generate sends: the resolved template, tidied for the model (when Tidy is on). */
  function final(raw = ta().value, seed = Math.floor(Math.random() * 1e9)) {
    const r = resolve(raw, { seed });
    return S.tidy ? shape(r).text : r;
  }

  /* ------------------------------------------------------------ live panel */
  // Over the Shot writer: the same duration estimate for the prompt it's filling.
  function renderWriterDuration() {
    const el = $("#pw-dur"), prof = profile(), raw = ta().value;
    if (!el) return;
    if (!(prof === "h3video" || prof === "h3ref") || words(raw) < 3) { el.innerHTML = ""; return; }
    const s = shape(resolve(raw), prof).text, d = durationNote(s);
    el.className = `pw-dur${d?.[1] === "warn" ? " warn" : ""}`;
    el.innerHTML = `⏱ needs ~${fmtSec(neededSeconds(s))} of ${fmtSec(clipSeconds())}${d ? ` · ${esc(d[1] === "warn" ? (d[2] ? "may be cut off" : d[0]) : "could be shorter")}` : ""}${d?.[2] ? ` <button type="button" class="link" data-pl="dur" data-s="${d[2]}">Use ${d[2]} s</button>` : ""}`;
  }
  function renderLive() {
    renderWriterDuration();
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
        <span class="pl-count">${words(text)} words${(prof === "h3video" || prof === "h3ref") && words(text) >= 3 ? ` · ⏱ needs ~${fmtSec(neededSeconds(text))} of ${fmtSec(clipSeconds())}` : ""}</span>
        <span class="pl-gap"></span>
        <label class="pl-tg" title="Tidy the prompt for the model: weights and filler out, dialogue tagged. Generate sends the tidied text."><input type="checkbox" data-pl="tidy"${S.tidy ? " checked" : ""}> Tidy</label>
        <label class="pl-tg" title="${canLive ? "A local LLM rewrites the prompt in this model's format after you pause typing (Tab accepts)" : "No live rewrite for this model"}"><input type="checkbox" data-pl="live"${S.live && canLive ? " checked" : ""}${canLive ? "" : " disabled"}> ✨ Live rewrite</label>
        ${S.live && canLive ? (() => {
          const names = (typeof writer !== "undefined" && writer.models || []).map(m => m.name);
          if (S.liveModel && !names.includes(S.liveModel)) names.unshift(S.liveModel);
          return `<select class="pl-llm" data-pl="model" aria-label="LLM for the live rewrite" title="LLM for the live rewrite. Auto: a small fast model (qwen3:4b-instruct…) for image and music prompts, the Prompt writer's model for H3 shot lists">
            <option value="">Auto (fastest)${S.usedModel && !S.liveModel ? ` · ${esc(S.usedModel)}` : ""}</option>${names.map(n => `<option value="${esc(n)}"${n === S.liveModel ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
        })() : ""}
      </div>
      ${notes.length ? `<ul class="pl-notes">${notes.map(([t, k, , dur]) => `<li class="pl-${k}">${k === "fix" ? "✓" : k === "warn" ? "⚠" : "💡"} ${esc(t)}${dur ? ` <button type="button" class="link" data-pl="dur" data-s="${dur}" title="Set Duration (Settings) to ${dur} s">Use ${dur} s</button>` : ""}</li>`).join("")}</ul>` : ""}
      ${sug ? `<div class="pl-sug${sug.done ? "" : " busy"}${sug.error ? " err" : ""}" aria-live="polite">
          <div class="pl-sug-head">${sug.error ? "⚠ Live rewrite" : sug.done ? `✨ ${esc(modelLabel(sug.model))} version` : `✨ Rewriting for ${esc(modelLabel(sug.model))}…`}
            ${sug.done && !sug.error ? `<span class="pl-keys"><kbd>Tab</kbd> accept · <kbd>Esc</kbd> dismiss</span>` : ""}</div>
          ${sug.total && !sug.error ? `<p class="pl-fixing">${sug.done
            ? (sug.left?.length ? `Fixes ${Math.max(0, sug.total - sug.left.length)} of ${sug.total} flagged problem${sug.total === 1 ? "" : "s"}; still: ${sug.left.map(esc).join(" · ")}`
              : `✓ Fixes the ${sug.total} flagged problem${sug.total === 1 ? "" : "s"}`)
            : sug.round > 1 ? `Second pass: fixing the ${sug.problems.length} still flagged…` : `Fixing ${sug.total} flagged problem${sug.total === 1 ? "" : "s"}…`}</p>` : ""}
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
    S.timer = setTimeout(ask, 600);
  }

  async function warm() {
    // Auto may use another model for another kind of prompt: warm again when that changes.
    if (Date.now() - S.warmAt < 150000 && S.warmProfile === profile()) return;
    S.warmAt = Date.now(); S.warmProfile = profile();
    const w = { ...llmOpts(), profile: profile() };
    try { const r = await api("/api/prompt/warm", { method: "POST", body: JSON.stringify(w) }); S.paused = !!r.paused; if (S.paused) S.warmAt = 0; }
    catch { S.warmAt = 0; }
  }
  function llmOpts() {
    const st = (typeof writer !== "undefined" && writer.settings) || {};
    const backend = st.backend || undefined;
    // The live rewrite has its own model (fast by default); the Prompt writer keeps its own choice.
    return { backend, url: backend ? st.urls?.[backend] || undefined : undefined, model: S.liveModel || undefined };
  }

  /* from/prev: a second pass that rewrites the first suggestion again, to fix what it left flagged. */
  async function ask(force = false, from = null, prev = null) {
    const raw = ta().value, prof = profile();
    if (!prof || !S.live) return;
    if (!from && (words(raw) < 3 || (!force && raw === S.lastAsked))) return;
    S.lastAsked = raw;
    S.ctrl?.abort();
    const ctrl = S.ctrl = new AbortController();
    const { text, markers } = protect(from ?? raw);
    // What the live model view flags (not what Tidy already put right) goes along, so the rewrite fixes it.
    const flagged = (from ? shape(resolve(from), prof) : shape(resolve(raw), prof)).notes.filter(([, k, fix]) => k !== "fix" && fix !== null);
    const problems = flagged.map(([t, , fix]) => fix || t);
    const sug = S.sug = { for: raw, text: "", done: false, model: modelKey(), markers, problems,
      total: prev?.total ?? problems.length, round: prev ? prev.round + 1 : 1 };
    renderLive();
    try {
      const res = await fetch("/api/prompt/rewrite", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ text, keep: [...markers.map(m => m.value), ...spokenLines(from ?? raw)], problems, profile: prof, seconds: +$("#seconds").value || 5,
          refs: ["h3ref", "h3image"].includes(prof) ? state.refs?.length || 0 : null, arefs: prof === "h3ref" ? state.arefs?.length || 0 : 0, ...llmOpts() }),
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
          if (m.model && m.model !== S.usedModel) { S.usedModel = m.model; const o = $("#prompt-live .pl-llm option[value='']"); if (o && !S.liveModel) o.textContent = `Auto (fastest) · ${m.model}`; }
          if (m.t) sug.text += m.t;
          if (m.done) {
            const u = unprotect(m.text, markers); sug.text = u.text; sug.missing = [...new Set([...(prev?.missing || []), ...u.missing])]; sug.done = true;
            sug.left = shape(resolve(sug.text), prof).notes.filter(([, k]) => k !== "fix").map(([t]) => t);
            // Still flagged after the first pass (and fewer than before): one more pass on the rewrite itself.
            if (sug.left.length && sug.round === 1 && sug.problems.length) { sug.again = true; }
          }
        }
        if (S.sug !== sug) return;
        const now = performance.now();
        if (sug.done || now - shown > 50) { shown = now; renderSugText(sug); }
      }
      if (S.sug === sug) {
        sug.done = true;
        if (sug.again && !sug.error) { sug.done = false; renderLive(); ask(true, sug.text, sug); return; }
        renderLive();
      }
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
  /* The toolbar over the prompt: reference pictures and voices (H3 Reference, H3 Image), this prompt's
     tags, presets, and text from the catalog, all inserted at the cursor. */
  function renderTags() {
    const box = $("#prompt-bar");
    if (!box) return;
    const tags = state.promptTags || {};
    const names = Object.keys(tags);
    const mk = modelKey(), refModel = mk === "video:h3ref" || mk === "image:h3image";
    const refs = refModel ? state.refs || [] : [], arefs = mk === "video:h3ref" ? state.arefs || [] : [];
    box.innerHTML = `${refModel ? `<div class="pb-group pb-refs" role="group" aria-label="References">
        ${refs.map((r, i) => `<button type="button" class="pb-ref" data-pt="ref" data-n="${i + 1}" title="Insert <Picture ${i + 1}>"><img src="${esc(r.url)}" alt=""><span>${i + 1}</span></button>`).join("")}
        ${arefs.map((a, i) => `<button type="button" class="pb-chip" data-pt="aref" data-n="${i + 1}" title="Insert <Audio ${i + 1}> (${esc(a.name || "")})">🔊 ${i + 1}</button>`).join("")}
        ${refs.length || arefs.length ? "" : `<span class="pb-hint">No references yet</span>`}
        <button type="button" class="link" data-pt="add-ref" title="Add reference pictures${mk === "video:h3ref" ? " and voices" : ""} (Inputs step)">+ Reference</button>
      </div>` : ""}
      <div class="pb-group" role="group" aria-label="Prompt tags" title="Named values this prompt uses as <name> or {{name}}. A tag with several values gives one at random.">
        ${names.map(n => { const v = tags[n], many = Array.isArray(v);
          return `<span class="pt-chip" data-tag="${esc(n)}"><button type="button" class="pt-ins" data-pt="insert" title="Insert <${esc(n)}> at the cursor">&lt;${esc(n)}&gt;</button><button type="button" class="pt-val" data-pt="edit" title="Edit">${many ? `🎲 ${v.length}` : esc(String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 28)) || "…"}</button></span>`; }).join("")}
        <button type="button" class="link" data-pt="add">+ Tag</button>
        <button type="button" class="link" data-pt="presets" title="Pick ready-made words: hair, outfits, lighting, camera…">🏷 Presets</button>
      </div>
      <div class="pb-group"><button type="button" class="link" data-pt="from-catalog" title="Insert a saved prompt's text (and its tags) at the cursor">📚 Insert saved…</button></div>`;
  }
  // The textarea keeps its caret while focus is elsewhere; insert there and tell the live view.
  function insertText(text) {
    insertAtCursor(ta(), text);
    ta().dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* Insert from the catalog: a saved prompt's text at the cursor, its tags added to this prompt's
     (a tag of the same name already here is kept). */
  async function insertSaved() {
    try { await load(true); } catch (e) { Media.toast(`Catalog: ${e.message}`); return; }
    const box = document.createElement("div");
    box.className = "pp";
    const mk = modelKey();
    const draw = q => {
      const ql = q.toLowerCase();
      const list = S.entries.filter(e => !ql || e.title.toLowerCase().includes(ql) || e.prompt.toLowerCase().includes(ql))
        .sort((a, b) => (b.model === mk) - (a.model === mk));
      $(".pp-list", box).innerHTML = list.length ? list.map(e => `<div class="ps-item" data-id="${esc(e.id)}">
          <div class="ps-text"><b>${esc(e.title)}</b><small>${esc(modelLabel(e.model))}${Object.keys(e.tags || {}).length ? ` · ${Object.keys(e.tags).length} tag(s)` : ""} · ${esc(e.prompt.replace(/\s+/g, " ").slice(0, 80))}</small></div>
          <button type="button" class="btn sm" data-a="text" title="Insert the text at the cursor (and add its tags)">Insert</button>
          ${Object.keys(e.tags || {}).length ? `<button type="button" class="btn sm ghost" data-a="tags" title="Add only its tags">Tags</button>` : ""}
        </div>`).join("") : `<p class="hint">${S.entries.length ? "Nothing matches." : "The catalog is empty: save a prompt from 📚 Catalog first."}</p>`;
    };
    box.innerHTML = `<input type="search" class="pp-q" placeholder="Search saved prompts" aria-label="Search saved prompts"><div class="pp-list"></div>`;
    const w = WM.open({ id: "prompt-insert", title: "Insert a saved prompt", content: box, width: 480, height: 520, modal: false });
    draw("");
    $(".pp-q", box).addEventListener("input", e => draw(e.target.value.trim()));
    box.addEventListener("click", e => {
      const a = e.target.closest("[data-a]")?.dataset.a, id = e.target.closest("[data-id]")?.dataset.id;
      const entry = S.entries.find(x => x.id === id);
      if (!a || !entry) return;
      const tags = state.promptTags ||= {};
      const added = [], kept = [];
      for (const [k, v] of Object.entries(entry.tags || {})) {
        if (!(k in tags)) { tags[k] = structuredClone(v); added.push(k); }
        else if (JSON.stringify(tags[k]) !== JSON.stringify(v)) kept.push(k);
      }
      if (a === "text") insertText(entry.prompt);
      afterTags();
      Media.toast([a === "text" ? `Inserted “${entry.title}”` : "", added.length ? `added tag${added.length === 1 ? "" : "s"} ${added.map(n => `<${n}>`).join(", ")}` : "",
        kept.length ? `kept your own ${kept.map(n => `<${n}>`).join(", ")}` : ""].filter(Boolean).join("; ") || "Its tags are already here.");
      if (a === "text") w.close();
    });
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
      if (a === "dur") {
        const sec = $("#seconds"); sec.value = e.target.closest("[data-s]").dataset.s;
        sec.dispatchEvent(new Event("input", { bubbles: true }));
        Media.toast(`Duration set to ${sec.value} s.`);
      }
    });
    $("#prompt-live").addEventListener("change", e => {
      const a = e.target.dataset.pl;
      if (a === "tidy") { S.tidy = e.target.checked; lsSet(TIDY_KEY, S.tidy); renderLive(); }
      if (a === "live") { S.live = e.target.checked; lsSet(LIVE_KEY, S.live); if (!S.live) dismiss(); else { S.lastAsked = ""; onInput(); } }
      if (a === "model") {
        S.liveModel = e.target.value; S.usedModel = ""; S.warmAt = 0;
        try { localStorage.setItem(MODEL_KEY, S.liveModel); } catch {}
        dismiss(false); S.lastAsked = ""; onInput();
      }
    });
    const bar = $("#prompt-bar");
    bar.addEventListener("mousedown", e => { if (e.target.closest("button")) e.preventDefault(); });  // keep the caret in the prompt
    bar.addEventListener("click", e => {
      const el = e.target.closest("[data-pt]"), a = el?.dataset.pt, name = e.target.closest("[data-tag]")?.dataset.tag;
      if (a === "add") editTag();
      if (a === "edit") editTag(name);
      if (a === "presets") presetsWin();
      if (a === "insert") insertText(`<${name}>`);
      if (a === "ref") insertText(`<Picture ${el.dataset.n}>`);
      if (a === "aref") insertText(`<Audio ${el.dataset.n}>`);
      if (a === "add-ref") showStep("inputs");
      if (a === "from-catalog") insertSaved();
    });
    $$("#prompt-mode button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.m)));
    $("#pw-dur").addEventListener("click", e => {
      const b = e.target.closest('[data-pl="dur"]'); if (!b) return;
      const sec = $("#seconds"); sec.value = b.dataset.s;
      sec.dispatchEvent(new Event("input", { bubbles: true }));
      postContext(true);  // the Shot writer's Duration follows
      Media.toast(`Duration set to ${sec.value} s.`);
    });
    $("#btn-catalog").onclick = catalog;
    $("#seconds").addEventListener("input", () => renderLive());  // H3 checks depend on the clip length
    load().then(renderLive).catch(() => {});
    renderTags(); renderLive();
  }
  /* The Prompt tab writes the prompt as text (with the live view) or with the Shot writer (H3 models): the
     writer page in a frame, which keeps the prompt in step as you build the shot list. */
  const MODE_KEY = "bob.prompt.mode";
  let writerOk = false;
  const wantMode = () => { try { return localStorage.getItem(MODE_KEY) || "text"; } catch { return "text"; } };
  function setMode(m, persist = true) {
    const writerOn = m === "writer" && writerOk;
    const step = $('.step[data-step="prompt"]');
    step.classList.toggle("writer-mode", writerOn);
    $("#prompt-writer").hidden = !writerOn;
    $$("#prompt-mode button").forEach(b => { const on = b.dataset.m === (writerOn ? "writer" : "text"); b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
    if (writerOn) {
      dismiss(false);
      const f = $("#prompt-writer-frame");
      if (!f.getAttribute("src")) f.src = "/writer?embed=1&inline=1";  // loaded the first time it's shown
      else postContext(true);
    } else renderLive();
    if (persist && writerOk) { try { localStorage.setItem(MODE_KEY, writerOn ? "writer" : "text"); } catch {} }
    if (typeof syncSideWidth === "function") syncSideWidth();  // the Shot writer gets a wider side panel
  }
  function writerAvailable(ok) {
    writerOk = ok;
    $("#prompt-mode").hidden = !ok;
    setMode(ok ? wantMode() : "text", false);
  }
  function toggleWriter() {
    if (!writerOk) { Media.toast("The Shot writer is for the MiniMax H3 models."); return; }
    showStep("prompt");
    setMode($('.step[data-step="prompt"]').classList.contains("writer-mode") ? "text" : "writer");
  }

  // The model, the prompt or the tags changed from outside (model pick, project load, Reuse…).
  function refresh() {
    if (S.sug && S.sug.model !== modelKey()) dismiss(false);
    S.lastAsked = "";
    renderTags(); renderLive();
  }

  return { init, refresh, resolve, shape, final, hasSyntax, catalog, presetsWin, accept, dismiss, profile,
    renderBar: () => renderTags(), setMode, toggleWriter, writerAvailable, _S: S };
})();
