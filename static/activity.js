/* Activity console: everything the studio is processing, with a detailed log, progress,
   time taken and an estimate of when it finishes.

   Sources: studio items (generations and timeline renders) from /api/items and the live
   event stream (item / progress / log events), plus local tasks the page runs itself
   (Activity.task(title) → {log, progress, done, fail}).
   Opened from the top bar's activity chip, the queue's "Log" buttons, or Ctrl+Shift+A. */
"use strict";

const Activity = (() => {
  const entries = new Map();   // id → {id, title, status, progress, message, started, finished, log[], samples[], local, item}
  let win = null, selected = null, timer = 0, queue = { running: 0, pending: 0 };
  const BUSY = ["submitting", "queued", "running"];

  const now = () => Date.now() / 1000;
  const fmtDur = s => {
    if (!isFinite(s) || s < 0) return "—";
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
  };
  const clock = t => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const titleOf = it => {
    if (it.engine === "timeline") return `Render · ${it.info?.format?.split(" (")[0] || "timeline"}`;
    let name = it.engine;
    try { name = engineName(it.kind, it.engine); } catch {}
    return `${name} · ${(it.params?.pose || promptLabel(it.params?.prompt)).slice(0, 48) || it.kind}`;
  };

  /* ---------------------------------------------------------------- model */
  function fromItem(it) {
    let e = entries.get(it.id);
    if (!e) {
      e = { id: it.id, log: [], samples: [], local: false };
      entries.set(it.id, e);
    }
    e.item = it;
    e.title = titleOf(it);
    e.status = it.status;
    e.started = it.started || it.created;
    e.created = it.created;
    e.finished = it.finished || null;
    if (typeof it.progress === "number") e.progress = it.progress;
    if (Array.isArray(it.log) && it.log.length >= e.log.length) e.log = it.log.slice();
    if (it.error && !e.log.some(l => l.level === "error")) e.log.push({ t: e.finished || now(), msg: it.error, level: "error" });
    if (!BUSY.includes(it.status) && it.status === "done") e.progress = 1;
    return e;
  }
  function sample(e, v) {
    if (typeof v !== "number") return;
    const t = now();
    if (e.samples.length && v < e.samples[e.samples.length - 1].v - 0.05) e.samples = [];  // progress restarted (a new stage)
    e.samples.push({ t, v });
    while (e.samples.length > 2 && t - e.samples[0].t > 45) e.samples.shift();
  }
  const enh = (fn, it) => { try { return typeof Enhance !== "undefined" ? Enhance[fn](it) : null; } catch { return null; } };
  // An enhance run's whole time from its steps and sizes: each step restarts the progress bar.
  const expected = e => e.item ? enh("expected", e.item) : null;
  // What Settings › Post-Processing will add once this generation is done.
  const afterOf = e => e.item && e.status !== "done" ? enh("afterTime", e.item) : null;
  // Seconds left, from the progress rate over the last ~45 s (or since it started). Enhance
  // runs use their expected time less the time so far, until that runs out.
  function eta(e) {
    const exp = e.status === "running" ? expected(e) : null;
    if (exp != null && e.started) { const left = exp - (now() - e.started); if (left > 3) return left; }
    if (e.status !== "running" || !(e.progress > 0.01)) return null;
    const s = e.samples;
    let rate = null;
    if (s.length >= 2 && s[s.length - 1].t - s[0].t > 1.5) rate = (s[s.length - 1].v - s[0].v) / (s[s.length - 1].t - s[0].t);
    if (!(rate > 0) && e.started) rate = e.progress / Math.max(0.5, now() - e.started);
    return rate > 0 ? (1 - e.progress) / rate : null;
  }

  function onEvent(ev) {
    if (ev.type === "item") { fromItem(ev.item); }
    else if (ev.type === "progress") {
      const e = entries.get(ev.id);
      if (!e) return;
      e.progress = ev.value; e.status = e.status === "queued" ? "running" : e.status;
      e.message = ev.message || (ev.steps ? `Step ${ev.step} of ${ev.steps}` : e.message);
      sample(e, ev.value);
    } else if (ev.type === "log") {
      const e = entries.get(ev.id);
      if (!e) return;
      // The same line can arrive twice: in an item snapshot and as its own event.
      if (e.log.slice(-20).some(l => l.t === ev.t && l.msg === ev.msg)) return;
      e.log.push({ t: ev.t, msg: ev.msg, level: ev.level });
      if (e.log.length > 400) e.log.splice(0, e.log.length - 400);
    } else if (ev.type === "queue") {
      const e = entries.get(ev.id);
      if (e && ev.position != null) e.message = `Waiting in ComfyUI's queue (position ${ev.position})`;
    } else if (ev.type === "deleted") { entries.delete(ev.id); }
    else return;
    schedule();
  }
  function load(items) { for (const it of items) fromItem(it); schedule(); }

  // A task the page runs itself (an export, a request) shown alongside the server's work.
  function task(title, { open = false } = {}) {
    const id = "local-" + Math.random().toString(16).slice(2, 10);
    const e = { id, title, status: "running", progress: null, started: now(), finished: null, log: [], samples: [], local: true };
    entries.set(id, e);
    const add = (msg, level = "info") => { e.log.push({ t: now(), msg, level }); schedule(); };
    add(`${title}…`);
    if (open) show(id);
    schedule();
    return {
      id,
      log: add,
      progress(v, msg) { e.progress = v; if (msg) e.message = msg; sample(e, v); schedule(); },
      done(msg) { e.status = "done"; e.progress = 1; e.finished = now(); add(msg || `Done in ${fmtDur(e.finished - e.started)}`); },
      fail(err) { e.status = "failed"; e.finished = now(); add(`Failed: ${err?.message || err}`, "error"); },
    };
  }

  /* ---------------------------------------------------------------- top-bar chip */
  function busyList() { return [...entries.values()].filter(e => BUSY.includes(e.status)).sort((a, b) => (a.created || a.started) - (b.created || b.started)); }
  function setQueue(q) { queue = q || queue; renderChip(); }
  function renderChip() {
    const chip = document.getElementById("st-queue");
    if (!chip) return;
    const busy = busyList();
    chip.classList.toggle("busy", busy.length > 0);
    if (!busy.length) { chip.innerHTML = `<i></i>Activity`; chip.title = "Activity: what the studio is doing, with logs (Ctrl+Shift+A)"; return; }
    const run = busy.find(e => e.status === "running") || busy[0];
    const pct = typeof run.progress === "number" ? `${Math.round(run.progress * 100)}%` : run.status;
    const left = eta(run), after = afterOf(run);
    chip.innerHTML = `<i></i>${busy.length > 1 ? `${busy.length} jobs · ` : ""}${esc(run.title.split(" · ")[0])} ${pct}${left != null ? ` · ~${fmtDur(left)} left` : ""}${after != null ? ` + enhance ~${fmtDur(after)}` : ""} · Details`;
    chip.title = "Open the activity console: log, progress and time estimates (Ctrl+Shift+A)";
  }

  /* ---------------------------------------------------------------- console window */
  let raf = 0;
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { renderChip(); if (win) renderWin(); renderInline(); }); }

  /* The Generate step's log: the running generation (or the most recent one), live. */
  let inlineId = null;
  function renderInline() {
    const box = document.getElementById("gen-log");
    if (!box) return;
    const e = ordered().find(x => !x.local) || null;
    box.hidden = !e;
    if (!e || !box.offsetParent) return;
    const pct = e.status === "done" ? 100 : typeof e.progress === "number" ? Math.round(e.progress * 100) : null;
    const head = `<div class="gen-log-head"><b>Log</b><span class="gen-log-t">${esc(e.title)}</span>
      <span class="s-${e.status}">${esc(stateText(e))}${e.message && BUSY.includes(e.status) ? ` · ${esc(e.message)}` : ""}</span>
      <button type="button" class="link" data-gen-log="open">Activity…</button></div>
      <div class="bar${e.status === "running" && !pct ? " indeterminate" : ""}"><i style="width:${pct ?? 0}%"></i></div>`;
    const lines = e.log.map(l => `<div class="ln ${l.level || "info"}"><time>${clock(l.t)}</time><span>${esc(l.msg)}</span></div>`).join("")
      || `<div class="ln"><span class="hint">No log lines yet.</span></div>`;
    let lg = box.querySelector(".act-log");
    const atEnd = !lg || lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 8;
    if (!lg || inlineId !== e.id) {
      inlineId = e.id;
      box.innerHTML = `<div class="gen-log-top">${head}</div><div class="act-log" aria-live="polite">${lines}</div>`;
      lg = box.querySelector(".act-log"); lg.scrollTop = lg.scrollHeight;
    } else {
      box.querySelector(".gen-log-top").innerHTML = head;
      if (lg.childElementCount !== e.log.length) { lg.innerHTML = lines; if (atEnd) lg.scrollTop = lg.scrollHeight; }
    }
  }

  function show(id) {
    if (id) selected = id;
    if (!win) {
      const box = document.createElement("div");
      box.className = "act";
      box.innerHTML = `<div class="act-list" role="listbox" aria-label="Activity"></div><div class="act-detail"></div>`;
      const foot = document.createElement("div");
      foot.innerHTML = `<label class="act-auto"><input type="checkbox" id="act-scroll" checked> Follow the log</label><span class="wm-foot-gap"></span>
        <button type="button" class="btn sm" data-a="clear" title="Remove finished entries from this list (results stay)">Clear finished</button>
        <button type="button" class="btn sm" data-a="copy">Copy log</button>`;
      win = WM.open({ id: "activity", title: "Activity", content: box, footer: foot, width: 880, height: 520, minWidth: 360, minHeight: 260, modal: false,
        onClose: () => { win = null; clearInterval(timer); } });
      box.addEventListener("click", e => {
        const row = e.target.closest("[data-act-id]");
        if (row) { selected = row.dataset.actId; renderWin(true); return; }
        const b = e.target.closest("[data-do]");
        if (!b) return;
        const en = entries.get(selected);
        if (b.dataset.do === "cancel" && en?.item) cancel(en.id);
        if (b.dataset.do === "show" && en?.item) { select(en.id); }
      });
      foot.querySelector('[data-a="copy"]').onclick = () => {
        const en = entries.get(selected);
        if (!en) return;
        const text = [`${en.title} (${en.status})`, ...en.log.map(l => `[${clock(l.t)}] ${l.level === "error" ? "ERROR " : ""}${l.msg}`)].join("\n");
        navigator.clipboard?.writeText(text).then(() => Media.toast("Log copied."), () => Media.toast("Couldn't copy."));
      };
      foot.querySelector('[data-a="clear"]').onclick = () => {
        for (const [k, en] of entries) if (!BUSY.includes(en.status)) entries.delete(k);
        renderWin(true);
      };
      timer = setInterval(() => renderWin(), 1000);  // clocks tick even without events
    } else win.focus?.();
    renderWin(true);
  }

  function ordered() {
    const list = [...entries.values()];
    const busy = list.filter(e => BUSY.includes(e.status)).sort((a, b) => (a.created || a.started) - (b.created || b.started));
    const rest = list.filter(e => !BUSY.includes(e.status)).sort((a, b) => (b.finished || b.started || 0) - (a.finished || a.started || 0)).slice(0, 40);
    return [...busy, ...rest];
  }

  function stateText(e) {
    if (e.status === "running") return typeof e.progress === "number" ? `${Math.round(e.progress * 100)}%` : "working";
    return { queued: "waiting", submitting: "starting", done: "done", failed: "failed", cancelled: "cancelled" }[e.status] || e.status;
  }

  function renderWin(full = false) {
    if (!win) return;
    const box = win.body || document.querySelector(".act");
    const listEl = box.querySelector(".act-list"), det = box.querySelector(".act-detail");
    const list = ordered();
    if (!selected || !entries.has(selected)) selected = list[0]?.id || null;
    listEl.innerHTML = list.length ? list.map(e => {
      const pct = e.status === "done" ? 100 : typeof e.progress === "number" ? Math.round(e.progress * 100) : 0;
      return `<button type="button" class="act-row s-${e.status}${e.id === selected ? " sel" : ""}" data-act-id="${e.id}" role="option" aria-selected="${e.id === selected}">
        <span class="act-t">${esc(e.title)}</span><span class="act-s">${esc(stateText(e))}</span>
        <span class="bar${e.status === "running" && !pct ? " indeterminate" : ""}"><i style="width:${pct}%"></i></span></button>`;
    }).join("") : `<p class="hint act-empty">Nothing yet. Generations, renders and exports show up here with their logs.</p>`;
    const e = entries.get(selected);
    if (!e) { det.innerHTML = ""; return; }
    const elapsed = (e.finished || now()) - (e.status === "queued" ? (e.created || e.started) : e.started || e.created || now());
    const left = eta(e), after = afterOf(e), exp = expected(e);
    const pct = e.status === "done" ? 100 : typeof e.progress === "number" ? Math.round(e.progress * 100) : null;
    const head = `
      <div class="act-head">
        <h4>${esc(e.title)}</h4>
        <div class="act-btns">${e.item && BUSY.includes(e.status) && !e.local ? `<button type="button" class="btn sm danger" data-do="cancel">Cancel</button>` : ""}
          ${e.item && e.status === "done" ? `<button type="button" class="btn sm" data-do="show">Show result</button>` : ""}</div>
      </div>
      <div class="bar big${e.status === "running" && !pct ? " indeterminate" : ""}"><i style="width:${pct ?? 0}%"></i></div>
      <dl class="act-stats">
        <div><dt>Status</dt><dd class="s-${e.status}">${esc(stateText(e))}${e.message && BUSY.includes(e.status) ? ` · ${esc(e.message)}` : ""}</dd></div>
        <div><dt>${e.status === "queued" ? "Waiting" : "Elapsed"}</dt><dd>${fmtDur(elapsed)}</dd></div>
        <div><dt>Time left</dt><dd>${BUSY.includes(e.status) ? (left != null ? `~${fmtDur(left)}` : "estimating…") : "—"}</dd></div>
        <div><dt>${e.finished ? "Finished" : "Done by"}</dt><dd>${e.finished ? clock(e.finished) : left != null ? `~${clock(now() + left)}` : "—"}</dd></div>
        <div><dt>Started</dt><dd>${e.started ? clock(e.started) : "—"}</dd></div>
        ${exp != null ? `<div><dt>${e.finished ? "Expected" : "Takes about"}</dt><dd>~${fmtDur(exp)} on the GPU</dd></div>` : ""}
        ${after != null ? `<div><dt>Then enhance</dt><dd>~${fmtDur(after)} more${left != null ? `, all done ~${clock(now() + left + after)}` : ""}</dd></div>` : ""}
        ${e.item?.info?.file ? `<div class="wide"><dt>File</dt><dd>${esc(e.item.info.file)}</dd></div>` : ""}
      </dl>`;
    const logEl = det.querySelector(".act-log");
    const follow = document.getElementById("act-scroll")?.checked !== false;
    const atEnd = logEl ? logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8 : true;
    const lines = e.log.map(l => `<div class="ln ${l.level || "info"}"><time>${clock(l.t)}</time><span>${esc(l.msg)}</span></div>`).join("")
      || `<div class="ln"><span class="hint">No log lines yet${e.item && !e.item.log ? " (items made before 0.12 have no log)" : ""}.</span></div>`;
    if (full || !logEl || det.dataset.id !== e.id) {
      det.dataset.id = e.id;
      det.innerHTML = `${head}<div class="act-log" aria-live="polite">${lines}</div>`;
    } else {
      // Keep the log element (and its scroll position) while refreshing the rest.
      const tmp = document.createElement("div"); tmp.innerHTML = head;
      for (const sel of [".act-head", ".bar.big", ".act-stats"]) det.querySelector(sel).replaceWith(tmp.querySelector(sel));
      if (logEl.childElementCount !== e.log.length) logEl.innerHTML = lines;
    }
    const lg = det.querySelector(".act-log");
    if (follow && (atEnd || full)) lg.scrollTop = lg.scrollHeight;
  }

  /* ---------------------------------------------------------------- wiring */
  document.addEventListener("DOMContentLoaded", () => {
    const chip = document.getElementById("st-queue");
    if (chip) chip.addEventListener("click", () => show(busyList()[0]?.id));
    addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") { e.preventDefault(); show(); }
    }, true);
    setInterval(() => { renderChip(); renderInline(); }, 1000);
    document.addEventListener("click", ev => { if (ev.target.closest('[data-gen-log="open"]')) show(inlineId); });
  });

  return { onEvent, load, task, show, setQueue, eta: id => eta(entries.get(id)), get entries() { return entries; } };
})();
