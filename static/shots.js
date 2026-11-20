/* Shots: the Shots step, where every H3 video is planned (H3 and H3 Reference; the Prompt step is for pictures
   and sound). The step lists the shots as compact blocks: drag one by its handle to reorder, ⋯ for Edit, Move,
   Duplicate and Delete, double-click to edit. Edit opens a large window with everything about that shot: its
   length, framing, angle, camera position and move, where and what happens, a spoken line and voice, its inputs
   (first / last frame, or which reference pictures), ✨ AI help for this shot, its own generation settings, a
   title and notes, and the exact prompt it sends.

   Two ways to make video from the list, chosen in the step:
   - each (the default): one generation per shot; with several shots the results go on the timeline in order;
   - multi: one generation whose prompt is H3's multi-shot format ([Shot 1] ... [Shot 2] At 00:03.000, ...).

   A shot's first frame falls back to the Inputs step's first frame for shot 1, and its last frame to the Inputs
   step's last frame for the last shot. A shot can also carry its own prompt ("Write the prompt myself").

   state.shots = {v: 2, mode, style, soundscape, music, idea, ideaShots, ideaSeconds, creativity, list: [shot]},
   saved with the project settings. Older projects (Use shots off, the prompt on the Prompt step) become one
   shot whose own prompt is that prompt. */
"use strict";

