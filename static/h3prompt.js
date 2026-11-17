/* H3 prompt assembly, mirrored from app/llm.py (assemble, clean_dialogue, ...) so the
   Prompt Writer can rebuild the prompt on every keystroke without a server round trip.
   Keep the two in step: tests/h3prompt_parity.mjs compares them. */
"use strict";

(function (root) {
  const FPS = 24;
  const FRAMINGS = ["extreme close-up", "close-up", "medium close-up", "medium shot", "full shot", "wide shot",
    "extreme wide shot"];
  // Where the camera is, as cinematographers say it: H3 follows "Low-angle wide shot" and "The camera is behind
  // her at shoulder height and tracks her" far more reliably than a bare move with no position.
  const ANGLES = ["eye level", "low angle", "high angle", "overhead", "ground level", "over the shoulder", "point of view",
    "dutch angle"];
  const ANGLE_ADJ = { "eye level": "eye-level", "low angle": "low-angle", "high angle": "high-angle", "overhead": "overhead top-down",
    "ground level": "ground-level", "over the shoulder": "over-the-shoulder", "point of view": "point-of-view", "dutch angle": "dutch-angle" };
  const LIMITS = { style: 35, setting: 30, action: 45, position: 14, camera: 16, soundscape: 70, music: 30 };
  const NEGATION = /\b(no|not|never|without|don't|doesn't|isn't|aren't|nothing|nobody|none|neither|nor)\b/i;
  const FILLER = /\b(masterpiece|best quality|8k|4k|ultra[- ]?hd|hdr|highly detailed|trending|award[- ]winning)\b/i;

  // Python's round() rounds half to even; Math.round rounds half up.
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  function h3Length(seconds) {
    const a = Math.max(5, pyRound(seconds * FPS));
    return a + ((5 - (a % 17)) % 17 + 17) % 17;
  }
  function autoShots(seconds) { return Math.max(1, Math.min(5, pyRound(seconds / 3.5))); }
  function shotTimes(frames, n) {
    const total = frames / FPS, out = [];
    for (let k = 0; k < n; k++) out.push(pyRound(k * total / n * FPS) / FPS);
    return out;
  }
  function dialogueBudget(seconds) { return Math.max(2, Math.floor(seconds * 2.5)); }
  function fmtTime(t) {
    const m = Math.floor(t / 60), s = t % 60;
    return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  }
  const words = s => (s || "").split(/\s+/).filter(Boolean).length;

  function sentence(s) {
    s = (s || "").trim().replace(/^"+|"+$/g, "").trim();
    if (!s) return s;
    s = s[0].toUpperCase() + s.slice(1);
    return /[.!?]$/.test(s) ? s : s + ".";
  }
  function cleanDialogue(line, budget) {
    line = (line || "").trim().replace(/^"+|"+$/g, "");
    line = line.replace(/[^\x00-ɏ‘-‟…]+.*/, "").trim();
    let out = [];
    for (const w of line.split(/\s+/).filter(Boolean)) {
      out.push(w);
      let rep = 0;
      for (let k = 2; k <= 6; k++) {
        if (out.length >= 2 * k && out.slice(-k).join(" ") === out.slice(-2 * k, -k).join(" ")) { rep = k; break; }
      }
      if (rep) { out = out.slice(0, -rep); break; }
    }
    return out.slice(0, budget).join(" ").replace(/[,;:\-—… ]+$/, "");
  }
  function cameraText(s) {
    s = (s || "").trim().replace(/^(the\s+)?camera\s+/i, "").replace(/\.+$/, "");
    return s;
  }
  const capitalize = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
  // "low angle" + "wide shot" -> "low-angle wide shot"; an angle the list doesn't know is used as written.
  function angleText(a) {
    a = (a || "").trim().toLowerCase().replace(/\.+$/, "");
    return ANGLE_ADJ[a] || a;
  }
  function shotHead(angle, framing) {
    const a = angleText(angle), f = (framing || "").trim();
    return a && f ? `${a} ${f}` : a || f;
  }
  // "behind her, at shoulder height" -> "is behind her, at shoulder height and " (before the move).
  function positionText(s) {
    s = (s || "").trim().replace(/^(the\s+)?camera\s+/i, "").replace(/^(is|sits|stands|stays|placed|positioned)\s+/i, "").replace(/[.,;]+$/, "");
    return s;
  }

  /* Build the prompt as segments {text, key}. key is null for H3 template text, or the
     field it came from ("style", "shots.2.action", ...). A segment with hole:true marks an
     empty field: shown in the preview, left out of the text. */
  // ", in the voice of <Audio N>": the first person tagged in the action who has a voice recording.
  function voiceOf(action, voices) {
    for (const m of String(action || "").matchAll(/<Picture (\d+)>/g)) if (+m[1] >= 1 && +m[1] <= voices) return `, in the voice of <Audio ${m[1]}>`;
    return "";
  }
  function assemble(data, mode, n, frames, voices = 0) {
    const seg = [];
    const tpl = text => seg.push({ text, key: null });
    const fld = (key, text) => text ? seg.push({ text, key }) : seg.push({ text: `‹${key.split(".").pop()}›`, key, hole: true });
    const opt = (key, text) => text && seg.push({ text, key });  // optional field: nothing when empty
    const shots = (data.shots || []).slice(0, n);

    if (mode === "sound") {
      tpl("overall_soundscape: "); fld("soundscape", sentence(data.soundscape));
      tpl("\nnon_diegetic_music: "); fld("music", (data.music || "").trim() || "N/A");
      return seg;
    }
    fld("style", sentence(data.style));
    if (mode === "still") {
      const s = shots[0] || {};
      tpl("\n\n");
      if (s.angle) { opt("shots.1.angle", capitalize(angleText(s.angle))); tpl(" "); fld("shots.1.framing", (s.framing || "").toLowerCase()); }
      else fld("shots.1.framing", capitalize(s.framing || ""));
      tpl(". ");
      fld("shots.1.setting", sentence(s.setting)); tpl(" ");
      fld("shots.1.action", sentence(s.action));
      const pos = positionText(s.position);
      if (pos) { tpl(" The camera is "); opt("shots.1.position", pos); tpl(" and holds a static shot."); }
      else tpl(" The camera holds a static shot.");
      return seg;
    }
    const times = shotTimes(frames, shots.length).concat([frames / FPS]);
    tpl("\n");
    shots.forEach((s, k) => {
      const i = k + 1;
      tpl(`\n[Shot ${i}] `);
      let framing = s.framing || "", angle = angleText(s.angle);
      if (k > 0) tpl(`At ${fmtTime(times[k])}, `);
      else if (angle) angle = angle[0].toUpperCase() + angle.slice(1);
      else framing = framing ? framing[0].toUpperCase() + framing.slice(1) : framing;
      if (angle) { opt(`shots.${i}.angle`, angle); tpl(" "); }
      fld(`shots.${i}.framing`, framing); tpl(". ");
      fld(`shots.${i}.setting`, sentence(s.setting)); tpl(" ");
      fld(`shots.${i}.action`, sentence(s.action));
      const line = cleanDialogue(s.dialogue || "", dialogueBudget(times[k + 1] - times[k]));
      if (line) { tpl(` They say${mode === "ref" ? voiceOf(s.action, voices) : ""}: <d>[English] `); fld(`shots.${i}.dialogue`, line); tpl("</d>"); }
      const pos = positionText(s.position);
      if (pos) { tpl(" The camera is "); opt(`shots.${i}.position`, pos); tpl(" and "); }
      else tpl(" The camera ");
      fld(`shots.${i}.camera`, cameraText(s.camera)); tpl(".");
    });
    tpl("\n\noverall_soundscape: "); fld("soundscape", sentence(data.soundscape));
    tpl("\nnon_diegetic_music: "); fld("music", (data.music || "").trim() || "N/A");
    return seg;
  }

  function toText(segments) {
    return segments.filter(s => !s.hole).map(s => s.text).join("").replace(/ {2,}/g, " ");
  }

  /* Live checks, the same rules the server's validator applies. */
  function check(data, mode, n, frames, pictures) {
    const out = [];
    const add = (key, msg) => out.push({ key, msg });
    const field = (key, label, text, limit) => {
      if (!text || !text.trim()) return add(key, `${label} is empty`);
      const neg = text.match(NEGATION);
      if (neg && !key.endsWith("dialogue")) add(key, `${label} uses a negation (“${neg[0]}”); H3 has no negative prompt`);
      const fill = text.match(FILLER);
      if (fill) add(key, `${label} uses filler (“${fill[0]}”)`);
      if (limit && words(text) > LIMITS[limit]) add(key, `${label} has ${words(text)} words; keep it under ${LIMITS[limit]}`);
    };
    if (mode === "sound") { field("soundscape", "Soundscape", data.soundscape, "soundscape"); return out; }
    field("style", "Style", data.style, "style");
    const shots = (data.shots || []).slice(0, n);
    shots.forEach((s, k) => {
      const i = k + 1;
      if (!s.framing) add(`shots.${i}.framing`, `Shot ${i} framing is empty`);
      field(`shots.${i}.setting`, `Shot ${i} setting`, s.setting, "setting");
      field(`shots.${i}.action`, `Shot ${i} action`, s.action, "action");
      if (mode !== "still") field(`shots.${i}.camera`, `Shot ${i} camera move`, s.camera, "camera");
      if (s.position && words(s.position) > LIMITS.position) add(`shots.${i}.position`, `Shot ${i} camera position has ${words(s.position)} words; keep it under ${LIMITS.position}`);
      const pneg = (s.position || "").match(NEGATION);
      if (pneg) add(`shots.${i}.position`, `Shot ${i} camera position uses a negation (“${pneg[0]}”); H3 has no negative prompt`);
    });
    if (mode !== "still") {
      const times = shotTimes(frames, shots.length).concat([frames / FPS]);
      shots.forEach((s, k) => {
        const budget = dialogueBudget(times[k + 1] - times[k]), w = words(s.dialogue);
        if (w > budget) add(`shots.${k + 1}.dialogue`, `Shot ${k + 1} line has ${w} words; about ${budget} fit, the rest is cut`);
      });
      field("soundscape", "Soundscape", data.soundscape, "soundscape");
    }
    if (mode === "ref" && pictures) {
      const used = new Set();
      shots.forEach(s => ["setting", "action"].forEach(f => {
        for (const m of (s[f] || "").matchAll(/<Picture (\d+)>/g)) used.add(+m[1]);
      }));
      const bad = [...used].filter(t => t < 1 || t > pictures);
      if (bad.length) add(null, `${bad.map(t => `<Picture ${t}>`).join(", ")} doesn't exist; there are ${pictures} picture(s)`);
      const unused = [];
      for (let t = 1; t <= pictures; t++) if (!used.has(t)) unused.push(`<Picture ${t}>`);
      if (unused.length) add(null, `${unused.join(", ")} isn't used in any shot`);
    }
    return out;
  }

  root.H3Prompt = { FPS, FRAMINGS, ANGLES, angleText, shotHead, positionText, LIMITS, h3Length, autoShots, shotTimes, fmtTime, dialogueBudget, sentence,
    cleanDialogue, cameraText, assemble, toText, check };
})(typeof window !== "undefined" ? window : globalThis);