const Shots = (() => {
  const P = () => window.H3Prompt;
  const V = 2;
  const FIELDS = ["framing", "angle", "setting", "action", "position", "camera", "dialogue"];
  const EXTRA_FRAMINGS = ["over-the-shoulder shot", "point-of-view shot", "insert shot"];
  const CREAT_NAMES = [[15, "Literal"], [40, "Faithful"], [65, "Enhanced"], [85, "Bold"], [100, "Wild"]];
  const creatName = p => CREAT_NAMES.find(([top]) => p <= top)[1];
  const uid = () => Math.random().toString(16).slice(2, 10);
  const blank = (seconds = 5) => ({ id: uid(), title: "", notes: "", brief: "", raw: "", rawOn: false, seconds,
    framing: "medium shot", angle: "", setting: "", action: "", position: "", camera: "holds a static shot", dialogue: "", voice: "", speaker: "" });
  const isVideo = () => state.kind === "video";
  const isRef = () => state.engine.video === "h3ref";
  /* MiniMax H3 Image plans its pictures here too: one picture per shot, from the shot's framing, angle, camera
     position, place and subject (no length, camera move or spoken line), with the Inputs step's reference pictures
     as <Picture N>. A shot mapped to a 3D scene is a photo of what the scene's shot camera sees (Scene3D.photoForShot). */
  const isImg = () => state.kind === "image" && state.engine.image === "h3image";
  const picRefs = () => isRef() || isImg();  // the shots name the Inputs step's reference pictures as <Picture N>
  const keyframes = () => isVideo() && !isRef();  // the Inputs step's first and last frame
  const modeOf = () => isImg() ? "each" : state.shots?.mode;  // pictures: always one per shot
  // A list is usable once ensure() has upgraded it; while a project loads (state.loading) it may still be the old shape.
  const upgraded = () => state.shots?.v === V && Array.isArray(state.shots.list);
  const on = () => (isVideo() || isImg()) && upgraded() && state.shots.list.length > 0;
  const total = () => state.shots.list.reduce((a, s) => a + (+s.seconds || 0), 0);
  const fmtT = t => P()?.fmtTime(t) || t.toFixed(2);
  const clampSec = v => Math.max(1, Math.min(15, Math.round((+v || 1) * 2) / 2));
  const str = v => typeof v === "string" ? v.trim() : "";
  const hasContent = s => !!(s.scene || (s.rawOn && str(s.raw)) || str(s.setting) || str(s.action) || str(s.dialogue));
  const settingsSeconds = () => { const v = +document.getElementById("seconds")?.value; return v >= 1 && v <= 15 ? v : 5; };

  /* ---------------------------------------------------------------- state */
  function normShot(x) {
    const s = { ...blank(), ...(x && typeof x === "object" ? x : {}) };
    s.id = s.id || uid();
    s.seconds = clampSec(s.seconds);
    for (const k of ["title", "notes", "brief", "raw", ...FIELDS, "voice", "speaker"]) s[k] = typeof s[k] === "string" ? s[k] : "";
    s.framing ||= "medium shot"; s.camera ||= "holds a static shot";
    s.rawOn = !!s.rawOn;
    s.join = s.join === "continue" ? "continue" : "cut";  // from the shot before: a cut, or the same shot carrying on
    // Objects in motion (static/motion.js): {picture: {ref, url, name}, plate, hold, layers: [{name, mask, keys}]}
    s.motion = s.motion && typeof s.motion === "object" && s.motion.picture?.ref && Array.isArray(s.motion.layers) ? s.motion : null;
    // A 3D scene's render (static/scene3d.js, 🎬 Render › Goes to a shot): {id, name, thumb, seconds, what, cam,
    // req: {motion_video, motion_video_mask, first_frame, motion_first, motion_hold, quality, references}}
    s.scene = s.scene && typeof s.scene === "object" && s.scene.req?.motion_video && s.scene.req.first_frame ? s.scene : null;
    // The 3D scene this shot is mapped to (made from it, or picked for it), rendered into it yet or not: {id, name,
    // thumb}. The scene's 🎬 Render goes to this shot, with this shot's text, unless told otherwise.
    s.sceneLink = s.sceneLink && typeof s.sceneLink === "object" && typeof s.sceneLink.id === "string" && s.sceneLink.id ? s.sceneLink
      : s.scene?.id ? { id: s.scene.id, name: s.scene.name || "3D scene", thumb: s.scene.thumb || "" } : null;
    // Shots no longer carry their own frames, picture choice or settings (the Inputs and Settings steps hold them).
    for (const k of ["first_frame", "last_frame", "refs", "over"]) delete s[k];
    return s;
  }
  /* Make state.shots a v2 shot list. `prompt`: the project's Prompt-step text, kept as shot 1's own prompt when an
     older project made its videos from the Prompt step. */
  const checked = new WeakSet();  // lists already normalized (a loaded file may lack fields)
  function ensure(prompt = null) {
    const old = state.shots;
    if (old?.v === V && Array.isArray(old.list)) {
      if (!checked.has(old.list)) {
        old.list = old.list.filter(x => x && typeof x === "object").map(normShot);
        old.mode = old.mode === "multi" ? "multi" : "each";
        if (typeof old.subjectsOn !== "boolean") old.subjectsOn = true;
        checked.add(old.list);
      }
      if (!old.list.length) old.list.push(blank(settingsSeconds()));
      return old;
    }
    const sh = { v: V, mode: "each", style: "", soundscape: "", music: "", idea: "", ideaShots: "", ideaSeconds: 10, creativity: 50, subjectsOn: true, list: [] };
    if (old && Array.isArray(old.list) && old.on) {
      Object.assign(sh, { mode: old.mode === "multi" ? "multi" : "each", style: old.style || "", soundscape: old.soundscape || "", music: old.music || "" });
      sh.list = old.list.map(normShot);
    }
    const text = (prompt ?? document.getElementById("prompt")?.value ?? "").trim();
    if (!sh.list.length) {
      const s = blank(settingsSeconds());
      if (text && (isVideo() || isImg())) Object.assign(s, { raw: text, rawOn: true, title: "From the Prompt step" });
      sh.list.push(s);
    }
    checked.add(sh.list);
    state.shots = sh;
    return sh;
  }

  /* ---------------------------------------------------------------- prompts */
  // Who says the spoken line (H3 Reference): "<Picture N>", or "" for anyone. Ignored once that picture is gone.
  const speakerOf = s => {
    const m = /^<Picture (\d+)>$/.exec(s.speaker || "");
    return isRef() && m && +m[1] >= 1 && +m[1] <= state.refs.length ? s.speaker : "";
  };
  // The voice: the one chosen, else the speaker's own recording (<Audio N> goes with <Picture N>).
  function voiceFor(s) {
    if (s.voice) return s.voice;
    const m = /^<Picture (\d+)>$/.exec(speakerOf(s));
    return m && +m[1] <= state.arefs.length ? `<Audio ${m[1]}>` : "";
  }
  /* The voice recordings a video actually uses (1-based, in order): each spoken line's voice, and any <Audio N> written
     in its shots or in the look, sound and music. Only these go to H3, renumbered <Audio 1>, <Audio 2>… With every
     recording attached, H3 tends to give a lone speaker the first voice (MiniMax's guide: similar voices can merge into
     one timbre), so a video where only <Picture 2> speaks got <Audio 1>'s voice. A shot with its own prompt keeps all. */
  function audiosFor(list) {
    const n = state.arefs.length;
    if (!isRef() || !n) return [];
    if (list.some(s => s.rawOn && s.raw.trim())) return state.arefs.map((_, k) => k + 1);
    const used = new Set();
    const cite = t => { for (const m of String(t || "").matchAll(/<Audio (\d+)>/g)) if (+m[1] >= 1 && +m[1] <= n) used.add(+m[1]); };
    for (const s of list) {
      if ((s.dialogue || "").trim()) cite(voiceFor(s));
      cite([s.setting, s.action, s.dialogue].join(" "));
    }
    const sh = state.shots; cite([sh.style, sh.soundscape, sh.music].join(" "));
    // Nothing to say and nothing else to send: keep them all rather than send H3 no references at all.
    if (!used.size && !state.refs.length) return state.arefs.map((_, k) => k + 1);
    return [...used].sort((a, b) => a - b);
  }
  /* The prompt follows MiniMax's Video Prompt Writing Guide (a copy ships with ComfyUI-Fantastic-MiniMaxH3-PromptBuilder):
     - H3 (text / keyframes): integrated_multimodal_description: [Shot 1] <style> <shot> [Shot 2] At …, then
       overall_soundscape: and non_diegetic_music: (the server adds the keyframe line in front, workflows.h3_frame_alignment);
     - H3 Reference (full-reference mode): six sections, subject_definitions, summary, retention_analysis,
       integrated_multimodal_description (the guide names it detailed_description here), overall_soundscape, non_diegetic_music. Each reference picture is a <Subject N> (the
       picture defines a person, object or place; it isn't a frame), each voice recording an <Audio N> voice-timbre
       reference, and whoever speaks gets a stable speaker ID (S1), (S2)… in order of first speaking.
     In a shot's fields people are tagged as <Picture N>; in reference mode those become <Subject N>. */
  /* Prompt syntax in the fields (Where, What happens, Spoken line), as on the Prompt step: this prompt's own tags
     (<hero>), {a|b} choices (weights as {2::a|b}), <list>, <maybe> and preset lists. The preview rolls with the
     Prompt step's preview seed (🎲 re-roll there); each Generate rolls afresh, once for all its shots, so a tag used in
     two shots picks the same thing. <Picture N>, <Audio N> and <Subject N> are H3's own and pass through. */
  let rollSeed = null;
  // Every shot's three fields go through ONE resolve, joined by a separator, so a tag is rolled once for the whole video
  // (the same <pet> in every shot and line) while each {a|b} gets its own roll.
  const RS = "\u001e", RF = ["setting", "action", "dialogue"];
  function resolveShots(all) {
    const parts = all.flatMap(s => RF.map(f => (s.rawOn ? "" : String(s[f] || "")).replaceAll(RS, " ")));
    const joined = parts.join(RS);
    if (typeof Prompts === "undefined" || !Prompts.hasSyntax(joined)) return all;
    const out = Prompts.resolve(joined, rollSeed == null ? {} : { seed: rollSeed }).split(RS);
    if (out.length !== parts.length) return all;  // a choice spanned two fields: leave them as written
    return all.map((s, i) => s.rawOn ? s : { ...s, setting: out[i * 3], action: out[i * 3 + 1], dialogue: out[i * 3 + 2] });
  }
  const resolveText = t => t;  // fields arrive resolved (resolveShots)
  const subj = t => isRef() ? String(t || "").replace(/<Picture (\d+)>/g, "<Subject $1>") : String(t || "");
  // Speaker IDs in order of first speaking: a picked speaker (one subject) keeps one ID; an unnamed one gets its own per shot.
  function speakerIds() {
    const ids = new Map();
    state.shots.list.forEach((s, k) => {
      if (s.rawOn || !(s.dialogue || "").trim()) return;
      const key = speakerOf(s) || `shot${k}`;
      if (!ids.has(key)) ids.set(key, ids.size + 1);
    });
    return ids;
  }
  const speakerKey = (s, k) => speakerOf(s) || `shot${k}`;
  function shotText(s, k, start, n, ids = speakerIds()) {
    const H = P();
    if (s.rawOn && s.raw.trim()) {  // its own prompt, as one shot's description inside the multi-shot format
      const body = subj(s.raw.trim().replace(/\s*\n+\s*/g, " "));
      return k > 0 && n > 1 ? `At ${fmtT(start)}, ${body}` : body;
    }
    // "Low-angle wide shot." and "The camera is behind her at shoulder height and tracks her": a stated angle and
    // position steer H3's camera far better than a move alone (both are optional).
    const framing = H.shotHead(s.angle, (s.framing || "medium shot").trim());
    const head = k > 0 && n > 1 ? `At ${fmtT(start)}, ${framing}` : framing[0].toUpperCase() + framing.slice(1);
    const parts = [`${head}.`];
    const setting = resolveText(s.setting).trim(), action = resolveText(s.action).trim();
    if (setting) parts.push(H.sentence(subj(setting)));
    if (action) parts.push(H.sentence(subj(action)));
    const line = H.cleanDialogue(resolveText(s.dialogue), H.dialogueBudget(+s.seconds || 3));
    if (line) {
      const sid = ids.get(speakerKey(s, k)), v = voiceFor(s);
      const who = speakerOf(s) ? subj(s.speaker) : "The speaker";
      const voice = v ? (isRef() ? `, using the voice timbre referenced from ${v}` : `, in the voice of ${v}`) : "";
      parts.push(`${who}${sid ? ` (S${sid})` : ""} says${voice}: <d>[English] ${line}</d>`);
    }
    const pos = H.positionText(s.position);
    parts.push(`The camera ${pos ? `is ${pos} and ` : ""}${H.cameraText(s.camera || "holds a static shot")}.`);
    return parts.join(" ");
  }
  // The two audio fields; `sep` is what follows each label (" " in base mode, a new line in full-reference mode).
  function audioFields(sep = " ") {
    const sh = state.shots, H = P();
    return `overall_soundscape:${sep}${H.sentence(sh.soundscape || "") || "Natural ambient sound of the scene."}\n\nnon_diegetic_music:${sep}${(sh.music || "").trim() || "N/A"}`;
  }
  /* Subject definitions: each reference picture's subject, in detail (Describe with AI, kept as refs[].desc), so H3
     keeps it accurate in every shot. */
  const subjectsWanted = () => isRef() && state.shots?.subjectsOn !== false && state.refs.length > 0;
  const missingSubjects = () => subjectsWanted() ? state.refs.map((r, k) => (r.desc || "").trim() ? -1 : k).filter(k => k >= 0) : [];
  const oneLine = t => String(t || "").trim().replace(/\s*\n+\s*/g, " ").replace(/\.\s*$/, "");
  // The shots (indexes into `list`) that show <Subject N> (tagged in the text, or speaking). When no shot tags any
  // subject, every subject is taken to be in every shot; when others are tagged and this one isn't, it's in none.
  const shotTags = s => [s.setting, s.action, s.speaker, s.rawOn ? s.raw : ""].join(" ");
  function appearsIn(n, list) {
    const tag = new RegExp(`<(?:Picture|Subject) ${n}>`);
    const hits = list.map((s, k) => [s, k]).filter(([s]) => tag.test(shotTags(s))).map(([, k]) => k);
    if (hits.length) return hits;
    return list.some(s => /<(?:Picture|Subject) \d+>/.test(shotTags(s))) ? [] : list.map((_, k) => k);
  }
  /* The full-reference prompt for `list` (the shots in this video: one, or all of them in a multi-shot video); shot
     numbers and speaker IDs follow that video. */
  /* Continuity (one video per shot, H3 Reference): from shot 2 on, the last frame of the shot before goes to H3 as one
     more, hidden picture, after the Inputs' pictures so their numbers stay (cont = {pic: its <Picture N>, prev: the
     shot before, setting: the place carried forward}). Following MiniMax's guide, a picture that only sets the scene is
     defined as a <Subject N> rather than a picture entry. It is cited in the shot itself as well, because H3 shows a
     reference only when the text asks for it (EDITS-WITH-AI's measurements), and the previous shot's action goes in the
     summary so the story carries on. */
  function refPrompt(list, style, cont = null) {
    const H = P(), ids = new Map();
    if (cont?.setting && list[0] && !list[0].rawOn && !(list[0].setting || "").trim()) list = [{ ...list[0], setting: cont.setting }, ...list.slice(1)];
    list.forEach((s, k) => { if (!s.rawOn && (s.dialogue || "").trim() && !ids.has(speakerKey(s, k))) ids.set(speakerKey(s, k), ids.size + 1); });
    const n = list.length, T = list.reduce((a, s) => a + (+s.seconds || 0), 0);
    const pics = state.refs.map((r, k) => k + 1), voices = audiosFor(list);  // labels are renumbered at the end
    // subject_definitions
    const defs = pics.map(p => {
      const d = subjectsWanted() ? oneLine(state.refs[p - 1].desc) : "";
      return d ? `<Subject ${p}> is the subject of <Picture ${p}>: ${d.charAt(0).toLowerCase() + d.slice(1)}.`
        : `<Subject ${p}> is the main subject of <Picture ${p}>, kept exactly as it appears there.`;
    });
    const K = cont?.pic, seamless = !!(K && cont.seamless);
    /* Continuing without a cut, the shot's own framing and angle still count: the camera travels to them inside the
       same take (from the previous shot's framing and angle), so the story keeps moving instead of freezing on the
       old view. H3 follows a framing over a camera move when the two disagree (EDITS-WITH-AI's notes), so the move
       is written as reaching that framing. */
    const headOf = x => P().shotHead(x?.angle, (x?.framing || "medium shot").trim());
    const toHead = seamless ? headOf(list[0]) : "", fromHead = seamless && cont.prev && !cont.prev.rawOn ? headOf(cont.prev) : "";
    const reframes = seamless && !!fromHead && fromHead !== toHead;
    if (seamless) defs.push(`<Picture ${K}> is the first frame of [Shot 1]: the last frame of the shot so far, which carries on here without a cut, `
      + "with the same people in the same clothes, in the same place and light"
      + (reframes ? `; from that ${fromHead} the camera moves on, in the same take, to a ${toHead}.` : `, seen as the same ${toHead}.`));
    else if (K) defs.push(`<Subject ${K}> is the place in <Picture ${K}>, the last frame of the previous shot: the same location, set dressing, `
      + "lighting, time of day and colour grade carry on in this shot, and the people keep the clothes, hair, make-up and props they have there.");
    // Whose voice each recording is: the subject who speaks with it in this video (a voice picked on the line),
    // else the subject with the same number.
    const owner = new Map();
    list.forEach(s => {
      const v = /^<Audio (\d+)>$/.exec((s.dialogue || "").trim() ? voiceFor(s) : ""), sp = /^<Picture (\d+)>$/.exec(speakerOf(s));
      if (v && sp && !owner.has(+v[1])) owner.set(+v[1], +sp[1]);
    });
    const ownerOf = a => owner.get(a) ?? (a <= pics.length ? a : 0);
    for (const a of voices) {
      const p = ownerOf(a), sid = p ? ids.get(`<Picture ${p}>`) : null;
      defs.push(p ? `<Audio ${a}> is the voice-timbre reference for <Subject ${p}>${sid ? ` (S${sid})` : ""}.`
        : `<Audio ${a}> is a voice-timbre reference.`);
    }
    // summary
    const tasks = ["reference generation", ...(seamless ? ["keyframe completion"] : []), ...(voices.length ? ["audio reference"] : [])];
    const who = pics.map(p => `<Subject ${p}>`);
    const whoText = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : who[0] || "the subject";
    const opening = list[0] && !list[0].rawOn ? oneLine(subj(resolveText(list[0].action))).split(/\s+/).slice(0, 40).join(" ") : "";
    const prevAction = K && cont.prev && !cont.prev.rawOn ? oneLine(subj(cont.prev.action)).split(/\s+/).slice(0, 30).join(" ") : "";
    const voiceRoles = voices.filter(a => ownerOf(a)).map(a => `<Audio ${a}> as the voice-timbre reference for <Subject ${ownerOf(a)}>`);
    const summary = `[${tasks.join(" + ")}] The target video is ${n === 1 ? "a single" : `a ${n}-shot`} ${T.toFixed(1)}-second scene with ${whoText}`
      + (voiceRoles.length ? `, using ${voiceRoles.join(" and ")}` : "") + "." + (opening ? ` It opens as ${opening.charAt(0).toLowerCase() + opening.slice(1)}.` : "")
      + (seamless ? ` It is the same shot carrying on without a cut from <Picture ${K}>${prevAction ? `, after ${prevAction.charAt(0).toLowerCase() + prevAction.slice(1)}` : ""}.`
        : K ? ` It follows straight on from the previous shot${prevAction ? `, in which ${prevAction.charAt(0).toLowerCase() + prevAction.slice(1)}` : ""}; <Picture ${K}> is that shot's last frame.` : "");
    // retention_analysis
    const retention = [
      ...pics.map(p => [p, appearsIn(p, list)]).filter(([, at]) => at.length).map(([p, at]) =>
        `<Subject ${p}> (appears in ${at.map(k => `[Shot ${k + 1}]`).join(", ")}): fully_preserved - the identity, face, hair, build and appearance from <Picture ${p}> are retained.`),
      ...(seamless ? [`<Picture ${K}> ([Shot 1] first frame): ${reframes ? "partially_preserved" : "fully_preserved"} - the shot picks up exactly where <Picture ${K}> leaves off, with the same people, clothes, place and light${reframes ? `; the camera then moves on to this shot's ${toHead}` : ""}.`]
        : K ? [`<Subject ${K}> (appears in [Shot 1]): partially_preserved - the location, lighting, time of day, colour grade and the people's clothes continue from <Picture ${K}>; the framing, camera angle and action follow this shot.`] : []),
      ...voices.map(a => `<Audio ${a}>: reference - its voice timbre ${ownerOf(a) ? `guides the delivery of <Subject ${ownerOf(a)}>` : "guides the spoken delivery"} without copying the original signal.`),
    ];
    // the main field: integrated_multimodal_description (the guide calls it detailed_description in reference mode; this studio uses the base name, by choice)
    let t = 0;
    let body = list.map((s, k) => { const txt = `[Shot ${k + 1}] ${shotText(s, k, t, n, ids)}`; t += +s.seconds || 0; return txt; }).join("\n");
    // after the framing: the text has to ask for the place, or H3 leaves the reference out
    if (seamless) {
      body = body.replace(/^\[Shot 1\] [^.]*\./, reframes
        ? `[Shot 1] The same shot carries on without a cut from <Picture ${K}>: in one smooth, continuous camera move the view goes from the ${fromHead} to a ${toHead}.`
        : `[Shot 1] The same shot carries on without a cut from <Picture ${K}>, still a ${toHead}.`);
      // the shot's own camera line comes after the move to the new framing, not instead of it
      if (reframes) body = body.replace(/ The camera (?=[^\n]*$)/m, " Once it gets there, the camera ");
    } else if (K) body = body.replace(/^(\[Shot 1\] [^.]*\.)/, `$1 It is the same place as <Subject ${K}>, in the same light, a moment later.`);
    const look = oneLine(style);
    const out = [`subject_definitions:\n${defs.join("\n")}`, `summary:\n${summary}`, `retention_analysis:\n${retention.join("\n")}`,
      `integrated_multimodal_description:\nThe target video's look: ${look.charAt(0).toLowerCase() + look.slice(1)}.\n${body}`, audioFields("\n")].join("\n\n");
    // Only the recordings this video uses are sent, in order: <Audio 2> alone becomes <Audio 1>.
    const renum = new Map(voices.map((a, k) => [a, k + 1]));
    return out.replace(/<Audio (\d+)>/g, (m, a) => renum.has(+a) ? `<Audio ${renum.get(+a)}>` : m);
  }
  function basePrompt(list, style) {
    let t = 0;
    const ids = new Map();
    list.forEach((s, k) => { if (!s.rawOn && (s.dialogue || "").trim() && !ids.has(speakerKey(s, k))) ids.set(speakerKey(s, k), ids.size + 1); });
    const body = list.map((s, k) => {
      const txt = `[Shot ${k + 1}] ${k === 0 ? `${style} ` : ""}${shotText(s, k, t, list.length, ids)}`;
      t += +s.seconds || 0; return txt;
    }).join("\n");
    return `integrated_multimodal_description: ${body}\n\n${audioFields()}`;
  }
  /* H3 Image: one shot's picture, in the order its guide gives (medium and style, subject, setting, light and camera):
     the look, the framing and angle, what's there and happening, where, and where the camera stands. */
  function stillPrompt(i) {
    const sh = state.shots, H = P(), s0 = sh.list[i];
    if (s0.rawOn && s0.raw.trim()) return Prompts.final(s0.raw);
    const s = resolveShots(sh.list)[i];
    const look = H.sentence(sh.style || "") || "A cinematic still photograph, natural light.";
    const head = H.shotHead(s.angle, (s.framing || "medium shot").trim()), pos = H.positionText(s.position);
    return [look, H.sentence(head), H.sentence(s.action), H.sentence(s.setting), pos ? `The camera is ${pos}.` : ""].filter(Boolean).join(" ");
  }
  // H3 Image, a shot mapped to a 3D scene: what it says, its place and the look, for the photo of the scene.
  function stillLook(i) {
    const s = resolveShots(state.shots.list)[i], raw = s.rawOn && s.raw.trim();
    return { text: raw ? Prompts.final(s.raw) : s.action, setting: raw ? "" : s.setting, style: state.shots.style || "" };
  }
  // One shot's own prompt (one video per shot), or the whole multi-shot prompt (only = null).
  function prompt(only = null, withCont = true) {
    if (isImg()) return only != null ? stillPrompt(only) : state.shots.list.map((_, i) => stillPrompt(i)).join("\n\n");
    const sh = state.shots, H = P();
    const style = H.sentence(sh.style || "") || "Cinematic live-action, natural light.";
    if (only != null) {
      const s = sh.list[only];
      if (sceneOn(only)) return scenePrompt(s);
      if (s.rawOn && s.raw.trim()) return Prompts.final(s.raw);  // its own prompt: tags and {a|b} resolved, tidied
    }
    const all = resolveShots(sh.list), list = only != null ? [all[only]] : all;
    if (only != null && motionOn(only)) return motionPrompt(list, style);
    if (!isRef()) return basePrompt(list, style);
    const cont = withCont && only != null && carries(only) ? { pic: contPic(), prev: all[only - 1], setting: carriedSetting(all, only), seamless: joins(only) } : null;
    return refPrompt(list, style, cont);
  }
  /* Continuity between the videos of "One video per shot" (H3 Reference, two or more shots, on by default): the shots
     render one after another, each with the last frame of the one before as a hidden reference picture. A shot with
     its own prompt doesn't take it (its text can't cite it), nor does any shot once the Inputs hold all 9 pictures. */
  /* Objects in motion (one video per shot): a shot with a motion plan renders from the plan's picture with its objects
     moving along their paths (engine "motion": H3 image-to-video with Time-to-Move, app/motion.py). Its own text,
     length and settings still make the video; it doesn't take reference pictures, voices or the last frame of the shot
     before (it starts from its own picture, so it comes after a cut). */
  const motionOn = i => !isImg() && state.shots?.mode === "each" && !!state.shots.list[i]?.motion && !(state.shots.list[i].rawOn && state.shots.list[i].raw.trim()) && !sceneOn(i);
  /* A 3D scene's render (one video per shot): the rough animation and its mask were drawn when it was put in the shot,
     so the shot sends them as they are (engine "motion", as the scene's own 🎬 Render does), with the scene's text and
     length; the shot list's sound and music, and the Settings step, still apply. It starts with a cut. */
  const sceneOn = i => !isImg() && state.shots?.mode === "each" && !!state.shots.list[i]?.scene;
  // H3 Image: a shot mapped to a 3D scene is made as a photo of it.
  const sceneStill = i => isImg() && !!state.shots.list[i]?.sceneLink && sceneFits();
  const scenePrompt = s => `integrated_multimodal_description: [Shot 1] ${oneLine(s.scene.what) || "The scene comes to life"}. ${s.scene.cam || ""}`.replace(/\.\. /g, ". ").trim()
    + `\n\n${audioFields()}`;
  function motionPictures() {
    const out = state.refs.map((r, k) => ({ ref: r.ref, url: r.url, name: `Picture ${k + 1}` }));
    const f = state.frames?.first_frame;
    if (f?.ref) out.push({ ref: f.ref, url: f.url, name: "The first frame" });
    return out;
  }
  // <Picture N> in a motion shot's text: the motion model has no reference pictures, so it gets that subject in words.
  function subjectWords(k) {
    const d = oneLine(state.refs[k]?.desc || "");
    if (!d) return "the subject";
    const w = d.split(/[,;:]/)[0].split(/\s+/).slice(0, 10).join(" ");
    return w.charAt(0).toLowerCase() + w.slice(1);
  }
  const motionPrompt = (list, style) => basePrompt(list, style)
    .replace(/,\s*(?:in the voice of|using the voice timbre referenced from) <Audio \d+>/g, "")
    .replace(/<(?:Picture|Subject) (\d+)>/g, (_, n) => subjectWords(+n - 1))
    .replace(/(\. |\] )([a-z])/g, (_, a, c) => a + c.toUpperCase());  // "… light. a red cube" -> "… light. A red cube"
  // A shot set to "Continue without a cut" (from the shot before) always waits for that shot and carries it on.
  const joins = i => isRef() && state.shots?.mode === "each" && i > 0 && state.shots.list[i]?.join === "continue" && !motionOn(i) && !sceneOn(i);
  const chainOn = () => isRef() && state.shots?.mode === "each" && state.shots.list.length > 1
    && (state.shots.continuity !== false || state.shots.list.some((_, i) => joins(i)));
  const contPic = () => state.refs.length + 1;
  const carries = i => chainOn() && i > 0 && state.refs.length < 9 && !(state.shots.list[i].rawOn && state.shots.list[i].raw.trim()) && !motionOn(i) && !sceneOn(i)
    && (state.shots.continuity !== false || joins(i));
  // A shot with no Where of its own keeps the last place written before it: the place in words is what H3 follows most.
  function carriedSetting(all, i) {
    for (let k = i - 1; k >= 0; k--) if (!all[k].rawOn && (all[k].setting || "").trim()) return all[k].setting.trim();
    return "";
  }
  // Describe with AI every reference picture that has no definition yet (for Generate and the Subjects section).
  async function describeMissing(onEach = () => {}) {
    const v = id => document.getElementById(id)?.value ?? "";
    const llm = { backend: v("llm-backend") || null, url: v("llm-url").trim() || null, model: v("llm-model") || null };
    for (const k of missingSubjects()) {
      const r = state.refs[k]; if (!r) continue;
      onEach(k);
      const j = await api("/api/describe", { method: "POST", body: JSON.stringify({ ref: r.ref, ...llm }) });
      if (state.refs[k] === r) r.desc = j.text;
    }
    renderRefs(); render();
  }
  function renderSubjects() {
    const box = document.getElementById("shots-subjects"); if (!box) return;
    box.hidden = !isRef() || !state.refs.length;
    if (box.hidden) return;
    const sh = state.shots, miss = missingSubjects().length;
    const sum = box.querySelector(".subj-sum");
    if (sum) sum.textContent = sh.subjectsOn === false ? "Off" : miss ? `${miss} not defined yet` : `${state.refs.length} defined`;
    const list = box.querySelector(".subj-list");
    const focused = document.activeElement && list.contains(document.activeElement) ? document.activeElement.dataset.subj : null;
    if (focused == null) list.innerHTML = state.refs.map((r, k) => `<div class="subj">
        <img src="${esc(r.url)}" alt="Picture ${k + 1}">
        <div class="subj-main"><div class="subj-h"><b>&lt;Picture ${k + 1}&gt;</b>
          <button type="button" class="btn sm ghost" data-subj-act="describe" data-k="${k}">${(r.desc || "").trim() ? "↻ Describe again" : "✨ Describe"}</button></div>
          <textarea rows="3" data-subj="${k}" placeholder="Not defined yet: ✨ Describe, or Generate does it for you.">${esc(r.desc || "")}</textarea></div></div>`).join("");
    box.querySelector("#subjects-on").checked = sh.subjectsOn !== false;
    box.querySelector('[data-subj-act="all"]').disabled = !miss;
  }
  // The Inputs step's frames: the first frame starts shot 1, the last frame ends the last shot.
  function framesOf(i) {
    const last = state.shots.list.length - 1;
    return { first_frame: i === 0 ? state.frames.first_frame || null : null, last_frame: i === last ? state.frames.last_frame || null : null };
  }
  // The <Picture N> tags a text uses, as 0-based indexes into state.refs.
  const picsIn = t => [...String(t || "").matchAll(/<Picture (\d+)>/g)].map(m => +m[1] - 1).filter(k => k >= 0 && k < state.refs.length);

  /* ---------------------------------------------------------------- the step */
  const thumbOf = (s, i) => {
    if (s.scene?.thumb) return s.scene.thumb;
    if (isImg() && s.sceneLink?.thumb) return s.sceneLink.thumb;
    if (picRefs()) { const k = picsIn(s.rawOn ? s.raw : s.action)[0] ?? 0; return state.refs[k]?.url || s.sceneLink?.thumb || ""; }
    const f = framesOf(i); return (f.first_frame || f.last_frame)?.url || s.sceneLink?.thumb || "";
  };
  function summary(s) {
    if (s.scene && !isImg()) return `🏞 ${s.scene.name}: ${oneLine(s.scene.what)}`;
    if (s.rawOn && s.raw.trim()) return s.raw.trim();
    return [s.action, s.setting].map(x => x.trim()).filter(Boolean).join(" · ");
  }
  function render() {
    const box = document.getElementById("shot-list");
    if (!box || state.loading && !upgraded()) return;  // applySettings upgrades it once the prompt is in
    const sh = ensure(), img = isImg();
    $$("#shots-mode button").forEach(b => b.classList.toggle("active", b.dataset.m === sh.mode));
    // pictures: one per shot, no timeline, sound or lengths
    document.getElementById("shots-mode").hidden = img;
    $$(".step[data-step=\"shots\"] .shots-autotl").forEach(l => { if (l.querySelector("#shots-autotl")) l.hidden = img; });
    const sm = document.getElementById("shots-sound")?.closest(".row2"); if (sm) sm.hidden = img;
    const am0 = document.getElementById("shots-automatch")?.closest("label"); if (am0) am0.hidden = img;
    const il = document.getElementById("shots-idea-s")?.closest("label"); if (il) il.hidden = img;
    const lk = document.querySelector(".shots-look > summary"); if (lk) lk.firstChild.textContent = img ? "Look " : "Look, sound and music ";
    const ideaTa = document.getElementById("shots-idea");
    if (ideaTa) ideaTa.placeholder = img ? "A woman walks her dog in a park at sunset: the dog runs off, she laughs, they rest on a bench" : "A woman walks her dog in a park at sunset; the dog runs off and she laughs";
    for (const [id, k] of [["shots-style", "style"], ["shots-sound", "soundscape"], ["shots-music", "music"], ["shots-idea", "idea"]]) {
      const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = sh[k] || "";
    }
    const ideaN = document.getElementById("shots-idea-n"); if (ideaN) ideaN.value = sh.ideaShots || "";
    const am = document.getElementById("shots-automatch"); if (am) am.checked = sh.autoMatch !== false;
    const atl = document.getElementById("shots-autotl"); if (atl) atl.checked = sh.autoTimeline !== false;
    const cont = document.getElementById("shots-cont");
    if (cont) { cont.checked = sh.continuity !== false; cont.closest("label").hidden = !(isVideo() && isRef() && sh.mode === "each" && sh.list.length > 1); }
    const ideaS = document.getElementById("shots-idea-s"); if (ideaS && document.activeElement !== ideaS) ideaS.value = sh.ideaSeconds || 10;
    renderCreat();
    renderSubjects();
    if (typeof Scene3D !== "undefined") Scene3D.refreshPanel(false);  // the 3D scenes panel (H3, H3 Reference)
    const T = total(), n = sh.list.length;
    document.getElementById("shots-total").textContent = img ? `${n} shot${n === 1 ? "" : "s"} · ${n} picture${n === 1 ? "" : "s"}` : `${n} shot${n === 1 ? "" : "s"} · ${T.toFixed(1)} s`;
    let t = 0;
    box.innerHTML = sh.list.map((s, i) => {
      const t0 = t; t += +s.seconds || 0;
      const thumb = thumbOf(s, i), text = summary(s);
      const meta = sceneStill(i) ? ["3D scene", "photo from its shot camera"] : s.scene && !img ? ["3D scene", s.scene.cam?.includes("moves") ? "camera moves" : "static camera"]
        : s.rawOn && s.raw.trim() ? ["own prompt"] : [s.framing, s.angle, img ? "" : s.camera].filter(Boolean);
      const badges = [sceneStill(i) ? `<span class="sb-badge" title="Mapped to the 3D scene ${esc(s.sceneLink.name)}: Generate makes this picture from what its shot camera sees">🏞</span>`
        : s.scene && !img ? `<span class="sb-badge" title="Renders the 3D scene ${esc(s.scene.name)}">🏞</span>`
        : s.sceneLink && sceneFits() ? `<span class="sb-badge sb-dim" title="Mapped to the 3D scene ${esc(s.sceneLink.name)}: Generate draws it into this shot first">🏞</span>` : "", motionOn(i) ? `<span class="sb-badge" title="Objects in motion: ${esc(s.motion.layers.map(l => l.name).join(", "))}, from ${esc(s.motion.picture.name || "a picture")}">🎬</span>` : "",
        joins(i) ? `<span class="sb-badge" title="Continues shot ${i} without a cut">↪</span>` : "", s.dialogue.trim() && !s.rawOn && !img ? `<span class="sb-badge" title="${esc(speakerOf(s) ? `${s.speaker} says` : "Spoken line")}: ${esc(s.dialogue)}">🗣</span>` : "",
        s.notes.trim() ? `<span class="sb-badge" title="${esc(s.notes)}">📝</span>` : ""].join("");
      return `<div class="shot-block${hasContent(s) ? "" : " sb-blank"}" data-i="${i}" ${n > 1 ? 'draggable="true"' : ""} role="listitem" aria-label="Shot ${i + 1}${s.title ? `: ${esc(s.title)}` : ""}">
        <span class="sb-grip" title="${n > 1 ? "Drag to reorder" : ""}" aria-hidden="true">${n > 1 ? "⠿" : ""}</span>
        <div class="sb-thumb">${thumb ? `<img src="${esc(thumb)}" alt="">` : `<span>${i + 1}</span>`}</div>
        <div class="sb-main" data-shot-act="edit" title="Edit this shot (double-click)">
          <div class="sb-top"><b>Shot ${i + 1}</b>${s.title ? `<span class="sb-title">${esc(s.title)}</span>` : ""}
            ${img ? "" : `<span class="sb-time">${fmtT(t0)} – ${fmtT(t)} · ${(+s.seconds).toFixed(1)} s</span>`}${badges}</div>
          <div class="sb-meta">${esc(meta.join(" · "))}</div>
          <div class="sb-text">${text ? esc(text) : '<span class="sb-empty">Empty: click to describe it, or write it with ✨</span>'}</div>
        </div>
        <button type="button" class="sb-more" data-shot-act="menu" aria-haspopup="menu" aria-label="Shot ${i + 1} options" title="Options">⋯</button>
      </div>`;
    }).join("");
    const warn = [];
    if (!img && sh.mode === "multi" && T > 15) warn.push(`H3 makes up to about 15 s in one video; this is ${T.toFixed(1)} s. Use “One video per shot”, or shorten.`);
    if (!img && sh.mode === "multi" && n > 6) warn.push("More than 6 shots in one video crowds it; H3 does best with 1–5.");
    if (!img && sh.mode === "multi" && sh.list.some(s => s.scene)) warn.push("A 3D scene renders only in “One video per shot”: in one multi-shot video its shot has no text.");
    const unrendered = !img && sceneFits() && sh.mode === "each" ? sh.list.map((s, i) => s.sceneLink && !s.scene ? i + 1 : 0).filter(Boolean) : [];
    if (unrendered.length) warn.push(`Shot${unrendered.length > 1 ? "s" : ""} ${unrendered.join(", ")}: Generate first draws ${unrendered.length > 1 ? "their 3D scenes" : "its 3D scene"} (the camera move, and a photo of the first frame when needed, about a minute), then makes the video from it.`);
    const empty = sh.list.map((s, i) => hasContent(s) || sceneStill(i) ? 0 : i + 1).filter(Boolean);
    if (empty.length) warn.push(`Shot${empty.length > 1 ? "s" : ""} ${empty.join(", ")} ${empty.length > 1 ? "are" : "is"} empty.`);
    if (img) {
      const sc = sh.list.map((_, i) => sceneStill(i) ? i + 1 : 0).filter(Boolean);
      document.getElementById("shots-hint").innerHTML = `Generate makes <b>${n === 1 ? "one picture" : `${n} pictures`}</b>${n > 1 ? ", one per shot" : " from this shot"}.`
        + (sc.length ? ` Shot${sc.length > 1 ? "s" : ""} ${sc.join(", ")}: a photo of ${sc.length > 1 ? "their 3D scenes" : "its 3D scene"} from the shot camera, made by the edit model with the shot's text.` : "")
        + ` ${warn.map(w => `<span class="warn">⚠ ${esc(w)}</span>`).join(" ")}`;
      document.getElementById("shots-prompt").textContent = previewText();
      return;
    }
    document.getElementById("shots-hint").innerHTML = `${sh.mode === "multi"
      ? `Generate makes <b>one ${T.toFixed(1)} s video</b> from these shots.`
      : n > 1 ? `Generate makes <b>${n} videos</b>, one per shot${chainOn() ? ", one after another, each starting from the last frame of the one before" : ""}${sh.autoTimeline !== false ? ", and puts them on the timeline in order" : ""}.` : "Generate makes <b>one video</b> from this shot."}${sh.autoTimeline !== false && (sh.mode === "multi" || n === 1) ? " It goes on the timeline when it's done." : ""} ${warn.map(w => `<span class="warn">⚠ ${esc(w)}</span>`).join(" ")}`;
    document.getElementById("shots-prompt").textContent = previewText();
  }
  function renderBanner() {
    const b = document.getElementById("prompt-shots-banner");
    if (b) b.hidden = true;  // the Prompt step isn't shown for video any more
  }
  function renderCreat() {
    const sh = state.shots, v = sh.creativity ?? 50;
    for (const id of ["shots-creat", "sm-creat"]) {
      const el = document.getElementById(id); if (!el) continue;
      if (+el.value !== v) el.value = v;
      el.setAttribute("aria-valuetext", `${v}% ${creatName(v)}`);
    }
    $$(".shots-creat-val").forEach(el => { el.textContent = `${v}% · ${creatName(v)}`; });
  }
  // A change that alters the shot list: save, redraw the list, and the Edit window if it's open. (Typing in the window
  // doesn't come here: scheduleSave() redraws the list on every key, and rebuilding the window then would lose the caret.)
  function changed() { scheduleSave(); render(); if (modal) renderModal(); }

  /* ---------------------------------------------------------------- list actions */
  function move(from, to) {
    const L = state.shots.list;
    if (from === to || from < 0 || to < 0 || from >= L.length || to >= L.length) return;
    const [s] = L.splice(from, 1); L.splice(to, 0, s);
    if (modal && modal.i === from) modal.i = to;
    changed();
  }
  function duplicate(i) {
    const L = state.shots.list, c = { ...structuredClone(L[i]), id: uid() };
    if (c.title) c.title += " (copy)";
    if (!c.scene) c.sceneLink = null;  // a scene renders into one shot
    L.splice(i + 1, 0, c); changed();
    return i + 1;
  }
  function remove(i) {
    const L = state.shots.list;
    if (L.length <= 1) return;
    const s = L[i];
    if (hasContent(s) && !confirm(`Delete shot ${i + 1}${s.title ? ` “${s.title}”` : ""}?`)) return;
    L.splice(i, 1);
    if (modal) { if (modal.i === i) closeModal(); else if (modal.i > i) modal.i--; }
    changed();
  }
  function add() {
    const L = state.shots.list, last = L[L.length - 1];
    L.push({ ...blank(last?.seconds || settingsSeconds()), framing: last?.framing || "medium shot", setting: last?.setting || "" });
    changed();
    return L.length - 1;
  }
  function menu(i, anchor) {
    document.querySelector(".ex-menu")?.remove();
    const n = state.shots.list.length;
    const s = state.shots.list[i];
    const items = [["✎  Edit…", () => openModal(i)],
      ...(sceneFits() && modeOf() === "each" ? s.sceneLink ? [["🏞  Open its 3D scene", () => Scene3D.open(s.sceneLink.id)]]
        : [["🏞  New 3D scene from this shot", () => newScene(i, shotPictures(i)[0]?.ref || null)]] : []), null,
      ["↑  Move up", () => move(i, i - 1), i === 0], ["↓  Move down", () => move(i, i + 1), i === n - 1], null,
      ["⧉  Duplicate", () => duplicate(i)], ["🗑  Delete", () => remove(i), n <= 1]];
    const m = document.createElement("div");
    m.className = "ex-menu"; m.setAttribute("role", "menu");
    m.innerHTML = items.map((it, k) => it ? `<button type="button" role="menuitem" data-k="${k}"${it[2] ? " disabled" : ""}>${esc(it[0])}</button>` : '<div class="menu-sep"></div>').join("");
    document.body.appendChild(m);
    const a = anchor.getBoundingClientRect(), r = m.getBoundingClientRect();
    Object.assign(m.style, { left: Math.max(8, Math.min(a.right - r.width, innerWidth - r.width - 8)) + "px",
      top: (a.bottom + r.height + 8 > innerHeight ? a.top - r.height - 4 : a.bottom + 4) + "px", zIndex: 100000 });
    anchor.setAttribute("aria-expanded", "true");
    const close = () => { m.remove(); anchor.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); };
    const outside = ev => { if (!m.contains(ev.target) && ev.target !== anchor) close(); };
    m.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b && !b.disabled) { close(); items[+b.dataset.k][1](); } });
    m.addEventListener("keydown", ev => {
      const bs = [...m.querySelectorAll("button:not([disabled])")], at = bs.indexOf(document.activeElement);
      if (ev.key === "Escape") { ev.stopPropagation(); close(); anchor.focus(); }
      if (ev.key === "ArrowDown") { ev.preventDefault(); bs[(at + 1) % bs.length]?.focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); bs[(at - 1 + bs.length) % bs.length]?.focus(); }
    });
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
    m.querySelector("button:not([disabled])")?.focus();
  }

  /* ---------------------------------------------------------------- ✨ AI (the prompt writer, /api/prompt/write) */
  function aiBase() {
    const v = id => document.getElementById(id)?.value ?? "";
    return { kind: "video", engine: isImg() ? (state.refs.length ? "h3ref" : "h3") : state.engine.video, aspect: v("aspect") || "16:9",
      backend: v("llm-backend") || null, url: v("llm-url").trim() || null, model: v("llm-model") || null,
      voices: isRef() ? state.arefs.length : 0, creativity: state.shots.creativity ?? 50 };
  }
  function projectLocks() {
    const sh = state.shots, l = {};
    for (const k of ["style", "soundscape", "music"]) if ((sh[k] || "").trim()) l[k] = sh[k];
    return l;
  }
  // The look, sound and music the writer came up with fill the project's when those are still empty.
  function takeProjectFields(f) {
    const sh = state.shots;
    for (const k of ["style", "soundscape", "music"]) if (!(sh[k] || "").trim() && typeof f?.[k] === "string" && f[k].trim()) sh[k] = f[k].trim();
  }
  const wantsLine = t => /\b(say|says|said|ask|asks|tell|tells|shout|shouts|whisper|whispers|reply|replies|talk|talks)\b|["“”]/i.test(t);
  const shotFields = s => Object.fromEntries(FIELDS.map(k => [k, s[k] || ""]));
  async function aiShot(i, enhance) {
    const sh = state.shots, s = sh.list[i], prev = sh.list[i - 1];
    const brief = (s.brief || "").trim() || [s.action, s.setting].filter(x => x.trim()).join(". ");
    if (!enhance && !brief) return Media.toast("Write in a line what happens in this shot first.");
    let idea = brief;
    const who = subjectsWanted() ? state.refs.map((r, k) => oneLine(r.desc) ? `<Picture ${k + 1}> is ${oneLine(r.desc)}` : "").filter(Boolean).join("; ") : "";
    if (who) idea += `\n\n(Who is who, for reference only: ${who}.)`;
    if (speakerOf(s)) idea += `\n\n(The spoken line is said by the person in ${s.speaker}.)`;
    if (prev && hasContent(prev)) idea += `\n\n(For continuity only, don't film it: the shot before this one is ${summary(prev).slice(0, 300)})`;
    const f = framesOf(i);
    const refs = picRefs() ? state.refs.map(r => r.ref) : [];
    const body = { ...aiBase(), idea, seconds: +s.seconds || 5, shots: 1, dialogue: !isImg() && (!!s.dialogue.trim() || wantsLine(brief)),
      first_frame: keyframes() ? f.first_frame?.ref ?? null : null, last_frame: keyframes() ? f.last_frame?.ref ?? null : null,
      references: refs, locked: projectLocks(), draft: enhance ? { ...projectLocks(), shots: [shotFields(s)] } : {} };
    const j = await api("/api/prompt/write", { method: "POST", body: JSON.stringify(body) });
    const got = j.fields?.shots?.[0];
    if (!got) throw new Error("The writer returned no shot");
    undo.set(s.id, { ...shotFields(s), rawOn: s.rawOn });
    for (const k of FIELDS) if (typeof got[k] === "string") s[k] = got[k].trim();
    s.rawOn = false;
    if (!s.brief.trim()) s.brief = brief.split("\n")[0];
    takeProjectFields(j.fields);
    changed();
    return j;
  }
  async function aiAll() {
    const sh = state.shots, idea = (sh.idea || "").trim();
    if (!idea) return Media.toast("Write your idea first.");
    if (sh.list.some(hasContent) && !confirm("Replace the shots you have with new ones written from this idea?")) return;
    const seconds = Math.max(2, Math.min(60, +sh.ideaSeconds || 10));
    const body = { ...aiBase(), idea, seconds: Math.min(15, seconds), shots: sh.ideaShots ? +sh.ideaShots : null, dialogue: !isImg() && wantsLine(idea),
      first_frame: keyframes() ? state.frames.first_frame?.ref ?? null : null, last_frame: keyframes() ? state.frames.last_frame?.ref ?? null : null,
      references: picRefs() ? state.refs.map(r => r.ref) : [], locked: projectLocks(), draft: {} };
    if (seconds > 15 && !body.shots) body.shots = Math.max(2, Math.min(6, Math.round(seconds / 3.5)));
    const j = await api("/api/prompt/write", { method: "POST", body: JSON.stringify(body) });
    const shots = j.fields?.shots || [];
    if (!shots.length) throw new Error("The writer returned no shots");
    const each = Math.max(1, Math.floor(seconds / shots.length * 2) / 2);
    sh.list = shots.map((x, k) => normShot({ ...blank(k === shots.length - 1 ? clampSec(seconds - each * (shots.length - 1)) : each),
      ...Object.fromEntries(FIELDS.map(f => [f, typeof x?.[f] === "string" ? x[f].trim() : ""])) }));
    for (const k of ["style", "soundscape", "music"]) if (typeof j.fields?.[k] === "string" && j.fields[k].trim() && !projectLocks()[k]) sh[k] = j.fields[k].trim();
    changed();
    return j;
  }
  const undo = new Map();  // shot id → its fields before the last ✨ (not saved)

  /* ---- Match the shots to a new look, sound or music: when one of those changes, the writer rewrites every shot's
     fields to fit (setting and light, action wording, camera), keeping what happens, who is in it and the spoken
     lines word for word. Shots with their own prompt are left alone. One ↶ Undo puts the shots back. While a render
     runs it waits for the render to finish, so the LLM doesn't take the GPU from it. */
  let matchUndo = null, matchWaiting = false, matchBusy = false, lastMatched = null;
  const projectKey = () => JSON.stringify([state.shots.style || "", state.shots.soundscape || "", state.shots.music || ""]);
  const rendering = () => [...(state.items?.values?.() || [])].some(x => ["queued", "running", "submitting"].includes(x.status));
  function matchStatus(html) { const el = document.getElementById("shots-match-status"); if (el) el.innerHTML = html; }
  function maybeMatch() {
    const sh = state.shots;
    if (sh.autoMatch === false || !isVideo()) return;
    if (lastMatched === null || projectKey() === lastMatched) return;
    if (!sh.list.some(s => !s.rawOn && hasContent(s))) { lastMatched = projectKey(); return; }
    if (rendering()) { matchWaiting = true; matchStatus("The shots will be updated to match once the render finishes."); return; }
    matchShots();
  }
  async function matchShots() {
    const sh = state.shots;
    const idx = sh.list.map((s, k) => (!s.rawOn && hasContent(s) ? k : -1)).filter(k => k >= 0);
    if (!idx.length || matchBusy) return;
    matchBusy = true; matchWaiting = false;
    const key = projectKey();
    matchStatus(`Updating ${idx.length} shot${idx.length === 1 ? "" : "s"} to match the look, sound and music…`);
    const before = idx.map(k => ({ id: sh.list[k].id, ...shotFields(sh.list[k]) }));
    const list = idx.map(k => sh.list[k]);
    // No draft: as a draft the old fields win and keep their old light and weather. The old shots go in as the story
    // to keep instead, with the new look spelled out, and the writer writes each shot afresh in it.
    const story = list.map((s, n) => `Shot ${n + 1}: ${[s.action, s.setting].map(x => x.trim()).filter(Boolean).join(". In: ")}`).join("\n");
    const look = [sh.style && `Look: ${sh.style}`, sh.soundscape && `Sound: ${sh.soundscape}`, sh.music && `Music: ${sh.music}`].filter(Boolean).join(". ");
    const idea = `${look}.\n\nRe-imagine these ${list.length} shots in that look. Keep what happens in each shot, who is in it and the order of the `
      + "shots, but rewrite the place's light, time of day, weather and colours, the wording of the action and the camera so everything "
      + "fits the look; drop any old light or weather that clashes with it (no sunshine in a night scene).\n\n" + story;
    const locked = { ...projectLocks(), shots: list.map(s => (s.dialogue.trim() ? { dialogue: s.dialogue } : {})) };
    const draft = {};
    const f = framesOf(0);
    const body = { ...aiBase(), idea, seconds: Math.min(15, Math.max(2, list.reduce((a, s) => a + (+s.seconds || 0), 0))), shots: list.length,
      dialogue: list.some(s => s.dialogue.trim()), first_frame: !isRef() ? f.first_frame?.ref ?? null : null, last_frame: null,
      references: isRef() ? state.refs.map(r => r.ref) : [], locked, draft };
    try {
      const j = await api("/api/prompt/write", { method: "POST", body: JSON.stringify(body) });
      const got = j.fields?.shots || [];
      let changedN = 0;
      list.forEach((s, n) => {
        const g = got[n]; if (!g || !sh.list.includes(s)) return;
        for (const k of FIELDS) if (k !== "dialogue" && typeof g[k] === "string" && g[k].trim()) s[k] = g[k].trim();
        changedN++;
      });
      matchUndo = before; lastMatched = key;
      changed();
      matchStatus(`Updated ${changedN} shot${changedN === 1 ? "" : "s"} to match (${esc(j.model)}, ${j.seconds}s). `
        + `<button type="button" class="link" data-match="undo">↶ Undo</button>`);
    } catch (e) {
      matchStatus(`⚠ Couldn't update the shots: ${esc(e.message)} <button type="button" class="link" data-match="now">Try again</button>`);
    } finally {
      matchBusy = false;
      if (projectKey() !== key && state.shots.autoMatch !== false) maybeMatch();  // changed again meanwhile
    }
  }
  function undoMatch() {
    if (!matchUndo) return;
    for (const b of matchUndo) { const s = state.shots.list.find(x => x.id === b.id); if (s) for (const k of FIELDS) s[k] = b[k]; }
    matchUndo = null; changed();
    matchStatus("The shots are back as they were.");
  }

  /* ---------------------------------------------------------------- the Edit window */
  let modal = null;  // {root, i}
  function openModal(i) {
    if (modal) { modal.i = i; renderModal(true); return; }
    const root = document.createElement("div");
    root.className = "set-overlay shot-overlay";
    root.innerHTML = `<div class="shot-modal" role="dialog" aria-modal="true" aria-labelledby="sm-h"></div>`;
    document.body.appendChild(root);
    modal = { root, i, back: document.activeElement };
    root.addEventListener("pointerdown", e => { if (e.target === root) closeModal(); });
    root.addEventListener("keydown", e => {
      if (e.key === "Escape" && !e.target.closest(".ex-menu")) { e.stopPropagation(); closeModal(); }
      if (e.key === "Tab") trap(e);
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); go(e.key === "ArrowLeft" ? -1 : 1); }
    });
    root.addEventListener("input", onModalInput);
    for (const ev of ["input", "change", "paste", "cut", "drop", "keyup"]) root.addEventListener(ev, e => { if (e.target.closest?.(".sm-form")) syncSoon(); });
    root.addEventListener("change", onModalChange);
    root.addEventListener("click", onModalClick);
    renderModal(true);
  }
  function closeModal() {
    if (!modal) return;
    const back = modal.back; modal.root.remove(); modal = null;
    render();
    back?.isConnected && back.focus?.();
  }
  function go(d) {
    const n = state.shots.list.length, j = modal.i + d;
    if (j < 0 || j >= n) return;
    modal.i = j; renderModal(true);
  }
  function trap(e) {
    const f = [...modal.root.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`;
  function renderModal(focus = false) {
    const sh = state.shots, n = sh.list.length;
    if (modal.i >= n) modal.i = n - 1;
    const i = modal.i, s = sh.list[i], H = P(), multi = modeOf() === "multi", img = isImg();
    const box = modal.root.querySelector(".shot-modal");
    // Keep the focused field, its caret and the scroll position across the rebuild.
    const ae = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
    const keep = ae ? ae.dataset.sf || ae.id : null;
    let sel = null; try { if (ae && typeof ae.selectionStart === "number") sel = [ae.selectionStart, ae.selectionEnd]; } catch {}
    const scroll = focus ? 0 : box.querySelector(".sm-form")?.scrollTop || 0;
    let t0 = 0; for (let k = 0; k < i; k++) t0 += +sh.list[k].seconds || 0;
    const framings = [...H.FRAMINGS, ...EXTRA_FRAMINGS];
    if (s.framing && !framings.includes(s.framing)) framings.push(s.framing);
    const angles = [...H.ANGLES]; if (s.angle && !angles.includes(s.angle)) angles.push(s.angle);
    const voices = state.arefs.map((_, k) => `<Audio ${k + 1}>`);
    const speakerVoice = speakerOf(s) ? voiceFor({ ...s, voice: "" }) : "";
    const rawOn = s.rawOn, busy = modal.busy;
    // Chips that insert a tag into a field: the reference pictures (hover for the picture) and this prompt's own tags.
    const tagChips = field => {
      const pics = picRefs() ? state.refs.map((r, k) => `<span class="pic-chip">
          <button type="button" class="chip-btn" data-tag="<Picture ${k + 1}>" data-for="${field}" title="Insert <Picture ${k + 1}>">Picture ${k + 1}</button>
          <span class="pic-pop"><button type="button" data-sm="goto-inputs" title="Open the Inputs step"><img src="${esc(r.url)}" alt="Picture ${k + 1}"><span>Picture ${k + 1} · Inputs ›</span></button></span></span>`) : [];
      const own = Object.keys(state.promptTags || {}).map(k => `<button type="button" class="chip-btn own" data-tag="<${esc(k)}>" data-for="${field}" title="Insert your tag <${esc(k)}>">&lt;${esc(k)}&gt;</button>`);
      own.push(`<button type="button" class="chip-btn add" data-sm="new-tag" title="Make a tag: a name for text you reuse, or a list to pick from at random">＋ Tag</button>`);
      return `<span class="shot-tags">${[...pics, ...own].join("")}</span>`;
    };
    const preview = multi ? prompt() : prompt(i);
    box.innerHTML = `
      <header class="sm-head">
        <button type="button" class="set-x" data-sm="prev" title="Previous shot (Alt+←)" ${i ? "" : "disabled"} aria-label="Previous shot">‹</button>
        <h2 id="sm-h">Shot ${i + 1} <small>of ${n}</small></h2>
        <button type="button" class="set-x" data-sm="next" title="Next shot (Alt+→)" ${i < n - 1 ? "" : "disabled"} aria-label="Next shot">›</button>
        <input class="sm-title" data-sf="title" value="${esc(s.title)}" placeholder="Title (optional): Arrival at the door" aria-label="Shot title">
        ${img ? "" : `<span class="sm-time">${fmtT(t0)} – ${fmtT(t0 + (+s.seconds || 0))}</span>`}
        <button type="button" class="set-x" data-sm="close" title="Close (Esc)" aria-label="Close">✕</button>
      </header>
      <div class="sm-body">
        <div class="sm-form">
          <section class="sm-ai${busy ? " busy" : ""}">
            <div class="sm-ai-row">
              <input data-sf="brief" value="${esc(s.brief)}" placeholder="✨ In a line, what happens: she opens the door and freezes" aria-label="What happens, in a line">
              <button type="button" class="btn sm primary" data-sm="ai-write" ${busy ? "disabled" : ""} title="Write this shot's fields from the line at the creativity below">✨ Write</button>
              <button type="button" class="btn sm" data-sm="ai-enhance" ${busy || !hasContent(s) ? "disabled" : ""} title="Improve the fields as they are now">🪄 Enhance</button>
              ${undo.has(s.id) ? `<button type="button" class="btn sm ghost" data-sm="ai-undo" title="Put back the fields from before ✨">↶ Undo</button>` : ""}
            </div>
            <div class="sm-ai-row">
              <label for="sm-creat">Creativity</label>
              <input type="range" id="sm-creat" min="0" max="100" step="5" value="${sh.creativity ?? 50}">
              <span class="shots-creat-val"></span>
              <span class="sm-ai-status" aria-live="polite">${esc(modal.status || "")}</span>
            </div>
          </section>

          ${!multi && (img || !s.scene) && sceneFits() ? `<section class="sm-scene"><h3>🏞 3D scene <span class="opt">optional</span></h3>
            ${s.sceneLink && img ? `<div class="sm-mo">${s.sceneLink.thumb ? `<img src="${esc(s.sceneLink.thumb)}" alt="">` : `<span class="sm-mo-ph" aria-hidden="true">🏞</span>`}
                <div><b>${esc(s.sceneLink.name)}</b>
                  <div class="sm-mo-acts"><button type="button" class="btn sm" data-sm="link-open" title="Place the objects and the shot camera">🏞 Open the scene</button>
                  <button type="button" class="btn sm ghost" data-sm="link-off" title="This shot no longer uses the scene (the scene stays)">Unlink</button></div></div></div>
              <p class="hint">Generate makes this shot's picture from the scene: what its shot camera sees at 0 s, drawn and turned into a photo by the edit model (MiniMax H3 Image when it's there), which keeps where everything is. This shot's text says how it looks; its &lt;Picture N&gt; tags become the objects that have those pictures (a Person without one takes it), and those pictures go along.</p>`
            : s.sceneLink ? `<div class="sm-mo">${s.sceneLink.thumb ? `<img src="${esc(s.sceneLink.thumb)}" alt="">` : `<span class="sm-mo-ph" aria-hidden="true">🏞</span>`}
                <div><b>${esc(s.sceneLink.name)}</b> · not rendered in yet
                  <div class="sm-mo-acts"><button type="button" class="btn sm" data-sm="link-open" title="Build the shot in 3D, then 🎬 Render: it goes to this shot">🏞 Open the scene</button>
                  <button type="button" class="btn sm ghost" data-sm="link-off" title="This shot no longer uses the scene (the scene stays)">Unlink</button></div></div></div>
              <p class="hint">Generate draws this scene into the shot first (its camera move, and a photo of its first frame when needed), with this shot's What happens; its &lt;Picture N&gt; tags become the objects that have those pictures (a Person without one takes it). The scene's 🎬 Render does the same with your choices.</p>`
            : `<div class="sm-mo-acts"><button type="button" class="btn sm" data-sm="link-new" title="A 3D scene made from this shot's inputs: its picture, length and text">＋ New scene from this shot…</button>
                <button type="button" class="btn sm ghost" data-sm="link-pick" title="One of this project's 3D scenes">Use a scene…</button></div>
              <p class="hint">Stage this shot in 3D. The scene starts from ${shotPictures(i).length ? `this shot's ${esc(shotPictures(i).map(p => p.label.toLowerCase()).join(", "))} (or another Inputs picture, or none)` : "an Inputs picture, or none"}${img ? "; Generate then makes this shot's picture from what its shot camera sees." : ", with this shot's length; its 🎬 Render then goes to this shot."}</p>`}
          </section>` : ""}

          ${s.scene && !img ? `<section class="sm-scene"><h3>🏞 3D scene</h3>
            <div class="sm-mo"><img src="${esc(s.scene.thumb || "")}" alt="">
              <div><b>${esc(s.scene.name)}</b> · ${(+s.scene.seconds).toFixed(2)} s · ${esc(s.scene.cam || "")}
                <div class="sm-mo-acts"><button type="button" class="btn sm" data-sm="scene-open" title="Open the scene; 🎬 Render › Goes to this shot again replaces this render">🏞 Open the scene</button>
                <button type="button" class="btn sm ghost" data-sm="scene-off">Remove</button></div></div></div>
            <div class="field"><label for="sm-scene-what">What happens <span class="opt">what H3 reads</span></label>
              <textarea id="sm-scene-what" rows="3">${esc(s.scene.what || "")}</textarea></div>
            <p class="hint">${multi ? `<span class="warn">⚠ A 3D scene renders only in “One video per shot”.</span>` : "This shot is the scene's render: its rough animation, mask and first picture as they were when it was put here. The fields below aren't used; its length is the scene's. The shot list's sound, music and the Settings step still apply."}</p>
          </section>` : ""}

          <section${s.scene && !multi && !img ? ' class="sm-dim"' : ""}>
            <h3>Shot</h3>
            ${i > 0 && !multi && isRef() ? `<div class="field sm-join"><label for="sm-join">From shot ${i}</label>
              <select id="sm-join" data-sf="join" title="Continue without a cut: H3 carries on from the last moments of shot ${i} (its picture, motion and sound), so the two play as one shot">
                ${opt("cut", "Cut to a new shot", s.join)}${opt("continue", "Continue without a cut", s.join)}</select></div>` : ""}
            <div class="sm-grid">
              ${img ? "" : `<div class="field"><label for="sm-sec">Length</label><div class="sm-sec"><input type="number" id="sm-sec" data-sf="seconds" min="1" max="15" step="0.5" value="${s.seconds}"${s.scene ? " disabled title=\"The 3D scene's length\"" : ""}> s</div></div>`}
              <div class="field"><label>Framing</label><select data-sf="framing">${framings.map(f => opt(f, f, s.framing)).join("")}</select></div>
              <div class="field"><label>Angle</label><select data-sf="angle" title="The camera's height and angle">${opt("", "Any", s.angle)}${angles.map(a => opt(a, a, s.angle)).join("")}</select></div>
            </div>
            <div class="row2">
              <div class="field"><label>Camera position <span class="opt">optional</span></label><input data-sf="position" value="${esc(s.position)}" placeholder="behind her at shoulder height" title="Where the camera stands, relative to the subject"></div>
              ${img ? "" : `<div class="field"><label>Camera move</label><input list="shot-cams" data-sf="camera" value="${esc(s.camera)}" placeholder="holds a static shot"></div>`}
            </div>
            <div class="field"><label>Where <span class="opt">place and light</span></label><input data-sf="setting" value="${esc(s.setting)}" placeholder="A rain-soaked back alley at night, neon signs further down"></div>
            <div class="field"><div class="sm-lbl">${img ? "Who and what is there" : "What happens"} ${tagChips("action")}</div>
              <textarea rows="3" data-sf="action" placeholder="${img ? (state.refs.length ? "The woman from <Picture 1> in a red coat, laughing, her dog at her feet" : "A woman in a red coat, laughing, her dog at her feet") : isRef() ? "The woman from <Picture 1> turns around and smiles" : "The woman turns around and smiles"}">${esc(s.action)}</textarea></div>
            ${img ? "" : `<div class="field"><div class="sm-lbl">Spoken line <span class="opt">optional</span> ${tagChips("dialogue")}</div>
              <textarea rows="3" data-sf="dialogue" placeholder="See you tomorrow.">${esc(s.dialogue)}</textarea></div>
            <div class="sm-say">
                ${isRef() ? `<div class="field"><label>Speaker</label><select data-sf="speaker" title="Which reference picture's person says the line" ${state.refs.length ? "" : "disabled"}>${opt("", "Anyone", s.speaker)}${state.refs.map((_, k) => opt(`<Picture ${k + 1}>`, `<Picture ${k + 1}>`, s.speaker)).join("")}</select></div>` : ""}
                <div class="field"><label>Voice</label><select data-sf="voice" ${voices.length ? "" : "disabled title='Add reference sounds on the Inputs step to choose a voice'"}>${opt("", speakerVoice ? `Speaker's · ${speakerVoice}` : "Any", s.voice)}${voices.map(v => opt(v, v, s.voice)).join("")}</select></div>
            </div>`}
            <p class="hint sm-syntax">In Where, ${img ? "Who and what is there" : "What happens and Spoken line"}: your tags (＋ Tag),
              <code>{a|b}</code> choices, <code>&lt;list&gt;</code> and <code>&lt;maybe&gt;</code> are filled in when the prompt is built; the preview shows one roll.</p>
            <label class="sm-check"><input type="checkbox" data-sf="rawOn"${rawOn ? " checked" : ""}> Write the prompt myself <span class="opt">this shot sends the text below instead of the fields above</span></label>
            ${rawOn ? `<div class="field"><textarea rows="6" data-sf="raw" class="sm-raw" placeholder="The whole prompt for this shot, in H3's format">${esc(s.raw)}</textarea>
              <p class="hint">${multi ? `In one multi-shot video this text becomes Shot ${i + 1}'s description.` : "Tags like <Picture 1> and {a|b} choices work as on the Prompt step."}${img && s.sceneLink ? " With a 3D scene, this text says how the photo of it looks." : ""}</p></div>` : ""}
          </section>

          ${!multi && !s.scene && !img ? (() => {
            const mo = s.motion, pics = motionPictures(), holdName = { loose: "loosely", normal: "normally", tight: "tightly" };
            return `<section class="sm-motion"><h3>Objects in motion <span class="opt">optional</span></h3>
            ${mo ? `<div class="sm-mo"><img src="${esc(mo.picture.url)}" alt="">
                <div><b>${mo.layers.length} object${mo.layers.length === 1 ? "" : "s"}</b>: ${esc(mo.layers.map(l => l.name).join(", "))}, from ${esc(mo.picture.name || "a picture")}, following ${holdName[mo.hold] || "normally"}.
                  ${mo.plate ? "" : `<span class="warn">⚠ No empty background yet.</span>`}
                  <div class="sm-mo-acts"><button type="button" class="btn sm" data-sm="motion-edit">🎬 Edit…</button>
                  <button type="button" class="btn sm ghost" data-sm="motion-off">Remove</button></div></div></div>
              <p class="hint">This shot renders from that picture with the objects on their paths (H3 with Time-to-Move). Its text, length and settings still apply; reference pictures and voices don't, and it starts with a cut.</p>`
            : pics.length ? `<div class="mo-find"><select id="sm-mopic" aria-label="Picture to animate">${pics.map((p, k) => `<option value="${k}">${esc(p.name)}</option>`).join("")}</select>
                <button type="button" class="btn sm" data-sm="motion-new">🎬 Animate objects…</button></div>
              <p class="hint">Start this shot from a picture and move objects in it along paths.</p>`
            : `<p class="hint">Add a reference picture or a first frame on the Inputs step to animate objects in it.</p>`}
            </section>`; })() : ""}

          <section>
            <h3>Notes</h3>
            <textarea rows="2" data-sf="notes" placeholder="Anything to remember about this shot (not sent to the model)">${esc(s.notes)}</textarea>
          </section>
        </div>
        <aside class="sm-side">
          <div class="label-row"><h3>Prompt ${multi ? "<span class=\"opt\">the whole multi-shot video</span>" : img ? `<span class="opt">${sceneStill(i) ? "how the photo of its 3D scene looks" : "this shot's picture"}</span>` : "<span class=\"opt\">this shot's video</span>"}</h3>
            <span class="sm-side-acts"><button type="button" class="link" data-sm="rebuild" title="Read every field again and rebuild the prompt">↻ Rebuild</button>
            <button type="button" class="link" data-sm="copy" title="Copy the prompt">Copy</button></span></div>
          <pre class="sm-prompt">${esc(preview)}</pre>
          <p class="hint">${preview.split(/\s+/).filter(Boolean).length} words · updates as you edit.</p>
        </aside>
      </div>
      <footer class="sm-foot">
        <button type="button" class="btn sm ghost" data-sm="delete" ${n > 1 ? "" : "disabled"}>🗑 Delete</button>
        <button type="button" class="btn sm ghost" data-sm="dup">⧉ Duplicate</button>
        <button type="button" class="btn sm ghost" data-sm="add">＋ New shot</button>
        <span class="sm-gap"></span>
        <span class="hint">Saved as you edit.</span>
        <button type="button" class="btn sm primary" data-sm="close">Done</button>
      </footer>`;
    renderCreat();
    const form = box.querySelector(".sm-form"); if (form) form.scrollTop = scroll;
    if (focus) box.querySelector('[data-sf="brief"]')?.focus();
    else if (keep) {
      const el = box.querySelector(`[data-sf="${keep}"]`) || box.querySelector(`#${CSS.escape(keep)}`);
      el?.focus({ preventScroll: true });
      if (el && sel) try { el.setSelectionRange(sel[0], sel[1]); } catch {}
    }
  }
  function refreshPreview() {
    if (!modal) return;
    const multi = modeOf() === "multi", text = multi ? prompt() : prompt(modal.i);
    const pre = modal.root.querySelector(".sm-prompt");
    if (pre && pre.textContent !== text) {
      pre.textContent = text;
      pre.classList.remove("flash"); void pre.offsetWidth; pre.classList.add("flash");  // a brief sign it was rebuilt
    }
    const w = modal.root.querySelector(".sm-side .hint"); if (w) w.textContent = `${text.split(/\s+/).filter(Boolean).length} words · updates as you edit.`;
  }
  /* The safety net: read every field of the window back into the shot (whatever the edit was: typing, paste from a
     menu, drag and drop, autofill, a chip), then rebuild the prompt. Runs shortly after any edit, and on ↻ Rebuild. */
  function syncFromForm() {
    if (!modal) return false;
    const s = state.shots.list[modal.i]; if (!s) return false;
    let diff = false;
    for (const el of modal.root.querySelectorAll("[data-sf]")) {
      const k = el.dataset.sf;
      const v = k === "rawOn" ? el.checked : k === "seconds" ? clampSec(el.value) : el.value;
      if (k === "rawOn") continue;  // switching it rebuilds the window (onModalChange)
      if (s[k] !== v) { s[k] = v; diff = true; }
    }
    if (diff) scheduleSave();
    return diff;
  }
  let syncTimer = 0;
  const syncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(() => { syncFromForm(); refreshPreview(); }, 120); };
  function onModalInput(e) {
    const s = state.shots.list[modal.i], f = e.target.dataset.sf;
    if (e.target.id === "sm-creat") { state.shots.creativity = +e.target.value; renderCreat(); scheduleSave(); return; }
    if (e.target.id === "sm-scene-what" && s.scene) { s.scene.what = e.target.value; scheduleSave(); refreshPreview(); return; }
    if (f && f !== "rawOn" && e.target.tagName !== "SELECT") {
      if (f === "seconds") { s.seconds = clampSec(e.target.value); const tm = modal.root.querySelector(".sm-time"); if (tm) { let t0 = 0; for (let k = 0; k < modal.i; k++) t0 += +state.shots.list[k].seconds || 0; tm.textContent = `${fmtT(t0)} – ${fmtT(t0 + s.seconds)}`; } }
      else s[f] = e.target.value;
    } else return;
    scheduleSave(); refreshPreview();
  }
  function onModalChange(e) {
    const s = state.shots.list[modal.i], f = e.target.dataset.sf;
    if (f === "rawOn") {
      s.rawOn = e.target.checked;
      if (s.rawOn && !s.raw.trim()) s.raw = prompt(modal.i);  // start from what the fields make
    } else if (f && e.target.tagName === "SELECT") s[f] = e.target.value;
    else if (f === "seconds") s.seconds = clampSec(e.target.value);
    else return;
    changed();
  }
  async function onModalClick(e) {
    const tag = e.target.closest("[data-tag]");
    if (tag) {
      const ta = modal.root.querySelector(`[data-sf="${tag.dataset.for}"]`);
      insertAtCursor(ta, tag.dataset.tag); ta.dispatchEvent(new Event("input", { bubbles: true })); return;
    }
    const a = e.target.closest("[data-sm]")?.dataset.sm;
    if (!a) return;
    const i = modal.i, s = state.shots.list[i];
    if (a === "close") return closeModal();
    if (a === "prev") return go(-1);
    if (a === "next") return go(1);
    if (a === "dup") { modal.i = duplicate(i); return renderModal(true); }
    if (a === "add") { modal.i = add(); return renderModal(true); }
    if (a === "delete") return remove(i);
    if (a === "goto-inputs") { closeModal(); return showStep("inputs"); }
    if (a === "new-tag") return Prompts.editTag(null, () => { if (modal) renderModal(); });
    if (a === "motion-new" || a === "motion-edit") {
      // The Animate objects window opens in place of this one (it would sit under it) and brings it back after.
      const id = s.id, pic = a === "motion-edit" ? s.motion.picture : motionPictures()[+modal.root.querySelector("#sm-mopic")?.value || 0];
      if (!pic) return;
      syncFromForm(); closeModal();
      const back = () => { const k = state.shots.list.findIndex(x => x.id === id); if (k >= 0) openModal(k); };
      return Motion.open(pic, { plan: a === "motion-edit" ? s.motion : null, seconds: +s.seconds || 3, onClose: back,
        onUse: plan => { const x = state.shots.list.find(y => y.id === id); if (x) { x.motion = plan; changed(); } } });
    }
    if (a === "motion-off") { s.motion = null; changed(); return renderModal(); }
    if (a === "scene-off") { s.scene = null; changed(); return renderModal(); }
    if (a === "scene-open") { syncFromForm(); closeModal(); return Scene3D.open(s.scene.id); }
    if (a === "link-open") { syncFromForm(); closeModal(); return Scene3D.open(s.sceneLink.id); }
    if (a === "link-off") { s.sceneLink = null; changed(); return renderModal(); }
    if (a === "link-new" || a === "link-pick") {
      const r = e.target.closest("[data-sm]").getBoundingClientRect();
      let items;
      if (a === "link-new") {
        const own = shotPictures(i), rest = Scene3D.inputPictures().filter(p => !own.some(o => o.ref === p.ref));
        items = [...own.map(p => [`🖼 This shot's ${p.label.toLowerCase()}: ${p.name}`, p.ref]), ...rest.map(p => [`🖼 ${p.label}: ${p.name}`, p.ref]),
          ["▢ An empty scene (a floor and a sky)", null]].map(([l, ref]) => [l, () => { syncFromForm(); closeModal(); newScene(i, ref); }]);
      } else {
        const list = await Scene3D.projectScenes();
        if (!list.length) return Media.toast("This project has no 3D scenes yet: make one with ＋ New scene from this shot.");
        items = list.map(x => [`🏞 ${x.name}${(state.shots.list.find(y => y.sceneLink?.id === x.id && y !== s) ? " (another shot's)" : "")}`, () => linkScene(i, x)]);
      }
      return Media.menu(r.left, r.bottom + 4, items);
    }
    if (a === "rebuild") {
      const diff = syncFromForm();
      const pre = modal.root.querySelector(".sm-prompt"); if (pre) pre.textContent = "";  // force the rebuild and its flash
      refreshPreview(); render();
      Media.toast(diff ? "Picked up changes the prompt had missed, and rebuilt it." : "Prompt rebuilt: it was already up to date.");
      return;
    }
    if (a === "copy") { try { await navigator.clipboard.writeText(modal.root.querySelector(".sm-prompt").textContent); Media.toast("Prompt copied."); } catch {} return; }
    if (a === "ai-undo") { const u = undo.get(s.id); if (u) { Object.assign(s, u); undo.delete(s.id); changed(); } return; }
    if (a === "ai-write" || a === "ai-enhance") {
      const enhance = a === "ai-enhance", id = s.id;
      modal.busy = true; modal.status = `${enhance ? "Enhancing" : "Writing"} at ${state.shots.creativity ?? 50}% creativity…`; renderModal();
      try {
        const j = await aiShot(i, enhance);
        if (modal) modal.status = `${enhance ? "Enhanced" : "Written"} by ${j.model} in ${j.seconds}s${j.warnings?.length ? ` · ${j.warnings.length} note${j.warnings.length > 1 ? "s" : ""}` : ""}`;
      } catch (err) {
        if (modal) modal.status = `⚠ ${err.message}`;
      } finally {
        if (modal) { modal.busy = false; const k = state.shots.list.findIndex(x => x.id === id); if (k >= 0) modal.i = k; renderModal(); }
      }
    }
  }
  /* ---------------------------------------------------------------- wiring */
  function init() {
    ensure();
    const step = document.querySelector('.step[data-step="shots"]');
    step.addEventListener("input", e => {
      const sh = state.shots, id = e.target.id;
      // A checkbox fires input before change, and the form's input handler redraws the step: take it here, first.
      if (id === "subjects-on") { sh.subjectsOn = e.target.checked; return changed(); }
      if (id === "shots-automatch") { sh.autoMatch = e.target.checked; return scheduleSave(); }
      if (id === "shots-autotl") { sh.autoTimeline = e.target.checked; return changed(); }
      if (id === "shots-cont") { sh.continuity = e.target.checked; return changed(); }
      const map = { "shots-style": "style", "shots-sound": "soundscape", "shots-music": "music", "shots-idea": "idea" };
      if (map[id]) { sh[map[id]] = e.target.value; scheduleSave(); if (id !== "shots-idea") document.getElementById("shots-prompt").textContent = previewText(); return; }
      if (id === "shots-creat") { sh.creativity = +e.target.value; renderCreat(); scheduleSave(); }
      if (id === "shots-idea-s") { sh.ideaSeconds = Math.max(2, Math.min(60, +e.target.value || 10)); scheduleSave(); }
      if (e.target.dataset.subj != null) {
        const r = state.refs[+e.target.dataset.subj]; if (!r) return;
        if (e.target.value.trim()) r.desc = e.target.value; else delete r.desc;
        scheduleSave();
        document.getElementById("shots-prompt").textContent = previewText();
      }
    });
    step.addEventListener("change", e => {
      if (e.target.dataset.subj != null) { renderRefs(); renderSubjects(); }
      if (["shots-style", "shots-sound", "shots-music"].includes(e.target.id)) maybeMatch();
      if (e.target.id === "shots-idea-n") { state.shots.ideaShots = e.target.value; scheduleSave(); }
    });
    step.addEventListener("click", async e => {
      const sh = state.shots;
      const m = e.target.closest("#shots-mode button")?.dataset.m;
      if (m) { sh.mode = m; return changed(); }
      if (e.target.closest("#btn-shot-add")) return openModal(add());
      const mt = e.target.closest("[data-match]")?.dataset.match;
      if (mt === "undo") return undoMatch();
      if (mt === "now") { lastMatched = null; return matchShots(); }
      const sa = e.target.closest("[data-subj-act]");
      if (sa) {
        const st = document.getElementById("subjects-status"); sa.disabled = true;
        try {
          if (sa.dataset.subjAct === "all") await describeMissing(k => { st.textContent = `Describing <Picture ${k + 1}>…`; });
          else {
            const k = +sa.dataset.k; st.textContent = `Describing <Picture ${k + 1}>…`;
            const r = state.refs[k], v = id => document.getElementById(id)?.value ?? "";
            const j = await api("/api/describe", { method: "POST", body: JSON.stringify({ ref: r.ref, backend: v("llm-backend") || null, url: v("llm-url").trim() || null, model: v("llm-model") || null }) });
            r.desc = j.text; renderRefs(); render();
          }
          st.textContent = "Done. Edit any definition; the prompt uses it as written.";
        } catch (err2) { st.textContent = `⚠ ${err2.message}`; }
        finally { sa.disabled = false; }
        return;
      }
      if (e.target.closest("#btn-shots-write")) {
        const b = e.target.closest("#btn-shots-write"), st = document.getElementById("shots-idea-status");
        b.disabled = true; st.textContent = `Writing the shots at ${sh.creativity ?? 50}% creativity…`;
        try { const j = await aiAll(); st.textContent = j ? `Written by ${j.model} in ${j.seconds}s: ${state.shots.list.length} shot${state.shots.list.length === 1 ? "" : "s"}. Edit any of them below.` : ""; }
        catch (err) { st.textContent = `⚠ ${err.message}`; }
        finally { b.disabled = false; }
        return;
      }
      const block = e.target.closest(".shot-block"); if (!block) return;
      const i = +block.dataset.i, a = e.target.closest("[data-shot-act]")?.dataset.shotAct;
      if (a === "menu") return menu(i, e.target.closest(".sb-more"));
      if (a === "edit" || e.target.closest(".sb-thumb")) return openModal(i);
    });
    step.addEventListener("focusin", e => {
      if (["shots-style", "shots-sound", "shots-music"].includes(e.target.id) && !matchBusy && !matchWaiting) lastMatched = projectKey();
    });
    step.addEventListener("dblclick", e => { const b = e.target.closest(".shot-block"); if (b && !e.target.closest(".sb-more")) openModal(+b.dataset.i); });
    step.addEventListener("keydown", e => {
      const b = e.target.closest?.(".sb-main"); if (!b) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModal(+b.closest(".shot-block").dataset.i); }
    });
    // drag to reorder (the whole block is the handle; only with more than one shot)
    let dragFrom = -1;
    const list = document.getElementById("shot-list");
    list.addEventListener("dragstart", e => {
      const b = e.target.closest?.(".shot-block"); if (!b) return;
      dragFrom = +b.dataset.i; b.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-bob-shot", String(dragFrom));
    });
    list.addEventListener("dragend", () => { dragFrom = -1; $$(".shot-block", list).forEach(x => x.classList.remove("dragging", "drop-before", "drop-after")); });
    list.addEventListener("dragover", e => {
      if (dragFrom < 0) return;
      const b = e.target.closest(".shot-block"); if (!b) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = b.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      $$(".shot-block", list).forEach(x => x.classList.remove("drop-before", "drop-after"));
      if (+b.dataset.i !== dragFrom) b.classList.add(after ? "drop-after" : "drop-before");
    });
    list.addEventListener("drop", e => {
      if (dragFrom < 0) return;
      const b = e.target.closest(".shot-block"); if (!b) return;
      e.preventDefault();
      const r = b.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      let to = +b.dataset.i + (after ? 1 : 0);
      if (to > dragFrom) to--;
      const from = dragFrom; dragFrom = -1;
      move(from, to);
    });
  }

  /* ---------------------------------------------------------------- generate */
  // batch id → {ids: [item ids in shot order], project}; kept in localStorage so a reload doesn't lose it
  const pending = new Map();
  const PKEY = "bob.shotBatches";
  const savePending = () => { try { localStorage.setItem(PKEY, JSON.stringify([...pending])); } catch {} };
  try { for (const [k, v] of JSON.parse(localStorage.getItem(PKEY) || "[]")) pending.set(k, v); } catch {}
  async function generate(base) {
    rollSeed = Math.floor(Math.random() * 1e9);  // one roll of {a|b} and tags for every shot of this run
    try { return await generateRun(base); } finally { rollSeed = null; }
  }
  async function generateRun(base) {
    const sh = ensure(), isR = base.engine === "h3ref", err = document.getElementById("form-error");
    err.textContent = "";
    const empty = sh.list.findIndex((s, i) => !hasContent(s) && !sceneStill(i));
    if (empty >= 0) {
      err.textContent = `Shot ${empty + 1} is empty: describe it (Shots step › Edit), or write it with ✨.`;
      Media.toast(err.textContent); showStep("shots"); return;
    }
    if (isImg()) return generateStills(base, sh);
    if (isR && missingSubjects().length) {  // the prompt defines every subject: have the vision model write the missing ones
      try { await describeMissing(k => Media.toast(`Defining <Picture ${k + 1}> for the prompt…`)); base = { ...base }; }
      catch (e) { Media.toast(`Couldn't define the subjects (${e.message}); generating without them.`); }
    }
    const autoTl = sh.autoTimeline !== false;
    // One generation (takes allowed): with "Add to timeline when done", the first good take goes on the timeline.
    const submitOne = async req => {
      const items = await submit(req);
      if (autoTl && items?.length) { pending.set(items[0].id, { ids: items.map(x => x.id), project: state.project?.id ?? "experiment", one: true }); savePending(); }
    };
    // Only the voice recordings this video uses (the prompt numbers them the same way).
    const arefsFor = list => isR && (base.ref_audios || []).length ? audiosFor(list).map(a => base.ref_audios[a - 1]).filter(Boolean) : base.ref_audios;
    if (sh.mode === "multi") {
      const first = framesOf(0).first_frame, last = framesOf(sh.list.length - 1).last_frame;
      return submitOne({ ...base, prompt: prompt(), seconds: Math.min(300, total()), ref_audios: arefsFor(sh.list),
        first_frame: !isR ? first?.ref ?? null : null, last_frame: !isR ? last?.ref ?? null : null });
    }
    // A shot mapped to a 3D scene follows that scene's camera: draw it into the shot first when it isn't in yet or the
    // scene changed since (Scene3D opens it, draws the rough animation and its first picture, and puts it in).
    if (sceneFits()) for (let i = 0; i < sh.list.length; i++) {
      const s = sh.list[i]; if (!s.sceneLink) continue;
      let stale = !s.scene || s.scene.id !== s.sceneLink.id || !s.scene.rev;
      if (!stale) { try { stale = ((await api(`/api/scenes/${s.sceneLink.id}`)).updated || 0) > s.scene.rev + 1e-3; } catch { continue; } }
      if (!stale) continue;
      Media.toast(`Shot ${i + 1}: drawing its 3D scene's camera move first…`);
      try { await Scene3D.renderForShot(s.sceneLink.id, i, { quality: base.quality }, m => { err.textContent = `Shot ${i + 1}, 3D scene: ${m}`; }); }
      catch (e) { err.textContent = `Shot ${i + 1}'s 3D scene couldn't be drawn: ${e.message}`; Media.toast(err.textContent); return; }
      err.textContent = "";
    }
    const reqFor = i => {
      const s = sh.list[i], f = framesOf(i);
      if (sceneOn(i)) {  // a 3D scene's render: its prepared rough animation, mask and first picture
        const r = s.scene.req;
        return { ...base, engine: "motion", prompt: prompt(i), seconds: +s.scene.seconds || +s.seconds || 3, first_frame: r.first_frame, last_frame: null,
          references: r.references || [], ref_audios: [], motion_video: r.motion_video, motion_video_mask: r.motion_video_mask,
          motion_hold: r.motion_hold || "normal", motion_first: r.motion_first || "picture", quality: r.quality || base.quality,
          motion_plate: null, motion_layers: [], loras: [], unet: null, sampler: null, scheduler: null, cfg: null };
      }
      if (motionOn(i)) {  // objects in motion: the motion engine, from the plan's picture
        const p = s.motion, secs = +s.seconds || 3;
        return { ...base, engine: "motion", prompt: prompt(i), seconds: secs, first_frame: p.picture.ref, last_frame: null, references: [],
          ref_audios: [], motion_plate: p.plate, motion_layers: Motion.layerFrames(p, secs), motion_hold: p.hold || "normal", motion_first: Motion.firstOf(p),
          loras: [], unet: null, sampler: null, scheduler: null, cfg: null };
      }
      return { ...base, prompt: prompt(i), seconds: +s.seconds || 3, references: isR ? base.references : [], ref_audios: arefsFor([s]),
        first_frame: !isR ? f.first_frame?.ref ?? null : null, last_frame: !isR ? f.last_frame?.ref ?? null : null };
    };
    if (sh.list.length === 1) {  // one shot: a plain generation (takes allowed), no timeline layout
      const req = reqFor(0);
      if (isR && req.engine !== "motion" && !req.references.length && !(req.ref_audios || []).length) { err.textContent = "Add reference pictures on the Inputs step."; return; }
      return submitOne(req);
    }
    // Every shot of the run draws from one seed: the seed weighs a lot in H3, so the shots look more alike.
    if (!(+base.seed >= 0)) base = { ...base, seed: Math.floor(Math.random() * 2 ** 31) };
    // Continuity: shot 1 now, each next one when the one before is done, with its last frame (onItem → advance).
    if (chainOn()) {
      const steps = sh.list.map((s, i) => ({ ...reqFor(i), batch: 1, seed: base.seed,
        cont: carries(i) ? prompt(i) : null, prompt: prompt(i, false), join: joins(i) }));
      const bad = steps.findIndex(r => isR && r.engine !== "motion" && !r.references.length && !(r.ref_audios || []).length);
      if (bad >= 0) { err.textContent = `Shot ${bad + 1} has no reference pictures.`; return; }
      const first = steps.shift(); delete first.cont; delete first.join;
      let items;
      try { ({ items } = await api("/api/generate", { method: "POST", body: JSON.stringify(first) })); }
      catch (e) { err.textContent = `Shot 1: ${e.message}`; return; }
      for (const it of items) { state.items.set(it.id, it); Activity.onEvent({ type: "item", item: it }); }
      pending.set(items[0].id, { ids: [items[0].id], project: state.project?.id ?? "experiment", place: autoTl, steps, total: sh.list.length });
      savePending();
      renderGallery(); renderQueue(); select(items[0].id);
      Media.toast(`Shot 1 of ${sh.list.length} queued. Each next shot starts when the one before is done, from its last frame${autoTl ? "; they go on the timeline in order" : ""}.`);
      return;
    }
    // one per shot: submit them in order, then place the results on the timeline in order
    const ids = [];
    for (let i = 0; i < sh.list.length; i++) {
      const req = { ...reqFor(i), batch: 1, seed: base.seed };
      if (isR && req.engine !== "motion" && !req.references.length && !(req.ref_audios || []).length) { err.textContent = `Shot ${i + 1} has no reference pictures.`; return; }
      try {
        const { items } = await api("/api/generate", { method: "POST", body: JSON.stringify(req) });
        for (const it of items) { state.items.set(it.id, it); Activity.onEvent({ type: "item", item: it }); }
        ids.push(items[0].id);
      } catch (e) { err.textContent = `Shot ${i + 1}: ${e.message}`; break; }
    }
    if (!ids.length) return;
    if (autoTl) { pending.set(ids[0], { ids, project: state.project?.id ?? "experiment", place: true }); savePending(); }
    renderGallery(); renderQueue(); select(ids[0]);
    Media.toast(autoTl ? `${ids.length} shots queued: they go on the timeline in order when all are done.` : `${ids.length} shots queued.`);
  }
  /* H3 Image: one picture per shot (a single shot keeps its takes). A shot mapped to a 3D scene is a photo of what its
     shot camera sees, made by the edit model with the shot's text (Scene3D.photoForShot); the others are H3 Image
     from their prompt and the Inputs step's reference pictures, all with one seed so they look alike. */
  async function generateStills(base, sh) {
    const err = document.getElementById("form-error"), n = sh.list.length, ids = [];
    if (n > 1 && !(+base.seed >= 0)) base = { ...base, seed: Math.floor(Math.random() * 2 ** 31) };
    for (let i = 0; i < n; i++) {
      const s = sh.list[i];
      try {
        if (sceneStill(i)) {
          Media.toast(`Shot ${i + 1}: drawing its 3D scene from the shot camera…`);
          const it = await Scene3D.photoForShot(s.sceneLink.id, stillLook(i),
            m => { err.textContent = `Shot ${i + 1}, 3D scene: ${m}`; });
          err.textContent = "";
          ids.push(it.id); continue;
        }
        const req = { ...base, prompt: prompt(i), ...(n > 1 ? { batch: 1 } : {}) };
        if (n === 1) return await submit(req);
        const { items } = await api("/api/generate", { method: "POST", body: JSON.stringify(req) });
        for (const it of items) { state.items.set(it.id, it); Activity.onEvent({ type: "item", item: it }); }
        ids.push(items[0].id);
      } catch (e) { err.textContent = `Shot ${i + 1}: ${e.message}`; Media.toast(err.textContent); break; }
    }
    if (!ids.length) return;
    renderGallery(); renderQueue(); select(ids[0]);
    if (n > 1) Media.toast(`${ids.length} picture${ids.length === 1 ? "" : "s"} queued, one per shot.`);
  }
  // Called for every studio item update: when a whole batch is done, lay it out on the timeline.
  const FINAL = ["done", "failed", "cancelled"];
  const videoOf = x => x?.status === "done" ? (x.files || []).find(f => /^video\//.test(f.content_type || "")) || x.files?.[0] : null;
  /* A chained run (Continuity): its last shot is finished, so queue the next one with that shot's last frame as the
     hidden picture. A failed shot hands on nothing (the next one goes without the frame); a cancelled one stops the run. */
  async function advance(key, b, last) {
    if (b.busy && Date.now() - b.busy < 120000) return;
    b.busy = Date.now(); savePending();
    try {
      if (last.status === "cancelled") {
        Media.toast(`Shot ${b.ids.length} was cancelled, so the ${b.steps.length} shot${b.steps.length > 1 ? "s" : ""} after it won't be made.`);
        b.steps = []; return;
      }
      const step = b.steps[0], k = b.ids.length + 1;
      let req = { ...step }; delete req.cont; delete req.join;
      const f = videoOf(last);
      if (step.cont && f) {
        try {
          const fr = await api("/api/media/frame", { method: "POST", body: JSON.stringify({ path: f.path, t: 1e6 }) });
          req = { ...req, prompt: step.cont, references: [...(req.references || []), fr.ref] };
        } catch (e) { Media.toast(`Couldn't take shot ${k - 1}'s last frame (${e.message}); shot ${k} goes without it.`); }
      }
      // Continue without a cut: H3 carries on the last moments of the shot before (a failed one leaves a plain cut).
      if (step.join && f) req.continue_from = f.path;
      else if (step.join) Media.toast(`Shot ${k - 1} didn't finish, so shot ${k} starts with a cut instead of continuing it.`);
      const { items } = await api("/api/generate", { method: "POST", body: JSON.stringify(req) });
      for (const x of items) { state.items.set(x.id, x); Activity.onEvent({ type: "item", item: x }); }
      b.steps.shift(); b.ids.push(items[0].id);
      renderGallery(); renderQueue();
      Media.toast(`Shot ${k} of ${b.total} queued${req.continue_from ? `, continuing shot ${k - 1} without a cut` : req.prompt === step.cont ? `, carrying on from shot ${k - 1}'s last frame` : ""}.`);
    } catch (e) {
      Media.toast(`Shot ${b.ids.length + 1} couldn't be queued: ${e.message}. The rest of the run stopped.`);
      b.steps = [];
    } finally {
      b.busy = 0; savePending();
      if (!b.steps.length) finish(key, b);
    }
  }
  // A chained run that was waiting when the page closed: carry on once the studio's items are in.
  function resume() {
    for (const [key, b] of pending) {
      if (!b.steps?.length) continue;
      const last = state.items.get(b.ids.at(-1));
      if (last && FINAL.includes(last.status)) advance(key, b, last);
    }
  }
  async function onItem(it) {
    if (matchWaiting && !rendering()) setTimeout(() => { if (matchWaiting && !rendering()) matchShots(); }, 500);
    for (const [key, b] of pending) {
      if (!b.ids.includes(it.id)) continue;
      if (b.steps?.length) {  // a chained run: the next shot when this, its last one so far, is finished
        if (it.id === b.ids.at(-1) && FINAL.includes(it.status)) advance(key, b, it);
        return;
      }
      return finish(key, b, it);
    }
  }
  async function finish(key, b, it = null) {
    {
      // `it` is newer than state.items here (the studio stores it after telling us)
      const all = b.ids.map(id => (id === it?.id ? it : state.items.get(id)));
      if (all.some(x => !x || !FINAL.includes(x.status))) return;
      pending.delete(key);
      savePending();
      if (b.place === false) return;
      let okItems = all.filter(x => x.status === "done" && x.files?.length);
      if (b.one) okItems = okItems.slice(0, 1);  // takes of one video: only the first good one
      if ((state.project?.id ?? "experiment") !== b.project || !TL.model || !okItems.length) return;
      const v1 = TL.model.tracks.find(t => t.kind === "video");
      let at = Math.max(0, ...TL.model.clips.filter(c => c.track === v1?.id).map(c => c.start + c.trim_out - c.trim_in));
      for (const x of okItems) {
        const f = x.files.find(f => /^video\//.test(f.content_type || "")) || x.files[0];
        const c = await TL.add({ ref: f.path, kind: "video", name: (promptLabel(x.params?.prompt) || "Shot").slice(0, 40), job: x.id }, { track: v1?.id, at });
        if (c) at = c.start + c.trim_out - c.trim_in;
      }
      Media.toast(b.one ? `The video is on the timeline${all.length > 1 ? " (the first good take)" : ""}.`
        : `The ${okItems.length} shots are on the timeline in order${okItems.length < all.length ? ` (${all.length - okItems.length} failed)` : ""}.`);
      return;
    }
  }
  // Another window's video (a 3D scene's render): onto the end of the timeline's first video track when it's done, like
  // a shot with "Add to timeline when done" (the first good take; kept across a reload).
  function placeWhenDone(items, project) {
    if (!items?.length) return;
    pending.set(items[0].id, { ids: items.map(x => x.id), project: project ?? "experiment", one: true });
    savePending();
  }
  // For the Generate step's summary.
  // Exactly what Generate sends: the multi-shot prompt, or each shot's own prompt.
  function previewText() {
    const sh = state.shots;
    if (isImg()) return sh.list.length === 1 && !sceneStill(0) ? prompt(0) : sh.list.map((_, i) =>
      sceneStill(i) ? `── Shot ${i + 1} · 🏞 a photo of the 3D scene ${sh.list[i].sceneLink.name} from its shot camera; how it looks ──\n${(l => [l.text, l.setting, l.style].map(x => String(x || "").trim()).filter(Boolean).join(". ") || "(as the scene is)")(stillLook(i))}`
        : `── Shot ${i + 1} ──\n${prompt(i)}`).join("\n\n");
    if (sh.mode !== "multi" && sh.list.length === 1 && (sceneOn(0) || motionOn(0))) return prompt(0);  // as Generate sends it
    return sh.mode === "multi" || sh.list.length === 1 ? prompt() : sh.list.map((_, i) =>
      `── Shot ${i + 1}${sceneOn(i) ? ` · 🏞 the 3D scene ${state.shots.list[i].scene.name}` : ""}${motionOn(i) ? ` · 🎬 objects in motion, from ${state.shots.list[i].motion.picture.name || "a picture"}` : ""}${joins(i) ? ` · continues shot ${i} without a cut` : ""}${carries(i) ? ` · ${joins(i) ? "its" : `carries on from shot ${i}'s`} last frame is sent as <Picture ${contPic()}>` : ""} ──\n${prompt(i)}`).join("\n\n");
  }
  function describe() {
    if (!upgraded()) return { text: "", first: "", empty: 0, prompt: "", missing: 0 };
    const sh = state.shots, n = sh.list.length, T = total();
    const empty = sh.list.filter((s, i) => !hasContent(s) && !sceneStill(i)).length;
    if (isImg()) return { text: `${n} shot${n === 1 ? "" : "s"} · ${n === 1 ? "one picture" : `${n} pictures, one per shot`}`, first: summary(sh.list[0]), empty, prompt: previewText(), missing: 0 };
    return { text: `${n} shot${n === 1 ? "" : "s"} · ${T.toFixed(1)} s · ${sh.mode === "multi" ? "one multi-shot video" : n > 1 ? "one video per shot" : "one video"}`,
      first: summary(sh.list[0]), empty, prompt: previewText(), missing: missingSubjects().length };
  }
  const ready = () => on() && state.shots.list.some((s, i) => hasContent(s) || sceneStill(i));
  // Reuse on a video result: its prompt as a shot with its own prompt (fills an empty single shot, else is added).
  /* A 3D scene's render, put in a shot (scene3d.js): `at` is a shot index, or -1 for a new shot (it fills an empty
     single shot). Returns the shot's index. */
  function useScene(at, scene) {
    const sh = ensure(), only = sh.list.length === 1 && !hasContent(sh.list[0]);
    let k = at;
    if (at < 0 || at >= sh.list.length) {
      if (only) k = 0;
      else { sh.list.push({ ...blank(), title: scene.name }); k = sh.list.length - 1; }
    }
    const s = sh.list[k];
    s.scene = scene; s.seconds = clampSec(scene.seconds);
    s.sceneLink = { id: scene.id, name: scene.name, thumb: scene.thumb || s.sceneLink?.thumb || "" };
    for (const x of sh.list) if (x !== s && !x.scene && x.sceneLink?.id === scene.id) x.sceneLink = null;  // one shot per scene
    if (!s.title) s.title = scene.name;
    if (sh.mode === "multi") sh.mode = "each";  // a scene renders only as its own video
    changed();
    return k;
  }
  /* Shots mapped to 3D scenes (H3, H3 Reference, one video per shot). A shot's own inputs are the keyframe it starts
     or ends on and the reference pictures its text names; a scene made from it starts from one of those (in depth) or
     from nothing, takes its length (and, empty, the project's picture shape), and is linked to it, so the scene's
     🎬 Render goes to this shot with its text. */
  const sceneFits = () => (isVideo() && ["h3", "h3ref"].includes(state.engine.video)) || isImg();
  function shotPictures(i) {
    const s = state.shots.list[i], f = framesOf(i), out = [];
    const add = (r, label) => { if (r?.ref && r.url && !out.some(p => p.ref === r.ref)) out.push({ ref: r.ref, url: r.url, label, name: r.ref.split("/").pop().replace(/\.[^.]+$/, "") }); };
    if (!isImg()) { add(f.first_frame, "First frame"); add(f.last_frame, "Last frame"); }  // pictures have no keyframes
    for (const k of picsIn(s.rawOn ? s.raw : s.action)) add(state.refs[k], `Picture ${k + 1}`);
    return out;
  }
  async function newScene(i, picture) {
    const s = state.shots.list[i], id = s.id;
    const sc = await Scene3D.createFor({ picture, name: `Shot ${i + 1}${s.title ? `: ${s.title}` : ""}`, seconds: s.seconds });
    const k = state.shots.list.findIndex(x => x.id === id);
    if (sc && k >= 0) linkScene(k, sc);
  }
  function linkScene(i, sc) {
    const sh = ensure(), s = sh.list[i];
    if (!s || !sc) return;
    for (const x of sh.list) if (x !== s && !x.scene && x.sceneLink?.id === sc.id) x.sceneLink = null;  // one shot per scene
    s.sceneLink = { id: sc.id, name: sc.name, thumb: sc.plate_url || sc.picture_url || sc.backdrop_url || "" };
    if (!s.title) s.title = sc.name.replace(/^Shot \d+:\s*/, "");
    if (sh.mode === "multi") sh.mode = "each";  // a scene renders only as its own video
    changed();
    Scene3D.refreshPanel();  // its "→ Shot N"
  }
  function unlinkScene(id) {
    if (!upgraded()) return;
    let hit = false;
    for (const x of state.shots.list) if (x.sceneLink?.id === id && !x.scene) { x.sceneLink = null; hit = true; }
    if (hit) { changed(); Scene3D.refreshPanel(); }
  }
  // The shot a scene is mapped to, for its Render window and the scenes panel: {i, label, action}.
  function shotOfScene(id) {
    if (!on()) return null;
    const i = state.shots.list.findIndex(s => s.sceneLink?.id === id);
    if (i < 0) return null;
    const s = state.shots.list[i];
    return { i, label: `Shot ${i + 1}${s.title ? `: ${s.title}` : ""}`, action: s.rawOn ? "" : s.action || "" };
  }
  // The shots a scene's render can go to (for its Render window).
  const targets = () => on() && !isImg() ? state.shots.list.map((s, i) => ({ i, label: `Shot ${i + 1}${s.title ? `: ${s.title}` : ""}${s.scene ? " (its 3D scene)" : hasContent(s) ? "" : " (empty)"}` })) : [];
  function reuse(text, seconds) {
    const sh = ensure(), only = sh.list.length === 1 && !hasContent(sh.list[0]);
    const s = { ...blank(clampSec(seconds || settingsSeconds())), raw: text, rawOn: true, title: "Reused from a result" };
    if (only) sh.list[0] = s; else sh.list.push(s);
    changed();
    return only ? 0 : sh.list.length - 1;
  }

  const each = () => on() && modeOf() === "each";  // shots map to 3D scenes one by one
  return { init, render, renderBanner, prompt, previewText, on, ready, each, isImage: isImg, generate, onItem, resume, ensure, describe, openModal, reuse, describeMissing, placeWhenDone, useScene, targets, shotOfScene, linkScene, unlinkScene, sceneFits };
})();
